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
 * **This is the one layer where a cache-friendly reorder can live.** It is the
 * only function that sees both halves of the decision: which contributions get
 * folded into the system prompt (and therefore into the request's leading
 * bytes) and which get spliced into the conversation. A caller upstream builds
 * contributions but cannot express "after the history", because
 * {@link Placement} has only the two kinds; a caller downstream has the system
 * prompt already joined into one string and would have to re-split it on
 * `\n\n`, which is a guess about where a contribution ended. `itemize` is here
 * too, so the account a person reads and the request the model reads come out
 * of one pass rather than two that can disagree.
 *
 * @module @iris/pipeline/assemble
 */

import type {
  AssembledItem,
  AssembledMember,
  AssembleInput,
  AssembleResult,
  Contribution,
  ContributionMember,
  HistoryEntry,
  PipelineMessage,
  Role,
  SystemSegment,
  TokenCounter,
  Placement,
} from './types.ts'

/**
 * What {@link renderSystem} puts between two segments.
 *
 * Exported because a reader of {@link AssembleResult.systemSegments} has to lay
 * the segments back end to end to know where each one starts, and a separator
 * guessed from the rendered string is a guess: a segment whose own text ends in
 * a blank line makes `'\n\n'` ambiguous to find and unambiguous to count.
 */
export const SYSTEM_JOIN = '\n\n'

/**
 * What a composite contribution's members are joined with.
 *
 * **One newline, because that is what SillyTavern's world info joins a depth
 * bucket with** — every entry sharing a depth and a role is merged into one
 * injection before it is registered (`world-info.js`, a single
 * `setExtensionPrompt(CUSTOM_WI_DEPTH_ROLE(depth, role), joined, …)` per
 * bucket), and the prompt builder reproduces that join to the byte. It is the
 * separator the split has to be able to put *back*: a member list that does not
 * rejoin to the contribution's own text is refused, and this constant is what
 * "rejoin" means.
 *
 * It coincides with the separator `squash_system_messages` uses, which is
 * convenient for a reader laying either kind of subdivided slot back down, and
 * a coincidence all the same — the two are decided by two independent upstream
 * lines, so neither is written in terms of the other.
 */
export const MEMBER_JOIN = '\n'

/** A depth contribution with its resolved sort key. */
interface DepthItem {
  contribution: Contribution
  placement: Extract<Placement, { kind: 'depth' }>
  /** Original position, to keep the sort stable. */
  sequence: number
}

/** A depth contribution the reorder may split, with its members and its slot. */
interface SplitBucket {
  placement: Extract<Placement, { kind: 'depth' }>
  members: readonly ContributionMember[]
}

/**
 * Whether this contribution may be placed member by member, and its members if so.
 *
 * Four conditions, and each one is a way the split could be wrong rather than a
 * formality:
 *
 * - **The reorder is on.** With it off the assembly is upstream's, and upstream
 *   sends a depth bucket as one message. Nothing below is read at all, which is
 *   what makes "off is byte-identical" a property of the code rather than a
 *   claim about it.
 * - **It is a depth placement.** A system section is folded into one string
 *   with its neighbours; splitting one would move a seam that
 *   {@link systemSegments} has already described.
 * - **It has members.** Absent means the caller did not decompose it, and a
 *   contribution nobody decomposed is one part.
 * - **The members rejoin to its text exactly.** This is the load-bearing one.
 *   The members are built where the entries are still separate and the text is
 *   built by joining them, so the two agree — until something rewrites the text
 *   afterwards, and then the member list describes bytes that are not in the
 *   request. Refusing the split there costs a turn of rent; trusting it would
 *   send the model text nobody assembled.
 * @param contribution - the contribution.
 * @param cacheFriendly - whether the reorder is enabled.
 * @returns the members and the slot they came from, or undefined for a
 *   contribution that has to be placed whole.
 */
