import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ChatView, IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * The application half, driven through its own handler table.
 *
 * Everything is asserted through the protocol surface rather than by reaching
 * into the log, because the log's shape is `@iris/chat`'s business and already
 * has its own tests. What is Iris-specific — that a send returns before the
 * reply exists, that a reroll starts from the same variable baseline the
 * discarded reply did, that an edit is not silently a swipe — only shows up
 * here.
 */

/** A V2 card file, with whatever the test needs layered on. */
function cardFile(data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria',
      description: 'A retired cartographer.',
      personality: '',
      scenario: '',
      first_mes: 'Hello, {{user}}.',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['maps'],
      creator: 'someone',
      character_version: '1',
      extensions: {},
      ...data,
    },
  })
}

/** A `[InitVar]` world book declaring the tree the model may change. */
const INIT_VAR_BOOK = {
  entries: [{
    keys: [],
    content: ['日期: ["03月15日", "今天的日期"]', '好感度: [10, "互动时更新"]'].join('\n'),
    enabled: true,
    insertion_order: 100,
    extensions: {},
    comment: '[InitVar]初始变量',
  }],
}

/** A stream that replies with scripted text, one script per call. */
function scriptedStream(replies: readonly string[], gate?: Promise<void>, seen?: GenerateOptions[]): StreamFn {
  let call = 0
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen?.push(_options)
    const text = replies[Math.min(call, replies.length - 1)] ?? ''
    call += 1
    if (gate !== undefined) await gate
    yield { type: 'block-start', index: 0, blockType: 'text' }
    // Several deltas, so a test can tell streaming from one lump of text.
    for (const piece of text.match(/[\s\S]{1,8}/g) ?? []) {
      yield { type: 'text-delta', index: 0, text: piece }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Collects pushed frames and lets a test wait for one. */
function collector(): {
  events: IrisEvent[]
  broadcast: (event: IrisEvent) => void
  waitFor: <T extends IrisEvent['type']>(type: T) => Promise<Extract<IrisEvent, { type: T }>>
} {
  const events: IrisEvent[] = []
  const waiters: { type: string, resolve: (event: IrisEvent) => void }[] = []

  return {
    events,
    broadcast(event) {
      events.push(event)
      for (const waiter of waiters.splice(0, waiters.length)) {
        if (waiter.type === event.type) waiter.resolve(event)
        else waiters.push(waiter)
      }
    },
    waitFor<T extends IrisEvent['type']>(type: T) {
      const existing = events.find(event => event.type === type)
      if (existing !== undefined) return Promise.resolve(existing as Extract<IrisEvent, { type: T }>)
      return new Promise<Extract<IrisEvent, { type: T }>>((resolve) => {
        waiters.push({ type, resolve: event => { resolve(event as Extract<IrisEvent, { type: T }>) } })
      })
    },
  }
}

/** Everything one test needs, over a throwaway data folder. */
interface Fixture {
  dir: string
  chats: ChatStore
  library: CharacterLibrary
  settings: SettingsStore
  service: IrisAppService
  handlers: Handlers
  sink: ReturnType<typeof collector>
}

/** Build a service over a fresh data folder holding one card. */
async function fixture(t: TestContext, options: {
  card?: string
  replies?: readonly string[]
  gate?: Promise<void>
  seen?: GenerateOptions[]
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-app-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })

  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), options.card ?? cardFile(), 'utf8')

  return { dir, ...await open(dir, options) }
}

/** Build a service over an existing data folder, as a restart would. */
async function open(dir: string, options: {
  replies?: readonly string[]
  gate?: Promise<void>
  seen?: GenerateOptions[]
} = {}): Promise<Omit<Fixture, 'dir'>> {
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  await settings.load()
  const sink = collector()

  const service = new IrisAppService({
    stream: scriptedStream(options.replies ?? ['*She looks up.* Hello.'], options.gate, options.seen),
    library,
    chats,
    settings,
    broadcast: sink.broadcast,
    userName: 'Traveller',
  })
  return { library, chats, settings, service, handlers: service.handlers(), sink }
}

/** The last message of a view. */
function last(view: ChatView): ChatView['messages'][number] {
  const message = view.messages[view.messages.length - 1]
  assert.ok(message !== undefined, 'the view has no messages')
  return message
}

