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
import {
  TAVERN_HELPER_VERSION,
  createFrameTavernHelper,
  resolveRange,
  settledEvents,
} from '../src/sandbox/tavern-helper.ts'

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
  /**
   * The bus, when a test needs to emit on the same one the surface listens to.
   *
   * `injectPrompts({once:true})` subscribes to a generation settling, and a
   * test that could not emit that event could only assert the subscription was
   * made — which is what the implementation this replaced also did, to three
   * event names nothing emits.
   */
  events?: EventBus
}) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const gaps: string[] = []
  let snapshot = overrides === undefined || !('context' in overrides) ? context() : overrides.context
  const api = createFrameTavernHelper({
    context: () => snapshot,
    scriptId: () => overrides?.scriptId,
    reportGap: message => gaps.push(message),
    reportFault: message => gaps.push(message),
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
    events: overrides?.events ?? new EventBus(),
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

/** The member under test, typed off the surface bag. */
function setChatMessages(
  scope: { api: Record<string, unknown> },
): (messages: readonly Record<string, unknown>[]) => Promise<void> {
  return scope.api['setChatMessages'] as (messages: readonly Record<string, unknown>[]) => Promise<void>
}

test('setChatMessages routes each patch field to the arm that owns it', async () => {
  /*
   * The measured card starts its whole game through
   * `setChatMessages([{ message_id: 0, swipe_id: 1 }])` — a swipe patch, and
   * the swipe arm is where it has to land. A text patch lands on the rewrite
   * arm the journal replay uses. Both routable, neither invented.
   */
  const swipe = surface()
  await setChatMessages(swipe)([{ message_id: 0, swipe_id: 1 }])
  assert.deepEqual(swipe.calls, [
    { method: 'swipeTo', params: { messageId: 0, swipeIndex: 1 } },
  ])

  const text = surface()
  await setChatMessages(text)([{ message_id: 2, message: ' rewritten ' }])
  assert.deepEqual(text.calls, [
    { method: 'setChatMessages', params: { messages: [{ messageId: 2, message: ' rewritten ' }] } },
  ])
})

test('setChatMessages names the fields it could not carry', async () => {
  /*
   * A patch carrying `data` must not be readable as one that applied. The
   * carried fields still run; the uncarrried ones are named once, on the gap
   * channel, because the card carried on.
   */
  const scope = surface()
  await setChatMessages(scope)([
    { message_id: 0, swipe_id: 1 },
    { message_id: 1, data: { hp: 5 } },
  ])
  assert.equal(scope.calls.length, 1, 'the uncarrried patch was applied anyway')
  assert.match(scope.gaps.join(' '), /data/)

  // And a carried field must not smuggle an uncarrried one past the report.
  const mixed = surface()
  await setChatMessages(mixed)([{ message_id: 0, message: 'x', data: 1 }])
  assert.equal(mixed.calls.length, 1)
  assert.match(mixed.gaps.join(' '), /data/)
})

test('setChatMessages refuses a patch without a readable message_id', async () => {
  const scope = surface()
  await assert.rejects(
    () => setChatMessages(scope)([{ swipe_id: 1 }]),
    /message_id/,
    'a patch naming no floor would silently do nothing',
  )
})

test('createChatMessages maps roles onto the wire rows the host arm takes', async () => {
  /*
   * The 建国控制台's chain: `createChatMessages([{ role: 'user', message }])`
   * bare, then `/trigger`. The member has to answer that bare call — upstream
   * flattens it onto the window — and translate `role` into the storage
   * vocabulary the host arm stores: the chat's own speaker names, `is_user`,
   * and the narrator flag for `system`.
   */
  const calls = surface({
    // The chat already holds three floors, so the answer view carries six and
    // the created ids are the tail — what a real host answer looks like.
    answers: {
      createChatMessages: {
        view: { messages: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] },
      },
    },
  })
  const create = calls.api['createChatMessages'] as (
    messages: readonly Record<string, unknown>[],
    options?: Record<string, unknown>,
  ) => Promise<number[]>
  const ids = await create([
    { role: 'user', message: '<PolSimInit>…</PolSimInit>' },
    { role: 'assistant', message: 'Established.' },
    { role: 'system', message: '(narrator)' },
  ])
  assert.deepEqual(calls.calls, [
    {
      method: 'createChatMessages',
      params: {
        messages: [
          { name: 'You', is_user: true, mes: '<PolSimInit>…</PolSimInit>' },
          { name: 'Her', is_user: false, mes: 'Established.' },
          { name: 'Her', is_user: false, mes: '(narrator)', is_system: true },
        ],
      },
    },
  ])
  // Upstream answers with the ids the floors landed at — here the tail after
  // the three floors the snapshot already had.
  assert.deepEqual(ids, [3, 4, 5])
})

test('createChatMessages carries insert_at and reports the landed ids', async () => {
  const calls = surface({
    // The host answers with the whole view, so the ids come from where the
    // floors actually landed rather than from what the caller guessed.
    answers: {
      createChatMessages: { view: { messages: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }] } },
    },
  })
  const create = calls.api['createChatMessages'] as (
    messages: readonly Record<string, unknown>[],
    options?: Record<string, unknown>,
  ) => Promise<number[]>
  const ids = await create(
    [{ role: 'user', message: 'inserted' }, { role: 'user', message: 'inserted too' }],
    { insert_at: 1 },
  )
  assert.equal(calls.calls[0]?.params['insertAt'], 1)
  assert.deepEqual(ids, [1, 2])
})

