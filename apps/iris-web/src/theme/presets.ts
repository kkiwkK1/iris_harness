/**
 * The built-in themes, as token tables.
 *
 * A theme in Iris **is** a table of `--iris-*` overrides — nothing else. Every
 * colour the shell paints comes from the custom properties authored in
 * `tokens.css`, so a theme is fully described by naming what each of the
 * palette properties becomes. That is what makes a theme exportable as JSON
 * and previewable as a row of swatches drawn from the same numbers the page
 * uses.
 *
 * The tables here and the blocks in `tokens.css` say the same thing twice, on
 * purpose: the CSS blocks exist so the stored theme reaches the document
 * before the bundle does (a flash of the wrong ground on every reload is the
 * most visible bug a themed app can have), and the tables exist so the same
 * values can be exported, imported, diffed and drawn as previews. Which is why
 * the agreement between the two is **asserted, not assumed** —
 * `theme-presets.test.ts` parses `tokens.css` and compares it to these tables,
 * because duplication without a check is drift wearing a comment.
 *
 * Readability floors every preset is held to (computed, in the same test):
 * body ink ≥ 4.5:1 on the page, secondary ink ≥ 4.5:1, the variant-rail tick
 * ≥ 3:1 (WCAG 1.4.11, a mark that carries information), and the accent
 * clearly louder than the tick.
 *
 * @module iris-web/theme/presets
 */

import type { ThemeId } from './theme.ts'

/**
 * The palette properties a theme may set. Everything else in `tokens.css` —
 * type, rhythm, the scrollbar mechanics — is theme-independent structure.
 */
export const THEME_TOKENS = [
  '--iris-bg-base',
  '--iris-bg-page',
  '--iris-bg-raised',
  '--iris-bg-sunken',
  '--iris-bg-mask',
  '--iris-rule',
  '--iris-rule-strong',
  '--iris-rule-faint',
  '--iris-tick',
  '--iris-ink',
  '--iris-ink-secondary',
  '--iris-ink-tertiary',
  '--iris-ink-faint',
  '--iris-ink-inverted',
  '--iris-accent',
  // Hover/pressed, and a *lighter* plum for a reading that can no longer be
  // changed. They pull in opposite directions on purpose — tokens.css says why.
  '--iris-accent-strong',
  '--iris-accent-quiet',
  '--iris-accent-wash',
  // The two plum-alpha shadows the composer spends, and the paper's 藕粉 dye at
  // its lower edge. Per theme, because 墨 needs more alpha to show at all.
  '--iris-accent-soft',
  '--iris-accent-cast',
  '--iris-blush',
  '--iris-danger',
  '--iris-danger-wash',
  '--iris-warn',
  '--iris-code-bg',
  '--iris-code-inline',
  '--iris-shadow',
  '--iris-scrim',
  // The scrollbar rides the theme like every other colour (the task-O
  // acceptance: a dark page does not keep a light desk's scrollbar).
  '--iris-scrollbar',
  '--iris-scrollbar-strong',
] as const

/** One palette property name. */
export type ThemeToken = (typeof THEME_TOKENS)[number]

/** One built-in theme: an id and the full palette it paints. */
export interface ThemePreset {
  id: ThemeId
  tokens: Record<ThemeToken, string>
}

/**
 * 雪 — the bare `:root` of `tokens.css`, the paper Iris ships on.
 *
 * The id stays `light`: it is what existing readers have in `localStorage`, and
 * renaming it would silently reset every stored choice. The interface calls it
 * 雪 (`i18n/strings.ts`).
 */
const light: ThemePreset = {
  id: 'light',
  tokens: {
    '--iris-bg-base': '#ebe7e3',
    '--iris-bg-page': '#f8f5f2',
    '--iris-bg-raised': '#fffdfb',
    '--iris-bg-sunken': '#f1eeeb',
    '--iris-bg-mask': 'rgb(35 32 31 / 38%)',
    '--iris-rule': '#d9d3cd',
    '--iris-rule-strong': '#c9c2bb',
    '--iris-rule-faint': '#e3ded9',
    '--iris-tick': '#8d8580',
    '--iris-ink': '#23201f',
    '--iris-ink-secondary': '#4a4543',
    '--iris-ink-tertiary': '#7d7672',
    '--iris-ink-faint': '#a39b95',
    '--iris-ink-inverted': '#fbf3f2',
    '--iris-accent': '#b3374a',
    '--iris-accent-strong': '#8e2a3b',
    '--iris-accent-quiet': '#c9707d',
    '--iris-accent-wash': 'rgb(179 55 74 / 8%)',
    '--iris-accent-soft': 'rgb(179 55 74 / 6%)',
    '--iris-accent-cast': 'rgb(179 55 74 / 28%)',
    '--iris-blush': '#f7eeef',
    '--iris-danger': '#a4472f',
    '--iris-danger-wash': 'rgb(164 71 47 / 10%)',
    '--iris-warn': '#8a6420',
    '--iris-code-bg': '#ece7e1',
    '--iris-code-inline': '#e7e1da',
    '--iris-shadow': '0 1px 2px rgb(35 32 31 / 6%), 0 8px 24px rgb(35 32 31 / 10%)',
    '--iris-scrim': 'rgb(35 32 31 / 28%)',
    '--iris-scrollbar': '#d5cec7',
    '--iris-scrollbar-strong': '#b3aaa2',
  },
}

