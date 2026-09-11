/**
 * Saved connections: an endpoint, a model and a preset switched as a set.
 *
 * Kept in their own file rather than a section of `settings.json`, because the
 * two answer different questions: settings are *what this chat is using now*,
 * these are *the sets the user has put together*. Resetting one should not
 * empty the other.
 *
 * The one design rule here comes from a measurement rather than taste. Upstream
 * stores a display name generated at creation time from the values as they then
 * were, and the profile the user currently has selected is called
 * `deepseek deepseek-chat - Default` while pointing at a Gemini model on a
 * different endpoint with a different preset. So nothing derived is stored: a
 * profile keeps only the user's own words, and everything shown is computed from
 * the live values. A name that disagrees with its contents is not something to
 * be careful about — it is unrepresentable.
 *
 * @module @iris/app-service/connections
 */

import type { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

import type { ConnectionProfile, GenerationSettings, HostDefaultConnection, ModelContextLength } from '@iris/protocol'

import { atomicWriteFile, quarantineCorruptFile, readJsonStore } from './atomic.ts'
import { notFound } from './errors.ts'
import {
  DATA_KEY_BYTES,
  decryptValue,
  encryptValue,
  isEncryptedValue,
  protectorForKind,
  readKeyFile,
  wrapNewDataKey,
  writeKeyFile,
  type EncryptedValue,
  type KeyProtector,
} from './key-protection.ts'
import { sanitize } from './settings.ts'

/**
 * How much of a stored key a read may show.
 *
 * The tail is a convenience for the one question a user asks of a masked
 * field — "which of my keys is this?" — and a boundary: shorter than this,
 * showing four characters shows most of the key, so nothing is shown at all.
 */
export const KEY_TAIL_MIN_LENGTH = 8
/** How many trailing characters a masked key shows. */
export const KEY_TAIL_LENGTH = 4

/** A profile as it is stored: no derived values. */
interface StoredProfile {
  id: string
  label?: string
  provider: string
  model: string
  preset?: string
  sampling?: Partial<GenerationSettings>
  /** The endpoint this profile generates through. Absent rides the host's route. */
  baseURL?: string
  /**
   * The key as the user typed it — **in memory only**.
   *
   * Until 2026-09-11 this was the field the file carried, which is what
   * upstream still does (`src/endpoints/secrets.js:150`). It is now the
   * decrypted form of {@link apiKeyEnc}, written by `#load` and read by
   * `routeCredential`, `toWire`'s mask and the probe ladder; the serializer
   * deletes it, so the name cannot reach the file even by accident. Absent on a
   * row whose ciphertext this host could not open — which is why every reader
   * of it already treats absent as "no key", and why an unreadable key shows up
   * as a panel asking for it again rather than as a broken profile.
   */
  apiKey?: string
  /**
   * The key as the file carries it: AES-256-GCM under the profile's data key,
   * with this row's `id` as the additional authenticated data.
   *
   * Kept in memory beside the plaintext rather than re-derived on every write,
   * for two reasons that are both about *not* touching it: a save that changes
   * a label rewrites the file byte-identically where the key is concerned, and
   * a row whose ciphertext could not be opened travels through that same save
   * unchanged instead of being silently dropped by a serializer that only knew
   * how to write what it could read.
   */
  apiKeyEnc?: EncryptedValue
  /** The header the key is sent in. Absent means the OpenAI-compatible default. */
  apiKeyHeader?: string
  /**
   * The ids a successful probe of {@link baseURL} last reported.
   *
   * The one non-user, non-derived field in this file, and the module's opening
   * rule survives it: nothing *derived* is stored, and this is not derived —
   * it is an observation, kept with the moment it was made so it cannot be
   * mistaken for the present. Dropped whenever {@link baseURL} changes, because
   * a list from the endpoint this profile used to point at is not a stale
   * version of the truth, it is a different endpoint's answer.
   */
  models?: string[]
  /** Unix epoch milliseconds of the probe {@link models} came from. */
  modelsProbedAt?: number
  /**
   * What is known about those ids' context windows, keyed by id.
   *
   * Filed under the same rule as {@link models} and never separately: the two
   * are one observation of one endpoint, so a window record surviving a list
   * that was dropped for a moved base URL would describe models this profile
   * can no longer reach.
   */
  modelContexts?: Record<string, ModelContextLength>
}

/** The file's shape. */
interface ConnectionsFile {
  profiles: StoredProfile[]
  activeId?: string
}

/** What a caller may set. */
export interface ProfileInput {
  id?: string
  label?: string
  provider: string
  model: string
  preset?: string
  sampling?: Record<string, unknown>
  baseURL?: string
  /**
   * Write-only, with merge semantics the other fields do not have.
   *
   * Absent keeps whatever is stored — a caller editing a label cannot re-send
   * a key it was never shown. Empty string clears. Non-empty replaces.
   */
  apiKey?: string
  apiKeyHeader?: string
  /**
   * The model list a probe just reported, recorded on the profile.
   *
   * Merges like the key does — absent keeps what was recorded, because a caller
   * editing a label has no probe result to re-send. An empty array is a real
   * record ("probed, advertised nothing"), not a clear.
   */
  models?: string[]
  /**
   * What is known about those ids' context windows, keyed by id.
   *
   * Merges with {@link models} and never separately: the two are one
   * observation of one endpoint, and a window record surviving a list that was
   * dropped for a moved base URL would describe models this profile can no
   * longer reach.
   */
  modelContexts?: Record<string, ModelContextLength>
}

/**
 * The connection the host process was started with, as this runtime is told it.
 *
 * Preferably **handed in** by the composition, which is the one place that
 * decides what the host generates through. When it is not — and on the shipped
 * composition today it is not, because the `app` row carries no endpoint —
 * {@link hostConnectionFromEnv} reads the same variables that composition
 * reads, which makes it a second *reader* of one answer rather than a second
 * answer. `HOST_CONNECTION_ENV` names that coupling and a test holds it.
 *
 * `apiKey` stays inside the process — it is what a bare probe and an adoption
 * use, and it is never projected onto {@link hostDefaultView}.
 */
export interface HostConnection {
  /** The adapter route the composition registered. */
  provider: string
  /** The endpoint, when the host was configured with one. */
  baseURL?: string
  /** The model the host was configured with. */
  model?: string
  /** The credential the process holds, if any. **Never leaves the process.** */
  apiKey?: string
  /** The header it is sent in. Absent means `Authorization: Bearer`. */
  apiKeyHeader?: string
  /** The environment variable the key came from, for a form to name it by. */
  keyEnv?: string
}

/**
 * The environment variables the shipped composition configures the host's own
 * endpoint from.
 *
 * Named as a constant because this list is a **coupling to another file**:
 * `apps/iris/cordis.yml` reads exactly these three for its
 * `llm-openai-compat` row, and this module reads them only as a fallback for a
 * host that did not hand its connection in. A rename there with no rename here
 * would leave the panel quietly reporting a host default that is not the one
 * generating — so `tests/host-connection.test.ts` parses that file and holds
 * the two together, and the drift goes red instead of silent.
 */
export const HOST_CONNECTION_ENV = {
  baseURL: 'IRIS_BASE_URL',
  model: 'IRIS_MODEL',
  /** Not the key — the *name of the variable* holding it, which is the indirection upstream of the key. */
  keyEnv: 'IRIS_API_KEY_ENV',
} as const

/**
 * Read the host's own connection out of the environment, as a fallback.
 *
 * **The composition is the authority**; this is what a host that never told
 * this runtime what it generates through can still be asked. It reads the same
 * variables that composition reads, which is what makes it a second *reader*
 * rather than a second *answer*.
 *
 * `baseURL` stays absent when `IRIS_BASE_URL` is unset, rather than repeating
 * the composition's `http://127.0.0.1:11434/v1` default here: an absent
 * endpoint already means "rides the host's configured route" everywhere else in
 * this protocol, and a copied default is a constant that drifts.
 * @param env - the environment to read (`process.env` in the product).
 * @param route - the provider and model the settings layer already knows,
 * which is where the composition's own `provider` / `model` row landed.
 * @returns what the environment says the host is; the route alone when it says nothing.
 */
export function hostConnectionFromEnv(
  env: Record<string, string | undefined>,
  route: { provider: string, model: string },
): HostConnection {
  const baseURL = env[HOST_CONNECTION_ENV.baseURL]
  const keyEnv = env[HOST_CONNECTION_ENV.keyEnv]
  const apiKey = keyEnv === undefined || keyEnv.length === 0 ? undefined : env[keyEnv]
  return {
    provider: route.provider,
    model: route.model,
    ...baseURL === undefined || baseURL.length === 0 ? {} : { baseURL },
    ...apiKey === undefined || apiKey.length === 0 ? {} : { apiKey },
    ...keyEnv === undefined || keyEnv.length === 0 ? {} : { keyEnv },
  }
}

/**
 * Project what the browser may know about the host's own environment —
 * **the credential's origin and source, never the credential.**
 *
 * This used to project a *connection*: the route, the model and the model list
 * of the row the panel showed first, which a user could test, adopt and (host
 * §60) select. The user's ruling of 2026-09-10 retires that row, so what is
 * left is the one fact the provider editor still has to be able to say — the
 * process holds a key for this origin, so a provider saved with a blank key
 * there generates and probes anyway (§58's ladder, now a fallback rather than a
 * route). `provider`, `model` and the probe record went with the row: nothing
 * read them once the row was gone, and `HostProbeRecord` (the in-memory list a
 * bare probe of the host's endpoint filed) existed only to fill them.
 * @param host - what the composition told this runtime.
 * @returns the environment's endpoint and key *source*, never the key.
 */
export function hostDefaultView(host: HostConnection): HostDefaultConnection {
  const hasKey = host.apiKey !== undefined && host.apiKey.length > 0
  return {
    ...host.baseURL === undefined || host.baseURL.length === 0 ? {} : { baseURL: host.baseURL },
    keySource: hasKey ? 'env' : 'none',
    ...hasKey && host.keyEnv !== undefined && host.keyEnv.length > 0 ? { keyEnv: host.keyEnv } : {},
  }
}

/**
 * Whether two endpoints are the same place, for the purpose of reusing a key.
 *
 * Origin, not the full URL: `…/v1` and `…/v1/` and `…/v1beta/openai` are the
 * same host holding the same credential, and demanding a character-identical
 * base URL would refuse to reuse a key the user plainly meant. The path is
 * deliberately *not* compared — but the origin is, and that is the line that
 * matters: a stored key must never be sent to a **different** host because the
 * page asked for a bare probe of one.
 * @param left - one endpoint.
 * @param right - the other.
 * @returns true when both parse and share an origin.
 */
export function sameEndpointOrigin(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    // One of them is not a URL. Refusing is the safe direction: the question
    // this answers is "may this key go there", and "I could not tell" is no.
    return false
  }
}

