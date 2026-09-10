/**
 * The old `Lorebook` vocabulary, and the four `Worldbook` writes beside it.
 *
 * Two halves, deliberately tested differently:
 *
 * - the **mapping** is pure, so it is exercised directly, field by field, in
 *   both directions. A mapping tested only through the members would be pinned
 *   by whichever fields those members happen to vary;
 * - the **members** are exercised through the real façade with a recording
 *   host, so what is asserted is the call that would cross the boundary.
 *
 * The three assertions worth naming, because each one fails on a plausible
 * simpler implementation:
 *
 * 1. an old partial with no `type` must become **selective**, where the new
 *    API's default is `constant`. Forwarding the partial to `replaceWorldbook`
 *    passes every other test in this file and turns a card's blank entry
 *    always-on;
 * 2. `setLorebookEntries` merges key lists **index by index** (lodash's
 *    `_.merge`), so a spread would leave a removed keyword in the book;
 * 3. `setLorebookSettings` is **synchronous**, and a `Promise` returned from it
 *    is a value MVU's non-awaiting call site never looks at.
 *
 * @module iris-web/tests/lorebook-aliases
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { EventBus } from '@iris/compat-tavernhelper-core'
import type { LorebookSettings, ScriptContext, WorldbookEntry } from '@iris/protocol'

import { UnsupportedApiError } from '../src/sandbox/errors.ts'
import {
  assignLorebookUids,
  fromLorebookEntry,
  lorebookSettingsPatch,
  matchesLorebookFilter,
  mergeLorebookEntry,
  toLorebookEntry,
  type CardLorebookEntry,
} from '../src/sandbox/lorebook-aliases.ts'
import { createFrameTavernHelper } from '../src/sandbox/tavern-helper.ts'

/** One wire entry with every field set to something distinguishable. */
function wireEntry(over: Partial<WorldbookEntry> = {}): WorldbookEntry {
  return {
    uid: 7,
    name: 'the entry',
    enabled: false,
    strategy: {
      type: 'vectorized',
      keys: ['alpha', '/beta/i'],
      keys_secondary: { logic: 'not_all', keys: ['gamma'] },
      scan_depth: 3,
    },
    position: { type: 'at_depth', role: 'assistant', depth: 9, order: 42 },
    content: 'body',
    probability: 60,
    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: 4 },
    effect: { sticky: 2, cooldown: 3, delay: 5 },
    addMemo: true,
    group: 'clique',
    groupOverride: true,
    groupWeight: 250,
    caseSensitive: true,
    matchWholeWords: false,
    outletName: 'somewhere',
    automationId: 'auto-1',
    useGroupScoring: true,
    ignoreBudget: true,
    useProbability: true,
    triggers: ['normal'],
    characterFilter: { isExclude: true, names: ['Aria'], tags: ['t'] },
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    ...over,
  }
}

// ------------------------------------------------------------ the mapping

test('every old field is read from the new shape it lives in', () => {
  const old = toLorebookEntry(wireEntry(), 2)

  assert.deepEqual(old, {
    uid: 7,
    // The array position, not a stored number: the new shape carries no
    // `displayIndex` and this host renumbers from position on every write.
    display_index: 2,
    comment: 'the entry',
    enabled: false,
    type: 'vectorized',
    position: 'at_depth_as_assistant',
    depth: 9,
    order: 42,
    probability: 60,
    key: ['alpha', '/beta/i'],
    keys: ['alpha', '/beta/i'],
    logic: 'not_all',
    filter: ['gamma'],
    filters: ['gamma'],
    scan_depth: 3,
    case_sensitive: true,
    match_whole_words: false,
    use_group_scoring: true,
    automation_id: 'auto-1',
    exclude_recursion: true,
    prevent_recursion: true,
    delay_until_recursion: 4,
    content: 'body',
    group: 'clique',
    group_prioritized: true,
    group_weight: 250,
    sticky: 2,
    cooldown: 3,
    delay: 5,
  })
})

test('the deprecated spellings are copies, not the same array twice', () => {
  // Upstream's getter sets `key` beside `keys` and `filter` beside `filters`,
  // and a card sorting one must not find the other sorted with it — this
  // surface hands out detached data everywhere else for the same reason.
  const old = toLorebookEntry(wireEntry(), 0)
  old.keys.push('injected')
  old.filters.push('injected')

  assert.deepEqual(old.key, ['alpha', '/beta/i'])
  assert.deepEqual(old.filter, ['gamma'])
})

test('a deferred override reads as same_as_global, in both directions', () => {
  const deferred = toLorebookEntry(
    wireEntry({ caseSensitive: null, matchWholeWords: null, useGroupScoring: null, strategy: {
      type: 'selective', keys: [], keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global',
    } }),
    0,
  )
  assert.equal(deferred.case_sensitive, 'same_as_global')
  assert.equal(deferred.match_whole_words, 'same_as_global')
  assert.equal(deferred.use_group_scoring, 'same_as_global')
  assert.equal(deferred.scan_depth, 'same_as_global')

  const back = fromLorebookEntry({ ...deferred, uid: 1 })
  assert.equal(back.caseSensitive, null)
  assert.equal(back.matchWholeWords, null)
  assert.equal(back.useGroupScoring, null)
  assert.equal(back.strategy.scan_depth, 'same_as_global')
})

