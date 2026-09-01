/**
 * `getWorldbook`, and the key revival that happens on the last hop to a card.
 *
 * Assertions here are about **behaviour**, never about `RegExp.prototype.source`.
 * That is not a style choice: `source` re-escapes forward slashes, so a pattern
 * built from `a\/b` and one built from `a/b` render identically — an assertion on
 * `source` passes for both and pins nothing. The neighbouring package learned
 * this the expensive way while moving `parseRegexFromString` between packages.
 *
 * @module iris-web/tests/worldbook-facade
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { EventBus } from '@iris/compat-tavernhelper-core'
import type { ScriptContext, WorldbookEntry } from '@iris/protocol'

import { UnsupportedApiError } from '../src/sandbox/errors.ts'
import { createFrameTavernHelper } from '../src/sandbox/tavern-helper.ts'

/** A minimal snapshot; nothing here reads it, but the façade requires one. */
function context(): ScriptContext {
  return {
    chat: [],
    chatMetadata: {},
    name1: 'You',
    name2: 'Her',
    characters: [],
    extensionSettings: {},
    variables: {},
    variableLayers: { global: {}, character: {}, script: {}, chat: {} },
  } as ScriptContext
}

/** One entry, with only the fields these tests care about varied. */
function entry(keys: string[], secondary: string[] = []): WorldbookEntry {
  return {
    uid: 1,
    name: 'an entry',
    enabled: true,
    strategy: {
      type: 'selective',
      keys,
      keys_secondary: { logic: 'and_any', keys: secondary },
      scan_depth: 'same_as_global',
    },
    position: { type: 'before_character_definition', role: 'system', depth: 0, order: 100 },
    content: 'body',
    probability: 100,
    recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
    effect: { sticky: null, cooldown: null, delay: null },
    addMemo: false,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    caseSensitive: null,
    matchWholeWords: null,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
  }
}

/** The façade, plus what it sent to the host. */
function surface(answer: unknown, fails?: Error) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const api = createFrameTavernHelper({
    context: () => context(),
    scriptId: () => undefined,
    reportGap: () => undefined,
    adoptVariables: () => undefined,
    call: async (method, params) => {
      calls.push({ method, params })
      if (fails !== undefined) throw fails
      return answer
    },
    triggerSlash: async () => '',
    events: new EventBus(),
  })
  return { api, calls }
}

/** `getWorldbook`, typed for these tests. */
type GetWorldbook = (name: string) => Promise<{
  strategy: { keys: (RegExp | string)[], keys_secondary: { keys: string[] } }
}[]>

/** A façade whose snapshot carries the given bindings, or none at all. */
function bound(charWorldbooks?: { primary: string | null, additional: string[] }) {
  const calls: string[] = []
  const api = createFrameTavernHelper({
    context: () => ({
      ...context(),
      ...(charWorldbooks === undefined ? {} : { charWorldbooks }),
    }),
    scriptId: () => undefined,
    reportGap: () => undefined,
    adoptVariables: () => undefined,
    call: async method => {
      calls.push(method)
      return undefined
    },
    triggerSlash: async () => '',
    events: new EventBus(),
  })
  return { api, calls }
}

/** `getCharWorldbookNames`, typed for these tests. */
type GetCharWorldbookNames = (name?: string) => { primary: string | null, additional: string[] }

test('the bindings are answered synchronously, with no host round trip', () => {
  /*
   * The property the whole design turns on. Upstream's declaration returns
   * `CharWorldbooks`, not a promise, and all five corpus call sites read a
   * property straight off the result — `getCharWorldbookNames('current').primary`.
   * A promise here would give them `undefined`, which flows into `getWorldbook`;
   * two of the three cards have no guard on that path.
   *
   * Asserting "not a promise" is not enough on its own, so the absence of any
   * call is asserted too: a member that reached the host could not be synchronous
   * whatever its return type said.
   */
  const scope = bound({ primary: '世界观设定', additional: ['补充设定'] })
  const names = (scope.api['getCharWorldbookNames'] as GetCharWorldbookNames)('current')

  assert.equal(names instanceof Promise, false, 'the card would read .primary off a promise')
  assert.equal(names.primary, '世界观设定')
  assert.deepEqual(names.additional, ['补充设定'])
  assert.deepEqual(scope.calls, [], 'a synchronous member cannot make a round trip')
})

test('a card with no bindings reads null and empty, not a missing field', () => {
  /*
   * Upstream returns an empty `CharWorldbooks` for a character with nothing bound
   * rather than throwing, and the snapshot field is optional only because older
   * snapshots predate it. Both absences collapse to the same answer here.
   */
  const absent = (bound().api['getCharWorldbookNames'] as GetCharWorldbookNames)('current')
  assert.deepEqual(absent, { primary: null, additional: [] })

  const empty = bound({ primary: null, additional: [] })
  assert.deepEqual(
    (empty.api['getCharWorldbookNames'] as GetCharWorldbookNames)('current'),
    { primary: null, additional: [] },
  )
})

