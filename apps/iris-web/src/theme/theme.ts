/**
 * Theme and reading preferences.
 *
 * The theme **choice** lives in an external store — the same shape the
 * interface language uses (a module-level value, subscribers,
 * `useSyncExternalStore` on the React side) — because a switch must repaint
 * the drawer that offers the switch, and a component holding the old choice in
 * `useState` is exactly the thing that would not. The choice is also *applied*
 * the moment it is set: the `data-iris-theme` attribute moves, the CSS cascade
 * re-resolves every `--iris-*` token, and the page is repainted synchronously.
 * Nothing waits for a reload, which is the whole point of a theme switch.
 *
 * The theme is per-device (`localStorage`, safeRead/safeWrite — a reader with
 * site data blocked still gets a working app), never per-account, and the
 * default follows the system: until the reader picks a theme by name, the
 * stored value stays absent and `prefers-color-scheme` answers, live —
 * `watchSystemTheme` keeps a `system` choice in step if the OS flips
 * mid-session. A manual choice wins from the moment it is made, because it is
 * the stored value the next load reads.
 *
 * On top of the choice sits the **overrides layer**: a table of `--iris-*`
 * custom properties written as inline properties on the root element, so it
 * outranks every theme block in the cascade. It is how an imported theme
 * package (see `theme-transfer.ts`) carries token values that differ from the
 * built-ins, and it is deliberately visible and clearable — overrides that
 * silently shadow theme switching are how a reader concludes the theme
 * picker is broken.
 *
 * @module iris-web/theme
 */

import { THEME_TOKENS, themePreset } from './presets.ts'

/** A built-in theme's id. */
export type ThemeId = 'light' | 'dark' | 'parchment'

/** What the reader chose, including "follow the system". */
export type ThemeChoice = 'system' | ThemeId

/** Reading-surface preferences the settings panel writes. */
export interface ReadingPrefs {
  /** Prose size in pixels. */
  size: number
  /** Line-length cap, in `ch`. */
  measure: number
  /** Show each floor's number in the margin (upstream's `mesIDDisplay_enabled`). */
  floors: boolean
}

/** Bounds the panel and the stored value are both held to. */
export const READING_LIMITS = {
  size: { min: 14, max: 22, step: 1 },
  measure: { min: 48, max: 96, step: 2 },
} as const

const THEME_KEY = 'iris.theme'
const READING_KEY = 'iris.reading'
const AUTO_OPEN_KEY = 'iris.startup.autoOpen'
const OVERRIDES_KEY = 'iris.theme.overrides'

/** A table of token overrides: palette property name → CSS value. */
export type TokenOverrides = Record<string, string>

/** How many overrides one table may carry — a theme palette, not a stylesheet. */
export const OVERRIDES_LIMIT = 64

/** Defaults: a book measure and a comfortable body size, not a UI size. */
export const DEFAULT_READING: ReadingPrefs = { size: 17, measure: 68, floors: false }

/* ------------------------------------------------------------------ choice */

let current: ThemeChoice = loadThemeChoice()

const listeners = new Set<() => void>()

/**
 * The theme choice in force right now.
 * @returns the choice.
 */
export function getThemeChoice(): ThemeChoice {
  return current
}

/**
 * Watch for theme switches.
 * @param listener - called after every switch.
 * @returns a disposer, because every registration in Iris is reversible.
 */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Switch the theme, apply it to the document, remember it, and tell every
 * reader.
 *
 * Applying here — not in an effect somewhere above the tree — is what makes
 * the switch instant and single-sourced: the attribute moves before any
 * subscriber re-renders, so the repainted words land on an already-repainted
 * page.
 * @param choice - the reader's choice.
 */
export function setThemeChoice(choice: ThemeChoice): void {
  if (choice === current) return
  current = choice
  applyThemeDocument(choice)
  safeWrite(THEME_KEY, choice)
  for (const listener of listeners) listener()
}

/**
 * Read the stored theme choice.
 *
 * A standalone read, not the live value — the reload half of the persistence
 * promise. An unknown word (an older build, a typo, another app's key) reads
 * as "follow the system", the same tolerance the settings import applies.
 * @returns the stored choice, defaulting to following the system.
 */
export function loadThemeChoice(): ThemeChoice {
  const stored = safeRead(THEME_KEY)
  return stored === 'light' || stored === 'dark' || stored === 'parchment' || stored === 'system'
    ? stored
    : 'system'
}

/**
 * Resolve a choice to the theme id that paints.
 *
 * `system` is resolved against `prefers-color-scheme` at the moment of the
 * call; the attribute carries the resolved id rather than the word `system`,
 * so the CSS never has to know the media query and a mid-session OS flip only
 * has to re-apply, not re-decide everywhere. Where there is no window (the
 * node --test suites) the media query cannot be asked and light is the answer.
 * @param choice - the stored or just-chosen choice.
 * @returns the theme id to paint.
 */
export function resolveThemeId(choice: ThemeChoice): ThemeId {
  if (choice !== 'system') return choice
  const dark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  return dark ? 'dark' : 'light'
}