test('the library lists a hand-dropped card by its filename', async (t) => {
  const { handlers } = await fixture(t)
  const { characters } = await handlers['character.list']({})

  assert.equal(characters.length, 1)
  assert.equal(characters[0]?.characterId, 'aria')
  assert.equal(characters[0]?.name, 'Aria')
  assert.deepEqual(characters[0]?.tags, ['maps'])
  // A `.json` card has no picture, so offering an avatar endpoint would 404.
  assert.equal(characters[0]?.avatarUrl, undefined)
})

test('a new chat opens on the greeting, with the alternates as its swipes', async (t) => {
  const { handlers } = await fixture(t, {
    card: cardFile({ alternate_greetings: ['A different opening.', 'A third.'] }),
  })

  const { view } = await handlers['chat.create']({ characterId: 'aria' })

  assert.equal(view.messages.length, 1)
  assert.equal(view.messages[0]?.role, 'assistant')
  assert.equal(view.messages[0]?.text, 'Hello, Traveller.', '{{user}} is expanded in the greeting')
  assert.deepEqual(view.messages[0]?.swipes, { count: 3, index: 0 }, 'first_mes is the one showing')
  assert.equal(view.characterId, 'aria')
})

test('a send resolves when the turn opens, not when the reply is finished', async (t) => {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { handlers, sink, chats } = await fixture(t, { gate })

  const { view } = await handlers['chat.create']({ characterId: 'aria' })
  const { turn } = await handlers['chat.send']({ chatId: view.chatId, text: 'Hello?' })

  assert.equal(turn, 1, 'the greeting was turn 0')
  assert.equal(sink.events.some(event => event.type === 'stream.start'), true)
  assert.equal(sink.events.some(event => event.type === 'stream.end'), false, 'nothing has been generated yet')
  assert.equal(chats.cached(view.chatId)?.generating, true)

  release()
  const end = await sink.waitFor('stream.end')

  const deltas = sink.events.filter(event => event.type === 'stream.text').map(event => event.delta)
  assert.ok(deltas.length > 1, 'the reply arrives as deltas, not one lump')
  assert.equal(deltas.join(''), '*She looks up.* Hello.')
  assert.equal(end.turn, 1)
  assert.equal(last(end.view).text, '*She looks up.* Hello.')
  assert.equal(last(end.view).streaming, undefined, 'the settled view is not still streaming')
})

test('a second page opening mid-generation sees the partial reply', async (t) => {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { handlers, sink } = await fixture(t, { gate })

  const created = await handlers['chat.create']({ characterId: 'aria' })
  await handlers['chat.send']({ chatId: created.view.chatId, text: 'Hello?' })
  release()
  await sink.waitFor('stream.text')

  const { view } = await handlers['chat.open']({ chatId: created.view.chatId })
  const streaming = last(view)
  assert.equal(streaming.streaming, true)
  assert.equal(streaming.role, 'assistant')
  assert.ok(streaming.text.length > 0, 'the text generated so far is real host state')

  await sink.waitFor('stream.end')
})

test('a reroll becomes a swipe, and swiping back restores the earlier reply', async (t) => {
  const { handlers, sink } = await fixture(t, { replies: ['The first take.', 'The second take.'] })

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  await sink.waitFor('stream.end')

  await handlers['chat.regenerate']({ chatId })
  const second = await new Promise<ChatView>((resolve) => {
    // The first `stream.end` is already recorded, so wait for the next one.
    const seen = sink.events.filter(event => event.type === 'stream.end').length
    const poll = setInterval(() => {
      const ends = sink.events.filter(event => event.type === 'stream.end')
      if (ends.length > seen) {
        clearInterval(poll)
        resolve(ends[ends.length - 1]?.view as ChatView)
      }
    }, 1)
  })

  assert.equal(last(second).text, 'The second take.')
  assert.deepEqual(last(second).swipes, { count: 2, index: 1 })

  const { view } = await handlers['chat.swipe']({ chatId, turn: 1, index: 0 })
  assert.equal(last(view).text, 'The first take.')
  assert.deepEqual(last(view).swipes, { count: 2, index: 0 })
})

