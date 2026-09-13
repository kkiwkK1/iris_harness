/**
 * The shell's half of the plugin merge: the aggregate manifest, fetched and
 * held for the snapshot reduction.
 *
 * Fetched per **snapshot revision**, not per mount: the manifest is the host
 * composing the enabled set, and a `plugins.changed` that moved the revision
 * is the only event that can change its content. The result lands in state,
 * whose identity is a rebuild dependency one level up — a manifest that
 * arrives after frames have mounted rebuilds them, because their tags were
 * built from the rows it carries.
 *
 * Failure is **empty, not fatal, and named in the console**: a card that needs
 * no plugin must keep working when `/plugins/manifest.json` does not answer,
 * so the reduction receives `undefined` and frames run with no plugin rows —
 * the same failure direction the build's own manifest takes (missing means
 * no-cache, not no-card). The named warning here is the shell-side half of the
 * visibility rule; the frame-side half is the merge's per-plugin reports. A
 * user-facing status surface for this fetch belongs to the plugin center, not
 * to the frame runner.
 *
 * @module iris-web/app/use-plugin-manifest
 */
import { useCallback, useEffect, useState } from 'react'

import { PLUGIN_ASSET_MANIFEST_PATH, parsePluginAssetManifest, type PluginAssetManifest } from '@iris/plugin-web-api'
import type { SystemPluginSnapshot } from '@iris/protocol'

/** Read and validate the aggregate manifest, or say why it could not be read. */
async function pluginAssetManifest(): Promise<PluginAssetManifest> {
  const response = await fetch(PLUGIN_ASSET_MANIFEST_PATH)
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const parsed = parsePluginAssetManifest(await response.text())
  if (typeof parsed === 'string') throw new Error(parsed)
  return parsed
}

/**
 * The manifest for one snapshot revision, or `undefined` while it is absent —
 * not yet fetched, unreachable, or invalid.
 * @param revision - the snapshot revision the manifest should answer for.
 * @returns the manifest, when one has been read for the current revision.
 */
export function usePluginAssetManifest(revision: number | undefined): PluginAssetManifest | undefined {
  const [manifest, setManifest] = useState<PluginAssetManifest | undefined>(undefined)
  useEffect(() => {
    if (revision === undefined) {
      setManifest(undefined)
      return
    }
    let stale = false
    pluginAssetManifest().then(
      read => {
        if (!stale) setManifest(read)
      },
      error => {
        if (!stale) {
          setManifest(undefined)
          console.warn(`plugin manifest: ${PLUGIN_ASSET_MANIFEST_PATH} could not be read (${String(error)}); frames run without plugin members`)
        }
      },
    )
    return () => {
      stale = true
    }
  }, [revision])
  return manifest
}

/**
 * The PluginCenter's half of the visibility rule: what the **browser side** of
 * each enabled plugin is doing, derived from what the shell can see on its own
 * side of the frame wall.
 *
 * The frame's merge reports (`plugin-members.ts`) name per-plugin refusals
 * inside each sandbox, but those realms are behind `srcdoc` and report to
 * cards, not to the shell — and this task's surface is this module plus the
 * plugin center. So the status below is assembled from the two things the
 * shell *can* read without touching the frame protocol: the aggregate
 * manifest (who has a bundle to serve) and the client bundle itself (fetched
 * like the frame would fetch it, compiled — never executed — so a syntax
 * error is named as a parse failure rather than left invisible until some
 * card probes the refused namespace).
 *
 * The phases map the five observable states onto shell-visible facts:
 *
 * - `undeclared` — the host snapshot does not run the plugin, or runs it
 *   without any manifest row this session has seen (a plugin whose browser
 *   face does not exist, the bundled catalog's normal state; the wire does
 *   not carry a "declares assets" bit, so this is the honest reading).
 * - `loading` — the manifest or the plugin's `client.js` is being fetched.
 * - `loaded` — the manifest row exists for the current revision, the bundle
 *   was fetched, and it compiles.
 * - `degraded` — a failure was named: the bundle is missing, the fetch
 *   failed, the manifest is malformed, or two bundles register a colliding
 *   member name. A row that vanished at the **same** revision it was served
 *   at is a server-side deletion and reads degraded, not undeclared. The
 *   host plugin stays enabled; degradation is **browser only** and never
 *   flows back into the store.
 * - `stale` — the manifest's revision does not answer for the snapshot's
 *   revision (an older read still in flight, or a fetch that has not caught
 *   up to a `plugins.changed`). The rows it carries are last revision's
 *   bytes and are shown as such — expected revision against actual — but are
 *   not probed further.
 */

