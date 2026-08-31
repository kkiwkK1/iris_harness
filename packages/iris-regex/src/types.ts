/**
 * The regex-script vocabulary.
 *
 * Numbers, not names, because a card stores these as integers and community
 * cards carry them verbatim. Reordering or renumbering would silently change
 * which text every existing script applies to.
 *
 * @module @iris/regex/types
 */

/**
 * Where a string is on its way to or from.
 *
 * `4` is missing on purpose — it was `sendAs` and was retired, and `0` is
 * retained only so an old script naming it still parses.
 */
export const PLACEMENT = {
  /** @deprecated Retired upstream; kept so old scripts still load. */
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
} as const

/** One placement value. */
export type Placement = (typeof PLACEMENT)[keyof typeof PLACEMENT]

/** How macros in the *find* pattern are handled. */
export const SUBSTITUTE = {
  /** The pattern is used as written. */
  NONE: 0,
  /** Macros expand, and whatever they expand to is treated as regex syntax. */
  RAW: 1,
  /** Macros expand and their values are escaped, so a name containing `.` matches literally. */
  ESCAPED: 2,
} as const

/** One substitution mode. */
export type SubstituteMode = (typeof SUBSTITUTE)[keyof typeof SUBSTITUTE]

/**
 * Script priority by owner.
 *
 * The numeric order is the run order: global first, then the character's own,
 * then the preset's. A card that ships a script expects to run after the user's
 * global ones.
 */
export const SCRIPT_TYPE = {
  GLOBAL: 0,
  SCOPED: 1,
  PRESET: 2,
} as const

/** One script owner. */
export type ScriptType = (typeof SCRIPT_TYPE)[keyof typeof SCRIPT_TYPE]

/**
 * One regex script, in the shape a character card stores under
 * `data.extensions.regex_scripts`.
 */
export interface RegexScript {
  id?: string
  scriptName?: string
  /** Pattern, either bare or in `/pattern/flags` form. */
  findRegex: string
  /** Replacement. `{{match}}`, `$0`, `$1`, `$<name>` and macros are all honoured. */
  replaceString: string
  /** Substrings stripped from each captured value before it is substituted in. */
  trimStrings?: string[]
  /** Which placements this script applies to. */
  placement?: number[]
  disabled?: boolean
  /**
   * Apply only when rendering for display.
   *
   * One half of the pair that makes this feature worth having: a display-only
   * script changes what the reader sees and leaves the stored message alone.
   */
  markdownOnly?: boolean
  /**
   * Apply only when building the outgoing prompt.
   *
   * The other half. This is what hides a block from the model without erasing
   * it from the chat — the reason an MVU card can strip `<UpdateVariable>` from
   * the next request while the command history stays on disk.
   */
  promptOnly?: boolean
  /** Also apply when the user edits a message by hand. */
  runOnEdit?: boolean
  substituteRegex?: number
  /** Skip when the message is shallower than this. `-1` and above are honoured. */
  minDepth?: number | null
  /** Skip when the message is deeper than this. `0` and above are honoured. */
  maxDepth?: number | null
  [key: string]: unknown
}

/** What the caller knows about the string being processed. */
export interface RegexParams {
  /** Character name used when expanding macros in trim strings. */
  characterOverride?: string
  /** The string is headed for display. */
  isMarkdown?: boolean
  /** The string is headed for the model. */
  isPrompt?: boolean
  /** The user is editing by hand. */
  isEdit?: boolean
  /** How far from the end of the conversation this message sits. */
  depth?: number
}

/**
 * Expands `{{macros}}`.
 *
 * Injected rather than imported so this package stays pure: macro expansion
 * needs a character, a persona and a chat, none of which a regex engine should
 * know about.
 */
export type MacroSubstitute = (
  text: string,
  options?: {
    /** Applied to each expanded value — used to escape regex metacharacters. */
    postProcess?: (value: string) => string
    characterOverride?: string
  },
) => string
