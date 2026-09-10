/**
 * Tavern Helper 4.x's **old** `Lorebook` vocabulary, over the new `Worldbook` one.
 *
 * Upstream renamed the family and kept the old names working. Every one of them
 * is `@deprecated` with a pointer at its replacement (`@types/function/lorebook.d.ts:24`
 * onward, `lorebook_entry.d.ts:1` onward), and cards written before the rename
 * still call them — so they have to resolve, and they have to resolve to the
 * same book the new names read.
 *
 * **The premise this module was dispatched with was wrong, and it changes the
 * shape of the work.** The brief said upstream implements the old API as a
 * compatibility layer over the new one. It does not: `src/function/lorebook.ts`
 * and `src/function/lorebook_entry.ts` implement the old names **directly**
 * against SillyTavern's own state (`world_names`, `loadWorldInfo`,
 * `saveWorldInfo`, `chat_metadata`), and it is the *new* module that delegates
 * to the old one — `worldbook.ts:50-82` builds four of its binding members out
 * of `getCharLorebooks`, `getChatLorebook`, `setChatLorebook` and
 * `getOrCreateChatLorebook`. The two entry vocabularies therefore meet nowhere
 * upstream: each converts to and from the raw stored row on its own
 * (`toLorebookEntry` at `lorebook_entry.ts:133` and `fromPartialLorebookEntry`
 * at `:223`; `toWorldbookEntry` at `worldbook.ts:205` and `fromWorldbookEntry`
 * at `:262`).
 *
 * Iris has no raw row in the frame — the host owns storage and the wire carries
 * the *new* shape — so the old vocabulary is composed **through** the new one
 * here, and the two upstream converters are read as one mapping with the raw row
 * as the pivot:
 *
 * | old (`LorebookEntry`) | raw row | new (`WorldbookEntry`) |
 * | --- | --- | --- |
 * | `comment` | `comment` | `name` |
 * | `enabled` | `!disable` | `enabled` |
 * | `type` | `constant`/`vectorized`/`selective` | `strategy.type` |
 * | `keys` (and `key`) | `key` | `strategy.keys` |
 * | `logic` | `selectiveLogic` | `strategy.keys_secondary.logic` |
 * | `filters` (and `filter`) | `keysecondary` | `strategy.keys_secondary.keys` |
 * | `scan_depth` | `scanDepth` | `strategy.scan_depth` |
 * | `position` (9 values) | `position` + `role` | `position.type` + `position.role` |
 * | `depth` | `depth` | `position.depth` |
 * | `order` | `order` | `position.order` |
 * | `probability` | `probability` | `probability` |
 * | `exclude_recursion` | `excludeRecursion` | `recursion.prevent_incoming` |
 * | `prevent_recursion` | `preventRecursion` | `recursion.prevent_outgoing` |
 * | `delay_until_recursion` | `delayUntilRecursion` | `recursion.delay_until` |
 * | `sticky`/`cooldown`/`delay` | same | `effect.*` |
 * | `case_sensitive` | `caseSensitive` | `caseSensitive` (implicit key) |
 * | `match_whole_words` | `matchWholeWords` | `matchWholeWords` |
 * | `use_group_scoring` | `useGroupScoring` | `useGroupScoring` |
 * | `automation_id` | `automationId` | `automationId` |
 * | `group`/`group_prioritized`/`group_weight` | `group`/`groupOverride`/`groupWeight` | same three |
 * | `display_index` | `displayIndex` | **nothing** — array position |
 *
 * The last row is the one that cannot be made to line up, and it is upstream's
 * doing rather than this module's: the new API dropped the field and derives
 * `displayIndex` from array position (`worldbook.ts:262`, whose second
 * parameter *is* the index), and this host does the same on every write. So the
 * value a card reads here is the entry's **position in the book**, not the
 * number stored beside it. Measured over the 29 real books in the two corpora
 * (2476 entries): the stored `displayIndex` equals the entry's ordinal for 1966
 * of them, so 21% of real entries would read a different number under upstream's
 * old getter. Nothing can recover it — `worldbook.get` does not carry it.
 *
 * Four asymmetries beyond that, each copied from upstream rather than repaired,
 * and each with the reason it must not be "fixed":
 *
 * 1. **The default entry is not the same entry.** An old partial with no `type`
 *    becomes `selective` (upstream's `default_original_lorebook_entry` has
 *    `constant: false, selective: true`, `lorebook_entry.ts:99`), while a new
 *    partial with no `strategy` becomes `constant` — always on
 *    (`worldbook.ts:272`). So `replaceLorebookEntries(book, [{uid: 0}])` and
 *    `replaceWorldbook(book, [{uid: 0}])` write **different entries**. This is
 *    why {@link fromLorebookEntry} fills in a complete entry from the old
 *    defaults instead of forwarding a partial: forwarding would silently hand a
 *    card the new API's defaults for the old API's call.
 * 2. **The old getter revives no keys.** `getWorldbook` hands a card `RegExp`
 *    objects for regex-shaped keys (`worldbook.ts:214`); the old getter hands
 *    back the stored strings untouched (`lorebook_entry.ts:157`), and
 *    `LorebookEntry.keys` is typed `string[]`. So this maps from the **wire**
 *    shape, before revival, which is also the cheaper of the two.
 * 3. **`key` and `filter` are readable and not writable.** Upstream's getter
 *    sets all four spellings (`:157`, `:167`) while its writer has transformers
 *    for `keys` and `filters` only (`:262`, `:271`) — a card that writes `key`
 *    is silently ignored *there too*, so both halves are reproduced exactly.
 * 4. **`outlet` has no old spelling.** Upstream's old getter maps six position
 *    codes by table and everything else through the role fallback
 *    (`lorebook_entry.ts:141-152`), so both `at_depth` (4) and `outlet` (7) read
 *    as `at_depth_as_<role>`; writing that back stores `at_depth`. The outlet is
 *    lost by a round trip through the old API — upstream's included. Zero of the
 *    2476 real entries are at position 7.
 *
 * @module iris-web/sandbox/lorebook-aliases
 */

