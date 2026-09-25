/**
 * Where a conversation's sandbox plugins live: `<profile>/sandbox-plugins/<chatId>.json`.
 *
 * One file per conversation rather than a directory per conversation — which is
 * what `cache-trace/<chatId>/` next door does — because that store rotates by
 * sequence and this one does not: a confirmation changes the version table and
 * the authorisation list **together**, and two files would have a moment where
 * one had landed and the other had not (`docs/SANDBOX-PLUGINS.md` §10.1).
 *
 * Three rules this module exists to keep, each of which has a test whose
 * mutation is written down in the ledger:
 *
 * - **`fileFor` is how a chat id becomes a path.** The same whitelist and the
 *   same resolve-then-contain check a chat file's own name goes through. An id
 *   reaches this process from a browser.
 * - **A schema version it does not know quarantines the whole file.** Not a
 *   migration, not a best-effort read of the rows it does understand: *what gets
 *   parsed here gets executed*, so "I understood most of it" is a sentence about
 *   which code the player authorised.
 * - **A deleted conversation's file goes.** Chat ids are minted against the
 *   files that exist, so a deleted id can be handed to the next conversation of
 *   the same name — and a leftover sidecar would have that new conversation open
 *   with a stranger's plugins already authorised. `cache-trace` has this hole
 *   today and its cost there is a stale diagnostic file; here the cost is
 *   execution (§10.3).
 *
 * **Durability is not promised.** `atomicWriteFile` issues no `fsync`, on
 * purpose, so a power cut guarantees the *old* file and not the new one. "Your
 * plugin is still there next time" is this feature's selling point, and the gap
 * between a selling point and a guarantee is written down here and in the
 * ledger rather than discovered.
 *
 * @module @iris/app-service/sandbox-plugins/store
 */
import { createHash } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  SANDBOX_PLUGIN_FACADE_VERSION,
  SANDBOX_PLUGIN_QUOTAS,
  SANDBOX_PLUGIN_SIDECAR_VERSION,
  type SandboxPluginDeclaration,
  type SandboxPluginFailureState,
  type SandboxPluginView,
  type SandboxPluginVersionView,
} from '@iris/protocol'

import { atomicWriteFile, quarantineCorruptFile, readJsonStore } from '../atomic.ts'
import { fileFor } from '../paths.ts'

/** One version of one plugin, as the sidecar stores it. */
export interface SandboxPluginVersionRecord {
  readonly version: number
  readonly name: string
  readonly purpose: string
  readonly declares: readonly SandboxPluginDeclaration[]
  /**
   * The source, as authored.
   *
   * **The one field that never reaches a `list` answer.** The wire projection
   * ({@link viewOf}) leaves it out, and what the shell is given to mount with is
   * a separate, narrower array holding only the plugins that are actually going
   * to run.
   */
  readonly code: string
  /** UTF-8 byte count of {@link code}. */
  readonly bytes: number
  /** First 12 hex of the source's sha256. The unit an authorisation is recorded in. */
  readonly hash: string
  /** The player's sentence, verbatim. */
  readonly prompt: string
  readonly authored: { readonly connectionId: string, readonly model: string, readonly at: number }
  /**
   * Which facade this version was written against (`SANDBOX_PLUGIN_FACADE_VERSION`).
   *
   * Stamped by the host at define time and never taken from the model's
   * output: the model cannot know which build will mount it, and a field it
   * could set would be a field it could set to "compatible". Absent on
   * versions written before the stamp existed, which reads as 1 — the only
   * facade that had shipped then ({@link facadeOf}).
   */
  readonly facade?: number
}

/**
 * The facade a version targets, with absence read as 1.
 * @param version - the stored version.
 * @returns its facade number.
 */
export function facadeOf(version: SandboxPluginVersionRecord): number {
  return version.facade ?? 1
}