/**
 * The credential a profile's route generates with, and where it came from.
 *
 * The profile's own key when it has one; otherwise the host's startup key,
 * **only** at the host's own origin ({@link sameEndpointOrigin}); otherwise
 * none. This is the same ladder `connection.test` climbs for a probe, and it
 * has to be: measured 2026-09-09, a same-origin profile saved with the key
 * field blank — which the form labels as "provided by the host environment,
 * leave blank to use it" — probed green and then generated with no
 * `Authorization` header, because activation installed the profile's own
 * credential only. A probe that passes with one key and a route that sends
 * another (or none) is a form that lies.
 *
 * The header travels with the key that won: a host key under a profile's
 * header, or the reverse, authenticates as neither. An empty stored key counts
 * as none — the form never writes one, but an imported file might.
 * @param profile - the profile being installed.
 * @param host - the host's own connection, credential included (in-process).
 * @returns the key and header to install, and the source to report — never the key itself in prose.
 */
export function routeCredential(
  profile: { baseURL?: string | undefined, apiKey?: string | undefined, apiKeyHeader?: string | undefined },
  host: Pick<HostConnection, 'baseURL' | 'apiKey' | 'apiKeyHeader'>,
): { apiKey?: string, apiKeyHeader?: string, keySource: 'stored' | 'host' | 'none' } {
  if (profile.apiKey !== undefined && profile.apiKey.length > 0) {
    return {
      apiKey: profile.apiKey,
      ...profile.apiKeyHeader === undefined || profile.apiKeyHeader.length === 0 ? {} : { apiKeyHeader: profile.apiKeyHeader },
      keySource: 'stored',
    }
  }
  if (host.apiKey !== undefined && host.apiKey.length > 0 && sameEndpointOrigin(host.baseURL, profile.baseURL)) {
    return {
      apiKey: host.apiKey,
      ...host.apiKeyHeader === undefined || host.apiKeyHeader.length === 0 ? {} : { apiKeyHeader: host.apiKeyHeader },
      keySource: 'host',
    }
  }
  return { keySource: 'none' }
}

