/**
 * The frame's Tavern Helper surface.
 *
 * Two things are being defended here. The first is *sameness with the host*:
 * `resolveRange` is a second implementation of a function that already exists
 * host-side, and the cases below are the host's own test cases, copied
 * deliberately so that a change to either side shows up as a disagreement
 * rather than as a card returning the wrong messages.
 *
 * The second is the sync/async split. It is not a style choice — MVU calls the
 * read family synchronously and awaits every write — so a read that started
 * returning a promise would break cards in a way no type checks here.
 *
 * @module iris-web/tests/tavern-helper
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { EventBus, MVU_EVENTS, TAVERN_EVENTS } from '@iris/compat-tavernhelper-core'
import type { ScriptContext } from '@iris/protocol'

import { UnsupportedApiError } from '../src/sandbox/errors.ts'
import { readFile } from 'node:fs/promises'

import { CARD_METHODS } from '../src/sandbox/card-api.ts'
import { TAVERN_HELPER_VERSION, createFrameTavernHelper, resolveRange } from '../src/sandbox/tavern-helper.ts'

/** A snapshot with three messages, the last carrying two swipes. */
function context(): ScriptContext {
  return {
    chat: [
      { name: 'You', is_user: true, mes: 'first' },
      { name: 'Her', is_user: false, mes: 'second' },
      { name: 'Her', is_user: false, mes: 'third', swipes: ['third', 'other'], swipe_id: 0 },
    ],
    chatMetadata: {},
    name1: 'You',
    name2: 'Her',
    characters: [],
    extensionSettings: {},
    chatId: 'chat-1',
    variables: { stat: { hp: 10 } },
    // Distinct values per layer, so a merge that drops one or takes them in the
    // wrong order is visible rather than plausible.
    variableLayers: {
      global: { fromGlobal: 1, overridden: 'global' },
      character: { fromCharacter: 1, overridden: 'character' },
      script: { s1: { fromScript: 1, overridden: 'script' }, other: { leaked: true } },
      chat: { fromChat: 1, overridden: 'chat' },
    },
  }
}

/** The snapshot with no chat open, which is a state a real frame can be in. */
function contextWithoutChat(): ScriptContext {
  const { chatId: _chatId, ...rest } = context()
  return rest as ScriptContext
}

/** The surface, plus a record of everything it sent to the host. */
function surface(overrides?: {
  context?: ScriptContext | undefined
  scriptId?: string
  answer?: unknown
  /** Per-method answers, for members that make more than one call. */
  answers?: Record<string, unknown>
}) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const gaps: string[] = []
  let snapshot = overrides === undefined || !('context' in overrides) ? context() : overrides.context
  const api = createFrameTavernHelper({
    context: () => snapshot,
    scriptId: () => overrides?.scriptId,
    reportGap: message => gaps.push(message),
    adoptVariables: variables => {
      if (snapshot !== undefined) snapshot = { ...snapshot, variables }
    },
    call: async (method, params) => {
      calls.push({ method, params })
      const perMethod = overrides?.answers
      if (perMethod !== undefined && Object.hasOwn(perMethod, method)) return perMethod[method]
      return overrides?.answer
    },
    triggerSlash: async command => `ran ${command}`,
    events: new EventBus(),
  })
  return { api, calls, gaps }
}

test('resolveRange agrees with the host, case for case', () => {
  // Copied from `packages/iris-compat-tavernhelper/tests/api.test.ts`. If these
  // ever disagree, one of the two implementations has moved.
  assert.deepEqual(resolveRange(-1, 3), [2])
  assert.deepEqual(resolveRange('0-2', 3), [0, 1, 2])
  assert.deepEqual(resolveRange('2-0', 3), [0, 1, 2], 'a reversed span still reads forwards')
  assert.deepEqual(resolveRange('all', 2), [0, 1])
  assert.deepEqual(resolveRange(0, 0), [], 'an empty chat names nothing')
})

test('a span may carry negative bounds on either side', () => {
  // The separator and the sign are the same character, which is the whole
  // reason this is scanned rather than split.
  assert.deepEqual(resolveRange('-2--1', 5), [3, 4])
  assert.deepEqual(resolveRange('-1-1', 5), [1, 2, 3, 4])
  assert.deepEqual(resolveRange(' 0 - 2 ', 3), [0, 1, 2], 'whitespace around the dash is upstream syntax')
})

test('a span that is not two integers is refused, not approximated', () => {
  /*
   * The host's grammar is `-?\d+`, and the rewrite here scans instead of
   * matching. `1.5-2` and `1e2-3` are the cases where a looser check would
   * diverge: both are finite numbers, neither is an index, and accepting them
   * would build a fractional-length array rather than report the typo.
   */
  assert.throws(() => resolveRange('1.5-2', 5), /unrecognized range/)
  assert.throws(() => resolveRange('1e2-3', 5), /unrecognized range/)
  assert.throws(() => resolveRange('abc-def', 5), /unrecognized range/)
})

test('the read family answers synchronously, because its callers do not await', () => {
  /*
   * MVU writes `deleteVariable(getLastMessageId(), ...)` — the result goes
   * straight in as an argument. A promise there would be passed along as a
   * message id and the failure would surface somewhere else entirely.
   */
  const { api } = surface()

  const lastId = (api['getLastMessageId'] as () => unknown)()
  const variables = (api['getVariables'] as () => unknown)()
  const messages = (api['getChatMessages'] as (range: number) => unknown)(0)

  assert.equal(lastId, 2)
  assert.ok(!(variables instanceof Promise), 'getVariables must not return a promise')
  assert.ok(!(messages instanceof Promise), 'getChatMessages must not return a promise')
  assert.deepEqual(variables, { stat: { hp: 10 } })
})