/**
 * Whether this build can mount a version, judged by its facade stamp alone.
 *
 * Newer is refused; older and equal mount. The facade grows by addition and a
 * member a build lacks reads as `undefined`, so a lower stamp is code written
 * against a subset of what is here. A higher one may call a member that was
 * renamed or removed in between, and the honest answer is a named state, not
 * `mount-failed` on whichever member it reaches first.
 * @param version - the stored version.
 * @returns whether the stamp is within this build's facade.
 */
export function facadeMounts(version: SandboxPluginVersionRecord): boolean {
  return facadeOf(version) <= SANDBOX_PLUGIN_FACADE_VERSION
}

/** One plugin's whole state in one conversation. */
export interface SandboxPluginRecord {
  readonly id: string
  /** Append-only, oldest first; the current version is the last. */
  readonly versions: readonly SandboxPluginVersionRecord[]
  readonly enabled: boolean
  readonly trustFutureVersions: boolean
  /** Hashes a single tick has authorised. */
  readonly authorizedHashes: readonly string[]
  /** Which conversation this row was copied out of, when it was branched. */
  readonly branchedFrom?: string
  readonly failure?: { readonly state: SandboxPluginFailureState, readonly detail: string, readonly at: number }
}

/** What one file holds. */
interface SandboxPluginFile {
  readonly version: number
  readonly chatId: string
  readonly characterId: string
  readonly plugins: readonly SandboxPluginRecord[]
}

/** What the shell needs to actually mount one plugin. */
export interface SandboxPluginMount {
  readonly pluginId: string
  readonly version: number
  readonly code: string
}

/** The seams this store takes. */
export interface SandboxPluginStoreOptions {
  /** Told when a file was there and could not be read; see `readJsonStore`. */
  onProblem?: (message: string) => void
  /** The clock, so a test can pin a quarantine's name. */
  now?: () => Date
}

/**
 * The sha the authorisation is recorded against.
 * @param code - the source.
 * @returns the first 12 hex of its sha256.
 */
export function hashOfPluginCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 12)
}

/**
 * Whether the record's current version may mount.
 *
 * Two ways in, and they are not the same promise: a double tick trusts the
 * **position** for ever, a single tick trusts **these bytes** (§4.1). Asking the
 * question in one place is what stops the panel and the mount path disagreeing
 * about whether something is waiting for the player.
 * @param record - the plugin.
 * @returns whether the last version is authorised.
 */
export function isPluginAuthorized(record: SandboxPluginRecord): boolean {
  const current = record.versions.at(-1)
  if (current === undefined) return false
  return record.trustFutureVersions || record.authorizedHashes.includes(current.hash)
}

/**
 * Project a version for the wire.
 * @param version - the stored version.
 * @returns the view, without `code`.
 */
function versionViewOf(version: SandboxPluginVersionRecord): SandboxPluginVersionView {
  return {
    version: version.version,
    name: version.name,
    purpose: version.purpose,
    declares: version.declares,
    bytes: version.bytes,
    hash: version.hash,
    prompt: version.prompt,
    authored: version.authored,
  }
}

/**
 * Project a record for the wire.
 * @param record - the stored plugin.
 * @returns the view.
 */
export function viewOf(record: SandboxPluginRecord): SandboxPluginView {
  const current = record.versions.at(-1)
  /*
   * `facade-mismatch` is derived, not stored: it is a fact about this build and
   * that version together, so it appears on an older build and disappears after
   * an upgrade without anything being written. It outranks a stored failure,
   * because it is the reason nothing will be mounted now.
   */
  const mismatch = current !== undefined && !facadeMounts(current)
    ? {
      state: 'facade-mismatch' as const,
      detail: `version ${String(current.version)} was written for plugin facade ${String(facadeOf(current))}, and`
        + ` this Iris hands over facade ${String(SANDBOX_PLUGIN_FACADE_VERSION)} — it is not mounted here`,
      at: 0,
    }
    : undefined
  const failure = mismatch ?? record.failure
  return {
    id: record.id,
    versions: record.versions.map(versionViewOf),
    enabled: record.enabled,
    trustFutureVersions: record.trustFutureVersions,
    authorized: isPluginAuthorized(record),
    ...record.branchedFrom === undefined ? {} : { branchedFrom: record.branchedFrom },
    ...failure === undefined ? {} : { failure },
  }
}

