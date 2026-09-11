/**
 * The user's personas: who {{user}} is, in the user's own words.
 *
 * SillyTavern keeps one persona per avatar in `power_user.persona_descriptions`,
 * keyed by avatar file, with the *selected* persona's values copied into
 * `power_user.persona_description` / `persona_description_position` /
 * `persona_description_depth` / `persona_description_role` on every switch
 * (`personas.js`, the `descriptor` read in the persona-selected path). Iris has
 * no avatar files, so the persona itself is the key: an id, a name, a
 * description, and the position the description takes in the prompt — with the
 * active id standing in for upstream's `user_avatar`.
 *
 * Its own file rather than a section of `settings.json`, for the same reason
 * the connections are: settings are what a chat is using now, this is who the
 * user says they are, and clearing one must not empty the other.
 *
 * @module @iris/app-service/persona
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { PersonaView } from '@iris/protocol'

import { atomicWriteFile, readJsonStore } from './atomic.ts'
import { invalid, notFound } from './errors.ts'

/**
 * Where the persona description goes, in upstream's own words.
 *
 * These are the words `parsePersonaPosition` accepts (`personas.js:1963`),
 * spelled as upstream spells them — `inprompt`, `atdepth`, `none` — because a
 * stored value that has to be renamed on the way in or out is a second
 * vocabulary that can drift. The numeric enum lives only in upstream's
 * browser; the words are its wire form.
 *
 * Upstream also carries `topan` / `bottoman` (2, 3), which merge the
 * description into the author's note before world info adds its prompt. Iris
 * assembles no author's note of its own — the AN buckets hold only world-info
 * entries — so those two have nothing to merge into and are refused at the
 * boundary rather than accepted and ignored.
 */
export type PersonaPosition = 'inprompt' | 'atdepth' | 'none'

/** Upstream's `DEFAULT_DEPTH` (`personas.js`, beside the position enum). */
export const DEFAULT_PERSONA_DEPTH = 2

/**
 * Upstream's `DEFAULT_ROLE` — numeric 0, which is `system` in the
 * `promptRole` enum the depth injection reads.
 */
export const DEFAULT_PERSONA_ROLE = 'system' as const

/** The roles a depth injection can take, as the wire spells them. */
const ROLES = ['system', 'user', 'assistant'] as const

/** A persona as it is stored: the user's own words, nothing derived. */
interface StoredPersona {
  id: string
  name: string
  description: string
  position: PersonaPosition
  /** Only meaningful when `position` is `atdepth`. */
  depth?: number
  /** Only meaningful when `position` is `atdepth`. */
  role?: 'system' | 'user' | 'assistant'
}

/** The file's shape. */
interface PersonaFile {
  personas: StoredPersona[]
  activeId?: string
}

/** What a caller may set. */
export interface PersonaInput {
  /** Absent creates a persona with a fresh id; present edits that one. */
  id?: string
  name: string
  description?: string
  position?: PersonaPosition
  depth?: number
  role?: 'system' | 'user' | 'assistant'
  /** Make this persona the active one in the same call. */
  active?: boolean
}

/**
 * The active persona as the prompt assembler reads it, resolved over upstream's
 * defaults — the exact read `personas.js` performs on a descriptor:
 * `position ?? IN_PROMPT`, `depth ?? DEFAULT_DEPTH`, `role ?? DEFAULT_ROLE`.
 */
export interface ActivePersona {
  description: string
  position: PersonaPosition
  depth: number
  role: 'system' | 'user' | 'assistant'
}

/** Project a stored persona onto the wire shape. */
function toWire(persona: StoredPersona): PersonaView {
  return {
    id: persona.id,
    name: persona.name,
    description: persona.description,
    position: persona.position,
    ...persona.depth === undefined ? {} : { depth: persona.depth },
    ...persona.role === undefined ? {} : { role: persona.role },
  }
}

/** One default the depth position needs, for a persona that omits it. */
function depthOf(persona: StoredPersona): number {
  return persona.depth ?? DEFAULT_PERSONA_DEPTH
}

/** One default the depth position needs, for a persona that omits it. */
function roleOf(persona: StoredPersona): 'system' | 'user' | 'assistant' {
  return persona.role ?? DEFAULT_PERSONA_ROLE
}

/** Reads and persists the profile's personas. */
export class PersonaStore {
  readonly #path: string
  readonly #onProblem: ((message: string) => void) | undefined
  #file: PersonaFile = { personas: [] }
  #loaded = false

  /**
   * @param path - the JSON file backing the store.
   * @param onProblem - told when the file was there and could not be parsed;
   *   see {@link readJsonStore}. Absent means silence.
   */
  constructor(path: string, onProblem?: (message: string) => void) {
    this.#path = path
    this.#onProblem = onProblem
  }

