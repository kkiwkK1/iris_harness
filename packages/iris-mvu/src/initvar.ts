/**
 * Declaring the variable tree.
 *
 * MVU's state is not invented by the model — it is declared up front, in world
 * book entries whose title carries `[InitVar]`, and that declaration is what
 * gives `_.set` something to refuse when the model hallucinates a key.
 *
 * Three upstream details that look like accidents and are not:
 *
 *  - the marker is matched **case-insensitively, as a substring of the entry's
 *    comment (its title)** — so `[initvar]初始变量1` is a valid title;
 *  - a **disabled** entry still initializes: authors switch these off so they
 *    never reach the prompt, not so they stop declaring;
 *  - the body is parsed as **YAML**, which also accepts JSON and JSON5, so a
 *    card written either way loads.
 *
 * @module @iris/mvu/initvar
 */

import { load as parseYaml } from 'js-yaml'
import cloneDeep from 'lodash-es/cloneDeep.js'
import mergeWith from 'lodash-es/mergeWith.js'

import type { MvuData } from './apply.ts'

/** One world book entry, reduced to the fields initialization cares about. */
export interface InitVarEntry {
  /** The entry's title, where the `[InitVar]` marker lives. */
  comment?: string
  content?: string
  disable?: boolean
  [key: string]: unknown
}

/** One world book. */
export interface InitVarSource {
  /** Book name; recorded so a book initializes only once per chat. */
  name: string
  entries: readonly InitVarEntry[]
}

/** What a load produced. */
export interface InitVarResult {
  data: MvuData
  /** Books initialized by this call, in order. */
  loaded: string[]
  /** Entries whose body could not be parsed, with the failure. */
  failures: { book: string, comment: string, reason: string }[]
}

const MARKER = /\[initvar\]/i

/** Whether an entry declares initial variables. */
function declaresInitVars(entry: InitVarEntry): boolean {
  return MARKER.test(entry.comment ?? '')
}

/**
 * Merge declared defaults under whatever the chat already holds.
 *
 * Existing state wins: a book added mid-chat should contribute the keys nobody
 * has set yet without resetting a relationship that has been running for fifty
 * turns. Arrays replace rather than merging element-wise, matching the variable
 * system's own rule.
 */
function mergeDefaults(current: Record<string, unknown>, declared: Record<string, unknown>): Record<string, unknown> {
  return mergeWith({}, declared, current, (_destination: unknown, source: unknown) =>
    (Array.isArray(source) ? source : undefined)) as Record<string, unknown>
}

/**
 * Parse one `[InitVar]` body.
 * @param body - the entry's content.
 * @returns the declared tree, or `undefined` when the body is empty.
 * @throws {Error} when the body is neither valid YAML nor a mapping.
 */
export function parseInitVarBody(body: string): Record<string, unknown> | undefined {
  if (body.trim().length === 0) return undefined
  const parsed = parseYaml(body) as unknown
  if (parsed === null || parsed === undefined) return undefined
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('an [InitVar] body must be a mapping of variable names')
  }
  return parsed as Record<string, unknown>
}

/**
 * Fold every not-yet-loaded book's `[InitVar]` entries into the state.
 * @param sources - world books available to this chat.
 * @param current - the state so far; not mutated.
 * @returns the new state, which books were loaded, and any unparseable entries.
 */
export function loadInitVars(sources: readonly InitVarSource[], current: MvuData): InitVarResult {
  const data = cloneDeep(current)
  const loaded: string[] = []
  const failures: InitVarResult['failures'] = []

  for (const source of sources) {
    // A book initializes once per chat; re-running must not undo later edits.
    if (Object.prototype.hasOwnProperty.call(data.initialized_lorebooks, source.name)) continue

    let touched = false
    for (const entry of source.entries) {
      if (!declaresInitVars(entry)) continue
      try {
        const declared = parseInitVarBody(entry.content ?? '')
        if (declared === undefined) continue
        data.stat_data = mergeDefaults(data.stat_data, declared)
        touched = true
      } catch (error: unknown) {
        failures.push({
          book: source.name,
          comment: entry.comment ?? '',
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (touched) {
      data.initialized_lorebooks[source.name] = []
      loaded.push(source.name)
    }
  }

  return { data, loaded, failures }
}

/** A block lifted out of a greeting. */
export interface GreetingOverride {
  kind: 'replace' | 'update'
  body: string
}

const INITVAR_BLOCK = /<(initvar)>(?:\s*```.*)?([\s\S]*?)(?:```\s*)?<\/\1>/i
const UPDATE_BLOCK = /<(UpdateVariable)>([\s\S]*?)<\/\1>/i

/**
 * Find a per-greeting variable override.
 *
 * A card's alternate greetings can each start the story somewhere different.
 * Two dialects express that: `<initvar>` **replaces** the declared tree
 * outright, while a `<UpdateVariable>` block is applied **on top of** it as
 * ordinary commands.
 * @param greeting - the greeting text.
 * @returns the override, or `undefined` when the greeting declares none.
 */
export function extractGreetingOverride(greeting: string): GreetingOverride | undefined {
  const replace = INITVAR_BLOCK.exec(greeting)
  if (replace?.[2] !== undefined) return { kind: 'replace', body: replace[2].trim() }

  const update = UPDATE_BLOCK.exec(greeting)
  if (update?.[2] !== undefined) return { kind: 'update', body: update[2].trim() }

  return undefined
}
