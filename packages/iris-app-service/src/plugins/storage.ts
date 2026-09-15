/**
 * Where an activated system plugin's own data lives: one directory per plugin
 * under `<profile>/plugin-data/`, one file per key inside it.
 *
 * **Why one file per key, when `CardStorageStore` keeps one big JSON.** That
 * store rewrites its whole file on every write and measured the cost itself
 * (`card-storage.ts:46` — 4 MiB rewritten in 2.53 ms) against a 10 MiB ceiling;
 * this store's ceiling is 64 MiB per plugin with no ceiling at all on how many
 * plugins exist, and a single big file would make the cost of one `set` grow
 * with everything the plugin ever stored. Worse is the blast radius: one key
 * whose bytes arrive damaged quarantines *one file* here, where in a single
 * file it would take the plugin's whole saved state into quarantine with it —
 * the exact shape of the incident `atomic.ts` records, where one unparsable
 * store file zeroed settings, profiles and consent records together because
 * they shared a file.
 *
 * **Who this store belongs to.** A plugin reaches it through
 * `scope.storage`, declared by listing `plugin-storage` in its manifest — the
 * one permission name that is a boundary rather than a declaration
 * (`plugins/manifest.ts`). The host keeps the paths: a plugin is never told
 * where its directory is, and every key it hands over is re-checked against
 * the id grammar *and* a resolved-prefix containment before it becomes a
 * filename, because a key is outside input the same way a chat id is
 * (`paths.ts`).
 *
 * @module @iris/app-service/plugins/storage
 */

import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { isValidExtensionId } from '@iris/extension-installer'
import type { PluginStorage } from '@iris/plugin-api'

import { atomicWriteFile, readJsonStore } from '../atomic.ts'
import { assertStorable } from '../context.ts'
import { AppError, invalid } from '../errors.ts'

/**
 * The ceiling on one stored value, in bytes of the serialized file.
 *
 * `card-storage.ts:33` deliberately has **no** per-value limit, and the two
 * constants disagree on purpose: card storage re-creates a browser API a card
 * already lives inside, and a browser imposes no per-value limit — a 2 MB
 * wallpaper stored fine in SillyTavern and must store fine there. Plugin
 * storage has no upstream to align with; it is a service this host invented,
 * and the ceiling is that service's own pricing. A runaway plugin should hit
 * a named wall after one value, not discover the 64 MiB total by filling it.
 */
export const MAX_PLUGIN_VALUE_BYTES = 1_048_576

/**
 * The ceiling on one plugin's whole store, in bytes of serialized files.
 *
 * Same convention as the installer's `PLUGIN_TREE_LIMITS` (256 MiB / 20,000 files,
 * justified by the one measured pilot tree): a ceiling nobody measured against
 * a real workload is a guess, and this one keeps a data ceiling one notch
 * below the code-tree ceiling because the two grow differently — a plugin's
 * code arrives once at a fixed size, its data accumulates for as long as the
 * user keeps it. Counted over the serialized files only, which is what `set`
 * writes and what the directory scan seeds from.
 */
export const MAX_PLUGIN_STORE_BYTES = 64 * 1_048_576

/** Construction options; every field past `root` is a test seam or a report channel. */
export interface PluginDataStoreOptions {
  /** `<profile>/plugin-data`, from `profilePaths`. One level above the per-plugin directories. */
  root: string
  /**
   * Told, once, when a file this store reads was damaged or unreadable — the
   * same sentence `readJsonStore` reports for every store in this package.
   * Production wires it to `index.ts`'s `reportStoreProblem`, so a damaged
   * plugin data file reaches the host's diagnostics and never a stream frame
   * (`storage-error` is a stream code bound to a chat and a turn, which a
   * plugin quarantine has neither of).
   */
  onProblem?: (message: string) => void
  /**
   * Told when a queued write failed on disk. The plugin that called `set`
   * sees the same error thrown back to it; this channel exists because the
   * host's own shutdown drain (`flush`) cannot re-raise what a caller
   * already received, and because the caller may be a disposed fiber nobody
   * is listening to any more.
   */
  onError?: (error: Error) => void
  /**
   * Test-only override of the two ceilings — the same seam
   * `PLUGIN_TREE_LIMITS` carries, for the same reason: a test proving a
   * 64 MiB ceiling by building 64 MiB would take minutes and prove nothing
   * the pinned constants do not. Production call sites never pass this.
   */
  limits?: { valueBytes?: number, storeBytes?: number }
  /** The clock the quarantine name carries; injectable so a test can pin the name. */
  now?: () => Date
}

/**
 * Every plugin's private store, behind one object per activation.
 *
 * The store is host-level and long-lived; {@link storageFor} hands out one
 * `PluginStorage` face per activation, which is the only thing a plugin ever
 * sees. The identity question — *may this face still write?* — stays with the
 * caller as an `isCurrent` predicate, so the store needs no opinion about
 * plugin lifecycle and a test can drive it without a runtime.
 */
