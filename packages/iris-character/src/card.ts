/**
 * Normalisation between the three card specs and one internal shape.
 *
 * The rule that governs every decision here is that a card is *someone else's
 * data*. We read V1, V2 and V3, we guarantee the V2 field set exists so callers
 * need no defaulting of their own, and we touch nothing else — unknown keys in
 * `data`, in `data.extensions`, and at the top level all come out the far side
 * byte-identical. That is the whole compatibility promise of the package.
 *
 * Two places deliberately diverge from SillyTavern's `charaFormatData`:
 *
 *  - **`fav`.** Upstream computes `data.fav == 'true'`, which is correct for a
 *    string arriving from its edit form but silently turns a JSON card's real
 *    `fav: true` into `false`. We accept both spellings.
 *  - **`creator_notes`.** Upstream reads only the V1 spelling `creatorcomment`.
 *    Several exporters write a top-level `creator_notes` instead, so we fall
 *    back to it rather than discarding the author's notes.
 *
 * @module @iris/character/card
 */

import type {
  CardData,
  CardExtensions,
  CardFile,
  CardSpec,
  CharacterBook,
  CharacterCard,
  DepthPrompt,
  PromptRole,
} from './types.ts'

/** Raised when input cannot be read as a character card at all. */
export class CharacterCardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CharacterCardError'
  }
}

/**
 * Top-level keys that {@link toV2} and {@link toV3} regenerate from `data`.
 *
 * They are dropped on the way in rather than preserved: keeping a second copy
 * of `name` next to `data.name` is how V1 mirrors drift out of sync, which is
 * the exact mismatch SillyTavern's `readFromV2` logs warnings about.
 */
const REGENERATED_KEYS = new Set([
  'spec',
  'spec_version',
  'data',
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creatorcomment',
  'tags',
  'talkativeness',
  'fav',
  // SillyTavern stashes the card's own source JSON here on save. Carrying it
  // forward would nest a copy of the card inside itself on every round trip.
  'json_data',
])

/**
 * Additional top-level keys consumed when the input is a flat V1 card.
 *
 * In a V1 card these are the only copy of the field, so they are read into
 * `data` and then dropped. In a V2/V3 card the same names at the top level
 * would be something else's data, so they are left alone.
 */
const V1_CONSUMED_KEYS = new Set([
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'character_book',
  'creator',
  'character_version',
  'extensions',
  'world',
  'depth_prompt_prompt',
  'depth_prompt_depth',
  'depth_prompt_role',
])

/** Whether a value is a plain keyed object rather than an array or primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a string field, defaulting rather than throwing on the wrong type. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Read a numeric field, tolerating the numeric strings that HTML forms produce. */
function num(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

/**
 * Read a string list, accepting the comma-joined form cards sometimes carry.
 * @param value - the raw field.
 * @returns a list of strings; never the input array itself.
 */
function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  // A lone string is the singular case of the list, not a character sequence.
  if (typeof value === 'string') return value === '' ? [] : [value]
  return []
}

/** Tags additionally accept a comma-separated string, as SillyTavern's form posts them. */
function tagList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(',').map(tag => tag.trim()).filter(tag => tag !== '')
  }
  return strList(value)
}

/** Accept both the JSON boolean and the form-encoded `"true"` upstream expects. */
function favFlag(value: unknown): boolean {
  return value === true || value === 'true'
}

/** Coerce to one of the three roles a depth prompt may be attributed to. */
function promptRole(value: unknown): PromptRole {
  return value === 'user' || value === 'assistant' ? value : 'system'
}

/**
 * Copy the extensions bag verbatim.
 *
 * Nothing is validated and nothing is defaulted for a V2/V3 card: an absent
 * `talkativeness` means the author never set one, and inventing `0.5` here
 * would write a value into a card that did not have it.
 * @param value - the raw `data.extensions`.
 * @returns a shallow copy, or an empty bag when the field is missing.
 */
function normalizeExtensions(value: unknown): CardExtensions {
  return isRecord(value) ? { ...value } : {}
}

/**
 * Copy an embedded world book, guaranteeing only its two structural fields.
 *
 * This is the one place normalisation *adds* something: the V2 spec declares
 * `character_book.extensions` non-optional, but SillyTavern's own bundled cards
 * omit it, so a book that arrives without one leaves with an empty one. The
 * alternative — an optional `extensions` — pushes the same defaulting onto
 * every reader of a book, which is worse for a field the spec says is there.
 * @param value - the raw `data.character_book`.
 * @returns the book with `entries` and `extensions` present.
 */
function normalizeBook(value: Record<string, unknown>): CharacterBook {
  return {
    ...value,
    entries: Array.isArray(value.entries) ? [...value.entries] : [],
    extensions: isRecord(value.extensions) ? { ...value.extensions } : {},
  } as CharacterBook
}

/**
 * Normalise the `data` object of a V2 or V3 card.
 * @param raw - the raw `data` value.
 * @returns the body with every V2 field present and every unknown key intact.
 */
function normalizeBody(raw: unknown): CardData {
  const source = isRecord(raw) ? raw : {}
  // Start from a verbatim copy, then overwrite only what we guarantee. This is
  // what keeps unknown members of `data` itself — not just of `data.extensions`
  // — alive across a round trip.
  const data: Record<string, unknown> = { ...source }

  data.name = str(source.name)
  data.description = str(source.description)
  data.personality = str(source.personality)
  data.scenario = str(source.scenario)
  data.first_mes = str(source.first_mes)
  data.mes_example = str(source.mes_example)
  data.creator_notes = str(source.creator_notes)
  data.system_prompt = str(source.system_prompt)
  data.post_history_instructions = str(source.post_history_instructions)
  data.alternate_greetings = strList(source.alternate_greetings)
  data.tags = tagList(source.tags)
  data.creator = str(source.creator)
  data.character_version = str(source.character_version)
  data.extensions = normalizeExtensions(source.extensions)
  if (isRecord(source.character_book)) data.character_book = normalizeBook(source.character_book)

  // The declared members of `CardData` are a description of the vocabulary,
  // not a checked invariant — see the module note in `types.ts`. This is the
  // single point where that is asserted rather than proven.
  return data as CardData
}