function splitOf(contribution: Contribution, cacheFriendly: boolean): SplitBucket | undefined {
  if (!cacheFriendly) return undefined
  const placement = contribution.placement
  if (placement.kind !== 'depth') return undefined
  const members = contribution.members
  if (members === undefined || members.length === 0) return undefined
  if (members.map(member => member.text).join(MEMBER_JOIN) !== contribution.text) return undefined
  return { placement, members }
}

/** Where the reorder sends one member of a split bucket. */
type MemberPhase = 'promote' | 'defer' | 'keep'

/**
 * Which of the three places one member goes.
 *
 * **The same rule {@link moves} and {@link promotes} apply to a whole
 * contribution, at member granularity** — deliberately the same and not a
 * second policy, so there is one story about what the reorder does and the
 * member case is that story with a finer unit. Volatility outranks settling for
 * the reason it does there: the two must not both claim the same text, and a
 * measured change is the newer evidence.
 * @param member - the member.
 * @param placement - the slot its bucket sits in.
 * @returns the phase it belongs to.
 */
function memberPhase(
  member: ContributionMember,
  placement: Extract<Placement, { kind: 'depth' }>,
): MemberPhase {
  // Depth 0 is already the last thing before the reply, so there is nowhere
  // later to send a volatile member — the geometry `moves` explains, unchanged.
  if (member.volatile === true) return placement.depth >= 1 ? 'defer' : 'keep'
  if (member.settled === true) return 'promote'
  return 'keep'
}

/** A member as the provenance the message will carry: identity and text, no verdict. */
function partOf(member: ContributionMember): ContributionMember {
  return {
    id: member.id,
    ...member.label === undefined ? {} : { label: member.label },
    text: member.text,
  }
}

/**
 * Whether the cache-friendly reorder moves this contribution.
 *
 * Volatile contributions move, **except at depth 0**, and the exception is
 * geometry rather than policy:
 *
 * - A **system** section sits ahead of the whole conversation, so a volatile
 *   one costs the entire request. It moves.
 * - A **depth ≥ 1** injection sits *inside* the conversation, one or more
 *   floors from the end — which means it sits inside the run two turns would
 *   otherwise agree on. It moves. `CACHE-PREFIX.md` §3 提案 A rules that depth
 *   content must not be relocated, and its argument ("它们已经在新历史之后了")
 *   is true of depth 0 and false of depth 1 and deeper; measured, the residual
 *   jitter left in every conversation of this corpus after the system sections
 *   were handled was depth-placed.
 * - **Depth 0** is already the last thing before the reply. There is nowhere
 *   later to put it, and §提案 A's warning applies exactly here: moving it
 *   changes nothing about the prefix and only disturbs the `order` semantics
 *   inside the slot. It stays.
 *
 * **This answers for a contribution placed *whole*.** A contribution
 * {@link splitOf} admits is placed member by member instead, and its
 * contribution-level verdict is ignored rather than combined: a bucket is
 * marked volatile the moment its *membership* changes, which says nothing about
 * any entry in it, and that mark is exactly what the split exists to stop
 * reading. Combining the two would move the whole bucket *and* its members,
 * which is the one arrangement that could send text twice. The branch that
 * prevents that is in the three callers — {@link depthSlots},
 * {@link depthSegment} and {@link itemize} each ask `splitOf` first and only
 * consult this function on the `undefined` side. It is not repeated here: a
 * second guard inside this function would be unreachable, and unreachable code
 * with no test to fail is worse than none.
 * @param contribution - the contribution.
 * @param cacheFriendly - whether the reorder is enabled.
 * @returns true when it belongs in the volatile segment.
 */
function moves(contribution: Contribution, cacheFriendly: boolean): boolean {
  if (!cacheFriendly || contribution.volatile !== true) return false
  if (contribution.placement.kind === 'system') return true
  return contribution.placement.depth >= 1
}

