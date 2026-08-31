/**
 * Apply extracted commands to an MVU state tree.
 *
 * Faithful to `MagVarUpdate`'s `updateVariables`, including the parts that look
 * inconsistent until you know the convention:
 *
 *  - **`set` refuses a path that does not exist.** The tree's shape is declared
 *    up front by `[InitVar]` world-book entries, so a model inventing a key is
 *    a hallucination rather than a state change.
 *  - **Only `set` and `add` unwrap a `[value, description]` leaf.** `insert`
 *    and `delete` address the stored value directly. That is why the v2 prompt
 *    insists a path carry an explicit `[0]` suffix: it is how the model reaches
 *    inside the pair when the verb will not do it for it.
 *  - **`set`'s unwrap additionally requires a non-array value.** A pair whose
 *    value is itself a list falls through to a whole-leaf write, so list
 *    variables really do need the `[0]`.
 *
 * The description half is preserved on every unwrapped write: it holds the
 * update rule the model was given, and losing it degrades every later turn.
 *
 * @module @iris/mvu/apply
 */

import cloneDeep from 'lodash-es/cloneDeep.js'
import get from 'lodash-es/get.js'
import has from 'lodash-es/has.js'
import isObject from 'lodash-es/isObject.js'
import set from 'lodash-es/set.js'
import toPath from 'lodash-es/toPath.js'
import unset from 'lodash-es/unset.js'

import { normalizeCommandPaths, type CommandInfo } from './commands.ts'

/** The MVU state tree. `stat_data` is what cards read. */
export interface MvuData {
  /** World books whose `[InitVar]` entries have already been folded in. */
  initialized_lorebooks: Record<string, unknown[]>
  /** The live variable tree. */
  stat_data: Record<string, unknown>
  [key: string]: unknown
}

/** One command that could not be applied. */
export interface ApplyFailure {
  command: CommandInfo
  reason: string
}

/** Result of folding a command list into a state tree. */
export interface ApplyResult {
  /** The new state. The input is never mutated. */
  data: MvuData
  /** `"old->new (reason)"` lines keyed by path — what status-bar cards render. */
  display_data: Record<string, string>
  /** Commands that were rejected, with why. */
  failures: ApplyFailure[]
  /** Whether anything actually changed. */
  changed: boolean
}

/** Compatibility knobs, mirroring the root `$meta` flags. */
export interface ApplyOptions {
  /**
   * Write the whole leaf instead of the value half of a `[value, description]`
   * pair. Off by default, matching upstream.
   */
  strictSet?: boolean
}

/**
 * Whether a leaf follows the `[value, description]` convention.
 *
 * Inherited ambiguity: a genuine two-element list of strings — `['剑', '盾']` —
 * is indistinguishable from a pair by shape alone, and upstream has the same
 * hole. What resolves it in practice is the `[InitVar]` declaration, which
 * fixes each leaf's shape before the model ever writes to it.
 * @param value - the stored leaf.
 * @returns whether to treat it as value-plus-description.
 */
function isPair(value: unknown): value is [unknown, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[1] === 'string'
}

/**
 * Evaluate one argument's literal source.
 *
 * Deliberately conservative: quoted strings, JSON literals, numbers, booleans
 * and `null`. Upstream also evaluates mathjs expressions (`math.pow(2,3)`);
 * that is a separate evaluator and is not wired here, so an expression falls
 * through as its own source text rather than being guessed at.
 * @param literal - argument source text.
 * @returns the value it denotes.
 */
