/**
 * The variable store.
 *
 * Each scope is a different lifetime backed by a different medium, so the store
 * owns the semantics and delegates storage. That split is what lets the message
 * scope live in the append-only chat log — the one place state can be
 * swipe-consistent — while global settings live in a settings file, without the
 * card-facing API knowing the difference.
 *
 * @module @iris/variables/store
 */

import { deletePath, detach, insertMissing, insertOrAssign, type DeleteResult } from './semantics.ts'
import { VariableScopeError, type VariableOption, type Variables } from './scope.ts'

/** Where one scope's variables actually live. */
export interface ScopeBackend {
  /**
   * @param option - the full scope selector, including `message_id` / `script_id`.
   * @returns the stored table; an absent store reads as empty.
   */
  read(option: VariableOption): Variables
  /**
   * @param option - the full scope selector.
   * @param next - the complete replacement table.
   */
  write(option: VariableOption, next: Variables): void
}

/** Scope name to backend. A scope with no backend is unavailable, not empty. */
export type ScopeBackends = Partial<Record<VariableOption['type'], ScopeBackend>>

/**
 * A backend holding one table in memory.
 *
 * Enough on its own for the global, preset, character and extension scopes in
 * tests and in a headless run; a deployment swaps in a persisted one.
 * @param initial - starting contents.
 * @returns the backend.
 */
export function memoryBackend(initial: Variables = {}): ScopeBackend {
  let table = detach(initial)
  return {
    read: () => table,
    write: (_option, next) => { table = next },
  }
}

/**
 * A backend keyed by an id carried on the scope selector.
 *
 * The script and extension scopes are one table per owner, so the key comes
 * from the selector rather than from which backend was chosen.
 * @param keyOf - reads the owning id out of the selector.
 * @returns the backend.
 */
export function keyedMemoryBackend(keyOf: (option: VariableOption) => string): ScopeBackend {
  const tables = new Map<string, Variables>()
  return {
    read: option => tables.get(keyOf(option)) ?? {},
    write: (option, next) => { tables.set(keyOf(option), next) },
  }
}

/**
 * The card-facing variable API.
 *
 * Method names and shapes match Tavern Helper's, because community cards call
 * them by name.
 */
export class VariableStore {
  readonly #backends: ScopeBackends

  /**
   * @param backends - storage for each scope this deployment supports.
   */
  constructor(backends: ScopeBackends) {
    this.#backends = backends
  }

  /** Resolve a scope to its backend, or say plainly that it is unavailable. */
  #backend(option: VariableOption): ScopeBackend {
    const backend = this.#backends[option.type]
    if (backend === undefined) {
      throw new VariableScopeError(`the "${option.type}" variable scope is not available here`)
    }
    return backend
  }

  /**
   * Read a variable table.
   * @param option - which scope.
   * @returns a detached copy — mutating it changes nothing until it is written back.
   */
  getVariables(option: VariableOption): Variables {
    return detach(this.#backend(option).read(option))
  }

  /**
   * Replace a variable table outright.
   * @param variables - the complete new table.
   * @param option - which scope.
   */
  replaceVariables(variables: Variables, option: VariableOption): void {
    this.#backend(option).write(option, detach(variables))
  }

  /**
   * Transform a table with a function.
   * @param updater - receives a detached table and returns the new one.
   * @param option - which scope.
   * @returns the stored result.
   */
  updateVariablesWith(updater: (variables: Variables) => Variables, option: VariableOption): Variables {
    const next = updater(this.getVariables(option))
    this.replaceVariables(next, option)
    return this.getVariables(option)
  }

  /**
   * Merge values in, letting the incoming value win.
   * @param variables - values to apply.
   * @param option - which scope.
   * @returns the stored result.
   */
  insertOrAssignVariables(variables: Variables, option: VariableOption): Variables {
    const backend = this.#backend(option)
    const next = insertOrAssign(backend.read(option), variables)
    backend.write(option, next)
    return detach(next)
  }

  /**
   * Merge values in only where nothing is set yet.
   * @param variables - values to apply.
   * @param option - which scope.
   * @returns the stored result.
   */
  insertVariables(variables: Variables, option: VariableOption): Variables {
    const backend = this.#backend(option)
    const next = insertMissing(backend.read(option), variables)
    backend.write(option, next)
    return detach(next)
  }

  /**
   * Remove one path.
   * @param variable_path - lodash path to remove.
   * @param option - which scope.
   * @returns the new table and whether anything was there.
   */
  deleteVariable(variable_path: string, option: VariableOption): DeleteResult {
    const backend = this.#backend(option)
    const result = deletePath(backend.read(option), variable_path)
    if (result.delete_occurred) backend.write(option, result.variables)
    return result
  }

  /**
   * Every scope's variables merged into one view.
   *
   * The precedence chain is Tavern Helper's: global, then character, then
   * script, then chat, then the message scope last — nearest to the turn wins.
   * @param option - the message scope selector deciding which turn to read.
   * @returns the merged table.
   */
  getAllVariables(option: VariableOption = { type: 'chat' }): Variables {
    const order: VariableOption[] = [
      { type: 'global' },
      { type: 'character' },
      ...option.type === 'script' ? [option] : [],
      { type: 'chat' },
      ...option.type === 'message' ? [option] : [],
    ]

    let merged: Variables = {}
    for (const scope of order) {
      if (this.#backends[scope.type] === undefined) continue
      merged = insertOrAssign(merged, this.#backend(scope).read(scope))
    }
    return merged
  }
}