import type { LorebookSettings, WorldbookEntry } from '@iris/protocol'

/** Upstream's nine-value fusion of a position and a message role. */
export type LorebookPosition =
  | 'before_character_definition'
  | 'after_character_definition'
  | 'before_example_messages'
  | 'after_example_messages'
  | 'before_author_note'
  | 'after_author_note'
  | 'at_depth_as_system'
  | 'at_depth_as_assistant'
  | 'at_depth_as_user'

/** A per-entry override that may defer to the world-info settings. */
type Deferred<T> = 'same_as_global' | T

/**
 * One entry in the old vocabulary, as a card reads it.
 *
 * The `@types` declaration (`lorebook_entry.d.ts:2`) plus the two deprecated
 * aliases upstream's implementation also sets (`key`, `filter`) — declared here
 * because a card that predates the rename reads them, and leaving them off the
 * type while the value carries them is how the next reader deletes them.
 */
export interface CardLorebookEntry {
  uid: number
  /** The entry's position in the book; see the module header's last table row. */
  display_index: number
  comment: string
  enabled: boolean
  type: 'constant' | 'selective' | 'vectorized'
  position: LorebookPosition
  /** Null unless the entry is at a depth — upstream's own rule. */
  depth: number | null
  order: number
  probability: number
  /** @deprecated upstream's own note: use `keys`. Read-only in both halves. */
  key: string[]
  keys: string[]
  logic: 'and_any' | 'and_all' | 'not_all' | 'not_any'
  /** @deprecated upstream's own note: use `filters`. Read-only in both halves. */
  filter: string[]
  filters: string[]
  scan_depth: Deferred<number>
  case_sensitive: Deferred<boolean>
  match_whole_words: Deferred<boolean>
  use_group_scoring: Deferred<boolean>
  automation_id: string | null
  exclude_recursion: boolean
  prevent_recursion: boolean
  delay_until_recursion: boolean | number
  content: string
  group: string
  group_prioritized: boolean
  group_weight: number
  sticky: number | null
  cooldown: number | null
  delay: number | null
}

/** The six position codes upstream's old getter maps by table. */
const NAMED_POSITIONS: Partial<Record<WorldbookEntry['position']['type'], LorebookPosition>> = {
  before_character_definition: 'before_character_definition',
  after_character_definition: 'after_character_definition',
  before_example_messages: 'before_example_messages',
  after_example_messages: 'after_example_messages',
  before_author_note: 'before_author_note',
  after_author_note: 'after_author_note',
}

/** Where each old position lands in the new pair. Upstream's `:236` inverted. */
const POSITION_PAIRS: Record<
  LorebookPosition,
  { type: WorldbookEntry['position']['type'], role: WorldbookEntry['position']['role'] }
