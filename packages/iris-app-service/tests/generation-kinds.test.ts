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

  // And it reached the provider the way upstream delivers it: role system, the
  // request's last message (`openai.js:1373` builds the prompt role system,
  // `:1213-1216` appends it after the whole chat history). A user-voice
  // instruction standing on an assistant-ended conversation is what made a
  // strong preset continue the character's last floor instead of writing the
  // user's next line.
  const instruction = fix.seen[0]?.messages.at(-1)
  assert.equal(instruction?.role, 'system', 'the expanded impersonation prompt did not ride as a system message')
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

  // The impersonated turn owns no table of its own — a user line carries no
  // variable consequences, the same rule a typed message lives under — so
  // reading it answers the nearest earlier settled turn's table, inherited,
  // and the settled turns' own tables are untouched. (The inherited read used
  // to be an error, which emptied every status surface for the user→reply
  // window; it is the same fact under the read rule the store already applies
  // one turn later.)
  const after = await fix.chats.open(chatId)
  assert.deepEqual(after.variables.getVariables({ type: 'message', message_id: 0 }), before)
  assert.deepEqual(
    after.variables.getVariables({ type: 'message', message_id: turn }),
    after.variables.getVariables({ type: 'message', message_id: turn - 1 }),
    'the impersonated turn reads the state it inherited, not a table of its own',
  )
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

test('trim_sentences cuts a completed reply back to its last sentence before it is stored', async (t) => {
  // The generated text runs past its last complete sentence — the shape the
  // setting exists for.
  const fix = await fixture(t, { replies: ['He stood. He waved his hand'] })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // Default off: the reply is stored exactly as generated.
  await fix.handlers['chat.send']({ chatId, text: 'Go on.' })
  await fix.settled()
  const first = (await fix.handlers['chat.open']({ chatId })).view
  assert.equal(
    first.messages.find(message => message.role === 'assistant' && message.turn === 1)?.text,
    'He stood. He waved his hand',
  )

  await fix.handlers['settings.set']({ settings: { trimSentences: true } })
  await fix.handlers['chat.send']({ chatId, text: 'Go on.' })
  await fix.settled()

  // The floor, and the file projection under it, carry the cut text: the trim
  // runs before variables and storage read the reply, so everything downstream
  // sees what upstream's cleanUpMessage would have left.
  const view = (await fix.handlers['chat.open']({ chatId })).view
  assert.equal(
    view.messages.find(message => message.role === 'assistant' && message.turn === 2)?.text,
    'He stood.',
  )
  const entry = await fix.chats.open(chatId)
  const line = entry.toFile().messages.at(-1)
  assert.equal(line?.is_user, false)
  assert.equal((line as { mes?: string }).mes, 'He stood.')
})

test('an impersonated line is a user line, and trim_sentences never touches it', async (t) => {
  const fix = await fixture(t, { replies: ['He waved his hand'] })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['settings.set']({ settings: { trimSentences: true } })
  await fix.handlers['chat.send']({ chatId, kind: 'impersonate' })
  await fix.settled()

  const view = (await fix.handlers['chat.open']({ chatId })).view
  // A user line with no sentence end keeps every word of it.
  assert.equal(view.messages.at(-1)?.role, 'user')
  assert.equal(view.messages.at(-1)?.text, 'He waved his hand')
})

test('continue_postfix spells the boundary on the announce, the request and the floor', async (t) => {
  const fix = await fixture(t, { replies: ['A reply.', 'And the scene goes on.'] })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['chat.send']({ chatId, text: 'Go on.' })
  await fix.settled()

  await fix.handlers['settings.set']({ settings: { continuePostfix: 'double' } })
  await fix.handlers['chat.send']({ chatId, kind: 'continue' })

  // The announce paints the boundary the request carries.
  const start = fix.events.filter(event => event.type === 'stream.start').at(-1)
  assert.equal(start?.type === 'stream.start' && start.seed, 'A reply.\n\n')

  await fix.settled()

  // The provider read the same boundary (upstream appends `continue_postfix`
  // to `cyclePrompt` before the prompt is built, script.js:4919).
  const texts = textsOf(fix.seen[1])
  assert.equal(texts.includes('A reply.\n\n'), true, 'the request never carried the continue separator')
  // And the floor joins seed, separator, continuation.
  const view = (await fix.handlers['chat.open']({ chatId })).view
  assert.equal(
    view.messages.find(message => message.role === 'assistant' && message.turn === 1)?.text,
    'A reply.\n\nAnd the scene goes on.',
  )
})

