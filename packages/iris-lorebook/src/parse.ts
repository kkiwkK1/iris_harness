/**
 * Reading and writing world books.
 *
 * Two formats have to work, and they are not variants of one another:
 *
 *  - `parseLorebook` takes the ST storage shape, which is what circulates as a
 *    downloadable `.json` and what the community actually trades.
 *  - `fromCharacterBook` takes the V2/V3 card spec's `character_book`, which is
 *    what is embedded in a PNG. Nothing ships that format standalone, and
 *    nothing embeds the other one, so an importer that only handles one of them
 *    fails on roughly half of real assets.
 *  - `convertAgnaiMemoryBook` / `convertRisuLorebook` / `convertNovelLorebook`
 *    take the three foreign dialects ST's importer recognizes, and
 *    `convertLorebookDialect` is the file-feature dispatch that picks between
 *    them. A dialect file is not parseable as an ST book (`entries` is an
 *    array of differently-named fields, or `data`), so conversion has to
 *    happen first.
 *
 * Normalization fills every missing field with ST's template default, mirroring
 * `addMissingWorldInfoFields`. That makes the output a superset of the input,
 * never a subset: unknown keys ride along in the index signature and come back
 * out unchanged, which is the property that matters — card authors keep state
 * in fields no version of ST has ever heard of.
 *
 * @module @iris/lorebook/parse
 */

import {
  DEFAULT_DEPTH,
  DEFAULT_ORDER,
  DEFAULT_WEIGHT,
  promptRole,
  worldInfoLogic,
  worldInfoPosition,
  type CharacterBook,
  type CharacterBookEntry,
  type CharacterFilter,
  type Lorebook,
  type LorebookEntry,
} from './types.ts'

/** Raised when input cannot be read as a world book at all. */
export class LorebookParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LorebookParseError'
  }
}

/** Narrow to a plain object. Arrays are excluded — `entries` being one is the whole format question. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Coerce to string, or fall back. */
function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** Coerce to boolean, or fall back. `undefined` and `null` both defer. */
function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Coerce to a finite number, or fall back.
 *
 * Numeric strings are accepted because ST's UI writes some of these fields from
 * `<input type="number">` values and older books carry `"100"` where newer ones
 * carry `100`.
 */
function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/** A three-state number: a real value, or `null` meaning "defer to the global setting". */
function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = asNumber(value, Number.NaN)
  return Number.isFinite(parsed) ? parsed : null
}

/** A three-state boolean: a real value, or `null` meaning "defer to the global setting". */
function asNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * Coerce to a string array.
 *
 * A bare string is split on commas because that is how ST's plaintext key input
 * stores keys when the fancy tokenizer is off, and books saved that way are
 * common enough to be worth handling rather than blanking.
 */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string' && value.trim() !== '') {
    return value.split(',').map((item) => item.trim()).filter((item) => item !== '')
  }
  return []
}

/** Coerce a character filter, replacing anything malformed with the permissive default. */
function asCharacterFilter(value: unknown): CharacterFilter {
  if (!isRecord(value)) return { isExclude: false, names: [], tags: [] }
  return {
    isExclude: asBoolean(value['isExclude'], false),
    names: asStringArray(value['names']),
    tags: asStringArray(value['tags']),
  }
}

/**
 * `delayUntilRecursion` is a level count, but `true` is still written by older
 * books and by the card spec's extension field. Upstream reads `true` as level
 * 1; both spellings are preserved here so a round trip does not rewrite the
 * author's file.
 */
function asRecursionDelay(value: unknown): number | boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return 0
}

/**
 * Every field's default, matching ST's `newWorldInfoEntryTemplate`.
 *
 * Returns a whole entry rather than the template's field subset — `uid: 0` is a
 * placeholder every caller overwrites. `Omit<LorebookEntry, 'uid'>` would be the
 * honest type and is unusable: the index signature makes `keyof LorebookEntry`
 * include `string`, so `Omit` erases every named field back to `unknown`.
 * @returns a fresh entry with no fields set.
 */
