/**
 * The second MVU dialect: `<JSONPatch>` blocks.
 *
 * Newer MVU distributions ask the model for RFC 6902-shaped operations instead
 * of the `_.verb();` calls `commands.ts` scans for. The card carries the spec
 * itself — 爱衣's `[mvu_update]变量输出格式` entry, transcribed:
 *
 * > the update commands works like the **JSON Patch (RFC 6902)** standard, must
 * > be a valid JSON array containing operation objects, but supports the
 * > following operations instead: `replace`, `delta`, `insert` (using `-` as
 * > array index intends appending to the end), `remove`, `move`
 *
 * `delta` and `insert` are not RFC operations, and `move` carries `from`/`to`
 * rather than the RFC's `from`/`path`. Implementing "RFC 6902" from the RFC
 * would therefore get three of the five wrong, so this is written from the
 * card's own definition and gated on a reply a real model produced against a
 * real SillyTavern.
 *
 * **Both dialects stay live.** A card in the corpus asks for one or the other,
 * never both, and the old one is what most of them still use.
 *
 * @module @iris/mvu/json-patch
 */

import type { CommandInfo, CommandType } from './commands.ts'

/** One operation as the model wrote it, before it is understood. */
interface RawOperation {
  op?: unknown
  path?: unknown
  value?: unknown
  from?: unknown
  to?: unknown
}

/** What one scan found, including what it could not use. */
export interface JsonPatchScan {
  /** The operations that became commands, in source order. */
  commands: CommandInfo[]
  /** How many `<JSONPatch>` blocks were present at all. */
  blocks: number
  /**
   * How many operations those blocks contained, understood or not.
   *
   * Separate from `commands.length` so a caller can tell an **empty** block from
   * an unreadable one. `<JSONPatch>[]</JSONPatch>` is a model saying "nothing
   * changed this turn", which is a correct answer and must not be reported as a
   * failure to read; a block with operations in it that produced no commands is
   * the opposite, and is the thing worth saying out loud.
   */
  operations: number
  /**
   * One line per operation that was dropped, and why.
   *
   * Carried rather than discarded because this whole dialect went unnoticed for
   * a release: the model emitted blocks, nothing understood them, and no channel
   * existed to say so. A block that yields no commands is the signal that
   * something is wrong with the format, not with the model's willingness.
   */
  rejected: string[]
}

/** `<JSONPatch>` … `</JSONPatch>`, tolerant of case and surrounding whitespace. */
const BLOCK = /<JSONPatch>([\s\S]*?)<\/JSONPatch>/gi

/**
 * RFC 6902 operations this dialect does **not** carry, and what to say instead.
 *
 * A model that has read the RFC rather than the card writes `add` or `copy`, and
 * a refusal reading `unknown op "add"` blames it for inventing something that is
 * in fact the standard's own name. The message has to say which side the gap is
 * on: this dialect is the card's, not the RFC's, and it spells three of the five
 * differently.
 */
const RFC_ONLY: Readonly<Record<string, string>> = {
  add: 'RFC 6902 calls this "add"; this dialect spells the same thing "insert"',
  copy: '"copy" belongs to RFC 6902; this dialect has no equivalent, and a "move" followed by a re-set is the nearest',
  test: '"test" is the RFC 6902 assertion op; this dialect has no equivalent and nothing in the corpus uses it',
}

/** JSON Patch op names mapped onto the canonical verbs `apply` implements. */
const OPS: Readonly<Record<string, CommandType>> = {
  replace: 'set',
  delta: 'add',
  insert: 'insert',
  remove: 'delete',
  move: 'move',
}

/**
 * Convert one JSON Pointer to the lodash path the command model uses.
 *
 * RFC 6901's escapes are honoured in the RFC's order — `~1` before `~0`, or a
 * literal `~1` in a key decodes to `/` — and a purely numeric segment becomes a
 * bracket index so it reaches `apply`'s array handling rather than being treated
 * as an object key.
 * @param pointer - e.g. `/世界/当前时间` or `/队伍/0`.
 * @returns the lodash path, e.g. `世界.当前时间` or `队伍[0]`.
 */
export function pointerToPath(pointer: string): string {
  const segments = pointer.split('/')
  // A pointer starts with `/`, so the first segment is empty. A pointer that
  // does not is malformed by the RFC but common from models, so the empty
  // leading segment is dropped rather than required.
  if (segments[0] === '') segments.shift()

  let path = ''
  for (const raw of segments) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (/^\d+$/.test(segment)) path += `[${segment}]`
    else path += path === '' ? segment : `.${segment}`
  }
  return path
}

/**
 * Split a pointer into its container and its last segment.
 * @param pointer - the operation's path.
 * @returns the container's lodash path and the raw final segment.
 */
