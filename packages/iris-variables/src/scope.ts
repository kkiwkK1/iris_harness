/**
 * Variable scopes.
 *
 * The seven-way split is not ours — it is Tavern Helper's public surface, and
 * community cards address scopes by these exact strings. Each one is a
 * different lifetime and a different storage medium, which is why a card that
 * writes `{type:'message'}` survives a regeneration while `{type:'chat'}` does
 * not.
 *
 * @module @iris/variables/scope
 */

/** Scopes addressed by name alone. */
export interface NormalScope {
  type: 'chat' | 'preset' | 'global'
}

/** The open character card's own store. */
export interface CharacterScope {
  type: 'character'
}

/**
 * One turn's variables.
 *
 * SillyTavern keys these by `chat[i].variables[swipe_id]` — an array parallel
 * to the swipe list, which is what keeps state consistent when the user
 * regenerates. Iris keys them by candidate instead, because a candidate *is* a
 * swipe here (see `@iris/chat`).
 */
export interface MessageScope {
  type: 'message'
  /**
   * Turn to address. Negative values index from the end (`-1` is the latest);
   * `'latest'` and omission both mean the newest turn.
   */
  message_id?: number | 'latest'
}

/** One script's private store. */
export interface ScriptScope {
  type: 'script'
  script_id?: string
}

/** One extension's settings-backed store. */
export interface ExtensionScope {
  type: 'extension'
  extension_id: string
}

/** Any addressable variable store. */
export type VariableOption =
  | NormalScope
  | CharacterScope
  | MessageScope
  | ScriptScope
  | ExtensionScope

/** A variable table: plain JSON, addressed by lodash-style paths. */
export type Variables = Record<string, unknown>

/** Raised when a scope cannot be resolved to a store. */
export class VariableScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VariableScopeError'
  }
}