/**
 * Whether the cache-friendly reorder moves this contribution **forward**, into
 * the prefix.
 *
 * Only depth placements can be promoted, and only ones observed unchanged
 * ({@link Contribution.settled}). A system placement is already in the prefix,
 * so promoting it would be a no-op that changed the order for nothing.
 *
 * **This is the larger of the two directions.** A depth injection is anchored
 * to the *end* of the conversation, so its absolute position moves forward by
 * one exchange every turn: two turns diverge at the newest floor, and every
 * byte of depth content behind that point is re-sent in full and charged in
 * full even when it is byte-identical. Measured over the corpus, that rent is
 * **100% depth-anchored** across 11 real adjacent pairs, 6 381 tokens a turn on
 * average — and it is invisible to any rule that only looks for content that
 * *changes*. Numbers and their source: the app-service ledger, §38.
 *
 * A volatile contribution is never promoted even if some earlier assembly had
 * settled it: {@link moves} and this function must not both claim the same
 * contribution, and volatility is the newer evidence.
 *
 * Like {@link moves}, this answers for a contribution placed **whole**; a split
 * one is decided by {@link memberPhase}, on the other side of a branch its
 * three callers take first.
 * @param contribution - the contribution.
 * @param cacheFriendly - whether the reorder is enabled.
 * @returns true when it belongs in the stable segment.
 */
function promotes(contribution: Contribution, cacheFriendly: boolean): boolean {
  return cacheFriendly
    && contribution.settled === true
    && contribution.volatile !== true
    && contribution.placement.kind === 'depth'
}

/**
 * One message the reorder emits somewhere other than the slot its contribution
 * asked for.
 *
 * `parts` is set only when the entry is one member of a split bucket, so the
 * member's own id and label ride to the trace: the message is not in the system
 * string, so the seams cannot name it, and a promoted entry that could only be
 * reported as its bucket would defeat the point of splitting it.
 */
interface SegmentEntry {
  id: string
  text: string
  role: Role
  parts?: ContributionMember[]
}

/** A segment entry with the keys it is sorted by. */
interface RankedEntry extends SegmentEntry {
  depth: number
  order: number
  sequence: number
  /** Position among its bucket's members, so a split bucket keeps upstream's order. */
  member: number
}

/**
 * One direction of the reorder, over depth placements and their members.
 *
 * Deepest first, which is the order the model would have read them: a depth-4
 * entry sat four floors from the end and a depth-1 entry one floor from it, so
 * the deeper one came first. Ties fall to `order`, then to the original
 * sequence, then — new with the split — to the member's position in its bucket,
 * so two entries promoted out of one bucket reach the model in the order
 * upstream joined them. Without that last key the group would keep its
 * *relative* order only by accident of the sort's stability.
 * @param contributions - every contribution.
 * @param cacheFriendly - whether the reorder is enabled.
 * @param phase - `promote` for the stable segment, `defer` for the volatile one.
 * @returns the entries for that segment, in reading order, none of them empty.
 */
function depthSegment(
  contributions: readonly Contribution[],
  cacheFriendly: boolean,
  phase: 'promote' | 'defer',
): SegmentEntry[] {
  const ranked: RankedEntry[] = []
  for (const item of depthItems(contributions)) {
    const rank = {
      depth: item.placement.depth,
      order: item.placement.order ?? 0,
      sequence: item.sequence,
    }
    const split = splitOf(item.contribution, cacheFriendly)
    if (split === undefined) {
      const takes = phase === 'promote'
        ? promotes(item.contribution, cacheFriendly)
        : moves(item.contribution, cacheFriendly)
      if (takes) {
        ranked.push({
          ...rank,
          member: 0,
          id: item.contribution.id,
          text: item.contribution.text,
          role: item.placement.role,
        })
      }
      continue
    }
    split.members.forEach((member, index) => {
      if (memberPhase(member, split.placement) !== phase) return
      ranked.push({
        ...rank,
        member: index,
        id: member.id,
        text: member.text,
        role: split.placement.role,
        parts: [partOf(member)],
      })
    })
  }
  return ranked
    .sort((left, right) =>
      right.depth - left.depth
      || left.order - right.order
      || left.sequence - right.sequence
      || left.member - right.member)
    .filter(entry => entry.text.trim().length > 0)
    .map(entry => ({
      id: entry.id,
      text: entry.text,
      role: entry.role,
      ...entry.parts === undefined ? {} : { parts: entry.parts },
    }))
}

