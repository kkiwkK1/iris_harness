/**
 * `/doctor`: read this host, this page and this conversation, and say what to
 * fix.
 *
 * Claude Code's `/doctor` diagnoses an installation; this is the same idea for
 * the three things an Iris session is made of. Each check is a **reading** plus
 * a **verdict** plus, when the verdict is not a pass, **one sentence saying
 * what to do** — a row that only said "✗ provider" would send the reader
 * looking for the fix the row already knew.
 *
 * **The rows are the cases this project actually hit**, not a checklist of
 * everything that could be read. Two of them (the stale page bundle and the
 * missing authoring model) were each seen by the owner more than once in one
 * week and each looked like a missing feature rather than a state; the others
 * are the states the host already refuses by name somewhere, gathered where
 * someone asking "why is this not working" will look.
 *
 * **Read-only.** The one call that goes over the network is `connection.test`,
 * the connection card's own test button: a `GET /models` against the provider,
 * which costs no tokens. Nothing here saves, grants, clears or starts
 * anything.
 *
 * **No key material.** This module never reads a profile's key fields and never
 * names the connection store's file; `tests/doctor.test.ts` pins that on the
 * source, because the property is about what the module *could* read, not what
 * today's output happens to contain.
 *
 * Pure over an injected client and page, so every row's good and bad shape is
 * a `node --test` case with a fake — the store wires the real ones.
 *
 * @module iris-web/app/doctor
 */

import type {
  ConnectionProfile,
  HostDoctorFacts,
  RpcRequest,
  RpcResponse,
} from '@iris/protocol'

import { parseSandboxManifest } from '../sandbox/asset-manifest.ts'
import { t } from './i18n/use-language.ts'
import type { StringKey } from './i18n/strings.ts'

/** The methods the doctor reads. Every one of them is a read. */
export type DoctorMethod =
  | 'debug.doctor'
  | 'debug.reports'
  | 'connection.list'
  | 'connection.test'
  | 'script.list'
  | 'plugin.list'

/** The slice of the client the doctor calls. `IrisClient` satisfies it. */
export interface DoctorClient {
  call<M extends DoctorMethod>(method: M, params: RpcRequest<M>): Promise<RpcResponse<M>>
}

/** What the page knows about itself, read by the caller from the live document. */
export interface DoctorPage {
  /** The file name of the module script this page booted from, when it has one. */
  entry?: string
  /** Whether this document carries the shell's Content-Security-Policy meta. */
  shellPolicy: boolean
  /** The port the page was served on, as `location.port` spells it. */
  port: string
  /** The open conversation's character, when the conversation names one. */
  characterId?: string
  /**
   * Fetch a same-origin path and return its status and body.
   *
   * Injected so the sandbox row can be tested without a server; the store passes
   * a `fetch` with `cache: 'no-store'`, because the question is what the host
   * serves now and not what the browser kept. `HEAD` for an artifact whose
   * bytes are not the question — the message preset is 1.66 MB.
   */
  fetchText: (path: string, method: 'GET' | 'HEAD') => Promise<{ status: number, body: string }>
}

/** How one row came out. */
export type DoctorVerdict = 'ok' | 'warn' | 'fail'

/** The checks, in the order the report prints them. */
export type DoctorCheck =
  | 'host'
  | 'bundle'
  | 'provider'
  | 'providerTest'
  | 'authoring'
  | 'consent'
  | 'dataDir'
  | 'faults'
  | 'sandbox'
  | 'policy'
  | 'plugins'
  | 'storage'
  | 'corpus'

/** One row of the report. */
export interface DoctorRow {
  check: DoctorCheck
  verdict: DoctorVerdict
  /** What was read, in words. */
  read: string
  /** What to do about it. Present exactly when the verdict is not `ok`. */
  remedy?: string
}

/** The glyph each verdict prints as. */
export const VERDICT_GLYPH: Record<DoctorVerdict, string> = { ok: '✓', warn: '⚠', fail: '✗' }

