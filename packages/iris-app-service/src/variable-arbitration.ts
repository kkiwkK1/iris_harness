/**
 * One message-variable transaction shared by reply processors.
 *
 * ST-Prompt-Template is registered with `makeFirst` on
 * `CHARACTER_MESSAGE_RENDERED`; card scripts such as MVU run afterwards. Iris
 * therefore applies proposals in that order. Each processor returns a complete
 * table, but only its changes from the common inherited baseline participate:
 * this preserves disjoint writes and prevents a later complete-table snapshot
 * from erasing an earlier processor's unrelated keys.
 */

import type { Variables } from '@iris/variables'

export interface VariableProposal {
  pluginId: string
  before: Variables
  after: Variables
}

export interface VariableConflict {
  key: string
  earlierPluginId: string
  laterPluginId: string
  winnerPluginId: string
}

export interface VariableArbitration {
  variables: Variables
  conflicts: VariableConflict[]
}

interface Change {
  path: string[]
  deleted: boolean
  value?: unknown
}

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => same(value, right[index]))
  }
  if (!plain(left) || !plain(right)) return false
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (own(left, key) !== own(right, key) || !same(left[key], right[key])) return false
  }
  return true
}

function changes(before: unknown, after: unknown, path: string[] = []): Change[] {
  if (same(before, after)) return []
  if (plain(before) && plain(after)) {
    const result: Change[] = []
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!own(after, key)) result.push({ path: [...path, key], deleted: true })
      else if (!own(before, key)) result.push({ path: [...path, key], deleted: false, value: after[key] })
      else result.push(...changes(before[key], after[key], [...path, key]))
    }
    return result
  }
  return [{ path, deleted: false, value: after }]
}

function detached<T>(value: T): T {
  return structuredClone(value)
}

function setAt(target: Variables, change: Change): void {
  if (change.path.length === 0) return
  let cursor: Record<string, unknown> = target
  for (const segment of change.path.slice(0, -1)) {
    const child = cursor[segment]
    if (!plain(child)) cursor[segment] = {}
    cursor = cursor[segment] as Record<string, unknown>
  }
  const leaf = change.path.at(-1)!
  if (change.deleted) delete cursor[leaf]
  else cursor[leaf] = detached(change.value)
}

function overlaps(left: string[], right: string[]): boolean {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Apply processor deltas in upstream order and describe every overwritten path. */
export function arbitrateMessageVariables(
  baseline: Variables,
  proposals: readonly VariableProposal[],
): VariableArbitration {
  const variables = detached(baseline)
  const applied: Array<{ pluginId: string, path: string[] }> = []
  const conflicts: VariableConflict[] = []

  for (const proposal of proposals) {
    for (const change of changes(proposal.before, proposal.after)) {
      const earlier = [...applied].reverse().find(item => overlaps(item.path, change.path))
      if (earlier !== undefined && earlier.pluginId !== proposal.pluginId) {
        conflicts.push({
          key: change.path.join('.'),
          earlierPluginId: earlier.pluginId,
          laterPluginId: proposal.pluginId,
          winnerPluginId: proposal.pluginId,
        })
      }
      setAt(variables, change)
      applied.push({ pluginId: proposal.pluginId, path: change.path })
    }
  }
  return { variables, conflicts }
}
