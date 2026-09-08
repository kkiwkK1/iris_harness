/**
 * Assemble one model request.
 *
 * The ordering here is the whole point. Depth-injected content is anchored to
 * the END of the conversation, so it has to be placed *after* the budget has
 * decided which history survives — otherwise trimming the top would silently
 * shift an author's note that was supposed to sit two turns from the bottom.
 * Its cost is still charged up front, so the trim knows what it is competing
 * with.
 *
 * @module @iris/pipeline/assemble
 */

import type {
  AssembledItem,
  AssembleInput,
  AssembleResult,
  Contribution,
  HistoryEntry,
  PipelineMessage,
  TokenCounter,
  Placement,
} from './types.ts'

/** A depth contribution with its resolved sort key. */
interface DepthItem {
  contribution: Contribution
  placement: Extract<Placement, { kind: 'depth' }>
  /** Original position, to keep the sort stable. */
  sequence: number
}

/**
 * Join the system-placed contributions.
 *
 * Empty text drops out rather than leaving a blank run: a section that
 * evaluated to nothing this turn should not cost the model a paragraph break
 * that looks like a missing instruction.
 * @param contributions - every contribution.
 * @returns the system prompt.
 */
export function renderSystem(contributions: readonly Contribution[]): string {
  return contributions
    .filter(item => item.placement.kind === 'system')
    .map((item, sequence) => ({ item, order: (item.placement as { order: number }).order, sequence }))
    .sort((left, right) => left.order - right.order || left.sequence - right.sequence)
    .map(entry => entry.item.text.trim())
    .filter(text => text.length > 0)
    .join('\n\n')
}

/** Collect the depth-placed contributions in stable, sorted order. */
function depthItems(contributions: readonly Contribution[]): DepthItem[] {
  const items: DepthItem[] = []
  contributions.forEach((contribution, sequence) => {
    if (contribution.placement.kind === 'depth') {
      items.push({ contribution, placement: contribution.placement, sequence })
    }
  })
  return items
}

/**
 * Default {@link Budget.trimBlockFloors}: floors are dropped in multiples of
 * this many.
 *
 * Eight floors is four exchanges, so the oldest sent floor holds still for
 * about four turns after a cut and the boundary moves on roughly one turn in
 * four instead of on every one. The cost is the other half of the same number:
 * at the moment of a cut, up to seven floors the budget could still have
 * afforded are given up — the oldest ones, which is also the span automatic
 * compaction is meant to have replaced with a summary long before the trimmer
 * ever runs (`@iris/app-service`'s `compaction.ts`, threshold 80% of the same
 * budget). `0` restores upstream's per-floor arithmetic.
 */
export const DEFAULT_TRIM_BLOCK_FLOORS = 8

/**
 * Keep as many of the newest entries as `available` pays for.
 *
 * Upstream's arithmetic, and the inner half of {@link trimHistory}: newest
 * first, stop at the first entry that does not fit
 * (`openai.js:1061-1065` — `canAfford` then `break`, never "skip and keep
 * going"). Pinned entries are exempt wherever they sit.
 * @param history - the full conversation, oldest first.
 * @param available - tokens the conversation may spend.
 * @param count - token counter.
 * @returns the surviving entries in chronological order, and how many were dropped.
 */
function selectHistory(
  history: readonly HistoryEntry[],
  available: number,
  count: (text: string) => number,
): { kept: HistoryEntry[], dropped: number } {
  const keep = new Set<number>()
  let spent = 0

  history.forEach((entry, index) => {
    if (entry.pinned === true) keep.add(index)
  })

  // Newest first: the last turns are the ones the reply has to follow.
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (keep.has(index)) continue
    const entry = history[index] as HistoryEntry
    const cost = count(entry.text)
    if (spent + cost > available) break
    spent += cost
    keep.add(index)
  }

  const kept = history.filter((_entry, index) => keep.has(index))
  return { kept, dropped: history.length - kept.length }
}

/** How many of these entries are not exempt from trimming. */
function unpinnedCount(entries: readonly HistoryEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.pinned === true ? 0 : 1), 0)
}