  /** Load on first use; a missing file is an empty list, a corrupt one is set aside. */
  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    const parsed = await readJsonStore(this.#path, this.#onProblem) as Partial<PersonaFile> | undefined
    // Nothing saved yet is the state every install starts in; a file that is
    // there and does not parse is now kept under its own name rather than
    // overwritten by the first persona edit after the incident.
    if (Array.isArray(parsed?.personas)) {
      this.#file = {
        personas: parsed.personas,
        ...typeof parsed.activeId === 'string' ? { activeId: parsed.activeId } : {},
      }
    }
  }

  /** Persist the file, creating its directory on a first run. */
  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    await atomicWriteFile(this.#path, `${JSON.stringify(this.#file, null, 2)}\n`)
  }

  /** Validate and place one persona's position fields, upstream's defaults applied on read. */
  #normalize(input: PersonaInput, previous: StoredPersona | undefined): StoredPersona {
    const name = input.name.trim()
    if (name.length === 0) throw invalid('a persona needs a name')

    const position = input.position ?? previous?.position ?? 'inprompt'
    const depth = input.depth ?? previous?.depth
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 0 || depth > 1000)) {
      throw invalid(`"${String(depth)}" is not a depth between 0 and 1000`)
    }
    const role = input.role ?? previous?.role
    if (role !== undefined && !ROLES.includes(role)) {
      throw invalid(`"${role}" is not a prompt role`)
    }

    return {
      id: input.id ?? previous?.id ?? randomUUID(),
      name,
      // Absent keeps what is stored — an editor that only renamed the persona
      // must not blank the description it was never shown.
      description: input.description ?? previous?.description ?? '',
      position,
      ...depth === undefined ? {} : { depth },
      ...role === undefined ? {} : { role },
    }
  }

  /**
   * Every persona, and which one is active.
   * @returns the personas and the active id, when one is set.
   */
  async list(): Promise<{ personas: PersonaView[], activeId?: string }> {
    await this.#load()
    return {
      personas: this.#file.personas.map(toWire),
      ...this.#file.activeId === undefined ? {} : { activeId: this.#file.activeId },
    }
  }

  /**
   * One persona by id, or the active one when no id is given.
   * @param id - the persona to read; absent reads the active one.
   * @returns the persona, or undefined when the id is unknown or nothing is active.
   */
  async get(id?: string): Promise<PersonaView | undefined> {
    await this.#load()
    const wanted = id ?? this.#file.activeId
    if (wanted === undefined) return undefined
    const found = this.#file.personas.find(persona => persona.id === wanted)
    return found === undefined ? undefined : toWire(found)
  }

  /**
   * Create or edit a persona, and optionally make it active.
   * @param input - the values to store; absent fields keep what is stored.
   * @returns the list after the change.
   * @throws {AppError} `invalid-request` when the name, depth or role is malformed.
   */
  async upsert(input: PersonaInput): Promise<{ personas: PersonaView[], activeId?: string }> {
    await this.#load()
    const at = input.id === undefined
      ? -1
      : this.#file.personas.findIndex(persona => persona.id === input.id)
    if (input.id !== undefined && at === -1) {
      throw notFound(`no persona "${input.id}"`)
    }
    const stored = this.#normalize(input, at === -1 ? undefined : this.#file.personas[at])
    if (at === -1) this.#file.personas.push(stored)
    else this.#file.personas[at] = stored
    // `active` is the only switch: editing a persona must not silently make it
    // the one in play, which a presence-based rule would do.
    if (input.active === true) this.#file.activeId = stored.id
    await this.#save()
    return await this.list()
  }

  /**
   * Remove a persona. Removing the active one clears the activation — an empty
   * id would otherwise point at a persona the list no longer has.
   * @param id - the persona to remove.
   * @returns the list after the change.
   * @throws {AppError} `not-found` when the id is unknown.
   */
  async remove(id: string): Promise<{ personas: PersonaView[], activeId?: string }> {
    await this.#load()
    const before = this.#file.personas.length
    this.#file.personas = this.#file.personas.filter(persona => persona.id !== id)
    if (this.#file.personas.length === before) throw notFound(`no persona "${id}"`)
    if (this.#file.activeId === id) delete this.#file.activeId
    await this.#save()
    return await this.list()
  }

  /**
   * The active persona as the prompt assembler reads it.
   *
   * An **empty description is no persona** — upstream guards every read with
   * `if (!power_user.persona_description …)`, so a persona whose description
   * has not been written contributes nothing anywhere. That guard is what keeps
   * the default behaviour identical with and without the store configured.
   * @returns the resolved values, or undefined when nothing is active or the active description is empty.
   */
  async active(): Promise<ActivePersona | undefined> {
    await this.#load()
    const found = this.#file.personas.find(persona => persona.id === this.#file.activeId)
    if (found === undefined || found.description.trim().length === 0) return undefined
    return {
      description: found.description,
      position: found.position,
      depth: found.depth ?? DEFAULT_PERSONA_DEPTH,
      role: found.role ?? DEFAULT_PERSONA_ROLE,
    }
  }

  /**
   * Prime the store's cache, so the synchronous reads below answer from memory.
   *
   * Macro contexts need the description synchronously, and a store that read
   * the file on every call would need an async macro — which does not exist.
   * Called once by the composition at boot; every later change goes through
   * this store's own write paths, which keep the cache current.
   */
  async prime(): Promise<void> {
    await this.#load()
  }

  /**
   * The active description, read synchronously from the loaded cache.
   * @returns the description, or undefined when nothing is active or it is empty.
   */
  activeSync(): string | undefined {
    const found = this.#file.personas.find(persona => persona.id === this.#file.activeId)
    if (found === undefined || found.description.trim().length === 0) return undefined
    return found.description
  }
}
