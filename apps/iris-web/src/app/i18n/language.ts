/**
 * Which language the shell speaks, held outside React so anything can read it.
 *
 * **Persistence: `localStorage`, key `iris.language` — the same home and the
 * same reasoning as the theme.** `notes/SETTINGS-IA.md` files interface-surface
 * choices (theme / prose size / measure) under 意图 #4「屏幕上有什么」 with the
 * data source marked 界面本地 — and interface language is exactly that class:
 * it is about the shell's own surface, not about a conversation or a host, and
 * the same person reading on a phone and on a desktop may want different
 * languages. The host's `settings` RPC, by contrast, is generation routing —
 * putting a language there would send it through `settings.get` round trips and
 * make the choice per-chat rather than per-device. So: the device store, like
 * `iris.theme` and `iris.reading` before it, and for the same safeRead/safeWrite
 * tolerance — a reader with site data blocked still gets a working app.
 *
 * **The default follows the browser, and a manual choice wins.** With nothing
 * stored, a `navigator.language` starting with `zh` picks Chinese and anything
 * else picks English. Detection happens once, at load; `setLanguage` writes the
 * stored value, so from then on the stored choice decides. Detection is
 * deliberately *not* persisted — until the reader actually chooses, the next
 * browser or device should be free to answer for itself.
 *
 * The state is a module-level external store with subscribers, so React reads
 * it through `useSyncExternalStore` (see `use-language.tsx`) and non-React code
 * — the zustand store's notices, the sentence builders — reads `getLanguage()`
 * directly. Both see the same value, which is what makes a switch take effect
 * without a reload.
 *
 * @module iris-web/app/i18n/language
 */

import type { Language } from './strings.ts'

const LANGUAGE_KEY = 'iris.language'

let current: Language = detect()

const listeners = new Set<() => void>()

/**
 * Guess a language from a `navigator.language` value.
 *
 * Pure so the rule is testable without a `navigator`: anything beginning with
 * `zh` (zh, zh-CN, zh-TW, zh-Hant…) reads Chinese; every other locale reads
 * English — including `und` and garbage, because English is the source language
 * the copy was written against.
 * @param tag - a BCP-47 language tag, or undefined when there is none.
 * @returns the language to show.
 */
export function detectLanguage(tag: string | undefined): Language {
  return tag !== undefined && tag.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * The language in force right now.
 * @returns the language.
 */
export function getLanguage(): Language {
  return current
}

/**
 * Switch the language, remember it, and tell every reader.
 *
 * Writing here — and only here — is what makes a manual choice outlive
 * detection: the stored value short-circuits the `navigator` on every later
 * load.
 * @param lang - the language to switch to.
 */
export function setLanguage(lang: Language): void {
  if (lang === current) return
  current = lang
  applyDocumentLang()
  safeWrite(LANGUAGE_KEY, lang)
  for (const listener of listeners) listener()
}

/**
 * Watch for language changes.
 * @param listener - called after every switch.
 * @returns a disposer, because every registration in Iris is reversible.
 */
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Keep `<html lang>` in step with the interface language.
 *
 * The document ships `lang="zh"`; a screen reader told the wrong language
 * reads the other one with the wrong phonology, so the attribute follows the
 * choice the way the theme attribute follows the theme choice.
 */
function applyDocumentLang(): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = current
}

/**
 * Read the stored choice, falling back to the browser's language.
 *
 * No stored value means never chosen: detect and return without persisting, so
 * a different browser on the same machine is still free to answer for itself.
 * The detection is gated on `window`, not on `navigator`, on purpose: Node has
 * had a global `navigator.language` since 21, and the sentence builders run
 * under `node --test`, where the copy must stay deterministically English —
 * the tests assert English sentences and a host machine set to Chinese must
 * not flip them. A browser always has `window`; node never does.
 *
 * The storage reads are guarded the way the theme's are — private-mode browsers
 * throw on access, and a language preference is not worth a blank page.
 * @returns the language to start in.
 */
function detect(): Language {
  if (typeof window === 'undefined') return 'en'
  const stored = safeRead(LANGUAGE_KEY)
  if (stored === 'en' || stored === 'zh') return stored
  const nav = typeof navigator === 'undefined' ? undefined : navigator.language
  return detectLanguage(Array.isArray(nav) ? nav[0] : nav)
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
    // remembered language.
  }
}

// On first import in a browser, say which language the document is in — the
// module decides before React renders, so nothing else has to remember to.
applyDocumentLang()
