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
import { createFrameTavernHelper, resolveRange } from '../src/sandbox/tavern-helper.ts'

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
    variables: { stat: { hp: 10 } },
  }
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
  let snapshot = overrides === undefined || !('context' in overrides) ? context() : overrides.context
  const api = createFrameTavernHelper({
    context: () => snapshot,
    scriptId: () => overrides?.scriptId,
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
  return { api, calls }
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

test('include_swipes returns one entry per swipe, the way cards index it', () => {
  const { api } = surface()
  const read = api['getChatMessages'] as (
    range: number,
    options?: { include_swipes?: boolean },
  ) => { mes: string }[]

  assert.deepEqual(read(2, { include_swipes: true }).map(message => message.mes), ['third', 'other'])
  assert.deepEqual(read(2).map(message => message.mes), ['third'], 'without the flag, the shown text only')
})

test('a scope the snapshot does not carry is refused by name, not answered empty', () => {
  /*
   * The dangerous alternative is returning `{}`. MVU reads that as "not
   * initialised yet" and writes its defaults over whatever was really there, so
   * an empty answer does not fail — it destroys state and then succeeds.
   */
  const { api } = surface()
  let caught: unknown
  try {
    ;(api['getVariables'] as (option: { type: string }) => unknown)({ type: 'chat' })
  } catch (error: unknown) {
    caught = error
  }

  assert.ok(caught instanceof UnsupportedApiError)
  assert.equal(caught.member, "getVariables({type:'chat'})")
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