test('include_swipes returns one entry carrying every swipe', () => {
  /*
   * This test asserted the opposite — one entry per swipe, on the reasoning that
   * "cards index the result directly" — and both halves of it were wrong.
   *
   * Upstream returns one entry per **message**, carrying a `swipes` array
   * (`chat_message.ts:164`), and the fields are Tavern Helper's names, not
   * SillyTavern's: `message`, not `mes`. Four corpus sites read `.message` and
   * call a string method on it straight away, so the old shape threw there.
   *
   * Kept as one test rather than split, because the two mistakes had one cause:
   * a measurement of `context.chat` — which really does carry `mes` — applied to
   * a different surface.
   */
  const { api } = surface()
  const read = api['getChatMessages'] as (
    range: number,
    options?: { include_swipes?: boolean },
  ) => {
    message: string
    swipes?: string[]
    swipe_id?: number
    data?: Record<string, unknown>
    swipes_data?: Record<string, unknown>[]
  }[]

  const swiped = read(2, { include_swipes: true })
  assert.equal(swiped.length, 1, 'one entry per message, not per swipe')
  assert.deepEqual(swiped[0]?.swipes, ['third', 'other'])
  assert.equal(swiped[0]?.swipe_id, 0)

  const plain = read(2)
  assert.equal(plain.length, 1)
  assert.equal(plain[0]?.message, 'third', 'the selected swipe’s text, under Tavern Helper’s name')
  assert.equal(plain[0]?.swipes, undefined, 'without the flag there are no swipes')
})

test('data is present without swipes and absent with them', () => {
  /*
   * Upstream's own asymmetry, copied rather than smoothed: a caller asking for
   * every swipe gets `swipes_data` and **no `data` field at all**. Smoothing it
   * would mean a card written against upstream behaves differently here, and the
   * difference would only show on the swipe-reading path.
   */
  const { api } = surface()
  const read = api['getChatMessages'] as (
    range: number,
    options?: { include_swipes?: boolean },
  ) => { data?: unknown, swipes_data?: unknown[] }[]

  const plain = read(2)[0]
  assert.ok(plain !== undefined)
  assert.equal('data' in plain, true, 'the plain read must carry this floor’s variables')
  assert.equal('swipes_data' in plain, false)

  const swiped = read(2, { include_swipes: true })[0]
  assert.ok(swiped !== undefined)
  assert.equal('data' in swiped, false, 'upstream omits data when swipes were asked for')
  assert.equal(Array.isArray(swiped.swipes_data), true)
})

test('every scope the snapshot carries is answered, not refused', () => {
  /*
   * This assertion used to require the opposite, and the reversal is the point:
   * the refusal was never about the scope being unreachable, it was about the
   * *snapshot* not carrying it. The snapshot carries four layers now, so
   * refusing them would be a gap invented by this file.
   *
   * What has not changed is the rule the old test existed for: refusal, never
   * `{}`. MVU reads an empty answer as "not initialised yet" and writes its
   * defaults over whatever was really there — so an empty answer does not fail,
   * it destroys state and then succeeds.
   */
  const { api } = surface({ scriptId: 's1' })
  const read = api['getVariables'] as (option: { type: string }) => Record<string, unknown>

  assert.deepEqual(read({ type: 'global' }), { fromGlobal: 1, overridden: 'global' })
  assert.deepEqual(read({ type: 'character' }), { fromCharacter: 1, overridden: 'character' })
  assert.deepEqual(read({ type: 'chat' }), { fromChat: 1, overridden: 'chat' })
  assert.deepEqual(read({ type: 'script' }), { fromScript: 1, overridden: 'script' })
})

test('a scope that does not exist is still refused by name', () => {
  const { api } = surface()
  let caught: unknown
  try {
    ;(api['getVariables'] as (option: { type: string }) => unknown)({ type: 'nonsense' })
  } catch (error: unknown) {
    caught = error
  }

  assert.ok(caught instanceof UnsupportedApiError)
  assert.equal(caught.member, "getVariables({type:'nonsense'})")
})

test('one script cannot read another script’s scope', () => {
  /*
   * The host sends every partition because the context is fetched per card while
   * this scope is per script — so **the façade picking is the enforcement
   * point**, and this is the test of that sentence. The fixture puts a
   * recognisable value in a neighbour's partition precisely so a leak is visible
   * rather than plausible.
   */
  const { api } = surface({ scriptId: 's1' })
  const read = api['getVariables'] as (option: { type: string }) => Record<string, unknown>

  assert.equal('leaked' in read({ type: 'script' }), false)
})

test('a frame with no identity gets no script scope rather than a neighbour’s', () => {
  const { api } = surface()
  assert.throws(
    () => (api['getVariables'] as (option: { type: string }) => unknown)({ type: 'script' }),
    /script_id/,
  )
})

test('getAllVariables merges the four layers in upstream’s order', () => {
  /*
   * `global → character → script → chat`, later winning, shallow — upstream's
   * `_getAllVariables` for a script frame. No floor sweep: upstream folds
   * per-floor tables in only for a *message* frame.
   *
   * These two members used to be the same function returning the message scope,
   * which made this one wrong twice over — every layer upstream merges was
   * missing, and one upstream does not include was present. No measured card
   * calls it, so nothing had ever reported it.
   */
  const { api } = surface({ scriptId: 's1' })
  const all = (api['getAllVariables'] as () => Record<string, unknown>)()

  assert.equal(all['fromGlobal'], 1)
  assert.equal(all['fromCharacter'], 1)
  assert.equal(all['fromScript'], 1)
  assert.equal(all['fromChat'], 1)
  // Last layer wins, and the order is the assertion — not merely that all four
  // contributed.
  assert.equal(all['overridden'], 'chat')
  // Still not a neighbour's, and still not the message scope.
  assert.equal('leaked' in all, false)
  assert.equal('stat' in all, false)
})