/**
 * Keep every pinned entry, plus every trimmable entry after the first `drop`
 * of them.
 *
 * Counted over trimmable entries rather than over positions, so it agrees with
 * {@link selectHistory}'s `dropped`: a pinned greeting at index 0 is kept
 * either way and is not one of the drops.
 * @param history - the full conversation, oldest first.
 * @param drop - how many trimmable entries to give up from the oldest end.
 * @returns the survivors in chronological order, and how many were dropped.
 */
function dropOldest(
  history: readonly HistoryEntry[],
  drop: number,
): { kept: HistoryEntry[], dropped: number } {
  let seen = 0
  const kept = history.filter(entry => {
    if (entry.pinned === true) return true
    seen += 1
    return seen > drop
  })
  return { kept, dropped: history.length - kept.length }
}

/**
 * Choose which history survives the budget.
 *
 * Trims from the oldest end, which is what keeps a conversation coherent: the
 * model needs the recent turns and the character definition, and the middle is
 * what it can afford to forget. Pinned entries are exempt wherever they sit.
 *
 * **Where this departs from upstream: the cut is quantised.** Upstream drops
 * exactly what does not fit, one message at a time, and recomputes from
 * scratch on every generation (`openai.js:1558` re-sets the budget on a fresh
 * `ChatCompletion`; the only stored artefact, `lastInContextMessageId`, is read
 * by two macros and never fed back). So the first turn that overflows drops one
 * floor, the next turn drops the next one, and the oldest floor the model is
 * shown moves on *every* turn from then on. Against a provider that caches on
 * the request prefix (DeepSeek's context cache: 64-token blocks keyed on the
 * literal prefix) that is the most expensive shape a long chat can have — every
 * turn re-pays for the entire conversation, because the conversation now starts
 * one floor later than the cached copy does. Measured on the operator's own
 * longest chat with the window narrowed until the trimmer engaged: the
 * conversation's own prefix ceiling fell from ~47% untrimmed to 10–16%, and the
 * oldest sent floor moved on 6 of 6 adjacent rounds.
 *
 * So the number of dropped floors is rounded **up** to a multiple of `block`.
 * The count then has to climb a whole block before the boundary moves again,
 * which takes about `block / 2` turns, and while it does not move the whole
 * prefix up to the newest exchange is byte-identical to the previous turn's.
 *
 * **The quantum is a floor count, not a token allowance, and that took a
 * measurement to establish.** The first version of this subtracted a share of
 * the token budget before selecting, on the theory that the leftover would be
 * headroom. It is not: {@link selectHistory} adds floors until the next one
 * overflows, so whatever the target, the slack left behind is only the size of
 * the floor that did not fit — and the boundary advances on the next turn
 * exactly as it did before. Run against the same six rounds, that version was
 * byte-for-byte indistinguishable from upstream's. The boundary is an index,
 * so the quantum has to be an index.
 *
 * Nothing is remembered between calls. Stability comes from the quantisation,
 * not from a stored boundary: the same conversation and the same budget always
 * produce the same cut, which is what keeps a reroll, a preview and the real
 * turn agreeing about which floors were sent.
 * @param history - the full conversation, oldest first.
 * @param available - tokens left after the fixed cost.
 * @param count - token counter.
 * @param block - drop floors in multiples of this many; `0` drops exactly what
 *   does not fit, upstream's rule.
 * @returns the surviving entries in chronological order, and how many were dropped.
 */
export function trimHistory(
  history: readonly HistoryEntry[],
  available: number,
  count: (text: string) => number,
  block = 0,
): { kept: HistoryEntry[], dropped: number } {
  const exact = selectHistory(history, available, count)
  // Nothing had to go, so nothing is given up: the block is the price of a cut,
  // and a conversation that still fits is not being cut.
  if (block <= 1 || exact.dropped === 0) return exact

  const trimmable = unpinnedCount(history)
  // Never past the last trimmable floor. A conversation the budget cannot fit
  // at all already keeps nothing but the newest floor upstream would have
  // kept, and rounding that up would hand the model a conversation with no
  // present in it.
  const drop = Math.min(Math.ceil(exact.dropped / block) * block, Math.max(trimmable - 1, exact.dropped))
  return dropOldest(history, drop)
}

