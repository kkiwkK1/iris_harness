import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CharacterCard } from '@iris/character'
import type { ChatView, IrisEvent, RegexScriptView } from '@iris/protocol'
import type { RegexScript } from '@iris/regex'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ExtensionSettingsStore } from '../src/context.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { scriptsOf } from '../src/regex.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * The global regex tier.
 *
 * Upstream keeps the user's own scripts at `extension_settings.regex` and runs
 * them against every conversation, before anything the character ships
 * (`extensions/regex/engine.js`: `getScriptsByType(SCRIPT_TYPES.GLOBAL)`
 * returns `extension_settings.regex ?? []`). The engine-side ordering is
 * already pinned in `@iris/regex`'s own tests; what is pinned here is the two
 * things this host adds — the profile-level store that keeps the list
 * **verbatim** (a script exported from an install must survive a round trip),
 * and the wiring that puts the tier in front of the card's on all three
 * directions of an open conversation, including one that was already open when
 * the list was edited.
 */

/** A V2 card file, with whatever the test needs layered on. */
function cardFile(extensions: Record<string, unknown> = {}): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria', description: '', personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1', extensions,
    },
  })
}

/** A stream that replies with scripted text, one script per call. */
function scriptedStream(replies: readonly string[], seen?: GenerateOptions[]): StreamFn {
  let call = 0
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen?.push(_options)
    const text = replies[Math.min(call, replies.length - 1)] ?? ''
    call += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
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

/** Everything one test needs, over a throwaway data folder holding one card. */
async function fixture(t: TestContext, options: {
  card?: string
  replies?: readonly string[]
  seen?: GenerateOptions[]
} = {}): Promise<{
  dir: string
  handlers: Handlers
  store: ExtensionSettingsStore
  chats: ChatStore
  sink: ReturnType<typeof collector>
  chatId: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-regex-'))
  // `maxRetries`, the tidy-up hardening `card-storage.test.ts` documents for
  // the Windows window 2b43efc found: a write can land a moment after the
  // last assertion, and a bare `rm` then fails the whole file with ENOTEMPTY.
  // Seen on full-suite runs after the atomic-write change of 2026-09-11,
  // which replaced one write syscall per save with a write and a rename.
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), options.card ?? cardFile(), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const store = new ExtensionSettingsStore(join(dir, 'extension-settings.json'))
  const chats = new ChatStore(
    join(dir, 'chats'), library,
    undefined, undefined, undefined,
    () => [], undefined,
    // No persona store in this fixture: the `{{persona}}` slot expands empty.
    undefined,
    // The provider the real host passes: a live read, not a snapshot.
    () => store.globalRegex(),
  )
  const sink = collector()
  const handlers = new IrisAppService({
    stream: scriptedStream(options.replies ?? ['*She looks up.* Hello.'], options.seen),
    library, chats,
    extensionSettings: store,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: sink.broadcast,
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  return { dir, handlers, store, chats, sink, chatId: created.view.chatId }
}

/** The last message of a view. */
function last(view: ChatView): ChatView['messages'][number] {
  const message = view.messages[view.messages.length - 1]
  assert.ok(message !== undefined, 'the view has no messages')
  return message
}

/** Every text block of an assembled request, joined. */
function promptText(options: GenerateOptions): string {
  return [
    options.system ?? '',
    ...options.messages.map(message =>
      message.content.filter(block => block.type === 'text').map(block => block.text).join('')),
  ].join('\n')
}

// ── the store ───────────────────────────────────────────────────────────────

test('the global list round-trips verbatim, unknown fields included', async (t) => {
  const { store } = await fixture(t)
  // The shape an ST export carries, including keys this host has never heard
  // of — exactly what a lossy store would drop.
  const script = {
    id: '0a67b2e1-0000-4000-8000-000000000001',
    scriptName: 'from an install',
    findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/g',
    replaceString: '',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
    'some-future-key': { nested: [1, 2, 3] },
  } as unknown as RegexScriptView

  await store.setGlobalRegex([script])
  assert.deepEqual(await store.globalRegex(), [script], 'the read-back equals what was written')
})

test('the global list survives a restart of the host', async (t) => {
  const { dir, store } = await fixture(t)
  await store.setGlobalRegex([{
    scriptName: 'kept', findRegex: '/x/g', replaceString: 'y', placement: [2],
  }])

  // A fresh store over the same file, as a second host start would be.
  const reloaded = new ExtensionSettingsStore(join(dir, 'extension-settings.json'))
  const scripts = await reloaded.globalRegex()
  assert.equal(scripts.length, 1)
  assert.equal(scripts[0]?.scriptName, 'kept')
})

test('an install that never stored regex reads as empty, not as an error', async (t) => {
  const { store } = await fixture(t)
  assert.deepEqual(await store.globalRegex(), [])
})

// ── composition ─────────────────────────────────────────────────────────────

test('global scripts compose before the card’s own', () => {
  const global: RegexScript = { scriptName: 'g', findRegex: '/A/g', replaceString: 'B', placement: [2] }
  const card = JSON.parse(cardFile({
    regex_scripts: [{ scriptName: 'c', findRegex: '/B/g', replaceString: 'C', placement: [2] }],
  })) as CharacterCard

  // Global first is the difference between C and B: the card's B-rule only
  // finds anything to match because the global A-rule ran before it.
  assert.equal(scriptsOf(card, [global]).length, 2)
  assert.deepEqual(
    scriptsOf(card, [global]).map(script => script.replaceString),
    ['B', 'C'],
  )
  // And the empty tier is exactly what the one-tier call always returned.
  assert.deepEqual(scriptsOf(undefined, []).map(script => script.replaceString), [])
})

// ── the wire surface ────────────────────────────────────────────────────────

test('a fresh host lists no global scripts', async (t) => {
  const { handlers } = await fixture(t)
  assert.deepEqual((await handlers['regex.list']({})).scripts, [])
})

test('regex.set stores the list, minting ids where the import has none', async (t) => {
  const { handlers, store } = await fixture(t)
  const answer = await handlers['regex.set']({
    scripts: [
      { scriptName: 'first', findRegex: '/a/g', replaceString: 'b', placement: [2] },
      { id: 'kept-id', scriptName: 'second', findRegex: '/c/g', replaceString: 'd', placement: [1] },
    ],
  })

  assert.equal(answer.scripts.length, 2)
  assert.ok(answer.scripts[0]?.id !== undefined, 'the import without an id was given one')
  assert.equal(answer.scripts[1]?.id, 'kept-id', 'the id that arrived was kept')
  assert.deepEqual(await store.globalRegex(), answer.scripts)
  // Array order is run order inside the tier; it is data, not an accident.
  assert.deepEqual(answer.scripts.map(script => script.scriptName), ['first', 'second'])
})

// ── the pipeline ────────────────────────────────────────────────────────────

test('a global script rewrites what the reader sees, and only that', async (t) => {
  const reply = '络络笑了。\n<UpdateVariable>_.add("x", 1);</UpdateVariable>'
  const { handlers, sink, chatId, dir } = await fixture(t, { replies: [reply] })
  await handlers['regex.set']({
    scripts: [{
      scriptName: 'hide commands from the reader',
      findRegex: String.raw`/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g`,
      replaceString: '',
      placement: [2],
      markdownOnly: true,
    }],
  })

  await handlers['chat.send']({ chatId, text: '你好。' })
  const end = await sink.waitFor('stream.end')
  assert.equal(last(end.view).text, '络络笑了。\n', 'the reader sees prose, not machinery')

  // Hiding is not erasing: the file keeps the block, and it is the file an
  // export carries.
  const file = await readFile(join(dir, 'chats', `${chatId}.jsonl`), 'utf8')
  assert.match(file, /UpdateVariable/)
})

test('a global script rewrites what the model reads', async (t) => {
  const reply = '络络笑了。\n<UpdateVariable>_.set("x", 1);</UpdateVariable>'
  const seen: GenerateOptions[] = []
  const { handlers, sink, chatId } = await fixture(t, { replies: [reply], seen })
  await handlers['regex.set']({
    scripts: [{
      scriptName: 'strip commands from the prompt',
      findRegex: String.raw`/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g`,
      replaceString: '',
      placement: [2],
      promptOnly: true,
    }],
  })

  await handlers['chat.send']({ chatId, text: '你好。' })
  await sink.waitFor('stream.end')
  await handlers['chat.send']({ chatId, text: '再来。' })
  for (;;) {
    if (seen.length > 1) break
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  const second = seen[1]
  assert.ok(second !== undefined)
  assert.match(promptText(second), /络络笑了。/, 'the prose is in context')
  assert.doesNotMatch(promptText(second), /UpdateVariable/, 'the command block is not')
})

test('the tier order holds in the live pipeline: global feeds the card’s rule', async (t) => {
  // The card's rule turns B into C and cannot see A at all; only a global
  // script that ran first can produce the B it matches. The view showing C —
  // not B — is the whole proof.
  const { handlers, sink, chatId } = await fixture(t, {
    card: cardFile({
      regex_scripts: [{ scriptName: 'card rule', findRegex: '/B/g', replaceString: 'C', placement: [2], markdownOnly: true }],
    }),
    replies: ['A'],
  })
  await handlers['regex.set']({
    scripts: [{ scriptName: 'global rule', findRegex: '/A/g', replaceString: 'B', placement: [2], markdownOnly: true }],
  })

  await handlers['chat.send']({ chatId, text: '你好。' })
  const end = await sink.waitFor('stream.end')
  assert.equal(last(end.view).text, 'C', 'global ran first, the card’s rule ran on its output')
})

test('a permanent global script rewrites the stored message', async (t) => {
  const { handlers, sink, dir, chatId } = await fixture(t)
  await handlers['regex.set']({
    scripts: [{
      scriptName: 'typographic quotes',
      findRegex: String.raw`/"([^"]*)"/g`,
      replaceString: '“$1”',
      placement: [1, 2],
    }],
  })

  await handlers['chat.send']({ chatId, text: 'Say "hello".' })
  await sink.waitFor('stream.end')
  const file = await readFile(join(dir, 'chats', `${chatId}.jsonl`), 'utf8')
  assert.match(file, /Say “hello”\./, 'the user line is stored rewritten')
  assert.doesNotMatch(file, /"hello"/)
})

test('editing the list reaches a conversation that is already open', async (t) => {
  const reply = 'plain text'
  const { handlers, sink, chatId } = await fixture(t, { replies: [reply] })
  await handlers['chat.send']({ chatId, text: '你好。' })
  await sink.waitFor('stream.end')
  assert.equal(last((await handlers['chat.open']({ chatId })).view).text, 'plain text')

  // The chat stays open on the same cached entry; the edit must still land,
  // both on the re-announced view and on the entry's next read.
  await handlers['regex.set']({
    scripts: [{
      scriptName: 'mark it', findRegex: '/plain/g', replaceString: 'marked', placement: [2], markdownOnly: true,
    }],
  })
  // The settle of the send above also announced the chat; wait until the
  // announcement that carries the new list's text arrives.
  let event: { type: 'chat.updated', view: ChatView } | undefined
  for (;;) {
    event = sink.events.filter(entry => entry.type === 'chat.updated').at(-1) as
      | { type: 'chat.updated', view: ChatView }
      | undefined
    if (event !== undefined && last(event.view).text === 'marked text') break
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.ok(event !== undefined, 'the open chat was re-announced')

  const { view } = await handlers['chat.open']({ chatId })
  assert.equal(last(view).text, 'marked text')
})