test('all nine old positions map onto the pair, and back', () => {
  const cases: [CardLorebookEntry['position'], WorldbookEntry['position']['type'], string][] = [
    ['before_character_definition', 'before_character_definition', 'system'],
    ['after_character_definition', 'after_character_definition', 'system'],
    ['before_example_messages', 'before_example_messages', 'system'],
    ['after_example_messages', 'after_example_messages', 'system'],
    ['before_author_note', 'before_author_note', 'system'],
    ['after_author_note', 'after_author_note', 'system'],
    ['at_depth_as_system', 'at_depth', 'system'],
    ['at_depth_as_user', 'at_depth', 'user'],
    ['at_depth_as_assistant', 'at_depth', 'assistant'],
  ]

  for (const [old, type, role] of cases) {
    const written = fromLorebookEntry({ uid: 0, position: old, depth: 6 })
    assert.equal(written.position.type, type, `${old} wrote the wrong position`)
    assert.equal(written.position.role, role, `${old} wrote the wrong role`)
    // …and the reading is the inverse for all nine, which is what makes a
    // card's read-modify-write leave the entry where it was.
    assert.equal(toLorebookEntry(wireEntry(written), 0).position, old, `${old} did not survive the round trip`)
  }
})

test('depth is null unless the entry is at a depth, and 4 when it comes back', () => {
  // Upstream's own rule (`lorebook_entry.ts:153`): the stored depth is reported
  // only for position 4, and a null depth is written back as the raw default.
  const anchored = toLorebookEntry(
    wireEntry({ position: { type: 'before_author_note', role: 'system', depth: 9, order: 1 } }),
    0,
  )
  assert.equal(anchored.depth, null, 'a non-depth entry must not report a depth')
  assert.equal(fromLorebookEntry({ ...anchored, uid: 1 }).position.depth, 4)
})

test('an outlet entry reads as at_depth, because upstream’s table has no row for it', () => {
  /*
   * Not a shortcut: upstream's old getter maps six position codes by table and
   * sends everything else — 4 and 7 alike — through the role fallback. So an
   * `outlet` entry read through the old API is `at_depth_as_<role>` there too,
   * and writing it back stores `at_depth`. **The outlet is lost by a round trip
   * through the old vocabulary, upstream's included.** Zero of the 2476 entries
   * in the two real corpora sit at position 7.
   */
  const old = toLorebookEntry(
    wireEntry({ position: { type: 'outlet', role: 'user', depth: 3, order: 1 } }),
    0,
  )
  assert.equal(old.position, 'at_depth_as_user')
  assert.equal(old.depth, null, 'only position 4 reports a depth')
  assert.equal(fromLorebookEntry({ ...old, uid: 1 }).position.type, 'at_depth')
})

test('an empty automation id is null, and null is written back as empty', () => {
  const none = toLorebookEntry(wireEntry({ automationId: '' }), 0)
  assert.equal(none.automation_id, null, 'upstream’s `|| null`')
  assert.equal(fromLorebookEntry({ ...none, uid: 1 }).automationId, '')
})

test('a recursion delay of none is false in the old shape and null in the new', () => {
  const none = toLorebookEntry(wireEntry({
    recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
  }), 0)
  // The old field is `boolean | number`, the new one `number | null`.
  assert.equal(none.delay_until_recursion, false)
  assert.equal(fromLorebookEntry({ ...none, uid: 1 }).recursion.delay_until, null)
  // And a real delay survives both ways.
  assert.equal(fromLorebookEntry({ uid: 1, delay_until_recursion: 3 }).recursion.delay_until, 3)
})

test('an entry with nothing set becomes selective, not constant', () => {
  /*
   * **The asymmetry this whole module exists for.** The old API's default row
   * is `constant: false, selective: true` (`lorebook_entry.ts:99`); the new
   * API's absent `strategy` means `constant: true` (`worldbook.ts:272`) — an
   * always-on entry. So forwarding an old partial to `replaceWorldbook` would
   * silently turn every blank entry a card writes into a blue-light one, in a
   * book the card then believes is keyword-gated.
   */
  const written = fromLorebookEntry({ uid: 0 })

  assert.equal(written.strategy.type, 'selective')
  // The rest of the old defaults, which are the same table's other rows.
  assert.equal(written.name, '')
  assert.equal(written.enabled, true)
  assert.equal(written.position.type, 'before_character_definition')
  assert.equal(written.position.order, 100)
  assert.equal(written.probability, 100)
  assert.equal(written.groupWeight, 100)
  assert.deepEqual(written.strategy.keys, [])
})

test('the write leg honours keys and filters, and ignores key and filter', () => {
  /*
   * Both halves are upstream's: its getter sets all four spellings and its
   * writer has transformers for `keys` and `filters` only, so a card writing
   * `key` is ignored **there** as well. Reproduced rather than improved,
   * because a card that "works" here and silently drops its keys on real
   * SillyTavern is the worse outcome.
   */
  const written = fromLorebookEntry({ uid: 0, key: ['ignored'], filter: ['ignored'], keys: ['kept'] })

  assert.deepEqual(written.strategy.keys, ['kept'])
  assert.deepEqual(written.strategy.keys_secondary.keys, [])
})

