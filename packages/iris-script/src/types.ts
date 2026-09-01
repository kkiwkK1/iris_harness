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

/**
 * One button a script offers.
 *
 * `visible` is the author's own choice about whether it shows, and it is `false`
 * far more often than not — see {@link CardScript.buttons}.
 */
export interface ScriptButton {
  name: string
  visible: boolean
}

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
   * The button block exactly as the card stores it.
   *
   * Passed through untouched: the shape is upstream's and a card that round
   * trips through Iris must come out the way it went in. {@link buttons} is the
   * read of it; this is the copy that gets written back.
   */
  button?: unknown
  /**
   * The buttons this script asks the shell to show, parsed.
   *
   * Upstream's shape, transcribed from `JS-Slash-Runner/src/type/scripts.ts`:
   * `button: { enabled: boolean, buttons: { name: string, visible: boolean }[] }`.
   * Measured against the corpus independently by two of us and agreeing to the
   * entry: 48 script entries all carry exactly `{enabled, buttons}`, and all 89
   * buttons carry exactly `{name, visible}` — no icon, no id, no tooltip. A
   * button is identified **by its position** in this array and nothing else.
   *
   * **`visible: false` is the common case, not the exception**: 58 of the 89.
   * A panel that renders everything here shows a pile of controls their authors
   * deliberately hid.
   */
  buttons?: ScriptButton[]
  /**
   * Whether the card's author left this script's button group switched on.
   *
   * Upstream's `button.enabled`, distinct from each button's own `visible`.
   * 47 of 48 in the corpus are `true`, so the one that is not is the whole
   * reason to carry it rather than assume it.
   */
  buttonsEnabled?: boolean
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
