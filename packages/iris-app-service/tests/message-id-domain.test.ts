import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { requestSchemas } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Which `message_id` values a card may address a floor with.
 *
 * The domain is upstream's, and it is wider than a number: `_.inRange` and
 * `Array.prototype.at` both coerce, so numeric strings work there, and `at`
 * gives negatives their from-the-end meaning. `'latest'` is a real sentinel two
 * corpus cards write verbatim.
 *
 * **Every case here goes through `requestSchemas` first.** An earlier change
 * widened the *comment* on this field and left the schema at
 * `z.number().int().min(0)` — the substitution silently failed, nothing
 * asserted that it had landed, and no test exercised the field through the
 * schema. The result compiled, passed 943 tests, and shipped a contract whose
 * documentation promised what its validator rejected. Parsing here is what
 * makes that impossible to repeat.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

/** A host with a few turns on the log. */
async function fixture(t: TestContext): Promise<{ handlers: Handlers, chatId: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-mid-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  let ends = 0
  const stream: StreamFn = async function* () {
    const text = 'Reply.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: event => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  for (let index = 0; index < 2; index += 1) {
    await handlers['chat.send']({ chatId, text: `Message ${String(index)}.` })
    while (ends < index + 1) await new Promise(resolve => setTimeout(resolve, 1))
  }
  return { handlers, chatId }
}

/** Parse through the wire contract, as a real request would. */
function accepted(method: 'script.getVariables' | 'script.setVariables', messageId: unknown): boolean {
  return requestSchemas[method].safeParse({
    chatId: 'c', scope: 'message', messageId,
    ...method === 'script.setVariables' ? { op: 'replace', variables: {} } : {},
  }).success
}

test('the schema accepts every value upstream accepts', () => {
  // The assertion the previous change lacked: the *validator*, not the comment.
  for (const method of ['script.getVariables', 'script.setVariables'] as const) {
    assert.equal(accepted(method, 'latest'), true, `${method} rejected the 'latest' sentinel`)
    assert.equal(accepted(method, 0), true)
    assert.equal(accepted(method, 3), true)
    assert.equal(accepted(method, -1), true, `${method} rejected a from-the-end id`)
    assert.equal(accepted(method, '3'), true, `${method} rejected a numeric string`)
    assert.equal(accepted(method, undefined), true)
  }
})

test('the range is not pinned in the schema, because the schema cannot know it', () => {
  // A wire schema has no idea how long the chat is, so `-1` and `9999` are both
  // well-shaped here and both decided by the host against a real log. Pinning
  // `min(0)` is what rejected the negatives upstream accepts.
  assert.equal(accepted('script.getVariables', 9999), true)
  assert.equal(accepted('script.getVariables', -50), true)
})

test('a floor addressed from the end is the same floor as from the front', async (t) => {
  const fixed = await fixture(t)

  const fromFront = await fixed.handlers['script.getVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: 2,
  })
  const fromEnd = await fixed.handlers['script.getVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: -3,
  })

  // 5 lines: greeting, user, reply, user, reply. Index 2 and -3 are one line.
  assert.deepEqual(fromEnd.variables, fromFront.variables)
})

test('a numeric string addresses the same floor as the number', async (t) => {
  const fixed = await fixture(t)

  const asNumber = await fixed.handlers['script.getVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: 2,
  })
  const asText = await fixed.handlers['script.getVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: '2',
  })
  assert.deepEqual(asText.variables, asNumber.variables)
})

test('null is refused by name, never treated as floor 0', async (t) => {
  const fixed = await fixture(t)

  // Upstream lets `null` through by accident — `_.inRange(null, …)` is true and
  // `chat.at(null)` is `chat.at(0)` — so a card that computed `null` silently
  // reads, and on the write path silently overwrites, the opening message. A
  // read-modify-write aimed at floor 0 destroys data and reports success.
  await assert.rejects(
    () => fixed.handlers['script.getVariables']({
      chatId: fixed.chatId, scope: 'message', messageId: null as never,
    }),
    /message_id is null/u,
  )
  await assert.rejects(
    () => fixed.handlers['script.setVariables']({
      chatId: fixed.chatId, scope: 'message', messageId: null as never,
      op: 'replace', variables: { a: 1 },
    }),
    /message_id is null/u,
  )
})

test('an out-of-range id is refused, not clamped', async (t) => {
  const fixed = await fixture(t)

  for (const messageId of [9999, -9999]) {
    await assert.rejects(
      () => fixed.handlers['script.getVariables']({
        chatId: fixed.chatId, scope: 'message', messageId,
      }),
      /has no message/u,
      `messageId ${String(messageId)} was not refused`,
    )
  }
})

test('a non-integer id is refused by shape', async (t) => {
  const fixed = await fixture(t)

  for (const messageId of ['last', 'abc', 1.5]) {
    await assert.rejects(
      () => fixed.handlers['script.getVariables']({
        chatId: fixed.chatId, scope: 'message', messageId: messageId as never,
      }),
      /must be an integer/u,
      `messageId ${JSON.stringify(messageId)} was accepted`,
    )
  }
})

test('latest reads and writes the same floor', async (t) => {
  const fixed = await fixture(t)

  // Upstream reads the last non-system message and writes the last message, so
  // a chat ending in a system row reads one floor and writes another — silently
  // and only sometimes. One rule here means a write through `'latest'` is
  // always visible to a read through `'latest'`.
  await fixed.handlers['script.setVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: 'latest',
    op: 'replace', variables: { marker: 'written via latest' },
  })
  const read = await fixed.handlers['script.getVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: 'latest',
  })

  assert.equal((read.variables as { marker?: string }).marker, 'written via latest')
})