export function entryDefaults(): LorebookEntry {
  return {
    uid: 0,
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: worldInfoLogic.AND_ANY,
    order: DEFAULT_ORDER,
    position: worldInfoPosition.before,
    disable: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: DEFAULT_DEPTH,
    group: '',
    groupOverride: false,
    groupWeight: DEFAULT_WEIGHT,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: promptRole.SYSTEM,
    sticky: null,
    cooldown: null,
    delay: null,
    displayIndex: 0,
    characterFilter: { isExclude: false, names: [], tags: [] },
    ignoreBudget: false,
    outletName: '',
    triggers: [],
    addMemo: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
  }
}

/**
 * Build an entry from a partial one.
 *
 * Exists mostly for tests and for the editor's "new entry" button; anything
 * read off disk should go through {@link normalizeEntry} instead, which also
 * repairs fields that are present but the wrong type.
 * @param overrides - the fields to set; `uid` is required because it is identity.
 * @returns a complete entry.
 */
export function createEntry(overrides: Partial<LorebookEntry> & { uid: number }): LorebookEntry {
  return Object.assign(entryDefaults(), overrides)
}

/**
 * Normalize one raw entry.
 *
 * Unknown keys are spread in first so the normalized fields win: a book that
 * carries `probability: "80"` gets a number, and its unrecognized
 * `myExtension.state` survives untouched.
 * @param raw - the entry as read from JSON.
 * @param uid - the uid to use when the entry does not carry a usable one.
 * @returns a complete entry.
 */
export function normalizeEntry(raw: unknown, uid: number): LorebookEntry {
  const source = isRecord(raw) ? raw : {}
  const defaults = entryDefaults()

  return {
    ...source,
    uid: asNumber(source['uid'], uid),
    key: asStringArray(source['key']),
    keysecondary: asStringArray(source['keysecondary']),
    comment: asString(source['comment'], defaults.comment),
    content: asString(source['content'], defaults.content),
    constant: asBoolean(source['constant'], defaults.constant),
    vectorized: asBoolean(source['vectorized'], defaults.vectorized),
    selective: asBoolean(source['selective'], defaults.selective),
    selectiveLogic: asNumber(source['selectiveLogic'], defaults.selectiveLogic),
    order: asNumber(source['order'], defaults.order),
    position: asNumber(source['position'], defaults.position),
    disable: asBoolean(source['disable'], defaults.disable),
    excludeRecursion: asBoolean(source['excludeRecursion'], defaults.excludeRecursion),
    preventRecursion: asBoolean(source['preventRecursion'], defaults.preventRecursion),
    delayUntilRecursion: asRecursionDelay(source['delayUntilRecursion']),
    probability: asNumber(source['probability'], defaults.probability),
    useProbability: asBoolean(source['useProbability'], defaults.useProbability),
    depth: asNumber(source['depth'], defaults.depth),
    group: asString(source['group'], defaults.group),
    groupOverride: asBoolean(source['groupOverride'], defaults.groupOverride),
    groupWeight: asNumber(source['groupWeight'], defaults.groupWeight),
    scanDepth: asNullableNumber(source['scanDepth']),
    caseSensitive: asNullableBoolean(source['caseSensitive']),
    matchWholeWords: asNullableBoolean(source['matchWholeWords']),
    useGroupScoring: asNullableBoolean(source['useGroupScoring']),
    automationId: asString(source['automationId'], defaults.automationId),
    role: asNumber(source['role'], defaults.role),
    sticky: asNullableNumber(source['sticky']),
    cooldown: asNullableNumber(source['cooldown']),
    delay: asNullableNumber(source['delay']),
    displayIndex: asNumber(source['displayIndex'], uid),
    characterFilter: asCharacterFilter(source['characterFilter']),
    ignoreBudget: asBoolean(source['ignoreBudget'], defaults.ignoreBudget),
    outletName: asString(source['outletName'], defaults.outletName),
    triggers: asStringArray(source['triggers']),
    addMemo: asBoolean(source['addMemo'], defaults.addMemo),
    matchPersonaDescription: asBoolean(source['matchPersonaDescription'], false),
    matchCharacterDescription: asBoolean(source['matchCharacterDescription'], false),
    matchCharacterPersonality: asBoolean(source['matchCharacterPersonality'], false),
    matchCharacterDepthPrompt: asBoolean(source['matchCharacterDepthPrompt'], false),
    matchScenario: asBoolean(source['matchScenario'], false),
    matchCreatorNotes: asBoolean(source['matchCreatorNotes'], false),
  }
}

