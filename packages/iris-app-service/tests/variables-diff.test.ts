/**
 * `chat.variablesDiff` through the service: two conversations with a fork
 * between them, floor tables written the way a card writes them
 * (`script.setVariables`, message scope), and the diff read back.
 *
 * What the pure diff's own tests cannot show and these do: that each side is
 * read from **its own** conversation (the branch's copy of a shared floor, and
 * the branch's own later floors), that an unselected reading can be named,
 * and that a floor, a reading or a chat that is not there is told apart.
 */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { StreamFn } from '@iris/turn'

import type { Handlers } from '../src/service.ts'
import { createTestService } from './support/service.ts'

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '1', extensions: {},
  },
})

interface Fixture {
  handlers: Handlers
  say: (chatId: string, text: string) => Promise<void>
  floor: (chatId: string, messageId: number, variables: Record<string, unknown>) => Promise<void>
}

async function fixture(t: TestContext): Promise<Fixture> {
  let replies = 0
  let ends = 0
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    replies += 1
    const text = `Reply ${String(replies)}.`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const { handlers } = await createTestService(t, async ({ dir }) => {
    await mkdir(join(dir, 'characters'), { recursive: true })
    await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
    return { stream, broadcast: event => { if (event.type === 'stream.end') ends += 1 } }
  }, 'iris-variables-diff-')
  let waited = 0
  return {
    handlers,
    say: async (chatId, text) => {
      await handlers['chat.send']({ chatId, text })
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
    floor: async (chatId, messageId, variables) => {
      await handlers['script.setVariables']({ chatId, scope: 'message', messageId, op: 'replace', variables })
    },
  }
}

/**
 * root: greeting, q1, reply, q2, reply — each reply floor with its own table.
 * branch: cut at root's floor 2, then its own q and reply with a different table.
 */
async function lineage(fix: Fixture): Promise<{ root: string, branch: string }> {
  const root = (await fix.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await fix.say(root, 'q1')
  await fix.say(root, 'q2')
  await fix.floor(root, 0, { stat_data: { hp: [10, 'health'], place: 'gate' } })
  await fix.floor(root, 2, { stat_data: { hp: [12, 'health'], place: 'gate', items: ['key'] } })
  await fix.floor(root, 4, { stat_data: { hp: [15, 'health'], place: 'hall', items: ['key', 'lamp'] } })
  const branch = (await fix.handlers['chat.branch']({ chatId: root, id: 2 })).view.chatId
  await fix.say(branch, 'down the stairs')
  await fix.floor(branch, 4, { stat_data: { hp: [9, 'health'], place: 'cellar', items: ['key'] }, flags: { dark: true } })
  return { root, branch }
}

test('two floors of one conversation: the MVU pair by value, a list by position, a key that arrived', async (t) => {
  const fix = await fixture(t)
  const { root } = await lineage(fix)
  const { diff } = await fix.handlers['chat.variablesDiff']({ a: { chatId: root, floor: 0 }, b: { chatId: root, floor: 4 } })
  assert.deepEqual(diff.entries, [
    { path: ['stat_data', 'hp'], kind: 'changed', before: 10, after: 15, notes: ['mvu'] },
    { path: ['stat_data', 'place'], kind: 'changed', before: 'gate', after: 'hall' },
    { path: ['stat_data', 'items'], kind: 'added', after: ['key', 'lamp'] },
  ])
  assert.deepEqual(diff.summary, { added: 1, removed: 0, changed: 2 })
  assert.deepEqual(diff.a, { chatId: root, floor: 0, swipe: 0, swipes: 1, role: 'assistant', source: 'floor' })
  assert.equal(diff.b.missing, undefined)
  assert.equal(diff.tables, undefined, 'the tables travel only when asked for')

  const withTables = await fix.handlers['chat.variablesDiff']({ a: { chatId: root, floor: 0 }, b: { chatId: root, floor: 40 }, tables: true })
  assert.deepEqual(withTables.diff.tables, { a: { stat_data: { hp: [10, 'health'], place: 'gate' } } })
})

test('the same floor on the trunk and on the branch: each side is read from its own conversation', async (t) => {
  const fix = await fixture(t)
  const { root, branch } = await lineage(fix)
  const { diff } = await fix.handlers['chat.variablesDiff']({ a: { chatId: root, floor: 4 }, b: { chatId: branch, floor: 4 } })
  assert.deepEqual(diff.entries, [
    { path: ['stat_data', 'hp'], kind: 'changed', before: 15, after: 9, notes: ['mvu'] },
    { path: ['stat_data', 'place'], kind: 'changed', before: 'hall', after: 'cellar' },
    { path: ['stat_data', 'items', 1], kind: 'removed', before: 'lamp', notes: ['index'] },
    { path: ['flags'], kind: 'added', after: { dark: true } },
  ])
  assert.equal(diff.a.chatId, root)
  assert.equal(diff.b.chatId, branch)

  // The floor the branch copied reads the same on both sides: the fork carried
  // the table, and the branch's own later write did not reach back into it.
  const shared = await fix.handlers['chat.variablesDiff']({ a: { chatId: root, floor: 2 }, b: { chatId: branch, floor: 2 } })
  assert.equal(shared.diff.identical, true)
  assert.deepEqual(shared.diff.summary, { added: 0, removed: 0, changed: 0 })
})

test('a floor, a reading, a table that is not there are three different answers; an unknown chat is refused', async (t) => {
  const fix = await fixture(t)
  const { root, branch } = await lineage(fix)

  const pastTheEnd = await fix.handlers['chat.variablesDiff']({ a: { chatId: root, floor: 2 }, b: { chatId: branch, floor: 40 } })
  assert.equal(pastTheEnd.diff.b.missing, 'no-floor')
  assert.equal(pastTheEnd.diff.b.source, 'none')
  // A missing side compares as empty: side A's one top-level key went.
  assert.deepEqual(pastTheEnd.diff.summary, { added: 0, removed: 1, changed: 0 })

  const noReading = await fix.handlers['chat.variablesDiff']({ a: { chatId: root, floor: 2, swipe: 3 }, b: { chatId: root, floor: 2 } })
  assert.equal(noReading.diff.a.missing, 'no-swipe')
  assert.equal(noReading.diff.a.swipes, 1)

  // A user line this host grew carries no table of its own; it reads its
  // turn's, which is what a card reading that floor is given, and says so.
  const userLine = await fix.handlers['chat.variablesDiff']({ a: { chatId: root, floor: 1 }, b: { chatId: root, floor: 2 } })
  assert.equal(userLine.diff.a.role, 'user')
  assert.equal(userLine.diff.a.source, 'turn')
  assert.equal(userLine.diff.identical, true)

  await assert.rejects(
    () => fix.handlers['chat.variablesDiff']({ a: { chatId: 'nope', floor: 0 }, b: { chatId: root, floor: 0 } }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
})

test('a named reading is compared, not the selected one', async (t) => {
  const fix = await fixture(t)
  const { root } = await lineage(fix)
  // A second reading of floor 4, then back to the first: the selected reading
  // is 0 again, and the regenerated reading 1 carries a table of its own.
  await fix.handlers['chat.regenerate']({ chatId: root })
  while ((await fix.handlers['chat.open']({ chatId: root })).view.messages.at(-1)?.swipes?.count !== 2) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  await fix.floor(root, 4, { stat_data: { hp: [1, 'health'] } })
  await fix.handlers['chat.swipe']({ chatId: root, turn: 2, index: 0 })

  const { diff } = await fix.handlers['chat.variablesDiff']({ a: { chatId: root, floor: 4 }, b: { chatId: root, floor: 4, swipe: 1 } })
  assert.equal(diff.a.swipe, 0)
  assert.equal(diff.b.swipe, 1)
  assert.equal(diff.b.swipes, 2)
  assert.deepEqual(diff.entries[0], { path: ['stat_data', 'hp'], kind: 'changed', before: 15, after: 1, notes: ['mvu'] })
})
