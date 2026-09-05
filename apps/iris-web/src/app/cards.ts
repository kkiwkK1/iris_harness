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
  | 'regex'
  | 'route'
  | 'sampling'
  | 'replies'
  | 'appearance'
  | 'reading'
  | 'worldbooks'
  | 'scripts'
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

/** Every card id — the set of keys a stored record is filtered to. */
const ALL_CARDS: readonly CardId[] = [
  'connection', 'presets', 'regex', 'route', 'sampling', 'replies', 'appearance', 'reading', 'worldbooks', 'scripts', 'about',
]

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
