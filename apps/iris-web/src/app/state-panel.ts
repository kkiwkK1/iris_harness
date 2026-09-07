/*
 * The state margin's decisions, as functions `node --test` can load.
 *
 * They live here rather than in `StatePanel.tsx` for the reason
 * `host-report-rows.ts` was split out: **a `.tsx` cannot be loaded by the test
 * runner**, so a decision left in the component is a decision nothing asserts.
 * The component keeps only rendering; everything that decides something — what
 * changed between two floors, what a search keeps, how a fold is remembered —
 * is a pure function here.
 *
 * **Everything works on data shape, never on card identity.** No branch in this
 * file names a card, a Chinese key, or `stat_data` specifically: a branch is a
 * value `branchEntries` can take apart, and a leaf is everything else. That is
 * what makes one panel serve every MVU card instead of a lucky subset.
 *
 * @module iris-web/app/state-panel
 */

import { translate, type Language } from './i18n/strings.ts'

/**
 * How one value wants to be typeset.
 *
 * `faint` marks a value that is present but says nothing — the literal string
 * `未知` or `unknown` — which is drawn dimmed rather than drawn as fact.
 */
export type Shown =
  | { kind: 'text', text: string, numeric: boolean, faint: boolean }
  | { kind: 'absent' }
  | { kind: 'branch', entries: [string, unknown][] }

/** The scalar types that can share one line with their key. */
const SCALARS: readonly string[] = ['string', 'number', 'boolean']

/**
 * Whether a value is a branch the tree can recurse into.
 *
 * Arrays count only when they hold something a numbered row can show: a list of
 * scalars collapses to a single line instead (three tags are a value, not
 * structure), so the filter and the renderer agree on where the branches are.
 */
function isBranch(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return !(value.length === 0 || value.every(entry => entry === null || SCALARS.includes(typeof entry)))
  }
  return true
}

/**
 * Take a branch value apart the way the tree will show it.
 *
 * Array children are keyed one-based, because these are positions a reader
 * counts, not indices.
 * @param value - a value `isBranch` has already accepted.
 * @returns its named children.
 */
export function branchEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) return value.map((entry, at) => [String(at + 1), entry])
  return Object.entries(value as Record<string, unknown>)
}

/** How many children a branch value has, for a count badge on a removed row. */
export function branchSize(value: unknown): number {
  if (value === null || typeof value === 'undefined') return 0
  if (Array.isArray(value)) return value.length
  if (typeof value === 'object') return Object.keys(value).length
  return 1
}

/**
 * Decide how a value is drawn, which is the only place kinds are distinguished.
 * @param value - the raw value from the snapshot.
 * @param lang - which language the yes/no words take.
 * @returns how to draw it.
 */
export function describe(value: unknown, lang: Language = 'en'): Shown {
  if (value === null || value === undefined) return { kind: 'absent' }
  if (typeof value === 'boolean') {
    return { kind: 'text', text: translate(lang, value ? 'booleanYes' : 'booleanNo'), numeric: false, faint: false }
  }
  if (typeof value === 'number') return { kind: 'text', text: String(value), numeric: true, faint: false }
  if (typeof value === 'string') {
    // An empty string and a missing key are the same thing to a reader, and
    // drawing one as a blank line leaves them wondering whether it failed to load.
    if (value.trim() === '') return { kind: 'absent' }
    // `未知` is what a card writes when a stat has no reading yet. It is a value
    // the card did write, so it is shown — but dimmed, the way absence is,
    // because presenting it the same as a real reading makes every unscanned
    // entry look like data. Matched exactly and case-blind, by shape: no card's
    // key vocabulary is involved.
    const lower = value.trim().toLowerCase()
    if (lower === '未知' || lower === 'unknown') {
      return { kind: 'text', text: value.trim(), numeric: false, faint: true }
    }
    return { kind: 'text', text: value, numeric: false, faint: false }
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'absent' }
    const flat = value.every(entry => entry === null || SCALARS.includes(typeof entry))
    if (flat) {
      return {
        kind: 'text',
        text: value.map(entry => (entry === null ? '—' : String(entry))).join(', '),
        numeric: false,
        faint: false,
      }
    }
    return { kind: 'branch', entries: branchEntries(value) }
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return entries.length === 0 ? { kind: 'absent' } : { kind: 'branch', entries }
  }

  return { kind: 'text', text: String(value), numeric: false, faint: false }
}

/**
 * Beyond this many characters a value stops sharing a line with its key.
 *
 * Ranged-right values are the point of an index — the eye runs down a column of
 * numbers — but this column starts at 260px, so a sentence set against its key
 * squeezes the key to two characters a line. Past this length the value takes
 * its own full-width line underneath, clamped, with the whole text on hover.
 */