/**
 * The last characters of a stored key, for the mask a form shows.
 * @param key - the stored key, or absent.
 * @returns the tail, or undefined when there is no key or it is too short to show one.
 */
export function keyTailOf(key: string | undefined): string | undefined {
  if (key === undefined || key.length < KEY_TAIL_MIN_LENGTH) return undefined
  return key.slice(-KEY_TAIL_LENGTH)
}

/**
 * Describe a profile from its current values.
 *
 * Computed on every read, never stored — this is the whole point. The moment
 * this became a field, it would start being true only of the values it was
 * written from.
 *
 * The endpoint rides in the summary as its origin, because for a profile that
 * carries one, **where it points is the truth the summary exists to tell** —
 * the measured failure this design answers is a profile whose name says one
 * provider and whose endpoint says another.
 * @param profile - the stored values.
 * @returns a one-line description of what the profile currently is.
 */
export function summarize(profile: StoredProfile): string {
  const parts = [profile.provider, profile.model]
  if (profile.preset !== undefined && profile.preset.length > 0) parts.push(profile.preset)
  if (profile.baseURL !== undefined && profile.baseURL.length > 0) {
    try {
      parts.push(new URL(profile.baseURL).origin)
    } catch {
      // Not a parseable URL — show it raw rather than hide where it points.
      parts.push(profile.baseURL)
    }
  }
  return parts.join(' · ')
}