test('a missing snapshot is refused by name rather than read as an empty chat', () => {
  // `getLastMessageId()` on an absent snapshot would otherwise answer -1, which
  // is a legitimate value meaning "empty chat".
  const { api } = surface({ context: undefined })

  assert.throws(() => (api['getLastMessageId'] as () => number)(), UnsupportedApiError)
})

test('a write sends the operation, not a merged tree', async () => {
  /*
   * The distinction the contract is built around: `insertOrAssign` lets the
   * incoming value win and replaces arrays wholesale, `insert` lets the existing
   * one win. Folding either here would put that rule in the half that is not
   * authoritative, where it can diverge without anyone noticing.
   */
  const cases = [
    ['replaceVariables', 'replace'],
    ['insertOrAssignVariables', 'insertOrAssign'],
    ['insertVariables', 'insert'],
  ] as const

  for (const [member, op] of cases) {
    const { api, calls } = surface()
    await (api[member] as (v: object, o?: object) => Promise<void>)({ stat: { hp: 3 } })
    assert.equal(calls[0]?.method, 'setVariables', 'the card-facing name; the shell maps it')
    assert.equal(calls[0]?.params['op'], op, `${member} must send ${op}`)
    assert.deepEqual(calls[0]?.params['variables'], { stat: { hp: 3 } })
  }
})

test('a write adopts the table the host returns, and nothing before it', async () => {
  /*
   * This is not the optimistic write it replaced. Applying a value before the
   * host answered would tell a card its write succeeded when the host might
   * still reject it; adopting what the host *returned* is reading back its
   * decision. Without it a card that writes then reads is answered from a state
   * that no longer exists.
   */
  const { api } = surface({ answer: { variables: { stat: { hp: 99 } } } })

  assert.deepEqual((api['getVariables'] as () => unknown)(), { stat: { hp: 10 } })
  await (api['replaceVariables'] as (v: object) => Promise<void>)({ stat: { hp: 99 } })
  assert.deepEqual((api['getVariables'] as () => unknown)(), { stat: { hp: 99 } })
})

test('a host that returns no table leaves the snapshot alone', async () => {
  // Absence is not an instruction to empty the scope.
  const { api } = surface({ answer: undefined })

  await (api['replaceVariables'] as (v: object) => Promise<void>)({ stat: { hp: 1 } })

  assert.deepEqual((api['getVariables'] as () => unknown)(), { stat: { hp: 10 } })
})

test('message_id "latest" is resolved here, because the host cannot', async () => {
  // Upstream syntax; the contract wants an index. The frame is the side holding
  // the chat it refers to.
  const { api, calls } = surface()

  await (api['replaceVariables'] as (v: object, o: object) => Promise<void>)(
    {},
    { type: 'message', message_id: 'latest' },
  )

  assert.equal(calls[0]?.params['messageId'], 2, 'the last of three messages')
})

test('a script-scoped write is partitioned by the running script', async () => {
  // Upstream's `withScript`: a bare `{type:'script'}` means *this* script, and
  // the frame is the only side that knows which one is running.
  const { api, calls } = surface({ scriptId: 'card-7' })

  await (api['replaceVariables'] as (v: object, o: object) => Promise<void>)({}, { type: 'script' })

  assert.equal(calls[0]?.params['scope'], 'script')
  assert.equal(calls[0]?.params['scriptId'], 'card-7')
})

test('a script scope with no identity is refused, not sent as anonymous', async () => {
  /*
   * Upstream throws in both directions rather than inventing an owner
   * (`JS-Slash-Runner/src/function/variables.ts`), and the host refuses for the
   * concrete reason: an `anonymous` catch-all merges two unidentified callers
   * into one persisted partition, so they would share state on disk without
   * either asking to.
   *
   * The frame refuses first so the message names the member rather than the
   * request. Reachable only from a body with no entry in `script.list` — a file
   * from disk, or the probe.
   */
  const { api, calls } = surface()
  await assert.rejects(
    () => (api['replaceVariables'] as (v: object, o: object) => Promise<void>)({}, { type: 'script' }),
    (error: unknown) =>
      error instanceof UnsupportedApiError && error.member === "replaceVariables({type:'script'})",
  )

  assert.deepEqual(calls, [], 'nothing should reach the host')
})

test('a scope the host does not store is refused before it becomes a round trip', async () => {
  // `preset` and `character` are real scopes in the domain but not in the
  // contract's enum. Sending one earns an `invalid-request` that names the
  // request; refusing here names the member and the scope.
  const { api } = surface()
  await assert.rejects(
    () => (api['replaceVariables'] as (v: object, o: object) => Promise<void>)({}, { type: 'preset' }),
    (error: unknown) =>
      error instanceof UnsupportedApiError && error.member === "replaceVariables({type:'preset'})",
  )
})