/** Why a plugin's browser face is not whole, classified for display. */
export type PluginAssetErrorKind =
  | 'client-missing'
  | 'http'
  | 'parse'
  | 'manifest'
  | 'revision'
  | 'conflict'

/** One classified browser-asset failure, ready for the status row. */
export interface PluginAssetError {
  kind: PluginAssetErrorKind
  message: string
  /** For `conflict`: the member name and the plugin ids claiming it. */
  sources?: { member: string, claimants: string[] }
}

/** The browser-asset phase of one plugin, as the shell can observe it. */
export type PluginAssetPhase = 'undeclared' | 'loading' | 'loaded' | 'degraded' | 'stale'

/** What the PluginCenter shows for one plugin's browser side. */
export interface PluginBrowserAssetStatus {
  phase: PluginAssetPhase
  /** The snapshot revision the browser assets should answer for. */
  expectedRevision: number | undefined
  /** The content rev actually served for the plugin, when known. */
  actualRevision: string | undefined
  error: PluginAssetError | undefined
  /** Epoch ms of the last successful bundle fetch, when there was one. */
  loadedAt: number | undefined
}

/** One probe's outcome, before the reduction merges it with the snapshot. */
export interface PluginProbe {
  phase: 'loading' | 'loaded' | 'degraded'
  rev: string | undefined
  error: PluginAssetError | undefined
  loadedAt: number | undefined
  /** The bundle text as served, kept for the cross-plugin conflict scan. */
  source: string | undefined
}

/**
 * Classify one `client.js` response into a probe outcome.
 *
 * Exported for tests: the classification is the contract the status row
 * shows, so the kinds stay named here rather than inlined into the fetch
 * path. A 404 names a missing bundle; any other failed HTTP status names the
 * fetch; a bundle that fails to compile (classic script, `new Function`
 * parses but does not run a statement) names the parse; a module bundle is
 * taken on trust, because it cannot be compile-checked without a module
 * context and the frame's own ready marker is its verdict.
 */
export function classifyClientResponse(status: number, text: string | undefined, rev: string): PluginProbe {
  if (status === 404) {
    return { phase: 'degraded', rev, loadedAt: undefined, source: undefined, error: { kind: 'client-missing', message: `the client bundle does not exist (HTTP 404 for rev ${rev})` } }
  }
  if (status < 200 || status >= 300) {
    return { phase: 'degraded', rev, loadedAt: undefined, source: undefined, error: { kind: 'http', message: `HTTP ${String(status)} while fetching the client bundle` } }
  }
  if (/^\s*(import|export)\b/m.test(text ?? '')) {
    return { phase: 'loaded', rev, loadedAt: Date.now(), source: text, error: undefined }
  }
  try {
    // Compile only: `new Function` parses classic script without running a
    // statement of it, so plugin code never executes on the shell side.
    new Function(text ?? '')
  } catch (error) {
    return { phase: 'degraded', rev, loadedAt: undefined, source: undefined, error: { kind: 'parse', message: `the client bundle failed to parse (${error instanceof Error ? error.message : String(error)})` } }
  }
  return { phase: 'loaded', rev, loadedAt: Date.now(), source: text, error: undefined }
}

/**
 * Extract the member names one bundle registers, best effort.
 *
 * The merge protocol is a runtime call
 * (`registerPluginMembers('<id>', { name: … })`), and the shell cannot see a
 * frame's registration — but the typical bundle passes a literal object, and
 * a collision between two enabled plugins' literal names is visible in the
 * two sources before either frame runs. The scan is deliberately narrow: only
 * literal object keys directly inside a `registerPluginMembers` call are
 * collected; computed keys and indirect registration yield nothing, because
 * a static scan must not invent a conflict. Exported for tests.
 */