export const RANGED_RIGHT_LIMIT = 22

/* --------------------------------------------------------------------- diff */

/**
 * What moved between two floors' variable snapshots.
 *
 * Paths are the same slash-joined keys the tree folds by, so a path here names
 * a row there. An added or removed **branch** is one entry for the whole
 * subtree — a card creating a 34-item section is one fact, not 34 rows.
 */
export interface StateDiff {
  /** Paths present now that were absent before, whole subtrees included. */
  added: string[]
  /** Leaf values that changed, with both readings for the hover. */
  changed: { path: string, from: unknown, to: unknown }[]
  /** Paths that vanished, with the value they held. */
  removed: { path: string, value: unknown }[]
}

/** The diff between two sightings of the same snapshot. */
export const EMPTY_DIFF: StateDiff = { added: [], changed: [], removed: [] }

/**
 * Whether two snapshots hold the same value.
 *
 * Branches compare by their named children, so a key reordered is not a change
 * and an **empty array re-created is not a change either** — the host
 * re-materialises tables wholesale, and `Object.is` on two fresh `[]` would
 * have reported every empty list as moved. Anything else compares by identity
 * or `Object.is`. A container that changed kind (object to array, branch to
 * scalar) is a change of the whole path.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((entry, at) => sameValue(entry, b[at]))
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (!isBranch(a) || !isBranch(b)) return false
  const left = branchEntries(a)
  const right = branchEntries(b)
  if (left.length !== right.length) return false
  const map = new Map(right)
  return left.every(([key, value]) => map.has(key) && sameValue(value, map.get(key)))
}

/**
 * Diff one floor's variables against the previous floor's, recursively.
 *
 * This is the panel's answer to "what did this turn do", and it is deliberately
 * a pure function of two trees: the component only decides *which* two trees to
 * hand it. Added subtrees stop at their root — the count badge says how much
 * arrived — and a removed branch is recorded whole, because a "removed" section
 * that expanded into every leaf would be the wall of rows this panel exists to
 * end.
 * @param previous - the earlier snapshot, or `undefined` on first sight.
 * @param current - the snapshot to describe.
 * @returns what moved; empty when either side is missing or nothing did.
 */
export function diffStats(previous: unknown, current: unknown): StateDiff {
  const added: string[] = []
  const changed: StateDiff['changed'] = []
  const removed: StateDiff['removed'] = []
  if (previous === undefined || current === undefined) return EMPTY_DIFF
  walk(previous, current, '')
  return { added, changed, removed }

  function walk(was: unknown, now: unknown, path: string): void {
    if (isBranch(was) && isBranch(now)) {
      const before = new Map(branchEntries(was))
      const after = branchEntries(now)
      const afterKeys = new Set(after.map(([key]) => key))
      for (const [key, value] of after) {
        const here = `${path}/${key}`
        if (!before.has(key)) {
          added.push(here)
          continue
        }
        walk(before.get(key), value, here)
      }
      for (const [key, value] of before) {
        if (!afterKeys.has(key)) removed.push({ path: `${path}/${key}`, value })
      }
      return
    }
    if (!sameValue(was, now)) changed.push({ path, from: was, to: now })
  }
}

/** The paths a diff marked, as one set the tree filter can test against. */
export function changedPaths(diff: StateDiff): ReadonlySet<string> {
  return new Set([...diff.added, ...diff.changed.map(row => row.path)])
}

/** A diff's changed row, for the hover that shows the old reading. */
export function changedAt(diff: StateDiff, path: string): { from: unknown, to: unknown } | undefined {
  return diff.changed.find(row => row.path === path)
}

/**
 * Keep only the entries a diff marked, plus the branch headings above them.
 *
 * This is the "changes only" view: the tree pruned to what moved this round.
 * An ancestor survives as a heading even when none of its own children changed,
 * because a changed leaf with no path to it is a fact nobody can find.
 * @param entries - the current tree.
 * @param keep - the paths the diff marked.
 * @returns the pruned tree; siblings of marked paths are gone.
 */
export function keepChanged(
  entries: readonly [string, unknown][],
  keep: ReadonlySet<string>,
  path: string = '',
): [string, unknown][] {
  const kept: [string, unknown][] = []
  for (const [key, value] of entries) {
    const here = `${path}/${key}`
    if (keep.has(here)) {
      kept.push([key, value])
      continue
    }
    if (isBranch(value)) {
      const children = keepChanged(branchEntries(value), keep, here)
      // A branch nobody marked and that holds nothing marked is not part of
      // this round's story; a branch holding a marked leaf is its heading.
      if (children.length > 0) kept.push([key, rebuildBranch(value, children)])
    }
  }
  return kept
}