/**
 * Splice depth contributions into a conversation.
 *
 * SillyTavern's convention, preserved exactly: **depth 0 lands after the last
 * message, depth 1 before it**. A depth deeper than the conversation clamps to
 * the front rather than being dropped — an author's note set to depth 20 in a
 * three-message chat should still be seen.
 * @param history - the surviving conversation, oldest first.
 * @param items - depth contributions.
 * @returns the conversation with injections in place.
 */
export function injectAtDepth(
  history: readonly HistoryEntry[],
  contributions: readonly Contribution[],
): PipelineMessage[] {
  const items = depthItems(contributions)

  // One bucket per insertion point, including `history.length` for depth 0.
  const slots: DepthItem[][] = Array.from({ length: history.length + 1 }, () => [])

  for (const item of items) {
    const raw = history.length - item.placement.depth
    const index = Math.min(Math.max(raw, 0), history.length)
    ;(slots[index] as DepthItem[]).push(item)
  }

  for (const slot of slots) {
    slot.sort((left, right) =>
      (left.placement.order ?? 0) - (right.placement.order ?? 0) || left.sequence - right.sequence)
  }

  const messages: PipelineMessage[] = []
  for (let index = 0; index <= history.length; index += 1) {
    for (const item of slots[index] as DepthItem[]) {
      if (item.contribution.text.trim().length === 0) continue
      messages.push({ role: item.placement.role, text: item.contribution.text })
    }
    const entry = history[index]
    if (entry !== undefined) {
      const { pinned: _pinned, ...message } = entry
      messages.push(message)
    }
  }
  return messages
}

/**
 * Build one model request from its parts.
 * @param input - contributions, conversation and budget.
 * @returns the system prompt, the message list, and what had to be dropped.
 */
export function assemble(input: AssembleInput): AssembleResult {
  const { contributions, history, budget } = input
  const count = budget.count

  const system = renderSystem(contributions)
  const items = depthItems(contributions)

  // Charged before the trim, spent after it: the trim has to know what the
  // injections will occupy, but the injections have to be placed relative to
  // whatever history survives.
  const fixed = count(system)
    + items.reduce((total, item) => total + count(item.contribution.text), 0)
    + history.reduce((total, entry) => total + (entry.pinned === true ? count(entry.text) : 0), 0)

  const available = budget.context - budget.reserve - fixed
  const { kept, dropped } = trimHistory(
    history,
    Math.max(available, 0),
    count,
    budget.trimBlockFloors ?? DEFAULT_TRIM_BLOCK_FLOORS,
  )
  const messages = injectAtDepth(kept, contributions)

  const tokens = count(system) + messages.reduce((total, message) => total + count(message.text), 0)

  return {
    system,
    messages,
    tokens,
    overflow: { droppedHistory: dropped, overBudget: available < 0 },
    items: itemize(contributions, kept, count),
  }
}

/**
 * Attribute the assembled tokens to the parts that produced them.
 *
 * Counted from the contributions rather than from the rendered request, so a
 * part that contributed nothing still appears with a zero — a user looking for
 * why a section is missing is better served by a zero than by an absence.
 * @param contributions - the parts offered.
 * @param kept - the history that survived the budget.
 * @param count - the token counter.
 * @returns one row per contribution, plus one aggregate row for the conversation.
 */
export function itemize(
  contributions: readonly Contribution[],
  kept: readonly HistoryEntry[],
  count: TokenCounter,
): AssembledItem[] {
  const items: AssembledItem[] = contributions.map(contribution => ({
    id: contribution.id,
    ...contribution.label === undefined ? {} : { label: contribution.label },
    kind: contribution.placement.kind,
    tokens: count(contribution.text),
    ...contribution.placement.kind === 'depth'
      ? { depth: contribution.placement.depth, role: contribution.placement.role }
      : {},
  }))

  items.push({
    id: 'chatHistory',
    label: 'Chat History',
    kind: 'history',
    tokens: kept.reduce((total, entry) => total + count(entry.text), 0),
  })
  return items
}