test('a full entry survives old → new → old unchanged', () => {
  // The strongest single property: whatever a card reads, it can hand straight
  // back. Anything the mapping loses shows up here as a diff.
  const old = toLorebookEntry(wireEntry(), 5)
  const round = toLorebookEntry(wireEntry(fromLorebookEntry({ ...old, uid: old.uid })), 5)
  assert.deepEqual(round, old)
})

test('the write leg drops the four fields the old shape cannot name', () => {
  /*
   * Stated as a test rather than only as a comment, because it is a **loss**
   * and the kind that is invisible in a diff: `outletName`, `triggers`,
   * `characterFilter` and `ignoreBudget` exist on disk, have no old spelling,
   * and are therefore reset by any write through this vocabulary. Upstream's
   * old writer loses exactly the same four — its default row has no key for
   * any of them.
   */
  const written = fromLorebookEntry({ ...toLorebookEntry(wireEntry(), 0), uid: 7 })

  assert.equal(written.outletName, '')
  assert.equal(written.ignoreBudget, false)
  assert.deepEqual(written.triggers, [])
  assert.deepEqual(written.characterFilter, { isExclude: false, names: [], tags: [] })
})

test('a probability that is not rolled reads as 100, and the write turns rolling on', () => {
  /*
   * The one field whose stored value cannot be recovered here: an entry with
   * `useProbability: false` arrives as `probability: 100` (this wire's rule and
   * upstream's new API's, `worldbook.ts:241`), while upstream's *old* getter
   * reports the stored number. Reporting what the entry actually does beats
   * inventing a number nobody sent. 23 of the 2476 real entries are in that
   * state.
   */
  const old = toLorebookEntry(wireEntry({ useProbability: false, probability: 100 }), 0)
  assert.equal(old.probability, 100)
  // And the write leg sets the flag, as upstream's default row does.
  assert.equal(fromLorebookEntry({ ...old, uid: 1 }).useProbability, true)
})

test('a merge patches index by index, the way lodash does', () => {
  /*
   * `setLorebookEntries` is `_.merge(data_entry, entry_to_set)`, and merge is
   * not a spread: two arrays merge element by element. A card narrowing a key
   * list from two to one keeps the second element — which a spread would drop,
   * making this host's book activate on fewer keywords than upstream's.
   */
  const base = toLorebookEntry(wireEntry({
    strategy: {
      type: 'selective', keys: ['x', 'y'], keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global',
    },
  }), 0)

  assert.deepEqual(mergeLorebookEntry(base, { keys: ['a'] }).keys, ['a', 'y'])
  // A longer patch keeps its own tail…
  assert.deepEqual(mergeLorebookEntry(base, { keys: ['a', 'b', 'c'] }).keys, ['a', 'b', 'c'])
  // …an undefined does not overwrite. Cast, because the compiler forbids an
  // explicit `undefined` here (`exactOptionalPropertyTypes`) and a card's
  // object does not go through the compiler: `{...entry, comment: maybe}` is
  // exactly how one arrives.
  assert.equal(
    mergeLorebookEntry(base, { comment: undefined } as unknown as Partial<CardLorebookEntry>).comment,
    base.comment,
  )
  // …and a scalar simply wins.
  assert.equal(mergeLorebookEntry(base, { comment: 'new' }).comment, 'new')
  // Neither argument is touched, so a caller's own object is never rewritten.
  assert.deepEqual(base.keys, ['x', 'y'])
})

test('uids are minted for entries that have none, and collisions probe', () => {
  // Upstream's `handleLorebookEntriesCollision`, and it has to happen in the
  // frame: `uid` is the one required field of the wire's entry shape, so an
  // entry without one would be refused at validation.
  const assigned = assignLorebookUids([{ uid: 5 }, { uid: 5 }, { comment: 'no uid' }])

  assert.equal(assigned[0]?.uid, 5)
  assert.equal(assigned[1]?.uid, 6, 'a collision advances by i * i, so the first step is 1')
  assert.equal(typeof assigned[2]?.uid, 'number')
  assert.equal(new Set(assigned.map(row => row.uid)).size, 3, 'two entries share a uid')
  // The order is the array's, because the array's order is what becomes
  // `displayIndex` on this host.
  assert.equal(assigned[2]?.comment, 'no uid')
})

test('the filter has three rules, and each is the one upstream uses', () => {
  const entry = toLorebookEntry(wireEntry({
    name: 'a haystack of words',
    strategy: {
      type: 'selective', keys: ['x', 'y', 'z'], keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global',
    },
  }), 0)

  // A string is a **substring** test, not equality — the rule most likely to be
  // "simplified" into `===`.
  assert.equal(matchesLorebookFilter(entry, { comment: 'haystack' }), true)
  assert.equal(matchesLorebookFilter(entry, { comment: 'needle' }), false)
  // An array is a subset test, in that direction: the expectation is the subset.
  assert.equal(matchesLorebookFilter(entry, { keys: ['x', 'z'] }), true)
  assert.equal(matchesLorebookFilter(entry, { keys: ['x', 'q'] }), false)
  // Anything else is equality.
  assert.equal(matchesLorebookFilter(entry, { uid: 7 }), true)
  assert.equal(matchesLorebookFilter(entry, { uid: 8 }), false)
  // Every field must pass, not any.
  assert.equal(matchesLorebookFilter(entry, { uid: 7, comment: 'needle' }), false)
})

