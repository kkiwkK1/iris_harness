/**
 * The entry editor's mechanics: the list sorts, the list filter, and the
 * local-draft state a whole-book save is built from.
 *
 * **Everything here is pure.** The panel renders it, the store holds one
 * instance of it, and the tests drive it without a DOM or a host — which is
 * the point, because the two halves most likely to quietly disagree with
 * SillyTavern (the sort order and the field round trip) are exactly the ones
 * that can be pinned without either.
 *
 * The sort table is transcribed, not designed. Upstream's selector lives at
 * `index.html:4838` (`#world_info_sort_order`) and its comparator at
 * `world-info.js` `sortWorldInfoEntries`; every rule, every direction, and the
 * two silent tie-breakers below are upstream's, in upstream's terms. The one
 * deliberate rename is cosmetic: upstream's `option value="13"` is called
 * `custom` here, its `data-rule`, rather than a number nobody reads.
 *
 * @module iris-web/app/worldbook-editor
 */

import type { WorldbookEntry } from '@iris/protocol'

/**
 * One list sort, in upstream's terms.
 *
 * `field`/`order`/`rule` are the three `data-*` attributes upstream's selector
 * option carries; a rule of `'field'` means the plain "sort by this field"
 * path — `localeCompare` for strings, numeric difference otherwise — which is
 * upstream's `else` branch rather than one of its named rules.
 */
export interface WiSort {
  /** Stable id, and the label key suffix in the dictionary (`wiSort_<id>`). */
  id: WiSortId
  /** The entry field, for the plain field sorts; absent for the named rules. */
  field?: 'comment' | 'content' | 'depth' | 'order' | 'uid' | 'probability'
  /** Upstream's `data-order`: the direction the field is walked in. */
  order?: 'asc' | 'desc'
  /** Upstream's `data-rule`, when the sort is a named rule rather than a field. */
  rule?: 'priority' | 'custom' | 'length' | 'search'
}

/**
 * One of {@link WI_SORTS}' ids, spelled out rather than derived from the table
 * — the table's type names this union, so deriving it back would be a cycle.
 */
export type WiSortId =
  | 'priority' | 'custom'
  | 'title_asc' | 'title_desc'
  | 'tokens_asc' | 'tokens_desc'
  | 'depth_asc' | 'depth_desc'
  | 'order_asc' | 'order_desc'
  | 'uid_asc' | 'uid_desc'
  | 'probability_asc' | 'probability_desc'
  | 'search'

/**
 * Every sort upstream's selector offers, in its order.
 *
 * The ids read as the pairs they are: upstream ships fourteen visible options —
 * direction twins on six fields plus the `priority` and `custom` rules — plus
 * one hidden `search` option that takes over while a filter term is set. The
 * number the task's checklist calls "10 kinds" was counted off an older
 * selector; the live 1.18.0 install has these fifteen, and shipping a subset
 * would mean an entry order upstream can produce and this shell cannot.
 */
export const WI_SORTS: readonly WiSort[] = [
  { id: 'priority', rule: 'priority' },
  { id: 'custom', rule: 'custom' },
  { id: 'title_asc', field: 'comment', order: 'asc' },
  { id: 'title_desc', field: 'comment', order: 'desc' },
  { id: 'tokens_asc', field: 'content', order: 'asc', rule: 'length' },
  { id: 'tokens_desc', field: 'content', order: 'desc', rule: 'length' },
  { id: 'depth_asc', field: 'depth', order: 'asc' },
  { id: 'depth_desc', field: 'depth', order: 'desc' },
  { id: 'order_asc', field: 'order', order: 'asc' },
  { id: 'order_desc', field: 'order', order: 'desc' },
  { id: 'uid_asc', field: 'uid', order: 'asc' },
  { id: 'uid_desc', field: 'uid', order: 'desc' },
  { id: 'probability_asc', field: 'probability', order: 'asc' },
  { id: 'probability_desc', field: 'probability', order: 'desc' },
  { id: 'search', rule: 'search' },
]

/** The default is upstream's own first visible option. */
export const DEFAULT_WI_SORT: WiSortId = 'priority'

/**
 * How many times the filter's text appears in one entry, weighted by field.
 *
 * Upstream hands this question to its filter plugin and keeps the score
 * private to it, so the weights here are this shell's own — chosen so a title
 * hit outranks a body hit, which is the only claim the sort makes on screen.
 * Zero means the entry does not match, which is what {@link searchWiEntries}
 * filters on; the two are one function so the list and its sort cannot
 * disagree about what matched.
 * @param entry - the entry to score.
 * @param needle - the lowered filter text.
 * @returns the weighted hit count.
 */
