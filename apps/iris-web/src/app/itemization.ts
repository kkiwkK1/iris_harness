/**
 * Reading a prompt breakdown.
 *
 * Measured across six real presets against one real card, the largest single part
 * held between **23% and 92%** of the prompt. So there is no one shape to design
 * for: sometimes it is one column and a pile of rubble, sometimes fifty
 * comparable parts. (An earlier version of this comment said 66% as though it
 * were the rule; that came from a single sample.)
 *
 * What holds across both extremes is what this module does. Ordering by size
 * matters *more* in the flat case, not less — a 23% maximum spread over fifty
 * rows is exactly the distribution the eye cannot rank. And computing every
 * row's share is what lets a reader tell the two situations apart at all.
 *
 * @module iris-web/app/itemization
 */

import type { PromptItemEntry, PromptItemExplanation, PromptItemization, PromptItemMember, PromptItemSource, PromptMessageSlot } from '@iris/protocol'

/**
 * The part of a row both the row and its members carry.
 *
 * An explanation hangs on a row and on each of its members with the same shape,
 * so the two readers below take this rather than `PromptItemEntry` — a member is
 * not an entry (no `kind`, no placement) and duplicating the functions for it
 * would be a second place for the copy to drift.
 */
export type Explained = { tokens: number, explanation?: PromptItemExplanation }

/** How the rows are ordered. */
export type ItemOrder = 'size' | 'assembly'

/** One row, with what the panel needs that the contract does not carry. */
export interface ItemRow {
  entry: PromptItemEntry
  /** Fraction of the total, 0–1. */
  share: number
  /**
   * One-based position in the host's own list, and its length.
   *
   * The host sends entries in **contribution** order — the order the preset and
   * the card asked for. Both display orders reshuffle that, so a row moved by
   * the cache-friendly reorder has to be able to say where it came from, and
   * "row 8 of 41" is the only form of that a reader can use: the ids are UUIDs
   * and the orders are internal numbers.
   */
  origin: { at: number, total: number }
}

/**
 * Where in the request a row is actually sent, as a sort rank.
 *
 * Coarse on purpose — three phases, not a message index. The host's breakdown
 * has one aggregate row for the whole conversation, so there is no finer
 * position to be had, and a rank that pretended otherwise would be a number the
 * contract cannot support.
 * @param entry - the row.
 * @returns 0 for promoted, 1 for in place, 2 for deferred.
 */
function phaseOf(entry: PromptItemEntry): number {
  if (entry.promoted === true) return 0
  if (entry.deferred === true) return 2
  return 1
}

/**
 * Order the entries for display.
 *
 * `size` answers "what is eating my context", which is the question the panel
 * exists for. `assembly` answers "is my preset ordered the way I think", which is
 * a different and rarer question — kept because the contract's order *is* the
 * assembly order and discarding it would throw away information the host went to
 * the trouble of preserving.
 *
 * Ties keep the host's order, so a re-render cannot reshuffle equal rows.
 *
 * **`assembly` is no longer the host's order verbatim.** With
 * `GenerationSettings.cacheFriendly` on, a `deferred` row is sent after the
 * whole conversation and a `promoted` one before it, neither from where it sits
 * in the list — so this order groups the rows into those three phases. The
 * host's list stays contribution order (that is the reading the *other* button
 * wants, and `origin` preserves it either way); making the assembly view agree
 * with the request is the whole point of its name.
 * @param entries - the entries as the host sent them.
 * @param order - the chosen order.
 * @param total - the reported total, used for each row's share.
 * @returns rows ready to render.
 */
export function rowsFor(
  entries: readonly PromptItemEntry[],
  order: ItemOrder,
  total: number,
): ItemRow[] {
  const rows = entries.map((entry, at) => ({
    entry,
    at,
    // Guarded rather than assumed: a zero total is a real answer for an empty
    // chat, and dividing by it would put NaN into every bar width.
    share: total > 0 ? entry.tokens / total : 0,
    origin: { at: at + 1, total: entries.length },
  }))

  if (order === 'size') {
    rows.sort((left, right) => right.entry.tokens - left.entry.tokens || left.at - right.at)
  } else {
    // Three phases, in the order the request carries them: promoted rows first
    // (they are sent ahead of the conversation), then everything in its own
    // place, then deferred rows (sent after it). Within a phase the host's
    // order stands, so a re-render cannot reshuffle anything.
    rows.sort((left, right) => phaseOf(left.entry) - phaseOf(right.entry) || left.at - right.at)
  }

  return rows.map(({ entry, share, origin }) => ({ entry, share, origin }))
}