/**
 * 墨 — ink on a night desk. The id stays `dark`, for the reason 雪's does.
 *
 * The plum is lifted rather than transcribed: `#b3374a` measures 2.5:1 on this
 * ground, which is findable and unreadable, so the accent is the same hue at the
 * lightness a dark page needs (5.31:1).
 */
const dark: ThemePreset = {
  id: 'dark',
  tokens: {
    '--iris-bg-base': '#141215',
    '--iris-bg-page': '#1c1a1d',
    '--iris-bg-raised': '#26232a',
    '--iris-bg-sunken': '#232025',
    '--iris-bg-mask': 'rgb(10 8 11 / 62%)',
    '--iris-rule': '#332f36',
    '--iris-rule-strong': '#453f4a',
    '--iris-rule-faint': '#262329',
    '--iris-tick': '#6e666c',
    '--iris-ink': '#ece7e4',
    '--iris-ink-secondary': '#b8b0ae',
    '--iris-ink-tertiary': '#8f8785',
    '--iris-ink-faint': '#6b6462',
    '--iris-ink-inverted': '#1c1a1d',
    '--iris-accent': '#e0687d',
    '--iris-accent-strong': '#ee8397',
    '--iris-accent-quiet': '#a8505f',
    '--iris-accent-wash': 'rgb(224 104 125 / 12%)',
    '--iris-accent-soft': 'rgb(224 104 125 / 10%)',
    '--iris-accent-cast': 'rgb(224 104 125 / 24%)',
    '--iris-blush': '#241b1f',
    '--iris-danger': '#e08a7e',
    '--iris-danger-wash': 'rgb(224 138 126 / 14%)',
    '--iris-warn': '#d9b46a',
    '--iris-code-bg': '#131114',
    '--iris-code-inline': '#262329',
    '--iris-shadow': '0 1px 2px rgb(0 0 0 / 40%), 0 10px 30px rgb(0 0 0 / 46%)',
    '--iris-scrim': 'rgb(0 0 0 / 52%)',
    '--iris-scrollbar': '#3a353d',
    '--iris-scrollbar-strong': '#544d58',
  },
}

/*
 * 宣 — 宣纸, the warm pole of the set: snow paper, a night desk, and now a
 * well-read page. The id stays `parchment`.
 *
 * The numbers were chosen against the floors, not by eye: ink `#2b241c` reads
 * 12.1:1 on the page, secondary ink `#54483a` 7.0:1, the tick `#8b7862` 3.35:1,
 * and the accent — the plum darkened, because a warm ground swallows a bright
 * red — 5.21:1, clear of the tick it must outrank. The scrollbar stays below the
 * rules in contrast on purpose, exactly as in the other two themes: chrome for
 * moving, not a line for reading.
 */
const parchment: ThemePreset = {
  id: 'parchment',
  tokens: {
    '--iris-bg-base': '#e3d5c4',
    '--iris-bg-page': '#efe3d6',
    '--iris-bg-raised': '#f8f1e8',
    '--iris-bg-sunken': '#e8dbcc',
    '--iris-bg-mask': 'rgb(43 36 28 / 38%)',
    '--iris-rule': '#d6c7b3',
    '--iris-rule-strong': '#c2b099',
    '--iris-rule-faint': '#e2d6c6',
    '--iris-tick': '#8b7862',
    '--iris-ink': '#2b241c',
    '--iris-ink-secondary': '#54483a',
    '--iris-ink-tertiary': '#867561',
    '--iris-ink-faint': '#a5947c',
    '--iris-ink-inverted': '#f8f1e8',
    '--iris-accent': '#a83145',
    '--iris-accent-strong': '#852535',
    '--iris-accent-quiet': '#c06e7c',
    '--iris-accent-wash': 'rgb(168 49 69 / 9%)',
    '--iris-accent-soft': 'rgb(168 49 69 / 7%)',
    '--iris-accent-cast': 'rgb(168 49 69 / 26%)',
    '--iris-blush': '#eddcd5',
    '--iris-danger': '#9a4526',
    '--iris-danger-wash': 'rgb(154 69 38 / 10%)',
    '--iris-warn': '#7d5c1e',
    '--iris-code-bg': '#e7dbc9',
    '--iris-code-inline': '#e2d5c1',
    '--iris-shadow': '0 1px 2px rgb(43 36 28 / 8%), 0 8px 24px rgb(43 36 28 / 12%)',
    '--iris-scrim': 'rgb(43 36 28 / 30%)',
    '--iris-scrollbar': '#cebba3',
    '--iris-scrollbar-strong': '#ab9576',
  },
}

/** Every built-in theme, in choice order. */
export const THEME_PRESETS: readonly ThemePreset[] = [light, dark, parchment]

/**
 * Look up a built-in by id.
 * @param id - the theme id.
 * @returns its preset, or undefined for an unknown id.
 */
export function themePreset(id: ThemeId): ThemePreset | undefined {
  return THEME_PRESETS.find(preset => preset.id === id)
}