test('deletion names a path and is refused without one', async () => {
  const { api, calls } = surface()

  await (api['deleteVariable'] as (p: string, o?: object) => Promise<void>)('stat.hp')
  assert.equal(calls[0]?.params['op'], 'delete')
  assert.equal(calls[0]?.params['path'], 'stat.hp')
  assert.equal(calls[0]?.params['variables'], undefined, 'delete carries a path, not a value')

  await assert.rejects(
    () => (api['deleteVariable'] as (p: unknown) => Promise<void>)(7),
    UnsupportedApiError,
  )
})

test('swipeTo renames its argument at the boundary', async () => {
  // Upstream's parameter is `swipeId`; the wire says `swipeIndex`. Neither half
  // has to adopt the other's word for it.
  const { api, calls } = surface()

  await (api['swipeTo'] as (m: number, s: number) => Promise<unknown>)(2, 1)

  assert.equal(calls[0]?.method, 'swipeTo')
  assert.deepEqual(calls[0]?.params, { messageId: 2, swipeIndex: 1 })
})

test('updateVariablesWith reads from the host, not from the snapshot', async () => {
  /*
   * The updater is a function and cannot cross the boundary, so it runs here —
   * but what it runs *on* comes from the host. Reading the snapshot instead
   * would make this a read-modify-write against a base that may have gone stale
   * since the last push, silently discarding whatever changed in between.
   */
  const { api, calls } = surface({
    answers: {
      getVariables: { variables: { stat: { hp: 42 } } },
      setVariables: { variables: { stat: { hp: 43 } } },
    },
  })

  await (api['updateVariablesWith'] as (
    updater: (v: Record<string, unknown>) => Record<string, unknown>,
    option?: object,
  ) => Promise<void>)(variables => {
    ;(variables['stat'] as { hp: number }).hp += 1
    return variables
  })

  assert.equal(calls[0]?.method, 'getVariables', 'it reads first')
  assert.equal(calls[1]?.method, 'setVariables')
  assert.equal(calls[1]?.params['op'], 'replace')
  assert.deepEqual(
    calls[1]?.params['variables'],
    { stat: { hp: 43 } },
    'the updater ran on the host table (42), not on the snapshot (10)',
  )
})

test('updateVariablesWith works on a scope the snapshot does not carry', async () => {
  /*
   * MVU's `update_variables.ts:1549` applies the same updater to `chat` and then
   * to `message`, behind its "also update chat variables" setting. The `chat`
   * half used to refuse, because the frame could not read that scope.
   */
  const { api, calls } = surface({ answers: { getVariables: { variables: { a: 1 } } } })

  await (api['updateVariablesWith'] as (
    updater: (v: Record<string, unknown>) => Record<string, unknown>,
    option?: object,
  ) => Promise<void>)(variables => ({ ...variables, b: 2 }), { type: 'chat' })

  assert.equal(calls[0]?.params['scope'], 'chat')
  assert.equal(calls[0]?.params['messageId'], undefined, 'a chat scope names no message')
  assert.deepEqual(calls[1]?.params['variables'], { a: 1, b: 2 })
})

test('an empty scope is a starting point, not a failure', async () => {
  /*
   * The first `updateVariablesWith` on a new chat reads a scope nobody has
   * written to. Refusing there would deadlock the writer on exactly the case it
   * exists to handle. A failed *call* is the different thing, and it rejects
   * before anything is written.
   */
  const { api, calls } = surface({ answers: { getVariables: { variables: {} } } })

  await (api['updateVariablesWith'] as (
    updater: (v: Record<string, unknown>) => Record<string, unknown>,
    option?: object,
  ) => Promise<void>)(variables => ({ ...variables, seeded: true }))

  assert.deepEqual(calls[1]?.params['variables'], { seeded: true })
})

test('a failed read writes nothing at all', async () => {
  const { api, calls } = surface()
  const failing = createFrameTavernHelper({
    context: () => context(),
    scriptId: () => undefined,
    adoptVariables: () => undefined,
    reportGap: () => undefined,
    call: async method => {
      if (method === 'getVariables') throw new Error('host said no')
      calls.push({ method, params: {} })
      return undefined
    },
    triggerSlash: async () => '',
    events: new EventBus(),
  })
  void api

  await assert.rejects(
    () =>
      (failing['updateVariablesWith'] as (u: (v: object) => object) => Promise<void>)(v => v),
    /host said no/,
  )
  assert.deepEqual(calls, [], 'a read that failed must not be followed by a write')
})

test('the event tables are the host tables, including the two upstream misspellings', () => {
  /*
   * Not re-declared here — imported. That is the whole reason the core package
   * exists: a hand-copied `characterDeleted` that someone tidied to
   * `character_deleted` produces a listener that never fires and never errors.
   */
  const { api } = surface()

  assert.equal(api['tavern_events'], TAVERN_EVENTS)
  assert.equal(api['mvu_events'], MVU_EVENTS)
  assert.equal((api['tavern_events'] as Record<string, string>)['CHARACTER_DELETED'], 'characterDeleted')
  assert.equal(
    (api['tavern_events'] as Record<string, string>)['GENERATION_AFTER_COMMANDS'],
    'GENERATION_AFTER_COMMANDS',
  )
})

test('a listener registered through the card surface hears an emit on the same bus', async () => {
  const { api } = surface()
  const heard: unknown[] = []

  ;(api['eventOn'] as (event: string, listener: (value: unknown) => void) => void)(
    MVU_EVENTS.COMMAND_PARSED,
    value => heard.push(value),
  )
  await (api['eventEmit'] as (event: string, ...args: unknown[]) => Promise<void>)(
    MVU_EVENTS.COMMAND_PARSED,
    { command: 'set' },
  )

  assert.deepEqual(heard, [{ command: 'set' }])
})

