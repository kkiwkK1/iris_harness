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
  AssembleInput,
  AssembleResult,
  Contribution,
  HistoryEntry,
  PipelineMessage,
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
 * Choose which history survives the budget.
 *
 * Trims from the oldest end, which is what keeps a conversation coherent: the
 * model needs the recent turns and the character definition, and the middle is
 * what it can afford to forget. Pinned entries are exempt wherever they sit.
 * @param history - the full conversation, oldest first.
 * @param available - tokens left after the fixed cost.
 * @param count - token counter.
 * @returns the surviving entries in chronological order, and how many were dropped.
 */
export function trimHistory(
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
  const { kept, dropped } = trimHistory(history, Math.max(available, 0), count)
  const messages = injectAtDepth(kept, contributions)

  const tokens = count(system) + messages.reduce((total, message) => total + count(message.text), 0)

  return {
    system,
    messages,
    tokens,
    overflow: { droppedHistory: dropped, overBudget: available < 0 },
  }
}