/**
 * The stable segment: depth injections, and members of them, the reorder pulled
 * into the prefix.
 * @param contributions - every contribution.
 * @param cacheFriendly - whether the reorder is enabled.
 * @returns the promoted entries in reading order.
 */
function stableSegment(
  contributions: readonly Contribution[],
  cacheFriendly: boolean,
): SegmentEntry[] {
  if (!cacheFriendly) return []
  return depthSegment(contributions, cacheFriendly, 'promote')
}

/**
 * The system-placed contributions in the order they render, with the sort key
 * the join uses.
 *
 * Split out because three readers need the same sequence and must not compute
 * it separately: the join, the volatile segment, and the stable-prefix walk.
 * `sequence` is the index **among the system contributions**, which is what the
 * original single-expression version computed — a tie-break taken over the full
 * contribution list would sort differently the moment a depth placement sat
 * between two equal orders.
 * @param contributions - every contribution.
 * @returns system contributions, sorted by (order, sequence).
 */
function systemOrder(contributions: readonly Contribution[]): Contribution[] {
  return contributions
    .filter(item => item.placement.kind === 'system')
    .map((item, sequence) => ({ item, order: (item.placement as { order: number }).order, sequence }))
    .sort((left, right) => left.order - right.order || left.sequence - right.sequence)
    .map(entry => entry.item)
}

/**
 * The system-placed contributions that survive rendering, in rendered order.
 *
 * Empty text drops out rather than leaving a blank run: a section that
 * evaluated to nothing this turn should not cost the model a paragraph break
 * that looks like a missing instruction.
 *
 * The seams are the product here, not a byproduct. Once the segments are joined
 * the system prompt is one opaque string, and a request whose cache broke
 * somewhere inside it can only be reported as "the system prompt changed" — a
 * sentence that names the largest section of the request and no part of it.
 * {@link renderSystem} is defined in terms of this, so the two can never
 * disagree about where a segment begins.
 * @param contributions - every contribution.
 * @param cacheFriendly - when true, volatile sections are left out because
 *   {@link injectAtDepth} places them after the conversation instead; the seams
 *   then describe the system string as the reorder actually rendered it, which
 *   is the only string a trace can attribute offsets in.
 * @returns one segment per surviving system contribution.
 */
export function systemSegments(
  contributions: readonly Contribution[],
  cacheFriendly = false,
): SystemSegment[] {
  return systemOrder(contributions)
    .filter(item => !moves(item, cacheFriendly))
    .map(item => ({
      id: item.id,
      ...item.label === undefined ? {} : { label: item.label },
      text: item.text.trim(),
    }))
    .filter(segment => segment.text.length > 0)
}

/**
 * Join the system-placed contributions.
 * @param contributions - every contribution.
 * @param cacheFriendly - when true, volatile sections are left out of the join
 *   because {@link injectAtDepth} places them after the conversation instead.
 * @returns the system prompt.
 */
export function renderSystem(contributions: readonly Contribution[], cacheFriendly = false): string {
  return systemSegments(contributions, cacheFriendly).map(segment => segment.text).join(SYSTEM_JOIN)
}

/**
 * The volatile segment: the contributions the reorder moved, in the order the
 * model would have read them.
 *
 * Relative order is kept on purpose — the reorder is a translation of the whole
 * group past the conversation, not a reshuffle inside it. So the segment is
 * built in *reading* order: the system sections first (they came before the
 * whole conversation), then the lifted depth injections deepest-first (a depth-3
 * entry was read before a depth-1 one), each group keeping its own tie-breaks.
 * @param contributions - every contribution.
 * @param cacheFriendly - whether the reorder is enabled.
 * @returns the moved contributions with the role each should ride, empty when
 *   the reorder is off.
 */
