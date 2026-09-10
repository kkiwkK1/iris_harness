/**
 * The frame's identity and message members.
 *
 * Twenty-four members, and three properties decide whether they are right:
 *
 * 1. **The sync/async split is upstream's, not a preference.** Nineteen of them
 *    are synchronous upstream and are called that way — `getCurrentCharacterId()`
 *    lands straight in a comparison, `getPersonaNames().includes(...)` reads the
 *    result in the same statement — so a member that started returning a promise
 *    would break cards without a type error anywhere. Every synchronous one is
 *    asserted not to be a promise and not to make a call.
 * 2. **A degenerate answer must be reported, once.** Five of them cannot do what
 *    upstream does (no persona pictures, no macro engine in the frame, no
 *    reachable message element, no card-file write, no redraw arm), and each
 *    answers the value upstream's own contract allows while saying so. A plausible
 *    value with no report is the quietest way a gap hides; four hundred identical
 *    reports from a redraw loop is a flood that hides the others.
 * 3. **A narrowing must be visible in the answer.** The members that could reach
 *    another card or another conversation answer `null` — upstream's own
 *    not-found value — and report *which* limit produced it, so a card author
 *    cannot read "Iris scoped this" as "that card does not exist".
 *
 * @module iris-web/tests/identity-messages
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { EventBus } from '@iris/compat-tavernhelper-core'
import type { CharacterSummary, ScriptContext } from '@iris/protocol'

import { UnsupportedApiError } from '../src/sandbox/errors.ts'
import { createFrameTavernHelper } from '../src/sandbox/tavern-helper.ts'

/** Two cards, so "the played one" and "a neighbour" are different rows. */
function characters(): CharacterSummary[] {
  return [
    {
      characterId: 'aria',
      name: 'Aria',
      avatarUrl: '/iris/avatar/aria',
      tags: ['tagged'],
      creator: 'kk',
      // What the snapshot carries for the played card, and all it carries.
      data: { character_book: { name: 'AriaBook', entries: [{ comment: 'e' }] } },
      // Clipped to 200 code points by the host, which is why `getCharData`
      // omits it: this value is the trap the member exists not to fall into.
      description: 'clipped opening',
    },
    { characterId: 'bella', name: 'Bella', tags: [] },
  ]
}

/** A snapshot with two floors, two cards, two personas and one script. */
function context(): ScriptContext {
  return {
    chat: [
      { name: 'You', is_user: true, mes: 'first' },
      { name: 'Aria', is_user: false, mes: 'second' },
    ],
    chatMetadata: {},
    name1: 'U',
    name2: 'Aria',
    characterId: 'aria',
    chatId: 'chat-1',
    characters: characters(),
    extensionSettings: {},
    variables: {},
    charWorldbooks: { primary: 'AriaBook', additional: [] },
    personas: [{ id: 'p1', name: 'Traveller' }, { id: 'p2', name: 'Shadow' }],
    persona: {
      id: 'p1',
      name: 'Traveller',
      description: 'a wanderer',
      position: 'atdepth',
      depth: 7,
      role: 'user',
    },
    scripts: { 's1': { name: '手机UI', info: 'by kk' }, 's2': { name: 'nameless' } },
    variableLayers: { global: {}, character: {}, script: {}, chat: {} },
  }
}

/** The surface, plus everything it said and sent. */
function surface(overrides?: {
  context?: ScriptContext
  scriptId?: string
  currentMessageId?: number
  answer?: unknown
}) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const gaps: string[] = []
  const api = createFrameTavernHelper({
    context: () => overrides === undefined || !('context' in overrides) ? context() : overrides.context,
    scriptId: () => overrides?.scriptId,
    currentMessageId: () => overrides?.currentMessageId,
    reportGap: message => gaps.push(message),
    reportFault: message => gaps.push(message),
    adoptVariables: () => undefined,
    call: async (method, params) => {
      calls.push({ method, params })
      return overrides?.answer
    },
    triggerSlash: async command => `ran ${command}`,
    events: new EventBus(),
  })
  return { api, calls, gaps }
}

