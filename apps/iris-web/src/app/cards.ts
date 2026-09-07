/**
 * Which drawer cards are open, remembered on the device.
 *
 * A settings drawer is read maybe twice a year per knob — but the knob someone
 * came for is different twice a year. Collapsing everything by default makes
 * the drawer a table of contents instead of a wall, and remembering what each
 * reader opens makes the second visit shorter than the first.
 *
 * Like the reading preferences, this is per-device state: which cards someone
 * keeps open says nothing about the chat they are on, so it never goes to the
 * host — `localStorage` only, written through guards that treat an unavailable
 * store as "no opinion yet".
 *
 * @module iris-web/app/cards
 */

/** The drawer's cards, in the order they render. */
export type CardId =
  | 'connection'
  | 'presets'
  | 'backups'
  | 'regex'
  | 'route'
  | 'sampling'
  | 'replies'
  | 'appearance'
  | 'reading'
  | 'worldbooks'
  | 'scripts'
  | 'usage'
  | 'about'

/**
 * The cards open before the reader has expressed a preference: the two things
 * everyone touches — where a conversation is sent, and how it reads — and
 * nothing else.
 */
export const DEFAULT_OPEN_CARDS: readonly CardId[] = ['connection', 'reading']

/** What one card's open state is read from; a card never named here uses the default. */
const CARDS_KEY = 'iris.drawer.cards'

/**
 * Read the remembered open state.
 * @returns the stored card states, or an empty record when nothing is stored.
 */
export function loadCardState(): Partial<Record<CardId, boolean>> {
  const raw = safeRead(CARDS_KEY)
  if (raw === undefined) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null) return {}
    const known = new Set<string>(ALL_CARDS)
    const state: Partial<Record<CardId, boolean>> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (known.has(key) && typeof value === 'boolean') state[key as CardId] = value
    }
    return state
  } catch {
    return {}
  }
}

/**
 * Remember the open state of every card the reader has toggled.
 * @param state - the states to store.
 */
export function saveCardState(state: Readonly<Partial<Record<CardId, boolean>>>): void {
  safeWrite(CARDS_KEY, JSON.stringify(state))
}

/** Whether a card is open, given the remembered state. */
export function isOpen(state: Readonly<Partial<Record<CardId, boolean>>>, id: CardId): boolean {
  return state[id] ?? DEFAULT_OPEN_CARDS.includes(id)
}

/**
 * Every card id — the set of keys a stored record is filtered to.
 *
 * **`backups` was missing from this list and is not any more**, which is the
 * kind of defect that leaves no trace: `loadCardState` filters the stored
 * record against these names, so the backups card's remembered open state was
 * read out of `localStorage` and then dropped on every load. The card worked,
 * the store held the right value, and the preference silently did nothing.
 *
 * The type below is what stops it happening again, `usage` included: a member
 * of {@link CardId} that is absent here makes `tsc` fail and *name the missing
 * id*, because a list that has to be kept in step with a union by hand is a
 * list that will not be. A comment asking for it would not have gone red.
 */
const ALL_CARDS = [
  'connection', 'presets', 'backups', 'regex', 'route', 'sampling', 'replies',
  'appearance', 'reading', 'worldbooks', 'scripts', 'usage', 'about',
] as const satisfies readonly CardId[]

/**
 * Compile-time proof that {@link ALL_CARDS} covers {@link CardId}.
 *
 * `Exclude` is the set of ids the list forgot. Empty, it is `never` and this
 * alias resolves; non-empty, the constraint fails and the error quotes the
 * missing member — which is the whole value of doing it in the type system
 * rather than in a test that would have to enumerate the union again to check
 * it.
 */
type EveryCardListed<Missing extends never> = Missing
export type CardsAreExhaustive =
  EveryCardListed<Exclude<CardId, typeof ALL_CARDS[number]>>

/**
 * Read a key, treating an unavailable store as an absent value.
 *
 * Private-mode browsers throw on access rather than returning null, and a
 * drawer preference is not worth a blank page.
 */
function safeRead(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

/** Write a key, ignoring an unavailable store. */
function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // A reader with site data blocked still gets a working drawer, just not a
    // remembered one.
  }
}