test('a reply’s variable updates belong to that generation', async (t) => {
  const first = ["络络笑了。<UpdateVariable>_.add('好感度[0]', 5);//愉快</UpdateVariable>"].join('')
  const second = ["络络皱眉。<UpdateVariable>_.add('好感度[0]', -3);//不快</UpdateVariable>"].join('')
  const { handlers, sink } = await fixture(t, {
    card: cardFile({ character_book: INIT_VAR_BOOK }),
    replies: [first, second],
  })

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: '你好。' })
  const afterFirst = await sink.waitFor('stream.end')

  const statOf = (view: ChatView): Record<string, unknown> =>
    (view.variables?.['stat_data'] ?? {}) as Record<string, unknown>
  assert.deepEqual(statOf(afterFirst.view)['好感度'], [15, '互动时更新'], 'the world book declared 10, the reply added 5')

  // The reroll must start from the turn's baseline, not from the reply the user
  // is throwing away — otherwise a discarded generation's consequences stick.
  await handlers['chat.regenerate']({ chatId })
  const ends = async (): Promise<ChatView> => {
    for (;;) {
      const all = sink.events.filter(event => event.type === 'stream.end')
      if (all.length > 1) return all[all.length - 1]?.view as ChatView
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  }
  const afterSecond = await ends()
  assert.deepEqual(statOf(afterSecond)['好感度'], [7, '互动时更新'], '10 - 3, not 15 - 3')

  // Swiping back restores the first reply's own state.
  const swiped = await handlers['chat.swipe']({ chatId, turn: 1, index: 0 })
  assert.deepEqual(statOf(swiped.view)['好感度'], [15, '互动时更新'])
})

test('editing a message rewrites it in place instead of adding a swipe', async (t) => {
  const { handlers, sink } = await fixture(t, { replies: ['The first take.', 'The second take.'] })

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  await sink.waitFor('stream.end')
  await handlers['chat.regenerate']({ chatId })
  for (;;) {
    if (sink.events.filter(event => event.type === 'stream.end').length > 1) break
    await new Promise(resolve => setTimeout(resolve, 1))
  }

  const { view } = await handlers['chat.editMessage']({ chatId, id: 2, text: 'The edited take.' })

  assert.equal(last(view).text, 'The edited take.')
  assert.deepEqual(last(view).swipes, { count: 2, index: 1 }, 'the swipe count is unchanged')

  // Editing the user's own message works the same way.
  const edited = await handlers['chat.editMessage']({ chatId, id: 1, text: 'Good evening?' })
  assert.equal(edited.view.messages[1]?.text, 'Good evening?')
  assert.equal(edited.view.messages[1]?.role, 'user')
})

test('deleting a message removes only that one', async (t) => {
  const { handlers, sink } = await fixture(t)

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  await sink.waitFor('stream.end')

  const before = (await handlers['chat.open']({ chatId })).view
  assert.deepEqual(before.messages.map(message => message.role), ['assistant', 'user', 'assistant'])

  const { view } = await handlers['chat.deleteMessage']({ chatId, id: 1 })
  assert.deepEqual(view.messages.map(message => message.text), ['Hello, Traveller.', '*She looks up.* Hello.'])

  await assert.rejects(
    () => handlers['chat.deleteMessage']({ chatId, id: 9 }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
})

test('a chat survives a restart with its messages and its variables', async (t) => {
  const reply = "好的。<UpdateVariable>_.add('好感度[0]', 5);//愉快</UpdateVariable>"
  const { dir, handlers, sink } = await fixture(t, {
    card: cardFile({ character_book: INIT_VAR_BOOK }),
    replies: [reply],
  })

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: '你好。' })
  await sink.waitFor('stream.end')

  // A second service over the same folder is exactly what a restart is.
  const restarted = await open(dir)
  const { view } = await restarted.handlers['chat.open']({ chatId })

  assert.deepEqual(view.messages.map(message => message.role), ['assistant', 'user', 'assistant'])
  assert.equal(last(view).text, reply)
  const stat = (view.variables?.['stat_data'] ?? {}) as Record<string, unknown>
  assert.deepEqual(stat['好感度'], [15, '互动时更新'], 'MVU state is not reset by a reload')

  const { chats } = await restarted.handlers['chat.list']({})
  assert.equal(chats.length, 1)
  assert.equal(chats[0]?.chatId, chatId)
  assert.equal(chats[0]?.messageCount, 3)
})

test('the chat file is SillyTavern’s own format', async (t) => {
  const { dir, handlers, sink } = await fixture(t)

  const created = await handlers['chat.create']({ characterId: 'aria' })
  await handlers['chat.send']({ chatId: created.view.chatId, text: 'Hello?' })
  await sink.waitFor('stream.end')

  const text = await readFile(join(dir, 'chats', `${created.view.chatId}.jsonl`), 'utf8')
  const lines = text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)

  assert.equal(lines[0]?.['character_name'], 'Aria')
  assert.equal(lines[0]?.['user_name'], 'Traveller')
  assert.equal(lines[2]?.['is_user'], true)
  assert.equal(lines[3]?.['is_user'], false)
  assert.deepEqual(lines[3]?.['swipes'], ['*She looks up.* Hello.'])
  assert.equal(lines[3]?.['swipe_id'], 0)
})