> = {
  before_character_definition: { type: 'before_character_definition', role: 'system' },
  after_character_definition: { type: 'after_character_definition', role: 'system' },
  before_example_messages: { type: 'before_example_messages', role: 'system' },
  after_example_messages: { type: 'after_example_messages', role: 'system' },
  before_author_note: { type: 'before_author_note', role: 'system' },
  after_author_note: { type: 'after_author_note', role: 'system' },
  at_depth_as_system: { type: 'at_depth', role: 'system' },
  at_depth_as_user: { type: 'at_depth', role: 'user' },
  at_depth_as_assistant: { type: 'at_depth', role: 'assistant' },
}

/**
 * The old API's defaults for an entry a caller left blank.
 *
 * Upstream's `default_original_lorebook_entry` (`lorebook_entry.ts:94`) read in
 * the old vocabulary. **Not the new API's defaults** — see asymmetry 1 in the
 * module header, which is the whole reason this constant exists rather than the
 * write leg forwarding a partial.
 */
const LOREBOOK_DEFAULTS: Omit<CardLorebookEntry, 'uid' | 'display_index'> = {
  comment: '',
  enabled: true,
  // `constant: false, vectorized: false, selective: true` upstream. The one
  // default that changes what a card's entry *does*.
  type: 'selective',
  position: 'before_character_definition',
  // Raw `depth: 4`, which the old getter reports as `null` for a non-depth
  // position; on the write leg `null` becomes 4 again.
  depth: null,
  order: 100,
  probability: 100,
  key: [],
  keys: [],
  logic: 'and_any',
  filter: [],
  filters: [],
  scan_depth: 'same_as_global',
  case_sensitive: 'same_as_global',
  match_whole_words: 'same_as_global',
  use_group_scoring: 'same_as_global',
  automation_id: null,
  exclude_recursion: false,
  prevent_recursion: false,
  // Upstream's raw default is the number 0; the new shape has no number for
  // "no delay", so this becomes `null` on the wire and the host stores `false`.
  // `0` and `false` are one state to every reader on both sides — SillyTavern
  // tests it for truthiness, and this host's `positive()` maps both to null.
  delay_until_recursion: false,
  content: '',
  group: '',
  group_prioritized: false,
  group_weight: 100,
  sticky: null,
  cooldown: null,
  delay: null,
}

/**
 * One entry, from the new vocabulary into the old.
 *
 * Reads the **wire** shape rather than the revived one a card gets from
 * `getWorldbook` — asymmetry 2 in the module header: the old getter hands back
 * stored strings and declares `keys: string[]`, so revival would be a
 * conversion this vocabulary has to undo.
 * @param entry - one entry as the host sent it.
 * @param displayIndex - its position in the book, which is what the old
 *   `display_index` can be here; see the module header.
 * @returns the same entry in the old vocabulary.
 */
export function toLorebookEntry(entry: WorldbookEntry, displayIndex: number): CardLorebookEntry {
  const keys = [...entry.strategy.keys]
  const filters = [...entry.strategy.keys_secondary.keys]
  return {
    uid: entry.uid,
    display_index: displayIndex,
    comment: entry.name,
    enabled: entry.enabled,
    type: entry.strategy.type,
    // The role fallback covers `at_depth` and `outlet` both, which is upstream's
    // behaviour rather than a shortcut: its table has no row for either code.
    position: NAMED_POSITIONS[entry.position.type]
      ?? (entry.position.role === 'user'
        ? 'at_depth_as_user'
        : entry.position.role === 'assistant' ? 'at_depth_as_assistant' : 'at_depth_as_system'),
    depth: entry.position.type === 'at_depth' ? entry.position.depth : null,
    order: entry.position.order,
    /*
     * The resolved probability, which is **not** always the stored one.
     *
     * An entry with `useProbability: false` reads as `probability: 100` on this
     * wire (and in upstream's new API, `worldbook.ts:241`), while upstream's old
     * getter reports the stored number. The stored number is not recoverable
     * from what arrives here, so this reports what the entry actually does —
     * 100% — rather than inventing one. 23 of the 2476 real entries are in that
     * state.
     */
    probability: entry.probability,
    // All four spellings, as upstream's getter sets all four. Copies, not the
    // same array twice: a card that sorts `keys` in place must not find `key`
    // sorted with it.
    key: [...keys],
    keys,
    logic: entry.strategy.keys_secondary.logic,
    filter: [...filters],
    filters,
    scan_depth: entry.strategy.scan_depth,
    // `null` is the stored "defer to the global setting", which this vocabulary
    // spells out. Upstream's `?? 'same_as_global'`, three times over.
    case_sensitive: entry.caseSensitive ?? 'same_as_global',
    match_whole_words: entry.matchWholeWords ?? 'same_as_global',
    use_group_scoring: entry.useGroupScoring ?? 'same_as_global',
    // Empty becomes null, upstream's `entry.automationId || null`: the old
    // vocabulary's "no automation" is null and the stored one is ''.
    automation_id: entry.automationId === '' ? null : entry.automationId,
    exclude_recursion: entry.recursion.prevent_incoming,
    prevent_recursion: entry.recursion.prevent_outgoing,
    // The old field is `boolean | number` and the new one `number | null`.
    delay_until_recursion: entry.recursion.delay_until ?? false,
    content: entry.content,
    group: entry.group,
    group_prioritized: entry.groupOverride,
    group_weight: entry.groupWeight,
    sticky: entry.effect.sticky,
    cooldown: entry.effect.cooldown,
    delay: entry.effect.delay,
  }
}