/** Project a stored profile onto the wire shape. **Never carries the key.** */
function toWire(profile: StoredProfile): ConnectionProfile {
  const tail = keyTailOf(profile.apiKey)
  return {
    id: profile.id,
    ...profile.label === undefined ? {} : { label: profile.label },
    summary: summarize(profile),
    provider: profile.provider,
    model: profile.model,
    ...profile.preset === undefined ? {} : { preset: profile.preset },
    ...profile.sampling === undefined ? {} : { sampling: profile.sampling },
    ...profile.baseURL === undefined ? {} : { baseURL: profile.baseURL },
    ...profile.apiKey === undefined ? {} : { hasKey: true },
    ...tail === undefined ? {} : { keyTail: tail },
    ...profile.apiKeyHeader === undefined ? {} : { apiKeyHeader: profile.apiKeyHeader },
    // The list travels as it was recorded, timestamp included. Sending one
    // without the other would hand a picker a list it cannot date, which is
    // the shape that turns an observation into a claim.
    ...profile.models === undefined ? {} : { models: [...profile.models] },
    ...profile.modelsProbedAt === undefined ? {} : { modelsProbedAt: profile.modelsProbedAt },
    ...profile.modelContexts === undefined ? {} : { modelContexts: { ...profile.modelContexts } },
  }
}

/**
 * Where the wrapped data key sits, given where the profiles sit.
 *
 * Beside them, under the store's own name with a different extension, rather
 * than a second entry in `paths.ts`: it is not a store — nothing else reads it,
 * it has no shape a future feature would want, and a profile directory listing
 * should say plainly which file belongs to which. Derived rather than passed so
 * a test that points a store at a temporary directory cannot forget it.
 * @param storePath - the connections file.
 * @returns the key file beside it.
 */
export function keyFilePathFor(storePath: string): string {
  return `${storePath.replace(/\.json$/u, '')}.key`
}

/** The seams and the one real option {@link ConnectionStore} takes. */
export interface ConnectionStoreOptions {
  /**
   * Stands in for the operating system's key store.
   *
   * Production passes none and the platform decides
   * ({@link wrapNewDataKey} / {@link protectorForKind}). Every test that is not
   * *about* DPAPI passes a deterministic fake, because a suite that spawns a
   * PowerShell per case would be measuring Windows rather than this store.
   */
  protector?: KeyProtector
  /**
   * Told once when something was **done** rather than when something failed —
   * today, only the migration of plaintext keys. Absent means silence.
   *
   * Apart from `onProblem` because the two are different acts: a note is the
   * host saying what it did on the user's behalf, and filing it as a fault
   * would put a successful upgrade in the same list as an unreadable key.
   */
  onNote?: (message: string) => void
  /** Stands in for `process.platform` when a data key is created. */
  platform?: string
  /** Stands in for `child_process.spawn`; production code never passes one. */
  spawn?: typeof spawn
}

/** Reads and persists the user's saved connections. */
export class ConnectionStore {
  readonly #path: string
  readonly #keyPath: string
  readonly #onProblem: ((message: string) => void) | undefined
  readonly #options: ConnectionStoreOptions
  #file: ConnectionsFile = { profiles: [] }
  #loading: Promise<void> | undefined
  /** The opened data key, once something has needed it. */
  #dataKey: Uint8Array | undefined
  /**
   * How the data key stands.
   *
   * `absent` and `refused` are the two the first draft of this collapsed, and a
   * test caught it in the minute it took to run: **no key file is a first run**
   * — the state every install and every migration starts in — while a key file
   * that will not open is an incident. Collapsed, the ordinary first save
   * reported a fault about a missing file and then a second one about replacing
   * it.
   */
  #keyState: 'unknown' | 'absent' | 'open' | 'refused' = 'unknown'
  /** Why the stored data key would not open, when it would not. */
  #keyRefused: string | undefined
  /** So a store with several sealed rows and no key file says it once. */
  #saidKeyFileMissing = false