export function wiSearchScore(entry: WorldbookEntry, needle: string): number {
  if (needle === '') return 0
  const occurrences = (haystack: string): number => {
    let count = 0
    let at = haystack.toLowerCase().indexOf(needle)
    while (at !== -1) {
      count += 1
      at = haystack.toLowerCase().indexOf(needle, at + needle.length)
    }
    return count
  }
  return occurrences(entry.name) * 3
    + entry.strategy.keys.reduce((sum, key) => sum + occurrences(key), 0) * 2
    + entry.strategy.keys_secondary.keys.reduce((sum, key) => sum + occurrences(key), 0) * 2
    + occurrences(entry.content)
}

/**
 * Keep the entries whose title, keys, or content contain the text.
 *
 * Case-insensitive and order-preserving: a filter narrows the list, it does
 * not rank it — ranking is the `search` sort's job, and only when asked.
 * @param entries - the entries as the editor holds them.
 * @param query - the filter text, verbatim; empty keeps everything.
 * @returns the entries that match, in the order they arrived.
 */
export function searchWiEntries(entries: readonly WorldbookEntry[], query: string): WorldbookEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...entries]
  return entries.filter(entry => wiSearchScore(entry, needle) > 0)
}

/**
 * Order the entries the way upstream's selector would.
 *
 * **The tie-breakers are load-bearing and they are upstream's.** Every primary
 * rule here has many ties (a hundred entries share one `depth`), so the
 * comparator that only did the primary sort would scramble the list on every
 * re-render. Upstream appends `order` **descending**, then `uid` ascending,
 * and this copies both — a list sorted here and a list sorted there agree row
 * for row, which is what makes the sort worth pinning in tests.
 * @param entries - the entries to order; not mutated.
 * @param sortId - which selector option is active.
 * @param scores - match scores for the `search` rule, as {@link wiSearchScore}
 *   produced them; only read when `sortId` is `'search'`.
 * @returns a new array, in the sorted order.
 */
export function sortWiEntries(
  entries: readonly WorldbookEntry[],
  sortId: WiSortId = DEFAULT_WI_SORT,
  scores?: ReadonlyMap<number, number>,
): WorldbookEntry[] {
  // An unknown id falls back to the default row — upstream's own first option
  // — rather than to a sort that compares nothing. `WiSortId` makes that
  // unreachable from typed callers; the fallback is for a stale stored value.
  const sort = WI_SORTS.find(row => row.id === sortId) ?? { id: DEFAULT_WI_SORT, rule: 'priority' as const }
  const sign = sort.order === 'desc' ? -1 : 1

  // Upstream: "secondary and tertiary it will always be sorted by Order
  // descending, and last UID ascending".
  const secondary = (left: WorldbookEntry, right: WorldbookEntry): number => right.position.order - left.position.order
  const tertiary = (left: WorldbookEntry, right: WorldbookEntry): number => left.uid - right.uid

  let primary: (left: WorldbookEntry, right: WorldbookEntry) => number
  if (sort.rule === 'search') {
    // Upstream sorts by its filter's stored score ascending. Missing scores
    // sort as zero, which puts unmatched entries first — the same place
    // upstream's `getScore` puts an entry it has no record of.
    primary = (left, right) => (scores?.get(left.uid) ?? 0) - (scores?.get(right.uid) ?? 0)
  } else if (sort.rule === 'priority') {
    // Upstream: first constant, then normal, then disabled.
    const rank = (entry: WorldbookEntry): number => !entry.enabled ? 2 : entry.strategy.type === 'constant' ? 0 : 1
    primary = (left, right) => rank(left) - rank(right)
  } else if (sort.rule === 'custom') {
    // Upstream sorts by `displayIndex`, which the wire does not carry — but
    // `worldbook.get` answers already ordered by it, so arrival order *is* the
    // arrangement the user chose. The list is copied and left alone; the
    // tie-breakers stay out of it, because inserting them here would reshuffle
    // the one sort whose whole meaning is "as I arranged it".
    return [...entries]
  } else {
    const field = sort.field ?? 'uid'
    // The view nests two of the sortable fields: `depth` and `order` live
    // under `position`, and upstream's `comment` is called `name` here. A
    // flat `entry[field]` would read `undefined` for half the table and the
    // comparator would silently degrade to the tie-breakers.
    const read = (row: WorldbookEntry): string | number => {
      switch (field) {
        case 'comment': return row.name
        case 'depth': return row.position.depth
        case 'order': return row.position.order
        case 'uid': return row.uid
        case 'probability': return row.probability
        case 'content': return row.content
        default: return row.uid
      }
    }
    primary = (left, right) => {
      const a = read(left)
      const b = read(right)
      if (typeof a === 'string' && typeof b === 'string') {
        if (sort.rule === 'length') return sign * (a.length - b.length)
        return sign * a.localeCompare(b)
      }
      return sign * (Number(a) - Number(b))
    }
  }

  return [...entries].sort((left, right) => {
    const byPrimary = primary(left, right)
    const bySecondary = secondary(left, right)
    return byPrimary !== 0 ? byPrimary : bySecondary !== 0 ? bySecondary : tertiary(left, right)
  })
}