/**
 * A complete settings table, so a test varies one field and states the rest.
 *
 * Spelled out rather than cast from a fragment: the patch's whole job is to
 * compare against what is already set, and a partial standing in for the
 * current settings would make every unmentioned field compare against
 * `undefined` — which is not a state this host can be in, and which would make
 * the "unchanged fields are dropped" assertion pass for the wrong reason.
 */
function settingsTable(over: Partial<LorebookSettings> = {}): LorebookSettings {
  return {
    selected_global_lorebooks: [],
    scan_depth: 2,
    context_percentage: 25,
    budget_cap: 0,
    min_activations: 0,
    max_depth: 0,
    max_recursion_steps: 0,
    insertion_strategy: 'character_first',
    include_names: true,
    recursive: false,
    case_sensitive: false,
    match_whole_words: false,
    use_group_scoring: false,
    overflow_alert: false,
    ...over,
  }
}

test('a settings patch renames the knobs, splits the selection, and names the unstored', () => {
  const current = settingsTable({ selected_global_lorebooks: ['Kept'] })

  const answer = lorebookSettingsPatch({
    scan_depth: 5,
    // Both misleading names, mapped by meaning rather than by spelling.
    context_percentage: 40,
    max_depth: 7,
    // Already at this value, so upstream drops it (`lorebook.ts:198`).
    recursive: false,
    selected_global_lorebooks: ['Kept', 'Added'],
    overflow_alert: true,
  }, current)

  assert.deepEqual(answer.patch, { scanDepth: 5, budgetPercent: 40, minActivationsDepthMax: 7 })
  assert.deepEqual(answer.globalSelect, ['Kept', 'Added'])
  assert.deepEqual(answer.unstored, ['overflow_alert'])
})

test('a settings patch that changes nothing sends nothing', () => {
  const current = settingsTable({ selected_global_lorebooks: ['A'], scan_depth: 2 })
  const answer = lorebookSettingsPatch({ scan_depth: 2, selected_global_lorebooks: ['A'] }, current)

  // Not an optimisation: every write comes back as a new snapshot, which
  // re-plans the frame budget and refreshes every running card.
  assert.deepEqual(answer.patch, {})
  assert.equal(answer.globalSelect, undefined)
  assert.deepEqual(answer.unstored, [])
})

// ------------------------------------------------------------ the members

/** A snapshot carrying whatever a test needs, and nothing invented. */
function context(over: Partial<ScriptContext> = {}): ScriptContext {
  return {
    chat: [],
    chatMetadata: {},
    name1: 'You',
    name2: 'Her',
    chatId: 'a chat',
    characters: [],
    extensionSettings: {},
    variables: {},
    variableLayers: { global: {}, character: {}, script: {}, chat: {} },
    ...over,
  } as ScriptContext
}

/** The façade, with every host call recorded and one canned answer. */
function surface(over: Partial<ScriptContext> = {}, answers: Record<string, unknown> = {}) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const gaps: string[] = []
  const faults: string[] = []
  const api = createFrameTavernHelper({
    context: () => context(over),
    scriptId: () => undefined,
    reportGap: message => gaps.push(message),
    reportFault: message => faults.push(message),
    adoptVariables: () => undefined,
    call: async (method, params) => {
      calls.push({ method, params })
      if (method in answers) {
        const answer = answers[method]
        if (answer instanceof Error) throw answer
        return answer
      }
      return undefined
    },
    triggerSlash: async () => '',
    events: new EventBus(),
  })
  return { api, calls, gaps, faults }
}

/** One member, typed loosely because the surface is `Record<string, unknown>`. */
const member = <T>(api: Record<string, unknown>, name: string): T => api[name] as T

test('getLorebooks answers the snapshot’s list synchronously, and copies it', () => {
  const scope = surface({ worldbookNames: ['One', 'Two'] })
  const names = member<() => string[]>(scope.api, 'getLorebooks')()

  assert.equal(names instanceof Promise, false, 'upstream returns string[], and cards call .includes on it')
  assert.deepEqual(names, ['One', 'Two'])
  names.push('injected')
  assert.deepEqual(member<() => string[]>(scope.api, 'getLorebooks')(), ['One', 'Two'])
  assert.deepEqual(scope.calls, [], 'a synchronous member cannot make a round trip')
})

test('getCharLorebooks defaults to the current card and ignores type, as upstream does', () => {
  const scope = surface({ charWorldbooks: { primary: 'Own', additional: ['Extra'] } })
  const get = member<(option?: { name?: string, type?: string }) => {
    primary: string | null
    additional: string[]
  }>(scope.api, 'getCharLorebooks')

  // No argument at all is upstream's `{name = 'current'}` default.
  assert.deepEqual(get(), { primary: 'Own', additional: ['Extra'] })
  /*
   * `type` is declared upstream (`lorebook.d.ts:42`) and its implementation
   * destructures `{name}` alone (`lorebook.ts:219`) — so asking for
   * `'primary'` gets both lists **there** too. Filtering here would make a card
   * behave differently on the two hosts, which is the one improvement this
   * surface may not make.
   */
  assert.deepEqual(get({ type: 'primary' }), { primary: 'Own', additional: ['Extra'] })
  assert.deepEqual(get({ name: 'current', type: 'additional' }), { primary: 'Own', additional: ['Extra'] })
})