export class PluginDataStore {
  readonly #root: string
  readonly #onProblem: ((message: string) => void) | undefined
  readonly #onError: (error: Error) => void
  readonly #valueLimit: number
  readonly #storeLimit: number
  readonly #now: () => Date
  /**
   * One write chain per plugin id, so one plugin's reads-modify-write of its
   * own byte counter is a critical section.
   *
   * The chain lives on the **store**, keyed by plugin id — not on an
   * activation — so a reload's leftover old-generation writes still queue
   * ahead of the new generation's and cross-incarnation order cannot flip.
   * `ScriptVariableStore` runs the same shape with one chain for the opposite
   * reason (there, one file; here, the counter).
   */
  readonly #chains = new Map<string, Promise<void>>()
  /**
   * Serialized bytes per plugin id, seeded from the directory on this host
   * generation's first use of that id.
   *
   * A counter rather than a scan per `set`, because a scan per write is O(n)
   * `stat` calls and two concurrent writers can each read the same total and
   * both pass the gate. The counter drifts only within one host generation —
   * a crash between write and update, or a file an earlier host left, is
   * corrected by the next boot's seed — and the per-plugin chain closes the
   * concurrent-writer hole the scan had.
   */
  readonly #usage = new Map<string, number>()

  constructor(options: PluginDataStoreOptions) {
    this.#root = options.root
    this.#onProblem = options.onProblem
    this.#onError = options.onError ?? (() => {})
    this.#valueLimit = options.limits?.valueBytes ?? MAX_PLUGIN_VALUE_BYTES
    this.#storeLimit = options.limits?.storeBytes ?? MAX_PLUGIN_STORE_BYTES
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * One plugin's storage face.
   * @param pluginId - the plugin's catalog id; names its directory.
   * @param isCurrent - whether the activation this face was handed to is
   *   still the plugin's current incarnation. Asked before every write, never
   *   before a read: a read cannot make a plugin believe it saved something,
   *   and refusing one would only turn shutdown diagnostics into exceptions.
   */
  storageFor(pluginId: string, isCurrent: () => boolean): PluginStorage {
    return {
      get: key => this.#get(pluginId, key),
      set: (key, value) => this.#set(pluginId, isCurrent, key, value),
      delete: key => this.#delete(pluginId, isCurrent, key),
      keys: () => this.#keys(pluginId),
    }
  }

  /**
   * Drain every queued write and close the store.
   *
   * Closed **before** the drain, so a write arriving mid-flush is refused
   * rather than enqueued behind it — after the close there is no "later" this
   * store may promise, and a write taken but never persisted would let a
   * plugin believe it saved. The refusal is `invalid-request`, named after
   * `ScriptVariableStore`'s, whose docblock carries the reasoning this
   * mirrors. Reads keep working after the close: they answer what is on disk,
   * which is still true.
   */
  async flush(): Promise<void> {
    this.#closed = true
    // The map's links are the swallowed ones — they resolve even when the
    // write they carried failed, because every failure was already delivered
    // to its own `set`/`delete` caller and reported to `onError`. A flush
    // that re-raised one of them would fail the host's teardown over a write
    // somebody else was already told about.
    await Promise.all([...this.#chains.values()])
  }

  #closed = false

  #assertOpen(): void {
    if (this.#closed) {
      throw invalid('this host was unloaded, so the write was not kept;'
        + ' a newer host owns the plugin data now')
    }
  }

  #assertCurrentFor(pluginId: string, isCurrent: () => boolean): void {
    if (!isCurrent()) {
      throw new AppError(
        'unsupported',
        `system plugin "${pluginId}" incarnation is stale;`
        + ' the write came from an activation that has been disposed',
      )
    }
  }

  /** `<root>/<pluginId>` — the plugin id is outside input and gets both guards. */
  #dirFor(pluginId: string): string {
    if (!isValidExtensionId(pluginId)) {
      throw invalid(`"${pluginId}" is not a valid plugin id`)
    }
    const root = resolve(this.#root)
    const dir = resolve(root, pluginId)
    // Belt and braces, the same two layers `paths.ts` runs: the grammar above
    // already forbids separators, and this catches whatever it one day fails
    // to.
    if (!dir.startsWith(root + sep)) {
      throw invalid(`"${pluginId}" is not a valid plugin id`)
    }
    return dir
  }

  #fileFor(pluginId: string, key: string): string {
    if (!isValidExtensionId(key)) {
      throw invalid(`"${key}" is not a valid plugin storage key`)
    }
    const dir = this.#dirFor(pluginId)
    const file = resolve(dir, `${key}.json`)
    if (!file.startsWith(dir + sep)) {
      throw invalid(`"${key}" is not a valid plugin storage key`)
    }
    return file
  }

