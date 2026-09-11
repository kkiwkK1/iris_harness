/**
 * The user's own scripts.
 *
 * TavernHelper's 脚本库: code the *user* writes or imports, rather than code a
 * card ships. Read from the 酒馆助手 4.9.1 source on this machine
 * (`data/default-user/extensions/JS-Slash-Runner/src/`) rather than from
 * documentation — every field name and default below has a line behind it, and
 * where this host departs from one, the departure is in
 * `notes/packages/iris-app-service/DEVIATIONS.md` §32–§34.
 *
 * Upstream keeps **three** repositories (`store/scripts.ts:4-96`):
 *
 * - global, at `extension_settings.tavern_helper.script.scripts`
 * - preset, at `preset.extensions.tavern_helper.scripts`
 * - character, at `character.data.extensions.tavern_helper.scripts`
 *
 * and merges them global → preset → character at run time
 * (`store/iframe_runtimes/script.ts:26-32`). This store carries the first and
 * the third. The preset one is absent for the reason the preset *regex* tier is
 * absent: this host's preset library is read-only, and a repository the user
 * could see but not write would be a promise of edits that do nothing.
 *
 * **Two things this store does differently, both load-bearing.**
 *
 * It keeps the character repository in a file of its own rather than in the
 * card. Upstream writes it into `data.extensions` with `writeExtensionField`,
 * which means a user who shares a card ships their own scripts — and their
 * scripts' variable tables — inside it. That is the same argument
 * `script-variables.ts` and `script-buttons.ts` already made for their own
 * fields, and it is stronger here, because this is arbitrary code rather than a
 * few kilobytes of state.
 *
 * And a script created here arrives **switched off**, which *is* upstream's
 * default (`type/scripts.ts:20`, `z.boolean().default(false)`, and the importer
 * forces `enabled = false` again at `panel/script/Toolbar.vue:95`). Worth
 * stating because this host's *card* extractor defaults the same field the other
 * way (`@iris/script`'s `extract.ts:104`, absent ⇒ `true`, because the field
 * post-dates the cards) — one field, two justified defaults, and the reason
 * they differ is who wrote the script.
 *
 * @module @iris/app-service/script-library
 */

import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import type { ScriptView, UserScript, UserScriptView } from '@iris/protocol'

import { atomicWriteFile, readJsonStore } from './atomic.ts'
import { assertStorable } from './context.ts'
import { invalid, notFound } from './errors.ts'

/** Which repository a call names. */
export type LibraryScope = 'global' | 'character'

/**
 * What a save carries.
 *
 * The editable half of {@link UserScript}. `data` and `export_with` are absent
 * on purpose: they are round-tripped, not edited, so a save preserves whatever
 * the stored entry already held rather than letting a shell that renders
 * neither field erase both.
 */
export interface UserScriptInput {
  /**
   * Absent on create, present on edit.
   *
   * Spelled `| undefined` rather than plain optional, and every optional field
   * here is: the request this arrives as is a loose zod object, whose inferred
   * type says `string | undefined` for an optional key, and under
   * `exactOptionalPropertyTypes` those are two different types. Writing the
   * narrower one here would make the one call site that matters — the handler —
   * a type error, and the tempting repair is a cast.
   */
  id?: string | undefined
  name: string
  content: string
  info?: string | undefined
  enabled?: boolean | undefined
  button?: { enabled: boolean, buttons: { name: string, visible: boolean }[] } | undefined
  [key: string]: unknown
}

/** One stored script together with the repository it came from. */
export interface OwnedUserScript {
  script: UserScript
  scope: LibraryScope
}

/** The file on disk. */
interface LibraryFile {
  /** Runs in every conversation. */
  global: UserScript[]
  /** Runs only in this character's, keyed by character id. */
  characters: Record<string, UserScript[]>
}