function volatileSegment(
  contributions: readonly Contribution[],
  cacheFriendly: boolean,
): SegmentEntry[] {
  if (!cacheFriendly) return []
  const moved = systemOrder(contributions)
    .filter(item => moves(item, cacheFriendly))
    .map(item => ({ id: item.id, text: item.text, role: 'system' as Role }))

  const lifted = depthSegment(contributions, cacheFriendly, 'defer')

  return [...moved, ...lifted].filter(entry => entry.text.trim().length > 0)
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

/** What is left to place in a depth slot after the reorder has taken its share. */
interface SlottedDepth {
  placement: Extract<Placement, { kind: 'depth' }>
  sequence: number
  /** The contribution's id: a slot keeps its own name even when it is a remainder. */
  id: string
  /** The text this slot carries — the whole contribution, or the members that stayed. */
  text: string
  /** The members that stayed, when this slot came from a split bucket. */
  parts?: ContributionMember[]
  volatile: boolean
}

/**
 * The depth slots' occupants: whole contributions the reorder did not take, and
 * the remainder of the ones it took members out of.
 *
 * **The one place that decides what stays**, called by both the placement and
 * the budget charge, so the two cannot disagree about which text a slot holds.
 * The three groups — this, {@link stableSegment} and {@link volatileSegment} —
 * have to *partition* the contributions and their members: a member charged in
 * two of them would make the trim drop a floor that fits, and one charged in
 * none would let the conversation grow into space that is already spent.
 *
 * A split bucket keeps the **bucket's** id on its remainder rather than taking
 * the surviving member's, because the slot is still the bucket's slot; the
 * members ride in `parts`, which is where a reader looks to find out which
 * entries are left in it.
 * @param contributions - every contribution.
 * @param cacheFriendly - whether the reorder is enabled.
 * @returns one entry per depth slot that still has text, unsorted.
 */
function depthSlots(
  contributions: readonly Contribution[],
  cacheFriendly: boolean,
): SlottedDepth[] {
  const slotted: SlottedDepth[] = []
  for (const item of depthItems(contributions)) {
    const split = splitOf(item.contribution, cacheFriendly)
    if (split === undefined) {
      // The lifted and the promoted are excluded here rather than skipped
      // later: a depth injection going into a segment must not also occupy its
      // original slot, and filtering at the source is the only place that
      // cannot be forgotten by a later branch.
      if (moves(item.contribution, cacheFriendly) || promotes(item.contribution, cacheFriendly)) continue
      slotted.push({
        placement: item.placement,
        sequence: item.sequence,
        id: item.contribution.id,
        text: item.contribution.text,
        volatile: item.contribution.volatile === true,
      })
      continue
    }
    const kept = split.members.filter(member => memberPhase(member, split.placement) === 'keep')
    if (kept.length === 0) continue
    slotted.push({
      placement: item.placement,
      sequence: item.sequence,
      id: item.contribution.id,
      // Re-joined with the separator the bucket was joined with, so a slot
      // nothing was taken out of carries the contribution's own text back —
      // byte for byte, which is what makes "the split changed nothing here"
      // true rather than nearly true.
      text: kept.map(member => member.text).join(MEMBER_JOIN),
      parts: kept.map(partOf),
      // A remainder is volatile when any member left in it is: the flag answers
      // "will this slot's text differ next turn", and one moving member is
      // enough. Only depth 0 can be in this position — deeper volatile members
      // leave for the volatile segment.
      volatile: kept.some(member => member.volatile === true),
    })
  }
  return slotted
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
 *
 * Both cache-friendly segments ride here too, when
 * {@link AssembleInput.cacheFriendly} is on, and they sit at the two ends:
 *
 * - the **stable segment** (promoted depth injections) is emitted before the
 *   first floor, so it lands inside the run two turns agree on and stops being
 *   re-sent;
 * - the **volatile segment** is emitted at the depth-0 slot, *before* the
 *   depth-0 injections — a position that costs nothing, because everything from
 *   the newest floor onward is already past the divergence point, while keeping
 *   depth 0's own promise that it is the last thing before the reply.
 *
 * A contribution carrying {@link Contribution.members} takes part in all three
 * groups at once: its settled entries go into the stable segment as separate
 * messages, its volatile ones (deeper than 0) into the volatile segment, and
 * whatever is left is re-joined with {@link MEMBER_JOIN} and stays in the slot
 * under the bucket's own id. That is the whole point of the member list — the
 * bucket's hash moves whenever its *membership* does, so the bucket is the
 * wrong unit to ask "did this change" of.
 * @param history - the surviving conversation, oldest first.
 * @param contributions - every contribution; depth ones are spliced, and the
 *   classified ones become the two segments when `cacheFriendly` is on.
 * @param cacheFriendly - whether to emit the volatile segment.
 * @returns the conversation with injections in place.
 */
export function injectAtDepth(
  history: readonly HistoryEntry[],
  contributions: readonly Contribution[],
  cacheFriendly = false,
): PipelineMessage[] {
  const items = depthSlots(contributions, cacheFriendly)
  const moved = volatileSegment(contributions, cacheFriendly)
  const promoted = stableSegment(contributions, cacheFriendly)

  // One bucket per insertion point, including `history.length` for depth 0.
  const slots: SlottedDepth[][] = Array.from({ length: history.length + 1 }, () => [])

  for (const item of items) {
    const raw = history.length - item.placement.depth
    const index = Math.min(Math.max(raw, 0), history.length)
    ;(slots[index] as SlottedDepth[]).push(item)
  }

  for (const slot of slots) {
    slot.sort((left, right) =>
      (left.placement.order ?? 0) - (right.placement.order ?? 0) || left.sequence - right.sequence)
  }

  /**
   * One message for a segment entry.
   *
   * `parts` rides when the entry is a promoted or deferred **member**: its
   * message is not in the system string, so the seams cannot name it, and the
   * part is the only place the entry's own id and label can travel. A whole
   * contribution needs none — its `id` already names it, which is what every
   * segment message carried before the split existed.
   */
  const messageOf = (entry: SegmentEntry, volatile: boolean): PipelineMessage => ({
    role: entry.role,
    text: entry.text,
    id: entry.id,
    ...entry.parts === undefined ? {} : { parts: entry.parts },
    ...volatile ? { volatile: true } : {},
  })

  const messages: PipelineMessage[] = []
  // The stable segment goes in front of everything, including any injection
  // whose depth clamped to the front: those still slide as the conversation
  // grows (`history.length - depth` is negative and clamps), so putting the
  // promoted group behind them would leave it outside the prefix again.
  // Each promoted injection stays its own message and keeps its own `id`: it
  // did not fold into the system string, so the seams cannot name it and the
  // message is the only place its provenance can ride. A trace that could not
  // attribute these would mark every cache-friendly request unattributed —
  // the reorder's own messages reading as a defect.
  for (const item of promoted) messages.push(messageOf(item, false))
  for (let index = 0; index <= history.length; index += 1) {
    // The moved sections go in ahead of depth 0's own bucket, so a depth-0
    // injection stays the last thing before the reply.
    if (index === history.length) {
      // Same provenance rule as the promoted group: a deferred section left
      // the system string, so its id has to travel on the message.
      for (const item of moved) messages.push(messageOf(item, true))
    }
    for (const item of slots[index] as SlottedDepth[]) {
      if (item.text.trim().length === 0) continue
      // `id` is provenance, not content — `PipelineMessage.id` says why it
      // cannot reach a provider. Stamped here because here is the only place
      // that knows which contribution became which message: after this the
      // depth ordering has been applied and a downstream reader could only
      // recover it by matching text, which two contributions sharing a line
      // make a guess. `volatile` rides beside it and answers a different
      // question — provenance says which item, volatility says whether the
      // squash and the prefix walk may cross this message.
      //
      // `parts` is the finer half of the same answer, and it is set for a slot
      // that came from a member list: "the depth injection changed" names the
      // largest part of the request and no entry in it, and after a split it is
      // not even true of the whole slot any more.
      messages.push({
        role: item.placement.role,
        text: item.text,
        id: item.id,
        ...item.parts === undefined ? {} : { parts: item.parts },
        ...item.volatile ? { volatile: true } : {},
      })
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
 * How much of the request a prefix cache could serve next turn.
 *
 * Walked from the front and stopped at the first volatile part, because that
 * is what a prefix cache does: one changed byte costs everything behind it.
 * The walk crosses the system prompt's own section boundaries, so a volatile
 * world-info entry sitting eighth of ten sections reports about a fifth of the
 * request rather than "everything but that section".
 *
 * The separators are charged to the stable side: `count(system)` is taken over
 * the joined string when every section is stable, and over the joined prefix
 * when it is not, so the number is the same arithmetic the request itself uses.
 * @param contributions - every contribution.
 * @param messages - the assembled conversation.
 * @param cacheFriendly - whether the reorder moved the volatile sections out.
 * @param count - the token counter.
 * @returns tokens of the leading volatile-free run.
 */
function stablePrefixTokens(
  contributions: readonly Contribution[],
  messages: readonly PipelineMessage[],
  cacheFriendly: boolean,
  count: TokenCounter,
): number {
  const kept = systemOrder(contributions).filter(item => !moves(item, cacheFriendly))
  const sections: string[] = []
  for (const item of kept) {
    const text = item.text.trim()
    if (text.length === 0) continue
    // An empty section is not a boundary: it contributes no bytes, so a
    // volatile one that rendered to nothing cannot break anything.
    if (item.volatile === true) return count(sections.join(SYSTEM_JOIN))
    sections.push(text)
  }

  let total = count(sections.join(SYSTEM_JOIN))
  for (const message of messages) {
    if (message.volatile === true) break
    total += count(message.text)
  }
  return total
}

/**
 * Build one model request from its parts.
 * @param input - contributions, conversation and budget.
 * @returns the system prompt, the message list, and what had to be dropped.
 */
export function assemble(input: AssembleInput): AssembleResult {
  const { contributions, history, budget } = input
  const count = budget.count
  const cacheFriendly = input.cacheFriendly === true

  // The seams are taken with the same `cacheFriendly` the request is assembled
  // with, so they describe the system string that is actually sent: a deferred
  // section left the join, and a segment list that still named it would hand a
  // trace offsets past the end of the string.
  const segments = systemSegments(contributions, cacheFriendly)
  const system = segments.map(segment => segment.text).join(SYSTEM_JOIN)
  // The three terms of the charge below must **partition** the contributions
  // and their members: `moved` and `promoted` hold every relocated one, and
  // `depthSlots` returns exactly what is left, or a relocated injection would
  // be charged twice and the trim would drop a floor that fits.
  const items = depthSlots(contributions, cacheFriendly)
  const moved = volatileSegment(contributions, cacheFriendly)
  const promoted = stableSegment(contributions, cacheFriendly)

  // Charged before the trim, spent after it: the trim has to know what the
  // injections will occupy, but the injections have to be placed relative to
  // whatever history survives.
  //
  // The moved sections are charged here as their own term, because they left
  // `system` — without it the reorder would hand the trim a budget that looks
  // roomier by exactly the size of what it moved, and the conversation would
  // grow into space that is already spent. It is deliberately the *same* text:
  // the reorder changes where text sits, never how much of it there is.
  //
  // Not quite the same *number*, and the difference is separators. Text that
  // leaves a join takes no separator with it — the blank line between two
  // system sections, the newline between two members of a depth bucket — so a
  // reorder that lifts three sections and two entries out of their joins
  // charges a handful of tokens less than the unreordered assembly did, and the
  // pieces are counted at their own boundaries rather than across them. Both
  // effects are bounded by the number of seams moved; neither is a term the
  // trim can be off by a floor over.
  const fixed = count(system)
    + moved.reduce((total, item) => total + count(item.text), 0)
    + promoted.reduce((total, item) => total + count(item.text), 0)
    + items.reduce((total, item) => total + count(item.text), 0)
    + history.reduce((total, entry) => total + (entry.pinned === true ? count(entry.text) : 0), 0)

  const available = budget.context - budget.reserve - fixed
  const { kept, dropped } = trimHistory(
    history,
    Math.max(available, 0),
    count,
    budget.trimBlockFloors ?? DEFAULT_TRIM_BLOCK_FLOORS,
  )
  const messages = injectAtDepth(kept, contributions, cacheFriendly)

  const tokens = count(system) + messages.reduce((total, message) => total + count(message.text), 0)

  return {
    system,
    systemSegments: segments,
    messages,
    tokens,
    stablePrefixTokens: stablePrefixTokens(contributions, messages, cacheFriendly, count),
    overflow: { droppedHistory: dropped, overBudget: available < 0 },
    items: itemize(contributions, kept, count, cacheFriendly),
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
 * @param cacheFriendly - whether the reorder ran, so a moved row can say so.
 * @returns one row per contribution, plus one aggregate row for the conversation.
 */
export function itemize(
  contributions: readonly Contribution[],
  kept: readonly HistoryEntry[],
  count: TokenCounter,
  cacheFriendly = false,
): AssembledItem[] {
  const items: AssembledItem[] = contributions.map((contribution) => {
    const split = splitOf(contribution, cacheFriendly)
    const phases = split?.members.map(member => memberPhase(member, split.placement)) ?? []
    /** Whether every member went the same way, which is when the row can speak for them. */
    const all = (phase: MemberPhase): boolean => phases.length > 0 && phases.every(one => one === phase)
    const members: AssembledMember[] = (split?.members ?? []).map((member, index) => ({
      id: member.id,
      ...member.label === undefined ? {} : { label: member.label },
      tokens: count(member.text),
      ...phases[index] === 'defer' ? { deferred: true } : {},
      ...phases[index] === 'promote' ? { promoted: true } : {},
    }))
    return {
      id: contribution.id,
      ...contribution.label === undefined ? {} : { label: contribution.label },
      kind: contribution.placement.kind,
      tokens: count(contribution.text),
      ...contribution.placement.kind === 'depth'
        ? { depth: contribution.placement.depth, role: contribution.placement.role }
        : {},
      // Reported even for a section that rendered empty and therefore was not
      // actually emitted: the row exists to answer "where did my text go", and
      // an empty volatile section is still classified volatile, which is the
      // fact a reader is checking.
      //
      // For a split bucket the two marks mean **all of its members**, because
      // that is the only reading under which one mark on one row is true. A
      // bucket whose members went different ways carries neither and is read
      // through `members` instead — a 19 KB injection with two entries in the
      // prefix and one still at depth 0 has no honest single-row answer, and
      // inventing one would tell a reader their whole world-info block moved.
      ...split === undefined
        ? {
            ...moves(contribution, cacheFriendly) ? { deferred: true } : {},
            ...promotes(contribution, cacheFriendly) ? { promoted: true } : {},
          }
        : {
            ...all('defer') ? { deferred: true } : {},
            ...all('promote') ? { promoted: true } : {},
            members,
          },
    }
  })

  items.push({
    id: 'chatHistory',
    label: 'Chat History',
    kind: 'history',
    tokens: kept.reduce((total, entry) => total + count(entry.text), 0),
  })
  return items
}
