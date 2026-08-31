import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createTavernHelper, type ChatMessageSwiped } from '@iris/compat-tavernhelper'
import { applyCommands, extractCommands, loadInitVars, type MvuData } from '@iris/mvu'
import type { Contribution } from '@iris/pipeline'
import { historyFromSession, TurnDriver } from '@iris/turn'
import { memoryBackend, sessionMessageBackend, VariableStore } from '@iris/variables'

/**
 * A stateful roleplay turn, end to end.
 *
 * This is the scenario the whole design is arranged around: a world book
 * declares the variable tree, the model emits update commands inside its reply,
 * and the resulting state belongs to *that generation*. Regenerating must not
 * inherit the previous reply's consequences, and swiping back must restore
 * them — which is only possible because a candidate, its text and its variables
 * are the same object in the log.
 */

/** The `[InitVar]` entry a card ships. */
const WORLD_BOOK = {
  name: '主世界书',
  entries: [{
    comment: '[InitVar]初始变量',
    content: [
      '日期: ["03月15日", "今天的日期"]',
      '络络:',
      '  好感度: [10, "[-100,100] 之间，互动时更新"]',
      '  着装: [["法杖", "粉色缎带", "靴子"], "当前穿戴"]',
    ].join('\n'),
  }],
}

/** A stream that replies with scripted text, one script per call. */
function scriptedStream(replies: readonly string[]) {
  let call = 0
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = replies[Math.min(call, replies.length - 1)] as string
    call += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const FIRST_REPLY = [
  '络络对你笑了笑。',
  '<UpdateVariable>',
  `_.add('络络.好感度[0]', 5);//愉快的交谈`,
  `_.set('日期[0]', '03月15日', '03月16日');//一天过去了`,
  '</UpdateVariable>',
].join('\n')

const SECOND_REPLY = [
  '络络皱了皱眉。',
  '<UpdateVariable>',
  `_.add('络络.好感度[0]', -3);//话不投机`,
  `_.remove('络络.着装[0]', '粉色缎带');//她摘下了缎带`,
  '</UpdateVariable>',
].join('\n')

const CONTRIBUTIONS: Contribution[] = [
  { id: 'persona', placement: { kind: 'system', order: 0 }, text: '你是络络。' },
]

/** Everything one chat needs, wired together. */
function harness() {
  const session = Session.create(SessionId(`mvu-${Math.random().toString(36).slice(2)}`))
  const variables = new VariableStore({
    message: sessionMessageBackend(session),
    chat: memoryBackend(),
    global: memoryBackend(),
  })
  const driver = new TurnDriver({
    stream: scriptedStream([FIRST_REPLY, SECOND_REPLY]),
    provider: 'test',
    model: 'test-model',
    contributions: () => CONTRIBUTIONS,
    history: current => historyFromSession(current),
    budget: { context: 10_000, reserve: 0, count: text => text.length },
  })
  return { session, variables, driver }
}

/** Fold a reply's commands into the state and attach the result to the turn. */
function recordVariables(
  variables: VariableStore,
  base: MvuData,
  replyText: string,
): MvuData {
  const result = applyCommands(extractCommands(replyText), base)
  variables.replaceVariables(result.data as unknown as Record<string, unknown>, { type: 'message' })
  return result.data
}

/** Read the MVU state currently attached to the selected candidate. */
function currentState(variables: VariableStore): MvuData {
  return variables.getVariables({ type: 'message' }) as unknown as MvuData
}

/** 络络's sub-tree. */
function luoluo(data: MvuData): Record<string, unknown> {
  return data.stat_data.络络 as Record<string, unknown>
}

test('a world book declares the tree the model is allowed to change', () => {
  const { data } = loadInitVars([WORLD_BOOK], { initialized_lorebooks: {}, stat_data: {} })

  assert.deepEqual(luoluo(data).好感度, [10, '[-100,100] 之间，互动时更新'])
  // A key nobody declared cannot be invented by the model.
  const rejected = applyCommands(extractCommands(`_.set('络络.身高', 160);//幻觉`), data)
  assert.equal(rejected.changed, false)
})

test('a generated reply updates state that belongs to that generation', async () => {
  const { session, variables, driver } = harness()
  const initial = loadInitVars([WORLD_BOOK], { initialized_lorebooks: {}, stat_data: {} }).data

  const candidate = await driver.send(session, '你好。')
  const text = candidate.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  recordVariables(variables, initial, text)

  const state = currentState(variables)
  assert.deepEqual(luoluo(state).好感度, [15, '[-100,100] 之间，互动时更新'])
  assert.deepEqual(state.stat_data.日期, ['03月16日', '今天的日期'])
})

test('regenerating starts from the turn baseline, not the discarded reply', async () => {
  const { session, variables, driver } = harness()
  const initial = loadInitVars([WORLD_BOOK], { initialized_lorebooks: {}, stat_data: {} }).data

  const first = await driver.send(session, '你好。')
  recordVariables(variables, initial, textOf(first))

  // The user regenerates. The second reply must be folded into the state as it
  // was BEFORE the first reply — otherwise the discarded generation's effects
  // leak into its replacement.
  const second = await driver.regenerate(session)
  recordVariables(variables, initial, textOf(second))

  const state = currentState(variables)
  assert.deepEqual(luoluo(state).好感度, [7, '[-100,100] 之间，互动时更新'], '10 - 3, not 15 - 3')
  assert.deepEqual(luoluo(state).着装, [['法杖', '靴子'], '当前穿戴'])
})

test('swiping back restores that candidate’s own state', async () => {
  const { session, variables, driver } = harness()
  const initial = loadInitVars([WORLD_BOOK], { initialized_lorebooks: {}, stat_data: {} }).data

  recordVariables(variables, initial, textOf(await driver.send(session, '你好。')))
  recordVariables(variables, initial, textOf(await driver.regenerate(session)))

  driver.swipe(session, 0, 0)

  const state = currentState(variables)
  assert.deepEqual(luoluo(state).好感度, [15, '[-100,100] 之间，互动时更新'])
  assert.deepEqual(luoluo(state).着装, [['法杖', '粉色缎带', '靴子'], '当前穿戴'], 'the ribbon is back on')
})

test('a card script reads the state through the Tavern Helper surface', async () => {
  const { session, variables, driver } = harness()
  const initial = loadInitVars([WORLD_BOOK], { initialized_lorebooks: {}, stat_data: {} }).data
  recordVariables(variables, initial, textOf(await driver.send(session, '你好。')))

  const helper = createTavernHelper({ session, variables, names: { user: '旅人', character: '络络' } })
  const messages = (helper.api.getChatMessages as (range: number) => ChatMessageSwiped[])(-1)
  const statData = (messages[0]?.data.stat_data ?? {}) as Record<string, unknown>

  // Exactly the access path a community status-bar card uses.
  assert.deepEqual((statData.络络 as Record<string, unknown>).好感度, [15, '[-100,100] 之间，互动时更新'])
})

/** Text of a candidate. */
function textOf(candidate: { message: { content: readonly { type: string, text?: string }[] } }): string {
  return candidate.message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}