test('a named character is refused by name, on both spellings of the read', () => {
  const scope = surface({ charWorldbooks: { primary: null, additional: [] } })
  assert.throws(
    () => member<(option?: { name?: string }) => unknown>(scope.api, 'getCharLorebooks')({ name: 'Someone' }),
    UnsupportedApiError,
  )
  assert.throws(
    () => member<(name?: string) => unknown>(scope.api, 'getCharWorldbookNames')('Someone'),
    UnsupportedApiError,
  )
})

test('getCurrentCharPrimaryLorebook is the primary binding and nothing else', () => {
  const bound = surface({ charWorldbooks: { primary: 'Own', additional: ['Extra'] } })
  assert.equal(member<() => string | null>(bound.api, 'getCurrentCharPrimaryLorebook')(), 'Own')

  const unbound = surface({ charWorldbooks: { primary: null, additional: [] } })
  assert.equal(member<() => string | null>(unbound.api, 'getCurrentCharPrimaryLorebook')(), null)
})

test('getChatLorebook honours the same existence guard as its new name', () => {
  const bound = surface({ chatMetadata: { world_info: 'Chat Book' }, worldbookNames: ['Chat Book'] })
  assert.equal(member<() => string | null>(bound.api, 'getChatLorebook')(), 'Chat Book')

  // A key naming a book that is gone reads as unbound, not as an error — the
  // rule upstream's getter applies (`lorebook.ts:317`).
  const dangling = surface({ chatMetadata: { world_info: 'Deleted' }, worldbookNames: [] })
  assert.equal(member<() => string | null>(dangling.api, 'getChatLorebook')(), null)
  // …and it is the same reading as the new spelling, which is the property the
  // shared local exists for.
  assert.equal(member<(name?: string) => string | null>(dangling.api, 'getChatWorldbookName')('current'), null)
})

test('setChatLorebook binds and unbinds through the same arm as rebindChatWorldbook', async () => {
  const scope = surface()
  await member<(name: string | null) => Promise<void>>(scope.api, 'setChatLorebook')('Book')
  await member<(name: string | null) => Promise<void>>(scope.api, 'setChatLorebook')(null)

  assert.deepEqual(scope.calls, [
    { method: 'rebindChatWorldbook', params: { name: 'Book' } },
    // `null` is upstream's unbind, and it has to reach the host as null rather
    // than as an absent field.
    { method: 'rebindChatWorldbook', params: { name: null } },
  ])
})

test('createLorebook and deleteLorebook answer the host’s booleans', async () => {
  const made = surface({}, { createWorldbook: { created: true }, deleteWorldbook: { deleted: true } })
  assert.equal(await member<(name: string) => Promise<boolean>>(made.api, 'createLorebook')('New'), true)
  assert.equal(await member<(name: string) => Promise<boolean>>(made.api, 'deleteLorebook')('Old'), true)
  assert.deepEqual(made.calls.map(call => call.method), ['createWorldbook', 'deleteWorldbook'])

  // "Already there" and "there was none" are both `false`, and neither is an
  // error — upstream's own shape for the get-or-create and delete idioms.
  const not = surface({}, { createWorldbook: { created: false }, deleteWorldbook: { deleted: false } })
  assert.equal(await member<(name: string) => Promise<boolean>>(not.api, 'createLorebook')('Old'), false)
  assert.equal(await member<(name: string) => Promise<boolean>>(not.api, 'deleteLorebook')('Ghost')['valueOf'](), false)
})

test('getLorebookEntries maps the book and numbers it by position', async () => {
  const scope = surface({}, {
    getWorldbook: { entries: [wireEntry({ uid: 4, name: 'first' }), wireEntry({ uid: 2, name: 'second' })] },
  })
  const entries = await member<(name: string, option?: unknown) => Promise<CardLorebookEntry[]>>(
    scope.api, 'getLorebookEntries',
  )('Book')

  assert.deepEqual(entries.map(entry => entry.comment), ['first', 'second'])
  /*
   * `display_index` follows the **order the host sent**, which is the book's
   * `displayIndex` order, and not the uids. Deliberate: this host renumbers
   * `displayIndex` from array position on every write, so answering in uid
   * order — which is what upstream's old getter does, its storage being an
   * object keyed by uid — would let a card's read-modify-write reorder the
   * book. 14 of the 29 books in the two real corpora have a uid order that
   * differs from their displayIndex order, so this is not a theoretical case.
   */
  assert.deepEqual(entries.map(entry => entry.display_index), [0, 1])
  assert.deepEqual(entries.map(entry => entry.uid), [4, 2])
})

test('the filter option is applied in the frame, on the mapped entries', async () => {
  const scope = surface({}, {
    getWorldbook: { entries: [wireEntry({ name: 'keep me' }), wireEntry({ uid: 8, name: 'drop me' })] },
  })
  const entries = await member<(
    name: string,
    option?: { filter?: 'none' | Partial<CardLorebookEntry> },
  ) => Promise<CardLorebookEntry[]>>(scope.api, 'getLorebookEntries')('Book', { filter: { comment: 'keep' } })

  assert.deepEqual(entries.map(entry => entry.comment), ['keep me'])
  // One read, no query on the wire: the filter is a set of field expectations
  // over the old vocabulary, which the host has no name for.
  assert.deepEqual(scope.calls.map(call => call.method), ['getWorldbook'])
})

