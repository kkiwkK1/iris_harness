/**
 * The character card data model, across all three specs in circulation.
 *
 * The shapes here are deliberately permissive. Every object a card author can
 * reach carries an index signature, because the one thing a card importer must
 * never do is drop a key it did not recognise: `data.extensions` is where the
 * whole SillyTavern extension ecosystem keeps its per-character state, and a
 * card that loses `chub.full_path` or a `tavern_helper` script tree on import
 * has been quietly damaged in a way its author will notice and we cannot undo.
 *
 * The named members are therefore documentation of the vocabulary in use, not
 * a validation contract — nothing in this package checks that `regex_scripts`
 * really is an array before preserving it. Preservation beats validation at
 * this layer; validation belongs to whoever actually consumes a field.
 *
 * @module @iris/character/types
 */

/** The `spec` discriminator written into V2 and V3 cards. */
export type CardSpec = 'chara_card_v2' | 'chara_card_v3'

/** Which conversational role a depth-injected prompt is attributed to. */
export type PromptRole = 'system' | 'user' | 'assistant'

/**
 * The character's author's note, injected N messages from the end.
 *
 * Depth is counted from the tail of the chat, so `depth: 4` means "four
 * messages back" — the field predates the V2 spec and lives in `extensions`
 * rather than `data` for that reason.
 */
export interface DepthPrompt {
  depth: number
  prompt: string
  role: PromptRole
}

/** One entry of the per-character regex script list. */
export interface RegexScriptData {
  id: string
  scriptName: string
  findRegex: string
  replaceString: string
  trimStrings: string[]
  /** Which text streams the script rewrites; values are SillyTavern placement ids. */
  placement: number[]
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
  runOnEdit: boolean
  substituteRegex: number
  minDepth: number
  maxDepth: number
  [key: string]: unknown
}

/**
 * The `data.extensions` bag.
 *
 * Split three ways: fields SillyTavern itself reads, fields other front-ends
 * and import pipelines stamp in, and — via the index signature — everything
 * nobody has told us about yet. All three survive a round trip identically;
 * only the first group is ever interpreted.
 */
export interface CardExtensions {
  /** 0–1 bias for how often the character speaks unprompted in a group chat. */
  talkativeness?: number
  /** Favourite flag. Local UI state that nonetheless ships inside shared cards. */
  fav?: boolean
  /** Name of the world-info book this character auto-activates. */
  world?: string
  depth_prompt?: DepthPrompt
  regex_scripts?: RegexScriptData[]
  /** JS-Slash-Runner's script tree. Its shape belongs to `@iris/script-host`. */
  tavern_helper?: unknown
  /** Pre-`tavern_helper` field name for the same script tree; still in the wild. */
  TavernHelper_scripts?: unknown

  // Provenance stamped by the sites and tools cards pass through. None of it
  // is specified anywhere; it is simply what the ecosystem writes.
  /** Chub/Venus. */
  chub?: { full_path?: string, [key: string]: unknown }
  /** RisuAI. */
  risuai?: { source?: string[], [key: string]: unknown }
  /** Pygmalion.chat's character id. */
  pygmalion_id?: string
  github_repo?: string
  source_url?: string
  /** Stable Diffusion prompt pair used by the image-generation extension. */
  sd_character_prompt?: { positive?: string, negative?: string, [key: string]: unknown }

  [key: string]: unknown
}

/**
 * One world-info entry in the *spec* shape.
 *
 * Note this is not the shape SillyTavern stores world books in — that one is
 * `{ entries: { "0": {...} } }` keyed by uid, with different field names
 * (`keysecondary`, `order`, numeric `position`). Cards carry the spec shape;
 * translating between the two is `@iris/lorebook`'s job.
 */
export interface CharacterBookEntry {
  keys: string[]
  content: string
  extensions: Record<string, unknown>
  enabled: boolean
  insertion_order: number
  case_sensitive?: boolean
  name?: string
  priority?: number
  id?: number
  comment?: string
  selective?: boolean
  secondary_keys?: string[]
  constant?: boolean
  /** Spec-shape position is a string; the ST-shape equivalent is a number. */
  position?: 'before_char' | 'after_char'
  /** V3: treat `keys` as regular expressions rather than literals. */
  use_regex?: boolean
  [key: string]: unknown
}

/** A world-info book embedded in a card. */
export interface CharacterBook {
  name?: string
  description?: string
  scan_depth?: number
  token_budget?: number
  recursive_scanning?: boolean
  extensions: Record<string, unknown>
  entries: CharacterBookEntry[]
  [key: string]: unknown
}

/**
 * A V3 embedded asset.
 *
 * `uri` may be `embeded://` (the misspelling is RisuAI's and is now load-bearing),
 * `ccdefault:`, an http(s) URL, or a data URI. Only CHARX archives can actually
 * satisfy an `embeded://` reference; in a PNG card such an asset is dangling.
 */
export interface CardAsset {
  type: string
  uri: string
  name: string
  /** File extension without the dot. */
  ext: string
  [key: string]: unknown
}

/**
 * The card body — everything under `data` in a V2 or V3 card.
 *
 * V2 fields are required because normalisation supplies defaults for all of
 * them; V3 additions stay optional so that a V2 card does not acquire empty
 * V3 fields it never had.
 */
export interface CardData {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  /** Author-facing notes. Must never reach the model. */
  creator_notes: string
  system_prompt: string
  post_history_instructions: string
  alternate_greetings: string[]
  character_book?: CharacterBook
  tags: string[]
  creator: string
  character_version: string
  extensions: CardExtensions

  /** V3: substituted for `{{char}}` in place of `name`. */
  nickname?: string
  /** V3: creator notes keyed by ISO 639-1 language code. */
  creator_notes_multilingual?: Record<string, string>
  /** V3: where the card came from — URLs or opaque ids. */
  source?: string[]
  /** V3: greetings offered only in group chats. */
  group_only_greetings?: string[]
  /** V3: Unix milliseconds. */
  creation_date?: number
  /** V3: Unix milliseconds. */
  modification_date?: number
  assets?: CardAsset[]

  [key: string]: unknown
}

/**
 * A normalised card: one internal shape for V1, V2 and V3 input.
 *
 * The index signature holds top-level keys that are neither spec machinery nor
 * V1 mirrors of `data` — `create_date`, `avatar`, and whatever a given exporter
 * decided to staple on. They are carried through untouched.
 */
export interface CharacterCard {
  spec: CardSpec
  spec_version: string
  data: CardData
  [key: string]: unknown
}

/**
 * A card as it is serialised into a PNG chunk or a `.json` file.
 *
 * The V1 mirror fields are not vestigial: SillyTavern's own `charaFormatData`
 * writes them alongside `data` on every save, and V1-era readers see nothing
 * else. Emitting both is what makes an exported card readable everywhere.
 */
export interface CardFile {
  spec: CardSpec
  spec_version: string
  data: CardData
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  /** The V1 spelling of `data.creator_notes`. */
  creatorcomment: string
  tags: string[]
  talkativeness: number
  fav: boolean
  [key: string]: unknown
}