test('both spellings a card may use resolve to the same members', () => {
  // Cards write `getVariables(...)` bare and `TavernHelper.getVariables(...)`,
  // and real cards in the corpus use each.
  const { api } = surface({ scriptId: 'card-1' })
  const nested = api['TavernHelper'] as Record<string, unknown>

  assert.equal((nested['getScriptId'] as () => unknown)(), 'card-1')
  assert.equal(nested['tavern_events'], api['tavern_events'])
})

test('subscribing to a table entry that does not exist fails loudly', () => {
  /*
   * Measured, not hypothetical: MVU references `tavern_events.WORLDINFO_UPDATED`
   * and `tavern_events.CHAT_COMPLETION_SETTINGS_READY`, and neither key is in
   * the shared table. Without this guard both read as `undefined`, the bus keys
   * them under the string "undefined", and the card ends up holding a live
   * subscription to an event that can never arrive — no error, no listener, no
   * way to tell from inside the card that anything is wrong.
   */
  const { api } = surface()
  const on = api['eventOn'] as (event: unknown, listener: () => void) => unknown
  let caught: unknown
  try {
    on(undefined, () => undefined)
  } catch (error: unknown) {
    caught = error
  }

  assert.ok(caught instanceof UnsupportedApiError)
  assert.equal(caught.member, 'eventOn(undefined)')
})

test('a real table entry still subscribes normally', () => {
  // The guard must not cost the ordinary path anything.
  const { api } = surface()

  assert.doesNotThrow(() =>
    (api['eventOn'] as (event: string, listener: () => void) => unknown)(
      TAVERN_EVENTS.MESSAGE_RECEIVED,
      () => undefined,
    ),
  )
})

test('an unexpanded macro says so, instead of passing for text that had none', () => {
  /*
   * The quietest way a gap can hide: a plausible ordinary value. Text handed
   * back unchanged is exactly what text with no macros in it looks like, so a
   * card author sees a working call and a result that simply did not need
   * expanding — while the truth is that this frame has no macro engine at all.
   *
   * Upstream returns the text too when nothing is wired, and matching that is
   * right. Doing it silently is not.
   */
  const { api, gaps } = surface()
  const withMacros = (api['substitudeMacros'] as (t: string) => string)('hello {{user}}')
  const plain = (api['substitudeMacros'] as (t: string) => string)('hello')

  assert.equal(withMacros, 'hello {{user}}', 'the text still comes back unchanged, as upstream does')
  assert.equal(plain, 'hello')
  assert.equal(gaps.length, 1, 'text with nothing to expand is not a gap')
  assert.match(gaps[0] ?? '', /not a statement that it had no macros/)
})

test('getTavernHelperVersion answers with the version it was transcribed from', () => {
  const { api } = surface()
  const version = (api['getTavernHelperVersion'] as () => string)()

  assert.equal(version, TAVERN_HELPER_VERSION)
  /*
   * The card behaviour this exists for. MagVarUpdate opens its initialisation
   * with a `< 3.4.17` threshold check; answering below it shows the user an
   * error toast, and answering nothing at all threw a ReferenceError on that
   * first line and stopped the publish chain before it began.
   */
  assert.ok(
    version.split('.').map(Number)[0] !== undefined && Number(version.split('.')[0]) >= 4,
    `a card checking for 3.4.17 or newer would be told ${version}`,
  )
})

test('the version matches the installed extension it was transcribed from', async t => {
  /*
   * The drift pin. This string is a claim about a specific installed copy of
   * JS-Slash-Runner — the same copy the 171-member surface and the seeded
   * globals were read off — so it has to be checked against that copy rather
   * than trusted. When the blueprint is upgraded, this fails until the number
   * moves with it.
   *
   * Skipped rather than failed where the corpus is absent: it is one machine's
   * install, and a test that cannot see it has learned nothing either way.
   * Skipping loudly beats passing quietly.
   */
  const manifest =
    `${(process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern')}/data/default-user/extensions/JS-Slash-Runner/manifest.json`
  let raw: string
  try {
    raw = await readFile(manifest, 'utf8')
  } catch {
    t.skip(`no local Tavern Helper install at ${manifest}; the version claim is unverified here`)
    return
  }

  const declared: unknown = (JSON.parse(raw) as { version?: unknown }).version
  assert.equal(
    TAVERN_HELPER_VERSION,
    declared,
    'the transcribed surface and the version Iris reports have come apart',
  )
})

test('the script-button members answer instead of being absent', () => {
  const { api, gaps } = surface({ scriptId: 's1' })

  // Absence is the one answer that is definitely wrong: a card wiring up its
  // buttons would die on a ReferenceError and everything after it never runs.
  const buttons = (api['getScriptButtons'] as () => unknown[])()
  assert.deepEqual(buttons, [], 'MVU feeds this straight into _.intersectionBy')

  /*
   * **The read half no longer reports a gap, and the split is the assertion.**
   *
   * It is answered from the snapshot now, so an empty list here means "this
   * script has published nothing" — a true answer about the data. Reporting a
   * gap beside a true answer is the thing the gap list must not do: a reader
   * who sees "Iris has not built this" beside a correct empty list has been
   * told to distrust a member that works, and every reading of that panel
   * afterwards is worth less.
   */
  assert.equal(
    gaps.filter(gap => gap.includes('getScriptButtons')).length,
    0,
    'an answered member must not also be reported as a gap',
  )

  // The writers are still stubs, and still say so: they accept the call so the
  // card finishes starting, and record once that nothing was written.
  assert.doesNotThrow(() => {
    ;(api['replaceScriptButtons'] as (b: unknown) => void)([{ name: 'a', visible: true }])
    ;(api['appendInexistentScriptButtons'] as (b: unknown) => void)([{ name: 'b', visible: false }])
  })

  assert.ok(gaps.some(gap => gap.includes('replaceScriptButtons')))
  assert.ok(gaps.some(gap => gap.includes('appendInexistentScriptButtons')))
  assert.ok(gaps.some(gap => gap.includes('script buttons are scope Iris has not built')))
})

