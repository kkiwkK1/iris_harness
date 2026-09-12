/**
 * MVU's detachable initialization, update and replay strategy.
 *
 * Storage does not belong to this capability: chat files keep their variable
 * tables while the plugin is disabled or uninstalled. The capability receives
 * data, computes a new tree, and returns it to the chat that owns persistence.
 * That split makes disposal real without making uninstall destructive.
 *
 * @module @iris/app-service/plugins/mvu
 */

import type { CharacterCard } from '@iris/character'
import {
  applyCommands,
  loadInitVars,
  scanDialects,
  type MvuData,
} from '@iris/mvu'

import type { ResolvedWorldbook } from '../worldbooks.ts'

/** An empty MVU tree, before any book has declared anything. */
export const EMPTY_MVU: MvuData = { initialized_lorebooks: {}, stat_data: {} }

/** Inputs needed to resolve a card's declared initial variable tree. */
export interface MvuInitialSource {
  card: CharacterCard | undefined
  worldbook: ResolvedWorldbook | undefined
}

/** Result of interpreting one generated reply. */
export interface MvuUpdate {
  data: MvuData
  reports: string[]
}

/** The complete host-side MVU behavior owned by one activation. */
export interface MvuCapability {
  /** Activation revision that owns this object. */
  readonly revision: number
  /** Resolve `[InitVar]` declarations in MVU's upstream order. */
  initialState(source: MvuInitialSource): MvuData
  /** Interpret one reply against its persisted baseline. */
  update(text: string, baseline: MvuData): MvuUpdate
  /** Fold stored reply texts forward from an intact persisted baseline. */
  replay(texts: readonly string[], baseline: MvuData): MvuData
}

/** One admitted use of an MVU activation, valid through its drain window. */
export interface MvuExecution {
  capability: MvuCapability
  isCurrent(): boolean
}

/** Resolve the world books MVU itself scans for `[InitVar]`. */
function initBooks(source: MvuInitialSource): { name: string, entries: unknown[] }[] {
  const chosen = source.worldbook
  const books: { name: string, entries: unknown[] }[] = []
  const seen = new Set<string>()

  // MVU's getEnabledLorebookList builds global, primary, then additional.
  for (const book of chosen?.global ?? []) {
    if (seen.has(book.world)) continue
    seen.add(book.world)
    books.push({ name: book.world, entries: book.entries })
  }

  const ownName = chosen?.world ?? source.card?.data.name ?? 'character book'
  const own = chosen !== undefined
    ? chosen.entries
    : (() => {
        const book = source.card?.data.character_book
        return book !== undefined && Array.isArray(book.entries) ? book.entries : []
      })()
  if (own.length > 0 && !seen.has(ownName)) {
    seen.add(ownName)
    books.push({ name: ownName, entries: own })
  }

  for (const book of chosen?.additional ?? []) {
    if (seen.has(book.world) || book.entries.length === 0) continue
    seen.add(book.world)
    books.push({ name: book.world, entries: book.entries })
  }

  return books
}

/** Build one activation's MVU capability. */
export function createMvuCapability(revision: number): MvuCapability {
  return {
    revision,

    initialState(source): MvuData {
      const books = initBooks(source)
      return books.length === 0
        ? EMPTY_MVU
        : loadInitVars(books as Parameters<typeof loadInitVars>[0], EMPTY_MVU).data
    },

    update(text, baseline): MvuUpdate {
      const reports: string[] = []
      const scan = scanDialects(text)
      for (const rejection of scan.rejected) reports.push(`MVU: ${rejection}`)
      if (scan.jsonPatchOperations > 0 && scan.commands.length === 0) {
        reports.push(
          `MVU: a reply carried ${String(scan.jsonPatchOperations)} <JSONPatch> operation(s) that produced no commands`,
        )
      }
      if (scan.legacyAttempts > scan.legacyCommands) {
        const dropped = scan.legacyAttempts - scan.legacyCommands
        reports.push(
          `MVU: a reply started ${String(scan.legacyAttempts)} _.verb() call(s) and ${String(dropped)} could not be read`,
        )
      }
      const result = applyCommands(scan.commands, baseline)
      for (const failure of result.failures) reports.push(`MVU: ${failure.reason}`)
      return { data: result.data, reports }
    },

    replay(texts, baseline): MvuData {
      let state = baseline
      for (const text of texts) {
        state = applyCommands(scanDialects(text).commands, state).data
      }
      return state
    },
  }
}

/** Compatibility behavior for callers constructed without a plugin runtime. */
export const COMPAT_MVU = createMvuCapability(0)