export function evaluateLiteral(literal: string): unknown {
  const trimmed = literal.trim()
  if (trimmed === '') return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (trimmed === 'undefined') return undefined

  const first = trimmed[0]
  if ((first === "'" || first === '"' || first === '`') && trimmed.endsWith(first) && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1')
  }

  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed)

  if (first === '[' || first === '{') {
    try {
      // Single quotes are the norm in this dialect; JSON needs double.
      return JSON.parse(trimmed.replace(/'/g, '"')) as unknown
    } catch {
      return trimmed
    }
  }

  return trimmed
}

/** Read a leaf for display, unwrapping a pair. */
function displayValue(stored: unknown): unknown {
  return isPair(stored) ? stored[0] : stored
}

/** Render one change the way status-bar cards expect to read it. */
function renderChange(before: unknown, after: unknown, reason: string): string {
  const arrow = `${String(before)}->${String(after)}`
  return reason === '' ? arrow : `${arrow} (${reason})`
}

/** Join lodash path segments back into a path string. */
function joinPath(segments: readonly string[]): string {
  return segments.reduce<string>((path, segment) => {
    if (/^\d+$/.test(segment)) return `${path}[${segment}]`
    return path === '' ? segment : `${path}.${segment}`
  }, '')
}

/**
 * Fold a command list into a state tree.
 * @param commands - commands in source order, from `extractCommands`.
 * @param current - the state to update; not mutated.
 * @param options - compatibility knobs.
 * @returns the new state, the display strings, and any rejected commands.
 */
export function applyCommands(
  commands: readonly CommandInfo[],
  current: MvuData,
  options: ApplyOptions = {},
): ApplyResult {
  const strictSet = options.strictSet ?? false
  const data = cloneDeep(current)
  const display_data: Record<string, string> = {}
  const failures: ApplyFailure[] = []
  let changed = false

  // Paths arrive as raw source text so a fix-up hook can rewrite them; this is
  // the point past which they must be real lodash paths.
  const pending = normalizeCommandPaths(cloneDeep(commands) as CommandInfo[])

  /** Record a rejection without stopping the batch — one bad command must not lose the rest. */
  const reject = (command: CommandInfo, reason: string): void => {
    failures.push({ command, reason })
  }

  for (const command of pending) {
    const path = command.args[0] as string
    const stored = path === '' ? data.stat_data : get(data.stat_data, path)
    const before = displayValue(stored)

    switch (command.type) {
      case 'set': {
        if (path !== '' && !has(data.stat_data, path)) {
          reject(command, `path "${path}" does not exist`)
          continue
        }
        // Two-argument form is (path, new); three-argument is (path, old, new).
        // The declared old value is advisory — upstream never verifies it, and
        // models get it wrong constantly.
        const value = evaluateLiteral(command.args[command.args.length - 1] as string)

        if (path === '') {
          data.stat_data = value as Record<string, unknown>
        } else if (!strictSet && isPair(stored) && !Array.isArray(stored[0])) {
          // A numeric slot stays numeric: models quote numbers freely.
          const coerced = typeof stored[0] === 'number' && value !== null ? Number(value) : value
          set(data.stat_data, path, [coerced, stored[1]])
        } else if (typeof stored === 'number' && typeof value === 'string') {
          set(data.stat_data, path, Number(value))
        } else {
          set(data.stat_data, path, value)
        }
        break
      }

      case 'add': {
        if (!has(data.stat_data, path)) {
          reject(command, `path "${path}" does not exist`)
          continue
        }
        const wrapped = isPair(stored) && typeof stored[0] !== 'object'
        const target = wrapped ? (stored as [unknown, string])[0] : stored
        const delta = evaluateLiteral(command.args[1] as string)

        if (typeof target !== 'number' || typeof delta !== 'number') {
          reject(command, `cannot add ${typeof delta} to ${typeof target}`)
          continue
        }
        const sum = target + delta
        set(data.stat_data, path, wrapped ? [sum, (stored as [unknown, string])[1]] : sum)
        break
      }

      case 'insert': {
        // No pair unwrapping here — that is what the `[0]` path suffix is for.
        if (stored !== null && stored !== undefined && !Array.isArray(stored) && !isObject(stored)) {
          reject(command, `cannot insert into ${typeof stored}`)
          continue
        }
        if (command.args.length === 2) {
          const value = evaluateLiteral(command.args[1] as string)
          if (Array.isArray(stored)) set(data.stat_data, path, [...stored, value])
          else if (isObject(stored) && isObject(value)) {
            set(data.stat_data, path, { ...(stored as Record<string, unknown>), ...(value as Record<string, unknown>) })
          } else if (stored === undefined || stored === null) set(data.stat_data, path, [value])
          else {
            reject(command, 'merging into an object needs an object value')
            continue
          }
        } else {
          const key = evaluateLiteral(command.args[1] as string)
          const value = evaluateLiteral(command.args[2] as string)
          if (Array.isArray(stored) && typeof key === 'number') {
            const next = [...stored]
            next.splice(key, 0, value)
            set(data.stat_data, path, next)
          } else if (isObject(stored) && !Array.isArray(stored)) {
            set(data.stat_data, path, { ...(stored as Record<string, unknown>), [String(key)]: value })
          } else if (stored === undefined || stored === null) {
            set(data.stat_data, path, { [String(key)]: value })
          } else {
            reject(command, `cannot insert at a key into ${typeof stored}`)
            continue
          }
        }
        break
      }

      case 'delete': {
        const segments = toPath(path)
        const last = segments[segments.length - 1]

        // `_.remove('队伍[1]')` means "drop element 1", not "leave a hole".
        if (command.args.length === 1 && last !== undefined && /^\d+$/.test(last)) {
          const containerPath = joinPath(segments.slice(0, -1))
          const container = containerPath === '' ? data.stat_data : get(data.stat_data, containerPath)
          const index = Number(last)
          if (Array.isArray(container) && index < container.length) {
            const next = container.filter((_item, at) => at !== index)
            if (containerPath === '') data.stat_data = next as unknown as Record<string, unknown>
            else set(data.stat_data, containerPath, next)
            changed = true
            display_data[path] = renderChange(container[index], undefined, command.reason)
            continue
          }
        }

        if (!has(data.stat_data, path)) {
          reject(command, `path "${path}" does not exist`)
          continue
        }

        if (command.args.length === 1) {
          unset(data.stat_data, path)
        } else {
          const which = evaluateLiteral(command.args[1] as string)
          if (Array.isArray(stored)) {
            const index = typeof which === 'number' ? which : stored.indexOf(which)
            if (index < 0 || index >= stored.length) {
              reject(command, `no element ${String(which)} in "${path}"`)
              continue
            }
            set(data.stat_data, path, stored.filter((_item, at) => at !== index))
          } else if (isObject(stored)) {
            const next = { ...(stored as Record<string, unknown>) }
            if (!(String(which) in next)) {
              reject(command, `no key ${String(which)} in "${path}"`)
              continue
            }
            delete next[String(which)]
            set(data.stat_data, path, next)
          } else {
            reject(command, `cannot remove a member of ${typeof stored}`)
            continue
          }
        }
        break
      }

      case 'move': {
        reject(command, 'move is only reachable through the JSON Patch dialect')
        continue
      }
    }

    changed = true
    const settled = command.type === 'delete' && command.args.length === 1
      ? undefined
      : displayValue(path === '' ? data.stat_data : get(data.stat_data, path))
    display_data[path] = renderChange(before, settled, command.reason)
  }

  return { data, display_data, failures, changed }
}
