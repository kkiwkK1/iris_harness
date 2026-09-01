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
 * A message frame's snapshot is anchored to its own floor.
 *
 * The rule is upstream's, from `JS-Slash-Runner/src/function/variables.ts`:
 *
 * ```js
 * return chat_message?.variables?.[chat_message?.swipe_id ?? 0] ?? {};
 * ```
 *
 * Three properties, and the first is the one that makes the feature mean
 * anything: **a floor's layer does not inherit.** The `message` *scope* in this
 * host deliberately walks backwards, so a turn that wrote nothing still reads
 * the running state — right for the scope, fatal here. A floor anchor that
 * inherited would report the newest reachable state on every floor, and every
 * floor would agree with every other, which is exactly the answer anchoring
 * exists to replace.
 *
 * The other two: it follows the **selected** swipe (`variables` is an array
 * parallel to `swipes`), and an absent layer is `{}` rather than null or a
 * refusal — a floor may honestly have no variables.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
    // An `[InitVar]` entry, because MVU's `set` refuses a path that does not
    // exist — a card declares its shape before a reply can update it.
    character_book: {
      entries: [{
        keys: [], content: 'count: 0', comment: '[InitVar]', name: '[InitVar]',
        enabled: false, constant: false, insertion_order: 0, extensions: {},
      }],
    },
  },
})

interface Fixture {
  handlers: Handlers
  settled: () => Promise<void>
}

async function fixture(t: TestContext, replies: readonly string[]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-floor-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  let call = 0
  let ends = 0
  let waited = 0
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = replies[Math.min(call, replies.length - 1)] ?? ''
    call += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  return {
    handlers,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/** A reply carrying an MVU command, so a turn writes a variable layer. */
const wrote = (value: number): string => `Noted. _.set('count', ${String(value)});`

test('a floor reports its own layer, not the newest one', async (t) => {
  const { handlers, settled } = await fixture(t, [wrote(1), wrote(2)])
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['chat.send']({ chatId, text: 'First.' })
  await settled()
  await handlers['chat.send']({ chatId, text: 'Second.' })
  await settled()

  const view = await handlers['chat.open']({ chatId })
  const floors = view.view.messages.length
  assert.ok(floors >= 4, `expected greeting + two exchanges, saw ${String(floors)}`)

  const at = async (messageId: number): Promise<Record<string, unknown>> => {
    const { context } = await handlers['script.context']({ chatId, characterId: 'aria', messageId })
    assert.equal(context.floor?.messageId, messageId, 'the floor number came back wrong')
    return context.floor?.variables ?? {}
  }

  // The two assistant floors wrote different values. If the anchor inherited,
  // the earlier floor would report the later value and both would agree — which
  // is precisely the answer anchoring exists to replace.
  const earlier = await at(2)
  const later = await at(4)
  assert.equal((earlier['stat_data'] as { count?: number } | undefined)?.count, 1)
  assert.equal((later['stat_data'] as { count?: number } | undefined)?.count, 2)
  assert.notDeepEqual(earlier, later, 'every floor reported the same layer')
})

test('floor 0 carries the card’s declared starting state', async (t) => {
  const { handlers } = await fixture(t, ['Nothing to record.'])
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // Not empty, and this is two features meeting rather than an accident: a new
  // chat seeds floor 0 from the card's `[InitVar]` declaration, because that is
  // what SillyTavern's own files carry (21 of 31 measured) and what
  // `waitGlobalInitialized('Mvu')` polls for. So the greeting's floor has a real
  // layer, and a frame anchored there sees the declared starting state rather
  // than nothing.
  //
  // Asserting `{}` here would have looked reasonable and pinned the seeding
  // *off*.
  const { context } = await handlers['script.context']({ chatId, characterId: 'aria', messageId: 0 })
  assert.equal(context.floor?.messageId, 0)
  assert.equal((context.floor?.variables['stat_data'] as { count?: number } | undefined)?.count, 0)
})

test('a floor that does not exist is empty rather than an error', async (t) => {
  const { handlers } = await fixture(t, ['A reply.'])
  const created = await handlers['chat.create']({ characterId: 'aria' })

  // Upstream's optional chaining swallows this too: `chat[999]?.variables` is
  // undefined and the `?? {}` catches it. A refusal here would be stricter than
  // the thing being reproduced, and a frame would have to handle an error for a
  // floor it can only have learned about from us.
  const { context } = await handlers['script.context']({
    chatId: created.view.chatId,
    characterId: 'aria',
    messageId: 999,
  })
  assert.deepEqual(context.floor?.variables, {})
  assert.equal(context.floor?.messageId, 999)
})

test('a script frame gets no floor at all', async (t) => {
  const { handlers } = await fixture(t, ['A reply.'])
  const created = await handlers['chat.create']({ characterId: 'aria' })

  const { context } = await handlers['script.context']({
    chatId: created.view.chatId,
    characterId: 'aria',
  })
  // Absent, not an empty object: a script frame belongs to the card and has no
  // floor, and `floor: { messageId: 0, … }` would be a claim it is on floor zero.
  assert.equal('floor' in context, false, 'a script frame was given a floor')
  // The chat-level layers are still there — the two are independent.
  assert.equal(typeof context.variableLayers.chat, 'object')
})

test('the layer follows the selected swipe', async (t) => {
  const { handlers, settled } = await fixture(t, [wrote(1), wrote(2)])
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['chat.send']({ chatId, text: 'First.' })
  await settled()
  await handlers['chat.regenerate']({ chatId })
  await settled()

  const floorOf = async (): Promise<Record<string, unknown>> => {
    const { context } = await handlers['script.context']({ chatId, characterId: 'aria', messageId: 2 })
    return context.floor?.variables ?? {}
  }

  // `variables` is an array parallel to `swipes`, so which swipe is showing
  // decides which layer this floor has. Reading slot 0 unconditionally would
  // give a frame the consequences of a reply the user swiped away from.
  assert.equal(((await floorOf())['stat_data'] as { count?: number } | undefined)?.count, 2)
  await handlers['script.swipeTo']({ chatId, messageId: 2, swipeIndex: 0 })
  assert.equal(((await floorOf())['stat_data'] as { count?: number } | undefined)?.count, 1)
})
