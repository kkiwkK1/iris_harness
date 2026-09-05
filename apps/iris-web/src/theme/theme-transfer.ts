/**
 * The theme package: a theme's tokens and the reader's user.css as one JSON
 * file, and the gate an import must pass.
 *
 * The format is the theme side of the settings file (`settings-transfer.ts`),
 * and it exists because a theme is worth more than one machine: the same
 * palette and the same user stylesheet should follow a reader to a second
 * device. The shape:
 *
 * - `format` / `version` — the refuse-garbage tag, applied whole: a file that
 *   is not this format is refused before any key of it is applied.
 * - `theme.id` — which built-in the palette belongs to, so an import can set
 *   the choice as well as the colours.
 * - `theme.tokens` — the **full** palette of that theme, with any overrides
 *   the reader had in force already folded in. Full rather than a diff, so
 *   the file is self-describing: it paints without asking the receiving build
 *   what its built-ins look like. On import the diff against the receiving
 *   build's own preset becomes the overrides layer
 *   (`overridesFromPackage`), so a package produced by a modified theme
 *   survives and a stock package applies as nothing at all.
 * - `userCss` — the user.css slot's text and switch, verbatim. It is the
 *   reader's own page CSS, so it travels with the palette it was tuned
 *   against.
 *
 * Everything here is pure so the round trip can be asserted: build, serialise,
 * parse, and the same theme comes back.
 *
 * @module iris-web/theme/theme-transfer
 */

import { themePreset, type ThemeId, type TokenOverrides } from './theme.ts'

/** The shape of an exported theme package. */
export interface ThemePackageFile {
  format: 'iris.theme'
  version: 1
  exportedAt: string
  theme: {
    id: ThemeId
    tokens: Record<string, string>
  }
  userCss: {
    css: string
    enabled: boolean
  }
}

/** What `buildThemePackage` reads. */
export interface ThemePackageInput {
  /** The theme the palette was resolved from. */
  themeId: ThemeId
  /** Overrides in force over that theme's built-in palette, if any. */
  overrides?: TokenOverrides
  /** The user.css slot's current text and switch. */
  userCss: { css: string, enabled: boolean }
}

/**
 * Assemble the package: the theme's full palette with overrides folded in.
 * @param input - the live theme state.
 * @returns the file, ready to serialise.
 */
export function buildThemePackage(input: ThemePackageInput): ThemePackageFile {
  const preset = themePreset(input.themeId)
  return {
    format: 'iris.theme',
    version: 1,
    exportedAt: new Date().toISOString(),
    theme: {
      id: input.themeId,
      tokens: { ...preset?.tokens, ...input.overrides },
    },
    userCss: { css: input.userCss.css, enabled: input.userCss.enabled },
  }
}

/** Why an import was refused. */
export type ThemeImportRefusal = 'bad-json' | 'bad-format'

/**
 * Parse and validate a package file.
 *
 * The format tag is strict; everything under it is lenient per key, the same
 * policy the settings file applies — a file from an older or newer build
 * carries what it carries.
 * @param text - the file's text.
 * @returns the parsed package, or why it was refused.
 */
export function parseThemePackage(text: string): { ok: true, data: ThemePackageFile } | { ok: false, reason: ThemeImportRefusal } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'bad-json' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'bad-format' }
  const file = parsed as Record<string, unknown>
  if (file['format'] !== 'iris.theme' || file['version'] !== 1) return { ok: false, reason: 'bad-format' }
  if (typeof file['theme'] !== 'object' || file['theme'] === null) return { ok: false, reason: 'bad-format' }
  if (typeof file['userCss'] !== 'object' || file['userCss'] === null) return { ok: false, reason: 'bad-format' }
  return { ok: true, data: parsed as ThemePackageFile }
}

/**
 * Is this a theme id the receiving build knows?
 * @param id - the id as the file carried it.
 * @returns the id, or undefined for an unknown one.
 */
export function packageThemeId(id: unknown): ThemeId | undefined {
  return id === 'light' || id === 'dark' || id === 'parchment' ? id : undefined
}

/**
 * Diff a package's palette against the receiving build's own preset for that
 * theme.
 *
 * The result is what the overrides layer must carry for the imported theme to
 * look like the file: empty for a stock palette, so importing a theme nobody
 * has customised leaves no layer to shadow later theme switches.
 * @param data - the parsed package.
 * @returns the overrides the package implies.
 */
export function overridesFromPackage(data: ThemePackageFile): TokenOverrides {
  const preset = themePreset(data.theme.id)
  if (preset === undefined) return {}
  const diff: TokenOverrides = {}
  for (const [token, value] of Object.entries(data.theme.tokens)) {
    if (preset.tokens[token as keyof typeof preset.tokens] !== value) diff[token] = value
  }
  return diff
}