/**
 * Lift a flat V1 card into a card body.
 *
 * Mirrors SillyTavern's `convertToV2` -> `charaFormatData`, including its
 * habit of materialising `talkativeness`, `fav`, `world` and `depth_prompt`
 * with defaults. Those defaults are load-bearing downstream: a missing
 * `talkativeness` reads as `0` rather than "unset" in group-chat weighting.
 * @param raw - the flat V1 card.
 * @returns the equivalent V2 body.
 */
function v1Body(raw: Record<string, unknown>): CardData {
  const extensions = normalizeExtensions(raw.extensions)

  if (extensions.talkativeness === undefined) extensions.talkativeness = num(raw.talkativeness, 0.5)
  if (extensions.fav === undefined) extensions.fav = favFlag(raw.fav)
  if (extensions.world === undefined) extensions.world = str(raw.world)
  if (extensions.depth_prompt === undefined) {
    const depthPrompt: DepthPrompt = {
      prompt: str(raw.depth_prompt_prompt),
      // 4 and 'system' are upstream's defaults; the card format has no others.
      depth: num(raw.depth_prompt_depth, 4),
      role: promptRole(raw.depth_prompt_role),
    }
    extensions.depth_prompt = depthPrompt
  }

  const data: CardData = {
    name: str(raw.name),
    description: str(raw.description),
    personality: str(raw.personality),
    scenario: str(raw.scenario),
    first_mes: str(raw.first_mes),
    mes_example: str(raw.mes_example),
    // `creatorcomment` is the V1 spelling; the V2 spelling turns up in V1 files
    // emitted by tools that half-migrated.
    creator_notes: str(raw.creatorcomment) || str(raw.creator_notes),
    system_prompt: str(raw.system_prompt),
    post_history_instructions: str(raw.post_history_instructions),
    alternate_greetings: strList(raw.alternate_greetings),
    tags: tagList(raw.tags),
    creator: str(raw.creator),
    character_version: str(raw.character_version),
    extensions,
  }

  if (isRecord(raw.character_book)) data.character_book = normalizeBook(raw.character_book)
  return data
}

/**
 * Read V1, V2 or V3 card JSON into one internal shape.
 *
 * A card counts as V1 when it has no usable `data` object — which covers both
 * a genuine flat V1 card and a V2 card whose `data` went missing, where the
 * top-level mirrors are then the only surviving copy of the character.
 * @param raw - parsed card JSON.
 * @returns the normalised card.
 * @throws {CharacterCardError} when the input is not a JSON object.
 */
export function normalizeCard(raw: unknown): CharacterCard {
  if (!isRecord(raw)) {
    throw new CharacterCardError('a character card must be a JSON object')
  }

  const isV1 = !isRecord(raw.data)
  const spec: CardSpec = raw.spec === 'chara_card_v3' ? 'chara_card_v3' : 'chara_card_v2'
  const card: CharacterCard = {
    spec,
    spec_version: str(raw.spec_version, spec === 'chara_card_v3' ? '3.0' : '2.0'),
    data: isV1 ? v1Body(raw) : normalizeBody(raw.data),
  }

  for (const [key, value] of Object.entries(raw)) {
    if (REGENERATED_KEYS.has(key)) continue
    if (isV1 && V1_CONSUMED_KEYS.has(key)) continue
    card[key] = value
  }

  return card
}

/**
 * Serialise a card to its on-disk shape under a given spec.
 * @param card - the normalised card.
 * @param spec - the `spec` discriminator to stamp.
 * @param specVersion - the `spec_version` to stamp.
 * @returns the file-shaped card, sharing no mutable state with the input.
 */
function toFile(card: CharacterCard, spec: CardSpec, specVersion: string): CardFile {
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(card)) {
    if (key === 'spec' || key === 'spec_version' || key === 'data') continue
    extras[key] = value
  }

  // Cloned so a caller can stamp its own fields onto the serialised copy
  // without reaching back into the card it came from.
  const data = structuredClone(card.data)
  const extensions = data.extensions

  return {
    ...extras,
    spec,
    spec_version: specVersion,
    // V1 mirrors, written for the benefit of readers that only understand V1.
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
    creatorcomment: data.creator_notes,
    tags: data.tags,
    talkativeness: typeof extensions.talkativeness === 'number' ? extensions.talkativeness : 0.5,
    fav: extensions.fav === true,
    data,
  }
}

/**
 * Serialise a card as `chara_card_v2`.
 *
 * V3-only members of `data` are kept rather than stripped. A V2 reader ignores
 * fields it does not know, so dropping them would only lose the author's
 * `nickname` or `assets` for no reader's benefit.
 * @param card - the normalised card.
 * @returns the V2 file-shaped card.
 */
export function toV2(card: CharacterCard): CardFile {
  return toFile(card, 'chara_card_v2', '2.0')
}

/**
 * Serialise a card as `chara_card_v3`.
 *
 * Identical to {@link toV2} apart from the two spec fields, which is exactly
 * what SillyTavern writes into the `ccv3` chunk: the same JSON, restamped.
 * @param card - the normalised card.
 * @returns the V3 file-shaped card.
 */
export function toV3(card: CharacterCard): CardFile {
  return toFile(card, 'chara_card_v3', '3.0')
}
