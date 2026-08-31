/**
 * Theme and reading preferences.
 *
 * These live in `localStorage` and on the root element rather than in the
 * store, for two reasons: they must survive a reload before React runs (a flash
 * of the wrong theme on every refresh is the most visible bug a themed app can
 * have), and they are per-device, not per-account — the same chat read on a
 * phone in bed and on a desktop at noon wants different settings.
 *
 * @module iris-web/theme
 */

/** What the reader chose, including "follow the system". */
export type ThemeChoice = 'system' | 'light' | 'dark'

/** Reading-surface preferences the settings panel writes. */
export interface ReadingPrefs {
  /** Prose size in pixels. */
  size: number
  /** Line-length cap, in `ch`. */
  measure: number
}

/** Bounds the panel and the stored value are both held to. */
export const READING_LIMITS = {
  size: { min: 14, max: 22, step: 1 },
  measure: { min: 48, max: 96, step: 2 },
} as const

const THEME_KEY = 'iris.theme'
const READING_KEY = 'iris.reading'

/** Defaults: a book measure and a comfortable body size, not a UI size. */
export const DEFAULT_READING: ReadingPrefs = { size: 17, measure: 68 }

/**
 * Read the stored theme choice.
 * @returns the choice, defaulting to following the system.
 */
export function loadTheme(): ThemeChoice {
  const stored = safeRead(THEME_KEY)
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
}

/**
 * Read the stored reading preferences.
 * @returns the preferences, clamped to the supported range.
 */
export function loadReading(): ReadingPrefs {
  const raw = safeRead(READING_KEY)
  if (raw === undefined) return { ...DEFAULT_READING }
  try {
    const parsed = JSON.parse(raw) as Partial<ReadingPrefs>
    return {
      size: clamp(parsed.size ?? DEFAULT_READING.size, READING_LIMITS.size),
      measure: clamp(parsed.measure ?? DEFAULT_READING.measure, READING_LIMITS.measure),
    }
  } catch {
    return { ...DEFAULT_READING }
  }
}

/**
 * Apply a theme choice to the document and remember it.
 *
 * `system` removes the attribute rather than resolving the media query into
 * `light`/`dark`, so a reader who changes their OS theme mid-session follows
 * along without Iris having to watch for it.
 * @param choice - the reader's choice.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.setAttribute('data-iris-theme', dark ? 'dark' : 'light')
    root.setAttribute('data-iris-theme-source', 'system')
  } else {
    root.setAttribute('data-iris-theme', choice)
    root.setAttribute('data-iris-theme-source', 'explicit')
  }
  safeWrite(THEME_KEY, choice)
}

/**
 * Apply reading preferences to the document and remember them.
 * @param prefs - the preferences.
 */
export function applyReading(prefs: ReadingPrefs): void {
  const root = document.documentElement
  root.style.setProperty('--iris-prose-size', `${prefs.size}px`)
  root.style.setProperty('--iris-measure', `${prefs.measure}ch`)
  safeWrite(READING_KEY, JSON.stringify(prefs))
}

/**
 * Keep a `system` choice in step with the OS.
 * @param current - a function returning the live choice.
 * @returns a disposer, because every registration in Iris is reversible.
 */
export function watchSystemTheme(current: () => ThemeChoice): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = (): void => {
    if (current() === 'system') applyTheme('system')
  }
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** Clamp a number into a limit range. */
function clamp(value: number, limit: { min: number, max: number }): number {
  if (!Number.isFinite(value)) return limit.min
  return Math.min(Math.max(Math.round(value), limit.min), limit.max)
}

/**
 * Read a key, treating an unavailable store as an absent value.
 *
 * Private-mode browsers throw on access rather than returning null, and a theme
 * preference is not worth a blank page.
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
    // A reader with site data blocked still gets a working app, just not a
    // remembered theme.
  }
}