  /** Run one counter-touching operation at the end of this plugin's write chain. */
  #enqueue(pluginId: string, work: () => Promise<void>): Promise<void> {
    const link = (this.#chains.get(pluginId) ?? Promise.resolve()).then(work)
    this.#chains.set(pluginId, link.then(() => {}, () => {}))
    return link
  }

  /**
   * Serialized bytes this plugin has on disk, seeding from the directory on
   * this host generation's first use.
   *
   * The scan counts only files whose stem is a legal key — the same filter
   * `keys()` applies — so quarantine and temporary files, whose names do not
   * end in `.json`, are never counted as data.
   */
  async #usageOf(pluginId: string): Promise<number> {
    const known = this.#usage.get(pluginId)
    if (known !== undefined) return known
    const dir = this.#dirFor(pluginId)
    const entries = await readdir(dir).catch(() => [] as string[])
    let total = 0
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const key = entry.slice(0, -'.json'.length)
      if (!isValidExtensionId(key)) continue
      const info = await stat(join(dir, entry)).catch(() => undefined)
      if (info === undefined || !info.isFile()) continue
      total += info.size
    }
    this.#usage.set(pluginId, total)
    return total
  }

  async #get(pluginId: string, key: string): Promise<unknown> {
    const file = this.#fileFor(pluginId, key)
    // Three no-value answers, one `undefined`: never stored, damaged and
    // quarantined, or there but unreadable. The plugin cannot act on the
    // second and third; the host hears about both through `onProblem`.
    return await readJsonStore(file, this.#onProblem, this.#now())
  }

  async #set(pluginId: string, isCurrent: () => boolean, key: string, value: unknown): Promise<void> {
    this.#assertOpen()
    this.#assertCurrentFor(pluginId, isCurrent)
    // The host's own value guard, unchanged: a plugin writes through the same
    // face a card script does, forbidden keys and non-JSON values included.
    assertStorable(value, 'plugin storage value')
    const file = this.#fileFor(pluginId, key)
    // Not `JSON.stringify(value).length`: that counts UTF-16 code units, and a
    // Chinese value's real byte count is about three times that — the gate
    // would open three times too wide on exactly the values this corpus is
    // full of. `CardStorageStore.size` measures the same way.
    const text = `${JSON.stringify(value, null, 2)}\n`
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.#valueLimit) {
      throw invalid(`plugin storage value is ${String(bytes)} bytes;`
        + ` the ceiling for one value is ${String(this.#valueLimit)} bytes`)
    }
    await this.#enqueue(pluginId, async () => {
      const usage = await this.#usageOf(pluginId)
      const previous = await stat(file).catch(() => undefined)
      const previousBytes = previous === undefined || !previous.isFile() ? 0 : previous.size
      const after = usage - previousBytes + bytes
      if (after > this.#storeLimit) {
        throw new AppError('invalid-request',
          `system plugin "${pluginId}" plugin data would hold ${String(after)} bytes;`
          + ` the ceiling for one plugin is ${String(this.#storeLimit)} bytes`)
      }
      try {
        // Created on the first successful `set` and never before: a plugin
        // that only ever read or deleted nothing leaves no directory behind,
        // the same rule that keeps an empty card store from creating its file.
        await mkdir(dirname(file), { recursive: true })
        await atomicWriteFile(file, text)
      } catch (error: unknown) {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.#onError(failure)
        throw failure
      }
      this.#usage.set(pluginId, after)
    })
  }

  async #delete(pluginId: string, isCurrent: () => boolean, key: string): Promise<void> {
    this.#assertOpen()
    this.#assertCurrentFor(pluginId, isCurrent)
    const file = this.#fileFor(pluginId, key)
    await this.#enqueue(pluginId, async () => {
      const previous = await stat(file).catch(() => undefined)
      if (previous === undefined || !previous.isFile()) {
        // Removing a key that was never stored is not an error, the same
        // answer `CardStorageStore.remove` gives an absent key.
        return
      }
      try {
        await unlink(file)
      } catch (error: unknown) {
        if ((error as { code?: string }).code === 'ENOENT') return
        const failure = error instanceof Error ? error : new Error(String(error))
        this.#onError(failure)
        throw failure
      }
      const usage = await this.#usageOf(pluginId)
      this.#usage.set(pluginId, Math.max(0, usage - previous.size))
    })
  }

  async #keys(pluginId: string): Promise<string[]> {
    const dir = this.#dirFor(pluginId)
    const entries = await readdir(dir).catch(() => [] as string[])
    const keys: string[] = []
    for (const entry of entries) {
      // A key file's name ends in `.json` and its stem passes the key grammar.
      // Quarantine names end in a timestamp and temporaries end in `.tmp`, so
      // neither is eligible — and the assertion beside this filter holds the
      // two apart rather than trusting the naming rule to stay true.
      if (!entry.endsWith('.json')) continue
      const key = entry.slice(0, -'.json'.length)
      if (!isValidExtensionId(key)) continue
      keys.push(key)
    }
    return keys.sort()
  }
}