/**
 * The plugins of a conversation that are going to run, with their source.
 *
 * **A separate, narrower array rather than a field on {@link SandboxPluginView}.**
 * The design forbids `code` on the view (§10.2) and the shell still has to have
 * it, because the shell is what posts `plugin:mount` into the frame. Narrowing
 * it to "enabled and authorised" is what makes the two statements compatible: a
 * plugin waiting for a confirmation, or switched off, hands the browser nothing.
 * @param records - a conversation's plugins.
 * @returns what to mount, in the order §9 mounts them.
 */
export function mountsOf(records: readonly SandboxPluginRecord[]): SandboxPluginMount[] {
  const out: SandboxPluginMount[] = []
  for (const record of records) {
    if (!record.enabled) continue
    if (!isPluginAuthorized(record)) continue
    const current = record.versions.at(-1)
    if (current === undefined) continue
    // Refused by name in the view (`facade-mismatch`); here it simply is not
    // handed to the frame, so nothing reaches `new Function` that this build's
    // facade was not written for.
    if (!facadeMounts(current)) continue
    out.push({ pluginId: record.id, version: current.version, code: current.code })
  }
  // Lexicographic by id, the order §9 fixes. Sorted here as well as in the shell
  // because a consumer that gets the set from the host should not have to know
  // that the order is a rule rather than an accident.
  return out.sort((left, right) => (left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0))
}

/**
 * Read one plugin out of a parsed file, dropping anything malformed.
 *
 * Shape validation lives here rather than in `readJsonStore`, which answers
 * `unknown` on purpose. A row that does not read as a plugin is dropped rather
 * than defaulted: a "plugin" assembled out of defaults would be a row with an
 * id, no code and an authorisation.
 * @param value - one element of the stored array.
 * @returns the record, or undefined.
 */
function readRecord(value: unknown): SandboxPluginRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const id = row['id']
  const versions = row['versions']
  if (typeof id !== 'string' || id.length === 0 || !Array.isArray(versions)) return undefined
  const kept: SandboxPluginVersionRecord[] = []
  for (const entry of versions) {
    if (entry === null || typeof entry !== 'object') continue
    const version = entry as Record<string, unknown>
    const code = version['code']
    const number = version['version']
    const hash = version['hash']
    if (typeof code !== 'string' || typeof number !== 'number' || typeof hash !== 'string') continue
    const authored = version['authored']
    const facade = version['facade']
    kept.push({
      // Kept only when it is a positive integer. Anything else is dropped to
      // "absent", which reads as 1 — the same as a version from before stamps.
      ...typeof facade === 'number' && Number.isInteger(facade) && facade >= 1 ? { facade } : {},
      version: number,
      name: typeof version['name'] === 'string' ? version['name'] : '',
      purpose: typeof version['purpose'] === 'string' ? version['purpose'] : '',
      declares: Array.isArray(version['declares']) ? version['declares'] as SandboxPluginDeclaration[] : [],
      code,
      bytes: typeof version['bytes'] === 'number' ? version['bytes'] : Buffer.byteLength(code, 'utf8'),
      hash,
      prompt: typeof version['prompt'] === 'string' ? version['prompt'] : '',
      authored: authored !== null && typeof authored === 'object'
        ? authored as SandboxPluginVersionRecord['authored']
        : { connectionId: '', model: '', at: 0 },
    })
  }
  if (kept.length === 0) return undefined
  const hashes = row['authorizedHashes']
  const branchedFrom = row['branchedFrom']
  const failure = row['failure']
  return {
    id,
    versions: kept,
    // Absent reads as on: a row that exists was confirmed once, and a missing
    // flag must not silently switch a player's plugin off.
    enabled: row['enabled'] !== false,
    trustFutureVersions: row['trustFutureVersions'] === true,
    authorizedHashes: Array.isArray(hashes) ? hashes.filter((hash): hash is string => typeof hash === 'string') : [],
    ...typeof branchedFrom === 'string' ? { branchedFrom } : {},
    ...failure !== null && typeof failure === 'object'
      ? { failure: failure as NonNullable<SandboxPluginRecord['failure']> }
      : {},
  }
}