test('createChatMessages refuses a row it could not write, by name', async () => {
  const scope = surface()
  const create = scope.api['createChatMessages'] as (
    messages: readonly Record<string, unknown>[],
  ) => Promise<number[]>
  await assert.rejects(() => create([{ role: 'user' }]), /message/)
  await assert.rejects(() => create([{ role: 'narrator', message: 'x' }]), /role/)
})

test('deleteChatMessages sends the ids whole and answers with them', async () => {
  const scope = surface()
  const remove = scope.api['deleteChatMessages'] as (ids: number | number[]) => Promise<number[]>
  assert.deepEqual(await remove([2, 0]), [2, 0])
  assert.deepEqual(await remove(1), [1])
  assert.deepEqual(scope.calls, [
    { method: 'deleteChatMessages', params: { messageIds: [2, 0] } },
    { method: 'deleteChatMessages', params: { messageIds: [1] } },
  ])
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
    reportFault: () => undefined,
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

test('the script-button members are all answered, and none of them reports a gap', () => {
  const { api, gaps, calls } = surface({
    context: { ...context(), characterId: 'char', scriptButtons: { s1: [] } },
    scriptId: 's1',
  })

  const read = api['getScriptButtons'] as () => { name: string, visible: boolean }[]
  assert.deepEqual(read(), [], 'MVU feeds this straight into _.intersectionBy')

  const replace = api['replaceScriptButtons'] as (id: string, buttons: unknown) => void
  replace('s1', [{ name: 'a', visible: true }])

  assert.deepEqual(calls.map(call => call.method), ['replaceScriptButtons'])
  assert.deepEqual(calls[0]?.params, {
    characterId: 'char',
    scriptId: 's1',
    buttons: [{ name: 'a', visible: true }],
  })

  /*
   * **No gap, and that is the assertion.** These four were stubs that answered
   * and reported once — the right shape while there was no host arm — and the
   * report is now the thing that would be wrong. A gap beside a member that
   * works tells a reader to distrust something that is fine, and every later
   * reading of that panel is worth less for it.
   */
  assert.deepEqual(gaps, [], `nothing should be reported: ${gaps.join(' | ')}`)
})

test('replacing with the table that is already stored writes nothing', () => {
  /*
   * Upstream's own guard (`function/script.ts:80`, `!_.isEqual`), and it earns
   * its place here for a reason upstream does not have: a write crosses the
   * boundary and returns as a new snapshot, which re-plans the frame budget and
   * refreshes every running card. The one corpus caller republishes its table
   * on a button press, so an identical republish paying for all of that is a
   * real path, not a hypothetical.
   */
  const stored = [{ name: 'a', visible: true }, { name: 'b', visible: false }]
  const { api, calls } = surface({
    context: { ...context(), characterId: 'char', scriptButtons: { s1: stored } },
    scriptId: 's1',
  })
  const replace = api['replaceScriptButtons'] as (id: string, buttons: unknown) => void

  replace('s1', [{ name: 'a', visible: true }, { name: 'b', visible: false }])
  // Length, not `deepEqual(calls, [])`: @types/node declares deepEqual as
  // `asserts actual is T`, so comparing against `[]` narrows `calls` to
  // `never[]` and every later read of it is a type error.
  assert.equal(calls.length, 0, 'an equal table must not be written')

  // Order is part of the table: the bar renders in this order, so a reordering
  // is a change even though the set is the same.
  replace('s1', [{ name: 'b', visible: false }, { name: 'a', visible: true }])
  assert.equal(calls.length, 1, 'a reordered table is a different table')
})

test('a button writer accepts the one-argument shape MVU actually uses', () => {
  /*
   * **This test asserted the opposite, and the opposite was wrong.**
   *
   * It required `(script_id, buttons)` and pinned a refusal of the lone array,
   * citing upstream's 3.2.5 changelog example. Then a real card threw an
   * uncaught refusal during setup, and the caller was not the card — it was
   * MVU's fetched bundle:
   *
   *   appendInexistentScriptButtons(ja.map(e => ({ name: e.name, visible: !1 })))
   *   const n = getScriptButtons(); if (n) return void replaceScriptButtons(...)
   *
   * One argument, both writers, and **13 corpus cards bundle MVU** — so the
   * refusal broke every one of them, and it broke them at wiring-up time with a
   * throw that abandoned the rest of MVU's initialisation.
   *
   * The changelog example and MVU's usage are only both true if upstream takes
   * either shape. What settled it was the bytes that actually run, and those
   * were not in the card at all: this member's only measured caller is a fetched
   * bundle, so no amount of reading the card corpus could have found it.
   */
  const { api, calls } = surface({
    context: { ...context(), characterId: 'char', scriptButtons: { s1: [] } },
    scriptId: 's1',
  })

  const append = api['appendInexistentScriptButtons'] as (...args: unknown[]) => void
  append([{ name: '开始', visible: false }])

  assert.equal(calls.length, 1, 'the one-argument call must be honoured')
  assert.deepEqual(calls[0]?.params, {
    characterId: 'char',
    // Defaulted to the running script, which is what the omitted argument means.
    scriptId: 's1',
    buttons: [{ name: '开始', visible: false }],
  })

  // And the two-argument form still works, because upstream's own example uses it.
  const replace = api['replaceScriptButtons'] as (...args: unknown[]) => void
  replace('s1', [{ name: '结束', visible: true }])
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]?.params['buttons'], [{ name: '结束', visible: true }])
})