/**
 * Read a world book in the ST storage shape.
 *
 * `entries` is normally the uid-keyed object; an array is accepted too, because
 * several conversion tools (and ST's own Agnai/Risu/Novel importers) emit one
 * on the way in, and rejecting it would fail a file the user considers valid.
 * Either way the result is keyed by uid.
 * @param raw - parsed JSON.
 * @returns a normalized book.
 * @throws LorebookParseError when the input has no readable `entries`.
 */
export function parseLorebook(raw: unknown): Lorebook {
  if (!isRecord(raw)) {
    throw new LorebookParseError('a world book must be a JSON object')
  }

  const rawEntries = raw['entries']
  if (!isRecord(rawEntries) && !Array.isArray(rawEntries)) {
    throw new LorebookParseError('a world book must have an "entries" object')
  }

  const pairs: Array<[string, unknown]> = Array.isArray(rawEntries)
    ? rawEntries.map((entry, index) => [String(index), entry])
    : Object.entries(rawEntries)

  const entries: Record<string, LorebookEntry> = {}
  for (const [key, value] of pairs) {
    // The object key is the authority on uid when the entry disagrees or is
    // silent: it is what every other reference into the book uses.
    const fallbackUid = Number.isFinite(Number(key)) ? Number(key) : Object.keys(entries).length
    const entry = normalizeEntry(value, fallbackUid)
    entries[String(entry.uid)] = entry
  }

  return { ...raw, entries }
}

/**
 * Read the V2/V3 card spec's `character_book`.
 *
 * The mapping follows ST's `convertCharacterBook` field for field, with one
 * deliberate addition: the spec has a top-level `case_sensitive` on each entry
 * that upstream ignores in favour of `extensions.case_sensitive`. Ignoring it
 * silently discards the only case-sensitivity signal a spec-compliant,
 * non-ST-authored card can give, so it is read as a fallback. Everything the
 * mapping does not consume — `use_regex`, `name`, `priority`, anything a future
 * spec adds — stays on the entry under its original name.
 * @param book - the card's `character_book` value.
 * @returns a normalized book in the ST shape.
 * @throws LorebookParseError when `entries` is not an array.
 */