/** Reads and persists one profile's per-conversation plugin tables. */
export class SandboxPluginStore {
  readonly #root: string
  readonly #options: SandboxPluginStoreOptions
  /**
   * One chain per chat id, the shape `PluginDataStore` runs.
   *
   * `host.lock` guarantees one process per data directory; it guarantees
   * nothing about two read-modify-writes inside that process, and every write
   * here is one — a confirmation reads the table, changes one row and writes the
   * table back.
   */
  readonly #chains = new Map<string, Promise<void>>()

  /**
   * @param root - the profile's `sandbox-plugins` directory. It need not exist.
   * @param options - the problem channel and the clock.
   */
  constructor(root: string, options: SandboxPluginStoreOptions = {}) {
    this.#root = root
    this.#options = options
  }

  /**
   * One conversation's file, guarded.
   * @param chatId - the conversation.
   * @returns the absolute path.
   */
  #fileFor(chatId: string): string {
    return fileFor(this.#root, chatId, '.json')
  }

  /**
   * Run one read-modify-write at the end of this conversation's chain.
   *
   * The returned link carries the failure to the caller; the link kept in the
   * map has its rejection swallowed, so one failed write neither poisons the
   * chain nor becomes an unhandled rejection.
   * @param chatId - the conversation.
   * @param work - what to do.
   * @returns whatever `work` answered.
   */
  async #enqueue<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const link = (this.#chains.get(chatId) ?? Promise.resolve()).then(work)
    this.#chains.set(chatId, link.then(() => {}, () => {}))
    return link
  }

  /**
   * Read a conversation's table.
   *
   * Answers an empty list for every ordinary absence — no file, no directory —
   * and for the two failures the design routes here: a file that did not parse
   * (quarantined by `readJsonStore`) and a file whose schema version this build
   * does not know.
   * @param chatId - the conversation.
   * @returns the plugins, or an empty list.
   */
  async read(chatId: string): Promise<SandboxPluginRecord[]> {
    let path: string
    try {
      path = this.#fileFor(chatId)
    } catch {
      // An id this store will not make a path for has no table. Refusing loudly
      // here would turn opening a conversation into an error for a condition the
      // conversation itself already survives.
      return []
    }
    const parsed = await readJsonStore(path, this.#options.onProblem, this.#options.now?.())
    if (parsed === null || typeof parsed !== 'object') return []
    const file = parsed as Partial<SandboxPluginFile>
    /*
     * **Not `>=`, and not a migration.** A newer file written by a build that
     * knows more than this one is exactly the case where "read what you can
     * understand" is most tempting and most dangerous: the rows it would salvage
     * carry code and an authorisation, and a partial read of an authorisation is
     * a guess about consent.
     */
    if (file.version !== SANDBOX_PLUGIN_SIDECAR_VERSION) {
      const moved = await quarantineCorruptFile(path, this.#options.now?.() ?? new Date(), 'schema')
      this.#options.onProblem?.(
        `${path} carries sandbox-plugin schema version ${String(file.version)}, not`
        + ` ${String(SANDBOX_PLUGIN_SIDECAR_VERSION)}; the whole file was set aside`
        + `${moved === undefined ? ' (and could not be moved)' : ` as ${moved}`}`
        + ' rather than partly read, because what is parsed out of it would be executed',
      )
      return []
    }
    if (!Array.isArray(file.plugins)) return []
    const out: SandboxPluginRecord[] = []
    for (const row of file.plugins) {
      const record = readRecord(row)
      if (record !== undefined) out.push(record)
    }
    return out
  }

  /**
   * Read, change, write — as one critical section.
   *
   * The whole table is the unit: a confirmation moves a hash into
   * `authorizedHashes` and may append a version, and those two have to land
   * together or a refresh lands between them.
   * @param chatId - the conversation.
   * @param characterId - who it is played with, recorded so a file can say whose it is.
   * @param change - given the current table, answer the table to store.
   * @returns the table as stored.
   */
  async mutate(
    chatId: string,
    characterId: string,
    change: (current: readonly SandboxPluginRecord[]) => readonly SandboxPluginRecord[],
  ): Promise<SandboxPluginRecord[]> {
    return this.#enqueue(chatId, async () => {
      const current = await this.read(chatId)
      const next = [...change(current)]
      await this.#write(chatId, characterId, next)
      return next
    })
  }

  /**
   * Put a table on disk, or take the file away when the table is empty.
   *
   * **An empty table removes the file rather than storing `[]`.** A conversation
   * that has never grown anything and one whose last plugin was deleted are the
   * same conversation as far as everything downstream is concerned, and leaving
   * a husk behind would make "does this chat have a sidecar" a question with two
   * answers that mean the same thing.
   * @param chatId - the conversation.
   * @param characterId - who it is played with.
   * @param plugins - the table.
   */
  async #write(chatId: string, characterId: string, plugins: readonly SandboxPluginRecord[]): Promise<void> {
    const path = this.#fileFor(chatId)
    if (plugins.length === 0) {
      await unlink(path).catch(() => undefined)
      return
    }
    const file: SandboxPluginFile = {
      version: SANDBOX_PLUGIN_SIDECAR_VERSION,
      chatId,
      characterId,
      plugins,
    }
    const text = `${JSON.stringify(file, null, 2)}\n`
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > SANDBOX_PLUGIN_QUOTAS.sidecarBytes) {
      throw new Error(
        `this conversation's sandbox-plugin file would be ${String(bytes)} bytes, over the`
        + ` ${String(SANDBOX_PLUGIN_QUOTAS.sidecarBytes)} one file may hold; nothing was written`,
      )
    }
    await mkdir(dirname(path), { recursive: true })
    await atomicWriteFile(path, text)
  }

  /**
   * Drop a conversation's table, because the conversation is gone.
   *
   * **The hard requirement of §10.3.** Called from `chat.delete` beside
   * `settings.forget`. A chat id is minted against the files that exist, so the
   * next conversation of the same name can be handed this one's id; without this
   * line that conversation opens with plugins it never confirmed, already
   * authorised, and mounts them.
   * @param chatId - the conversation that was deleted.
   */
  async forget(chatId: string): Promise<void> {
    await this.#enqueue(chatId, async () => {
      let path: string
      try {
        path = this.#fileFor(chatId)
      } catch {
        return
      }
      await unlink(path).catch(() => undefined)
    })
  }

  /**
   * Copy a conversation's table onto a branch of it.
   *
   * **With the authorisations, and marked** (coordinator, 2026-09-19). A branch
   * is "carry on from here down another road", not "start again": a player who
   * has already nodded at this code is not making a new trust decision by
   * branching. The mark is what lets the panel say *why* a plugin is in a
   * conversation the player never grew it in — and it stays true after the
   * parent is deleted, because these are copies rather than references.
   * @param fromChatId - the parent conversation.
   * @param toChatId - the new branch.
   * @param characterId - who the branch is played with.
   */
  async branch(fromChatId: string, toChatId: string, characterId: string): Promise<void> {
    const parent = await this.read(fromChatId)
    if (parent.length === 0) return
    await this.#enqueue(toChatId, async () => {
      await this.#write(toChatId, characterId, parent.map(record => ({
        ...record,
        /*
         * The first branch records the parent; a branch of a branch keeps
         * pointing at the conversation it was actually copied from, which is the
         * one whose name the panel can show. Overwriting rather than preserving
         * the grandparent is the choice that keeps the sentence true.
         */
        branchedFrom: fromChatId,
      })))
    })
  }

  /**
   * Wait for every queued write.
   *
   * The map's links are the swallowed ones: every failure was already delivered
   * to the caller that asked for the write.
   */
  async flush(): Promise<void> {
    await Promise.all([...this.#chains.values()])
  }
}
