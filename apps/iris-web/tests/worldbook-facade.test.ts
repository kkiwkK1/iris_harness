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

/**
 * A key with an **escaped** delimiter, built rather than typed.
 *
 * Six characters: slash, `a`, backslash, slash, `b`, slash.
 *
 * The single most important fixture in this file and the easiest one to lose.
 * Typed as a literal it needs a doubled backslash, and a backslash in a string
 * literal has been eaten in transit in this repo seven times. What survives is a
 * key with **no escaped delimiter in it at all** — five characters, a perfectly
 * ordinary plaintext key. Every test using it keeps passing, having quietly
 * become a second copy of the plaintext case.
 *
 * The neighbouring package lost precisely this fixture, and found out only
 * because a deliberate mutation of its code failed to turn anything red. That is
 * the part worth naming: **a teeth-check assumes the fixture is sound.** When the
 * fixture is the broken thing, the test and the teeth-check fall silent together,
 * and each one's silence corroborates the other's.
 *
 * So it is assembled from a character code, and the test directly below checks it
 * independently of anything it is used for.
 */
const ESCAPED_SLASH_KEY = ['/a', String.fromCharCode(92), '/b/'].join('')

test('the escaped-delimiter fixture is what it claims to be', () => {
  /*
   * Guarding the input, not the code — and **do not delete this as redundant**.
   *
   * Measured, by degrading the constant to `/a/b/` and seeing who objects:
   *
   * | assertion | fixture degraded |
   * | --- | --- |
   * | this guard | red |
   * | `key instanceof RegExp` (the escaped-slash test) | red |
   * | the byte-for-byte round trip | **green** |
   *
   * The round trip is the strictest assertion here and the only one that cannot
   * see this failure, because a degraded fixture still satisfies the property it
   * checks: plaintext round-trips perfectly. Strictness defends against the code
   * being wrong; it offers nothing against the input not being what you think,
   * while looking like it does.
   *
   * So this guard is not a supplement to the round trip. For that test, it is the
   * whole of the immunity.
   */
  assert.equal(ESCAPED_SLASH_KEY.length, 6, 'the fixture lost its backslash')
  assert.equal(
    ESCAPED_SLASH_KEY.charCodeAt(2),
    92,
    'the third character must be a backslash, or this is just /a/b/',
  )
})

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
  strategy: {
    keys: (RegExp | string)[]
    keys_secondary: { keys: (RegExp | string)[] }
  }
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

/** A façade answering each wire method differently, recording every call. */
function duplex(answers: Record<string, unknown>, fails?: Record<string, Error>) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const api = createFrameTavernHelper({
    context: () => context(),
    scriptId: () => undefined,
    reportGap: () => undefined,
    adoptVariables: () => undefined,
    call: async (method, params) => {
      calls.push({ method, params })
      const failure = fails?.[method]
      if (failure !== undefined) throw failure
      return answers[method]
    },
    triggerSlash: async () => '',
    events: new EventBus(),
  })
  return { api, calls }
}

/** The two write members, typed for these tests. */
type ReplaceWorldbook = (
  name: string,
  entries: readonly unknown[],
  options?: { render?: 'debounced' | 'immediate' },
) => Promise<void>
type UpdateWorldbookWith = (
  name: string,
  updater: (book: unknown[]) => readonly unknown[] | Promise<readonly unknown[]>,
  options?: { render?: 'debounced' | 'immediate' },
) => Promise<{ uid: number }[]>

/** The `strategy.keys` of the first entry in a recorded `replaceWorldbook` call. */
function sentKeys(params: Record<string, unknown>): unknown[] {
  const entries = params['entries'] as { strategy?: { keys?: unknown[] } }[]
  return entries[0]?.strategy?.keys ?? []
}

test('a revived key is written back as the text the host stores', async () => {
  /*
   * The inverse of revival, and the reason it has to exist: `updateWorldbookWith`
   * hands the updater revived entries, so a card that returns them with one field
   * changed — which is what the corpus does — is handing back live `RegExp`
   * objects. Those are not merely lossy on the wire; the contract types keys as
   * strings, so the write would be refused, for a card that did nothing wrong.
   */
  const scope = duplex({ replaceWorldbook: { entries: [] } })
  await (scope.api['replaceWorldbook'] as ReplaceWorldbook)('book', [
    { uid: 1, strategy: { keys: [/gr[ae]y wolf/i, 'literal'] } },
  ])

  assert.deepEqual(
    sentKeys(scope.calls[0]?.params ?? {}),
    ['/gr[ae]y wolf/i', 'literal'],
    'a RegExp reached the wire, where it cannot survive',
  )
})

test('a key survives the full round trip byte for byte', async () => {
  /*
   * Revive then flatten must be the identity, including the case that motivated
   * `parseRegexFromString`'s odd unescape: `source` re-escapes exactly the
   * character the parser unescaped, so the two operations cancel.
   *
   * Asserted as a round trip rather than by inspecting either half, because each
   * half alone can be wrong in a way that reads as correct — which is how the
   * neighbouring package spent a round on an assertion that could not fail.
   */
  const original = [ESCAPED_SLASH_KEY, '/gr[ae]y/i', 'plain text', 'not/a/regex']
  const scope = duplex({
    getWorldbook: { entries: [entry(original)] },
    replaceWorldbook: { entries: [] },
  })

  const book = await (scope.api['getWorldbook'] as GetWorldbook)('book')
  await (scope.api['replaceWorldbook'] as ReplaceWorldbook)('book', book)

  const written = scope.calls.find(one => one.method === 'replaceWorldbook')
  assert.deepEqual(sentKeys(written?.params ?? {}), original)
})