/**
 * Keep a `system` choice in step with the OS.
 * @param current - a function returning the live choice.
 * @returns a disposer, because every registration in Iris is reversible.
 */
export function watchSystemTheme(current: () => ThemeChoice): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = (): void => {
    if (current() === 'system') applyThemeDocument('system')
  }
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * Write the choice onto the document.
 *
 * Where there is no `document` (node --test), the choice still switches and
 * still persists — the DOM is the presentation, not the state.
 */
function applyThemeDocument(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const resolved = resolveThemeId(choice)
  root.setAttribute('data-iris-theme', resolved)
  // `system` keeps its source named so a reader (and a QA script) can tell a
  // mirror of the OS from a choice; the resolved id still drives the palette.
  root.setAttribute('data-iris-theme-source', choice === 'system' ? 'system' : 'explicit')
  applyOverridesDocument()
}

/* --------------------------------------------------------------- overrides */

/**
 * Read the overrides layer, validated.
 *
 * Only palette property names are kept, each value is capped, and the table
 * as a whole is capped — a theme package is a palette, and a table of ten
 * thousand keys in `localStorage` is not a theme but an incident.
 * @returns the overrides in force, or an empty table when none are.
 */
export function loadThemeOverrides(): TokenOverrides {
  const raw = safeRead(OVERRIDES_KEY)
  if (raw === undefined) return {}
  try {
    return sanitizeOverrides(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return {}
  }
}

/** Drop everything that is not a bounded palette override. */
function sanitizeOverrides(parsed: Record<string, unknown>): TokenOverrides {
  if (typeof parsed !== 'object' || parsed === null) return {}
  const keys = Object.keys(parsed).filter(
    key => (THEME_TOKENS as readonly string[]).includes(key) && typeof parsed[key] === 'string',
  )
  if (keys.length > OVERRIDES_LIMIT) return {}
  const table: TokenOverrides = {}
  for (const key of keys) table[key] = (parsed[key] as string).slice(0, 256)
  return table
}

/**
 * Replace the overrides layer, apply it, and tell every reader.
 *
 * An empty table clears the layer — the "clear overrides" button and an
 * import that turns out to match the built-in both land here.
 * @param overrides - the table to put in force.
 */
export function setThemeOverrides(overrides: TokenOverrides): void {
  const table = sanitizeOverrides(overrides)
  safeWrite(OVERRIDES_KEY, JSON.stringify(table))
  applyOverridesDocument()
  for (const listener of listeners) listener()
}

/** Write the overrides onto the root element's inline style. */
function applyOverridesDocument(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const table = loadThemeOverrides()
  for (const token of THEME_TOKENS) {
    const value = table[token]
    // Named, so a QA script can tell an overrides layer from hand-set prose
    // size (which writes the same element style for reading preferences).
    if (value === undefined) root.style.removeProperty(token)
    else root.style.setProperty(token, value)
  }
  root.setAttribute('data-iris-overrides', Object.keys(table).length > 0 ? 'on' : 'off')
}

/* ----------------------------------------------------------------- reading */

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
      floors: parsed.floors === true,
    }
  } catch {
    return { ...DEFAULT_READING }
  }
}

/**
 * Apply reading preferences to the document and remember them.
 * @param prefs - the preferences.
 */
export function applyReading(prefs: ReadingPrefs): void {
  const root = document.documentElement
  root.style.setProperty('--iris-prose-size', `${prefs.size}px`)
  root.style.setProperty('--iris-measure', `${prefs.measure}ch`)
  // The floor numbers ride the same attribute as the other reading surface
  // choices: CSS shows them, so a row never has to know a pref exists.
  root.setAttribute('data-iris-floors', prefs.floors ? 'on' : 'off')
  safeWrite(READING_KEY, JSON.stringify(prefs))
}

/**
 * Read whether the most recent conversation should open on start.
 *
 * The shell reopens the newest chat by default — this is a reading app, and
 * the reader almost always wants to continue — so `true` is also the value an
 * unavailable store yields.
 * @returns the stored choice, defaulting to open.
 */
export function loadAutoOpenChat(): boolean {
  return safeRead(AUTO_OPEN_KEY) !== 'false'
}

/**
 * Remember whether the most recent conversation should open on start.
 * @param open - the choice.
 */
export function saveAutoOpenChat(open: boolean): void {
  safeWrite(AUTO_OPEN_KEY, open ? 'true' : 'false')
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

/*
 * On first import in a browser, put the stored choice and any overrides in
 * force — the pre-paint script in `index.html` has already set the attribute
 * from the same store (so the ground never flashes), and this makes the
 * module the one writer from then on. The preset tables in `presets.ts` and
 * the blocks in `tokens.css` are the same palette said twice; the test holds
 * them together.
 */
if (typeof document !== 'undefined') {
  applyThemeDocument(current)
}

// `themePreset` is re-exported so consumers of the choice (the appearance
// card's previews, the theme package) need only this module.
export { THEME_TOKENS, themePreset }
export type { ThemePreset, ThemeToken } from './presets.ts'