  /**
   * @param path - the JSON file backing the store.
   * @param onProblem - told when the file was there and could not be parsed
   *   (see {@link readJsonStore}), and when a stored key could not be read.
   *   Absent means silence.
   * @param options - the protector seam and the note channel.
   */
  constructor(path: string, onProblem?: (message: string) => void, options: ConnectionStoreOptions = {}) {
    this.#path = path
    this.#keyPath = keyFilePathFor(path)
    this.#onProblem = onProblem
    this.#options = options
  }

  /**
   * Load on first use; a missing file is an empty list.
   *
   * **The sharpest case for quarantining.** The load is attempted exactly once,
   * so a file that failed to parse is never retried, and the first
   * `connection.save` after the failure used to write an empty list over every
   * profile the user had — their endpoints and their API keys, with nothing
   * left to recover from. The bytes now move aside before that can happen.
   *
   * The *promise* is what is memoised, not a flag set before the read. With a
   * flag, a second caller arriving during the read — which is the ordinary boot
   * now that opening the data key can cost a PowerShell spawn — sailed past an
   * empty list and could write it back; with this, it waits for the same load
   * and the once-only property is unchanged.
   */
  async #load(): Promise<void> {
    this.#loading ??= this.#loadOnce()
    return this.#loading
  }

  /** The body of {@link #load}, run once per store. */
  async #loadOnce(): Promise<void> {
    const parsed = await readJsonStore(this.#path, this.#onProblem) as Partial<ConnectionsFile> | undefined
    if (!Array.isArray(parsed?.profiles)) return
    this.#file = {
      profiles: parsed.profiles,
      ...typeof parsed.activeId === 'string' ? { activeId: parsed.activeId } : {},
    }
    await this.#adoptKeys()
  }

  /**
   * Bring every row's key into memory, and get the plaintext off the disk.
   *
   * Four states per row, and each gets its own answer rather than a shared
   * `catch`:
   *
   * - **encrypted** — opened with the data key, or reported and left absent, so
   *   the panel asks for it again instead of a profile silently generating with
   *   nothing;
   * - **encrypted *and* plaintext** — the encrypted one wins and the plaintext
   *   is dropped, reported, because a plaintext key beside a ciphertext is
   *   either a half-finished hand edit or someone trying the downgrade;
   * - **plaintext only** — the file from before 2026-09-11. Adopted and
   *   rewritten *now*, not at the next save, because "the next save" on a host
   *   that is only ever read is never;
   * - **an envelope this build cannot read** — left exactly as it is. A newer
   *   build wrote it, and dropping it would destroy a key to make a display
   *   tidier.
   */
  async #adoptKeys(): Promise<void> {
    let migrated = 0
    let rewrite = false
    for (const row of this.#file.profiles) {
      const sealed: unknown = row.apiKeyEnc
      if (sealed === undefined) {
        // The file from before 2026-09-11, or a row that never had a key.
        if (typeof row.apiKey !== 'string' || row.apiKey.length === 0) {
          delete row.apiKey
          continue
        }
        // `rewrite` is not set beside this: a migration is already a reason to
        // write, and setting both would have made one of the two unfalsifiable
        // — which is exactly what a mutation of it showed, staying green.
        migrated += 1
        continue
      }
      if (row.apiKey !== undefined) {
        // Dropped **here**, before the decrypt below can overwrite it, and not
        // left to that overwrite: when the data key will not open, the decrypt
        // never runs, and a plaintext left standing would be adopted as the
        // key and then sealed by the next save — a downgrade arriving through
        // the one path that is supposed to refuse them.
        delete row.apiKey
        rewrite = true
        this.#onProblem?.(`connection profile "${row.id}" carried a plaintext key beside its encrypted one;`
          + ` the encrypted key was kept and the plaintext dropped (${this.#path})`)
      }
      if (!isEncryptedValue(sealed)) {
        this.#onProblem?.(`the stored key of connection profile "${row.id}" is in an envelope this build`
          + ` cannot read; it is kept as it is and reads as absent (${this.#path})`)
        continue
      }
      const key = await this.#openDataKey()
      if (key === undefined) {
        // `refused` has already said its piece, once, with the reason. This is
        // the other way a sealed row has nothing to open it: the key file is
        // gone while the ciphertexts are not, which a half-restored backup and
        // a sync client carrying only `*.json` both produce.
        if (this.#keyState === 'absent' && !this.#saidKeyFileMissing) {
          this.#saidKeyFileMissing = true
          this.#onProblem?.(`${this.#keyPath} is missing while stored connection keys are encrypted with it;`
            + ' every one of them reads as absent and the panel will ask for them again')
        }
        continue
      }
      try {
        row.apiKey = decryptValue(key, row.id, sealed)
      } catch (error: unknown) {
        this.#onProblem?.(`the stored key of connection profile "${row.id}" could not be decrypted`
          + ` (${error instanceof Error ? error.message : String(error)});`
          + ' it reads as absent and the panel will ask for it again')
      }
    }
    if (rewrite || migrated > 0) await this.#save()
    if (migrated > 0) {
      this.#options.onNote?.(`${String(migrated)} connection key(s) were encrypted at rest;`
        + ` the plaintext is gone from ${this.#path}`)
    }
  }

  /**
   * The data key, opened once — or `undefined`, once, with a reason reported.
   *
   * **No downgrade lives here.** A key file naming `dpapi` is opened by DPAPI
   * or not at all: a machine that cannot is a different account, a different
   * machine or a tampered file, and each of those is a thing to say out loud.
   * Answering it by writing a `file`-kind key instead would turn the one
   * detection this design has into a silent weakening.
   *
   * A key file that is simply **not there** is not a refusal and reports
   * nothing: that is a first run, and it is the caller finding a sealed row
   * with no key to open it that has something to say.
   * @returns the raw bytes, or `undefined` when they cannot be had.
   */
  async #openDataKey(): Promise<Uint8Array | undefined> {
    if (this.#keyState === 'open') return this.#dataKey
    if (this.#keyState !== 'unknown') return undefined
    try {
      const file = await readKeyFile(this.#keyPath)
      if (file === undefined) {
        this.#keyState = 'absent'
        return undefined
      }
      const protector = this.#options.protector ?? protectorForKind(file.kind, this.#options.spawn)
      const opened = await protector.unwrap(file.wrapped)
      if (opened.length !== DATA_KEY_BYTES) {
        throw new Error(`it unwrapped to ${String(opened.length)} bytes, not ${String(DATA_KEY_BYTES)}`)
      }
      this.#dataKey = opened
      this.#keyState = 'open'
      return opened
    } catch (error: unknown) {
      this.#keyState = 'refused'
      this.#keyRefused = error instanceof Error ? error.message : String(error)
      this.#onProblem?.(`${this.#keyPath} could not be unwrapped (${this.#keyRefused});`
        + ' every stored connection key reads as absent and the panel will ask for them again.'
        + ' The key file and the encrypted keys were kept, not replaced')
      return undefined
    }
  }

  /**
   * The data key to encrypt with, minting and wrapping one if there is none.
   *
   * The refused case is the interesting one. The keys under the old data key
   * are unreadable on this machine for good — that is what DPAPI's account
   * binding *is* — so a user who answers the panel's request by typing a key
   * again must get a working store out of it, or the documented recovery is not
   * a recovery. The old wrapped key is therefore **set aside, never deleted**,
   * under the same idiom a file that would not parse gets, and the rows sealed
   * against it travel on untouched and keep reading as absent.
   * @returns the raw bytes; a wrap failure throws rather than storing plaintext.
   */
  async #dataKeyForWrite(): Promise<Uint8Array> {
    const opened = await this.#openDataKey()
    if (opened !== undefined) return opened

    // Only a *refused* key is set aside. An absent one is the first save of a
    // new profile, and there is nothing to keep.
    const stale = this.#keyState === 'refused' ? this.#keyRefused : undefined
    const created = randomBytes(DATA_KEY_BYTES)
    const wrapped = this.#options.protector === undefined
      ? await wrapNewDataKey(created, {
        ...this.#options.platform === undefined ? {} : { platform: this.#options.platform },
        ...this.#options.spawn === undefined ? {} : { spawnFn: this.#options.spawn },
        ...this.#onProblem === undefined ? {} : { onWarn: this.#onProblem },
      })
      : { kind: this.#options.protector.kind, wrapped: await this.#options.protector.wrap(created) }

    await mkdir(dirname(this.#keyPath), { recursive: true })
    if (stale !== undefined) {
      const kept = await quarantineCorruptFile(this.#keyPath, new Date(), 'unreadable')
      this.#onProblem?.(`a new connection data key was created because the old one could not be opened;`
        + ` the old one was ${kept === undefined ? 'left in place and overwritten' : `kept as ${kept}`}`
        + ' and the keys stored under it stay unreadable')
    }
    await writeKeyFile(this.#keyPath, wrapped)
    this.#dataKey = created
    this.#keyState = 'open'
    this.#keyRefused = undefined
    return created
  }

  /**
   * The file's rows: every plaintext key sealed, and the field name gone.
   *
   * A row is encrypted **only** when it has a plaintext key and no ciphertext
   * for it, which is exactly a key the user just typed or one being migrated.
   * Everything else is carried through byte for byte — including a ciphertext
   * this host could not open, which is the whole of "a save must not destroy
   * what it could not read".
   * @returns rows safe to write.
   */
  async #rowsForFile(): Promise<StoredProfile[]> {
    const rows: StoredProfile[] = []
    for (const profile of this.#file.profiles) {
      if (profile.apiKey !== undefined && profile.apiKey.length > 0 && profile.apiKeyEnc === undefined) {
        profile.apiKeyEnc = encryptValue(await this.#dataKeyForWrite(), profile.id, profile.apiKey)
      }
      const row: StoredProfile = { ...profile }
      // `delete` rather than building the row field by field: the fields here
      // grow, and a serializer that lists them is one merge away from dropping
      // a new one silently. This way the one field that must never be written
      // is the one field named.
      delete row.apiKey
      rows.push(row)
    }
    return rows
  }

  /** Persist the file, creating its directory on a first run. */
  async #save(): Promise<void> {
    const rows = await this.#rowsForFile()
    await mkdir(dirname(this.#path), { recursive: true })
    await atomicWriteFile(this.#path, `${JSON.stringify({
      profiles: rows,
      ...this.#file.activeId === undefined ? {} : { activeId: this.#file.activeId },
    }, null, 2)}\n`)
  }

  /**
   * Every saved profile, with its summary derived fresh.
   * @returns the profiles and which one was last activated.
   */
  async list(): Promise<{ profiles: ConnectionProfile[], activeId?: string }> {
    await this.#load()
    return {
      profiles: this.#file.profiles.map(toWire),
      ...this.#file.activeId === undefined ? {} : { activeId: this.#file.activeId },
    }
  }

  /**
   * Create a profile, or replace one by id.
   * @param input - the values to store; anything derived is not among them.
   * @returns the profiles after the change.
   * @throws {AppError} `invalid-request` when the sampling block is malformed.
   */
  async save(input: ProfileInput): Promise<{ profiles: ConnectionProfile[], activeId?: string }> {
    await this.#load()

    // Sampling goes through the same validation a settings patch does, so a
    // profile cannot store a temperature that `settings.set` would refuse.
    const sampling = input.sampling === undefined ? undefined : sanitize(input.sampling).set

    const stored: StoredProfile = {
      id: input.id ?? randomUUID(),
      ...input.label === undefined || input.label.length === 0 ? {} : { label: input.label },
      provider: input.provider,
      model: input.model,
      ...input.preset === undefined || input.preset.length === 0 ? {} : { preset: input.preset },
      ...sampling === undefined || Object.keys(sampling).length === 0 ? {} : { sampling },
      ...input.baseURL === undefined || input.baseURL.length === 0 ? {} : { baseURL: input.baseURL },
      ...input.apiKeyHeader === undefined || input.apiKeyHeader.length === 0
        ? {}
        : { apiKeyHeader: input.apiKeyHeader },
    }

    // The key is the one field that merges. Every read withholds it, so a
    // caller replacing a profile cannot send it back — treating absent as
    // "clear it" would silently disarm a profile whose label someone edited.
    // `''` is the explicit clear; anything else replaces.
    // The ciphertext travels with the plaintext, and on its own when there is
    // no plaintext to travel with: a row whose key this host could not open is
    // still that row's key, and an edit of its label must not be the act that
    // throws it away. A *new* key carries no ciphertext forward — the
    // serializer seals it, which is also what gives it a fresh nonce.
    const at = this.#file.profiles.findIndex(profile => profile.id === stored.id)
    const previous = at === -1 ? undefined : this.#file.profiles[at]
    if (input.apiKey === undefined) {
      if (previous?.apiKey !== undefined) stored.apiKey = previous.apiKey
      if (previous?.apiKeyEnc !== undefined) stored.apiKeyEnc = previous.apiKeyEnc
    } else if (input.apiKey.length > 0) {
      stored.apiKey = input.apiKey
    }

    // The recorded model list merges like the key, and for the same reason —
    // the caller editing a label has no probe result in hand. The one case that
    // is *not* a merge is a moved endpoint: a list recorded against the old
    // base URL describes a different server, so it goes rather than becoming a
    // set of model names this profile will never be able to reach.
    if (input.models !== undefined) {
      stored.models = [...input.models]
      stored.modelsProbedAt = Date.now()
      if (input.modelContexts !== undefined) stored.modelContexts = { ...input.modelContexts }
    } else if (previous?.models !== undefined && sameEndpointOrigin(previous.baseURL, stored.baseURL)) {
      stored.models = previous.models
      if (previous.modelsProbedAt !== undefined) stored.modelsProbedAt = previous.modelsProbedAt
      if (previous.modelContexts !== undefined) stored.modelContexts = previous.modelContexts
    }

    if (at === -1) this.#file.profiles.push(stored)
    else this.#file.profiles[at] = stored

    await this.#save()
    return this.list()
  }

  /**
   * Record what a probe of a profile's endpoint just reported.
   *
   * Its own method rather than a `save` call, because `save` replaces a whole
   * profile from a caller's values and a probe has none of them: routing this
   * through `save` would mean the probe path had to re-send the label, preset
   * and sampling it was never given, and getting that wrong would silently
   * blank a field.
   *
   * A profile that has since been deleted is not an error — the probe answered
   * a question about an endpoint, and the answer having nowhere to be filed is
   * not a failure of the probe.
   * @param id - the profile the probe was pointed at.
   * @param models - the ids it reported, possibly empty.
   * @param modelContexts - what is known about those ids' windows, when anything is.
   */
  async recordModels(
    id: string,
    models: readonly string[],
    modelContexts?: Record<string, ModelContextLength>,
  ): Promise<void> {
    await this.#load()
    const found = this.#file.profiles.find(profile => profile.id === id)
    if (found === undefined) return
    found.models = [...models]
    found.modelsProbedAt = Date.now()
    // Replaced, not merged: this probe's answer is the whole of what the
    // endpoint now says, and an id it no longer lists keeping a window from an
    // older probe would leave a record of a model that is gone.
    if (modelContexts === undefined) delete found.modelContexts
    else found.modelContexts = { ...modelContexts }
    await this.#save()
  }

  /**
   * Remove a profile.
   * @param id - which one.
   * @returns the profiles after the change.
   * @throws {AppError} `not-found` when no profile has that id.
   */
  async delete(id: string): Promise<{ profiles: ConnectionProfile[], activeId?: string }> {
    await this.#load()
    const at = this.#file.profiles.findIndex(profile => profile.id === id)
    if (at === -1) throw notFound(`no connection profile "${id}"`)

    this.#file.profiles.splice(at, 1)
    // The active id is cleared with it: pointing at a profile that is gone would
    // make the next read report an active connection nobody can inspect.
    if (this.#file.activeId === id) delete this.#file.activeId
    await this.#save()
    return this.list()
  }

  /**
   * The stored values of one profile, for activation.
   * @param id - which one.
   * @returns the stored profile.
   * @throws {AppError} `not-found` when no profile has that id.
   */
  async get(id: string): Promise<StoredProfile> {
    await this.#load()
    const found = this.#file.profiles.find(profile => profile.id === id)
    if (found === undefined) throw notFound(`no connection profile "${id}"`)
    return found
  }

  /**
   * Record which profile was last applied.
   * @param id - the profile.
   */
  async markActive(id: string): Promise<void> {
    await this.#load()
    this.#file.activeId = id
    await this.#save()
  }

  /*
   * `clearActive()` stood here, one day: the other half of `markActive`, added
   * so 「宿主环境」 could be selected back (host §60). Nothing can ask for "no
   * profile applied" any more — the environment is not a connection a person
   * chooses (host §61) — so the only way `activeId` becomes absent is the
   * deletion of the profile it named, which `delete` above does inline. A
   * setter with no caller is a state the product cannot reach, kept alive by a
   * test.
   */

  /**
   * The settings patch that applying a profile amounts to.
   * @param profile - the stored profile.
   * @param route - the provider route the patch should name, when it differs
   * from the profile's own (a profile with an endpoint of its own is served
   * by a runtime-installed adapter, not the route its `provider` was named for).
   * @returns a patch for `SettingsStore.set`.
   */
  static patchOf(profile: StoredProfile, route?: string): Record<string, unknown> {
    const patch = { provider: profile.provider, model: profile.model, ...profile.sampling }
    // The runtime-installed route wins over anything a sampling block carried:
    // the adapter registered for it is the one that can actually reach this
    // profile's endpoint.
    return route === undefined ? patch : { ...patch, provider: route }
  }
}

/**
 * The adapter route a profile is served through once activated.
 *
 * A profile carrying its own endpoint cannot generate through `default`: that
 * route belongs to the composition's own adapter registration, which this
 * runtime neither owns nor may displace. Everything else generates through
 * the route its provider names — presets install there on activation, and two
 * profiles of one provider take turns by replacing that registration.
 * @param profile - the stored profile (the id matters only for the derived route).
 * @returns the route key to install an adapter under and to write into settings.
 */
export function routeOf(
  profile: Pick<StoredProfile, 'id' | 'provider' | 'model'> & { baseURL?: string | undefined },
): string {
  if (profile.baseURL === undefined || profile.baseURL.length === 0) return profile.provider
  return profile.provider === 'default' ? `conn/${profile.id}` : profile.provider
}