/**
 * The sentence a zero row owes its reader, as an i18n key, or none.
 *
 * `tokens === 0` is where the panel used to stop, and it is exactly where the
 * question starts: 23 of 38 rows on one measured conversation were zero, from
 * three different causes that lead a reader to three different places. The
 * contract now carries the cause; this turns it into a word.
 *
 * **Rendered only beside a zero.** A `zeroReason` on a row that carries text is
 * a host contradiction rather than a thing to display, and the safe reading of
 * that contradiction is the one the numbers already support. Returning `null`
 * for "not explained" is deliberate: an old host's record has no reason, and a
 * sentence invented for it would claim a cause nobody measured.
 * @param entry - one itemization row.
 * @returns an i18n key, or null when there is nothing to say.
 */
export function zeroReasonKey(entry: Explained): string | null {
  if (entry.tokens !== 0) return null
  switch (entry.explanation?.zeroReason) {
    case 'macros-only': return 'promptZeroMacrosOnly'
    case 'marker-unfilled': return 'promptZeroMarkerUnfilled'
    case 'blank': return 'promptZeroBlank'
    case 'trimmed': return 'promptZeroTrimmed'
    case 'dropped-by-budget': return 'promptZeroDropped'
    default: return null
  }
}

/**
 * What wrote a row's bytes, as an i18n key and its one slot, or none.
 *
 * The other half of the explanation: a zero row says *why* it is empty and the
 * source says *whose* emptiness it is — a card's `scenario` field or a world
 * book's — which is the field a reader then goes and fills.
 *
 * The kinds are a closed set, so a `Record` rather than a `switch`: a sixth
 * kind added to the contract reddens the compiler here, which is where the copy
 * decision belongs.
 * @param entry - one itemization row.
 * @returns the key and its `{name}` slot, or null when not explained.
 */
export function sourceNoteKey(entry: Explained): { key: string, name: string } | null {
  const source = entry.explanation?.source
  if (source === undefined) return null
  const keys: Record<PromptItemSource['kind'], string> = {
    preset: 'promptSourcePreset',
    card: 'promptSourceCard',
    worldbook: 'promptSourceWorldbook',
    history: 'promptSourceHistory',
    script: 'promptSourceScript',
    host: 'promptSourceHost',
  }
  const key = keys[source.kind]
  // The label when the author gave one, the id otherwise — the id is often a
  // UUID (29 of a real preset's 41), so the label is what a person reads.
  return { key, name: source.label ?? source.id }
}

/**
 * One part inside a message, as the message view needs it.
 *
 * Resolved from a row or a member where the host explained one, and from a
 * floor's own id where the part is a conversation line — the conversation is an
 * aggregate row by contract, so its floors have no entry to look up and their
 * number is the whole of what is knowable here.
 */
export interface MessagePart {
  id: string
  /** What to show: the entry's label, or `floor 6` for a conversation line. */
  label: string
  kind: PromptItemEntry['kind']
  /** What this part costs, when the host names it — absent for a floor. */
  tokens?: number
  explanation?: PromptItemExplanation
  /**
   * True when this part is a conversation floor rather than an assembly item.
   *
   * A floor has no label of its own and no per-floor token in this contract, so
   * a surface renders its number and takes the message's own cost as the answer.
   */
  floor: boolean
}

/** One final message, with its parts resolved to something renderable. */
export interface MessageRow {
  index: number
  role: string
  tokens: number
  stable: boolean
  parts: MessagePart[]
}

/**
 * The request read as messages, rather than as contributions.
 *
 * The same assembly seen the other way round: `entries` is a table of parts that
 * says which message each went to, and this is the list of messages that says
 * which parts each holds. Both are on the contract, and they come from the one
 * pass that built the request, so a reader can switch between the two views
 * without either re-deriving the other.
 *
 * Parts are resolved against the entries and their members. A part no entry
 * names is a conversation floor (`history.N`), which the itemization folds into
 * one aggregate row on purpose — its number is all this view can honestly say
 * about it.
 *
 * Returns an empty list for a host that does not send `messages` — an older
 * record — so a caller renders nothing rather than a message list with no
 * provenance in it.
 * @param itemization - the host's answer.
 * @returns one row per final message, in the request's own order.
 */
export function messageRows(itemization: PromptItemization): MessageRow[] {
  const known = new Map<string, { part: Omit<MessagePart, 'floor'> }>()
  for (const entry of itemization.entries) {
    known.set(entry.id, {
      part: {
        id: entry.id,
        label: entry.label,
        kind: entry.kind,
        tokens: entry.tokens,
        ...entry.explanation === undefined ? {} : { explanation: entry.explanation },
      },
    })
    for (const member of entry.members ?? []) {
      known.set(member.id, {
        part: {
          id: member.id,
          label: member.label,
          // A member rides inside its bucket's placement, so it shares the
          // bucket's kind — a world-info entry at depth 0 is a depth part.
          kind: entry.kind,
          tokens: member.tokens,
          ...member.explanation === undefined ? {} : { explanation: member.explanation },
        },
      })
    }
  }

  return (itemization.messages ?? []).map((slot: PromptMessageSlot) => ({
    index: slot.index,
    role: slot.role,
    tokens: slot.tokens,
    stable: slot.stable,
    parts: slot.partIds.map((id) => {
      const entry = known.get(id)
      if (entry !== undefined) return { ...entry.part, floor: false }
      // A floor. `history.6` is the host's id; the number after the dot is the
      // only human-readable form of it, and the divergence module already
      // prints floors the same way.
      return {
        id,
        label: id.startsWith('history.') ? `floor ${id.slice('history.'.length)}` : id,
        kind: 'history' as const,
        floor: true,
      }
    }),
  }))
}

