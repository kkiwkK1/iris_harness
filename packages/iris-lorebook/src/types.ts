/**
 * The SillyTavern world-book data contract.
 *
 * None of this is designed; it is transcribed. Every field name and every
 * numeric value below is what community books, character cards and the
 * `TavernHelper` API already carry on disk, so an "equivalent but tidier"
 * spelling is indistinguishable from a bug the first time a real book is
 * loaded.
 *
 * Two shapes exist in the wild and they are not the same:
 *
 *  - **The ST storage shape** — `{ entries: { "0": Entry } }`, an object keyed
 *    by stringified uid. This is what circulates as a downloadable world book.
 *  - **The card spec shape** (`character_book`) — `entries` is an array with
 *    snake_case field names. This is what V2/V3 character cards embed.
 *
 * `parse.ts` accepts both; everything downstream of it speaks the first.
 *
 * @module @iris/lorebook/types
 */

/**
 * Where an activated entry goes in the assembled prompt.
 *
 * The numbers are persisted, so they are the contract — `atDepth` is 4 forever,
 * whatever the enum is called next year.
 */
export const worldInfoPosition = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
} as const

/** A known `position` value. */
export type WorldInfoPosition = (typeof worldInfoPosition)[keyof typeof worldInfoPosition]

/**
 * How secondary keys qualify a primary-key hit.
 *
 * `AND_ANY` is 0 and therefore the value a book gets when the field is missing,
 * which is why it is also the semantic default.
 */
export const worldInfoLogic = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
} as const

/** A known `selectiveLogic` value. */
export type WorldInfoLogic = (typeof worldInfoLogic)[keyof typeof worldInfoLogic]

/** Which side of the example-messages block an `EMTop`/`EMBottom` entry lands on. */
export const anchorPosition = {
  before: 0,
  after: 1,
} as const

/** A known anchor position. */
export type AnchorPosition = (typeof anchorPosition)[keyof typeof anchorPosition]

/** The message role an `atDepth` injection is written as. Shared with ST's `extension_prompt_roles`. */
export const promptRole = {
  SYSTEM: 0,
  USER: 1,
  ASSISTANT: 2,
} as const

/** A known injection role. */
export type PromptRole = (typeof promptRole)[keyof typeof promptRole]

/** Entry `order` when the field is absent. */
export const DEFAULT_ORDER = 100

/** Entry `depth` when the field is absent — four messages up from the end. */
export const DEFAULT_DEPTH = 4

/** Entry `groupWeight` when the field is absent. */
export const DEFAULT_WEIGHT = 100

/** Hard ceiling on how far back a scan may look, matching ST's `MAX_SCAN_DEPTH`. */
export const MAX_SCAN_DEPTH = 1000

/**
 * Restricts an entry to (or excludes it from) a set of characters.
 *
 * `isExclude` flips the whole test rather than negating each list, so an entry
 * with both `names` and `tags` populated is filtered when *either* list would
 * have admitted it.
 */
export interface CharacterFilter {
  /** Invert the match: listed characters are the ones that must *not* see this entry. */
  isExclude: boolean
  /** Character card filenames. */
  names: string[]
  /** Tag keys. */
  tags: string[]
}

/**
 * One world-book entry, normalized.
 *
 * Every field is required because `parseLorebook` fills the defaults up front,
 * the way ST's `addMissingWorldInfoFields` does. That is what lets the
 * activation engine read `entry.probability` without a `??` on every line, and
 * it is also how a book saved by Iris stays legible to ST.
 *
 * `position`, `selectiveLogic` and `role` are typed `number`, not their union
 * types, on purpose: books in the wild carry values from ST forks and from
 * builds newer than this one, and a model that refuses them would silently drop
 * data on a round trip. The unions are exported for `switch` statements.
 *
 * The index signature is load-bearing — unknown keys are how the ST ecosystem
 * carries per-extension state, and discarding them is the fastest way to break
 * somebody's card.
 */
