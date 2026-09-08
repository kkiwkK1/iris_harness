import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { appendCandidate, selectCandidate } from '@iris/chat'
import { memoryBackend, sessionMessageBackend, VariableStore } from '@iris/variables'

import {
  createTavernHelper,
  EventBus,
  flattenForCard,
  MVU_EVENTS,
  resolveRange,
  TAVERN_EVENTS,
  UnsupportedApiError,
  type ChatMessageSwiped,
} from '../src/index.ts'

const NAMES = { user: 'Traveller', character: 'Aria' }

/** A chat with one exchange and two candidate replies. */
function chat() {
  const session = Session.create(SessionId(`th-${Math.random().toString(36).slice(2)}`))
  session.append('turn/start', { turn: 0 })
  session.append('step/start', { turn: 0, step: 0 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'Hello?' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  const reply = (text: string) => createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test' },
  })
  appendCandidate(session, { turn: 0, step: 0, message: reply('Candidate A.') })
  appendCandidate(session, { turn: 0, step: 0, message: reply('Candidate B.') })

  const variables = new VariableStore({
    message: sessionMessageBackend(session),
    chat: memoryBackend(),
    global: memoryBackend(),
    script: memoryBackend(),
  })
  return { session, variables }
}

/** A helper over that chat. */
function helper(overrides: Partial<Parameters<typeof createTavernHelper>[0]> = {}) {
  const { session, variables } = chat()
  return {
    session,
    variables,
    helper: createTavernHelper({ session, variables, names: NAMES, ...overrides }),
  }
}

test('getChatMessages numbers user and assistant turns alike', () => {
  const { helper: th } = helper()
  const messages = (th.api.getChatMessages as (range: string) => ChatMessageSwiped[])('all')

  assert.deepEqual(messages.map(message => message.message_id), [0, 1])
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant'])
  assert.equal(messages[1]?.name, 'Aria')
})

test('the swipe triple rides on every shape, asked or not', () => {
  /*
   * This test asserted the opposite — `swipes` withheld unless the flag was
   * passed — and a real card paid for it: 人贩子物语's embedded phone calls
   * `getChatMessages('0', { include_swipe: true })`, a misspelling upstream's
   * own destructuring ignores too, and then reads `msg.swipes[swipeId]` from
   * the plain shape's `// for compatibility` fields
   * (`chat_message.ts:139-143`). Stripping the triple turned that read into
   * "开场白 N 不存在" on a floor that held all four greetings. The flag's real
   * job upstream is swapping `message`/`data`/`extra` for `swipes_info`, which
   * this surface has never carried.
   */
  const { helper: th } = helper()
  const get = th.api.getChatMessages as (range: string | number, options?: object) => ChatMessageSwiped[]

  assert.equal((get(1)[0]?.swipes?.length ?? 0), 2, 'the plain read still carries swipes')
  assert.equal(get(1)[0]?.swipe_id, 1, 'the showing candidate, not a gate on the fields')
  assert.equal(get(1, { include_swipes: true })[0]?.swipes?.length, 2)
})

test("a message's data carries its own variables, which is where MVU looks", () => {
  const { helper: th, variables } = helper()
  variables.replaceVariables({ stat_data: { 好感度: 20 } }, { type: 'message' })

  const message = (th.api.getChatMessages as (range: number) => ChatMessageSwiped[])(-1)[0]

  assert.deepEqual(message?.data, { stat_data: { 好感度: 20 } })
})

test('each swipe reports the state it produced', () => {
  const { helper: th, session, variables } = helper()
  variables.replaceVariables({ 好感度: 20 }, { type: 'message' })
  selectCandidate(session, 0, 0)
  variables.replaceVariables({ 好感度: 5 }, { type: 'message' })

  const message = (th.api.getChatMessages as (range: number, options: object) => ChatMessageSwiped[])(
    -1,
    { include_swipes: true },
  )[0]

  assert.deepEqual(message?.swipes_data, [{ 好感度: 5 }, { 好感度: 20 }])
  assert.equal(message?.swipe_id, 0)
})