/**
 * The entries of a split row worth showing under it, or none.
 *
 * A world-info depth bucket is **one** row here and several entries in the
 * request. When the host classified those entries separately and they went
 * different ways, the row above carries no badge at all — no single mark is
 * true of it — so the answer has to appear per entry, or the panel goes silent
 * about the largest row it has.
 *
 * **Empty unless at least one entry actually moved**, and that is the decision
 * this function exists to hold. A bucket that was split and stayed put is the
 * ordinary case, and five unmarked sub-rows under it would bury the rows that
 * did move. Once one entry has moved the *whole* list is shown, the unmoved
 * ones included: "these two went forward and this one stayed" is the reading,
 * and a list of only the movers cannot express its second half.
 *
 * A pure function rather than a condition inside the JSX so that it can be
 * asserted directly. A source-text check ("the panel mentions `members`")
 * cannot tell reading the field from naming it — measured: one stayed green
 * with the whole sub-list disabled.
 * @param entry - one itemization row.
 * @returns the entries to render beneath it, in the host's order; empty when
 *   there is nothing to say.
 */
export function splitMembers(entry: PromptItemEntry): PromptItemMember[] {
  const members = entry.members ?? []
  const moved = members.some(member => member.deferred === true || member.promoted === true)
  return moved ? [...members] : []
}

/**
 * The parts that actually divide the prompt.
 *
 * A zero-token entry is real — 14 of one preset's 53 were zero, from markers with
 * nothing to fill them and enabled prompts with empty content — but it occupies
 * none of the prompt, so it has no place in a picture of how the prompt is
 * divided. Drawing it anyway, at the one-pixel minimum that protects genuinely
 * small parts, would claim it takes up space.
 *
 * It stays in the table, where its presence is the answer to "why is my X not
 * getting through".
 * @param entries - every entry.
 * @returns those with a nonzero cost.
 */
export function contributing(entries: readonly PromptItemEntry[]): PromptItemEntry[] {
  return entries.filter(entry => entry.tokens > 0)
}

/**
 * Check the breakdown against its own total.
 *
 * The contract says the entries sum to `tokens` and the host has a test to that
 * effect. This checks anyway, and not from distrust: a breakdown that does not
 * add up is worse than no breakdown, because every number in it still looks
 * authoritative. If the two ever disagree the panel says so instead of drawing
 * bars against a total that is not the sum of them.
 * @param itemization - the host's answer.
 * @returns the discrepancy, or undefined when it adds up.
 */
export function discrepancy(itemization: PromptItemization): number | undefined {
  const summed = itemization.entries.reduce((sum, entry) => sum + entry.tokens, 0)
  return summed === itemization.tokens ? undefined : summed - itemization.tokens
}

/**
 * How much of the context window this prompt is using.
 *
 * Against `context - reserve` rather than `context`: the reserve is set aside for
 * the reply, so it was never available to the prompt and counting it would make
 * a request that is about to be truncated look comfortable.
 * @param itemization - the host's answer.
 * @returns the available budget and the fraction used, 0–1 and possibly above 1.
 */
export function budgetUse(itemization: PromptItemization): { available: number, used: number } {
  const available = Math.max(0, itemization.budget.context - itemization.budget.reserve)
  return { available, used: available > 0 ? itemization.tokens / available : 0 }
}

/**
 * What to tell the reader about which mode they are looking at.
 *
 * Three states, not two. A preview that was *asked for* is normal; a preview that
 * arrived because a record had expired is a different fact, and the contract
 * makes it visible precisely so the panel can say "the record is gone" rather
 * than showing a blank or an error. The host cannot distinguish these — only the
 * caller knows what it asked for.
 * @param itemization - the host's answer.
 * @param requestedTurn - the turn the caller asked about, or undefined for a preview.
 * @returns a state the panel can switch on.
 */
export function itemizationMode(
  itemization: PromptItemization,
  requestedTurn: number | undefined,
): 'record' | 'preview' | 'expired' {
  if (!itemization.preview) return 'record'
  return requestedTurn === undefined ? 'preview' : 'expired'
}
