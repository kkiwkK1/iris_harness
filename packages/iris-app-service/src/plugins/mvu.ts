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
import type {
  PluginVariableTable,
  VariableWriteView,
  VariableWriter,
} from '@iris/plugin-api'
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

/**
 * Whether a stored table is an MVU state tree rather than some other variable
 * table. Structural, the same test `entry.ts`'s baseline walk applies: the
 * message layer can carry any writer's table, and only one carrying a
 * `stat_data` tree is a state MVU may inherit from.
 */
function isMvuData(value: unknown): value is MvuData {
  return typeof value === 'object' && value !== null && 'stat_data' in value
}

/**
 * The state a turn's MVU commands fold into, read off a settlement view.
 *
 * The nearest earlier turn's MVU tree, NOT the state as it stands — a rerolled
 * turn must start from the same baseline the discarded reply did — walking
 * backwards through `view.variablesAt` and falling back to what the card
 * declares. This is the walk `entry.baselineFor` has always done; the two
 * coexist until the service-side callers of that one are gone, and they must
 * answer identically, which is what the writer tests pin.
 */
export function mvuBaselineOf(view: VariableWriteView): MvuData {
  for (let earlier = view.turn - 1; earlier >= 0; earlier -= 1) {
    const stored = view.variablesAt(earlier)
    if (stored !== undefined && isMvuData(stored)) return stored
  }
  return view.declared as MvuData
}

/**
 * MVU as a variable writer: the settlement side of the capability.
 *
 * The proposal is computed from the view alone — the capability travels in,
 * everything else (`text`, the baseline walk, the impersonation rule) rides on
 * the view — so one factory serves the live runtime (the host registers it
 * under `mvu` and resolves the capability per settlement, which is what keeps
 * a stale incarnation from writing) and the no-runtime compatibility path
 * (registered once with `COMPAT_MVU`). The impersonation refusal moved here
 * from the settlement's own `!impersonating` branch: an impersonated line
 * becomes a user line, and a user line carries no variable consequences.
 */
export function createMvuVariableWriter(capability: MvuCapability): VariableWriter {
  return {
    baselineFor: view => mvuBaselineOf(view) as unknown as PluginVariableTable,
    propose: view => {
      if (view.kind === 'impersonate') return undefined
      const result = capability.update(view.text, mvuBaselineOf(view))
      return {
        variables: result.data as unknown as PluginVariableTable,
        reports: result.reports,
        reportKind: 'mvu',
      }
    },
  }
}