test('a malformed button table is reported, not thrown', () => {
  /*
   * `visible: false` is the **common** case — 58 of the corpus's 89 buttons — so
   * a missing field is at least as likely to have meant hidden as shown, and
   * inventing either answer stores a table the card did not ask for. So it is
   * still refused.
   *
   * **But it is refused by reporting.** These writers return `void` upstream and
   * nothing awaits them; a throw does not read as "that call was malformed", it
   * reads as everything after the call never happening — which is precisely the
   * failure a real card produced.
   */
  const { api, calls, gaps } = surface({
    context: { ...context(), characterId: 'char', scriptButtons: { s1: [] } },
    scriptId: 's1',
  })
  const replace = api['replaceScriptButtons'] as (...args: unknown[]) => void

  assert.doesNotThrow(() => replace('s1', [{ name: '开始' }]))
  assert.doesNotThrow(() => replace('s1', [{ visible: true }]))
  assert.doesNotThrow(() => replace('s1', 'not an array'))

  assert.equal(calls.length, 0, 'nothing malformed reaches the host')
  assert.equal(gaps.length, 3, `each refusal is reported once: ${gaps.join(' | ')}`)
  assert.ok(gaps.some(gap => gap.includes('visible')), gaps.join(' | '))
  assert.ok(gaps.some(gap => gap.includes('no name')), gaps.join(' | '))
  assert.ok(gaps.some(gap => gap.includes('array')), gaps.join(' | '))
})

test('appendInexistent adds only the names that are not already there', () => {
  const { api, calls } = surface({
    context: {
      ...context(),
      characterId: 'char',
      scriptButtons: { s1: [{ name: 'a', visible: true }] },
    },
    scriptId: 's1',
  })
  const append = api['appendInexistentScriptButtons'] as (id: string, buttons: unknown) => void

  append('s1', [{ name: 'a', visible: false }, { name: 'b', visible: true }])

  /*
   * `a` is dropped **including its different `visible`**: this member appends
   * what is missing, it does not update what is present. Dedupe is by name
   * because the name is the identity — a button's event is
   * `${script_id}_${hash(name)}`, so two buttons with one name are one button as
   * far as every listener is concerned.
   */
  assert.deepEqual(calls[0]?.params['buttons'], [
    { name: 'a', visible: true },
    { name: 'b', visible: true },
  ])
})

test('appendInexistent with nothing new does not write', () => {
  const { api, calls } = surface({
    context: {
      ...context(),
      characterId: 'char',
      scriptButtons: { s1: [{ name: 'a', visible: true }] },
    },
    scriptId: 's1',
  })
  const append = api['appendInexistentScriptButtons'] as (id: string, buttons: unknown) => void

  append('s1', [{ name: 'a', visible: false }])
  assert.deepEqual(calls, [], 'a round trip to store what is stored is churn for nothing')
})

test('updateScriptButtonsWith takes a function, synchronously', () => {
  const { api, calls } = surface({
    context: {
      ...context(),
      characterId: 'char',
      scriptButtons: { s1: [{ name: 'a', visible: false }] },
    },
    scriptId: 's1',
  })
  const update = api['updateScriptButtonsWith'] as (
    id: string,
    updater: (current: { name: string, visible: boolean }[]) => unknown,
  ) => unknown

  const returned = update('s1', current => current.map(button => ({ ...button, visible: true })))

  // Upstream's returns void for a synchronous updater, so this does too.
  assert.equal(returned, undefined)
  assert.deepEqual(calls[0]?.params['buttons'], [{ name: 'a', visible: true }])
})

test('updateScriptButtonsWith awaits an async updater before writing', async () => {
  const { api, calls } = surface({
    context: {
      ...context(),
      characterId: 'char',
      scriptButtons: { s1: [{ name: 'a', visible: false }] },
    },
    scriptId: 's1',
  })
  const update = api['updateScriptButtonsWith'] as (
    id: string,
    updater: (current: { name: string, visible: boolean }[]) => unknown,
  ) => unknown

  const returned = update('s1', async current => {
    await Promise.resolve()
    return current.map(button => ({ ...button, visible: true }))
  })

  // Length again, for the `never[]` narrowing recorded above.
  assert.equal(calls.length, 0, 'the write must wait for the updater')
  assert.ok(returned instanceof Promise || typeof (returned as { then?: unknown })?.then === 'function')
  await returned
  assert.deepEqual(calls[0]?.params['buttons'], [{ name: 'a', visible: true }])
})