test('replaceLorebookEntries writes the old defaults, not the new ones', async () => {
  const scope = surface({}, { replaceWorldbook: { entries: [] } })
  await member<(name: string, entries: readonly Partial<CardLorebookEntry>[]) => Promise<void>>(
    scope.api, 'replaceLorebookEntries',
  )('Book', [{ comment: 'blank' }])

  const sent = scope.calls[0]?.params as { name: string, entries: WorldbookEntry[] }
  assert.equal(sent.name, 'Book')
  // The asymmetry, asserted where it crosses the boundary: `selective`, and a
  // uid minted because the wire requires one.
  assert.equal(sent.entries[0]?.strategy.type, 'selective')
  assert.equal(typeof sent.entries[0]?.uid, 'number')
  assert.equal(sent.entries[0]?.name, 'blank')
})

test('setLorebookEntries patches by uid and ignores a uid the book has not got', async () => {
  const scope = surface({}, {
    getWorldbook: { entries: [wireEntry({ uid: 1, name: 'one' }), wireEntry({ uid: 2, name: 'two' })] },
    replaceWorldbook: { entries: [] },
  })
  await member<(
    name: string,
    entries: readonly (Partial<CardLorebookEntry> & { uid: number })[],
  ) => Promise<CardLorebookEntry[]>>(scope.api, 'setLorebookEntries')('Book', [
    { uid: 2, comment: 'patched' },
    // Upstream's `find` has no else branch: a uid the book does not hold is
    // silently nothing, rather than an entry being created.
    { uid: 99, comment: 'nowhere' },
  ])

  const sent = scope.calls[1]?.params as { entries: WorldbookEntry[] }
  assert.deepEqual(sent.entries.map(entry => entry.name), ['one', 'patched'])
  assert.equal(sent.entries.length, 2, 'an unknown uid must not append an entry')
})

test('createLorebookEntries takes the lowest free uid and reports which', async () => {
  const scope = surface({}, {
    getWorldbook: { entries: [wireEntry({ uid: 0 }), wireEntry({ uid: 2 })] },
    replaceWorldbook: { entries: [] },
  })
  const answer = await member<(
    name: string,
    entries: readonly Partial<CardLorebookEntry>[],
  ) => Promise<{ entries: CardLorebookEntry[], new_uids: number[] }>>(
    scope.api, 'createLorebookEntries',
  )('Book', [{ comment: 'a' }, { comment: 'b' }])

  // Upstream walks up from zero (`lorebook_entry.ts:391`) — not the random uid
  // its replace path mints — and a card holds these numbers to find its own
  // entries again.
  assert.deepEqual(answer.new_uids, [1, 3])
  const sent = scope.calls[1]?.params as { entries: WorldbookEntry[] }
  assert.deepEqual(sent.entries.map(entry => entry.uid), [0, 2, 1, 3])
})

test('createLorebookEntries does not write uids onto the caller’s own objects', async () => {
  // Upstream does (`entries.forEach(entry => (entry.uid = …))`). Not copied:
  // mutating a card's argument is not behaviour worth reproducing, and this
  // surface hands back copies everywhere else.
  const scope = surface({}, { getWorldbook: { entries: [] }, replaceWorldbook: { entries: [] } })
  const mine: Partial<CardLorebookEntry>[] = [{ comment: 'a' }]
  await member<(name: string, entries: readonly Partial<CardLorebookEntry>[]) => Promise<unknown>>(
    scope.api, 'createLorebookEntries',
  )('Book', mine)

  assert.equal(mine[0]?.uid, undefined, 'the card’s own object was written to')
})

test('deleteLorebookEntries says whether anything was actually removed', async () => {
  const book = { entries: [wireEntry({ uid: 1 }), wireEntry({ uid: 2 })] }
  const hit = surface({}, { getWorldbook: book, replaceWorldbook: { entries: [] } })
  const removed = await member<(name: string, uids: readonly number[]) => Promise<{
    entries: CardLorebookEntry[]
    delete_occurred: boolean
  }>>(hit.api, 'deleteLorebookEntries')('Book', [2])
  assert.equal(removed.delete_occurred, true)
  assert.deepEqual((hit.calls[1]?.params as { entries: WorldbookEntry[] }).entries.map(e => e.uid), [1])

  const miss = surface({}, { getWorldbook: book, replaceWorldbook: { entries: [] } })
  const nothing = await member<(name: string, uids: readonly number[]) => Promise<{
    delete_occurred: boolean
  }>>(miss.api, 'deleteLorebookEntries')('Book', [99])
  assert.equal(nothing.delete_occurred, false, 'a uid nothing matched must not read as a deletion')
  // The write happens anyway, which is upstream's behaviour: it routes through
  // `updateLorebookEntriesWith` unconditionally.
  assert.deepEqual(miss.calls.map(call => call.method), ['getWorldbook', 'replaceWorldbook'])
})

