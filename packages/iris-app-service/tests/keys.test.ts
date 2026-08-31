import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * `MessageView.key` exists for exactly one job: surviving a delete.
 *
 * `id` is a position, so removing a message shifts every later one and a UI
 * keyed on it reattaches component state to the wrong row — an open inline
 * editor ends up on the neighbouring turn. This file pins that the keys of the
 * messages that were NOT deleted do not move.
 */

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

/** A stream that holds the reply back until the test lets it through. */
function gated(text: string, gate: Promise<void>): StreamFn {
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'partial' }
    await gate
    yield { type: 'text-delta', index: 0, text: text.slice('partial'.length) }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A stream that answers with the next scripted reply. */
function scripted(replies: readonly string[]): StreamFn {
  let call = 0
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = replies[Math.min(call, replies.length - 1)] ?? ''
    call += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A service over a throwaway folder, plus a way to wait for a turn to land. */
async function fixture(t: TestContext, replies: readonly string[]): Promise<{
  handlers: Handlers
  settled: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-keys-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  let ends = 0
  const handlers = new IrisAppService({
    stream: scripted(replies),
    library,
    chats,
    settings,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  let seen = 0
  return {
    handlers,
    settled: async () => {
      seen += 1
      while (ends < seen) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

test('every row in a view has a distinct key', async (t) => {
  const { handlers, settled } = await fixture(t, ['First reply.', 'Second reply.'])
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['chat.send']({ chatId, text: 'One?' })
  await settled()
  await handlers['chat.send']({ chatId, text: 'Two?' })
  await settled()

  const { view } = await handlers['chat.open']({ chatId })
  const keys = view.messages.map(message => message.key)
  assert.equal(keys.length, 5, 'greeting + two exchanges')
  assert.equal(new Set(keys).size, keys.length, `keys collide: ${keys.join(', ')}`)
})

test('deleting a message does not move the keys of the messages that remain', async (t) => {
  const { handlers, settled } = await fixture(t, ['First reply.', 'Second reply.'])
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['chat.send']({ chatId, text: 'One?' })
  await settled()
  await handlers['chat.send']({ chatId, text: 'Two?' })
  await settled()

  const before = (await handlers['chat.open']({ chatId })).view.messages
  const keptText = before.filter((_message, index) => index !== 2).map(message => message.text)
  const keptKeys = new Map(before.filter((_m, index) => index !== 2).map(m => [m.text, m.key]))

  // Drop the first reply, in the middle of the conversation.
  const { view } = await handlers['chat.deleteMessage']({ chatId, id: 2 })

  assert.deepEqual(view.messages.map(message => message.text), keptText, 'the right message went')
  for (const message of view.messages) {
    assert.equal(
      message.key,
      keptKeys.get(message.text),
      `the key of "${message.text}" moved, so a UI keyed on it would remount the row`,
    )
  }
})

test('stream.start announces the identity the settled row carries, before any delta', async (t) => {
  // The browser synthesizes a row for a turn no view of its holds yet, so the
  // identity has to travel on the frame: nothing in a minted key is derivable.
  // Ordering is asserted rather than argued — the announcement is broadcast
  // after the driver's synchronous appends, and if a delta could overtake it
  // the client would key the row from the fallback and remount on settle.
  const dir = await mkdtemp(join(tmpdir(), 'iris-keys-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const seen: IrisEvent[] = []
  let ended = false
  const handlers = new IrisAppService({
    stream: scripted(['She sets out.']),
    library,
    chats,
    settings,
    broadcast: (event: IrisEvent) => {
      seen.push(event)
      if (event.type === 'stream.end') ended = true
    },
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  while (!ended) await new Promise(resolve => setTimeout(resolve, 1))

  const streamFrames = seen.filter(event => event.type.startsWith('stream.'))
  assert.equal(streamFrames[0]?.type, 'stream.start', 'the opening frame is first')

  const opening = streamFrames[0]
  assert.ok(opening.type === 'stream.start')
  const settledRows = (await handlers['chat.open']({ chatId })).view.messages
  const reply = settledRows[settledRows.length - 1]

  assert.equal(reply?.role, 'assistant')
  assert.equal(opening.key, reply?.key, 'announced identity is the one the reply ends up with')
})

test('a streaming row keeps its key when the reply settles', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-keys-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  let release = (): void => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  let ended = false
  const handlers = new IrisAppService({
    stream: gated('partial and then the rest.', gate),
    library,
    chats,
    settings,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ended = true },
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })

  // Read the view while the reply is still arriving.
  let streamingKey: string | undefined
  for (let attempt = 0; attempt < 500 && streamingKey === undefined; attempt += 1) {
    const rows = (await handlers['chat.open']({ chatId })).view.messages
    const row = rows[rows.length - 1]
    if (row?.streaming === true) streamingKey = row.key
    else await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.ok(streamingKey !== undefined, 'never observed the streaming row')

  release()
  while (!ended) await new Promise(resolve => setTimeout(resolve, 1))

  const rows = (await handlers['chat.open']({ chatId })).view.messages
  const settledRow = rows[rows.length - 1]
  assert.equal(settledRow?.streaming, undefined)
  // The reply keeps one identity from its first token to its last, so a UI does
  // not tear down and rebuild the bubble at the moment it finishes.
  assert.equal(settledRow?.key, streamingKey)
})

test('a reroll announces the identity of the row it streams into', async (t) => {
  // A reroll writes into the row that is already there rather than adding one,
  // so the identity it announces is that row's — not the slot a fresh reply
  // would have taken. Getting this wrong is invisible on the send path and
  // remounts the bubble on every regenerate.
  const dir = await mkdtemp(join(tmpdir(), 'iris-keys-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const seen: IrisEvent[] = []
  let ends = 0
  const handlers = new IrisAppService({
    stream: scripted(['First take.', 'Second take.']),
    library,
    chats,
    settings,
    broadcast: (event: IrisEvent) => {
      seen.push(event)
      if (event.type === 'stream.end') ends += 1
    },
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  while (ends < 1) await new Promise(resolve => setTimeout(resolve, 1))

  const rows = (await handlers['chat.open']({ chatId })).view.messages
  const replyKey = rows[rows.length - 1]?.key

  seen.length = 0
  await handlers['chat.regenerate']({ chatId })
  while (ends < 2) await new Promise(resolve => setTimeout(resolve, 1))

  const opening = seen.find(event => event.type === 'stream.start')
  assert.ok(opening?.type === 'stream.start')
  assert.equal(opening.key, replyKey, 'a reroll streams into the row that is already showing')

  const settled = (await handlers['chat.open']({ chatId })).view.messages
  assert.equal(settled[settled.length - 1]?.key, replyKey, 'and the row keeps that identity')
  assert.equal(settled[settled.length - 1]?.text, 'Second take.')
})