export function fromCharacterBook(book: unknown): Lorebook {
  if (!isRecord(book)) {
    throw new LorebookParseError('a character_book must be a JSON object')
  }

  const rawEntries = book['entries']
  if (!Array.isArray(rawEntries)) {
    throw new LorebookParseError('a character_book must have an "entries" array')
  }

  const entries: Record<string, LorebookEntry> = {}

  rawEntries.forEach((raw: unknown, index: number) => {
    const source = isRecord(raw) ? raw : {}
    const extensions = isRecord(source['extensions']) ? source['extensions'] : {}
    const uid = asNumber(source['id'], index)

    // Consumed by the mapping below. Anything else on the spec entry is
    // unknown to us and is carried through verbatim.
    const mapped = new Set([
      'id', 'keys', 'secondary_keys', 'comment', 'content', 'constant',
      'selective', 'insertion_order', 'position', 'enabled', 'case_sensitive',
    ])
    const carried: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      if (!mapped.has(key)) carried[key] = value
    }

    const enabled = asBoolean(source['enabled'], true)
    const specPosition = source['position'] === 'before_char'
      ? worldInfoPosition.before
      : worldInfoPosition.after

    const entry = normalizeEntry({
      ...carried,
      uid,
      key: asStringArray(source['keys']),
      keysecondary: asStringArray(source['secondary_keys']),
      comment: asString(source['comment'], ''),
      content: asString(source['content'], ''),
      constant: asBoolean(source['constant'], false),
      selective: asBoolean(source['selective'], false),
      order: asNumber(source['insertion_order'], DEFAULT_ORDER),
      position: asNumber(extensions['position'], specPosition),
      disable: !enabled,
      addMemo: asString(source['comment'], '') !== '',
      displayIndex: asNumber(extensions['display_index'], index),
      excludeRecursion: asBoolean(extensions['exclude_recursion'], false),
      preventRecursion: asBoolean(extensions['prevent_recursion'], false),
      delayUntilRecursion: asRecursionDelay(extensions['delay_until_recursion']),
      probability: asNumber(extensions['probability'], 100),
      useProbability: asBoolean(extensions['useProbability'], true),
      depth: asNumber(extensions['depth'], DEFAULT_DEPTH),
      selectiveLogic: asNumber(extensions['selectiveLogic'], worldInfoLogic.AND_ANY),
      outletName: asString(extensions['outlet_name'], ''),
      group: asString(extensions['group'], ''),
      groupOverride: asBoolean(extensions['group_override'], false),
      groupWeight: asNumber(extensions['group_weight'], DEFAULT_WEIGHT),
      scanDepth: asNullableNumber(extensions['scan_depth']),
      caseSensitive: asNullableBoolean(extensions['case_sensitive']) ?? asNullableBoolean(source['case_sensitive']),
      matchWholeWords: asNullableBoolean(extensions['match_whole_words']),
      useGroupScoring: asNullableBoolean(extensions['use_group_scoring']),
      automationId: asString(extensions['automation_id'], ''),
      role: asNumber(extensions['role'], promptRole.SYSTEM),
      vectorized: asBoolean(extensions['vectorized'], false),
      sticky: asNullableNumber(extensions['sticky']),
      cooldown: asNullableNumber(extensions['cooldown']),
      delay: asNullableNumber(extensions['delay']),
      ignoreBudget: asBoolean(extensions['ignore_budget'], false),
      triggers: asStringArray(extensions['triggers']),
      matchPersonaDescription: asBoolean(extensions['match_persona_description'], false),
      matchCharacterDescription: asBoolean(extensions['match_character_description'], false),
      matchCharacterPersonality: asBoolean(extensions['match_character_personality'], false),
      matchCharacterDepthPrompt: asBoolean(extensions['match_character_depth_prompt'], false),
      matchScenario: asBoolean(extensions['match_scenario'], false),
      matchCreatorNotes: asBoolean(extensions['match_creator_notes'], false),
      extensions,
    }, uid)

    entries[String(entry.uid)] = entry
  })

  const { entries: _discarded, ...bookLevel } = book
  return { ...bookLevel, entries }
}

/**
 * The `entries`-style array a dialect book carries, or a named error.
 *
 * ST's converters call `.forEach` straight off the input and let the TypeError
 * abort the import with "Error parsing file"; here the same refusal is a
 * {@link LorebookParseError} with a message that names the dialect.
 */
function dialectEntryList(book: unknown, field: string, message: string): unknown[] {
  const rawEntries = isRecord(book) ? book[field] : undefined
  if (!Array.isArray(rawEntries)) throw new LorebookParseError(message)
  return rawEntries
}

/**
 * Convert an Agnai memory book (`{ kind: 'memory', entries: [...] }`).
 *
 * A field-for-field transcription of ST's `convertAgnaiMemoryBook`
 * (`world-info.js:5358`):
 *
 * | Agnai           | LorebookEntry                          |
 * | --------------- | -------------------------------------- |
 * | `keywords`      | `key`                                  |
 * | `name`          | `comment`, and `addMemo` when non-empty |
 * | `entry`         | `content`                              |
 * | `weight`        | `order`                                |
 * | `enabled`       | `disable` (inverted — absent means disabled) |
 * | *(array index)* | `uid`, `displayIndex`, the `entries` key |
 *
 * ST writes the mapped fields over `newWorldInfoEntryTemplate` and lets
 * `addMissingWorldInfoFields` fill the rest at load time; routing the mapping
 * through {@link normalizeEntry} is that same composition in one step. Fields
 * the mapping consumes (`keywords`, `weight`, ...) are dropped, exactly as ST
 * drops them — the template literal it builds has no place for them.
 * @param inputObj - parsed JSON of the `.json` file.
 * @returns a normalized book in the ST shape.
 * @throws LorebookParseError when `entries` is not an array.
 */