/**
 * Rebuild a branch value from kept children, keeping its kind.
 *
 * Arrays rebuild as arrays (the children are already one-based pairs, so the
 * positions re-dense); objects rebuild as records. A heading that lied about
 * what it contains would break the renderer, which decides how to draw a value
 * from exactly this shape.
 */
function rebuildBranch(value: unknown, children: [string, unknown][]): unknown {
  if (Array.isArray(value)) return children.map(([, entry]) => entry)
  return Object.fromEntries(children)
}

/* ------------------------------------------------------------------- search */

/**
 * Prune the tree to the subtrees a name filter hits.
 *
 * Matching is on **keys only**, substring, case-blind — the same test a reader
 * runs in their head, and the one that works unchanged for Chinese keys. A
 * branch whose own name matches keeps its whole subtree; a branch with a hit
 * deeper down survives as the path to it, pruned to the hits. Everything else
 * is dropped, which is what makes a 34-item section searchable at all.
 * @param entries - the current tree.
 * @param query - the trimmed, lower-cased needle.
 * @param path - this level's path, for nothing but recursion bookkeeping.
 * @returns the pruned tree, or `undefined` when nothing under here matches.
 */
export function filterByName(
  entries: readonly [string, unknown][],
  query: string,
  path: string = '',
): [string, unknown][] | undefined {
  if (query === '') return [...entries]
  const kept: [string, unknown][] = []
  for (const [key, value] of entries) {
    const matched = key.toLowerCase().includes(query)
    if (matched) {
      // A hit keeps everything under it: the reader asked for this subtree.
      kept.push([key, value])
      continue
    }
    if (isBranch(value)) {
      const children = filterByName(branchEntries(value), query, `${path}/${key}`)
      if (children !== undefined && children.length > 0) kept.push([key, rebuildBranch(value, children)])
    }
  }
  return kept.length > 0 ? kept : undefined
}

/* -------------------------------------------------------------------- folds */

/**
 * Every branch path in a tree, for the collapse-all and expand-all buttons.
 * @param entries - the tree to walk.
 * @param path - the parent path.
 * @returns every path that renders a disclosure triangle.
 */
export function branchPaths(entries: readonly [string, unknown][], path: string = ''): string[] {
  const paths: string[] = []
  for (const [key, value] of entries) {
    if (!isBranch(value)) continue
    const here = `${path}/${key}`
    paths.push(here, ...branchPaths(branchEntries(value), here))
  }
  return paths
}

/** What a storage keeps: the surface `localStorage` answers to, and no more. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** One memory record: per chat, which branches the reader folded by hand. */
const MEMORY_PREFIX = 'iris.state.folds.'

/**
 * Read a chat's fold memory.
 *
 * Stored as a JSON object of path → open, holding **only the branches the
 * reader toggled by hand** — everything else takes the default (top level
 * open, deeper branches folded), so a card that adds a section later is not
 * born already-misremembered. A damaged or foreign record is a default, not a
 * crash: the memory is a convenience, and nothing that stores it is allowed to
 * take the panel down.
 * @param chatId - whose folds to read.
 * @param storage - where from; defaults to `localStorage` when it exists.
 * @returns the recorded overrides.
 */
export function loadFoldMemory(chatId: string, storage: StorageLike | undefined = globalThis.localStorage): ReadonlyMap<string, boolean> {
  if (storage === undefined) return new Map()
  try {
    const raw = storage.getItem(MEMORY_PREFIX + chatId)
    if (raw === null) return new Map()
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    const overrides = new Map<string, boolean>()
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') overrides.set(key, value)
    }
    return overrides
  } catch {
    return new Map()
  }
}

/**
 * Write a chat's fold memory.
 * @param chatId - whose folds these are.
 * @param overrides - the paths toggled by hand, with their state.
 * @param storage - where to; defaults to `localStorage` when it exists. A
 *   refused write (private mode, a full quota) is dropped silently, because a
 *   lost fold state costs one re-expansion and an error notice would interrupt
 *   reading to announce it.
 */
export function saveFoldMemory(chatId: string, overrides: ReadonlyMap<string, boolean>, storage: StorageLike | undefined = globalThis.localStorage): void {
  if (storage === undefined) return
  try {
    if (overrides.size === 0) {
      storage.removeItem(MEMORY_PREFIX + chatId)
      return
    }
    storage.setItem(MEMORY_PREFIX + chatId, JSON.stringify(Object.fromEntries(overrides)))
  } catch {
    // The convenience failed; the panel carries on without it.
  }
}

