/**
 * Filling the EJS evaluator's `Snapshot`, and applying what it writes back.
 *
 * The contract is `packages/iris-compat-prompt-template/SNAPSHOT.md`; this is
 * the host half of it. Two properties do the work, and both fail silently if
 * they are got wrong:
 *
 * - **Text arrives macro-substituted and regexed.** Real cards write
 *   `<%_ if ({{roll 1d100}} >= 100) { _%>` — an ST macro generating the
 *   JavaScript the evaluator then parses — so an unsubstituted template is a
 *   syntax error rather than a template.
 * - **A world-info entry carries its own `world_info` local.** `getwi(null, …)`
 *   resolves `null` to *this entry's book* by reading it, and 58 of the corpus's
 *   62 call sites pass `null`. An entry pushed without it searches every book
 *   instead of its own and returns a plausible answer from the wrong place.
 *
 * Writes come back described rather than applied, and are replayed here through
 * the same guards any other write passes. That is the whole point of the
 * boundary: a template cannot reach a store the host would have checked.
 *
 * @module @iris/app-service/template
 */

import type { CharacterCard } from '@iris/character'
import type { Json, Op, Scope, Snapshot, WorldInfoEntry } from '@iris/compat-prompt-template'
import { fromCharacterBook } from '@iris/lorebook'
import { createMacroContext, expandMacros } from '@iris/macro'
import type { Variables } from '@iris/variables'

import { assertStorable } from './context.ts'
import type { ChatEntry } from './entry.ts'
import { invalid } from './errors.ts'

/** A variable table that survived the boundary. */
function jsonOf(value: unknown): Json {
  return (value ?? {}) as Json
}

/**
 * Every enabled entry of the character's books, as the evaluator searches them.
 *
 * Pushed whole rather than pre-filtered: the reachable set cannot be computed
 * here, because four of the corpus's `getwi` call sites build the name at
 * runtime and one of them makes a `RegExp` out of a variable. Filtering would
 * lose exactly those, and lose them silently.
 *
 * Entries their author disabled are excluded, because `getwi` searches what it
 * is given and a disabled entry is one the author took out of play.
 * @param card - the character being played.
 * @param expand - macro substitution, applied to content as upstream does.
 * @returns one record per enabled entry.
 */
export function worldInfoOf(card: CharacterCard | undefined, expand: (text: string) => string): WorldInfoEntry[] {
  const book = card?.data.character_book
  if (book === undefined) return []

  let entries: WorldInfoEntry[]
  try {
    const parsed = fromCharacterBook(book)
    const world = card?.data.name ?? 'character book'
    entries = Object.values(parsed.entries)
      .filter(entry => entry.disable !== true)
      .map(entry => ({
        world,
        uid: String(entry.uid),
        // The title, which is what `getwi` matches on — not the body.
        comment: entry.comment,
        content: expand(entry.content),
      }))
  } catch {
    return []
  }
  return entries
}

/**
 * The flat environment values upstream exposes.
 *
 * Filled even where the corpus never reads them: an absent name is not
 * `undefined` inside a template, it is an unresolved identifier, so the item
 * throws. Filling them costs nothing and turns a whole class of loud failure
 * into a working template.
 * @param entry - the conversation.
 * @returns upstream's scalar names.
 */
export function scalarsOf(entry: ChatEntry): Record<string, Json> {
  const meta = entry.meta
  const names = entry.names
  const messages = entry.toFile().messages

  const lastOf = (isUser: boolean): { text: string, id: number } => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const line = messages[index]
      if (line !== undefined && line.is_user === isUser) return { text: line.mes, id: index }
    }
    return { text: '', id: -1 }
  }
  const lastUser = lastOf(true)
  const lastChar = lastOf(false)

  return {
    // `charName` and `assistantName` are the same value upstream: both `name2`.
    charName: names.character,
    assistantName: names.character,
    userName: names.user,
    chatId: entry.chatId,
    characterId: meta.characterId ?? null,
    charAvatar: meta.characterId ?? null,
    userAvatar: null,
    groups: [],
    groupId: null,
    charLoreBook: entry.card?.data.character_book === undefined ? null : names.character,
    userLoreBook: null,
    chatLoreBook: null,
    lastUserMessage: lastUser.text,
    lastUserMessageId: lastUser.id,
    lastCharMessage: lastChar.text,
    lastCharMessageId: lastChar.id,
    lastMessageId: messages.length - 1,
    model: null,
  }
}

/**
 * Build the snapshot for one batch.
 *
 * The four variable scopes go over **unmerged**: the evaluator recomputes
 * upstream's merged view itself because `getvar(key, 'global')` has to see past
 * the merge. Merging here — and especially merging deeply — would change how
 * cards behave in a way a single generation would never reveal.
 * @param entry - the conversation being generated for.
 * @param turn - the turn being generated, for the message scope.
 * @param traceId - increases per batch, as upstream's `_trace_id` does.
 * @returns everything the template environment may read.
 */
