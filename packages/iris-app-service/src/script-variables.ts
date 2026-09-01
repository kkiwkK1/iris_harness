/**
 * Where a card script's own variables live.
 *
 * Upstream keeps them **inside the card file**. Measured in the installed
 * extension rather than inferred:
 *
 * - `JS-Slash-Runner/src/function/variables.ts:88` reads
 *   `useScriptIframeRuntimesStore().get(script_id)?.data`, and `:178-182`
 *   writes `script.data = variables`.
 * - That runtime object is the script inside `character_store.settings.scripts`
 *   (`src/store/iframe_runtimes/script.ts:1-14`, `src/store/scripts.ts:71-77`).
 * - `src/store/settings/character.ts:152-160` watches those settings **deeply**
 *   and calls `writeExtensionField` on every change, with the comment
 *   「酒馆经常读取角色卡数据, 所以这里需要立即保存」.
 *
 * So in SillyTavern, every `setvar` a script makes into its own scope is written
 * into the shared card file immediately. Iris does not do that, and the reason
 * is the one that also makes `initial` unwritable: **a card file gets shared**,
 * and content that depends on how long its owner played is not content its owner
 * chose to send.
 *
 * This is not a disagreement with upstream. `ScriptEditor.vue:65` binds a
 * per-script `export_with.data` checkbox — upstream already treats "does this
 * state travel with the card" as a choice. Iris takes the other default.
 *
 * **What it costs, measured:** 19 cards on this machine, 14 of them carrying
 * scripts, 47 scripts in total, of which **8 hold a non-empty `data`**. Every
 * one of those eight is a setting: a display toggle, a build stamp the author's
 * pipeline wrote, two feature switches, and a note saying a rule moved into the
 * script body. **Nothing in the corpus grows with play.** MVU — the heaviest
 * framework in it — never writes this scope at all, keeping its own settings in
 * `extension_settings.mvu_settings` instead. So the deviation costs no behaviour
 * today.
 *
 * Those counts were got wrong twice before they were got right, both times by
 * walking the card's extensions by hand: the corpus stores scripts under three
 * container shapes, and a walk written from one of them over-counts by sweeping
 * in `regex_scripts` or under-counts by missing two thirds of the cards. They
 * are measured through `@iris/script`'s `extractScripts`, which already knows the
 * shapes, and the test beside this module re-measures them the same way.
 *
 * **What would overturn it:** one real card that writes player progress into
 * `scripts[].data`. The corpus has none, but the corpus is 19 cards — so the
 * test pins the **key names**, not the count: a card that swapped its build
 * stamp for a save file would keep the count and break the claim.
 *
 * @module @iris/app-service/script-variables
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { CharacterCard } from '@iris/character'
import { extractScripts } from '@iris/script'
import type { ScopeBackend, VariableOption, Variables } from '@iris/variables'

import { assertStorable } from './context.ts'
import { invalid } from './errors.ts'

/** One card's tables, keyed by the script that owns each. */
type Tables = Record<string, Variables>

/** Every card's tables, keyed by character id. */
type Partitions = Record<string, Tables>

/**
 * The script id a selector names.
 *
 * Upstream throws when it is missing — `未指定 script_id`, both in
 * `variables.ts:85` and `:175` — because a script always knows its own id and
 * anything that does not is not a script. Refusing rather than pooling the
 * ownerless writes into one shared partition is the same rule: an invented
 * default would let two unidentified callers silently share a table.
 * @param option - the selector.
 * @returns the owning script's id.
 * @throws {AppError} `invalid-request` when the selector names no script.
 */
export function scriptIdOf(option: VariableOption): string {
  const id = option.type === 'script' ? option.script_id : undefined
  if (id === undefined || id === '') {
    throw invalid('a script scope needs a script_id — upstream refuses this too, because a script always knows its own id')
  }
  return id
}

/**
 * Per-card, per-script variables, kept beside the installation rather than in
 * the card.
 *
 * Partitioned by character id like {@link ExtensionSettingsStore}, and by script
 * id within that, so one card's script cannot read another's bookkeeping.
 */
