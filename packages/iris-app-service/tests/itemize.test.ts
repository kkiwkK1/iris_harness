import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { decodeCardPng } from '@iris/character'
import type { ChatCompletionPreset } from '@iris/preset'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { materialisingChatStore } from './support/materialising-store.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Where an assembled prompt's tokens went.
 *
 * The feature's own justification is a number, so the last test here measures
 * it rather than describing it: on a real preset and card, two thirds of the
 * prompt turns out to be one world-info entry.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: 'A retired cartographer of some renown.', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '1', extensions: {},
  },
})

/** A stream that answers once and reports what the prompt cost. */
function scripted(inputTokens?: number): StreamFn {
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'A reply.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'A reply.' } }
    if (inputTokens !== undefined) {
      yield { type: 'usage', usage: { inputTokens, outputTokens: 4 } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  settled: () => Promise<void>
}

async function fixture(t: TestContext, inputTokens?: number): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-itemize-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  let ends = 0
  let waited = 0

  const handlers = new IrisAppService({
    stream: scripted(inputTokens),
    library,
    chats,
    settings,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  return {
    handlers,
    chats,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

test('a preview needs no record, and says that it is one', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })

  // Nothing has been generated, so nothing could have been recorded — and the
  // answer is still useful, which is the point of preview mode.
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  assert.equal(itemization.preview, true)
  assert.ok(itemization.entries.length > 0)
  assert.equal(itemization.tokens > 0, true)
  assert.equal(itemization.budget.context, 32_768)

  // The character's description is in there, and named.
  const described = itemization.entries.find(entry => entry.id === 'charDescription')
  assert.ok(described !== undefined, `no charDescription among ${itemization.entries.map(e => e.id).join(', ')}`)
  assert.ok(described.tokens > 0)
})

test('the parts sum to the total, and the conversation is one row', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  const history = itemization.entries.filter(entry => entry.kind === 'history')
  assert.equal(history.length, 1, 'the conversation is one aggregate row, as upstream reports it')

  const summed = itemization.entries.reduce((total, entry) => total + entry.tokens, 0)
  // Exact, not approximate: a breakdown whose parts do not add up is worse than
  // no breakdown, because it sends someone hunting for the missing tokens.
  assert.equal(summed, itemization.tokens)
})

test('a generated turn is recorded as it was assembled, with what it really cost', async (t) => {
  const fix = await fixture(t, 4321)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  const { turn } = await fix.handlers['chat.send']({ chatId, text: 'Hello?' })
  await fix.settled()

  const { itemization } = await fix.handlers['prompt.itemize']({ chatId, turn })

  assert.equal(itemization.preview, false, 'this is the request that was sent, not a guess at the next one')
  assert.equal(itemization.turn, turn)
  // The provider's own count, beside our estimate — this is what tells a user
  // whether the estimate is worth trusting.
  assert.equal(itemization.actualTokens, 4321)
  assert.notEqual(itemization.tokens, 0)
})

test('a turn with no record answers with a preview rather than nothing', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })

  // Records live only while the host holds the chat open, so a UI asking about
  // an old turn has to get something useful back.
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId, turn: 99 })

  assert.equal(itemization.preview, true)
  assert.ok(itemization.entries.length > 0)
})

test('a label is always present, even when the id is a UUID', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  for (const entry of itemization.entries) {
    assert.ok(entry.label.length > 0, `${entry.id} has no label`)
  }
})

/**
 * The justification, measured.
 *
 * Skipped without a SillyTavern install. It is here because the argument for
 * building this at all is a number that no fixture can produce: a real preset
 * and a real card put two thirds of the prompt in one place nobody would guess.
 */
const PRESET = `${(process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern')}/data/default-user/OpenAI Settings/梦境思客V1-0425.json`
const REAL_CARD = `${(process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern')}/data/default-user/characters/银麒赎世.png`

test('on real data, one world-info entry is most of the prompt', {
  skip: (!existsSync(PRESET) || !existsSync(REAL_CARD))
    && `needs the real preset ${PRESET} and card ${REAL_CARD}; point IRIS_CORPUS at the install that has them`,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-itemize-real-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'yinqi.png'), await readFile(REAL_CARD))

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const preset = JSON.parse(await readFile(PRESET, 'utf8')) as ChatCompletionPreset

  const handlers = new IrisAppService({
    stream: scripted(),
    library,
    chats,
    settings,
    preset,
    broadcast: () => {},
    userName: '旅人',
  }).handlers()

  // The card decodes; if it ever stops, this test is measuring nothing.
  assert.ok(decodeCardPng(await readFile(REAL_CARD)).data.name.length > 0)

  const created = await handlers['chat.create']({ characterId: 'yinqi' })
  const { itemization } = await handlers['prompt.itemize']({ chatId: created.view.chatId })

  const ranked = [...itemization.entries].sort((left, right) => right.tokens - left.tokens)
  const biggest = ranked[0]
  assert.ok(biggest !== undefined)

  const share = biggest.tokens / itemization.tokens
  assert.ok(
    share > 0.4,
    `the largest part is ${String(biggest.tokens)}/${String(itemization.tokens)} — the shape this feature exists to reveal`,
  )
  // `worldInfoBefore` here rather than `worldInfo.depth.*` because a fresh chat
  // has no history for a depth injection to sit inside; both are world info,
  // which is the claim. Which bucket it lands in is the pipeline's business.
  assert.match(
    biggest.id,
    /^worldInfo/u,
    `expected world info to dominate, got ${biggest.id} at ${String(Math.round(share * 100))}%`,
  )
})