/** Whether the margin itself is open. Per device, not per chat — see below. */
const OPEN_KEY = 'iris.state.open'

/**
 * Read whether the variable margin is showing.
 *
 * **Per device and not per chat**, unlike the fold memory above, and the two are
 * different on purpose: which branches interest a reader is a fact about the
 * card they are reading, while whether they want a 236px column at all is a
 * fact about their screen. A reader who folded it away on a laptop wants it
 * folded on the next chat too.
 *
 * Open is the default and is also what an unavailable store yields: the margin
 * is the reason a wide window is not empty, and a reader who has never touched
 * the control should see what it holds.
 * @param storage - where from; defaults to `localStorage` when it exists.
 * @returns whether it is showing.
 */
export function loadAsideOpen(storage: StorageLike | undefined = globalThis.localStorage): boolean {
  if (storage === undefined) return true
  try {
    return storage.getItem(OPEN_KEY) !== 'shut'
  } catch {
    return true
  }
}

/**
 * Remember whether the variable margin is showing.
 * @param open - the reader's choice.
 * @param storage - where to; defaults to `localStorage` when it exists. A
 *   refused write is dropped silently, for the reason `saveFoldMemory` gives.
 */
export function saveAsideOpen(open: boolean, storage: StorageLike | undefined = globalThis.localStorage): void {
  if (storage === undefined) return
  try {
    storage.setItem(OPEN_KEY, open ? 'open' : 'shut')
  } catch {
    // The convenience failed; the panel carries on without it.
  }
}

/*
 * ---------------------------------------------------------------- 让位
 *
 * The three tracks that share a window with the reading column, and the width
 * below which they cannot all be paid for.
 *
 * Measured in the browser at 1440×DPR 1 with the drawer open as a column and
 * the margin expanded: 1440 − 272 − 236 − 393 ≈ 539px of reading area. Prose
 * and every card frame in it were squeezed into a ribbon and the frames grew
 * horizontal scrollbars — the one thing `StatePanel`'s own rules forbid of
 * itself.
 *
 * These four numbers are **copies of CSS declarations**, which is a drift risk
 * and is why `state-panel.test.ts` reads each one back out of the stylesheet
 * that owns it. Nothing here changes a layout; the arithmetic only decides when
 * the margin stands down.
 */

/** The sidebar's grid track above 880px (`shell.css`, `.iris-shell`). */
export const SIDEBAR_TRACK = 272

/** The margin's own open width (`tokens.css`, `--iris-aside`). */
export const ASIDE_TRACK = 236

/** The drawer's column width (`tokens.css`, `--iris-drawer-w`). */
export const DRAWER_TRACK = 392

/** The width from which the margin shows at all (`panels.css`, `.iris-aside`). */
export const ASIDE_FROM = 1360

/**
 * The narrowest reading column this layout will produce on purpose.
 *
 * A judgement, not a measurement, and stated as one: `--iris-measure` is 68ch,
 * which at the 17px prose size is around 578px, and the reading column carries
 * two 46px gutters around it — so a comfortable line of prose wants something
 * between 578 and 670px of track. 640 sits inside that band and is the figure
 * the browser review named. It is a floor for *when to yield*, not a min-width
 * anything is laid out against, so its precision is not load-bearing.
 */
export const READING_FLOOR = 640

/**
 * The window width at which the margin no longer has to yield to the drawer.
 *
 * At exactly this width the reading column is `READING_FLOOR` wide with all
 * three flanks present, so the yield applies strictly below it.
 */
export const ASIDE_YIELD_BELOW = SIDEBAR_TRACK + ASIDE_TRACK + DRAWER_TRACK + READING_FLOOR

/**
 * The window range in which an open drawer costs the margin its column.
 *
 * Below {@link ASIDE_FROM} the margin is `display: none` anyway, so yielding
 * there would be a decision about nothing; from {@link ASIDE_YIELD_BELOW} up
 * both fit. Built from the constants rather than written out, so the query and
 * the arithmetic above cannot disagree.
 */
export const ASIDE_YIELD_QUERY =
  `(min-width: ${String(ASIDE_FROM)}px) and (max-width: ${String(ASIDE_YIELD_BELOW - 1)}px)`

