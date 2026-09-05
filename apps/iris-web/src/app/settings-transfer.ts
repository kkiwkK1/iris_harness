/**
 * The settings file: everything one export carries, and the gate an import
 * must pass.
 *
 * Upstream lets an install export its settings as one JSON file, and the
 * ability matters more than any single key in it: a reader moving machines —
 * or restoring after a bad import — should not reconstruct forty sliders from
 * memory. The format here is the store's own shape, plus the per-device
 * choices the host never sees, and it is recorded here rather than invented at
 * the keyboard:
 *
 * - `format` / `version` — the refuse-garbage tag. An import that is not this
 *   format is refused before any key of it is applied.
 * - `scope` — the generation settings' layer. A chat with overrides exports
 *   those overrides; with none, the global layer. An import applies to the
 *   context open when it runs, which the drawer says in so many words.
 * - `device` — the per-device half (theme, reading, language, startup). These
 *   never touch the host, so they cannot come back from it either.
 * - `generation` / `worldbook` / `connections` — the host's stored settings.
 *   **A connection profile is exported without its key**, because no read
 *   ever returned one: an import restores the profile keyless and the key is
 *   typed again. A settings file that could carry credentials would turn the
 *   export button into the weakest link of the whole credential story.
 *
 * Everything here is pure so the round trip can be asserted in a test: build,
 * serialise, parse, and the same object comes back.
 *
 * @module iris-web/app/settings-transfer
 */

import type { ConnectionProfile, GenerationSettings, WorldbookSettingsView } from '@iris/protocol'

import { READING_LIMITS, type ReadingPrefs, type ThemeChoice } from '../theme/theme.ts'
import type { Language } from './i18n/strings.ts'

/** The shape of an exported settings file. */
export interface SettingsTransferFile {
  format: 'iris.settings'
  version: 1
  exportedAt: string
  scope: { chatId: string | null }
  device: {
    theme: ThemeChoice
    reading: ReadingPrefs
    language: Language
    autoOpenChat: boolean
  }
  generation: GenerationSettings
  /** Null when the drawer never loaded the world books (nothing was known). */
  worldbook: { settings: WorldbookSettingsView, globalSelect: string[] } | null
  /** Profiles as stored, minus every credential. */
  connections: Array<Omit<ConnectionProfile, 'id' | 'hasKey' | 'keyTail' | 'summary'>>
}

/** What `buildExport` reads: the live state, already in hand. */
export interface ExportInput {
  chatId: string | undefined
  theme: ThemeChoice
  reading: ReadingPrefs
  language: Language
  autoOpenChat: boolean
  generation: GenerationSettings
  worldbook: { settings: WorldbookSettingsView, globalSelect: string[] } | undefined
  connections: readonly ConnectionProfile[]
}

/**
 * Assemble the export file from the live state.
 *
 * The credential-stripping is structural: `connections` maps to a projection
 * that has no field a key could hide in, so an export cannot leak one by
 * forgetting to delete it.
 * @param input - the live state to carry.
 * @returns the file, ready to serialise.
 */
export function buildExport(input: ExportInput): SettingsTransferFile {
  return {
    format: 'iris.settings',
    version: 1,
    exportedAt: new Date().toISOString(),
    scope: { chatId: input.chatId ?? null },
    device: {
      theme: input.theme,
      reading: { ...input.reading },
      language: input.language,
      autoOpenChat: input.autoOpenChat,
    },
    generation: { ...input.generation },
    worldbook: input.worldbook === undefined
      ? null
      : { settings: { ...input.worldbook.settings }, globalSelect: [...input.worldbook.globalSelect] },
    connections: input.connections.map(profile => ({
      provider: profile.provider,
      model: profile.model,
      ...profile.label === undefined ? {} : { label: profile.label },
      ...profile.preset === undefined ? {} : { preset: profile.preset },
      ...profile.baseURL === undefined ? {} : { baseURL: profile.baseURL },
      ...profile.sampling === undefined ? {} : { sampling: profile.sampling },
    })),
  }
}

/** Why an import was refused. */
export type ImportRefusal = 'bad-json' | 'bad-format'

/**
 * Parse and validate an exported file.
 *
 * The format tag is strict — a file that does not name itself is refused
 * whole, because applying half of someone else's shape is worse than applying
 * none of it. Everything under the tag is lenient per key: a file from an
 * older or newer build carries what it carries, and unknown keys drop.
 * @param text - the file's text.
 * @returns the parsed file, or why it was refused.
 */
export function parseSettingsExport(text: string): { ok: true, data: SettingsTransferFile } | { ok: false, reason: ImportRefusal } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'bad-json' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'bad-format' }
  const file = parsed as Record<string, unknown>
  if (file['format'] !== 'iris.settings' || file['version'] !== 1) return { ok: false, reason: 'bad-format' }
  if (typeof file['generation'] !== 'object' || file['generation'] === null) return { ok: false, reason: 'bad-format' }
  if (typeof file['device'] !== 'object' || file['device'] === null) return { ok: false, reason: 'bad-format' }
  return { ok: true, data: parsed as SettingsTransferFile }
}

/**
 * Validate the device half of an import, one key at a time.
 *
 * The same rules the live preferences are held to: a theme is one of the three
 * words, the reading numbers clamp into their ranges, a language is one of the
 * two. An invalid key falls to its default rather than refusing the import —
 * a bad preference is not a reason to discard a settings file.
 * @param raw - the device section as the file carried it.
 * @returns the device choices to apply.
 */
export function transferDevice(raw: SettingsTransferFile['device']): {
  theme: ThemeChoice
  reading: ReadingPrefs
  language: Language
  autoOpenChat: boolean
} {
  const theme: ThemeChoice =
    raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'parchment' ? raw.theme : 'system'
  const language: Language = raw.language === 'zh' ? 'zh' : 'en'
  const reading = raw.reading ?? ({} as Partial<ReadingPrefs>)
  return {
    theme,
    language,
    autoOpenChat: raw.autoOpenChat !== false,
    reading: {
      size: clamp(reading.size, READING_LIMITS.size, 17),
      measure: clamp(reading.measure, READING_LIMITS.measure, 68),
      floors: reading.floors === true,
    },
  }
}

/** Clamp a number into a limit range, falling back when it is not a number. */
function clamp(value: number | undefined, limit: { min: number, max: number }, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.round(value), limit.min), limit.max)
}
