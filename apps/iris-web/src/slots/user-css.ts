/**
 * The user.css slot: a reader's own stylesheet, mounted as one `<style>`
 * element.
 *
 * Upstream calls this `user.css` — a file dropped into the install that the
 * page loads after every theme. Iris has no install directory to drop into, so
 * the slot is the page itself: the text lives on the device
 * (`localStorage`, safeRead/safeWrite like every per-device choice), and this
 * module owns its mount point. It follows the slot discipline the rest of
 * `slots/` states against the DOM: **registering mounts the style element,
 * disposing removes it, and nothing is left behind** — no residue style with
 * the reader's rules still in force after the slot is gone.
 *
 * The element carries `data-iris-slot="user-css"` so it is findable from
 * outside (a QA script asserting "the custom rule is in force" does not have
 * to know our id), and it mounts **last**: appended to `<head>`, after the
 * bundled stylesheets, so the reader's rules win ties without needing
 * `!important` for every line.
 *
 * Scope, said plainly: this styles Iris's page, after the theme. A card's
 * frame is a separate document with its own origin — the same boundary the
 * overlay rules already hold — so user CSS cannot reach into one, and a rule
 * the reader writes cannot leak out of this page either.
 *
 * The state is a module-level external store with subscribers, so the drawer
 * reads it through `useSyncExternalStore` and the mount reacts to the same
 * writes — one value, two readers, no reload.
 *
 * @module iris-web/slots/user-css
 */

import { useSyncExternalStore } from 'react'

/** The slot's persisted state. */
export interface UserCssState {
  /** The stylesheet text, verbatim. */
  css: string
  /** Whether the slot is mounted. The text is kept while off. */
  enabled: boolean
}

/** The default: nothing written, slot off — an empty page has nothing to say. */
export const DEFAULT_USER_CSS: UserCssState = { css: '', enabled: false }

/** 512 KiB of CSS. A stylesheet past this is not a stylesheet but a payload. */
export const USER_CSS_LIMIT = 512 * 1024

const KEY = 'iris.usercss'

/** The mount point, created once per document. */
const SLOT_ID = 'iris-user-css-slot'

let current: UserCssState = loadUserCss()

const listeners = new Set<() => void>()

let installed = false
let uninstall: (() => void) | undefined

/**
 * The slot's state in force right now.
 * @returns the state.
 */
export function getUserCss(): UserCssState {
  return current
}

/**
 * Watch for user.css changes.
 * @param listener - called after every write.
 * @returns a disposer, because every registration in Iris is reversible.
 */
export function subscribeUserCss(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Replace the stylesheet text and remember it.
 * @param css - the text to keep. Over the size cap nothing changes and false
 *   comes back, so the drawer can say so instead of silently keeping the old
 *   sheet.
 * @returns whether the text was accepted.
 */
export function setUserCssText(css: string): boolean {
  if (css.length > USER_CSS_LIMIT) return false
  write({ ...current, css })
  return true
}

/**
 * Switch the slot on or off, and remember it.
 * @param enabled - whether the stylesheet should paint.
 */
export function setUserCssEnabled(enabled: boolean): void {
  write({ ...current, enabled })
}

/**
 * The React side of the slot: the current state, subscribed, with setters.
 * @returns the state and the two writers.
 */
export function useUserCss(): {
  userCss: UserCssState
  setText: (css: string) => boolean
  setEnabled: (enabled: boolean) => void
} {
  const userCss = useSyncExternalStore(subscribeUserCss, getUserCss, getUserCss)
  return { userCss, setText: setUserCssText, setEnabled: setUserCssEnabled }
}

/**
 * Install the slot: mount the style element and keep it in step with the
 * store until the disposer runs.
 *
 * Idempotent — the shell mounts once, but a hot reload must not stack mounts.
 * @returns the disposer, which unmounts the element and the subscription, so
 *   nothing of the slot is left in the document.
 */
export function installUserCssSlot(): () => void {
  if (installed) return uninstall ?? (() => {})
  installed = true
  let element: HTMLStyleElement | undefined
  const mount = (): void => {
    if (typeof document === 'undefined') return
    const wanted = current.enabled && current.css.trim() !== ''
    if (wanted && element === undefined) {
      element = document.createElement('style')
      element.id = SLOT_ID
      element.dataset['irisSlot'] = 'user-css'
      // Last in the head: the reader's rules win ties with the bundle's.
      document.head.appendChild(element)
    }
    if (element !== undefined) {
      if (wanted) element.textContent = current.css
      else {
        element.remove()
        element = undefined
      }
    }
  }
  const unsubscribe = subscribeUserCss(mount)
  mount()
  uninstall = () => {
    unsubscribe()
    element?.remove()
    element = undefined
    installed = false
    uninstall = undefined
  }
  return uninstall
}

/** One write: store, persist, notify — in that order, like every store here. */
function write(next: UserCssState): void {
  current = next
  safeWrite(KEY, JSON.stringify(next))
  for (const listener of listeners) listener()
}

/**
 * Read the stored state.
 *
 * A standalone read, so a reload is the same path as a write: the module
 * starts from what the store says, and a corrupted or foreign value reads as
 * the default rather than as a broken page.
 * @returns the stored state, clamped to the size cap.
 */
export function loadUserCss(): UserCssState {
  const raw = safeRead(KEY)
  if (raw === undefined) return { ...DEFAULT_USER_CSS }
  try {
    const parsed = JSON.parse(raw) as Partial<UserCssState>
    return {
      css: typeof parsed.css === 'string' ? parsed.css.slice(0, USER_CSS_LIMIT) : '',
      enabled: parsed.enabled === true,
    }
  } catch {
    return { ...DEFAULT_USER_CSS }
  }
}

/** Read a key, treating an unavailable store as an absent value. */
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
    // A reader with site data blocked still gets a working app, just not a
    // remembered stylesheet.
  }
}