test('the returned list cannot be mutated into another script’s view', () => {
  // The surface is shared between a card's scripts, so handing back the
  // snapshot's own array would let one script edit what the next one reads.
  const scope = bound({ primary: 'a', additional: ['b'] })
  const first = (scope.api['getCharWorldbookNames'] as GetCharWorldbookNames)('current')
  first.additional.push('injected')

  const second = (scope.api['getCharWorldbookNames'] as GetCharWorldbookNames)('current')
  assert.deepEqual(second.additional, ['b'], 'one reader mutated the snapshot for the next')
})

test('a named character is refused by name rather than answered wrongly', () => {
  /*
   * A measured gap, not an inferred one: all five corpus call sites pass
   * `'current'`, so this is the branch no card travels. Serving it would need the
   * snapshot to carry every character's bindings, which is unbounded — and the
   * alternative to refusing is handing back `undefined`, which the corpus's
   * dominant idiom would carry silently into `getWorldbook`.
   */
  const scope = bound({ primary: 'a', additional: [] })
  const call = scope.api['getCharWorldbookNames'] as GetCharWorldbookNames

  assert.throws(() => call('Seraphina'), (error: unknown) => {
    assert.ok(error instanceof UnsupportedApiError)
    assert.match(String(error.message), /only supports 'current'/u)
    return true
  })

  // Omitting the argument is not the same as asking for the current character;
  // upstream's parameter is required, so this lands in the same refusal.
  assert.throws(() => call(), UnsupportedApiError)
})

test('the book name reaches the host under the name the card used', async () => {
  const scope = surface({ entries: [] })
  await (scope.api['getWorldbook'] as GetWorldbook)('世界观设定')

  assert.deepEqual(scope.calls.map(one => one.method), ['getWorldbook'])
  assert.equal(scope.calls[0]?.params['name'], '世界观设定')
})

test('a regex-shaped key arrives as a live RegExp that matches what it should', async () => {
  /*
   * The whole reason revival is on this side: a `RegExp` cannot cross the frame
   * boundary — it arrives as `{}` — so the host sends what it read and the last
   * hop rebuilds it.
   */
  const scope = surface({ entries: [entry(['/gr[ae]y wolf/i'])] })
  const book = await (scope.api['getWorldbook'] as GetWorldbook)('book')

  const key = book[0]?.strategy.keys[0]
  assert.ok(key instanceof RegExp, 'a regex-shaped key was handed over as a plain string')
  assert.equal(key.test('a GREY WOLF appears'), true, 'the flags did not survive')
  assert.equal(key.test('a brown bear appears'), false)
})

test('an escaped slash inside a key still matches the literal slash', async () => {
  /*
   * The case that a `source` assertion cannot see. Both a correct and a broken
   * unescape render as the same `source`; only running the pattern separates
   * them.
   */
  const scope = surface({ entries: [entry(['/a\\/b/'])] })
  const book = await (scope.api['getWorldbook'] as GetWorldbook)('book')

  const key = book[0]?.strategy.keys[0]
  assert.ok(key instanceof RegExp)
  assert.equal(key.test('a/b'), true, 'the escaped slash did not survive revival')
})

test('a plain key stays a string, because null means plaintext and not failure', async () => {
  /*
   * `parseRegexFromString` returns `null` for anything that is not regex-shaped,
   * and upstream's semantics are to fall back to plaintext matching. Reading that
   * `null` as an error would drop every ordinary keyword in the book — which is
   * most of every book.
   */
  const scope = surface({ entries: [entry(['dragon', '/wyrm/i', 'not/a/regex'])] })
  const book = await (scope.api['getWorldbook'] as GetWorldbook)('book')

  const keys = book[0]?.strategy.keys ?? []
  assert.equal(keys[0], 'dragon')
  assert.ok(keys[1] instanceof RegExp)
  assert.equal(
    keys[2],
    'not/a/regex',
    'a key with bare slashes is not portable as a pattern, so upstream keeps it literal',
  )
})

test('secondary keys are left exactly as the host sent them', async () => {
  /*
   * Not an oversight — a deliberate non-guess. The contract documents revival for
   * the primary keys only, and reviving the secondary ones on the strength of
   * "it would be consistent" would be a divergence invented here rather than
   * copied. If upstream turns out to revive them, this test is the place that
   * changes, and its failure will say so.
   */
  const scope = surface({ entries: [entry(['/a/i'], ['/b/i'])] })
  const book = await (scope.api['getWorldbook'] as GetWorldbook)('book')

  assert.deepEqual(
    book[0]?.strategy.keys_secondary.keys,
    ['/b/i'],
    'secondary keys were revived, which the contract does not say upstream does',
  )
})

test('a book that does not exist rejects rather than reading as empty', async () => {
  /*
   * Upstream declares `@throws` for a missing book, and that is copied rather
   * than softened. "This book has no entries" and "there is no such book" lead a
   * card to different repairs, and an empty array says the first while meaning
   * the second.
   */
  const scope = surface(undefined, new Error('no world book named ghost'))

  await assert.rejects(
    (scope.api['getWorldbook'] as GetWorldbook)('ghost'),
    /no world book named ghost/u,
  )
})

test('a host that answers with nothing yields no entries rather than throwing', async () => {
  // Distinct from the case above: the call succeeded, so this is a book the host
  // says is empty, not a book it says is absent.
  const scope = surface({})
  const book = await (scope.api['getWorldbook'] as GetWorldbook)('book')
  assert.deepEqual(book, [])
})