/** One member, off the surface bag. */
function member<T>(scope: { api: Record<string, unknown> }, name: string): T {
  const found = scope.api[name]
  assert.equal(typeof found, 'function', `${name} is not on the surface`)
  return found as T
}

// ── the split itself ─────────────────────────────────────────────────────

test('every member upstream answers synchronously answers synchronously here', () => {
  const scope = surface({ context: context(), scriptId: 's1' })
  // Called with arguments that succeed, so a promise is the only way to fail:
  // the point is the *shape* of the answer, not the value.
  const calls: [string, unknown[]][] = [
    ['getCharacterNames', []],
    ['getCharacterIds', []],
    ['getCurrentCharacterName', []],
    ['getCurrentCharacterId', []],
    ['getCharAvatarPath', ['current']],
    ['getCharData', ['current']],
    ['getPersonaNames', []],
    ['getPersonaIds', []],
    ['getCurrentPersonaName', []],
    ['getCurrentPersonaId', []],
    ['getPersonaAvatarPath', ['current']],
    ['getPersona', ['current']],
    ['getIframeName', []],
    ['getMessageId', ['TH-message--4--0']],
    ['getScriptName', []],
    ['getScriptInfo', []],
    ['replaceScriptInfo', ['note']],
    ['formatAsDisplayedMessage', ['text']],
    ['retrieveDisplayedMessage', [0]],
  ]
  for (const [name, args] of calls) {
    const answer = (member<(...a: unknown[]) => unknown>(scope, name))(...args)
    assert.equal(answer instanceof Promise, false, `${name} answered a promise`)
  }
  // Nineteen synchronous members and not one round trip between them: a read
  // that reached the host could not have answered before its caller read it.
  assert.deepEqual(scope.calls, [])
  assert.equal(calls.length, 19, 'the synchronous half of the family is nineteen members')
})

// ── characters ───────────────────────────────────────────────────────────

test('the library reads are index-parallel, and answer the host\'s ids', () => {
  const scope = surface()
  assert.deepEqual(member<() => string[]>(scope, 'getCharacterNames')(), ['Aria', 'Bella'])
  // Upstream answers avatar file names here; Iris answers its own ids, which is
  // what every other member of this family takes.
  assert.deepEqual(member<() => string[]>(scope, 'getCharacterIds')(), ['aria', 'bella'])
})

test('the current character is the chat\'s, and an empty name is null', () => {
  const scope = surface()
  assert.equal(member<() => string | null>(scope, 'getCurrentCharacterName')(), 'Aria')
  assert.equal(member<() => string | null>(scope, 'getCurrentCharacterId')(), 'aria')

  const { characterId: _characterId, ...anonymous } = context()
  const nobody = surface({ context: { ...anonymous, name2: '' } as ScriptContext })
  // `''` is upstream's "no card" and it turns it into null — the distinction a
  // card checks with `if (name === null)`.
  assert.equal(member<() => string | null>(nobody, 'getCurrentCharacterName')(), null)
  assert.equal(member<() => string | null>(nobody, 'getCurrentCharacterId')(), null)
})