export function scanPluginMemberNames(source: string | undefined): string[] {
  if (source === undefined) return []
  const names: string[] = []

  const quotedEnd = (at: number): number => {
    const quote = source[at]
    let i = at + 1
    while (i < source.length) {
      if (source[i] === '\\') i += 2
      else if (source[i] === quote) return i + 1
      else i += 1
    }
    return source.length
  }
  const triviaEnd = (at: number): number => {
    let i = at
    while (i < source.length) {
      if (/\s/u.test(source[i]!)) { i += 1; continue }
      if (source.startsWith('//', i)) {
        const end = source.indexOf('\n', i + 2)
        i = end < 0 ? source.length : end + 1
        continue
      }
      if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2)
        i = end < 0 ? source.length : end + 2
        continue
      }
      break
    }
    return i
  }
  const identifierAt = (at: number): { value: string; end: number } | undefined => {
    const match = /^[A-Za-z_$][\w$]*/u.exec(source.slice(at))
    return match === null ? undefined : { value: match[0], end: at + match[0].length }
  }
  const literalKeyAt = (at: number): { value: string; end: number } | undefined => {
    const id = identifierAt(at)
    if (id !== undefined) return id
    const quote = source[at]
    if (quote !== "'" && quote !== '"') return undefined
    const end = quotedEnd(at)
    const raw = source.slice(at + 1, end - 1)
    return /^[A-Za-z_$][\w$]*$/u.test(raw) ? { value: raw, end } : undefined
  }
  const objectKeys = (openingBrace: number): { keys: string[]; end: number } => {
    const keys: string[] = []
    let braces = 1
    let parens = 0
    let brackets = 0
    let expectKey = true
    let i = openingBrace + 1
    while (i < source.length && braces > 0) {
      const next = triviaEnd(i)
      if (next !== i) { i = next; continue }
      const char = source[i]!
      if (char === "'" || char === '"' || char === '`') {
        if (braces === 1 && parens === 0 && brackets === 0 && expectKey && char !== '`') {
          const key = literalKeyAt(i)
          if (key !== undefined) {
            const colon = triviaEnd(key.end)
            if (source[colon] === ':') {
              keys.push(key.value)
              expectKey = false
              i = colon + 1
              continue
            }
          }
        }
        i = quotedEnd(i)
        continue
      }
      if (char === '{') { braces += 1; i += 1; continue }
      if (char === '}') { braces -= 1; i += 1; continue }
      if (char === '(') { parens += 1; i += 1; continue }
      if (char === ')') { parens = Math.max(0, parens - 1); i += 1; continue }
      if (char === '[') { brackets += 1; i += 1; continue }
      if (char === ']') { brackets = Math.max(0, brackets - 1); i += 1; continue }
      if (braces === 1 && parens === 0 && brackets === 0 && char === ',') {
        expectKey = true
        i += 1
        continue
      }
      if (braces === 1 && parens === 0 && brackets === 0 && expectKey) {
        const key = literalKeyAt(i)
        if (key !== undefined) {
          const colon = triviaEnd(key.end)
          if (source[colon] === ':') {
            keys.push(key.value)
            expectKey = false
            i = colon + 1
            continue
          }
        }
      }
      i += 1
    }
    return { keys, end: i }
  }

  let i = 0
  while (i < source.length) {
    const next = triviaEnd(i)
    if (next !== i) { i = next; continue }
    if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      i = quotedEnd(i)
      continue
    }
    const token = identifierAt(i)
    if (token === undefined) { i += 1; continue }
    i = token.end
    if (token.value !== 'registerPluginMembers') continue
    let cursor = triviaEnd(i)
    if (source[cursor] !== '(') continue
    cursor = triviaEnd(cursor + 1)
    if (source[cursor] !== "'" && source[cursor] !== '"') continue
    cursor = triviaEnd(quotedEnd(cursor))
    if (source[cursor] !== ',') continue
    cursor = triviaEnd(cursor + 1)
    if (source[cursor] !== '{') continue
    const parsed = objectKeys(cursor)
    names.push(...parsed.keys)
    i = parsed.end
  }
  return names
}

/**
 * Pair up colliding member names across fetched bundles.
 *
 * At most one `conflict` error per plugin — the first colliding name found,
 * with every claimant — so a row names the sources without burying the rest
 * of the status. Exported for tests.
 */
export function findMemberConflicts(probes: Record<string, PluginProbe>): Record<string, PluginAssetError> {
  const names = new Map<string, string[]>()
  for (const [id, probe] of Object.entries(probes)) {
    for (const name of scanPluginMemberNames(probe.source)) {
      const claimants = names.get(name) ?? []
      if (!claimants.includes(id)) claimants.push(id)
      names.set(name, claimants)
    }
  }
  const errors: Record<string, PluginAssetError> = {}
  for (const [name, claimants] of names) {
    if (claimants.length < 2) continue
    for (const id of claimants) {
      errors[id] ??= {
        kind: 'conflict',
        message: `member "${name}" is declared by more than one plugin (${claimants.join(', ')})`,
        sources: { member: name, claimants },
      }
    }
  }
  return errors
}

