/**
 * The runtime overlay of plugins' bundled interface copy.
 *
 * A plugin ships two flat tables (`i18n.en` / `i18n.zh`, audited at install);
 * the shell merges them into a **namespace**, not the dictionary: every key is
 * addressed as `plugin:<id>:<key>`, so a plugin that declares `send` or even
 * `pluginCenterTitle` can never shadow a shell key — the static `StringKey`
 * type stays closed, and the namespace is the whole boundary. The state is a
 * module-level external store, the same shape `language.ts` holds the
 * interface language in: React subscribes through `useSyncExternalStore`
 * (`use-language.ts`), plain modules read directly, and no reload is needed
 * for copy that arrives late.
 *
 * **Lifetime follows the aggregate manifest.** The loader
 * (`syncPluginCopy`) runs once per manifest snapshot: rows are fetched per
 * `(id, lang, rev)` — the rev in each URL makes an unchanged table a no-op,
 * which is what the `immutable` cache contract buys — and every id the
 * manifest stopped carrying is dropped here. A disabled plugin has no row, so
 * disabling removes its copy without a second invalidation path; the overlay
 * is not a table things only enter.
 *
 * **Fallback is visible, not blank:** the requested language, then English,
 * then the runtime key itself (`plugin:demo:panelTitle`). An empty string
 * would be a failure nobody can find; a key on screen is one a reader can
 * report.
 *
 * @module iris-web/app/i18n/plugin-copy
 */

import type { PluginAssetManifest } from '@iris/plugin-web-api'

import type { Language } from './strings.ts'

/** One plugin's two copy tables, exactly as the package shipped them. */
export interface PluginCopyTables {
  readonly en: Readonly<Record<string, string>>
  readonly zh: Readonly<Record<string, string>>
}

/** The whole overlay, keyed by plugin id. */
export type PluginCopySnapshot = Readonly<Record<string, PluginCopyTables>>

let snapshot: PluginCopySnapshot = {}

const listeners = new Set<() => void>()

/** The copy one plugin currently contributes, or `undefined` when none. */
export function getPluginCopy(id: string): PluginCopyTables | undefined {
  return snapshot[id]
}

/** The whole overlay, for subscribers that render across plugins. */
export function getPluginCopyAll(): PluginCopySnapshot {
  return snapshot
}

/**
 * Install (or replace) one plugin's copy and tell every reader.
 * @param id - the plugin id the copy belongs to.
 * @param tables - the two tables, as fetched from the asset face.
 */
export function setPluginCopy(id: string, tables: PluginCopyTables): void {
  snapshot = { ...snapshot, [id]: tables }
  for (const listener of listeners) listener()
}

/** Remove one plugin's copy and tell every reader. */
export function dropPluginCopy(id: string): void {
  if (snapshot[id] === undefined) return
  const next = { ...snapshot }
  delete next[id]
  snapshot = next
  for (const listener of listeners) listener()
}

/**
 * Watch for copy arriving, changing or leaving.
 * @returns a disposer, because every registration in Iris is reversible.
 */
export function subscribePluginCopy(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The runtime key one plugin's copy key is addressed under. */
export function pluginRuntimeKey(id: string, copyKey: string): `plugin:${string}:${string}` {
  return `plugin:${id}:${copyKey}`
}

/**
 * Read one runtime key from the overlay, along the fallback chain
 * (`zh` → `en`), or `undefined` when neither column carries it — the caller
 * decides the terminal fallback (the key itself, or the snapshot's sentence).
 * @param lang - the language to prefer.
 * @param id - the plugin the copy belongs to.
 * @param copyKey - the key inside the plugin's own tables.
 * @param params - values for the string's `{slots}`, if it has any.
 */
export function readPluginCopy(
  lang: Language,
  id: string,
  copyKey: string,
  params?: Record<string, string | number>,
): string | undefined {
  const tables = snapshot[id]
  const template = tables?.[lang]?.[copyKey] ?? tables?.en?.[copyKey]
  if (template === undefined) return undefined
  return params === undefined ? template : interpolate(template, params)
}

/**
 * The copy for one runtime key, the implementation behind `translate`'s
 * `plugin:` branch (which delegates; see `strings.ts`). The terminal fallback
 * is the key itself: blank is a failure nobody can find.
 */
export function translatePlugin(
  lang: Language,
  id: string,
  copyKey: string,
  params?: Record<string, string | number>,
): string {
  return readPluginCopy(lang, id, copyKey, params) ?? pluginRuntimeKey(id, copyKey)
}

/**
 * Bring the overlay in line with one aggregate manifest: fetch rows that are
 * new or revved, keep rows already held at their current rev, and drop every
 * id the manifest no longer names — which is how a disabled or upgraded
 * plugin's copy leaves.
 *
 * Failures are per plugin and all-or-nothing within it, mirroring how the
 * host publishes copy: a table that will not read drops the whole id, the
 * rest of the overlay is untouched, and the console names the id — copy is
 * presentation, and one plugin's broken table must not decide what the
 * others render.
 * @param manifest - the aggregate manifest just read for the current revision.
 */
export async function syncPluginCopy(manifest: Pick<PluginAssetManifest, 'plugins'>): Promise<void> {
  const results = await Promise.all(Object.entries(manifest.plugins).map(async ([id, entry]) => {
    if (entry.i18n === undefined) return { id, tables: undefined }
    const [en, zh] = await Promise.all([
      fetchCopyTable(id, 'en', entry.i18n['en']),
      fetchCopyTable(id, 'zh', entry.i18n['zh']),
    ])
    if (en === undefined || zh === undefined) return { id, tables: undefined }
    return { id, tables: { en, zh } as PluginCopyTables }
  }))

  for (const { id, tables } of results) {
    if (tables !== undefined) {
      if (snapshot[id] !== tables) setPluginCopy(id, tables)
    } else {
      dropPluginCopy(id)
    }
  }
  for (const id of Object.keys(snapshot)) {
    if (!Object.hasOwn(manifest.plugins, id)) dropPluginCopy(id)
  }
}

/** Revs already fetched, per `<id>/<lang>` — the dedup that makes re-revving cheap. */
const fetched = new Map<string, string>()

/** The `?rev=` the copy URLs carry, so an unchanged table is never re-read. */
function revOf(url: string): string {
  return new URL(url, 'http://iris.invalid').searchParams.get('rev') ?? ''
}

async function fetchCopyTable(
  id: string,
  lang: 'en' | 'zh',
  url: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  const rev = revOf(url)
  const key = `${id}/${lang}`
  if (fetched.get(key) === rev && snapshot[id] !== undefined) return snapshot[id]![lang]
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const parsed: unknown = JSON.parse(await response.text())
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the copy table is not a JSON object')
    }
    for (const value of Object.values(parsed)) {
      if (typeof value !== 'string') throw new Error('the copy table has a non-string value')
    }
    fetched.set(key, rev)
    return parsed as Record<string, string>
  } catch (error: unknown) {
    console.warn(`plugin copy: ${id}/${lang} could not be loaded (${error instanceof Error ? error.message : String(error)}); its copy is dropped until the next manifest`)
    fetched.delete(key)
    return undefined
  }
}

/**
 * Minimal slot filling for plugin copy. Duplicated from `strings.ts` rather
 * than imported: `strings.ts` imports this module for the `plugin:` branch of
 * `translate`, and a runtime import back would make the cycle real.
 */
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  )
}