test('secondary keys are flattened too, or the round trip is only half done', async () => {
  const scope = duplex({ replaceWorldbook: { entries: [] } })
  await (scope.api['replaceWorldbook'] as ReplaceWorldbook)('book', [
    { uid: 1, strategy: { keys_secondary: { logic: 'and_any', keys: [/b/i] } } },
  ])

  const entries = scope.calls[0]?.params['entries'] as {
    strategy?: { keys_secondary?: { keys?: unknown[] } }
  }[]
  assert.deepEqual(entries[0]?.strategy?.keys_secondary?.keys, ['/b/i'])
})

test('the updater sees the current book and its result is what gets written', async () => {
  const scope = duplex({
    getWorldbook: { entries: [entry(['/a/i']), entry(['b'])] },
    replaceWorldbook: { entries: [entry(['/a/i'])] },
  })

  let seen = 0
  await (scope.api['updateWorldbookWith'] as UpdateWorldbookWith)('book', book => {
    seen = book.length
    return [{ uid: 7, content: 'rewritten' }]
  })

  assert.equal(seen, 2, 'the updater was not given the current entries')
  assert.deepEqual(scope.calls.map(one => one.method), ['getWorldbook', 'replaceWorldbook'])
  assert.deepEqual(
    scope.calls[1]?.params['entries'],
    [{ uid: 7, content: 'rewritten' }],
    'what the updater returned is not what was sent',
  )
})

test('what comes back is the host’s stored book, not the updater’s output', async () => {
  /*
   * They differ wherever the host filled in a `uid` or renumbered `displayIndex`,
   * and those are exactly the changes a card cannot predict and needs to see.
   * Returning the updater's own array would hide them behind something that looks
   * right.
   */
  const scope = duplex({
    getWorldbook: { entries: [] },
    replaceWorldbook: { entries: [entry(['/kept/i'])] },
  })

  const result = await (scope.api['updateWorldbookWith'] as UpdateWorldbookWith)(
    'book',
    () => [{ uid: 0 }],
  )

  assert.equal(result.length, 1)
  assert.notDeepEqual(result, [{ uid: 0 }], 'the updater’s own array came back')
  assert.ok(
    (result[0] as unknown as { strategy: { keys: unknown[] } }).strategy.keys[0] instanceof RegExp,
    'the returned book was not revived on the way back',
  )
})

test('an async updater is awaited', async () => {
  // Upstream's `WorldbookUpdater` is a union of a sync and an async signature.
  const scope = duplex({
    getWorldbook: { entries: [] },
    replaceWorldbook: { entries: [] },
  })

  await (scope.api['updateWorldbookWith'] as UpdateWorldbookWith)('book', async () => {
    await Promise.resolve()
    return [{ uid: 3 }]
  })

  assert.deepEqual(scope.calls[1]?.params['entries'], [{ uid: 3 }])
})

test('a missing book throws before the updater is ever called', async () => {
  /*
   * Upstream reads before it replaces, so a card's function is never run against
   * a book that is not there. Worth pinning because the natural way to write this
   * — call the updater, then discover the read failed — would let a card's
   * side effects happen for a write that could never land.
   */
  let ran = false
  const scope = duplex({}, { getWorldbook: new Error('no world book named ghost') })

  await assert.rejects(
    (scope.api['updateWorldbookWith'] as UpdateWorldbookWith)('ghost', () => {
      ran = true
      return []
    }),
    /no world book named ghost/u,
  )

  assert.equal(ran, false, 'the updater ran against a book that does not exist')
  assert.deepEqual(scope.calls.map(one => one.method), ['getWorldbook'], 'a write was attempted anyway')
})

test('render is accepted and never reaches the wire as behaviour', async () => {
  // Upstream's hint for repainting its own editor, which Iris does not have.
  // Rejecting it would fail a card on an argument that means nothing here.
  const scope = duplex({ replaceWorldbook: { entries: [] } })
  await (scope.api['replaceWorldbook'] as ReplaceWorldbook)('book', [{ uid: 1 }], {
    render: 'immediate',
  })

  assert.equal(scope.calls.length, 1, 'the call was refused or duplicated')
  assert.deepEqual(scope.calls[0]?.params['entries'], [{ uid: 1 }])
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
  const scope = surface({ entries: [entry([ESCAPED_SLASH_KEY])] })
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

test('secondary keys are revived exactly like primary ones', async () => {
  /*
   * Measured on both sides rather than reasoned from symmetry: upstream applies
   * the same expression to each list (`worldbook.ts:214` and `:218`), and this
   * project's activation engine puts both through `matchKey`
   * (`activate.ts:967`, `matching.ts:121`), which begins with
   * `parseRegexFromString`.
   *
   * The agreement is the point. If only the primary keys were revived, a card
   * would hold plain strings for keys the engine is matching as patterns — two
   * halves each self-consistent, wrong together, and with nothing to report.
   *
   * This test previously asserted the opposite, and was wrong for a reason worth
   * keeping: the contract documented revival under `keys` and said nothing under
   * `keys_secondary`, and **silence about a sibling field reads as a statement
   * about that field**. Reading it narrowly was the right way to read what was
   * written; what was written was incomplete.
   */
  const scope = surface({ entries: [entry(['/a/i'], ['/b/i', 'plain'])] })
  const book = await (scope.api['getWorldbook'] as GetWorldbook)('book')

  const secondary = book[0]?.strategy.keys_secondary.keys ?? []
  const pattern = secondary[0]
  assert.ok(pattern instanceof RegExp, 'a secondary key was left as a string the engine treats as a pattern')
  assert.equal(pattern.test('B'), true, 'the flags did not survive on the secondary list')
  assert.equal(secondary[1], 'plain', 'a literal secondary key must stay literal')
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