/** Read and validate the aggregate manifest, or say why it could not be read. */
async function fetchManifest(): Promise<PluginAssetManifest> {
  const response = await fetch(PLUGIN_ASSET_MANIFEST_PATH)
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const parsed = parsePluginAssetManifest(await response.text())
  if (typeof parsed === 'string') throw new Error(parsed)
  return parsed
}

/** Classify one aggregate-manifest fetch failure for display. */
function manifestErrorKind(message: string): PluginAssetErrorKind {
  return /not valid JSON|not an object|not a nonnegative|invalid rev|outside/.test(message) ? 'manifest' : 'http'
}

/**
 * Rows the shell has seen the manifest carry this session, keyed by plugin id.
 *
 * The wire snapshot does not say whether a plugin *declares* browser assets,
 * so "enabled, but no manifest row" is ambiguous between a plugin that never
 * had a client bundle (the normal state — the bundled catalog ships none) and
 * a bundle deleted from the server. A row observed earlier at the **current**
 * revision is the evidence that separates them: enable/disable/install all
 * bump the revision, so a row that vanished without the revision moving is a
 * deletion, not a declaration. Session-scoped on purpose — a fresh page load
 * after a deletion has no evidence and honestly reads `undeclared` again.
 */
const seenRows = new Map<string, { rev: string, revision: number }>()

/**
 * Browser-asset statuses for every plugin in the host snapshot, plus retry.
 *
 * `retry` re-runs the manifest fetch and the named plugin's bundle probe
 * (every plugin's when no id is given). A probe that already succeeded for
 * the current rev is reused across renders and other plugins' retries — a
 * retry answers "look again", not "forget what worked". The manifest is also
 * re-read on a short interval while the snapshot is live, so a bundle deleted
 * or restored outside the control plane surfaces without a click; the path
 * revalidates on every read, so the poll is cheap and always fresh.
 *
 * @param snapshot - the host's authoritative catalog; `undefined` means the
 *   catalog itself is absent and every plugin reports `undeclared`.
 */