/**
 * The same record with its explicitly-`undefined` keys removed.
 *
 * Needed because the request this store is fed is a *loose* zod object, whose
 * optional keys infer as `string | undefined` rather than as absent — and
 * spreading that into a stored record would write `info: undefined` where the
 * caller meant "no info". Under `exactOptionalPropertyTypes` those are
 * different types, which is what makes this a compile error rather than a
 * surprise on disk; `JSON.stringify` drops the key either way, so the two would
 * have looked identical after one save-and-reload.
 * @param record - the fields as they arrived.
 * @returns the same fields, minus the keys whose value is `undefined`.
 */
function present(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

/** Whether a parsed value could be one stored script. */
function isStored(value: unknown): value is UserScript {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row['id'] === 'string' && row['id'].length > 0
    && typeof row['name'] === 'string'
    && typeof row['content'] === 'string'
}

/** Read one list out of a parsed file, dropping rows that are not scripts. */
function listOf(value: unknown): UserScript[] {
  return Array.isArray(value) ? value.filter(isStored) : []
}

/**
 * The user's script repositories, global and per character.
 *
 * One file, two repositories, whole-file rewrite on every save — the shape
 * every other small store here uses. A library is tens of entries at the very
 * most; paging it would be complexity bought for a size nobody has.
 */
export class ScriptLibraryStore {
  readonly #path: string
  readonly #onProblem: ((message: string) => void) | undefined
  #file: LibraryFile = { global: [], characters: {} }
  #loaded = false

  /**
   * @param path - the JSON file backing the store.
   * @param onProblem - told when the file was there and could not be parsed;
   *   see `atomic.ts`'s `readJsonStore`. Absent means silence.
   */
  constructor(path: string, onProblem?: (message: string) => void) {
    this.#path = path
    this.#onProblem = onProblem
  }

  /**
   * Load on first use; a missing file is an empty library, not an error.
   *
   * An empty library is the safe reading and the safe *direction*: the default
   * is "nothing of the user's runs", so a corrupt file loses scripts rather
   * than running code nobody can see. Safe is not the same as free — the
   * scripts are the user's own work — so the file is set aside and reported
   * rather than quietly replaced by the next edit.
   */
  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    const parsed = await readJsonStore(this.#path, this.#onProblem)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const file = parsed as Record<string, unknown>
    const characters: Record<string, UserScript[]> = {}
    const stored = file['characters']
    if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
      for (const [id, rows] of Object.entries(stored)) characters[id] = listOf(rows)
    }
    this.#file = { global: listOf(file['global']), characters }
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    await atomicWriteFile(this.#path, `${JSON.stringify(this.#file, undefined, 2)}\n`)
  }

  /**
   * The list one scope owns, by reference into the loaded file.
   * @param scope - which repository.
   * @param characterId - required for `'character'`, refused for `'global'`.
   * @returns the live array, created for a character that has none yet.
   * @throws {AppError} `invalid-request` when the scope and the id disagree.
   */
  #listFor(scope: LibraryScope, characterId: string | undefined): UserScript[] {
    if (scope === 'global') {
      // Refused rather than ignored. A caller that sent a character id with a
      // global write believes the write is scoped, and a store that quietly
      // dropped the id would put the user's script in every conversation while
      // its panel said otherwise.
      if (characterId !== undefined) {
        throw invalid('the global script repository takes no character id')
      }
      return this.#file.global
    }
    if (characterId === undefined) {
      throw invalid('a character script repository needs a character id')
    }
    return this.#file.characters[characterId] ??= []
  }

  /**
   * Drop a character's repository, when its character is deleted.
   *
   * Load-bearing rather than tidy, and the same argument `ScriptPolicyStore`
   * makes: ids are minted from a card's name against the cards **present**, so
   * deleting "Aria" frees the id `Aria` and the next card imported under that
   * name takes it. Left behind, this repository would not be orphaned — it would
   * be **inherited**, and what it holds is arbitrary code that would then start
   * running in a stranger's conversations.
   * @param characterId - the card being deleted.
   */
  async forget(characterId: string): Promise<void> {
    await this.#load()
    if (this.#file.characters[characterId] === undefined) return
    delete this.#file.characters[characterId]
    await this.#save()
  }

  /**
   * The library as a listing: global first, then this character's.
   *
   * Run order, which is upstream's own merge order minus the preset tier
   * (`store/iframe_runtimes/script.ts:26-32`). The order is observable — two
   * scripts writing the same variable settle it by who ran last — so it is data
   * here and not presentation.
   * @param characterId - whose repository to include beside the global one.
   *   Absent lists the global one alone, which is what the settings drawer asks
   *   for with no conversation open.
   * @returns one row per stored script, switched off ones included.
   */
  async views(characterId?: string): Promise<UserScriptView[]> {
    await this.#load()
    const rows = this.#file.global.map(script => viewOf(script, 'global'))
    if (characterId !== undefined) {
      for (const script of this.#file.characters[characterId] ?? []) {
        rows.push(viewOf(script, 'character'))
      }
    }
    return rows
  }

  /**
   * One script whole, for an editor or an export.
   * @param scope - which repository.
   * @param characterId - required for `'character'`.
   * @param id - the script.
   * @returns a detached copy.
   * @throws {AppError} `not-found` when no such script is stored.
   */
  async read(scope: LibraryScope, characterId: string | undefined, id: string): Promise<UserScript> {
    await this.#load()
    const script = this.#listFor(scope, characterId).find(row => row.id === id)
    if (script === undefined) throw notFound(`${scope} script "${id}"`)
    return structuredClone(script)
  }

  /**
   * Create or replace one script.
   *
   * A save carries the body, so it is the one write that can be expensive; the
   * switch has a verb of its own for that reason.
   * @param scope - which repository.
   * @param characterId - required for `'character'`.
   * @param input - the editable fields. Without an `id`, a new script.
   * @returns the id of the script that was written.
   * @throws {AppError} `not-found` when an `id` names nothing here.
   * @throws {AppError} `invalid-request` when the result cannot be stored losslessly.
   */
  async save(
    scope: LibraryScope,
    characterId: string | undefined,
    input: UserScriptInput,
  ): Promise<string> {
    await this.#load()
    const list = this.#listFor(scope, characterId)
    const index = input.id === undefined ? -1 : list.findIndex(row => row.id === input.id)
    // Refused rather than turned into a create. An edit whose target has gone —
    // deleted in another window, or a stale id in a retried request — would
    // otherwise reappear as a second copy, and the user would be looking at two
    // scripts with one history and no report that it happened.
    if (input.id !== undefined && index === -1) throw notFound(`${scope} script "${input.id}"`)
    const previous = index === -1 ? undefined : list[index]
    const { id: _id, ...fields } = input
    const script: UserScript = {
      // The stored entry underneath, so the keys this shell does not edit
      // survive: `data` is the script's own variable table and `export_with` is
      // the author's export choice, and both come in through an import that a
      // later save must not quietly empty.
      ...previous,
      ...present(fields),
      type: 'script',
      // Restated after the spread rather than left to it: `present` erases the
      // required fields' types on its way through `Record<string, unknown>`,
      // and the repair that suggests itself is a cast over the whole literal —
      // which would also stop checking `id` and `enabled` below.
      name: input.name,
      content: input.content,
      id: previous?.id ?? randomUUID(),
      // Upstream's default, and the safe direction besides: a script the user
      // has just typed does not begin executing because they pressed Save.
      // On an edit the stored switch wins over the default, because the user
      // already answered that question and an edit is not a re-ask.
      enabled: input.enabled ?? previous?.enabled ?? false,
    }
    assertStorable(script, 'user script')
    if (index === -1) list.push(script)
    else list[index] = script
    await this.#save()
    return script.id
  }

  /**
   * Remove one script.
   * @param scope - which repository.
   * @param characterId - required for `'character'`.
   * @param id - the script.
   * @throws {AppError} `not-found` when no such script is stored.
   */
  async delete(scope: LibraryScope, characterId: string | undefined, id: string): Promise<void> {
    await this.#load()
    const list = this.#listFor(scope, characterId)
    const index = list.findIndex(row => row.id === id)
    if (index === -1) throw notFound(`${scope} script "${id}"`)
    list.splice(index, 1)
    await this.#save()
  }

  /**
   * Switch one script on or off.
   * @param scope - which repository.
   * @param characterId - required for `'character'`.
   * @param id - the script.
   * @param enabled - the user's choice.
   * @throws {AppError} `not-found` when no such script is stored.
   */
  async setEnabled(
    scope: LibraryScope,
    characterId: string | undefined,
    id: string,
    enabled: boolean,
  ): Promise<void> {
    await this.#load()
    const list = this.#listFor(scope, characterId)
    const script = list.find(row => row.id === id)
    if (script === undefined) throw notFound(`${scope} script "${id}"`)
    script.enabled = enabled
    await this.#save()
  }

  /**
   * Every script that would run in this character's conversations, in run order.
   *
   * Switched-off ones are dropped here and only here: the listing shows them so
   * the user can find the switch, and this is what the runner is handed.
   * @param characterId - whose conversations.
   * @returns the scripts, each with the repository it came from.
   */
  async runnable(characterId: string): Promise<OwnedUserScript[]> {
    await this.#load()
    const owned: OwnedUserScript[] = []
    for (const script of this.#file.global) {
      if (script.enabled) owned.push({ script, scope: 'global' })
    }
    for (const script of this.#file.characters[characterId] ?? []) {
      if (script.enabled) owned.push({ script, scope: 'character' })
    }
    return owned
  }

  /**
   * One script by the `source` a `script.list` row carried.
   *
   * The lookup `script.body` and `script.setEnabled` route through: the scope is
   * named by the caller rather than searched for, because a card's ids belong to
   * the card author and cannot be re-minted on collision the way upstream
   * re-mints its own (`use_resolve_id_conflict.ts`) — so a search would resolve
   * a collision by running the wrong body.
   * @param scope - which repository.
   * @param characterId - the conversation's character.
   * @param id - the script.
   * @returns the stored script, or undefined when it is not there.
   */
  async find(
    scope: LibraryScope,
    characterId: string,
    id: string,
  ): Promise<UserScript | undefined> {
    await this.#load()
    const list = scope === 'global' ? this.#file.global : this.#file.characters[characterId] ?? []
    return list.find(row => row.id === id)
  }
}

/**
 * One listing row.
 *
 * `bytes` is `Buffer.byteLength`, not `String.length`: a JS string's length is
 * UTF-16 code units, so a Chinese script body reports about a third of its real
 * size — and this number is shown to someone deciding whether to run that code.
 * The card-script listing made the same correction for the same reason.
 * @param script - the stored script.
 * @param scope - which repository it lives in.
 * @returns the row.
 */
export function viewOf(script: UserScript, scope: LibraryScope): UserScriptView {
  return {
    id: script.id,
    name: script.name,
    ...script.info === undefined || script.info === '' ? {} : { info: script.info },
    enabled: script.enabled,
    scope,
    ...script.button === undefined ? {} : {
      buttons: script.button.buttons.map(button => ({ ...button })),
      buttonsEnabled: script.button.enabled,
    },
    bytes: Buffer.byteLength(script.content, 'utf8'),
  }
}

/**
 * One library row as the *runnable* script list carries it.
 *
 * A projection rather than a second reading of the store, so the library panel
 * and the script list cannot disagree about a name, a switch or a size — the
 * only thing this adds is the vocabulary a mixed list needs.
 *
 * `enabledByCard: true` is a statement, not a filler: there is no card author
 * to disagree with about a script the user wrote, so the pair collapses and
 * every reader asking "did the card switch this off" correctly gets no. A
 * `false` here would make the script panel hide the toggle on the user's own
 * script and explain it as the card's decision.
 * @param row - the listing row.
 * @returns the runnable-list row.
 */
export function scriptRowOf(row: UserScriptView): ScriptView {
  return {
    id: row.id,
    name: row.name,
    source: row.scope,
    ...row.info === undefined ? {} : { info: row.info },
    enabledByCard: true,
    enabled: row.enabled,
    ...row.buttons === undefined ? {} : { buttons: row.buttons.map(button => ({ ...button })) },
    ...row.buttonsEnabled === undefined ? {} : { buttonsEnabled: row.buttonsEnabled },
    bytes: row.bytes,
  }
}