test('updateLorebookEntriesWith shows the updater the old vocabulary', async () => {
  const scope = surface({}, {
    getWorldbook: { entries: [wireEntry({ uid: 1, name: 'before' })] },
    replaceWorldbook: { entries: [wireEntry({ uid: 1, name: 'after' })] },
  })
  let seen: CardLorebookEntry[] = []
  const answer = await member<(
    name: string,
    updater: (entries: CardLorebookEntry[]) => Partial<CardLorebookEntry>[],
  ) => Promise<CardLorebookEntry[]>>(scope.api, 'updateLorebookEntriesWith')('Book', (entries) => {
    seen = entries
    return entries.map(entry => ({ ...entry, comment: 'after' }))
  })

  // The updater's input is the old shape — `comment`, not `name`.
  assert.deepEqual(seen.map(entry => entry.comment), ['before'])
  // And the answer is the host's stored book, not the updater's output: the
  // host mints uids and renumbers, so only the re-read tells the truth.
  assert.deepEqual(answer.map(entry => entry.comment), ['after'])
})

test('setLorebookSettings is synchronous, and splits into the two arms', () => {
  const scope = surface({
    worldbookNames: ['A', 'B'],
    lorebookSettings: settingsTable({ selected_global_lorebooks: ['A'], scan_depth: 2 }),
  })
  const set = member<(settings: Partial<LorebookSettings>) => void>(scope.api, 'setLorebookSettings')

  const answer = set({ scan_depth: 5, selected_global_lorebooks: ['A', 'B'] })

  // MVU has a call site that does not await this. Upstream's declaration is
  // `void`, so a promise here is a value that site never looks at.
  assert.equal(answer, undefined)
  assert.deepEqual(scope.calls, [
    { method: 'setLorebookSettings', params: { scanDepth: 5 } },
    { method: 'rebindGlobalWorldbooks', params: { names: ['A', 'B'] } },
  ])
})

test('a global selection naming a book that does not exist fails the whole call', () => {
  const scope = surface({ worldbookNames: ['A'] })
  assert.throws(
    () => member<(settings: Partial<LorebookSettings>) => void>(scope.api, 'setLorebookSettings')({
      scan_depth: 9,
      selected_global_lorebooks: ['A', 'Ghost', 'Phantom'],
    }),
    // Upstream's shape (`lorebook.ts:191`): one throw carrying **every**
    // missing name, so a card fixing them is not a card in a loop.
    /Ghost.*Phantom/u,
  )
  // And nothing was written — the check is before the writes, as upstream's is.
  assert.deepEqual(scope.calls, [])
})

test('a settings field this host cannot store is reported, not accepted', () => {
  const scope = surface({
    worldbookNames: [],
    lorebookSettings: settingsTable({ overflow_alert: false }),
  })
  member<(settings: Partial<LorebookSettings>) => void>(scope.api, 'setLorebookSettings')({ overflow_alert: true })

  assert.deepEqual(scope.calls, [], 'there is no arm for this knob, so nothing may be sent')
  assert.equal(scope.gaps.length, 1, `expected one gap note, saw ${JSON.stringify(scope.gaps)}`)
  assert.match(scope.gaps[0] ?? '', /overflow_alert/u)
  // The value came back unchanged from the read side, and silence there would
  // be a success byte-identical to having applied it.
  assert.match(scope.gaps[0] ?? '', /not a statement that it was applied/u)
})

test('a refused settings write is reported rather than thrown into nowhere', async () => {
  const scope = surface(
    { worldbookNames: [], lorebookSettings: settingsTable({ scan_depth: 2 }) },
    { setLorebookSettings: new Error('the host said no') },
  )
  member<(settings: Partial<LorebookSettings>) => void>(scope.api, 'setLorebookSettings')({ scan_depth: 9 })

  // The write is fired without an await, so the rejection has to be caught
  // here: an asynchronous throw from a `void` member arrives as an unhandled
  // rejection with no card frame in the stack. `writeButtons` set this shape.
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(scope.faults.length, 1, `expected one fault, saw ${JSON.stringify(scope.faults)}`)
  assert.match(scope.faults[0] ?? '', /the host said no/u)
})

test('a character rebind writes the additional list and never names the character', async () => {
  const scope = surface({
    worldbookNames: ['Extra'],
    charWorldbooks: { primary: 'Own', additional: [] },
  })
  await member<(name: 'current', books: { primary?: string | null, additional?: string[] }) => Promise<void>>(
    scope.api, 'rebindCharWorldbooks',
  )('current', { primary: 'Own', additional: ['Extra'] })

  /*
   * No `characterId` in the params, and that is the assertion: the frame is the
   * untrusted side, so a card naming a character could rebind someone else's
   * books. The shell fills the open character in — see `client/store.ts`.
   */
  assert.deepEqual(scope.calls, [
    { method: 'rebindCharWorldbooks', params: { names: ['Extra'] } },
  ])
})

test('changing the primary binding is refused, and nothing is written', async () => {
  const scope = surface({
    worldbookNames: ['Other', 'Extra'],
    charWorldbooks: { primary: 'Own', additional: [] },
  })
  /*
   * One argument, not two: `setCurrentCharLorebooks(lorebooks)` is the old
   * spelling and takes the bindings alone, while `rebindCharWorldbooks` takes
   * the character name first. Getting that wrong here made the test pass a
   * string as the bindings, so every field read `undefined`, the member
   * returned early, and the assertion reported a missing rejection — a wrong
   * call shape looking exactly like a missing refusal.
   */
  const rebind = member<(
    books: { primary?: string | null, additional?: string[] },
  ) => Promise<void>>(scope.api, 'setCurrentCharLorebooks')

  await assert.rejects(rebind({ primary: 'Other', additional: ['Extra'] }), UnsupportedApiError)
  /*
   * The primary lives inside the **card file** — upstream drives
   * `#character_world` and posts `/api/characters/edit` — and this host has no
   * arm for it. Half-applying the request would report success for a write that
   * did not happen, so the additional list is not sent either.
   */
  assert.deepEqual(scope.calls, [])
})