/** Which label each check prints under. */
const CHECK_LABEL: Record<DoctorCheck, StringKey> = {
  host: 'doctorLabelHost',
  bundle: 'doctorLabelBundle',
  provider: 'doctorLabelProvider',
  providerTest: 'doctorLabelProviderTest',
  authoring: 'doctorLabelAuthoring',
  consent: 'doctorLabelConsent',
  dataDir: 'doctorLabelDataDir',
  faults: 'doctorLabelFaults',
  sandbox: 'doctorLabelSandbox',
  policy: 'doctorLabelPolicy',
  plugins: 'doctorLabelPlugins',
  storage: 'doctorLabelStorage',
  corpus: 'doctorLabelCorpus',
}

/**
 * A failure's words, without the stack.
 * @param error - what was thrown.
 * @returns one line.
 */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return oneLine(text, 200)
}

/**
 * Cut a host sentence to one line of bounded length.
 * @param text - the sentence.
 * @param max - the most characters kept.
 * @returns the line.
 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * Whether an entry name is a built bundle's.
 *
 * Vite names the built entry `index-<hash>.js`; a dev server's page boots from
 * `main.tsx`, which no host build ever serves, so comparing the two would
 * report a stale page for every developer. A non-built page is read and said,
 * not compared.
 * @param entry - the file name.
 * @returns true for a content-hashed build entry.
 */
export function isBuiltEntry(entry: string | undefined): entry is string {
  return entry !== undefined && /^index-[\w-]+\.js$/.test(entry)
}

/**
 * Size in the unit a reader compares against a 10 MiB cap.
 * @param bytes - the size.
 * @returns e.g. `1.2 MiB` or `340 KiB`.
 */