export interface LorebookEntry {
  /** Identity within the book. Also the key this entry is stored under. */
  uid: number
  /** Primary keywords. A hit on any one of them is what starts an activation. */
  key: string[]
  /** Secondary keywords, combined with the primary hit by `selectiveLogic`. */
  keysecondary: string[]
  /** Title shown in the editor. Never reaches the prompt — but MVU's `[InitVar]` matches on it. */
  comment: string
  /** The text injected into the prompt. */
  content: string
  /** Activate on every scan without matching anything. */
  constant: boolean
  /** Reserved for vector-store retrieval instead of keyword scanning; the keyword engine ignores it. */
  vectorized: boolean
  /** Whether `keysecondary` is consulted at all. */
  selective: boolean
  /** One of {@link worldInfoLogic}. */
  selectiveLogic: number
  /** Sort weight. Higher wins ties and is emitted closer to the chat. */
  order: number
  /** One of {@link worldInfoPosition}. */
  position: number
  /** Skip this entry entirely. */
  disable: boolean
  /** Do not let a recursion pass activate this entry. */
  excludeRecursion: boolean
  /** Do not let this entry's content trigger further recursion. */
  preventRecursion: boolean
  /**
   * Hold this entry back until the given recursion level.
   *
   * `true` means level 1. The levels are walked in ascending order, so an entry
   * at level 2 cannot fire until every level-1 entry has had its turn.
   */
  delayUntilRecursion: number | boolean
  /** Percentage chance of surviving the roll, 0–100. */
  probability: number
  /** Whether `probability` is rolled at all. */
  useProbability: boolean
  /** For `position: atDepth`, how many messages up from the end to inject. */
  depth: number
  /** Comma-separated inclusion groups. Only one entry per group survives a scan. */
  group: string
  /** Win the group outright instead of entering the weighted draw. */
  groupOverride: boolean
  /** Relative weight in the group's draw. */
  groupWeight: number
  /** Per-entry scan depth override; `null` defers to the global setting. */
  scanDepth: number | null
  /** Per-entry case sensitivity override; `null` defers to the global setting. */
  caseSensitive: boolean | null
  /** Per-entry whole-word override; `null` defers to the global setting. */
  matchWholeWords: boolean | null
  /** Per-entry group-scoring override; `null` defers to the global setting. */
  useGroupScoring: boolean | null
  /** Identifier an automation (quick reply, STscript) can key off. */
  automationId: string
  /** One of {@link promptRole}, used by `position: atDepth`. */
  role: number
  /** Stay active for this many further messages once activated. */
  sticky: number | null
  /** Cannot re-activate for this many messages after activating. */
  cooldown: number | null
  /** Cannot activate until the chat is at least this many messages long. */
  delay: number | null
  /** Manual ordering in the editor. No effect on activation. */
  displayIndex: number
  /** Character allow/deny list. */
  characterFilter: CharacterFilter
  /** Bypass the token budget. */
  ignoreBudget: boolean
  /** Target name for `position: outlet`. */
  outletName: string
  /** Generation types this entry may fire on; empty means all of them. */
  triggers: string[]
  /** Whether the editor shows the comment. Carried for round-trip fidelity only. */
  addMemo: boolean
  /** Also scan the user persona description. */
  matchPersonaDescription: boolean
  /** Also scan the character description. */
  matchCharacterDescription: boolean
  /** Also scan the character personality. */
  matchCharacterPersonality: boolean
  /** Also scan the character's depth prompt / character notes. */
  matchCharacterDepthPrompt: boolean
  /** Also scan the scenario. */
  matchScenario: boolean
  /** Also scan the creator notes. */
  matchCreatorNotes: boolean
  /** Unknown keys, preserved verbatim. */
  [key: string]: unknown
}

/**
 * A world book.
 *
 * `entries` is an object keyed by stringified uid, not an array. That is the
 * shape on disk and the shape the `/api/worldinfo` endpoints speak; treating it
 * as an array is the single most common way to corrupt one.
 */
export interface Lorebook {
  /** Entries keyed by stringified uid. */
  entries: Record<string, LorebookEntry>
  /** Unknown top-level keys, preserved verbatim. */
  [key: string]: unknown
}

/** One entry of the V2/V3 card spec's `character_book`. */
export interface CharacterBookEntry {
  /** Primary keywords — `key` in the ST shape. */
  keys: string[]
  /** The injected text. */
  content: string
  /** Where every ST-specific field lives in this shape. */
  extensions: Record<string, unknown>
  /** Inverse of the ST shape's `disable`. */
  enabled: boolean
  /** `order` in the ST shape. */
  insertion_order: number
  /** Unknown keys, preserved verbatim. */
  [key: string]: unknown
}

/** The V2/V3 card spec's embedded world book. */
export interface CharacterBook {
  /** Entries as an array — the difference that breaks naive importers. */
  entries: CharacterBookEntry[]
  /** Book-level extension payload. */
  extensions: Record<string, unknown>
  /** Unknown keys, preserved verbatim. */
  [key: string]: unknown
}