/**
 * One entry, from the old vocabulary into the new.
 *
 * **A complete entry, not a patch**, and that is asymmetry 1 in the module
 * header: the old API merges its own defaults over whatever the caller supplied
 * (`lorebook_entry.ts:299`) and those defaults differ from the new API's, so a
 * partial forwarded as a partial would be completed by the wrong table — most
 * visibly turning a card's blank entry from green (`selective`) to blue
 * (`constant`).
 *
 * `display_index` is accepted and **not sent**: the new shape has no field for
 * it, and this host renumbers from array position on every write. A caller
 * ordering entries by `display_index` should order the array.
 * @param entry - a partial entry in the old vocabulary; every field may be absent.
 * @returns a complete entry in the new vocabulary, ready for the wire.
 */
export function fromLorebookEntry(
  entry: Partial<CardLorebookEntry> & { uid: number },
): WorldbookEntry {
  // `undefined` is "not supplied" and takes the default; upstream filters the
  // same way before applying its transformers (`lorebook_entry.ts:303`).
  const supplied = Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined),
  ) as Partial<CardLorebookEntry>
  const old: Omit<CardLorebookEntry, 'uid' | 'display_index'> = { ...LOREBOOK_DEFAULTS, ...supplied }
  /*
   * The fallback is for a card, not for the type: `position` arrives from a
   * card's own object, so at run time it can be any string.
   *
   * It lands on upstream's own answer for that case, which takes reading its
   * writer to see: the transformer resolves an unknown position to
   * `{position: undefined, role: null}` (`lorebook_entry.ts:236`), `_.merge`
   * skips an `undefined` source value, and so the default row's `position: 0`
   * survives — `before_character_definition`. Choosing the depth pair instead
   * would look more forgiving and would put the card's entry somewhere upstream
   * never puts it.
   */
  const place = POSITION_PAIRS[old.position] ?? POSITION_PAIRS.before_character_definition

  return {
    uid: entry.uid,
    name: old.comment,
    enabled: old.enabled,
    strategy: {
      type: old.type,
      // `keys` only. `key` is upstream's deprecated read-side alias and its
      // writer has no transformer for it — asymmetry 3.
      keys: [...old.keys],
      keys_secondary: { logic: old.logic, keys: [...old.filters] },
      scan_depth: old.scan_depth,
    },
    position: {
      type: place.type,
      role: place.role,
      // Upstream's `depth: value === null ? 4 : value` — the raw default.
      depth: old.depth ?? 4,
      order: old.order,
    },
    content: old.content,
    probability: old.probability,
    // Always true, because the old vocabulary has no field for it and upstream's
    // default row sets it (`lorebook_entry.ts:117`). An old-API write therefore
    // turns the probability roll **on** for an entry that had it off — upstream's
    // behaviour, and the counterpart of the read above.
    useProbability: true,
    recursion: {
      prevent_incoming: old.exclude_recursion,
      prevent_outgoing: old.prevent_recursion,
      // `false` and `0` both mean "no delay"; the new shape spells it `null`.
      delay_until: typeof old.delay_until_recursion === 'number' && old.delay_until_recursion > 0
        ? old.delay_until_recursion
        : null,
    },
    effect: { sticky: old.sticky, cooldown: old.cooldown, delay: old.delay },
    group: old.group,
    groupOverride: old.group_prioritized,
    groupWeight: old.group_weight,
    caseSensitive: old.case_sensitive === 'same_as_global' ? null : old.case_sensitive,
    matchWholeWords: old.match_whole_words === 'same_as_global' ? null : old.match_whole_words,
    useGroupScoring: old.use_group_scoring === 'same_as_global' ? null : old.use_group_scoring,
    automationId: old.automation_id ?? '',
    /*
     * The stored fields the old vocabulary has no name for, at the same values
     * this host's writer defaults them to.
     *
     * Sent rather than omitted because the shape is `WorldbookEntry`, and stated
     * rather than spread from a constant because each one is a claim: an old-API
     * write **loses** an `outletName`, a `triggers` list, a `characterFilter`
     * and an `ignoreBudget` flag that a book already carried. Upstream's old
     * writer loses them too — its default row has no key for any of them and
     * `_.merge` cannot restore what the caller never held.
     */
    outletName: '',
    ignoreBudget: false,
    triggers: [],
    characterFilter: { isExclude: false, names: [], tags: [] },
    addMemo: true,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
  }
}