test('a negative range counts from the end', () => {
  assert.deepEqual(resolveRange(-1, 3), [2])
  assert.deepEqual(resolveRange('0-2', 3), [0, 1, 2])
  assert.deepEqual(resolveRange('2-0', 3), [0, 1, 2], 'a reversed span still reads forwards')
  assert.deepEqual(resolveRange('all', 2), [0, 1])
  assert.deepEqual(resolveRange(0, 0), [], 'an empty chat names nothing')
})

test('a script-scoped call resolves to the calling script', () => {
  const { session, variables } = chat()
  const th = createTavernHelper({ session, variables, names: NAMES, scriptId: 'card-script' })
  const set = th.api.replaceVariables as (values: object, option: object) => void
  const get = th.bound.getVariables as (option: object) => object

  set({ n: 1 }, { type: 'script' })

  assert.deepEqual(get({ type: 'script' }), { n: 1 })
})

test('the event bus lets a listener repair the payload in flight', async () => {
  // The canonical use: undoing a model's mangling of a CJK name before the
  // commands are applied.
  const bus = new EventBus()
  const commands = [{ args: ['角色.络-络.好感度'] }]

  bus.eventOn(MVU_EVENTS.COMMAND_PARSED, ((list: { args: string[] }[]) => {
    for (const command of list) command.args[0] = (command.args[0] ?? '').replace(/-/g, '')
  }) as never)
  await bus.eventEmit(MVU_EVENTS.COMMAND_PARSED, commands)

  assert.equal(commands[0]?.args[0], '角色.络络.好感度')
})

test('listeners run in registration order and once means once', async () => {
  const bus = new EventBus()
  const seen: string[] = []
  bus.eventOn('e', (() => void seen.push('first')) as never)
  bus.eventOnce('e', (() => void seen.push('once')) as never)
  bus.eventMakeFirst('e', (() => void seen.push('ahead')) as never)

  await bus.eventEmit('e')
  await bus.eventEmit('e')

  assert.deepEqual(seen, ['ahead', 'first', 'once', 'ahead', 'first'])
})

test('a subscription handle removes exactly its own listener', async () => {
  const bus = new EventBus()
  let count = 0
  const subscription = bus.eventOn('e', (() => { count += 1 }) as never)

  await bus.eventEmit('e')
  subscription.stop()
  await bus.eventEmit('e')

  assert.equal(count, 1)
})

test('event name strings keep their upstream irregularities', () => {
  assert.equal(TAVERN_EVENTS.GENERATION_AFTER_COMMANDS, 'GENERATION_AFTER_COMMANDS')
  assert.equal(TAVERN_EVENTS.CHARACTER_DELETED, 'characterDeleted')
  assert.equal(MVU_EVENTS.VARIABLE_INITIALIZED, 'mag_variable_initialized')
})

test('an unavailable capability refuses by name instead of failing quietly', () => {
  const { helper: th } = helper()

  assert.throws(() => (th.api.generate as (config: object) => unknown)({}), UnsupportedApiError)
})

test('the misspelled macro helper is present under its upstream name', () => {
  const { helper: th } = helper({ substituteMacros: text => text.replace('{{char}}', 'Aria') })

  assert.equal((th.api.substitudeMacros as (text: string) => string)('Hi {{char}}'), 'Hi Aria')
})

test('flattening exposes both the bare globals and the namespaced object', () => {
  const { helper: th } = helper()
  const scope = flattenForCard(th)

  assert.equal(typeof scope.getVariables, 'function', 'cards call it bare')
  assert.equal(typeof (scope.TavernHelper as Record<string, unknown>).getChatMessages, 'function')
  assert.equal(typeof ((scope.TavernHelper as Record<string, unknown>)._bind as Record<string, unknown>).getVariables, 'function')
})