test('an unchanged primary is not a request, so the ordinary round trip works', async () => {
  // `setCurrentCharLorebooks({...getCharLorebooks(), additional: […]})` is the
  // shape a card writes. Refusing it for naming a value it is not changing
  // would refuse the common call.
  const scope = surface({
    worldbookNames: ['Extra'],
    charWorldbooks: { primary: 'Own', additional: [] },
  })
  await member<(books: { primary?: string | null, additional?: string[] }) => Promise<void>>(
    scope.api, 'setCurrentCharLorebooks',
  )({ primary: 'Own', additional: ['Extra'] })

  assert.deepEqual(scope.calls.map(call => call.method), ['rebindCharWorldbooks'])
})

test('a rebind naming a book with no file is refused before anything is written', async () => {
  const scope = surface({ worldbookNames: ['Extra'], charWorldbooks: { primary: null, additional: [] } })
  await assert.rejects(
    member<(books: { additional?: string[] }) => Promise<void>>(scope.api, 'setCurrentCharLorebooks')({
      additional: ['Extra', 'Ghost'],
    }),
    /Ghost/u,
  )
  // Upstream checks first and throws once (`lorebook.ts:255`). The host would
  // refuse too, but only after the frame had already decided to write — and a
  // half-applied rebind is what that order prevents.
  assert.deepEqual(scope.calls, [])
})

test('a dangling primary does not block a rebind of the additional list', async () => {
  /*
   * Found by this file's own first run, which is why it is here: the check used
   * to cover the primary as well — upstream's `_.concat` does — and it refused
   * the ordinary round trip for a card whose primary book is gone.
   *
   * That state is normal here on purpose: `getCharWorldbookNames` reports the
   * **binding**, not the book in use, and the host falls back to the card's
   * embedded copy. 2 of the corpus's 18 bindings dangle. Since this host never
   * writes the primary, validating it refuses a call over a name it is not
   * changing.
   */
  const scope = surface({
    worldbookNames: ['Extra'],
    charWorldbooks: { primary: 'Gone', additional: [] },
  })
  await member<(books: { primary?: string | null, additional?: string[] }) => Promise<void>>(
    scope.api, 'setCurrentCharLorebooks',
  )({ primary: 'Gone', additional: ['Extra'] })

  assert.deepEqual(scope.calls, [{ method: 'rebindCharWorldbooks', params: { names: ['Extra'] } }])
})

test('createOrReplaceWorldbook creates when it can and replaces when it cannot', async () => {
  const fresh = surface({}, { createWorldbook: { created: true } })
  assert.equal(
    await member<(name: string, book?: readonly unknown[]) => Promise<boolean>>(
      fresh.api, 'createOrReplaceWorldbook',
    )('New', [wireEntry()]),
    true,
  )
  // One call: the host's create takes the entries, so an absent book is not
  // create-then-write.
  assert.deepEqual(fresh.calls.map(call => call.method), ['createWorldbook'])

  const existing = surface({}, { createWorldbook: { created: false }, replaceWorldbook: { entries: [] } })
  assert.equal(
    await member<(name: string, book?: readonly unknown[]) => Promise<boolean>>(
      existing.api, 'createOrReplaceWorldbook',
    )('Old', [wireEntry()]),
    false,
  )
  assert.deepEqual(existing.calls.map(call => call.method), ['createWorldbook', 'replaceWorldbook'])
})

test('deleteWorldbookEntries shows the predicate revived keys and reports what went', async () => {
  const scope = surface({}, {
    getWorldbook: { entries: [wireEntry({ uid: 1, name: 'keep' }), wireEntry({ uid: 2, name: 'go' })] },
    replaceWorldbook: { entries: [wireEntry({ uid: 1, name: 'keep' })] },
  })
  const seen: unknown[] = []
  const answer = await member<(
    name: string,
    predicate: (entry: { name: string, strategy: { keys: unknown[] } }) => boolean,
  ) => Promise<{ worldbook: unknown[], deleted_entries: { name: string }[] }>>(
    scope.api, 'deleteWorldbookEntries',
  )('Book', (entry) => {
    seen.push(entry.strategy.keys[1])
    return entry.name === 'go'
  })

  // The predicate sees what `getWorldbook` returns, revival included — a
  // predicate testing `instanceof RegExp` behaves as it would upstream.
  assert.ok(seen[0] instanceof RegExp, 'the predicate was shown un-revived keys')
  assert.deepEqual(answer.deleted_entries.map(entry => entry.name), ['go'])
  assert.equal(answer.worldbook.length, 1)
  // The kept entries are what was written, and the deleted ones came from the
  // read — they no longer exist to be re-read.
  assert.deepEqual(
    (scope.calls[1]?.params as { entries: WorldbookEntry[] }).entries.map(entry => entry.name),
    ['keep'],
  )
})
