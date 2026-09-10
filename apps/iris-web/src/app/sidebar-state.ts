/**
 * How the sidebar was left: collapsed or open, and which order its chats read in.
 *
 * Per-device state, like the drawer's open cards (`cards.ts`) and the reading
 * preferences: neither of these says anything about a conversation, so neither
 * goes to the host. `localStorage` only, through guards that treat an
 * unavailable store as "no opinion yet" — a private-mode browser throws on
 * access rather than returning null, and a panel width is not worth a blank
 * page.
 *
 * **The manual chat order itself is not here.** That lives on the host
 * (`chat-order.json`), because a sequence someone arranged by hand is data
 * about their conversations, not a preference about this browser — it has to
 * survive a new machine, and it is the same list every device should see. What
 * is here is only which of the two orders *this* device is reading it in.
 *
 * @module iris-web/app/sidebar-state
 */

/**
 * The window width under which a first-time reader gets the rail.
 *
 * **Not a layout breakpoint, and it is deliberately not in a stylesheet.** The
 * shell has exactly three width breakpoints (880 / 1304 / 1360, enumerated in
 * `breakpoints.test.ts`) and each one *is* a rule: below it the layout is one
 * thing and above it another, at every moment. This is a **default** — it is
 * read once, when there is no stored choice, and never again; a reader who
 * narrows their window does not lose their expanded sidebar, and one who
 * expanded it at 800px keeps it at 800px.
 *
 * 900 rather than the 880 the layout already uses, because the two answer
 * different questions. At 880 and below the sidebar stops being a column at all
 * and becomes the drawer the ☰ opens — so a *collapse* default there decides
 * nothing. The interval this actually governs starts at 881, and the number
 * comes from the design's own reading of "narrow" rather than from a rule it
 * would then be confused with.
 */
export const RAIL_DEFAULT_BELOW = 900

/** Which order the conversation list is read in. */
export type ChatSort = 'recent' | 'manual'

/** Where the collapsed state is remembered. */
const COLLAPSED_KEY = 'iris.sidebar.collapsed'

/** Where the chat list's order choice is remembered. */
const SORT_KEY = 'iris.sidebar.chatSort'

/**
 * Whether the sidebar should start collapsed.
 *
 * A stored choice wins outright. With nothing stored the window decides once,
 * against {@link RAIL_DEFAULT_BELOW} — and a browser that cannot report its own
 * width (a server render) is treated as wide, because the expanded sidebar is
 * the form that shows what the product is.
 * @returns true when the rail is what the reader should see.
 */
export function loadSidebarCollapsed(): boolean {
  const stored = safeRead(COLLAPSED_KEY)
  if (stored === 'true') return true
  if (stored === 'false') return false
  const width = typeof window === 'undefined' ? undefined : window.innerWidth
  return typeof width === 'number' && width > 0 && width < RAIL_DEFAULT_BELOW
}

/**
 * Remember whether the sidebar is collapsed.
 * @param collapsed - the state to store.
 */
export function saveSidebarCollapsed(collapsed: boolean): void {
  safeWrite(COLLAPSED_KEY, collapsed ? 'true' : 'false')
}

/**
 * Which order the conversation list reads in on this device.
 *
 * `manual` is the default, and it is not a choice being made for the reader:
 * with no arranged sequence on the host the manual order *is* newest-first, so
 * the two answers are the same list until someone drags a row. Defaulting to
 * `recent` instead would have thrown away the first drag the moment the page
 * reloaded.
 * @returns the stored choice, or `manual`.
 */
export function loadChatSort(): ChatSort {
  return safeRead(SORT_KEY) === 'recent' ? 'recent' : 'manual'
}

/**
 * Remember which order the conversation list reads in.
 * @param sort - the order to store.
 */
export function saveChatSort(sort: ChatSort): void {
  safeWrite(SORT_KEY, sort)
}

/**
 * Read a key, treating an unavailable store as an absent value.
 * @param key - the key to read.
 * @returns the stored string, or undefined.
 */
function safeRead(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Write a key, ignoring an unavailable store.
 * @param key - the key to write.
 * @param value - the value to store.
 */
function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // A reader with site data blocked still gets a working sidebar, just not a
    // remembered one.
  }
}