test('a reroll does not feed the reply it is replacing back to the model', async (t) => {
  const fixed = await fixture(t, { replies: ['FIRST-READING.', 'SECOND-READING.'] })
  const chatId = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId

  await fixed.handlers['chat.send']({ chatId, text: 'Hello?' })
  await fixed.settled()
  await fixed.handlers['chat.regenerate']({ chatId })
  await fixed.settled()

  // Upstream drops it on both paths — `chat.length = chat.length - 1` before a
  // regenerate's prompt is built (script.js:4347) and `coreChat.pop()` for a
  // swipe (:4438-4440). Iris fed it back, so the model was shown its own
  // previous answer and asked for a different one.
  const reroll = fixed.seen[fixed.seen.length - 1]
  assert.equal(whole(reroll).includes('FIRST-READING.'), false,
    'the reroll carried the reply it was replacing')
  assert.equal(textsOf(reroll).includes('Hello?'), true, 'the reroll lost the user line it answers')

  // The dropped reading is not deleted — it is still a swipe, which is what
  // keeps its per-candidate records (`iris_usage`, the variable table)
  // addressable. Upstream's regenerate really does splice it off `chat`; here
  // it survives as an alternate, and only the prompt leaves it out.
  const view = (await fixed.handlers['chat.open']({ chatId })).view
  const last = view.messages[view.messages.length - 1]
  assert.equal(last?.text, 'SECOND-READING.')
  assert.deepEqual(last?.swipes, { count: 2, index: 1 })
  const entry = await fixed.chats.open(chatId)
  const line = entry.toFile().messages.at(-1) as { swipes?: string[] }
  assert.deepEqual(line.swipes, ['FIRST-READING.', 'SECOND-READING.'])
})

test('the next send after a reroll carries the whole conversation again', async (t) => {
  const fixed = await fixture(t, { replies: ['FIRST-READING.', 'SECOND-READING.', 'THIRD.'] })
  const chatId = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId

  await fixed.handlers['chat.send']({ chatId, text: 'Hello?' })
  await fixed.settled()
  await fixed.handlers['chat.regenerate']({ chatId })
  await fixed.settled()
  await fixed.handlers['chat.send']({ chatId, text: 'And then?' })
  await fixed.settled()

  // The projection belongs to the generation, not to the chat: the reply the
  // reroll produced is ordinary history for every request after it.
  const next = fixed.seen[fixed.seen.length - 1]
  assert.equal(whole(next).includes('SECOND-READING.'), true, 'the reroll’s own reply went missing')
  assert.equal(whole(next).includes('FIRST-READING.'), false, 'the swiped-away reading came back')
})

/**
 * A preset carrying its own utility prompts, the way a real one does.
 *
 * Both of the operator's presets tune these — a 456-character continue nudge
 * and a 457-character impersonation prompt in one of them — so the values here
 * stand in for real overrides rather than for a hypothetical.
 * @param fields - the utility fields this preset carries.
 * @returns the preset.
 */
function utilityPreset(fields: Record<string, unknown>): ChatCompletionPreset {
  return {
    ...fields,
    prompts: [
      { identifier: 'main', role: 'system', content: 'Main.' },
      { identifier: 'chatHistory', marker: true },
      { identifier: 'jailbreak', role: 'system', content: '' },
    ],
    prompt_order: [{
      character_id: GLOBAL_ORDER_ID,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: true },
      ],
    }],
  }
}

test('the continue nudge is the preset’s own text, not the shipped default', async (t) => {
  const fix = await fixture(t, {
    replies: ['A reply.', ' And more.'],
    preset: utilityPreset({ continue_nudge_prompt: '[CONTINUE MODE — PURE EXTENSION for {{char}}.]' }),
  })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['chat.send']({ chatId, text: 'Go on.' })
  await fix.settled()
  await fix.handlers['chat.send']({ chatId, kind: 'continue' })
  await fix.settled()

  const texts = textsOf(fix.seen[1])
  // The preset's words, with the turn's macros expanded — upstream runs the
  // nudge through `substituteParamsExtended` (`openai.js:902`).
  assert.equal(texts.at(-1), '[CONTINUE MODE — PURE EXTENSION for Aria.]')
  assert.equal(
    whole(fix.seen[1]).includes('without repeating its original content'),
    false,
    'the shipped default reached the request even though the preset overrode it',
  )
})

