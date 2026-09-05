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
  '--iris-accent-quiet',
  '--iris-accent-wash',
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

/** The light theme — the bare `:root` of `tokens.css`, the paper it ships on. */
const light: ThemePreset = {
  id: 'light',
  tokens: {
    '--iris-bg-base': '#e2e6ea',
    '--iris-bg-page': '#f7f8f9',
    '--iris-bg-raised': '#ffffff',
    '--iris-bg-sunken': '#dde2e6',
    '--iris-bg-mask': 'rgb(20 26 32 / 38%)',
    '--iris-rule': '#d3d9dd',
    '--iris-rule-strong': '#bcc4ca',
    '--iris-rule-faint': '#e2e6e9',
    '--iris-tick': '#828e98',
    '--iris-ink': '#161b22',
    '--iris-ink-secondary': '#414b55',
    '--iris-ink-tertiary': '#6c7781',
    '--iris-ink-faint': '#8d979f',
    '--iris-ink-inverted': '#f4f5f6',
    '--iris-accent': '#2c7c6b',
    '--iris-accent-quiet': '#4f9b8a',
    '--iris-accent-wash': 'rgb(44 124 107 / 10%)',
    '--iris-danger': '#a1403e',
    '--iris-danger-wash': 'rgb(161 64 62 / 10%)',
    '--iris-warn': '#8a6420',
    '--iris-code-bg': '#e4e8eb',
    '--iris-code-inline': '#dfe4e8',
    '--iris-shadow': '0 1px 2px rgb(20 26 32 / 6%), 0 8px 24px rgb(20 26 32 / 10%)',
    '--iris-scrim': 'rgb(20 26 32 / 28%)',
    '--iris-scrollbar': '#cdd4d9',
    '--iris-scrollbar-strong': '#a9b4bd',
  },
}

/** The dark theme — the blue-black ground and the lifted slate sheet. */
const dark: ThemePreset = {
  id: 'dark',
  tokens: {
    '--iris-bg-base': '#0d1116',
    '--iris-bg-page': '#12171d',
    '--iris-bg-raised': '#1a2128',
    '--iris-bg-sunken': '#090c10',
    '--iris-bg-mask': 'rgb(6 9 12 / 62%)',
    '--iris-rule': '#232c35',
    '--iris-rule-strong': '#33404b',
    '--iris-rule-faint': '#1a222a',
    '--iris-tick': '#586a79',
    '--iris-ink': '#e6e2d9',
    '--iris-ink-secondary': '#a8b1b9',
    '--iris-ink-tertiary': '#7c868f',
    '--iris-ink-faint': '#5d666e',
    '--iris-ink-inverted': '#0d1116',
    '--iris-accent': '#6cc0aa',
    '--iris-accent-quiet': '#4c9482',
    '--iris-accent-wash': 'rgb(108 192 170 / 12%)',
    '--iris-danger': '#d07d79',
    '--iris-danger-wash': 'rgb(208 125 121 / 14%)',
    '--iris-warn': '#cfa457',
    '--iris-code-bg': '#0b0f13',
    '--iris-code-inline': '#1e262e',
    '--iris-shadow': '0 1px 2px rgb(0 0 0 / 40%), 0 10px 30px rgb(0 0 0 / 46%)',
    '--iris-scrim': 'rgb(0 0 0 / 52%)',
    '--iris-scrollbar': '#2c3540',
    '--iris-scrollbar-strong': '#46545f',
  },
}

/*
 * The parchment theme — the third built-in, and the warm pole of the set:
 * cool paper, blue-black ground, and now aged paper under the same lamp.
 *
 * The numbers were chosen against the floors, not by eye: ink `#33291a` reads
 * 12.3:1 on the page, secondary ink `#5f5033` 6.8:1, the tick `#8a7a55` 3.6:1,
 * and the accent — an iron-gall ink green, keeping the metaphor — 5.4:1, well
 * clear of the tick it must outrank. The scrollbar stays below the rules in
 * contrast on purpose, exactly as in the other two themes: chrome for moving,
 * not a line for reading.
 */
const parchment: ThemePreset = {
  id: 'parchment',
  tokens: {
    '--iris-bg-base': '#e7dfca',
    '--iris-bg-page': '#f4eede',
    '--iris-bg-raised': '#fbf7ec',
    '--iris-bg-sunken': '#eae2cd',
    '--iris-bg-mask': 'rgb(53 42 26 / 38%)',
    '--iris-rule': '#d9cfb4',
    '--iris-rule-strong': '#c3b593',
    '--iris-rule-faint': '#e7dfc8',
    '--iris-tick': '#8a7a55',
    '--iris-ink': '#33291a',
    '--iris-ink-secondary': '#5f5033',
    '--iris-ink-tertiary': '#857452',
    '--iris-ink-faint': '#a4946f',
    '--iris-ink-inverted': '#f4eede',
    '--iris-accent': '#416a45',
    '--iris-accent-quiet': '#6d9673',
    '--iris-accent-wash': 'rgb(65 106 69 / 10%)',
    '--iris-danger': '#a4472f',
    '--iris-danger-wash': 'rgb(164 71 47 / 10%)',
    '--iris-warn': '#7d5c1e',
    '--iris-code-bg': '#ece4cf',
    '--iris-code-inline': '#e7dec6',
    '--iris-shadow': '0 1px 2px rgb(53 42 26 / 8%), 0 8px 24px rgb(53 42 26 / 12%)',
    '--iris-scrim': 'rgb(40 30 15 / 30%)',
    '--iris-scrollbar': '#cfc2a4',
    '--iris-scrollbar-strong': '#a99a76',
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