test('an avatar path is Iris\'s own endpoint, and a card with no picture answers null', () => {
  const scope = surface()
  const path = member<(name?: string) => string | null>(scope, 'getCharAvatarPath')
  assert.equal(path('current'), '/iris/avatar/aria')
  assert.equal(path('ARIA'), '/iris/avatar/aria', 'a name or an id, folded, as upstream folds')
  // Never a filesystem path, and never upstream's `/characters/<file>`: those
  // two are the answers this member exists not to give.
  assert.match(path() ?? '', /^\/iris\/avatar\//)

  // A neighbouring card with no picture: null, and the report says which of the
  // two nulls this is.
  assert.equal(path('bella'), null)
  assert.equal(scope.gaps.length, 1)
  assert.match(scope.gaps[0] ?? '', /no image/)

  // A card that is not there answers null in silence, as upstream does.
  const missing = surface()
  assert.equal(member<(name?: string) => string | null>(missing, 'getCharAvatarPath')('nobody'), null)
  assert.deepEqual(missing.gaps, [])
})

test('getCharData answers the played card from the snapshot, and says what is missing', () => {
  const scope = surface()
  const data = member<(name?: string) => Record<string, unknown> | null>(scope, 'getCharData')('current')
  assert.ok(data !== null)

  assert.equal(data['name'], 'Aria')
  assert.equal(data['avatar'], 'aria')
  const inner = data['data'] as Record<string, unknown>
  // The one path the corpus's own call site reads.
  assert.deepEqual(
    (inner['character_book'] as { entries?: unknown[] }).entries,
    [{ comment: 'e' }],
  )
  // Upstream's `RawCharacter.getWorldName()` reads exactly this key.
  assert.equal((inner['extensions'] as Record<string, unknown>)['world'], 'AriaBook')

  // **The clip must not be served under the field's own name.** The snapshot
  // carries 200 code points of it; a card putting that in a prompt would be
  // silently wrong, so the field is absent and the report names it.
  assert.equal(Object.hasOwn(data, 'description'), false)
  assert.equal(Object.hasOwn(inner, 'description'), false)
  assert.match(scope.gaps.join(' '), /description, first_mes, personality, scenario and mes_example are absent/)
  assert.match(scope.gaps.join(' '), /getCharacter\('current'\)/)
})

test('getCharData answers null for a neighbour, and says the null is Iris\'s', () => {
  const scope = surface()
  const data = member<(name?: string) => unknown>(scope, 'getCharData')('bella')
  assert.equal(data, null)
  assert.match(scope.gaps.join(' '), /this conversation's own card only/)
  assert.match(scope.gaps.join(' '), /rather than a claim that the card does not exist/)
})

test('getCharacter is the round trip, and defaults to the played card', async () => {
  const scope = surface({ answer: { character: { avatar: 'aria', first_messages: ['M0'] } } })
  const get = member<(name?: string) => Promise<Record<string, unknown>>>(scope, 'getCharacter')

  assert.deepEqual(await get('current'), { avatar: 'aria', first_messages: ['M0'] })
  await get()
  assert.deepEqual(scope.calls, [
    { method: 'getCharacter', params: { name: 'current' } },
    { method: 'getCharacter', params: { name: 'current' } },
  ], 'an absent argument is upstream\'s own backward compatibility, not an error')
})

// ── personas ─────────────────────────────────────────────────────────────

test('the persona lists come out of the snapshot, index-parallel', () => {
  const scope = surface()
  assert.deepEqual(member<() => string[]>(scope, 'getPersonaNames')(), ['Traveller', 'Shadow'])
  assert.deepEqual(member<() => string[]>(scope, 'getPersonaIds')(), ['p1', 'p2'])
  assert.equal(member<() => string | null>(scope, 'getCurrentPersonaName')(), 'Traveller')
  assert.equal(member<() => string | null>(scope, 'getCurrentPersonaId')(), 'p1')
})

test('a host with no persona store is reported, and a profile with none is not', () => {
  const { personas: _personas, persona: _persona, ...withoutStore } = context()
  const absent = surface({ context: withoutStore as ScriptContext })
  assert.deepEqual(member<() => string[]>(absent, 'getPersonaNames')(), [])
  // Key-missing is not empty: the first is a fact about this host and gets a
  // line, the second is upstream's own answer and gets silence.
  assert.match(absent.gaps.join(' '), /keeps no persona store/)
  assert.equal(member<() => string | null>(absent, 'getCurrentPersonaName')(), null)

  const { persona: _selected, ...unselected } = context()
  const empty = surface({ context: { ...unselected, personas: [] } as ScriptContext })
  assert.deepEqual(member<() => string[]>(empty, 'getPersonaNames')(), [])
  assert.deepEqual(empty.gaps, [], 'a store holding nothing is not a gap in the host')
})

test('a persona avatar path is null, and the null is explained', () => {
  const scope = surface()
  assert.equal(member<(id?: string) => null>(scope, 'getPersonaAvatarPath')('current'), null)
  assert.match(scope.gaps.join(' '), /keeps no persona pictures/)
  // Never a made-up URL: a card would put it in an `<img src>` and show a
  // broken image with nothing anywhere saying why.
  assert.equal(member<(id?: string) => null>(scope, 'getPersonaAvatarPath')('p2'), null)
})

test('getPersona answers upstream\'s shape, with SillyTavern\'s own numbers', () => {
  const scope = surface()
  const persona = member<(id?: string) => Record<string, unknown>>(scope, 'getPersona')('current')

  assert.equal(persona['avatar_id'], 'p1')
  assert.equal(persona['name'], 'Traveller')
  assert.equal(persona['description'], 'a wanderer')
  // `AT_DEPTH: 4` and `USER: 1` — a card compares these as numbers, so a string
  // here would be a silent mismatch on every comparison.
  assert.equal(persona['position'], 4)
  assert.equal(persona['role'], 1)
  assert.equal(persona['depth'], 7)
  // The fields this host has no concept of, answered as upstream's empties
  // rather than invented: `is_default` false means "no such notion here".
  assert.equal(persona['title'], '')
  assert.equal(persona['lorebook'], '')
  assert.deepEqual(persona['connections'], [])
  assert.equal(persona['is_default'], false)
  // Absent, not empty: there is no persona picture to name.
  assert.equal(Object.hasOwn(persona, 'avatar'), false)

  // Its own name and id also reach it, as upstream's lookup allows.
  assert.equal(member<(id?: string) => Record<string, unknown>>(scope, 'getPersona')('traveller')['avatar_id'], 'p1')
})

test('getPersona defaults the two fields upstream defaults', () => {
  const scope = surface({
    context: {
      ...context(),
      persona: { id: 'p1', name: 'Traveller', description: 'x', position: 'inprompt' },
    },
  })
  const persona = member<(id?: string) => Record<string, unknown>>(scope, 'getPersona')('current')
  // `DEFAULT_DEPTH = 2`, `DEFAULT_ROLE = SYSTEM = 0`, both upstream's.
  assert.equal(persona['depth'], 2)
  assert.equal(persona['role'], 0)
  assert.equal(persona['position'], 0)
})

test('getPersona throws for a persona whose content does not travel, and says which limit', () => {
  const scope = surface()
  const get = member<(id?: string) => unknown>(scope, 'getPersona')

  assert.throws(() => get('p2'), (error: unknown) => {
    assert.ok(error instanceof UnsupportedApiError)
    assert.match(error.message, /content does not travel/)
    assert.match(error.message, /limit in Iris/)
    return true
  }, 'a persona that exists but is not selected is a narrowing, not a missing persona')

  assert.throws(() => get('nobody'), (error: unknown) => {
    assert.ok(error instanceof UnsupportedApiError)
    // Upstream's own sentence for this case, so a card's handler reads the same
    // thing it reads there.
    assert.match(error.message, /does not exist or its name is not unique/)
    return true
  })

  const { persona: _none, ...noPersona } = context()
  const none = surface({ context: noPersona as ScriptContext })
  assert.throws(() => member<(id?: string) => unknown>(none, 'getPersona')('current'), UnsupportedApiError)
})

// ── this frame's own name, and the calling script ────────────────────────

test('a script frame\'s name carries its script, and round-trips through getMessageId', () => {
  const scope = surface({ scriptId: 's1' })
  assert.equal(member<() => string>(scope, 'getIframeName')(), 'TH-script--手机UI--s1')
  // Upstream throws for a script frame's name here, and says not to ask.
  assert.throws(
    () => member<(name: string) => number>(scope, 'getMessageId')('TH-script--手机UI--s1'),
    UnsupportedApiError,
  )
})

test('a message frame\'s name carries its floor, and the placeholder is reported', () => {
  const scope = surface({ currentMessageId: 4 })
  const name = member<() => string>(scope, 'getIframeName')()
  assert.equal(name, 'TH-message--4--0')
  // The floor is the part upstream's own readers parse, and it survives the
  // round trip a card makes.
  assert.equal(member<(n: string) => number>(scope, 'getMessageId')(name), 4)
  assert.match(scope.gaps.join(' '), /trailing number is a placeholder/)
})

test('a frame that is neither has no Tavern Helper name', () => {
  const scope = surface()
  assert.throws(() => member<() => string>(scope, 'getIframeName')(), UnsupportedApiError)
})

test('getMessageId is upstream\'s pattern, suffix and all', () => {
  const scope = surface()
  const parse = member<(name: string) => number>(scope, 'getMessageId')
  assert.equal(parse('TH-message--12--3'), 12)
  // Upstream's second render path appends `_n`, and its own reader tolerates it.
  assert.equal(parse('TH-message--12--3_1'), 12)
  for (const wrong of ['', 'TH-message--x--0', 'TH-message--12', 'nonsense']) {
    assert.throws(() => parse(wrong), UnsupportedApiError, `"${wrong}" is not a floor's frame name`)
  }
})

test('a script reads its own name and note, and an unknown one reads upstream\'s empty string', () => {
  const scope = surface({ scriptId: 's1' })
  assert.equal(member<() => string>(scope, 'getScriptName')(), '手机UI')
  assert.equal(member<() => string>(scope, 'getScriptInfo')(), 'by kk')

  // A script with no author note: `''`, which is upstream's answer too.
  const noNote = surface({ scriptId: 's2' })
  assert.equal(member<() => string>(noNote, 'getScriptName')(), 'nameless')
  assert.equal(member<() => string>(noNote, 'getScriptInfo')(), '')

  // A message frame has no script, and upstream's store-miss answer is `''`.
  const noScript = surface({ currentMessageId: 0 })
  assert.equal(member<() => string>(noScript, 'getScriptName')(), '')
})

test('a snapshot with no script table is reported, because its answer is plausible', () => {
  const { scripts: _scripts, ...withoutScripts } = context()
  const scope = surface({ context: withoutScripts as ScriptContext, scriptId: 's1' })
  assert.equal(member<() => string>(scope, 'getScriptName')(), '')
  assert.match(scope.gaps.join(' '), /carries no script names/)
})

test('replaceScriptInfo is remembered, reported as unstored, and never crosses scripts', () => {
  const scope = surface({ scriptId: 's1' })
  member<(info: string) => void>(scope, 'replaceScriptInfo')('rewritten')

  // The card's own read-back agrees with its write, which is the only part of
  // upstream's behaviour this frame can keep.
  assert.equal(member<() => string>(scope, 'getScriptInfo')(), 'rewritten')
  assert.match(scope.gaps.join(' '), /nothing was stored/)
  assert.match(scope.gaps.join(' '), /this frame's life only/)

  // A second script's surface is a second closure — a note must not leak
  // sideways, which is what classifying these three as identity-bearing means.
  const sibling = surface({ scriptId: 's2' })
  assert.equal(member<() => string>(sibling, 'getScriptInfo')(), '')

  // Outside a script it refuses, as upstream's declaration requires.
  const notAScript = surface({ currentMessageId: 0 })
  assert.throws(
    () => member<(info: string) => void>(notAScript, 'replaceScriptInfo')('x'),
    UnsupportedApiError,
  )
})

// ── the message half ─────────────────────────────────────────────────────

test('the history brief asks the host once, and refuses another character in the frame', async () => {
  const scope = surface({ answer: { chats: [{ file_name: 'chat-1.jsonl', chat_items: 2 }] } })
  const brief = member<(name?: string) => Promise<unknown[] | null>>(scope, 'getChatHistoryBrief')

  assert.deepEqual(await brief('current'), [{ file_name: 'chat-1.jsonl', chat_items: 2 }])
  assert.deepEqual(scope.calls, [{ method: 'getChatHistoryBrief', params: {} }])

  // A neighbour: null, no call, and a report — the host would refuse it too,
  // and not asking keeps a card's mistake off the wire.
  assert.equal(await brief('bella'), null)
  assert.equal(scope.calls.length, 1)
  assert.match(scope.gaps.join(' '), /own character only/)
})

test('the history detail takes the brief rows back, as upstream\'s example does', async () => {
  const scope = surface({ answer: { chats: { 'a.jsonl': [{ mes: 'x' }] } } })
  const detail = member<(data: unknown, group?: boolean) => Promise<Record<string, unknown>>>(
    scope,
    'getChatHistoryDetail',
  )

  const answer = await detail([{ file_name: 'a.jsonl' }, { nothing: true }, null])
  assert.deepEqual(answer, { 'a.jsonl': [{ mes: 'x' }] })
  assert.deepEqual(scope.calls, [{ method: 'getChatHistoryDetail', params: { files: ['a.jsonl'] } }])

  // Upstream's own reader filters the same way and answers `{}` without asking
  // the server anything, so a list with no usable names makes no call.
  assert.deepEqual(await detail([{ nothing: true }]), {})
  assert.deepEqual(await detail('not an array'), {})
  assert.equal(scope.calls.length, 1)
})

test('the history detail says what happened to the fifty-first file, and to the group flag', async () => {
  const scope = surface({ answer: { chats: {} } })
  const detail = member<(data: unknown, group?: boolean) => Promise<Record<string, unknown>>>(
    scope,
    'getChatHistoryDetail',
  )

  const rows = Array.from({ length: 51 }, (_row, at) => ({ file_name: `c${String(at)}.jsonl` }))
  await detail(rows, true)

  const sent = scope.calls[0]?.params['files'] as string[]
  assert.equal(sent.length, 50, 'the host\'s cap is applied before the call, not discovered by it')
  assert.equal(sent[49], 'c49.jsonl')
  // Both departures are on the record: the dropped file and the ignored flag.
  assert.match(scope.gaps.join(' '), /answers at most 50/)
  assert.match(scope.gaps.join(' '), /no group conversations/)
})

test('formatAsDisplayedMessage returns the text and says no pass ran', () => {
  const scope = surface()
  const format = member<(text: string, option?: { message_id?: unknown }) => string>(
    scope,
    'formatAsDisplayedMessage',
  )

  assert.equal(format('**bold** {{char}}'), '**bold** {{char}}')
  // The same sentence shape `substidudeMacros` uses, and for its reason: text
  // handed back unchanged is otherwise indistinguishable from text that needed
  // nothing.
  assert.match(scope.gaps.join(' '), /applied none of the three passes/)
  assert.match(scope.gaps.join(' '), /not a statement that it needed nothing/)
})

test('formatAsDisplayedMessage keeps upstream\'s floor resolution and its throw', () => {
  const scope = surface()
  const format = member<(text: string, option?: { message_id?: unknown }) => string>(
    scope,
    'formatAsDisplayedMessage',
  )

  // Two floors: a user line then a character line. All four spellings resolve,
  // so none of them throws.
  for (const messageId of ['last', 'last_user', 'last_char', 0, 1, -1, -2]) {
    assert.equal(format('t', { message_id: messageId }), 't', `${String(messageId)} is a floor here`)
  }
  // Upstream's range, upstream's throw: a card whose floor is wrong hears about
  // it rather than getting its text back and carrying on.
  for (const wrong of [2, -3, 'latest', 1.5]) {
    assert.throws(
      () => format('t', { message_id: wrong }),
      UnsupportedApiError,
      `${String(wrong)} is not a floor of a two-floor chat`,
    )
  }

  // A chat with no floors at all: upstream throws "no message floor found".
  const empty = surface({ context: { ...context(), chat: [] } })
  assert.throws(
    () => member<(t: string) => string>(empty, 'formatAsDisplayedMessage')('t'),
    UnsupportedApiError,
  )
})

test('retrieveDisplayedMessage answers an empty jQuery, once reported, and is not cloned', () => {
  const realm = globalThis as unknown as Record<string, unknown>
  const had = Object.hasOwn(realm, 'jQuery')
  const before = realm['jQuery']
  // A stand-in that is not structured-cloneable, which is what a real jQuery
  // object is: if the member were not exempt from the clone at the surface's
  // exit, every call would add a second report about an uncloneable return.
  const empty = { length: 0, text: () => empty, append: () => empty }
  realm['jQuery'] = () => empty
  try {
    const scope = surface()
    const retrieve = member<(id?: number) => { length: number }>(scope, 'retrieveDisplayedMessage')
    const first = retrieve(0)
    assert.equal(first.length, 0, 'upstream answers an empty jQuery for an undisplayed floor')
    retrieve(1)
    retrieve(2)
    // One line for three calls, and nothing about cloning.
    assert.equal(scope.gaps.length, 1, `reports: ${scope.gaps.join(' | ')}`)
    assert.match(scope.gaps[0] ?? '', /opaque origin/)
  } finally {
    if (had) realm['jQuery'] = before
    else delete realm['jQuery']
  }
})

test('refreshOneMessage keeps upstream\'s early return, refuses a floor that is not there, and says who draws', async () => {
  const quiet = surface()
  // Upstream's first line: an empty handle means the floor is not displayed and
  // there is nothing to do — including nothing to report.
  await member<(id: number, mes?: unknown) => Promise<void>>(quiet, 'refreshOneMessage')(0, { length: 0 })
  assert.deepEqual(quiet.gaps, [])

  const scope = surface()
  const refresh = member<(id: number, mes?: unknown) => Promise<void>>(scope, 'refreshOneMessage')
  await refresh(1)
  await refresh(0)
  assert.equal(scope.gaps.length, 1, 'a redraw loop must not repeat the same line')
  assert.match(scope.gaps[0] ?? '', /re-renders on the host's own chat.updated/)

  const wrong = surface()
  await member<(id: number) => Promise<void>>(wrong, 'refreshOneMessage')(9)
  assert.match(wrong.gaps.join(' '), /which this conversation does not have/)
  // No host arm exists for a redraw, so nothing may be sent for one.
  assert.deepEqual(scope.calls, [])
})

test('a rotation crosses to the host, and a non-number never leaves the frame', async () => {
  const scope = surface()
  const rotate = member<(b: number, m: number, e: number, o?: unknown) => Promise<void>>(
    scope,
    'rotateChatMessages',
  )

  await rotate(1, 3, 4)
  await rotate(0, 1, 2, { refresh: 'all' })
  assert.deepEqual(scope.calls, [
    { method: 'rotateChatMessages', params: { begin: 1, middle: 3, end: 4 } },
    { method: 'rotateChatMessages', params: { begin: 0, middle: 1, end: 2, refresh: 'all' } },
  ])

  await assert.rejects(rotate(0, 1.5, 2), UnsupportedApiError)
  await assert.rejects(rotate(0, 1, Number.NaN), UnsupportedApiError)
  assert.equal(scope.calls.length, 2, 'a refused rotation must not reach the chat file')
})

test('a rotation asking for no redraw is told the view follows anyway', async () => {
  const scope = surface()
  const rotate = member<(b: number, m: number, e: number, o?: unknown) => Promise<void>>(
    scope,
    'rotateChatMessages',
  )
  await rotate(1, 2, 3, { refresh: 'none' })
  assert.match(scope.gaps.join(' '), /no way to change[\s\S]*the file and hold the display/)
  // Still sent: the write is what the card asked for, and only the switch is
  // unhonourable.
  assert.equal(scope.calls[0]?.params['refresh'], 'none')
})

// ── the reports themselves ───────────────────────────────────────────────

test('every degenerate answer in this family says so exactly once', () => {
  const scope = surface({ scriptId: 's1' })
  // Each of these answers a value upstream's own contract allows, and each says
  // which limit produced it. Calling twice must not double the line.
  member<(id?: string) => null>(scope, 'getPersonaAvatarPath')('current')
  member<(id?: string) => null>(scope, 'getPersonaAvatarPath')('current')
  member<(t: string) => string>(scope, 'formatAsDisplayedMessage')('a')
  member<(t: string) => string>(scope, 'formatAsDisplayedMessage')('b')
  member<(name?: string) => unknown>(scope, 'getCharData')('current')
  member<(name?: string) => unknown>(scope, 'getCharData')('current')

  assert.equal(scope.gaps.length, 3, `one line per fact, got: ${scope.gaps.join(' | ')}`)
})
