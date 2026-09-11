/**
 * Button tables a script rewrote at runtime.
 *
 * **Why these live beside the installation rather than in the card.** Upstream's
 * `replaceScriptButtons` (`JS-Slash-Runner/src/function/script.ts:73`) calls no
 * save of its own — it assigns `script.button.buttons` and stops. What persists
 * it is a **deep watcher** on the character settings store
 * (`store/settings/character.ts:150`), which writes the card file *immediately*,
 * with the comment 「酒馆经常读取角色卡数据, 所以这里需要立即保存」. So on
 * SillyTavern a script rewriting its own buttons edits the character card on
 * disk.
 *
 * This host does not write runtime state into a shared card file — the same
 * ruling that moved `script.data` out (`notes/packages/iris-app-service/DEVIATIONS.md §1`), and this is the
 * structurally identical case: the card *declares* a button table, and
 * `replaceScriptButtons` changes it while running. Splitting the two across two
 * persistence schemes would leave nobody able to say which kind of runtime state
 * lives where, so they share one.
 *
 * The card's declaration is the **seed**; what a script writes is an override
 * kept here, and the snapshot hands out the two merged.
 *
 * **The cost, stated rather than left to be discovered.** A card exported back
 * to a real SillyTavern carries its declared buttons and not the runtime ones —
 * a script that rearranged its own panel finds the arrangement gone. That
 * follows from seed semantics and is the price of not writing the shared file;
 * it is recorded in `notes/packages/iris-app-service/DEVIATIONS.md` rather than left for someone to meet.
 *
 * @module @iris/app-service/script-buttons
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { atomicWriteFile, readJsonStore } from './atomic.ts'

/** One button as both the card and the wire describe it. */
export interface ScriptButton {
  name: string
  visible: boolean
}

/** Overrides for one character, by script id. */
type Tables = Record<string, ScriptButton[]>

/** Every character's overrides, by character id. */
type Partitions = Record<string, Tables>

/**
 * Button overrides, partitioned by character and then by script.
 *
 * Partitioned the same way script variables are, and for the same reason: one
 * card must not read or overwrite another's, and a per-card grant means nothing
 * against a shared bag.
 */
export class ScriptButtonStore {
  readonly #path: string
  readonly #onError: (error: Error) => void
  readonly #onProblem: ((message: string) => void) | undefined
  #partitions: Partitions = {}
  #loaded = false

  /**
   * @param path - the JSON file backing the store.
   * @param onError - told when a write fails; absent means silence.
   * @param onProblem - told when the file was there and could not be read or
   *   parsed; see `atomic.ts`'s `readJsonStore`. Absent means silence.
   */
  constructor(
    path: string,
    onError: (error: Error) => void = () => {},
    onProblem?: (message: string) => void,
  ) {
    this.#path = path
    this.#onError = onError
    this.#onProblem = onProblem
  }

  /** Load on first use; a missing file is an empty store, an unparsable one is set aside. */
  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    // An empty store means every script shows the buttons its card declared,
    // which is the correct first-run state — and the wrong state to write over
    // a file that only failed to parse.
    const parsed = await readJsonStore(this.#path, this.#onProblem)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      this.#partitions = parsed as Partitions
    }
  }

  /**
   * The override for one script, if it has ever rewritten its buttons.
   * @param characterId - whose card.
   * @param scriptId - which script.
   * @returns the stored table, or undefined when the declaration still stands.
   */
  async get(characterId: string, scriptId: string): Promise<ScriptButton[] | undefined> {
    await this.#load()
    const stored = this.#partitions[characterId]?.[scriptId]
    // Copied out, so a caller scribbling on the array cannot edit the store.
    return stored === undefined ? undefined : stored.map(button => ({ ...button }))
  }

  /**
   * Every override for one character, by script id.
   * @param characterId - whose card.
   * @returns the stored tables; an empty object when none.
   */
  async all(characterId: string): Promise<Tables> {
    await this.#load()
    const stored = this.#partitions[characterId] ?? {}
    return Object.fromEntries(
      Object.entries(stored).map(([id, buttons]) => [id, buttons.map(button => ({ ...button }))]),
    )
  }

  /**
   * Replace one script's button table.
   *
   * Whole-table, matching upstream: `replaceScriptButtons` assigns the array it
   * is given, so a button left out of it is gone. There is no per-button write
   * upstream and none here.
   * @param characterId - whose card.
   * @param scriptId - which script.
   * @param buttons - the complete new table.
   */
  async set(characterId: string, scriptId: string, buttons: readonly ScriptButton[]): Promise<void> {
    await this.#load()
    const tables = this.#partitions[characterId] ?? {}
    tables[scriptId] = buttons.map(button => ({ name: button.name, visible: button.visible }))
    this.#partitions[characterId] = tables
    await this.#save()
  }

  /**
   * Drop every override for one character.
   *
   * Called when a card is removed, so its leftovers do not outlive it and
   * reappear against a card imported later under the same id.
   * @param characterId - whose card.
   */
  async forget(characterId: string): Promise<void> {
    await this.#load()
    if (this.#partitions[characterId] === undefined) return
    delete this.#partitions[characterId]
    await this.#save()
  }

  async #save(): Promise<void> {
    try {
      await mkdir(dirname(this.#path), { recursive: true })
      await atomicWriteFile(this.#path, `${JSON.stringify(this.#partitions, null, 2)}\n`)
    } catch (error: unknown) {
      // Reported rather than thrown: a card's button rearrangement failing to
      // persist should not fail the call that made it, but it must not be
      // silent either — the script would go on believing the panel is saved.
      this.#onError(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

/**
 * A script's effective buttons: what it declared, overridden by what it wrote.
 *
 * Whole-table replacement, not a merge by name. Upstream's writer assigns the
 * array, so an override that omits a declared button means that button is gone —
 * merging them back in would resurrect exactly what the script removed.
 * @param declared - the card's own table, if it declares one.
 * @param override - the stored table, if the script has rewritten it.
 * @returns the table to hand a card, or undefined when there is none.
 */
export function effectiveButtons(
  declared: readonly ScriptButton[] | undefined,
  override: readonly ScriptButton[] | undefined,
): ScriptButton[] | undefined {
  if (override !== undefined) return override.map(button => ({ ...button }))
  if (declared !== undefined) return declared.map(button => ({ ...button }))
  return undefined
}