/**
 * Whether the variable margin shows its full column right now.
 *
 * The yield is deliberately **not** a stored state and not a write: it is
 * derived on every render from the drawer and the window, so closing the drawer
 * restores whatever the reader had chosen without anything having to remember
 * what that was. A version that "collapsed the margin for you" by calling
 * {@link saveAsideOpen} would overwrite a per-device preference with a
 * consequence of a window size — recoverable only by the reader noticing and
 * clicking twice.
 *
 * The reader's control keeps working while yielded: the click writes the
 * preference as it always did, and it takes effect the moment there is room.
 *
 * @param stored - the reader's own choice, from {@link loadAsideOpen}.
 * @param drawerOpen - whether the settings drawer is showing.
 * @param tight - whether the window is inside {@link ASIDE_YIELD_QUERY}.
 * @returns whether to draw the 236px column; `false` means the 36px strip.
 */
export function asideShowing(stored: boolean, drawerOpen: boolean, tight: boolean): boolean {
  return stored && !(drawerOpen && tight)
}

/** Where the last-seen variable tree lives, so "this round" survives a reload. */
const LAST_TREE_PREFIX = 'iris.state.lastTree.'

/**
 * How long a burst of snapshots counts as one round of changes.
 *
 * A story turn rarely arrives as one snapshot: a status-bar card reacts to the
 * settled view by writing its own derived variables, and each host echo of
 * that is another snapshot. Differencing **the last transition alone** made
 * the card's trailing no-op rewrites bury the turn they answered — the reader
 * watched a whole round happen and the panel reported "nothing changed".
 * Snapshots landing within this window of the previous one diff against the
 * same round baseline, so the burst sums into the round it belongs to; the
 * next change after quiet starts a new round from the tree just seen.
 */
export const ROUND_QUIET_MS = 90_000

/**
 * The round a chat's margin is currently showing: the tree the round started
 * from and when its last snapshot landed.
 */
export interface LastSight {
  /** The tree the current round is measured from. */
  tree: unknown
  /** When the round's latest snapshot arrived. Epoch milliseconds. */
  at: number
}

/**
 * Read the round a session last witnessed for a chat.
 *
 * The baseline has to survive the two events that routinely interrupt a
 * reading session — a page reload, and a stream whose end arrived while the
 * event socket was busy reconnecting — or "what did this turn change" goes
 * blank exactly when the turn was big enough to matter. `sessionStorage`, not
 * `localStorage`: the memory is this reading session's, and a browser reopened
 * tomorrow should meet the chat without stale marks, not reconstruct a diff
 * from yesterday.
 * @param chatId - which chat's round to read.
 * @param storage - where from; defaults to `sessionStorage` when it exists.
 * @returns the round, or `undefined` when this session has none (or the record
 *   is damaged — a baseline nobody can parse is no baseline).
 */
export function loadLastTree(chatId: string, storage: StorageLike | undefined = globalThis.sessionStorage): LastSight | undefined {
  if (storage === undefined) return undefined
  try {
    const raw = storage.getItem(LAST_TREE_PREFIX + chatId)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (!('tree' in record) || typeof record['at'] !== 'number') return undefined
    return { tree: record['tree'], at: record['at'] }
  } catch {
    return undefined
  }
}

/**
 * Record the round a session witnessed for a chat.
 * @param chatId - which chat this round belongs to.
 * @param sight - the round baseline and its latest arrival time.
 * @param storage - where to; a refused write costs one lost diff after a
 *   reload, which is a cost of storage, not of the panel.
 */
export function saveLastTree(chatId: string, sight: LastSight, storage: StorageLike | undefined = globalThis.sessionStorage): void {
  if (storage === undefined) return
  try {
    storage.setItem(LAST_TREE_PREFIX + chatId, JSON.stringify(sight))
  } catch {
    // The convenience failed; the panel carries on without it.
  }
}

/* ------------------------------------------------------------------ preview */

/**
 * A short, flat rendering of a value, for hover text and removed rows.
 *
 * Strings read as themselves — quotes around Chinese prose are noise — and a
 * branch becomes its size, because a 34-item object serialized into a title
 * attribute is the wall of text this panel exists to end.
 * @param value - the value to summarise.
 * @param lang - which language the size wording takes.
 * @returns the flat text, never longer than a hover needs.
 */
export function previewValue(value: unknown, lang: Language): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (isBranch(value)) return translate(lang, 'stateItems', { n: branchSize(value) })
  return String(value)
}

/**
 * The `old → new` sentence a changed row shows on hover.
 * @param from - the previous reading.
 * @param to - the current reading.
 * @param lang - which language the size wording takes.
 * @returns the sentence, with long readings clipped.
 */
export function changeSentence(from: unknown, to: unknown, lang: Language): string {
  const clip = (text: string): string => (text.length > 80 ? `${text.slice(0, 77)}…` : text)
  return `${clip(previewValue(from, lang))} → ${clip(previewValue(to, lang))}`
}