export class ScriptVariableStore {
  readonly #path: string
  readonly #onError: (error: Error) => void
  #partitions: Partitions = {}
  #loaded = false
  /** Writes are serialised through one chain so two flushes cannot interleave. */
  #queue: Promise<void> = Promise.resolve()

  /**
   * @param path - the JSON file backing the store.
   * @param onError - reports a flush that failed; a write is not awaited by its caller.
   */
  constructor(path: string, onError: (error: Error) => void = () => {}) {
    this.#path = path
    this.#onError = onError
  }

  /** Load on first use; a missing file is an empty store, not an error. */
  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        this.#partitions = parsed as Partitions
      }
    } catch {
      // Absent or unreadable. Empty is the safe reading: a script finds its
      // table missing and re-initialises, which is its first-run state anyway.
    }
  }

  /**
   * One card's tables, seeded from the card on first use.
   *
   * The card's own `scripts[].data` is the author's shipped default and has
   * exactly the standing `initial` has — a starting value, not live state. It
   * seeds a partition that does not exist yet, and never overwrites one that
   * does, or every restart would undo the player's progress.
   * @param characterId - whose partition.
   * @param card - the card, for its shipped defaults.
   * @returns the tables, live — this is the object the backend reads and writes.
   */
  async open(characterId: string, card: CharacterCard | undefined): Promise<Tables> {
    await this.#load()
    const existing = this.#partitions[characterId]
    if (existing !== undefined) return existing

    const seeded: Tables = {}
    for (const script of card === undefined ? [] : extractScripts(card).scripts) {
      const data = script.data
      if (data === undefined || data === null || typeof data !== 'object' || Array.isArray(data)) continue
      if (Object.keys(data).length === 0) continue
      seeded[script.id] = structuredClone(data) as Variables
    }
    this.#partitions[characterId] = seeded
    return seeded
  }

  /**
   * A variable backend over one card's partition.
   *
   * The backend is synchronous because `ScopeBackend` is, so a write updates the
   * table and schedules the flush. Upstream is no different in effect — its deep
   * watcher saves after the mutation, not before — but here a flush that fails
   * is reported rather than lost.
   * @param tables - the card's partition, from {@link open}.
   * @returns the backend for the `script` scope.
   */
  backendFor(tables: Tables): ScopeBackend {
    return {
      read: option => tables[scriptIdOf(option)] ?? {},
      write: (option, next) => {
        // Through the host's own guard, like every other write: a script must not
        // be able to put something in a file that the host would have refused.
        assertStorable(next, 'script variables')
        // `tables` is the partition itself — `open` stored this very object —
        // so mutating it is the update, and the flush only has to persist.
        tables[scriptIdOf(option)] = next
        this.#flush()
      },
    }
  }

  /** Queue the store's write to disk, behind whatever is already queued. */
  #flush(): void {
    this.#queue = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true })
      await writeFile(this.#path, `${JSON.stringify(this.#partitions, null, 2)}\n`, 'utf8')
    }).catch((error: unknown) => {
      this.#onError(error instanceof Error ? error : new Error(String(error)))
    })
  }

  /**
   * Wait for every queued write to land.
   *
   * For tests and for shutdown. Ordinary callers do not need it: a write is
   * ordered behind the ones before it, so the file is never half a partition.
   * @returns when the queue is empty.
   */
  async settled(): Promise<void> {
    await this.#queue
  }

  /**
   * Drop a card's partition, when its character is deleted.
   *
   * `scripts.ts` sets the rule for the moment a character id changes owner:
   * *content re-binds by name, a permission does not.* Script variables are
   * content — a player's progress, not a grant — so by that rule alone they
   * would survive a delete the way chats do. They do not, and the reason is
   * upstream rather than the rule: upstream keeps this table **inside the card
   * file**, so deleting a card and importing another under the same name gives
   * the new card's shipped `data`, not the old card's accumulated state.
   * Forgetting and re-seeding is what reproduces that. This is the answer to the
   * question the rule tells a new store to ask, written down because the answer
   * here looks like an exception to it and is not.
   * @param characterId - whose partition.
   */
  async forget(characterId: string): Promise<void> {
    await this.#load()
    if (this.#partitions[characterId] === undefined) return
    delete this.#partitions[characterId]
    this.#flush()
    await this.settled()
  }
}