test('a chat already generating refuses a second send', async (t) => {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { handlers, sink } = await fixture(t, { gate })

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })

  await assert.rejects(
    () => handlers['chat.send']({ chatId, text: 'Again?' }),
    (error: unknown) => (error as { code?: string }).code === 'busy',
  )
  await assert.rejects(
    () => handlers['chat.editMessage']({ chatId, id: 0, text: 'nope' }),
    (error: unknown) => (error as { code?: string }).code === 'busy',
  )

  release()
  await sink.waitFor('stream.end')
})

test('a chat with nothing to reroll says so rather than inventing a turn', async (t) => {
  const { handlers } = await fixture(t, { card: cardFile({ first_mes: '', alternate_greetings: [] }) })
  const created = await handlers['chat.create']({ characterId: 'aria' })

  await assert.rejects(
    () => handlers['chat.regenerate']({ chatId: created.view.chatId }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
})

test('per-chat settings override the global ones without replacing them', async (t) => {
  const { handlers } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['settings.set']({ settings: { temperature: 0.7, model: 'global-model' } })
  const scoped = await handlers['settings.set']({ chatId, settings: { temperature: 1.2 } })

  assert.equal(scoped.settings.temperature, 1.2)
  assert.equal(scoped.settings.model, 'global-model', 'the global layer still shows through')
  assert.equal((await handlers['settings.get']({})).settings.temperature, 0.7, 'the global default is intact')
})

test('an unknown chat or character is not found rather than a crash', async (t) => {
  const { handlers } = await fixture(t)

  for (const call of [
    () => handlers['chat.open']({ chatId: 'nope' }),
    () => handlers['chat.delete']({ chatId: 'nope' }),
    () => handlers['chat.create']({ characterId: 'nobody' }),
    () => handlers['character.delete']({ characterId: 'nobody' }),
  ]) {
    await assert.rejects(call, (error: unknown) => (error as { code?: string }).code === 'not-found')
  }

  // A traversal attempt is refused before it reaches the filesystem.
  await assert.rejects(
    () => handlers['chat.open']({ chatId: '../settings' }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
})

test('the estimate is corrected by what the provider actually charged', async (t) => {
  const { handlers, sink, service } = await fixture(t)

  assert.equal(service.calibration.samples, 0)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  await handlers['chat.send']({ chatId: created.view.chatId, text: 'Hello?' })
  await sink.waitFor('stream.end')

  // The `usage` chunk carries the real prompt size for the request just
  // estimated — the only signal that converges a character-class estimator.
  assert.equal(service.calibration.samples, 1)
  assert.notEqual(service.calibration.scale, 1)
})

/** A stream that emits a prefix and then hangs until the turn is aborted. */
function stallingStream(prefix: string): StreamFn {
  return async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: prefix }
    await new Promise<void>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => { reject(new Error('the turn was aborted')) }, { once: true })
    })
  }
}

/** A stream that fails the way a provider does: a terminal error finish. */
function failingStream(): StreamFn {
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'the endpoint returned 503', code: 'TRANSPORT', status: 503 } },
    }
  }
}

test('aborting a turn keeps what the model had already written', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-app-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), cardFile(), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const sink = collector()
  const service = new IrisAppService({
    stream: stallingStream('*She opens her mouth to'),
    library,
    chats,
    settings,
    broadcast: sink.broadcast,
    userName: 'Traveller',
  })
  const handlers = service.handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  await sink.waitFor('stream.text')

  await handlers['chat.abort']({ chatId })
  const end = await sink.waitFor('stream.end')

  // Upstream keeps a stopped reply, and throwing away half a message the user
  // decided was good enough is worse than the interruption itself.
  assert.equal(last(end.view).text, '*She opens her mouth to')
  assert.equal(chats.cached(chatId)?.generating, false)
  assert.equal(sink.events.some(event => event.type === 'stream.error'), false)
})