export function usePluginBrowserAssets(snapshot: SystemPluginSnapshot | undefined): {
  statuses: Record<string, PluginBrowserAssetStatus>
  retry: (pluginId?: string) => void
} {
  const revision = snapshot?.revision
  const [probes, setProbes] = useState<Record<string, PluginProbe>>({})
  const [manifest, setManifest] = useState<PluginAssetManifest | undefined>()
  const [manifestFailure, setManifestFailure] = useState<string | undefined>()
  const [nonce, setNonce] = useState(0)
  const [retryIds, setRetryIds] = useState<string[]>([])
  const [evidence, setEvidence] = useState(0)
  const [poll, setPoll] = useState(0)

  const retry = useCallback((pluginId?: string) => {
    setRetryIds(pluginId === undefined ? [] : [pluginId])
    setNonce(current => current + 1)
  }, [])

  useEffect(() => {
    if (revision === undefined) {
      setProbes({})
      setManifest(undefined)
      setManifestFailure(undefined)
      return
    }
    let stale = false
    setManifestFailure(undefined)
    fetchManifest().then(
      read => {
        if (stale) return
        setManifest(read)
        for (const [id, entry] of Object.entries(read.plugins)) {
          const held = seenRows.get(id)
          if (held?.rev === entry.rev && held.revision === read.revision) continue
          seenRows.set(id, { rev: entry.rev, revision: read.revision })
          setEvidence(current => current + 1)
        }
      },
      error => {
        if (!stale) setManifestFailure(String(error))
      },
    )
    return () => {
      stale = true
    }
  }, [revision, nonce, poll])

  // Poll while the catalog is live: the manifest revalidates per read, so this
  // is how a control-plane-external change (a bundle deleted or restored on
  // disk) reaches the surface without a click or a revision bump.
  useEffect(() => {
    if (revision === undefined) return
    const timer = setInterval(() => setPoll(current => current + 1), 10_000)
    return () => clearInterval(timer)
  }, [revision])

  useEffect(() => {
    // Probe each enabled plugin's bundle once the manifest answers for this
    // revision; a probe cached for the current rev is reused, and a retried
    // id is probed again even if a result is cached. A missing row is the
    // reduction's call (declaration evidence lives there), not a probe.
    if (manifest === undefined || snapshot === undefined || manifestFailure !== undefined) return
    if (manifest.revision !== snapshot.revision) return
    let stale = false
    for (const plugin of snapshot.plugins) {
      if (!(plugin.installed && plugin.enabled && plugin.status === 'enabled')) continue
      const entry = manifest.plugins[plugin.id]
      if (entry === undefined) continue
      const cached = probes[plugin.id]
      const probed = cached !== undefined && cached.rev === entry.rev && cached.phase !== 'loading'
      if (probed && !retryIds.includes(plugin.id)) continue
      void (async (): Promise<void> => {
        try {
          const response = await fetch(entry.client)
          const text = response.ok ? await response.text() : undefined
          const probe = classifyClientResponse(response.status, text, entry.rev)
          if (!stale) setProbes(current => ({ ...current, [plugin.id]: probe }))
        } catch (error) {
          if (!stale) setProbes(current => ({
            ...current,
            [plugin.id]: { phase: 'degraded', rev: entry.rev, loadedAt: undefined, source: undefined, error: { kind: 'http', message: `the client bundle could not be fetched (${error instanceof Error ? error.message : String(error)})` } },
          }))
        }
      })()
    }
    if (retryIds.length > 0) setRetryIds([])
    return () => {
      stale = true
    }
    // `probes` is read but deliberately not a dependency: the effect runs per
    // revision and per retry, and a probe landing must not re-run it.
  }, [manifest, manifestFailure, snapshot, retryIds])

  const statuses: Record<string, PluginBrowserAssetStatus> = {}
  if (snapshot !== undefined) {
    const conflicts = findMemberConflicts(probes)
    for (const plugin of snapshot.plugins) {
      if (!(plugin.installed && plugin.enabled && plugin.status === 'enabled')) {
        statuses[plugin.id] = { phase: 'undeclared', expectedRevision: revision, actualRevision: undefined, error: undefined, loadedAt: undefined }
        continue
      }
      if (manifestFailure !== undefined) {
        statuses[plugin.id] = { phase: 'degraded', expectedRevision: revision, actualRevision: undefined, loadedAt: undefined, error: { kind: manifestErrorKind(manifestFailure), message: `the aggregate manifest could not be read (${manifestFailure})` } }
        continue
      }
      if (manifest === undefined) {
        statuses[plugin.id] = { phase: 'loading', expectedRevision: revision, actualRevision: undefined, error: undefined, loadedAt: undefined }
        continue
      }
      if (manifest.revision !== revision) {
        statuses[plugin.id] = { phase: 'stale', expectedRevision: revision, actualRevision: undefined, loadedAt: undefined, error: { kind: 'revision', message: `the manifest answers for revision ${String(manifest.revision)}, not the current ${String(revision)}` } }
        continue
      }
      if (manifest.plugins[plugin.id] === undefined) {
        // Enabled with no row: a plugin that never declared browser assets
        // (the bundled catalog's normal state) reads `undeclared`; a row this
        // session served at the current revision and now lost reads as a
        // server-side deletion — `degraded`, with the retry left armed.
        const seen = seenRows.get(plugin.id)
        if (seen !== undefined && seen.revision === revision) {
          statuses[plugin.id] = { phase: 'degraded', expectedRevision: revision, actualRevision: seen.rev, loadedAt: probes[plugin.id]?.loadedAt, error: { kind: 'client-missing', message: 'the manifest stopped listing this enabled plugin without a revision change — its client.js was removed from the server' } }
        } else {
          statuses[plugin.id] = { phase: 'undeclared', expectedRevision: revision, actualRevision: undefined, error: undefined, loadedAt: undefined }
        }
        continue
      }
      const probe = probes[plugin.id]
      if (probe === undefined) {
        statuses[plugin.id] = { phase: 'loading', expectedRevision: revision, actualRevision: undefined, error: undefined, loadedAt: undefined }
        continue
      }
      const conflict = conflicts[plugin.id]
      if (conflict !== undefined) {
        statuses[plugin.id] = { phase: 'degraded', expectedRevision: revision, actualRevision: probe.rev, loadedAt: probe.loadedAt, error: conflict }
        continue
      }
      statuses[plugin.id] = { phase: probe.phase, expectedRevision: revision, actualRevision: probe.rev, error: probe.error, loadedAt: probe.loadedAt }
    }
  }
  return { statuses, retry }
}