/**
 * The editor's local state for one open book.
 *
 * `drafts` is what the fields edit — a deep copy, so a keystroke never writes
 * through to the answer the host gave. `baseline` is that answer, kept beside
 * the drafts so "does this book have unsaved changes" is a comparison the
 * reader can trust rather than a flag somebody forgot to set.
 *
 * This is client-authored state, not a host projection: the store holds it so
 * a drawer can close and reopen without losing the work, and the host never
 * sees it until `worldbook.replace` carries the whole draft list.
 */
export interface WiEditorState {
  /** The book's name, exactly as `worldbook.get` was asked for it. */
  book: string
  /** The editable copy, in the order the host answered (its display order). */
  drafts: WorldbookEntry[]
  /** The host's last answer, untouched, for the dirty comparison. */
  baseline: WorldbookEntry[]
}

/**
 * Open the editor on a book.
 * @param book - the book's name.
 * @param entries - the host's answer, as `worldbook.get` returned it.
 * @returns fresh state with no unsaved changes.
 */
export function openWiEditor(book: string, entries: readonly WorldbookEntry[]): WiEditorState {
  // Copied through JSON rather than `structuredClone`, because the drafts cross
  // a `JSON.stringify` boundary on their way to `worldbook.replace`: a value
  // that cannot survive serialization is dropped here, at open, rather than
  // discovered at save.
  const copy = JSON.parse(JSON.stringify(entries)) as WorldbookEntry[]
  return { book, drafts: copy, baseline: JSON.parse(JSON.stringify(entries)) as WorldbookEntry[] }
}

/**
 * Fold the host's post-save answer in as the new baseline.
 *
 * Held from the answer rather than from the drafts: the host resolves uids and
 * reorders by its own rules, and claiming "saved" over a list the host did not
 * send back is how a silent divergence becomes permanent.
 * @param state - the editor state.
 * @param entries - what `worldbook.replace` answered.
 * @returns state with the drafts reset to the answer and no unsaved changes.
 */
export function markSaved(state: WiEditorState, entries: readonly WorldbookEntry[]): WiEditorState {
  const answer = JSON.parse(JSON.stringify(entries)) as WorldbookEntry[]
  return { ...state, drafts: answer, baseline: JSON.parse(JSON.stringify(answer)) as WorldbookEntry[] }
}

/**
 * Apply one field edit to one entry.
 *
 * Structural, by `uid`: the other drafts keep their identity, so a keystroke
 * in one entry's textarea does not re-render the other ninety-six.
 * @param state - the editor state.
 * @param uid - which entry changed.
 * @param patch - the fields to set. `undefined` values are ignored; to clear
 *   an optional override, send `null` where the field allows it.
 * @returns new state; the baseline is untouched.
 */
export function updateWiEntry(
  state: WiEditorState,
  uid: number,
  patch: Partial<WorldbookEntry>,
): WiEditorState {
  const meaningful = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  )
  return {
    ...state,
    drafts: state.drafts.map(draft => draft.uid === uid
      ? { ...draft, ...meaningful }
      : draft),
  }
}

/**
 * Whether two entries say the same thing, field for field, deeply.
 *
 * Compared through their JSON text, which is the same serialization a save
 * crosses: a difference the wire cannot carry is not a difference, and an
 * edit that round-trips to the same bytes is not unsaved work.
 */
function sameEntry(left: WorldbookEntry, right: WorldbookEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * The uids whose drafts differ from the baseline.
 *
 * The save button and the unsaved-changes warning are both phrased from this:
 * "N entries changed" names the work, and an empty set means the list is as
 * the host last answered.
 * @param state - the editor state.
 * @returns the changed uids, in draft order.
 */
export function changedUids(state: WiEditorState): number[] {
  const baseline = new Map(state.baseline.map(entry => [entry.uid, entry]))
  const changed: number[] = []
  for (const draft of state.drafts) {
    const original = baseline.get(draft.uid)
    if (original === undefined || !sameEntry(draft, original)) changed.push(draft.uid)
  }
  return changed
}

/** Whether the book has edits the host has not been given. */
export function isDirty(state: WiEditorState): boolean {
  return changedUids(state).length > 0
}

/**
 * Split one keys field's text into the list it stores.
 *
 * Upstream's plaintext key input is comma-separated, and its semantics are
 * kept: parts are trimmed, and an empty part — the trailing comma every
 * typist leaves — stores nothing.
 * @param text - the field's text, verbatim.
 * @returns the keys it names, in order.
 */
export function parseKeyList(text: string): string[] {
  return text.split(',').map(part => part.trim()).filter(part => part !== '')
}

/**
 * Render a keys list as the text a comma-separated input shows.
 * @param keys - the stored keys.
 * @returns the text, with `', '` between the parts.
 */
export function formatKeyList(keys: readonly string[]): string {
  return keys.join(', ')
}