export function convertAgnaiMemoryBook(inputObj: unknown): Lorebook {
  const rawEntries = dialectEntryList(
    inputObj, 'entries', 'an Agnai memory book must have an "entries" array',
  )

  const entries: Record<string, LorebookEntry> = {}
  rawEntries.forEach((raw: unknown, index: number) => {
    const source = isRecord(raw) ? raw : {}
    const name = asString(source['name'], '')

    const entry = normalizeEntry({
      uid: index,
      key: asStringArray(source['keywords']),
      comment: name,
      content: asString(source['entry'], ''),
      // Agnai weights are small integers; ST maps them onto `order` as-is.
      order: asNumber(source['weight'], DEFAULT_ORDER),
      // `!entry.enabled`: an entry without the flag is disabled, not enabled.
      disable: !asBoolean(source['enabled'], false),
      // The template default is `selective: true`; this dialect writes false.
      selective: false,
      addMemo: name !== '',
      displayIndex: index,
    }, index)
    entries[String(entry.uid)] = entry
  })

  return { entries }
}

/**
 * Convert a Risu lorebook (`{ type: 'risu', data: [...] }`).
 *
 * A field-for-field transcription of ST's `convertRisuLorebook`
 * (`world-info.js:5403`):
 *
 * | Risu                | LorebookEntry            |
 * | ------------------- | ------------------------ |
 * | `key`               | `key` (split on commas)  |
 * | `secondkey`         | `keysecondary` (split on commas) |
 * | `comment`           | `comment`                |
 * | `content`           | `content`                |
 * | `alwaysActive`      | `constant`               |
 * | `selective`         | `selective` (absent means the template's `true`) |
 * | `insertorder`       | `order`                  |
 * | `activationPercent` | `probability`            |
 * | *(array index)*     | `uid`, `displayIndex`, the `entries` key |
 *
 * Risu is the one dialect whose entries are disabled-inclusive (`disable` is
 * written as a constant `false`) and always memo'd (`addMemo: true`).
 * `useProbability` deserves a note: ST writes `activationPercent ?? true`, so
 * it can never come out false, and when the percent is present it writes the
 * *number* — a truthy placeholder the boolean `useProbability` slot cannot
 * carry. The 0% case keeps its meaning through `probability: 0`, which the
 * activation roll rejects on its own, so coercing the placeholder to `true`
 * changes no outcome.
 * @param inputObj - parsed JSON of the `.json` file.
 * @returns a normalized book in the ST shape.
 * @throws LorebookParseError when `data` is not an array.
 */
export function convertRisuLorebook(inputObj: unknown): Lorebook {
  const rawEntries = dialectEntryList(
    inputObj, 'data', 'a Risu lorebook must have a "data" array',
  )

  const entries: Record<string, LorebookEntry> = {}
  rawEntries.forEach((raw: unknown, index: number) => {
    const source = isRecord(raw) ? raw : {}

    const entry = normalizeEntry({
      uid: index,
      // Risu stores keys as one comma-separated string, unlike every other dialect.
      key: asStringArray(source['key']),
      keysecondary: asStringArray(source['secondkey']),
      comment: asString(source['comment'], ''),
      content: asString(source['content'], ''),
      constant: asBoolean(source['alwaysActive'], false),
      selective: asBoolean(source['selective'], true),
      order: asNumber(source['insertorder'], DEFAULT_ORDER),
      probability: asNumber(source['activationPercent'], 100),
      useProbability: asBoolean(source['activationPercent'], true),
      addMemo: true,
      displayIndex: index,
    }, index)
    entries[String(entry.uid)] = entry
  })

  return { entries }
}