function size(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MiB`
  // Under a KiB in bytes: 309 bytes printed as "0 KiB" reads as an empty store.
  if (bytes < 1024) return `${String(bytes)} B`
  return `${String(Math.round(bytes / 1024))} KiB`
}

/**
 * The page bundle against the one the host serves now.
 * @param facts - the host's facts.
 * @param page - the page's own reading.
 * @returns the row.
 */
export function bundleRow(facts: HostDoctorFacts, page: DoctorPage): DoctorRow {
  if (!isBuiltEntry(page.entry)) {
    return { check: 'bundle', verdict: 'ok', read: t('doctorBundleNotBuilt', { page: page.entry ?? '?' }) }
  }
  if (facts.webBundle === undefined) {
    return {
      check: 'bundle', verdict: 'warn',
      read: t('doctorBundleHostNone', { page: page.entry }),
      remedy: t('doctorBundleHostNoneFix'),
    }
  }
  if (facts.webBundle.entry === undefined) {
    return {
      check: 'bundle', verdict: 'fail',
      read: t('doctorBundleHostUnreadable', { page: page.entry }),
      remedy: t('doctorBundleHostUnreadableFix'),
    }
  }
  if (facts.webBundle.entry !== page.entry) {
    return {
      check: 'bundle', verdict: 'warn',
      read: t('doctorBundleStale', { page: page.entry, host: facts.webBundle.entry }),
      remedy: t('doctorBundleStaleFix'),
    }
  }
  return { check: 'bundle', verdict: 'ok', read: t('doctorBundleSame', { entry: page.entry }) }
}

/**
 * The data directory and its lock.
 * @param facts - the host's facts.
 * @returns the row.
 */
export function dataDirRow(facts: HostDoctorFacts): DoctorRow {
  const { path, writable, lockPid } = facts.dataDir
  if (!writable) {
    return {
      check: 'dataDir', verdict: 'fail',
      read: t('doctorDataDirNotWritable', { path }),
      remedy: t('doctorDataDirNotWritableFix'),
    }
  }
  if (lockPid === undefined) {
    return {
      check: 'dataDir', verdict: 'fail',
      read: t('doctorLockMissing', { path }),
      remedy: t('doctorLockMissingFix'),
    }
  }
  if (lockPid !== facts.pid) {
    return {
      check: 'dataDir', verdict: 'fail',
      read: t('doctorLockOther', { path, lock: lockPid, pid: facts.pid }),
      remedy: t('doctorLockOtherFix'),
    }
  }
  return { check: 'dataDir', verdict: 'ok', read: t('doctorDataDirOk', { path, pid: facts.pid }) }
}

/**
 * The card storage against its cap.
 *
 * Warned at nine tenths rather than at the cap: at the cap the card's next
 * write is already refused, and the point of a doctor is to say so before.
 * @param facts - the host's facts.
 * @returns the row, or undefined when the host composes no store.
 */
export function storageRow(facts: HostDoctorFacts): DoctorRow | undefined {
  if (facts.cardStorage === undefined) return undefined
  const { bytes, limit } = facts.cardStorage
  const read = t('doctorStorageRead', { used: size(bytes), limit: size(limit) })
  if (bytes >= limit * 0.9) {
    return { check: 'storage', verdict: 'warn', read, remedy: t('doctorStorageFullFix') }
  }
  return { check: 'storage', verdict: 'ok', read }
}

/**
 * The SillyTavern directory, when one is configured.
 * @param facts - the host's facts.
 * @returns the row.
 */
export function corpusRow(facts: HostDoctorFacts): DoctorRow {
  if (facts.corpusDir === undefined) {
    return { check: 'corpus', verdict: 'ok', read: t('doctorCorpusUnset') }
  }
  if (!facts.corpusDir.readable) {
    return {
      check: 'corpus', verdict: 'fail',
      read: t('doctorCorpusUnreadable', { path: facts.corpusDir.path }),
      remedy: t('doctorCorpusUnreadableFix'),
    }
  }
  return { check: 'corpus', verdict: 'ok', read: t('doctorCorpusOk', { path: facts.corpusDir.path }) }
}

/**
 * What a profile is called in a row.
 * @param profile - the profile.
 * @returns its label, or the summary the host derives when it has none.
 */
function profileName(profile: ConnectionProfile): string {
  return profile.label ?? profile.summary
}

/**
 * The provider in use, whether it answers, and the authoring model.
 * @param client - the doctor's client.
 * @returns up to three rows.
 */
export async function connectionRows(client: DoctorClient): Promise<DoctorRow[]> {
  let list: RpcResponse<'connection.list'>
  try {
    list = await client.call('connection.list', {})
  } catch (error: unknown) {
    return [{
      check: 'provider', verdict: 'fail',
      read: t('doctorUnreadable', { reason: reasonOf(error) }),
      remedy: t('doctorProviderMissingFix'),
    }]
  }
  const rows: DoctorRow[] = []
  const active = list.profiles.find(profile => profile.id === list.activeId)
  if (active === undefined) {
    rows.push({
      check: 'provider', verdict: 'fail',
      read: t('doctorProviderMissing'),
      remedy: t('doctorProviderMissingFix'),
    })
  } else {
    rows.push({
      check: 'provider', verdict: 'ok',
      read: t('doctorProviderInUse', { name: profileName(active), model: active.model }),
    })
    try {
      const probe = await client.call('connection.test', { profileId: active.id })
      rows.push(probe.ok
        ? { check: 'providerTest', verdict: 'ok', read: t('doctorProviderAnswered', { ms: probe.latencyMs }) }
        : {
            check: 'providerTest', verdict: 'fail',
            read: t('doctorProviderRefused', {
              reason: probe.error === undefined ? '?' : oneLine(`${probe.error.code}: ${probe.error.message}`, 200),
            }),
            remedy: t('doctorProviderRefusedFix'),
          })
    } catch (error: unknown) {
      rows.push({
        check: 'providerTest', verdict: 'fail',
        read: t('doctorUnreadable', { reason: reasonOf(error) }),
        remedy: t('doctorProviderRefusedFix'),
      })
    }
  }
  const authoring = list.authoring
  const writer = authoring === undefined ? undefined : list.profiles.find(profile => profile.id === authoring.id)
  if (authoring === undefined) {
    rows.push({
      check: 'authoring', verdict: 'warn',
      read: t('doctorAuthoringUnset'),
      remedy: t('doctorAuthoringUnsetFix'),
    })
  } else if (writer === undefined) {
    // The setting names a profile that is gone: the host refuses the entry for
    // the same reason it refuses an unset one, so the row says so.
    rows.push({
      check: 'authoring', verdict: 'warn',
      read: t('doctorAuthoringOrphan', { model: authoring.model }),
      remedy: t('doctorAuthoringUnsetFix'),
    })
  } else {
    rows.push({
      check: 'authoring', verdict: 'ok',
      read: t('doctorAuthoringSet', { model: authoring.model, name: profileName(writer) }),
    })
  }
  return rows
}

/**
 * The open card's script consent and network grant.
 * @param client - the doctor's client.
 * @param characterId - the open conversation's card.
 * @returns the row, or undefined when the conversation names no card.
 */
export async function consentRow(client: DoctorClient, characterId: string | undefined): Promise<DoctorRow | undefined> {
  if (characterId === undefined) return undefined
  let answer: RpcResponse<'script.list'>
  try {
    answer = await client.call('script.list', { characterId })
  } catch (error: unknown) {
    return { check: 'consent', verdict: 'warn', read: t('doctorUnreadable', { reason: reasonOf(error) }), remedy: t('doctorConsentAskFix') }
  }
  const n = answer.scripts.length
  if (n === 0) return { check: 'consent', verdict: 'ok', read: t('doctorConsentNone') }
  if (answer.scriptsAllowed === undefined) {
    return { check: 'consent', verdict: 'warn', read: t('doctorConsentUnasked', { n }), remedy: t('doctorConsentAskFix') }
  }
  if (!answer.scriptsAllowed) {
    return { check: 'consent', verdict: 'warn', read: t('doctorConsentDeclined', { n }), remedy: t('doctorConsentDeclinedFix') }
  }
  return {
    check: 'consent', verdict: 'ok',
    read: t(answer.networkGranted ? 'doctorConsentAllowedNet' : 'doctorConsentAllowed', { n }),
  }
}

/**
 * Faults the host is holding.
 *
 * Every held `fault`, not a time window: the buffer is in-process and empties
 * on restart, so "held" already means "since this host started", and a window
 * chosen here would hide the fault that happened an hour before the reader
 * thought to ask.
 * @param client - the doctor's client.
 * @returns the row.
 */
export async function faultsRow(client: DoctorClient): Promise<DoctorRow> {
  let answer: RpcResponse<'debug.reports'>
  try {
    answer = await client.call('debug.reports', {})
  } catch (error: unknown) {
    return { check: 'faults', verdict: 'warn', read: t('doctorUnreadable', { reason: reasonOf(error) }), remedy: t('doctorFaultsFix') }
  }
  const faults = answer.reports.filter(report => report.grade === 'fault')
  const newest = faults[faults.length - 1]
  if (newest === undefined) return { check: 'faults', verdict: 'ok', read: t('doctorFaultsNone') }
  return {
    check: 'faults', verdict: 'warn',
    read: t('doctorFaultsHeld', { n: faults.length, kind: newest.kind, message: oneLine(newest.message, 160) }),
    remedy: t('doctorFaultsFix'),
  }
}

/**
 * The system plugins that failed.
 * @param client - the doctor's client.
 * @returns the row.
 */
export async function pluginsRow(client: DoctorClient): Promise<DoctorRow> {
  let snapshot: RpcResponse<'plugin.list'>
  try {
    snapshot = await client.call('plugin.list', {})
  } catch (error: unknown) {
    return { check: 'plugins', verdict: 'warn', read: t('doctorUnreadable', { reason: reasonOf(error) }), remedy: t('doctorPluginsFix') }
  }
  const failed = snapshot.plugins.filter(plugin => plugin.status === 'error' || plugin.failure !== undefined)
  const installed = snapshot.plugins.filter(plugin => plugin.installed).length
  if (failed.length === 0) return { check: 'plugins', verdict: 'ok', read: t('doctorPluginsOk', { n: installed }) }
  const named = failed
    .map(plugin => `${plugin.name} (${oneLine(plugin.failure?.reason ?? plugin.error ?? plugin.status, 120)})`)
    .join('; ')
  return { check: 'plugins', verdict: 'fail', read: t('doctorPluginsFailed', { plugins: named }), remedy: t('doctorPluginsFix') }
}

/**
 * The card sandbox's build: the manifest, and the preset it names, served.
 *
 * The preset rather than every artifact because it is the one a card frame
 * cannot run without and the largest one a partial build would lose. Its name
 * is read from the manifest, never spelled here — the names carry content
 * hashes.
 * @param page - the page, for its fetch.
 * @returns the row.
 */
export async function sandboxRow(page: DoctorPage): Promise<DoctorRow> {
  const fail = (reason: string): DoctorRow => ({
    check: 'sandbox', verdict: 'fail', read: t('doctorSandboxBroken', { reason }), remedy: t('doctorSandboxFix'),
  })
  try {
    const manifest = await page.fetchText('/sandbox/manifest.json', 'GET')
    if (manifest.status !== 200) return fail(`/sandbox/manifest.json HTTP ${String(manifest.status)}`)
    const assets = parseSandboxManifest(manifest.body)
    if (typeof assets === 'string') return fail(assets)
    const preset = await page.fetchText(assets.messagePreset, 'HEAD')
    if (preset.status !== 200) return fail(`${assets.messagePreset} HTTP ${String(preset.status)}`)
    return { check: 'sandbox', verdict: 'ok', read: t('doctorSandboxOk', { preset: assets.messagePreset }) }
  } catch (error: unknown) {
    return fail(reasonOf(error))
  }
}

/**
 * The shell's Content-Security-Policy, in this document.
 * @param page - the page.
 * @returns the row.
 */
export function policyRow(page: DoctorPage): DoctorRow {
  return page.shellPolicy
    ? { check: 'policy', verdict: 'ok', read: t('doctorPolicyOk') }
    : { check: 'policy', verdict: 'warn', read: t('doctorPolicyMissing'), remedy: t('doctorPolicyMissingFix') }
}

/**
 * Run every check.
 *
 * The host facts are read first because four rows are about them; when that
 * read fails, the host row says why (an older host answers "no handler is
 * registered", which is itself the stale-build case seen from the other side)
 * and the four rows are left out rather than guessed. Every other row reads on
 * its own, so one refusal never silences the rest.
 * @param client - the doctor's client.
 * @param page - the page's own reading.
 * @returns the rows, in report order.
 */
export async function runDoctor(client: DoctorClient, page: DoctorPage): Promise<DoctorRow[]> {
  let facts: HostDoctorFacts | undefined
  let factsError: string | undefined
  try {
    facts = (await client.call('debug.doctor', {})).facts
  } catch (error: unknown) {
    factsError = reasonOf(error)
  }
  const [connection, consent, faults, sandbox, plugins] = await Promise.all([
    connectionRows(client),
    consentRow(client, page.characterId),
    faultsRow(client),
    sandboxRow(page),
    pluginsRow(client),
  ])
  const rows: DoctorRow[] = []
  if (facts === undefined) {
    rows.push({
      check: 'host', verdict: 'fail',
      read: t('doctorHostUnreadable', { reason: factsError ?? '?' }),
      remedy: t('doctorHostUnreadableFix'),
    })
  } else {
    rows.push({
      check: 'host', verdict: 'ok',
      read: t('doctorHostRead', { version: facts.irisVersion, node: facts.node, pid: facts.pid, port: page.port || '?' }),
    })
    rows.push(bundleRow(facts, page))
  }
  rows.push(...connection)
  if (consent !== undefined) rows.push(consent)
  if (facts !== undefined) rows.push(dataDirRow(facts))
  rows.push(faults, sandbox, policyRow(page), plugins)
  if (facts !== undefined) {
    const storage = storageRow(facts)
    if (storage !== undefined) rows.push(storage)
    rows.push(corpusRow(facts))
  }
  return rows
}

/**
 * The report as one notice: a count line, then a line per row.
 *
 * Raised as an **error** notice when any row failed, so it gets the longer
 * of the two lifetimes and the error colour a reader scans for; otherwise as
 * information.
 * @param rows - what `runDoctor` returned.
 * @returns the notice's kind and text.
 */
export function doctorReport(rows: readonly DoctorRow[]): { kind: 'info' | 'error', text: string } {
  const count = (verdict: DoctorVerdict): number => rows.filter(row => row.verdict === verdict).length
  const lines = [t('doctorHeading', { ok: count('ok'), warn: count('warn'), fail: count('fail') })]
  for (const row of rows) {
    const head = `${VERDICT_GLYPH[row.verdict]} ${t(CHECK_LABEL[row.check])}: ${row.read}`
    lines.push(row.remedy === undefined ? head : t('doctorRowWithRemedy', { row: head, remedy: row.remedy }))
  }
  return { kind: count('fail') > 0 ? 'error' : 'info', text: lines.join('\n') }
}
