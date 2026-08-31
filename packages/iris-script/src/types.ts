/**
 * What a card's scripts look like once the storage shape is behind us.
 *
 * @module @iris/script/types
 */

/**
 * Where a script runs, as the card declares it.
 *
 * Upstream distinguishes a script bound to the character from one the user
 * installed globally. Only the character kind can arrive inside a card, but the
 * field is carried through rather than dropped: an import that discards it
 * cannot round-trip, and export fidelity is the whole reason these types are
 * shaped like the file rather than like Iris.
 */
export type ScriptType = 'script' | 'global' | string

/** One script, normalized out of whichever shape the card stored it in. */
export interface CardScript {
  /** The card author's identifier. Stable across exports; used for grants. */
  id: string
  /** Display name, as the card's own script manager showed it. */
  name: string
  type: ScriptType
  /**
   * Whether the card's author had this script switched on.
   *
   * Honoured, not ignored. A disabled script still ships inside the card, and
   * running it because it is present executes code its own author turned off.
   */
  enabled: boolean
  /** The script body. Usually webpack output containing `eval` per module. */
  content: string
  /** Author's notes, shown in a script list. */
  info?: string
  /**
   * A button the script asks the shell to show for it.
   *
   * Passed through untouched: the shape is upstream's and a card that round
   * trips through Iris must come out the way it went in.
   */
  button?: unknown
  /** Script-defined storage, opaque to Iris. */
  data?: unknown
  /** Which parts upstream exports with the card. */
  exportWith?: unknown
}

/** Everything script-related a card carries. */
export interface CardScriptBundle {
  scripts: CardScript[]
  /**
   * Initial variables the card ships beside its scripts.
   *
   * Distinct from a lorebook's or MVU's initial state: these belong to the
   * script runtime, and a card can rely on them existing before its first
   * script line runs.
   */
  variables: Record<string, unknown>
  /**
   * Shapes that were present but could not be read.
   *
   * Reported rather than thrown, because one unreadable script must not cost
   * the user the rest of the card. A caller that wants to be loud can be; the
   * importer's job is to salvage.
   */
  skipped: { reason: string, detail?: string }[]
}