/**
 * Convert a NovelAI lorebook (`{ lorebookVersion: ..., entries: [...] }`).
 *
 * A field-for-field transcription of ST's `convertNovelLorebook`
 * (`world-info.js:5448`):
 *
 * | NovelAI                          | LorebookEntry          |
 * | -------------------------------- | ---------------------- |
 * | `keys`                           | `key`                  |
 * | `displayName`                    | `comment` (`|| ''`), and `addMemo` when a non-blank string |
 * | `text`                           | `content`              |
 * | `contextConfig.budgetPriority`   | `order`                |
 * | `enabled`                        | `disable` (inverted — absent means disabled) |
 * | *(array index)*                  | `uid`, `displayIndex`, the `entries` key |
 *
 * The `order` fallback is 0, not the template's 100: NovelAI orders by token
 * budget priority, where 0 is a legitimate bottom-of-the-pile priority an
 * author can set on purpose, and ST preserves it rather than substituting the
 * default.
 * @param inputObj - parsed JSON of the `.json` file.
 * @returns a normalized book in the ST shape.
 * @throws LorebookParseError when `entries` is not an array.
 */
export function convertNovelLorebook(inputObj: unknown): Lorebook {
  const rawEntries = dialectEntryList(
    inputObj, 'entries', 'a NovelAI lorebook must have an "entries" array',
  )

  const entries: Record<string, LorebookEntry> = {}
  rawEntries.forEach((raw: unknown, index: number) => {
    const source = isRecord(raw) ? raw : {}
    const contextConfig = isRecord(source['contextConfig']) ? source['contextConfig'] : {}
    const displayName = source['displayName']

    const entry = normalizeEntry({
      uid: index,
      key: asStringArray(source['keys']),
      comment: asString(displayName, ''),
      content: asString(source['text'], ''),
      order: asNumber(contextConfig['budgetPriority'], 0),
      // `!entry.enabled`: an entry without the flag is disabled, not enabled.
      disable: !asBoolean(source['enabled'], false),
      // The template default is `selective: true`; this dialect writes false.
      selective: false,
      // ST tests `displayName !== undefined && displayName.trim() !== ''` —
      // blank-but-present names show as the comment yet tick no memo box.
      addMemo: typeof displayName === 'string' && displayName.trim() !== '',
      displayIndex: index,
    }, index)
    entries[String(entry.uid)] = entry
  })

  return { entries }
}

/**
 * Convert whichever foreign dialect `raw` is, or report that it is none.
 *
 * The dispatch mirrors ST's importer (`world-info.js:5754-5772`), which
 * recognizes a file by a feature no ST book carries: `lorebookVersion`
 * (NovelAI), `kind: 'memory'` (Agnai), `type: 'risu'` (Risu). Checked in ST's
 * order, first match wins.
 * @param raw - parsed JSON of an imported file.
 * @returns the converted book, or `null` when the file is not a known dialect
 *   and the caller should fall back to {@link parseLorebook}.
 */
export function convertLorebookDialect(raw: unknown): Lorebook | null {
  if (!isRecord(raw)) return null
  if (raw['lorebookVersion'] !== undefined) return convertNovelLorebook(raw)
  if (raw['kind'] === 'memory') return convertAgnaiMemoryBook(raw)
  if (raw['type'] === 'risu') return convertRisuLorebook(raw)
  return null
}

/**
 * Copy a book out for storage.
 *
 * A deep clone rather than the same object, so a caller cannot hand the result
 * to a writer and keep mutating what it thinks is its own copy. Nothing is
 * stripped: the output is the input plus whatever defaults normalization
 * supplied.
 * @param book - the book to serialize.
 * @returns a detached, JSON-ready copy.
 */
export function serializeLorebook(book: Lorebook): Lorebook {
  return structuredClone(book)
}

/**
 * Write a book back out in the card spec's `character_book` shape.
 *
 * The ST-specific fields are always written into each entry's `extensions`,
 * even for a book that arrived without them. That grows a file that came from a
 * spec-only tool, but the alternative — omitting anything left at its default —
 * would make export lossy for any entry the user deliberately set back to a
 * default, and the second round trip is stable either way.
 * @param book - a normalized book.
 * @returns the spec shape, entries as an array ordered by `displayIndex`.
 */
