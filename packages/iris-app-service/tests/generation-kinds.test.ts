import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ChatView, IrisEvent } from '@iris/protocol'
import { GLOBAL_ORDER_ID, type ChatCompletionPreset } from '@iris/preset'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { materialisingChatStore } from './support/materialising-store.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Generation kinds: `chat.send` with `kind: 'continue' | 'impersonate'`.
 *
 * Upstream makes the generation type a first-class input of assembly
 * (`getPromptCollection(generationType)`), and the two kinds that matter to a
 * reader are continue — write on from the newest reply, result rejoined to that
 * floor — and impersonate — write the user's next line instead. Both carry
 * utility prompts upstream (`continue_nudge_prompt` / `impersonation_prompt`,
 * `openai.js:104-110,898`), and both are where a preset's `injection_trigger`
 * lists get their consumer.
 */

/** A card whose post-history instructions say how to END a reply. */
const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'A retired cartographer.',
    personality: 'Precise.', scenario: '', first_mes: 'Hello, traveller.', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: 'End every reply with a question.',
    alternate_greetings: [], tags: [], creator: '', character_version: '1', extensions: {},
  },
})

/** A preset carrying one always-on prompt and two trigger-scoped ones. */
function triggeredPreset(): ChatCompletionPreset {
  const order = [
    { identifier: 'always', enabled: true },
    { identifier: 'onlyImpersonate', enabled: true },
    { identifier: 'onlyContinue', enabled: true },
    { identifier: 'main', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'jailbreak', enabled: true },
  ]
  return {
    prompts: [
      { identifier: 'always', role: 'system', content: 'ALWAYS-SENTINEL' },
      { identifier: 'onlyImpersonate', role: 'system', content: 'IMPERSONATE-SENTINEL', injection_trigger: ['impersonate'] },
      { identifier: 'onlyContinue', role: 'system', content: 'CONTINUE-SENTINEL', injection_trigger: ['continue'] },
      { identifier: 'main', role: 'system', content: 'Main.' },
      { identifier: 'chatHistory', marker: true },
      { identifier: 'jailbreak', role: 'system', content: '' },
    ],
    prompt_order: [{ character_id: GLOBAL_ORDER_ID, order }],
  }
}

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  seen: GenerateOptions[]
  events: IrisEvent[]
  settled: () => Promise<void>
}

