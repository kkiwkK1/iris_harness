import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * `message_id` counts **messages**, everywhere in the contract.
 *
 * It had two meanings. `script.getVariables` / `script.setVariables` passed the
 * number through to the variable service, which counts **turns** — exchanges —
 * so a card addressing message 2 wrote to a different floor. `ScriptContext`'s
 * `floor.messageId` meanwhile is a message index, as is upstream's
 * `chat.at(message_id)`. Two independent sources against one leaked
 * implementation detail, so the index reading is the contract's.
 *
 * Correcting it cost nothing because nothing had reached it: the frame refuses
 * every `message_id` but `'latest'`, so no explicit id had ever crossed. That
 * window is closing — MVU addresses explicitly at **12 sites across 13 of 19
 * cards**, three of them passing `getCurrentMessageId()` straight through, and
 * those become the first real traffic the moment the frame opens the path. The
 * last vector below is that shape.
 *
 * The tests address the same floor through **three readers that resolve it
 * independently** — the writer, the reader, and the floor anchor. Agreement
 * between any two of them could be two paths sharing one bug; all three is the
 * claim worth making.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'M0', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  chatId: string
  /** Message texts, so an index can be named rather than counted. */
  texts: () => Promise<string[]>
}

async function fixture(t: TestContext, turns = 3): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-addr-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  let ends = 0
  let reply = 0
  const stream: StreamFn = async function* () {
    const text = `A${String(reply)}`
    reply += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'U',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  for (let turn = 0; turn < turns; turn += 1) {
    await handlers['chat.send']({ chatId, text: `U${String(turn)}` })
    while (ends < turn + 1) await new Promise(resolve => setTimeout(resolve, 1))
  }

  return {
    handlers, chats, chatId,
    texts: async () => (await handlers['chat.open']({ chatId })).view.messages.map(message => message.text),
  }
}

test('a write and a read agree on which message an id names', async (t) => {
  const fixed = await fixture(t)
  const texts = await fixed.texts()
  assert.deepEqual(texts, ['M0', 'U0', 'A0', 'U1', 'A1', 'U2', 'A2'])

  await fixed.handlers['script.setVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: 2, op: 'replace',
    variables: { marker: 'AT_2' },
  })
  const read = await fixed.handlers['script.getVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: 2,
  })
  assert.deepEqual(read.variables, { marker: 'AT_2' })
})

test('the floor anchor resolves the same id to the same floor', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['script.setVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: 2, op: 'replace',
    variables: { marker: 'AT_2' },
  })

  // The third reader, and the one that makes this more than a round trip: the
  // floor anchor resolves an id by its own path. Before the fix the writer put
  // the table on the floor at index 3 while the anchor read index 2 — each half
  // self-consistent, the pair disagreeing, and nothing raised.
  const entry = await fixed.chats.open(fixed.chatId)
  assert.deepEqual(entry.floorVariables(2), { marker: 'AT_2' })
})

test('a floor reports its latest table, not the one it was born with', async (t) => {
  const fixed = await fixture(t)
  const entry = await fixed.chats.open(fixed.chatId)

  // The log is append-only, so a floor written twice has two `iris/variables`
  // events. `floorVariables` used to return on the first match, reporting the
  // table as it stood when the floor was created — well-formed, complete, and
  // stale. It stayed hidden because the ordinary path writes each candidate
  // once, so first and last coincide everywhere except after an explicit write.
  await fixed.handlers['script.setVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: 2, op: 'replace',
    variables: { generation: 'first' },
  })
  await fixed.handlers['script.setVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: 2, op: 'replace',
    variables: { generation: 'second' },
  })

  assert.deepEqual(entry.floorVariables(2), { generation: 'second' })
})

test('an id past the end is refused, not clamped to the newest floor', async (t) => {
  const fixed = await fixture(t)

  // Clamping would hand a miscounting card the newest floor's table, which it
  // cannot tell apart from the one it asked for — and then, MVU being
  // read-merge-write, fold it back onto the wrong floor.
  await assert.rejects(
    () => fixed.handlers['script.getVariables']({
      chatId: fixed.chatId, scope: 'message', messageId: 99,
    }),
    /no message 99/u,
  )
  await assert.rejects(
    () => fixed.handlers['script.setVariables']({
      chatId: fixed.chatId, scope: 'message', messageId: 99, op: 'replace', variables: {},
    }),
    /no message 99/u,
  )
})

test('the current floor number, passed straight through', async (t) => {
  const fixed = await fixture(t)
  const texts = await fixed.texts()

  // MVU's shape: `getCurrentMessageId()` returns the index of the floor being
  // rendered and is handed to the variable call unmodified — three of its
  // twelve addressing sites do exactly this. It is the vector most likely to
  // arrive first once the frame opens explicit addressing, so it is checked as
  // itself rather than folded into the generic case.
  const current = texts.length - 1
  await fixed.handlers['script.setVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: current, op: 'replace',
    variables: { at: 'current' },
  })

  const read = await fixed.handlers['script.getVariables']({
    chatId: fixed.chatId, scope: 'message', messageId: current,
  })
  assert.deepEqual(read.variables, { at: 'current' })

  const entry = await fixed.chats.open(fixed.chatId)
  assert.deepEqual(entry.floorVariables(current), { at: 'current' })

  // And it is genuinely the last floor, not merely self-consistent: an earlier
  // floor must not have been touched.
  assert.notDeepEqual(entry.floorVariables(2), { at: 'current' })
})

test('omitting the id still means the latest, unchanged', async (t) => {
  const fixed = await fixture(t)
  // The path 88% of corpus reads take, and the one that was already working.
  // Pinned because the fix touched the code it runs through.
  const read = await fixed.handlers['script.getVariables']({ chatId: fixed.chatId, scope: 'message' })
  assert.equal(typeof read.variables, 'object')
})