/**
 * `_.merge`'s behaviour for one entry, which `setLorebookEntries` needs exactly.
 *
 * Upstream patches an existing entry with `_.merge(data_entry, entry_to_set)`
 * (`lorebook_entry.ts:377`), and lodash's merge is **not** a spread:
 *
 * - a source value of `undefined` does not overwrite;
 * - two arrays merge **index by index**, so patching `keys: ['a']` over
 *   `['x', 'y']` leaves `['a', 'y']` rather than `['a']`.
 *
 * The second rule is the one a spread would get wrong, and it would get it
 * wrong quietly: a card narrowing an entry's key list would find the old tail
 * still in it, which is a book that activates on keywords the card removed.
 * Reproduced here rather than by importing lodash, because the entry shape is
 * flat — the only nested values are the two key lists, both arrays of strings —
 * so the whole of merge's behaviour over it is these two rules.
 * @param base - the entry as stored.
 * @param patch - the fields a card is setting.
 * @returns a new entry; neither argument is touched.
 */
export function mergeLorebookEntry(
  base: CardLorebookEntry,
  patch: Partial<CardLorebookEntry>,
): CardLorebookEntry {
  const merged: Record<string, unknown> = { ...base }
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = merged[field]
    if (Array.isArray(current) && Array.isArray(value)) {
      // Index-wise, longer tail kept — lodash's rule, not a spread's.
      merged[field] = current.map((element, at) => (at < value.length ? value[at] : element))
        .concat(value.slice(current.length))
      continue
    }
    merged[field] = value
  }
  return merged as unknown as CardLorebookEntry
}

/**
 * Give every entry in a write a uid nothing else in that write claims.
 *
 * Upstream's `handleLorebookEntriesCollision` (`lorebook_entry.ts:311`),
 * including the quadratic probe: an absent uid becomes a random one below a
 * million, and a collision advances by `i * i` modulo the same bound.
 *
 * **It has to happen here rather than being left to the host**, even though the
 * host runs the same algorithm (`resolveUidCollisions`): `uid` is the one
 * *required* field of the wire's entry shape, so an entry that reached the wire
 * without one would be rejected at validation — a card that wrote exactly what
 * upstream's declaration allows (`Partial<LorebookEntry>[]`, every field
 * optional) failing on a technicality of this transport.
 *
 * Upstream's own function also assigns `display_index` from a running maximum.
 * That half is dropped: the new shape has no such field and this host numbers
 * from array position, so a value assigned here would be computed and then
 * discarded.
 * @param entries - the entries as a card supplied them.
 * @returns the same entries, each with a uid, in the same order.
 */
export function assignLorebookUids(
  entries: readonly Partial<CardLorebookEntry>[],
): (Partial<CardLorebookEntry> & { uid: number })[] {
  const MAX_UID = 1_000_000
  const taken = new Set<number>()
  return entries.map((entry) => {
    let candidate = typeof entry.uid === 'number' ? entry.uid : Math.floor(Math.random() * MAX_UID)
    let step = 1
    while (taken.has(candidate)) {
      candidate = (candidate + step * step) % MAX_UID
      step += 1
    }
    taken.add(candidate)
    return { ...entry, uid: candidate }
  })
}