test('getButtonEvent returns a usable event name, as upstream declares', () => {
  /*
   * Upstream's declaration is `getButtonEvent(button_name: string): string` and
   * its own example passes the result to `eventOn`. Returning a string is what
   * makes this stub safe for free: the card registers on a valid event name and
   * nothing ever emits it, because there is no button. A fabricated
   * subscription object would have moved the crash one property along.
   */
  const { api } = surface({ scriptId: 's1' })
  const event = (api['getButtonEvent'] as (name: unknown) => unknown)('刷新')

  assert.equal(typeof event, 'string')
  assert.ok((event as string).length > 0)
  assert.ok((event as string).includes('s1'), 'button events are per script upstream')
})

test('a script-button gap is reported once per member, not once per call', () => {
  const { api, gaps } = surface({ scriptId: 's1' })
  /*
   * Asked of a writer, because the reader stopped being a gap when it was
   * implemented. The dedupe still matters here and matters more: a card that
   * republishes its buttons on every variable change calls this repeatedly, and
   * one fact repeated forty times is a panel a reader stops reading.
   */
  const replace = api['replaceScriptButtons'] as (buttons: unknown) => void
  replace([{ name: 'a', visible: true }])
  replace([{ name: 'a', visible: false }])
  replace([])

  assert.equal(
    gaps.filter(gap => gap.includes('replaceScriptButtons')).length,
    1,
    'a card republishing its buttons would fill the panel with one fact',
  )
})

test('a floor-addressed read is refused by name rather than answered from the wrong floor', () => {
  const { api } = surface()
  const read = api['getVariables'] as (option?: unknown) => unknown

  /*
   * The failure this prevents is a write, not a read. MagVarUpdate's update flow
   * reads one floor's variables and merges them into `stat_data` before storing
   * — so answering with a snapshot that cannot tell floors apart does not return
   * a wrong value, it persists a merge built on one.
   */
  assert.throws(
    () => read({ type: 'message', message_id: 5 }),
    /message_id:5/,
    'a floor-addressed read must name what it refused',
  )

  // The refusal points at the project that will answer it, so a card author is
  // not told a permanent limit about something already scheduled.
  assert.throws(() => read({ type: 'message', message_id: 0 }), /message-frame project/)
})

test('an unaddressed read still works, because that is what a script frame can answer', () => {
  const { api } = surface()
  const read = api['getVariables'] as (option?: unknown) => unknown

  // `latest` and an absent id both mean "whatever this frame was given", which
  // is exactly what the snapshot holds. Refusing these would break every card.
  assert.doesNotThrow(() => read())
  assert.doesNotThrow(() => read({ type: 'message' }))
  assert.doesNotThrow(() => read({ type: 'message', message_id: 'latest' }))
})