export function buildSnapshot(entry: ChatEntry, turn: number, traceId: number): Snapshot {
  const names = entry.names
  const macros = createMacroContext({ char: names.character, user: names.user })
  const expand = (text: string): string => expandMacros(text, macros)

  const read = (option: Parameters<ChatEntry['variables']['getVariables']>[0]): Json => {
    try {
      return jsonOf(entry.variables.getVariables(option))
    } catch {
      // A scope with no backend, or a turn with no candidate to hang variables
      // on. Empty is the right reading: the template finds nothing there.
      return {}
    }
  }

  return {
    variables: {
      global: read({ type: 'global' }),
      local: read({ type: 'chat' }),
      message: read({ type: 'message', message_id: turn }),
      // The card's shipped starting state. `@iris/script` extracts it beside the
      // scripts; it is deliberately NOT the `character` scope, which is a live
      // store with a different lifetime.
      initial: jsonOf(entry.initialVariables),
    },
    chatMetadata: jsonOf(entry.header.chat_metadata),
    worldInfo: worldInfoOf(entry.card, expand),
    scalars: scalarsOf(entry),
    traceId,
  }
}

/** Which variable store one scope maps onto. */
function optionFor(scope: Scope, turn: number): Parameters<ChatEntry['variables']['getVariables']>[0] | undefined {
  if (scope === 'global') return { type: 'global' }
  if (scope === 'local') return { type: 'chat' }
  if (scope === 'message') return { type: 'message', message_id: turn }
  // `initial` is the card's shipped state. A template writing to it would be
  // editing what a reset resets to, which upstream does not do either.
  return undefined
}

/**
 * Replay the writes a batch described.
 *
 * Every one goes through the same guard an ordinary write does, which is why
 * the evaluator describes rather than applies: a template must not be able to
 * put something in a store that the host would have refused at its own door.
 *
 * Ops from a failed item are applied too. Upstream performs a `setvar` the
 * moment it runs, so a template that wrote and then threw has already written,
 * and dropping those would be tidier than the user's SillyTavern rather than
 * equal to it.
 * @param entry - the conversation to write into.
 * @param ops - the writes, in the order the templates performed them.
 * @param turn - the turn whose message scope is addressed.
 * @returns how many writes were applied.
 * @throws {AppError} `invalid-request` when a write carries something unstorable.
 */
export function applyOps(entry: ChatEntry, ops: readonly Op[], turn: number): number {
  let applied = 0

  for (const op of ops) {
    if (op.op === 'saveMetadata') {
      assertStorable(op.value, 'saveMetadata')
      if (typeof op.value !== 'object' || op.value === null || Array.isArray(op.value)) {
        throw invalid('saveMetadata must be given an object')
      }
      entry.header.chat_metadata = op.value as Record<string, unknown>
      applied += 1
      continue
    }

    const option = optionFor(op.scope, turn)
    if (option === undefined) continue

    if (op.op === 'delvar') {
      entry.variables.deleteVariable(op.key, option)
      applied += 1
      continue
    }

    assertStorable(op.value, `${op.op}(${op.key})`)
    if (op.op === 'setvar') {
      entry.variables.updateVariablesWith(table => writePath(table, op.key, op.value), option)
      applied += 1
      continue
    }

    // `insvar` inserts into the array at a path, appending when no index is given.
    entry.variables.updateVariablesWith((table) => {
      const existing = readPath(table, op.key)
      const list = Array.isArray(existing) ? [...existing as unknown[]] : []
      const at = typeof op.index === 'number' ? op.index : list.length
      list.splice(Math.max(0, Math.min(at, list.length)), 0, op.value)
      return writePath(table, op.key, list)
    }, option)
    applied += 1
  }

  return applied
}

/**
 * Write a lodash-style dotted path into a variable table.
 *
 * Creates what is missing on the way down, which is `_.set`'s behaviour and
 * therefore the template engine's: MVU's refusal to invent a key is MVU's own
 * rule, not this one's. A numeric segment makes an array, so `a.0.b` produces
 * what a template author writing lodash paths expects.
 * @param table - the table; not mutated.
 * @param path - a dotted path.
 * @param value - what to put there.
 * @returns a new table with the path written.
 */
export function writePath(table: Variables, path: string, value: unknown): Variables {
  const segments = path.split('.')
  const root: Variables = { ...table }
  let cursor: Record<string, unknown> | unknown[] = root

  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index] as string
    const nextKey = segments[index + 1] as string
    const container = cursor as Record<string, unknown>
    const existing = container[key]
    // Copied rather than written through: the store hands out detached tables,
    // and mutating a nested object we did not create would reach into one.
    const next = Array.isArray(existing)
      ? [...existing]
      : typeof existing === 'object' && existing !== null
        ? { ...existing as Record<string, unknown> }
        : /^\d+$/u.test(nextKey) ? [] : {}
    container[key] = next
    cursor = next as Record<string, unknown>
  }

  ;(cursor as Record<string, unknown>)[segments[segments.length - 1] as string] = value
  return root
}

/**
 * Read a lodash-style dotted path out of a variable table.
 * @param table - the table to read.
 * @param path - a dotted path, e.g. `stat_data.银麒系统.账户`.
 * @returns the value, or undefined when the path is not there.
 */
function readPath(table: Variables, path: string): unknown {
  let cursor: unknown = table
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}