test('a button write with no character open is reported, not thrown', () => {
  /*
   * Reachable while a chat is closing, and upstream's writer returns **silently**
   * in exactly this window (`script.ts:76-78`, the four identical TODOs), which
   * `notes/apps/iris-web/SCRIPT-BUTTONS.md` records as the thinnest part of upstream's
   * observability. The silence is what is copied; the name is what is added.
   *
   * Not thrown, because upstream's member returns `void` and cards call it
   * without `await` — a throw here lands in whatever the card was doing when the
   * chat closed, which is nothing it can handle.
   */
  const { characterId: _absent, ...noCard } = { ...context(), characterId: 'char' }
  const { api, gaps, calls } = surface({
    // The key is **omitted**, not set to undefined: `exactOptionalPropertyTypes`
    // refuses the explicit undefined, and an absent key is what a snapshot with
    // no card open actually looks like.
    context: { ...noCard, scriptButtons: { s1: [] } },
    scriptId: 's1',
  })
  const replace = api['replaceScriptButtons'] as (id: string, buttons: unknown) => void

  assert.doesNotThrow(() => replace('s1', [{ name: 'a', visible: true }]))
  assert.deepEqual(calls, [], 'nothing can be stored without a card')
  assert.equal(gaps.length, 1, `expected one report: ${gaps.join(' | ')}`)
  assert.match(gaps[0] ?? '', /no character was open/)
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

test('a floor-addressed read is answered from that floor\u2019s own table', () => {
  /*
   * **This test replaced a refusal, and the replaced reasoning is worth keeping
   * beside the new behaviour.** It used to assert that
   * `getVariables({message_id: 5})` threw, naming "the message-frame project" as
   * where the answer would come from. The premise was that the frame's snapshot
   * could not tell floors apart — true of `context.variables`, and false of the
   * snapshot as a whole: `toFile()` attaches `chat[i].variables[swipe_id]` to
   * every row, 677 of 677 on the corpus's longest chat. The refusal named a
   * transport limit for what was a lookup limit in `tavern-helper.ts`, and sent
   * a card author to wait for a frame kind that would never have helped.
   *
   * What survives is why a *wrong* floor is worse than none: MagVarUpdate reads
   * a floor, merges it into `stat_data` and writes it back, so a wrong answer is
   * not a wrong value but a persisted merge built on one. Every branch below
   * chooses `undefined` over a neighbouring floor's table for that reason.
   */
  const { api } = surface({
    context: {
      ...context(),
      chat: [
        { name: 'u', is_user: true, mes: 'hi', variables: JSON.stringify([{ stat: 'from floor 0' }]) },
        {
          name: 'a',
          is_user: false,
          mes: 'yo',
          swipe_id: 1,
          variables: JSON.stringify([{ stat: 'swipe 0' }, { stat: 'swipe 1' }]),
        },
      ],
    },
  })
  const read = api['getVariables'] as (option?: unknown) => unknown

  assert.deepEqual(read({ type: 'message', message_id: 0 }), { stat: 'from floor 0' })

  // The row's own `swipe_id` picks the table, so a re-rolled reply reads the
  // variables of the swipe on screen rather than of the first one generated.
  assert.deepEqual(read({ type: 'message', message_id: 1 }), { stat: 'swipe 1' })
})

test('the table a card is handed is a copy, because the caller merges and writes it', () => {
  /*
   * **The guarantee is `detachReturns`', not this member's.** `floorVariables`
   * once spread the table on the way out too; a mutation test showed that
   * removing the spread changed nothing observable, because the detach layer
   * structured-clones every call result on this surface. So the redundant copy
   * came out, and this test is aimed at the layer that actually holds the
   * property — break `detach` and this goes red, which is where a reader should
   * be sent when it does.
   *
   * Kept as a test of *this* member regardless, because the property is what a
   * card depends on and the layer providing it is an implementation detail that
   * may move again.
   */
  const { api } = surface({
    context: {
      ...context(),
      chat: [{ name: 'u', is_user: true, mes: 'hi', variables: JSON.stringify([{ stat: { hp: 1 } }]) }],
    },
  })
  const read = api['getVariables'] as (option?: unknown) => Record<string, unknown>

  const first = read({ type: 'message', message_id: 0 })
  first['added'] = true
  assert.deepEqual(
    read({ type: 'message', message_id: 0 }),
    { stat: { hp: 1 } },
    'a merge landed in the snapshot before the host agreed to it',
  )
})

test('the message_id domain is upstream\u2019s, including the shapes that throw', () => {
  /*
   * **This test was rewritten once, and the reason is the interesting part.**
   * Its first version pinned "whole non-negative numbers are answered, every
   * other shape returns undefined and is reported as unmeasured" — which was
   * the right behaviour while the value domain was genuinely unread, and became
   * the wrong behaviour the moment 3c measured it. Reporting "not measured yet"
   * is a claim about our knowledge, so it expires; the assertion had to expire
   * with it rather than stand as a specification.
   */
  const { api } = surface({
    context: {
      ...context(),
      chat: [
        { name: 'u', is_user: true, mes: 'hi', variables: JSON.stringify([{ stat: 'zero' }]) },
        { name: 'a', is_user: false, mes: 'yo', variables: JSON.stringify([{ stat: 'one' }]) },
      ],
    },
  })
  const read = api['getVariables'] as (option?: unknown) => unknown

  // A negative counts from the end, `Array.at` semantics — the convention
  // `resolveRange` already implements for message ranges.
  assert.deepEqual(read({ type: 'message', message_id: -1 }), { stat: 'one' })
  assert.deepEqual(read({ type: 'message', message_id: -2 }), { stat: 'zero' })

  // A numeric string converts, because upstream does.
  assert.deepEqual(read({ type: 'message', message_id: '1' }), { stat: 'one' })

  // Out of range, either direction, in upstream's own words.
  assert.throws(() => read({ type: 'message', message_id: 9 }), /\u8d85\u51fa\u4e86\u8303\u56f4/)
  assert.throws(() => read({ type: 'message', message_id: -9 }), /2-message chat/)

  // `'last'` is not a sentinel upstream has; it converts to NaN and is refused
  // with the value the card actually passed, so its author can see the typo.
  assert.throws(() => read({ type: 'message', message_id: 'last' }), /"last"/)
  assert.throws(() => read({ type: 'message', message_id: 1.5 }), /1\.5/)
})

test('a null message_id is refused rather than resolved to floor 0', () => {
  /*
   * **The one deliberate divergence here.** Upstream resolves `null` to floor 0
   * silently. Floor 0 is a wrong *write* target for a caller that reads a floor,
   * merges into it and writes it back — which is MagVarUpdate's whole flow — so
   * copying this particular behaviour would help nobody and corrupt a save. It
   * is the same judgement the rest of this file makes about wrong-versus-absent,
   * applied to a case where upstream chose wrong.
   */
  const { api } = surface({
    context: {
      ...context(),
      chat: [{ name: 'u', is_user: true, mes: 'hi', variables: JSON.stringify([{ stat: 'zero' }]) }],
    },
  })
  const read = api['getVariables'] as (option?: unknown) => unknown

  assert.throws(() => read({ type: 'message', message_id: null }), /names no floor/)
  assert.throws(() => read({ type: 'message', message_id: null }), /wrong target/)
})

test('a floor with no table of its own is an empty object, as upstream answers', () => {
  /*
   * `{}` and not `undefined`, and it is not a comfortable answer: an empty
   * object is **truthy**, so it passes a card's `if (data)` guard and then reads
   * as "nothing set yet" — which is what makes MagVarUpdate re-initialise over
   * live state. But upstream answers `{}`, so a card that breaks on it breaks on
   * real SillyTavern too, and diverging would hide the card's bug instead of
   * fixing it. What Iris adds here is a report, not a different value.
   */
  const { api } = surface({
    context: {
      ...context(),
      chat: [
        { name: 'a', is_user: false, mes: 'no table at all' },
        { name: 'a', is_user: false, mes: 'no table for this swipe', swipe_id: 2, variables: JSON.stringify([{ a: 1 }]) },
      ],
    },
  })
  const read = api['getVariables'] as (option?: unknown) => unknown

  assert.deepEqual(read({ type: 'message', message_id: 0 }), {})
  assert.deepEqual(read({ type: 'message', message_id: 1 }), {})
})

test('the two readings of \u2018latest\u2019 are compared, not chosen between', () => {
  /*
   * `'latest'` has always been answered from `context.variables`, the host's
   * computed current state. 3c reads upstream as answering with the **last
   * non-system message's** table instead. The two agree except while a reply is
   * in flight — and every card that reads variables without an id takes this
   * path, so rewiring it on a reading rather than on an observed disagreement is
   * a large blast radius for a small claim.
   *
   * So the disagreement is reported and the answer is unchanged. This asserts
   * both halves: the value a card gets, and that the frame says when the other
   * candidate differs.
   */
  const { api, gaps } = surface({
    context: {
      ...context(),
      variables: { stat: 'current' },
      chat: [
        { name: 'a', is_user: false, mes: 'reply', variables: JSON.stringify([{ stat: 'from the row' }]) },
        // A system row, which floor addressing does not count, so the row above
        // is the last addressable one.
        { name: 'sys', is_user: false, is_system: true, mes: 'joined' },
      ],
    },
  })
  const read = api['getVariables'] as (option?: unknown) => unknown

  assert.deepEqual(read({ type: 'message', message_id: 'latest' }), { stat: 'current' })
  assert.equal(gaps.length, 1, gaps.join(' | '))
  assert.match(gaps[0] ?? '', /disagree/)
  assert.match(gaps[0] ?? '', /answered with the current one/)
})

test('agreeing tables produce no report, and a system row cannot make them disagree', () => {
  /*
   * Two properties in one fixture, because one of them needed the other to be
   * checkable.
   *
   * The first: without a case where the note stays quiet it would fire on every
   * read and stop being a signal — the failure mode of an instrument that cannot
   * be silent.
   *
   * The second: **the system row carries a different table on purpose.** An
   * earlier fixture had the trailing system row carry none, so removing the
   * `is_system` filter changed nothing a test could see — the comparison
   * disagreed either way and the note fired either way. A mutation that counts
   * system rows now flips this test from quiet to noisy, which is the only
   * arrangement in which the filter is actually pinned.
   */
  const { api, gaps } = surface({
    context: {
      ...context(),
      variables: { stat: 'same' },
      chat: [
        { name: 'a', is_user: false, mes: 'reply', variables: JSON.stringify([{ stat: 'same' }]) },
        {
          name: 'sys',
          is_user: false,
          is_system: true,
          mes: 'joined',
          variables: JSON.stringify([{ stat: 'a system row\u2019s own table' }]),
        },
      ],
    },
  })
  const read = api['getVariables'] as (option?: unknown) => unknown

  assert.deepEqual(read(), { stat: 'same' })
  assert.deepEqual(gaps, [], 'a system row was counted as the last addressable floor')
})

test('an unaddressed read still works, because that is what a script frame can answer', () => {
  const { api } = surface()
  const read = api['getVariables'] as (option?: unknown) => unknown

  // `latest` and an absent id both mean "whatever this frame was given", which
  // is exactly what the snapshot holds. Refusing these would break every card.
  assert.doesNotThrow(() => read())
  assert.doesNotThrow(() => read({ type: 'message' }))
  assert.doesNotThrow(() => read({ type: 'message', message_id: 'latest' }))

  /*
   * And `'latest'` still answers from `context.variables` rather than from the
   * last row of `chat`. The two are different objects whenever a reply is
   * mid-flight, and the first is the one upstream answers — so routing
   * `'latest'` through the floor lookup would have been a tidier
   * implementation of a different member.
   */
  assert.deepEqual(read({ type: 'message', message_id: 'latest' }), read())
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

test('generateRaw composes the caller’s order, and says what it had to leave out', async () => {
  /*
   * This member was documented in the surface's own mapping table and never
   * implemented — a bare `generateRaw(...)` in a card script was a
   * `ReferenceError` inside the script's own catch, and the card reported the
   * questionnaire as failed, which its player reads as "the plugin is not
   * installed". Measured shape is 神隐挑战's: the object form with
   * `ordered_prompts` mixing environment names and literal system messages.
   */
  const { api, calls, gaps } = surface({
    answers: { generateRaw: { text: 'raw reply' } },
  })
  const generateRaw = api['generateRaw'] as (config: unknown) => Promise<unknown>

  const answer = await generateRaw({
    user_input: '开帖',
    should_silence: true,
    overrides: { persona_description: '扮演测试者' },
    ordered_prompts: [
      'world_info_before',
      { role: 'system', content: '你是论坛引擎' },
      'persona_description',
      'world_info_after',
      { role: 'user', content: '前置语境' },
      'user_input',
    ],
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, 'generateRaw', 'the raw member rides the raw host method')
  assert.equal(answer, 'raw reply')
  // System messages ride the system field; everything else lands in the prompt
  // in the order the caller wrote, with `user_input` placed at its marker.
  assert.equal(calls[0]?.params['systemPrompt'], '你是论坛引擎')
  assert.equal(calls[0]?.params['prompt'], '扮演测试者\n\n前置语境\n\n开帖')

  // The environment names this frame cannot resolve are skipped and named —
  // silently dropping one would read as "the model ignored that part".
  assert.equal(gaps.length, 1)
  assert.match(gaps[0] ?? '', /world_info_before, world_info_after/)
})

test('generateRaw uses an override before the snapshot, and the bare string form', async () => {
  const { api, calls, gaps } = surface({ answers: { generateRaw: { text: 'x' } } })
  const generateRaw = api['generateRaw'] as (config: unknown) => Promise<unknown>

  // `persona_description` resolves from overrides — 神隐挑战 overrides it on
  // every site; the snapshot carries no persona text of its own.
  await generateRaw({
    user_input: 'hi',
    overrides: { persona_description: '扮演你' },
    ordered_prompts: ['persona_description', 'user_input'],
  })
  assert.equal(calls[0]?.params['prompt'], '扮演你\n\nhi')
  assert.deepEqual(gaps, [], 'an overridden name is not a gap')

  // No order given: upstream sends the user input alone.
  await generateRaw({ user_input: 'just this' })
  assert.equal(calls[1]?.params['prompt'], 'just this')
  assert.equal('systemPrompt' in (calls[1]?.params ?? {}), false)
})

test('generateRaw refuses an empty composition by name, not with a host contract error', async () => {
  const { api } = surface({ answers: { generateRaw: { text: 'x' } } })
  const generateRaw = api['generateRaw'] as (config: unknown) => Promise<unknown>

  // A caller ordering only names this frame skips would send nothing.
  await assert.rejects(
    () => generateRaw({ user_input: 'hi', ordered_prompts: ['world_info_before'] }),
    /composed prompt is empty/,
  )
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
      { name: 'You', is_user: true, mes: 'ask', variables: JSON.stringify([{ turn: 'user-row' }]) },
      {
        name: 'Her',
        is_user: false,
        mes: 'middle',
        swipes: ['middle', 'middle-alt', 'middle-third'],
        swipe_id: 1,
        // Only two tables for three swipes: the usual case, since a swipe that
        // never ran a variable update has none.
        variables: JSON.stringify([{ floor: 'middle-0' }, { floor: 'middle-1' }]),
      },
      { name: 'Her', is_user: false, mes: 'last', variables: JSON.stringify([{ floor: 'last-0' }]) },
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
test('injectPrompts composes upstream\u2019s wrapper over the host\u2019s primitive', () => {
  const { api, calls } = surface()
  const inject = api['injectPrompts'] as (
    prompts: unknown,
    options?: unknown,
  ) => { uninject: () => void }

  const handle = inject([
    { id: 'a', position: 'in_chat', depth: 0, role: 'user', content: 'hello', should_scan: false },
  ])

  /*
   * **Synchronous.** The measured card stores the handle in a module variable
   * and calls `S.uninject()` from several places later, so a promise here would
   * mean `S.uninject` is not a function at every one of them.
   */
  assert.equal(typeof handle.uninject, 'function')

  const wire = calls.filter(call => call.method === 'setExtensionPrompt')
  assert.equal(wire.length, 1)
  assert.equal(wire[0]?.params['key'], 'a')
  assert.equal(wire[0]?.params['value'], 'hello')
  assert.equal(wire[0]?.params['position'], 'at-depth')
  assert.equal(wire[0]?.params['role'], 'user')
  assert.equal(wire[0]?.params['should_scan'], false)
})

test('an id-less injection is still revocable, which upstream\u2019s is not', () => {
  /*
   * Upstream computes `prompt.id ?? uuidv4()` for the key and never writes it
   * back, so its own `uninject` reads `p.id`, finds `undefined`, and removes
   * nothing: an id-less injection upstream cannot be revoked. Writing the
   * generated id onto the prompt makes the handle work, and a card cannot
   * observe the difference except that `uninject()` does what it says.
   */
  const { api, calls } = surface()
  const inject = api['injectPrompts'] as (p: unknown) => { uninject: () => void }

  const prompt: Record<string, unknown> = { content: 'no id here' }
  const handle = inject([prompt])
  assert.equal(typeof prompt['id'], 'string', 'the id was not written back')

  handle.uninject()
  const removals = calls.filter(
    call => call.method === 'setExtensionPrompt' && call.params['value'] === '',
  )
  assert.equal(removals.length, 1)
  assert.equal(removals[0]?.params['key'], prompt['id'])
})

test('the defaults are upstream\u2019s, including the ones a contract would choose differently', () => {
  const { api, calls } = surface()
  const inject = api['injectPrompts'] as (p: unknown) => { uninject: () => void }

  inject([{ id: 'bare' }])
  const sent = calls.find(call => call.method === 'setExtensionPrompt')?.params ?? {}
  assert.equal(sent['value'], '')
  assert.equal(sent['depth'], 0)
  assert.equal(sent['should_scan'], false)
  /*
   * `'system'` **sent explicitly**, not omitted. Leaving it out would let the
   * contract's own default decide, and the contract's default is the host's
   * choice rather than upstream's — the two need not agree, and a role is which
   * voice the text speaks in.
   */
  assert.equal(sent['role'], 'system')
})

test('only the literal \u2018none\u2019 is a silent injection; a typo injects at depth', () => {
  /*
   * Upstream's check is `position === 'none' ? NONE : IN_CHAT`, so a misspelled
   * position lands the text at depth rather than being refused — and a card
   * written against the typo works. Matching that is compatibility; refusing the
   * typo would break a working card in the name of tidiness.
   */
  const { api, calls } = surface()
  const inject = api['injectPrompts'] as (p: unknown) => { uninject: () => void }

  inject([
    { id: 'silent', position: 'none', content: 'x' },
    { id: 'typo', position: 'in-chat', content: 'y' },
    { id: 'absent', content: 'z' },
  ])
  const positions = calls
    .filter(call => call.method === 'setExtensionPrompt')
    .map(call => call.params['position'])
  assert.deepEqual(positions, ['none', 'at-depth', 'at-depth'])
})

test('uninject is idempotent, because the measured card calls it more than once', () => {
  const { api, calls } = surface()
  const inject = api['injectPrompts'] as (p: unknown) => { uninject: () => void }

  const handle = inject([{ id: 'a', content: 'x' }, { id: 'b', content: 'y' }])
  handle.uninject()
  handle.uninject()

  const removals = calls.filter(
    call => call.method === 'setExtensionPrompt' && call.params['value'] === '',
  )
  assert.deepEqual(removals.map(call => call.params['key']), ['a', 'b'])
})

test('a repeated id is one injection, because upstream overwrites the whole row', () => {
  const { api, calls } = surface()
  const inject = api['injectPrompts'] as (p: unknown) => { uninject: () => void }

  const handle = inject([{ id: 'same', content: 'first' }, { id: 'same', content: 'second' }])
  handle.uninject()

  const removals = calls.filter(
    call => call.method === 'setExtensionPrompt' && call.params['value'] === '',
  )
  assert.deepEqual(removals.map(call => call.params['key']), ['same'], 'one key, one removal')
})

test('the names a settled generation goes out under are upstream’s, split by reason', () => {
  /*
   * An abort emits `generation_stopped` **only** — upstream's abort path does
   * not also fire `GENERATION_ENDED`, and a card that revoked on the first and
   * re-armed on the second would be left in the wrong state if both arrived.
   *
   * This function exists because for one round the answer was "none of them":
   * `stream.end` carried no reason, so these three names were emitted by nothing
   * and every subscription to them was silent. The `reason` field is what made
   * synthesising them honest rather than a guess wearing upstream's name.
   */
  assert.deepEqual(settledEvents('aborted'), ['generation_stopped'])
  assert.deepEqual(settledEvents('completed'), ['js_generation_ended', 'generation_ended'])
})

test('once revokes on the event the host actually broadcasts', async () => {
  /*
   * **The silence this closes.** A first version subscribed to upstream's three
   * names — `js_generation_ended`, `generation_ended`, `generation_stopped` —
   * and *nothing in this app emits any of them*. All three subscriptions would
   * have waited forever and a `once` injection would never have been revoked:
   * no error, no report, the text simply keeps appearing in every later prompt.
   * Three plausible names are not more robust than one real one; they are the
   * same silence, harder to notice.
   */
  const events = new EventBus()
  const { api, calls } = surface({ events })
  const inject = api['injectPrompts'] as (p: unknown, o?: unknown) => { uninject: () => void }

  inject([{ id: 'temporary', content: 'x' }], { once: true })
  assert.equal(
    calls.filter(call => call.method === 'setExtensionPrompt' && call.params['value'] === '').length,
    0,
    'revoked before any generation settled',
  )

  await events.eventEmit('generation_ended')
  const removals = calls.filter(
    call => call.method === 'setExtensionPrompt' && call.params['value'] === '',
  )
  assert.deepEqual(removals.map(call => call.params['key']), ['temporary'])
})

test('an injection without once survives a settled generation', () => {
  /*
   * The other half, and the one the measured card depends on: it passes a single
   * argument, so `once` is false and the injection outlives the generation that
   * follows it and every generation after. An implementation that cleared
   * anyway would be wrong in the direction nobody checks — the text just stops
   * appearing.
   */
  const events = new EventBus()
  const { api, calls } = surface({ events })
  const inject = api['injectPrompts'] as (p: unknown, o?: unknown) => { uninject: () => void }

  inject([{ id: 'durable', content: 'x' }])
  void events.eventEmit('generation_ended')

  assert.deepEqual(
    calls.filter(call => call.method === 'setExtensionPrompt' && call.params['value'] === ''),
    [],
    'a durable injection was revoked by a generation ending',
  )
})

test('a filter is reported, because a filter that never runs changes the prompt', () => {
  /*
   * `filter` is a function; upstream evaluates it at assembly time on its own
   * page, and a function cannot cross this frame's boundary. Dropping it
   * silently turns "inject this when X" into "inject this always" — a wrong
   * prompt rather than a missing feature, and wrong prompts are the class of
   * failure that surfaces as a bad reply instead of an error.
   */
  const { api, gaps } = surface()
  const inject = api['injectPrompts'] as (p: unknown) => { uninject: () => void }

  inject([{ id: 'conditional', content: 'x', filter: () => true }])
  assert.equal(gaps.filter(line => line.includes('filter')).length, 1, gaps.join(' | '))
  assert.match(gaps.join(' '), /unconditional here/)
})

test('the handle survives the detach layer, which would otherwise strip its method', () => {
  /*
   * `{ uninject }` is a live revocation, and `structuredClone` of one is an
   * object whose method is gone. The card stores the handle and calls it from
   * several places later, so a clone fails at the call rather than at the copy
   * — far from the cause. `HANDLE_RETURNS` exempts it, and this is the
   * assertion that says so.
   */
  const { api, gaps } = surface()
  const inject = api['injectPrompts'] as (p: unknown) => unknown
  const handle = inject([{ id: 'a', content: 'x' }]) as { uninject?: unknown }
  assert.equal(typeof handle.uninject, 'function', 'the handle was cloned into a plain object')

  /*
   * **And no report, which is the half with teeth.** A mutation removing this
   * member from `HANDLE_RETURNS` left the assertion above green: the clone of a
   * handle *throws* `DataCloneError`, and `detach`'s own fallback hands back the
   * original — so the value survives either way. What does not survive is the
   * truth of the report, which says "returned a value Iris could not copy, so
   * the card holds a live reference" and is a **false alarm** for a member whose
   * contract is a live reference. That is the whole reason the exemption list
   * exists, so it is what this asserts.
   */
  assert.deepEqual(
    gaps.filter(line => line.includes('could not copy')),
    [],
    'the handle was reported as a failed copy, which is the alarm the exemption exists to silence',
  )
})

test('uninjectPrompts removes by id, without a handle', () => {
  const { api, calls, gaps } = surface()
  const uninject = api['uninjectPrompts'] as (ids: unknown) => void

  uninject(['a', 'b'])
  const removals = calls.filter(
    call => call.method === 'setExtensionPrompt' && call.params['value'] === '',
  )
  assert.deepEqual(removals.map(call => call.params['key']), ['a', 'b'])

  uninject(['', 7])
  assert.equal(gaps.length, 2, gaps.join(' | '))
})