test('generate calls the assembling host method, not the raw one', async () => {
  /*
   * This assertion replaced one that pinned the *note* explaining why the old
   * mapping was wrong. That note existed because this member routed to
   * `script.generateRaw`, so a card asking for the assembled generate got a
   * reply with no persona, no worldbook and no history — and it succeeded.
   *
   * The pin worked as intended: rewiring turned the old test red, so the person
   * doing it had to come here and read why the note was there before deleting
   * it. That is the whole value of writing the reason into an assertion.
   */
  const { api, calls } = surface({ answers: { generate: { text: 'assembled reply' } } })
  const generate = api['generate'] as (config: unknown) => Promise<unknown>

  const answer = await generate({ user_input: 'hello there' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, 'generate', 'the raw method would answer without the card')
  assert.equal(calls[0]?.params['userInput'], 'hello there', 'upstream spells it user_input')
  assert.equal(typeof calls[0]?.params['chatId'], 'string', 'the assembling method needs a chat')
  assert.equal(answer, 'assembled reply', 'upstream returns the text itself, not the envelope')
})

test('upstream’s max_chat_history is mapped, and "all" is spelled as absent', async () => {
  const bounded = surface({ answers: { generate: { text: 'x' } } })
  await (bounded.api['generate'] as (c: unknown) => Promise<unknown>)({
    user_input: 'hi',
    max_chat_history: 12,
  })
  assert.equal(bounded.calls[0]?.params['maxHistory'], 12)

  // Upstream's `'all'` and an absent value mean the same thing, and the contract
  // spells it as absent — passing the string through would fail validation for
  // something the card did not get wrong.
  const all = surface({ answers: { generate: { text: 'x' } } })
  await (all.api['generate'] as (c: unknown) => Promise<unknown>)({
    user_input: 'hi',
    max_chat_history: 'all',
  })
  assert.equal('maxHistory' in (all.calls[0]?.params ?? {}), false)
})

test('a streaming request is answered whole, and says so', async () => {
  /*
   * Measured on the sample card: the stream only drives a character-count
   * progress indicator, and the body comes from the awaited return value. So a
   * non-streaming implementation is not wrong — but a progress bar that never
   * moves is exactly the thing a card author would chase into their own code.
   */
  const { api, gaps } = surface({ answers: { generate: { text: 'done' } } })
  const answer = await (api['generate'] as (c: unknown) => Promise<unknown>)({
    user_input: 'hi',
    should_stream: true,
  })

  assert.equal(answer, 'done', 'the text is unaffected by not streaming')
  assert.ok(gaps.some(gap => gap.includes('progress indicator')))
})

test('generate refuses by name rather than sending an empty request', async () => {
  const { api, calls } = surface()
  const generate = api['generate'] as (config: unknown) => Promise<unknown>

  await assert.rejects(() => generate({}), /user_input/)
  assert.equal(calls.length, 0, 'nothing should reach the host')
})

test('generate refuses when the frame has no chat to generate into', async () => {
  /*
   * `chatId` is optional on the snapshot, so this is a state a real frame can be
   * in — a card loaded before a chat is open. Sending the request anyway would
   * fail validation at the host with a message about a missing field, which
   * names the wire contract rather than the situation.
   */
  const { api, calls } = surface({ context: { ...contextWithoutChat() } })
  const generate = api['generate'] as (config: unknown) => Promise<unknown>

  await assert.rejects(() => generate({ user_input: 'hi' }), /no chat to generate into/)
  assert.equal(calls.length, 0)
})

test('the two generates map to two different wire methods', () => {
  /*
   * The table is where this distinction has to be visible, because serving one
   * with the other succeeds. A single mapping — or the same wire method for
   * both — would be invisible until a card's replies came back without their
   * character.
   */
  assert.equal(CARD_METHODS['generate'], 'script.generate')
  assert.equal(CARD_METHODS['generateRaw'], 'script.generateRaw')
  assert.notEqual(CARD_METHODS['generate'], CARD_METHODS['generateRaw'])
})


/**
 * A chat whose floor variables differ per floor and per swipe.
 *
 * Shaped so that a wrong answer is a *different* answer rather than a coincidence
 * — see below on why the last floor cannot be the sample.
 */
function chatWithFloorVariables(): ScriptContext {
  return {
    ...context(),
    chat: [
      { name: 'You', is_user: true, mes: 'ask', variables: [{ turn: 'user-row' }] },
      {
        name: 'Her',
        is_user: false,
        mes: 'middle',
        swipes: ['middle', 'middle-alt', 'middle-third'],
        swipe_id: 1,
        // Only two tables for three swipes: the usual case, since a swipe that
        // never ran a variable update has none.
        variables: [{ floor: 'middle-0' }, { floor: 'middle-1' }],
      },
      { name: 'Her', is_user: false, mes: 'last', variables: [{ floor: 'last-0' }] },
    ],
  } as ScriptContext
}

test('data comes from the selected swipe of the floor that was asked for', () => {
  /*
   * **The sample is the middle floor, deliberately.** The card this fixes falls
   * back to `Mvu.getMvuData({message_id: -1})` when `data` is missing, and on the
   * *last* floor that fallback returns the same table the real answer would —
   * so the last floor cannot tell a working derivation from a broken one with a
   * fallback behind it. An immune sample, chosen against.
   *
   * It also has `swipe_id: 1`, so reading table `[0]` — the plausible mistake —
   * gives a different answer rather than the right one.
   */
  const { api } = surface({ context: chatWithFloorVariables() })
  const read = api['getChatMessages'] as (range: number) => { data?: Record<string, unknown> }[]

  assert.deepEqual(read(1)[0]?.data, { floor: 'middle-1' })
  assert.deepEqual(read(2)[0]?.data, { floor: 'last-0' })
})

test('swipes_data is one table per swipe, with holes filled', () => {
  /*
   * Length follows the swipes, not the recorded tables: a floor usually has more
   * swipes than tables, and indexing by `swipe_id` has to be safe for every swipe
   * that exists. `{}` rather than a hole, because `undefined` would make "no
   * variables written yet" indistinguishable from "out of range".
   */
  const { api } = surface({ context: chatWithFloorVariables() })
  const read = api['getChatMessages'] as (
    range: number,
    options?: { include_swipes?: boolean },
  ) => { swipes_data?: Record<string, unknown>[] }[]

  assert.deepEqual(read(1, { include_swipes: true })[0]?.swipes_data, [
    { floor: 'middle-0' },
    { floor: 'middle-1' },
    {},
  ])
})

test('a user row carries its own variables too', () => {
  /*
   * Measured: 79.7% of user rows in the corpus carry a full MVU table, and MVU's
   * `'latest'` finds a floor by a data predicate rather than by role — so a
   * derivation that blanked user rows would answer with stale data rather than
   * with nothing, and only on chats where the newest table happens to sit on a
   * user row.
   */
  const { api } = surface({ context: chatWithFloorVariables() })
  const read = api['getChatMessages'] as (range: number) => {
    role?: string
    data?: Record<string, unknown>
  }[]

  const row = read(0)[0]
  assert.equal(row?.role, 'user')
  assert.deepEqual(row?.data, { turn: 'user-row' })
})

test('the renamed fields carry the values upstream says they do', () => {
  // `is_hidden` is `is_system` and `message` is `mes ?? ''`, both verbatim from
  // upstream's own line. `message_id` is the floor number.
  const { api } = surface({
    context: {
      ...context(),
      chat: [{ name: 'Sys', is_user: false, is_system: true, mes: 'hidden note' }],
    } as ScriptContext,
  })
  const read = api['getChatMessages'] as (range: number) => Record<string, unknown>[]

  assert.deepEqual(read(0)[0], {
    message_id: 0,
    name: 'Sys',
    role: 'assistant',
    is_hidden: true,
    message: 'hidden note',
    extra: {},
    data: {},
  })
})

test('a narrator row on a user message is role "unknown", and filtering loses it', () => {
  /*
   * Two holes, one test, by 3e's design — and it goes red under the obvious
   * wrong implementation (deriving role from `is_user` alone, per upstream's
   * *declared* three-value union).
   *
   * Upstream (`chat_message.ts:91-103`):
   *
   *   role = extra.type === 'narrator' ? (is_user ? 'unknown' : 'system')
   *                                    : (is_user ? 'user'    : 'assistant')
   *
   * **Hole one:** `'unknown'` exists at runtime and upstream's own type says it
   * cannot. The declaration is a three-value union populated through an `as`
   * assertion (`:137`, `:148`), which validates nothing. Our type follows the
   * runtime, because a contract that repeats the lie makes the value
   * unrepresentable downstream while it keeps arriving.
   *
   * **Hole two:** the role filter compares against that derived role, and its
   * parameter type has no `'unknown'` — so those floors match no passable
   * argument and disappear from every filtered read. Inherited, not ours, and
   * copied deliberately.
   */
  const { api } = surface({
    context: {
      ...context(),
      chat: [
        { name: 'You', is_user: true, mes: 'plain user' },
        { name: 'Sys', is_user: true, mes: 'narrated', extra: { type: 'narrator' } },
        { name: 'Sys', is_user: false, mes: 'narrator note', extra: { type: 'narrator' } },
      ],
    } as ScriptContext,
  })
  const read = api['getChatMessages'] as (
    range: string,
    options?: { role?: string },
  ) => { role: string, message: string }[]

  assert.deepEqual(
    read('all').map(one => one.role),
    ['user', 'unknown', 'system'],
    'the narrator branch is missing — both of its outcomes',
  )

  const users = read('all', { role: 'user' })
  assert.deepEqual(
    users.map(one => one.message),
    ['plain user'],
    'the narrator-on-user floor must not come back under role:user',
  )
})

test('a card cannot reach the host’s button table through getScriptButtons', () => {
  /*
   * **What this test can and cannot tell you, because the first version of it
   * claimed more than it could show.**
   *
   * Two layers keep the host's array out of a card's hands: the member copies
   * its answer, and `createFrameTavernHelper` returns its surface through
   * `detachReturns`, which `structuredClone`s every call result. Both are inside
   * this factory, so there is **no route a test can take** that has one and not
   * the other.
   *
   * So this pins the contract — a card's edit must not reach the host table —
   * and it cannot attribute it to either layer: deleting exactly one keeps this
   * green. It was written as "at the member, not only at the wrapper", which was
   * a claim about attribution that the test never had the power to make.
   *
   * The member's own copy stays anyway, for a caller the detach layer does not
   * cover: composition **inside** this file (the append and update sugar are
   * both built on the raw surface, not the detached one).
   */
  const table = [
    { name: '开始', visible: true },
    { name: '调试', visible: false },
  ]
  const { api } = surface({
    context: { ...context(), scriptButtons: { mine: table } },
    scriptId: 'mine',
  })

  // The façade is a loose record, so members are reached by key and typed at
  // the call site — the convention every other test in this file follows.
  const read = api['getScriptButtons'] as () => { name: string, visible: boolean }[]
  const answered = read()
  const entry = answered[0]
  assert.ok(entry !== undefined)
  entry.name = 'clobbered'
  entry.visible = false

  assert.deepEqual(table, [
    { name: '开始', visible: true },
    { name: '调试', visible: false },
  ], 'the snapshot the host pushed must be untouched')
  assert.deepEqual(read(), [
    { name: '开始', visible: true },
    { name: '调试', visible: false },
  ], 'and the next read must not see the card’s edit')
})

test('getScriptButtons keeps hidden buttons in the table it answers with', () => {
  /*
   * `visible: false` hides a button from the bar; it does not remove it from the
   * table. The failure this pins is a read-modify-write: a card reads the list,
   * flips one entry, writes the whole table back — and if the read had dropped
   * the hidden ones, the write deletes them. The card author sees "toggling one
   * button deleted my others" and has no reason to suspect the read.
   */
  const { api } = surface({
    context: {
      ...context(),
      scriptButtons: {
        mine: [
          { name: '开始', visible: true },
          { name: '调试', visible: false },
        ],
      },
    },
    scriptId: 'mine',
  })

  // The façade is a loose record, so members are reached by key and typed at
  // the call site — the convention every other test in this file follows.
  const read = api['getScriptButtons'] as () => { name: string, visible: boolean }[]
  assert.deepEqual(read().map(button => button.name), ['开始', '调试'])
})

test('getScriptButtons answers this script’s table and not the first one it finds', () => {
  /*
   * Another script's table is listed **first** on purpose. With only one script
   * published, or with this one first, an implementation that ignored the id
   * entirely — `Object.values(scriptButtons)[0]` — returns the right answer for
   * the wrong reason and every test agrees with it.
   *
   * The failure it hides is not a wrong list: it is one card publishing buttons
   * and a different card's frame answering with them, which upstream's
   * per-script registry exists to prevent.
   */
  const { api } = surface({
    context: {
      ...context(),
      scriptButtons: {
        theirs: [{ name: 'not mine', visible: true }],
        mine: [{ name: '开始', visible: true }],
      },
    },
    scriptId: 'mine',
  })
  const read = api['getScriptButtons'] as () => { name: string, visible: boolean }[]

  assert.deepEqual(read().map(button => button.name), ['开始'])
})