test('a provider failure is reported and the user’s message survives', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-app-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), cardFile(), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const sink = collector()
  const handlers = new IrisAppService({
    stream: failingStream(),
    library,
    chats,
    settings,
    broadcast: sink.broadcast,
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })

  const failure = await sink.waitFor('stream.error')
  assert.equal(failure.code, 'provider-error')
  assert.match(failure.message, /503/)

  // Retrying is only meaningful if what the user typed is still there.
  const { view } = await handlers['chat.open']({ chatId })
  assert.equal(last(view).role, 'user')
  assert.equal(last(view).text, 'Hello?')
  assert.equal(chats.cached(chatId)?.generating, false)
})

/**
 * The two scripts an MVU card actually ships: one hides the command block from
 * the reader, the other hides it from the model. Between them they are the
 * difference between a working card and a chat full of raw commands that the
 * model then starts imitating.
 */
const MVU_SCRIPTS = [
  {
    scriptName: 'hide UpdateVariable in chat',
    findRegex: String.raw`/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g`,
    replaceString: '',
    placement: [2],
    markdownOnly: true,
  },
  {
    scriptName: 'strip UpdateVariable from the prompt',
    findRegex: String.raw`/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g`,
    replaceString: '',
    placement: [2],
    promptOnly: true,
  },
]

/** Every text block of an assembled request, joined. */
function promptText(options: GenerateOptions): string {
  return [
    options.system ?? '',
    ...options.messages.map(message =>
      message.content.filter(block => block.type === 'text').map(block => block.text).join('')),
  ].join('\n')
}

test('a card’s regex scripts hide the command block from the reader and the model', async (t) => {
  const reply = "络络笑了。\n<UpdateVariable>\n_.add('好感度[0]', 5);//愉快\n</UpdateVariable>"
  const seen: GenerateOptions[] = []
  const { dir, handlers, sink } = await fixture(t, {
    card: cardFile({ character_book: INIT_VAR_BOOK, extensions: { regex_scripts: MVU_SCRIPTS } }),
    replies: [reply],
    seen,
  })

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: '你好。' })
  const end = await sink.waitFor('stream.end')

  // The reader sees the prose, not the machinery. The host does this, so every
  // page agrees and the browser needs no regex engine of its own.
  assert.equal(last(end.view).text, '络络笑了。\n')
  assert.doesNotMatch(last(end.view).text, /UpdateVariable/)

  // The commands still ran, and the chat file still has them: hiding is not
  // erasing, and the on-disk history is what an export carries.
  const stat = (end.view.variables?.['stat_data'] ?? {}) as Record<string, unknown>
  assert.deepEqual(stat['好感度'], [15, '互动时更新'])
  const file = await readFile(join(dir, 'chats', `${chatId}.jsonl`), 'utf8')
  assert.match(file, /UpdateVariable/)

  // The next request must not carry the previous turn's command block, or the
  // model starts writing commands back at itself.
  await handlers['chat.send']({ chatId, text: '再来。' })
  for (;;) {
    if (seen.length > 1) break
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  const second = seen[1]
  assert.ok(second !== undefined)
  assert.match(promptText(second), /络络笑了。/, 'the prose is still in context')
  assert.doesNotMatch(promptText(second), /UpdateVariable/, 'the command block is not')
})

test('a script marked neither way rewrites the message as it is stored', async (t) => {
  const permanent = [{
    scriptName: 'normalise the quotes',
    findRegex: String.raw`/"([^"]*)"/g`,
    replaceString: '“$1”',
    placement: [1, 2],
  }]
  const { dir, handlers, sink } = await fixture(t, {
    card: cardFile({ extensions: { regex_scripts: permanent } }),
    replies: ['She said "hello".'],
  })

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Say "hello".' })
  const end = await sink.waitFor('stream.end')

  // Both directions of a permanent script change the message itself, so the
  // rewritten form is what the view, the file and every later prompt all see.
  assert.equal(end.view.messages[1]?.text, 'Say “hello”.')
  assert.equal(last(end.view).text, 'She said “hello”.')

  const file = await readFile(join(dir, 'chats', `${chatId}.jsonl`), 'utf8')
  assert.match(file, /She said “hello”\./)
  assert.doesNotMatch(file, /"hello"/)
})

test('a chat with no scripts is left exactly as it was', async (t) => {
  const reply = 'Plain text with <UpdateVariable>_.set("x", 1);</UpdateVariable> left in.'
  const { handlers, sink } = await fixture(t, { replies: [reply] })

  const created = await handlers['chat.create']({ characterId: 'aria' })
  await handlers['chat.send']({ chatId: created.view.chatId, text: 'Hello?' })
  const end = await sink.waitFor('stream.end')

  assert.equal(last(end.view).text, reply)
})