test('continue_prefill cancels the nudge entirely, as upstream’s guard does', async (t) => {
  const fix = await fixture(t, {
    replies: ['A reply.', ' And more.'],
    // The same preset text as above, so the only variable is the flag — a
    // control that fails if the nudge went missing for any other reason.
    preset: utilityPreset({
      continue_nudge_prompt: '[CONTINUE MODE — PURE EXTENSION for {{char}}.]',
      continue_prefill: true,
    }),
  })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['chat.send']({ chatId, text: 'Go on.' })
  await fix.settled()
  const sentCount = fix.seen[0]?.messages.length ?? 0
  await fix.handlers['chat.send']({ chatId, kind: 'continue' })
  await fix.settled()

  // No nudge at all: upstream's guard is
  // `type === 'continue' && cyclePrompt && !oai_settings.continue_prefill`
  // (`openai.js:898`). The request still happened, and still ends on the
  // conversation — the reply being continued.
  assert.equal(whole(fix.seen[1]).includes('CONTINUE MODE'), false, 'the nudge survived continue_prefill')
  assert.equal(fix.seen.length, 2, 'the continue never reached the provider')
  assert.equal(textsOf(fix.seen[1]).at(-1)?.startsWith('A reply.'), true)
  // And it is shorter than the send by exactly the message the nudge would have
  // been, which is what makes the absence a measurement rather than a guess.
  assert.equal(fix.seen[1]?.messages.length, sentCount)
})

test('a blank continue_nudge_prompt sends nothing, and an absent one sends the default', async (t) => {
  const blank = await fixture(t, {
    replies: ['A reply.', ' And more.'],
    preset: utilityPreset({ continue_nudge_prompt: '' }),
  })
  const chatId = (await blank.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await blank.handlers['chat.send']({ chatId, text: 'Go on.' })
  await blank.settled()
  await blank.handlers['chat.send']({ chatId, kind: 'continue' })
  await blank.settled()
  // Upstream treats an emptied field as a deleted instruction, not as a request
  // for the default (`openai.js:1362` guards the impersonation prompt the same
  // way). Falling back here would put back words the user removed.
  assert.equal(whole(blank.seen[1]).includes('[Continue'), false, 'a blanked nudge fell back to the default')

  const absent = await fixture(t, {
    replies: ['A reply.', ' And more.'],
    preset: utilityPreset({}),
  })
  const other = (await absent.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await absent.handlers['chat.send']({ chatId: other, text: 'Go on.' })
  await absent.settled()
  await absent.handlers['chat.send']({ chatId: other, kind: 'continue' })
  await absent.settled()
  assert.equal(
    textsOf(absent.seen[1]).at(-1),
    '[Continue your last message without repeating its original content.]',
    'an absent key must still get upstream’s shipped default',
  )
})

test('the impersonation prompt is the preset’s own text', async (t) => {
  const fix = await fixture(t, {
    replies: ['A reply.', 'I look around.'],
    preset: utilityPreset({ impersonation_prompt: '[IMPERSONATION MODE for {{user}} — ABSOLUTE OVERRIDE]' }),
  })
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['chat.send']({ chatId, text: 'Go on.' })
  await fix.settled()
  await fix.handlers['chat.send']({ chatId, kind: 'impersonate' })
  await fix.settled()

  assert.equal(textsOf(fix.seen[1]).at(-1), '[IMPERSONATION MODE for Traveller — ABSOLUTE OVERRIDE]')
  assert.equal(
    whole(fix.seen[1]).includes('using the chat history so far as a guideline'),
    false,
    'the shipped default reached the request even though the preset overrode it',
  )
  // Still a system message: the role is the instruction's authority
  // (`openai.js:1373` builds it role system).
  assert.equal(fix.seen[1]?.messages.at(-1)?.role, 'system')
})
