/**
 * Which quotation marks take the theme's quote colour, as a device preference.
 *
 * SillyTavern colours six pairs alike (`public/script.js:1846`). Iris's
 * default is the three that mark speech — `"…"`, `“…”`, `«…»` — because in
 * Chinese prose `「…」` and `『…』` mostly mark terms, titles and emphasis
 * (「资格」转为「职责」), and painting those makes the page busy without
 * pointing at any dialogue. That is a deliberate divergence, written down in
 * `notes/apps/iris-web/DEVIATIONS.md` §122, and `'upstream'` is the way back
 * to the compatibility floor.
 *
 * **Persistence: `localStorage`, key `iris.quoteScope` — the same home and the
 * same reasoning as `iris.bodyTag` and `iris.language`.** It changes what the
 * shell *shows*, never what is stored or sent, and the same person reading on
 * a phone and on a desktop may answer it differently. A value that is neither
 * word degrades to the default rather than building a scan out of it.
 *
 * The state is a module-level external store with subscribers, so the reading
 * row reads it through `useSyncExternalStore` and re-marks its prose the
 * moment the choice changes — the panel and the page cannot come to disagree.
 *
 * @module iris-web/app/quote-scope
 */

import { QUOTE_SCOPE_DEFAULT, type QuoteScope } from './quoted-dialogue.ts'

const QUOTE_SCOPE_KEY = 'iris.quoteScope'

let current: QuoteScope = detect()

const listeners = new Set<() => void>()

/**
 * The quote scope in force right now.
 * @returns the scope.
 */
export function getQuoteScope(): QuoteScope {
  return current
}

/**
 * Switch the quote scope, remember it, and tell every reader.
 * @param scope - which quote pairs should count.
 */
export function setQuoteScope(scope: QuoteScope): void {
  if (scope === current) return
  current = scope
  safeWrite(QUOTE_SCOPE_KEY, scope)
  for (const listener of listeners) listener()
}

/**
 * Watch for quote-scope changes.
 * @param listener - called after every switch.
 * @returns a disposer, because every registration in Iris is reversible.
 */
export function subscribeQuoteScope(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Same storage tolerance as `body-tag.ts`: a blocked store is an absent value. */
function detect(): QuoteScope {
  if (typeof window === 'undefined') return QUOTE_SCOPE_DEFAULT
  try {
    const stored = window.localStorage.getItem(QUOTE_SCOPE_KEY)
    if (stored === 'dialogue' || stored === 'upstream') return stored
  } catch {
    // Private-mode browsers throw on access; the default still works.
  }
  return QUOTE_SCOPE_DEFAULT
}

function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The choice lives for this session; a blocked store is not worth a crash.
  }
}
