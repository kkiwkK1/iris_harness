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
function surface(overrides?: { context?: ScriptContext | undefined, scriptId?: string }) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const snapshot = overrides === undefined || !('context' in overrides) ? context() : overrides.context
  const api = createFrameTavernHelper({
    context: () => snapshot,
    scriptId: () => overrides?.scriptId,
    call: async (method, params) => {
      calls.push({ method, params })
      return undefined
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

test('writes travel to the host and are awaited, none of them applied locally', async () => {
  const { api, calls } = surface()

  await (api['replaceVariables'] as (v: object, o: object) => Promise<void>)(
    { stat: { hp: 3 } },
    { type: 'message', message_id: 2 },
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, 'setVariables', 'the card-facing name; the shell maps and enforces it')
  assert.equal(calls[0]?.params['member'], 'replaceVariables')
  assert.deepEqual(
    (api['getVariables'] as () => unknown)(),
    { stat: { hp: 10 } },
    'the local snapshot must not be updated: the host has not agreed yet',
  )
})

test('updateVariablesWith runs the updater here and sends the result', async () => {
  // The updater is a function and cannot cross the boundary, so the frame is
  // the only place it can run.
  const { api, calls } = surface()

  await (api['updateVariablesWith'] as (
    updater: (v: Record<string, unknown>) => Record<string, unknown>,
    option?: object,
  ) => Promise<void>)(variables => {
    ;(variables['stat'] as { hp: number }).hp = 99
    return variables
  })

  assert.deepEqual(calls[0]?.params['variables'], { stat: { hp: 99 } })
  assert.deepEqual(
    (api['getVariables'] as () => unknown)(),
    { stat: { hp: 10 } },
    'the updater must work on a copy, or it mutates the snapshot in place',
  )
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