export function toCharacterBook(book: Lorebook): CharacterBook {
  const { entries: rawEntries, ...bookLevel } = book

  const entries: CharacterBookEntry[] = Object.values(rawEntries)
    .sort((a, b) => a.displayIndex - b.displayIndex || a.uid - b.uid)
    .map((entry) => {
      const known = new Set([...Object.keys(entryDefaults()), 'uid', 'extensions'])
      const carried: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(entry)) {
        if (!known.has(key)) carried[key] = value
      }

      const inherited = isRecord(entry['extensions']) ? entry['extensions'] : {}

      return {
        ...carried,
        id: entry.uid,
        keys: [...entry.key],
        secondary_keys: [...entry.keysecondary],
        comment: entry.comment,
        content: entry.content,
        constant: entry.constant,
        selective: entry.selective,
        insertion_order: entry.order,
        enabled: !entry.disable,
        position: entry.position === worldInfoPosition.before ? 'before_char' : 'after_char',
        // Omitted rather than written as `false` when unset: the spec field is
        // a boolean, the ST field is three-state, and a `false` here would come
        // back as an explicit "case-insensitive" that overrides the global
        // setting the entry meant to defer to.
        ...(entry.caseSensitive === null ? {} : { case_sensitive: entry.caseSensitive }),
        extensions: {
          ...inherited,
          position: entry.position,
          exclude_recursion: entry.excludeRecursion,
          prevent_recursion: entry.preventRecursion,
          delay_until_recursion: entry.delayUntilRecursion,
          display_index: entry.displayIndex,
          probability: entry.probability,
          useProbability: entry.useProbability,
          depth: entry.depth,
          selectiveLogic: entry.selectiveLogic,
          outlet_name: entry.outletName,
          group: entry.group,
          group_override: entry.groupOverride,
          group_weight: entry.groupWeight,
          scan_depth: entry.scanDepth,
          case_sensitive: entry.caseSensitive,
          match_whole_words: entry.matchWholeWords,
          use_group_scoring: entry.useGroupScoring,
          automation_id: entry.automationId,
          role: entry.role,
          vectorized: entry.vectorized,
          sticky: entry.sticky,
          cooldown: entry.cooldown,
          delay: entry.delay,
          ignore_budget: entry.ignoreBudget,
          triggers: [...entry.triggers],
          match_persona_description: entry.matchPersonaDescription,
          match_character_description: entry.matchCharacterDescription,
          match_character_personality: entry.matchCharacterPersonality,
          match_character_depth_prompt: entry.matchCharacterDepthPrompt,
          match_scenario: entry.matchScenario,
          match_creator_notes: entry.matchCreatorNotes,
        },
      }
    })

  return {
    ...bookLevel,
    extensions: isRecord(book['extensions']) ? book['extensions'] : {},
    entries,
  }
}

/**
 * Split V3 content decorators off the front of an entry's body.
 *
 * The `@@@` prefix is a fallback chain, not a comment: a reader that knows the
 * decorator on the `@@` line uses it and skips every `@@@` alternative beneath;
 * a reader that does not, falls through to the first `@@@` line it recognizes.
 * That is why an unknown decorator sets `fallbacked` rather than being dropped.
 * @param content - the entry body.
 * @returns the recognized decorators and the body with them removed.
 */
export function parseDecorators(content: string): [string[], string] {
  if (!content.startsWith('@@')) return [[], content]

  const known = ['@@activate', '@@dont_activate']
  const isKnown = (line: string): boolean => {
    const bare = line.startsWith('@@@') ? line.slice(1) : line
    return known.some((decorator) => bare.startsWith(decorator))
  }

  const lines = content.split('\n')
  const decorators: string[] = []
  let body = content
  let fallbacked = false

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (!line.startsWith('@@')) {
      body = lines.slice(index).join('\n')
      break
    }
    if (line.startsWith('@@@') && !fallbacked) continue
    if (isKnown(line)) {
      decorators.push(line.startsWith('@@@') ? line.slice(1) : line)
      fallbacked = false
    } else {
      fallbacked = true
    }
  }

  return [decorators, body]
}