/**
 * What a `setLorebookSettings` call becomes on this host.
 *
 * Three destinations, because the sixteen fields upstream's table carries are
 * not one thing here: the scan knobs go to `worldbook.setSettings`, the global
 * selection is its own arm (`worldbook.setGlobalSelect` — installation-wide, a
 * list of names, and deliberately not a settings field), and one field has
 * nowhere to land at all.
 *
 * **`overflow_alert` is reported, never dropped.** This host stores no such
 * knob: `lorebookSettings()` answers it at SillyTavern's shipped value and the
 * scan has no branch on it. Accepting the write would make the next read
 * disagree with what the card just set, silently — the "apparent persist"
 * failure. Naming it is the honest half.
 *
 * **Fields already at the wanted value are dropped**, which is upstream's own
 * first act (`lorebook.ts:198`, `_.omitBy` against the current settings). It is
 * not an optimisation here either: every write crosses the boundary and comes
 * back as a new snapshot, so a card that re-sets what is already set would pay
 * a re-plan of every frame to change nothing.
 * @param settings - what the card asked for.
 * @param current - the settings as the snapshot reports them, when it has them.
 * @returns the scan patch, the selection when it changed, and the unstored
 *   fields the caller has to be told about.
 */
export function lorebookSettingsPatch(
  settings: Partial<LorebookSettings>,
  current?: LorebookSettings,
): {
    patch: Record<string, number | boolean | string>
    globalSelect?: string[]
    unstored: string[]
  } {
  /** Old name → this host's own name for the same knob. */
  const KNOBS: Record<string, string> = {
    scan_depth: 'scanDepth',
    // Two fields called budget upstream: this one is a percentage of context.
    context_percentage: 'budgetPercent',
    budget_cap: 'budgetCap',
    min_activations: 'minActivations',
    // Not the scan depth — the ceiling the *minimum activations* widening may
    // reach. The misleading name is upstream's and cards read it by name.
    max_depth: 'minActivationsDepthMax',
    max_recursion_steps: 'maxRecursionSteps',
    insertion_strategy: 'insertionStrategy',
    include_names: 'includeNames',
    recursive: 'recursive',
    case_sensitive: 'caseSensitive',
    match_whole_words: 'matchWholeWords',
    use_group_scoring: 'useGroupScoring',
  }

  const patch: Record<string, number | boolean | string> = {}
  const unstored: string[] = []
  let globalSelect: string[] | undefined

  for (const [field, value] of Object.entries(settings)) {
    if (value === undefined) continue
    if (field === 'selected_global_lorebooks') {
      const names = value as string[]
      const same = current !== undefined
        && current.selected_global_lorebooks.length === names.length
        && current.selected_global_lorebooks.every((name, at) => name === names[at])
      if (!same) globalSelect = [...names]
      continue
    }
    if (field === 'overflow_alert') {
      // Only when it would have changed something: a card echoing the value it
      // just read is not asking for anything, and reporting that would put a
      // gap note in front of a reader for a write nobody made.
      if (current === undefined || current.overflow_alert !== value) unstored.push(field)
      continue
    }
    const knob = KNOBS[field]
    // A field upstream's table does not have, arriving from a card that read
    // its own object back. Ignored rather than reported: it is not a gap in
    // this host, it is a key nobody declared.
    if (knob === undefined) continue
    if (current !== undefined && current[field as keyof LorebookSettings] === value) continue
    patch[knob] = value as number | boolean | string
  }

  return { patch, ...globalSelect === undefined ? {} : { globalSelect }, unstored }
}

/**
 * Upstream's `filter` option for `getLorebookEntries`, field by field.
 *
 * Three rules, and they are not one rule with cases — each behaves differently
 * enough that a card relies on which it gets (`lorebook_entry.ts:206`):
 *
 * - an **array** field is a subset test: every value asked for must be present;
 * - a **string** field is a substring test, not equality;
 * - anything else is strict equality.
 *
 * A field the entry does not carry compares as `undefined`, which only an
 * `undefined` expectation matches — and an expectation of `undefined` cannot
 * arrive, because the caller's `filter` object is walked with `Object.entries`.
 * @param entry - one entry in the old vocabulary.
 * @param filter - the caller's field expectations.
 * @returns whether the entry is kept.
 */
export function matchesLorebookFilter(
  entry: CardLorebookEntry,
  filter: Partial<CardLorebookEntry>,
): boolean {
  return Object.entries(filter).every(([field, expected]) => {
    const value = (entry as unknown as Record<string, unknown>)[field]
    if (Array.isArray(value)) {
      // The expectation is the subset, the entry's list is the superset —
      // upstream's direction, and reversing it would silently pass every entry
      // whose list is shorter.
      return Array.isArray(expected) && expected.every(wanted => value.includes(wanted))
    }
    if (typeof value === 'string') return typeof expected === 'string' && value.includes(expected)
    return value === expected
  })
}