async function fixture(
  t: TestContext,
  options: { replies?: string[], preset?: ChatCompletionPreset } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-gen-kinds-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const seen: GenerateOptions[] = []
  const events: IrisEvent[] = []
  const replies = options.replies ?? ['A reply.']
  let call = 0
  const stream: StreamFn = async function* (request: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(request)
    const text = replies[Math.min(call, replies.length - 1)] as string
    call += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  let ends = 0
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => {
      events.push(event)
      if (event.type === 'stream.end') ends += 1
    },
    userName: 'Traveller',
    ...options.preset === undefined ? {} : { preset: options.preset },
  }).handlers()

  return {
    handlers,
    chats,
    seen,
    events,
    settled: async () => {
      const wanted = ends + 1
      while (ends < wanted) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/** The texts of one request, in order. */
function textsOf(options: GenerateOptions | undefined): string[] {
  if (options === undefined) return []
  return options.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
}

/** Everything the provider saw, as one string. */
function whole(options: GenerateOptions | undefined): string {
  if (options === undefined) return ''
  return [options.system ?? '', ...textsOf(options)].join('\n')
}

test('a continue rejoins the floor it continued and keeps the older readings', async (t) => {
  // The continuation reply carries no leading space: the continue's separator
  // (the default `continue_postfix`, a space) already rides on the seed the
  // request is assembled with, so the composite keeps a single space.
  const fix = await fixture(t, { replies: ['A reply.', 'And the scene goes on.'] })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['chat.send']({ chatId, text: 'Go on.' })
  await fix.settled()
  const turn = fix.chats.cached(chatId)?.lastTurn ?? 0

  await fix.handlers['chat.send']({ chatId, kind: 'continue' })
  await fix.settled()

  const view = (await fix.handlers['chat.open']({ chatId })).view
  const floor = view.messages.find(message => message.role === 'assistant' && message.turn === turn)
  // 拼回原楼: the newest reading is seed plus continuation, on the SAME floor —
  // no new turn opened, and the older reading is still there to swipe back to.
  assert.notEqual(floor, undefined)
  assert.equal(floor?.text, 'A reply. And the scene goes on.')
  assert.deepEqual(floor?.swipes, { count: 2, index: 1 })

  // The file projection carries both readings, selected last: SillyTavern's
  // `swipes[]` + `swipe_id`, with the continue having edited the message in
  // place the way upstream's does.
  const entry = await fix.chats.open(chatId)
  const line = entry.toFile().messages.at(-1) as { swipes?: string[], swipe_id?: number }
  assert.deepEqual(line.swipes, ['A reply.', 'A reply. And the scene goes on.'])
  assert.equal(line.swipe_id, 1)
})

test('a continue closes on the nudge and drops the post-history wrap-up', async (t) => {
  const fix = await fixture(t, { replies: ['A reply.', ' And more.'] })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['chat.send']({ chatId, text: 'Go on.' })
  await fix.settled()
  const sent = whole(fix.seen[0])
  assert.ok(sent.includes('End every reply with a question.'), 'the card PHI never reached the ordinary send')

  await fix.handlers['chat.send']({ chatId, kind: 'continue' })
  await fix.settled()

  const texts = textsOf(fix.seen[1])
  // Upstream's continue nudge, last — after the continued floor, after any
  // depth injection, the thing the model reads before it writes.
  assert.equal(texts.at(-1), '[Continue your last message without repeating its original content.]')
  // B2's ruling: a continue must not close with post-history wrap-up, because
  // instruction that ends a reply is exactly wrong when the request writes on.
  assert.ok(
    whole(fix.seen[1]).includes('End every reply with a question.') === false,
    'the post-history instructions survived into the continue',
  )
})

test('a continue is refused when the newest line is not a reply', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // An exchange whose reply never arrived: a user line with nothing under it.
  // `script.createChatMessages` is the one path that writes a bare user line
  // without a generation attached.
  await fix.handlers['script.createChatMessages']({
    chatId,
    messages: [{ name: 'Traveller', is_user: true, mes: 'A line that never got its reply.' }],
  })

  await assert.rejects(
    () => fix.handlers['chat.send']({ chatId, kind: 'continue' }),
    /no reply to continue/u,
  )
})

test('an impersonate writes the user line, not a reply', async (t) => {
  const fix = await fixture(t, { replies: ['Fine, I will look for it myself.'] })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  const { turn } = await fix.handlers['chat.send']({ chatId, kind: 'impersonate' })
  await fix.settled()

  const view = (await fix.handlers['chat.open']({ chatId })).view
  const line = view.messages.at(-1)
  assert.notEqual(line, undefined)
  assert.equal(line?.role, 'user')
  assert.equal(line?.name, 'Traveller')
  assert.equal(line?.text, 'Fine, I will look for it myself.')
  assert.equal(line?.turn, turn, 'the impersonated line opened its own turn')

  // No reply followed it: the turn has a user line and nothing else, so the
  // next ordinary send opens the NEXT turn rather than being swallowed.
  assert.equal(
    view.messages.some(message => message.role === 'assistant' && message.turn === turn),
    false,
    'an impersonation produced an assistant reply',
  )
  assert.equal(turn, 1, 'the greeting held turn 0')

  // The instruction closed the request; the line was never in its own context.
  const texts = textsOf(fix.seen[0])
  assert.equal(texts.at(-1)?.includes('point of view of Traveller'), true, 'the impersonation prompt was not expanded')
  assert.ok(texts.slice(0, -1).every(text => !text.includes('I will look for it myself.')))
})

test('an impersonate leaves the MVU pathway alone', async (t) => {
  const fix = await fixture(t, { replies: ['Fine, I will do it myself.'] })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // A settled turn first, so there IS a variable table to protect.
  await fix.handlers['chat.send']({ chatId, text: 'Hello?' })
  await fix.settled()
  const entry = await fix.chats.open(chatId)
  const before = entry.variables.getVariables({ type: 'message', message_id: 0 })

  const { turn } = await fix.handlers['chat.send']({ chatId, kind: 'impersonate' })
  await fix.settled()

  // The impersonated turn owns no table at all — a user line carries no
  // variable consequences, the same rule a typed message lives under — and the
  // settled turn's table is untouched. Nothing for the next baseline walk to
  // stop on early, nothing misattributed to the model's reply.
  const after = await fix.chats.open(chatId)
  assert.deepEqual(after.variables.getVariables({ type: 'message', message_id: 0 }), before)
  assert.throws(() => after.variables.getVariables({ type: 'message', message_id: turn }))
})

test('a preset prompt triggered for impersonate appears only there', async (t) => {
  const fix = await fixture(t, { preset: triggeredPreset() })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['chat.send']({ chatId, text: 'Go on.' })
  await fix.settled()
  const sent = whole(fix.seen[0])
  assert.ok(sent.includes('ALWAYS-SENTINEL'), 'the always prompt went missing from a send')
  assert.ok(sent.includes('IMPERSONATE-SENTINEL') === false, 'an impersonate-triggered prompt joined a send')
  assert.ok(sent.includes('CONTINUE-SENTINEL') === false, 'a continue-triggered prompt joined a send')

  await fix.handlers['chat.send']({ chatId, kind: 'continue' })
  await fix.settled()
  const carry = whole(fix.seen[1])
  assert.ok(carry.includes('CONTINUE-SENTINEL'), 'the continue trigger did not fire')
  assert.ok(carry.includes('IMPERSONATE-SENTINEL') === false, 'an impersonate trigger fired on a continue')
  assert.ok(carry.includes('ALWAYS-SENTINEL'), 'the always prompt went missing from a continue')

  await fix.handlers['chat.send']({ chatId, kind: 'impersonate' })
  await fix.settled()
  const voice = whole(fix.seen[2])
  assert.ok(voice.includes('IMPERSONATE-SENTINEL'), 'the impersonate trigger did not fire')
  assert.ok(voice.includes('CONTINUE-SENTINEL') === false, 'a continue trigger fired on an impersonation')
  assert.ok(voice.includes('End every reply with a question.'), 'impersonation kept the post-history section')
})

test('a continue announces the seed so the row does not collapse while streaming', async (t) => {
  const fix = await fixture(t, { replies: ['A reply.', ' And more.'] })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['chat.send']({ chatId, text: 'Go on.' })
  await fix.settled()

  await fix.handlers['chat.send']({ chatId, kind: 'continue' })
  const start = fix.events.filter(event => event.type === 'stream.start').at(-1)
  assert.notEqual(start, undefined)
  // The seed announces with the separator included: the space postfix is part
  // of what the request carries and part of what paints, so the floor never
  // loses the character the model was actually given.
  assert.equal(start?.type === 'stream.start' && start.seed, 'A reply. ')

  await fix.settled()
})

test('an impersonate announces itself as the user, before it settles', async (t) => {
  const fix = await fixture(t, { replies: ['I will do it myself.'] })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['chat.send']({ chatId, kind: 'impersonate' })
  const start = fix.events.filter(event => event.type === 'stream.start').at(-1)
  assert.notEqual(start, undefined)
  assert.equal(start?.type === 'stream.start' && start.role, 'user')
  assert.equal(start?.type === 'stream.start' && start.name, 'Traveller')

  await fix.settled()
  const view: ChatView = (await fix.handlers['chat.open']({ chatId })).view
  assert.equal(view.messages.at(-1)?.role, 'user')
})