function splitPointer(pointer: string): { container: string, key: string } {
  const at = pointer.lastIndexOf('/')
  if (at <= 0) return { container: '', key: pointer.replace(/^\//, '') }
  return {
    container: pointerToPath(pointer.slice(0, at)),
    key: pointer.slice(at + 1).replace(/~1/g, '/').replace(/~0/g, '~'),
  }
}

/**
 * Turn one operation into a command.
 * @param raw - the operation object as parsed.
 * @param index - its position, for a rejection message.
 * @returns the command, or the reason it could not be used.
 */
function toCommand(raw: RawOperation, index: number): CommandInfo | { reason: string } {
  const op = typeof raw.op === 'string' ? raw.op.toLowerCase() : ''
  const type = OPS[op]
  if (type === undefined) {
    // Named precisely, because a refusal that points at the wrong side costs
    // somebody a search. `add` is not a model's invention.
    const known = RFC_ONLY[op]
    return {
      reason: known === undefined
        ? `operation ${String(index)}: unknown op "${String(raw.op)}"`
        : `operation ${String(index)}: ${known}`,
    }
  }

  const source = JSON.stringify(raw)

  if (type === 'move') {
    // `from`/`to`, which is the card's spelling, not the RFC's `from`/`path`.
    // `path` is accepted as a fallback because a model that has read the RFC
    // will write it, and refusing that would be pedantry at the user's expense.
    const from = typeof raw.from === 'string' ? raw.from : undefined
    const to = typeof raw.to === 'string' ? raw.to : typeof raw.path === 'string' ? raw.path : undefined
    if (from === undefined || to === undefined) return { reason: `operation ${String(index)}: move needs "from" and "to"` }
    return { type, full_match: source, args: [pointerToPath(from), pointerToPath(to)], reason: '', values: [] }
  }

  if (typeof raw.path !== 'string') return { reason: `operation ${String(index)}: "path" must be a string` }
  const pointer = raw.path

  if (type === 'delete') {
    return { type, full_match: source, args: [pointerToPath(pointer)], reason: '', values: [] }
  }

  if (!('value' in raw)) return { reason: `operation ${String(index)}: "${op}" needs a value` }
  const value = raw.value

  if (type === 'insert') {
    // `insert` names the **new** member's full path, so the command's container
    // is one level up. `-` is the card's append token; anything else is a key or
    // an index, and `apply`'s three-argument insert already tells those apart.
    const { container, key } = splitPointer(pointer)
    if (key === '-') {
      return { type, full_match: source, args: [container, literal(value)], reason: '', values: [undefined, value] }
    }
    const asIndex = /^\d+$/.test(key) ? Number(key) : key
    return {
      type,
      full_match: source,
      args: [container, literal(asIndex), literal(value)],
      reason: '',
      values: [undefined, asIndex, value],
    }
  }

  return { type, full_match: source, args: [pointerToPath(pointer), literal(value)], reason: '', values: [undefined, value] }
}

/**
 * Render a value back into the literal form `args` carries.
 *
 * Kept in step with `values` rather than replacing it: `args` is what the
 * community's `COMMAND_PARSED` fix-up listeners rewrite, so it has to stay
 * textual, while `values` is what `apply` actually reads. `JSON.stringify` is
 * only ever the display half here — round-tripping an object through
 * `evaluateLiteral` corrupts any string containing an apostrophe.
 * @param value - the parsed value.
 * @returns its source form.
 */
function literal(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * Scan a model reply for `<JSONPatch>` blocks.
 * @param text - the whole message.
 * @returns the commands, how many blocks were seen, and every dropped operation.
 */
export function scanJsonPatch(text: string): JsonPatchScan {
  const commands: CommandInfo[] = []
  const rejected: string[] = []
  let blocks = 0
  let operations = 0

  BLOCK.lastIndex = 0
  for (let match = BLOCK.exec(text); match !== null; match = BLOCK.exec(text)) {
    blocks += 1
    const body = (match[1] ?? '').trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (error: unknown) {
      rejected.push(`block ${String(blocks)}: not valid JSON (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    if (!Array.isArray(parsed)) {
      rejected.push(`block ${String(blocks)}: expected an array of operations`)
      continue
    }

    operations += parsed.length
    for (const [index, entry] of parsed.entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        rejected.push(`operation ${String(index)}: not an object`)
        continue
      }
      const command = toCommand(entry as RawOperation, index)
      if ('reason' in command && !('type' in command)) rejected.push(command.reason)
      else commands.push(command as CommandInfo)
    }
  }

  return { commands, blocks, operations, rejected }
}

/**
 * The commands in a reply's `<JSONPatch>` blocks.
 * @param text - the whole message.
 * @returns the commands in source order.
 */
export function extractJsonPatch(text: string): CommandInfo[] {
  return scanJsonPatch(text).commands
}
