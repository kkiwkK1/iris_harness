import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ExtensionSettingsStore } from '../src/context.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, injectedContributions, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * The five bridge methods, end to end through the handler table.
 *
 * These are what a card script reaches the host with. The wire shape is frozen,
 * so what is worth guarding here is the behaviour behind it: that a card gets a
 * copy rather than a handle, that one card's settings partition is not another's,
 * that a keyed injection replaces rather than accumulates, and that `generateRaw`
 * leaves no trace in the conversation.
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

/** A stream that answers with one scripted reply and records what it was asked. */
function scripted(replies: readonly string[], seen?: GenerateOptions[]): StreamFn {
  let call = 0
  return async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen?.push(options)
    const text = replies[Math.min(call, replies.length - 1)] ?? ''
    call += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Everything one test needs, over a throwaway data folder. */
interface Fixture {
  dir: string
  handlers: Handlers
  chats: ChatStore
  extensionSettings: ExtensionSettingsStore
  seen: GenerateOptions[]
  settled: () => Promise<void>
}

async function fixture(t: TestContext, replies: readonly string[] = ['A reply.']): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-bridge-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const extensionSettings = new ExtensionSettingsStore(join(dir, 'extension-settings.json'))
  const seen: GenerateOptions[] = []
  let ends = 0
  let waited = 0

  const handlers = new IrisAppService({
    stream: scripted(replies, seen),
    library,
    chats,
    settings,
    extensionSettings,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  return {
    dir,
    handlers,
    chats,
    extensionSettings,
    seen,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/** One run for every injection in this file: the subject here is not run identity. */
const RUN = 'chat:1'

test('a card reads its chat through the frozen context shape', async (t) => {
  const { handlers } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  const { context } = await handlers['script.context']({ chatId, characterId: 'aria' })

  assert.equal(context.name1, 'Traveller')
  assert.equal(context.name2, 'Aria')
  assert.equal(context.chatId, chatId)
  assert.equal(context.characterId, 'aria')
  // Upstream's field names and message shape, so the browser bridge is a
  // pass-through with no translation table to drift.
  assert.equal(context.chat[0]?.mes, 'Hello.')
  assert.equal(context.chat[0]?.is_user, false)
  assert.deepEqual(context.characters.map(entry => entry.characterId), ['aria'])
})

test('metadata a card writes survives, and a key it dropped stays dropped', async (t) => {
  const { handlers, dir } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['script.saveMetadata']({ chatId, metadata: { phone: { unread: 2 }, stale: true } })
  const second = await handlers['script.saveMetadata']({ chatId, metadata: { phone: { unread: 0 } } })

  // Whole-object, matching upstream: the card mutated what it was handed and a
  // key it deleted is meant to be gone, not merged back in.
  assert.deepEqual(second.metadata, { phone: { unread: 0 } })

  const reopened = await handlers['script.context']({ chatId, characterId: 'aria' })
  assert.deepEqual(reopened.context.chatMetadata, { phone: { unread: 0 } })

  // And it is on disk, not just in memory: a card's store has to survive the
  // process, or every restart silently resets whatever it was keeping.
  const file = await readFile(join(dir, 'chats', `${chatId}.jsonl`), 'utf8')
  const header = JSON.parse(file.split('\n')[0] ?? '{}') as { chat_metadata?: unknown }
  assert.deepEqual(header.chat_metadata, { phone: { unread: 0 } })
})

test('a card cannot hand back something the chat file could not hold', async (t) => {
  const { handlers } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })

  await assert.rejects(
    () => handlers['script.saveMetadata']({
      chatId: created.view.chatId,
      metadata: { when: Number.POSITIVE_INFINITY },
    }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
})

test('one card’s settings partition is not another’s', async (t) => {
  const { handlers, extensionSettings } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await extensionSettings.set('aria', { theme: 'dark' })
  await extensionSettings.set('someone-else', { theme: 'light', secret: 'not yours' })

  const { context } = await handlers['script.context']({ chatId, characterId: 'aria' })

  // The partition is what makes a per-card grant mean anything.
  assert.deepEqual(context.extensionSettings, { theme: 'dark' })
})

test('a keyed injection replaces its own text rather than accumulating', async (t) => {
  const { handlers, chats, seen, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['script.setExtensionPrompt']({
    chatId, key: 'status-bar', value: 'First version.', position: 'at-depth', depth: 0, runId: RUN,
  })
  await handlers['script.setExtensionPrompt']({
    chatId, key: 'status-bar', value: 'Second version.', position: 'at-depth', depth: 0, runId: RUN,
  })

  const entry = chats.cached(chatId)
  assert.ok(entry !== undefined)
  assert.equal(entry.extensionPrompts.size, 1, 'the same key overwrote rather than piling up')
  assert.deepEqual(injectedContributions(entry).map(item => item.text), ['Second version.'])

  // It really reaches the model.
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  await settled()
  const request = seen[0]
  assert.ok(request !== undefined)
  const sent = [request.system ?? '', ...request.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join(''))].join('\n')
  assert.match(sent, /Second version\./)
  assert.doesNotMatch(sent, /First version\./)
})

test('an empty injection clears the key, the way upstream removes one', async (t) => {
  const { handlers, chats } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['script.setExtensionPrompt']({
    chatId, key: 'status-bar', value: 'Something.', position: 'before', depth: 0, runId: RUN,
  })
  await handlers['script.setExtensionPrompt']({
    chatId, key: 'status-bar', value: '', position: 'before', depth: 0, runId: RUN,
  })

  assert.equal(chats.cached(chatId)?.extensionPrompts.size, 0)
})

test('generateRaw answers without leaving a trace in the conversation', async (t) => {
  const { handlers, seen, chats } = await fixture(t, ['A summary of things.'])
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  const before = created.view.messages.length

  const { text } = await handlers['script.generateRaw']({
    chatId,
    prompt: 'Summarize the chat.',
    systemPrompt: 'You summarize.',
  })

  assert.equal(text, 'A summary of things.')
  assert.equal(seen[0]?.system, 'You summarize.')

  // A side computation is not a turn: nothing appended, no candidate, no swipe.
  const after = (await handlers['chat.open']({ chatId })).view
  assert.equal(after.messages.length, before)
  assert.equal(chats.cached(chatId)?.generating, false)
})

test('a bridge call for a chat that does not exist is not found', async (t) => {
  const { handlers } = await fixture(t)

  for (const call of [
    () => handlers['script.context']({ chatId: 'nope', characterId: 'aria' }),
    () => handlers['script.saveChat']({ chatId: 'nope' }),
    () => handlers['script.saveMetadata']({ chatId: 'nope', metadata: {} }),
    () => handlers['script.generateRaw']({ chatId: 'nope', prompt: 'x' }),
  ]) {
    await assert.rejects(call, (error: unknown) => (error as { code?: string }).code === 'not-found')
  }
})

test('a slash pipeline is parsed once, in the host', async (t) => {
  const { handlers, chats, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // The browser forwards the string verbatim; the escape rule has exactly one
  // implementation, so a `|` a user typed cannot be split differently by the
  // two halves.
  const { result } = await handlers['script.slash']({ chatId, command: '/send 你好|/trigger' })
  await settled()

  assert.equal(result, '')
  const view = (await handlers['chat.open']({ chatId })).view
  assert.equal(view.messages[1]?.text, '你好')
  assert.equal(view.messages[1]?.role, 'user')
  assert.equal(chats.cached(chatId)?.generating, false)
})

test('a lone /send is refused rather than quietly generating', async (t) => {
  const { handlers } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })

  // `/send` without `/trigger` means insert *without* generating. Treating it
  // as the pair would start a generation the card explicitly did not ask for,
  // and spend the user's tokens doing it — doing more silently is worse than
  // doing less.
  await assert.rejects(
    () => handlers['script.slash']({ chatId: created.view.chatId, command: '/send 你好' }),
    (error: unknown) => (error as { code?: string }).code === 'unsupported',
  )
})

test('a lone /trigger replies to the newest line, as the send button does', async (t) => {
  const { handlers, chats, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // The measured call shape (新·架空政治经济模拟器's 建国控制台): a card
  // appends its own user line — which appends *without* generating, by design —
  // then asks for the reply with `/trigger` alone.
  await handlers['script.createChatMessages']({
    chatId,
    messages: [{ name: 'Traveller', is_user: true, mes: '请回复：连接正常。' }],
  })
  const { result } = await handlers['script.slash']({ chatId, command: '/trigger' })
  await settled()

  assert.equal(result, '')
  const view = (await handlers['chat.open']({ chatId })).view
  assert.equal(view.messages[1]?.role, 'user')
  assert.equal(view.messages[1]?.text, '请回复：连接正常。')
  // The reply landed on the turn that user line opened — not as a new turn,
  // and not as a second swipe of the greeting.
  assert.equal(view.messages[2]?.role, 'assistant')
  assert.equal(view.messages[2]?.text, 'A reply.')
  assert.equal(view.messages[2]?.turn, view.messages[1]?.turn)
  assert.equal(chats.cached(chatId)?.generating, false)
})

test('a /trigger while a generation is already running is refused as busy', async (t) => {
  const { handlers, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  void handlers['chat.send']({ chatId, text: 'first' })
  await assert.rejects(
    () => handlers['script.slash']({ chatId, command: '/trigger' }),
    (error: unknown) => (error as { code?: string }).code === 'busy',
  )
  await settled()
})

test('an unimplemented command is refused by name', async (t) => {
  const { handlers } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })

  await assert.rejects(
    () => handlers['script.slash']({ chatId: created.view.chatId, command: '/setvar x 1' }),
    (error: unknown) => /\/setvar/.test((error as Error).message),
  )
})

test('each writer keeps its own merge rule, on the host', async (t) => {
  const { handlers } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['script.setVariables']({
    chatId, scope: 'chat', op: 'replace',
    variables: { keep: 'original', list: [1, 2, 3] },
  })

  // insertOrAssign: the incoming value wins, and an array is replaced whole
  // rather than merged element-wise.
  const assigned = await handlers['script.setVariables']({
    chatId, scope: 'chat', op: 'insertOrAssign',
    variables: { keep: 'replaced', list: [9] },
  })
  assert.equal(assigned.variables['keep'], 'replaced')
  assert.deepEqual(assigned.variables['list'], [9])

  // insert: the existing value wins.
  const inserted = await handlers['script.setVariables']({
    chatId, scope: 'chat', op: 'insert',
    variables: { keep: 'ignored', fresh: 'added' },
  })
  assert.equal(inserted.variables['keep'], 'replaced')
  assert.equal(inserted.variables['fresh'], 'added')

  const deleted = await handlers['script.setVariables']({
    chatId, scope: 'chat', op: 'delete', path: 'fresh',
  })
  assert.equal('fresh' in deleted.variables, false)
})

test('a script’s variables are partitioned by script id', async (t) => {
  const { handlers } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['script.setVariables']({
    chatId, scope: 'script', scriptId: 'status-bar', op: 'replace', variables: { secret: 'mine' },
  })
  const other = await handlers['script.setVariables']({
    chatId, scope: 'script', scriptId: 'another', op: 'replace', variables: { own: 'theirs' },
  })

  // One card's script must not read another's bookkeeping.
  assert.deepEqual(other.variables, { own: 'theirs' })
  const mine = await handlers['script.setVariables']({
    chatId, scope: 'script', scriptId: 'status-bar', op: 'insert', variables: {},
  })
  assert.deepEqual(mine.variables, { secret: 'mine' })
})

test('a card cannot store through setVariables what the file could not hold', async (t) => {
  const { handlers } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })

  await assert.rejects(
    () => handlers['script.setVariables']({
      chatId: created.view.chatId, scope: 'chat', op: 'replace',
      variables: { when: Number.POSITIVE_INFINITY },
    }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
})

test('swipeTo addresses a message the way a card does', async (t) => {
  const { handlers, settled } = await fixture(t, ['First take.', 'Second take.'])
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  await settled()
  await handlers['chat.regenerate']({ chatId })
  await settled()

  assert.equal((await handlers['chat.open']({ chatId })).view.messages[2]?.text, 'Second take.')

  // messageId is the index a card script sees; the host maps it to the turn.
  const { view } = await handlers['script.swipeTo']({ chatId, messageId: 2, swipeIndex: 0 })
  assert.equal(view.messages[2]?.text, 'First take.')

  await assert.rejects(
    () => handlers['script.swipeTo']({ chatId, messageId: 99, swipeIndex: 0 }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
  await assert.rejects(
    () => handlers['script.swipeTo']({ chatId, messageId: 2, swipeIndex: 7 }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
})

test('swipeTo still answers for the greeting after the chat has moved on', async (t) => {
  /*
   * The measured card's opening-menu button addresses message 0 on a chat that
   * already has floors after it — `setChatMessages([{ message_id: 0,
   * swipe_id: 1 }])` lands here long after turn 1 exists. Refusing that because
   * turn 0 was "settled" was the SYSTEM START button that silently did nothing:
   * the card catches the rejection and logs it to its own console, so the user
   * saw a hint that never turned into a switch.
   */
  const { handlers, dir, settled } = await fixture(t, ['And then?'])
  await writeFile(join(dir, 'characters', 'menu.json'), JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Menu', description: '', personality: '', scenario: '',
      first_mes: '<开局>', mes_example: '', creator_notes: '',
      system_prompt: '', post_history_instructions: '',
      alternate_greetings: ['<介绍>', '<自定义>'],
      tags: [], creator: '', character_version: '1', extensions: {},
    },
  }), 'utf8')

  const created = await handlers['chat.create']({ characterId: 'menu' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  await settled()

  // Three floors: the greeting, the user's line, the reply. Turn 0 is not the
  // last turn any more — the exact shape the old guard refused.
  const before = (await handlers['chat.open']({ chatId })).view
  assert.equal(before.messages.length, 3)
  assert.equal(before.messages[0]?.text, '<开局>')

  const { view } = await handlers['script.swipeTo']({ chatId, messageId: 0, swipeIndex: 1 })
  assert.equal(view.messages[0]?.text, '<介绍>')
  // The later floors stay exactly where they were: one reply per turn, in order.
  assert.equal(view.messages.length, 3)
  assert.equal(view.messages[1]?.text, 'Hello?')
  assert.equal(view.messages[2]?.text, 'And then?')
})

test('getVariables reads back what each scope holds, and reads an empty scope as empty', async (t) => {
  const { handlers } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // Empty is a table, not an error: this is the read `updateVariablesWith`
  // makes before its first write, and a refusal there would break the writer
  // on a fresh chat.
  assert.deepEqual((await handlers['script.getVariables']({ chatId, scope: 'chat' })).variables, {})

  await handlers['script.setVariables']({
    chatId, scope: 'chat', op: 'replace', variables: { counted: 1 },
  })
  await handlers['script.setVariables']({
    chatId, scope: 'global', op: 'replace', variables: { elsewhere: true },
  })

  assert.deepEqual((await handlers['script.getVariables']({ chatId, scope: 'chat' })).variables, { counted: 1 })
  // The scopes stay separate on the way out, which is the property the read is
  // for: an updater applied to the wrong scope's table stores the wrong tree.
  assert.deepEqual((await handlers['script.getVariables']({ chatId, scope: 'global' })).variables, { elsewhere: true })
})

test('a script scope with no script id is refused over the wire too', async (t) => {
  const { handlers } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // Upstream throws 未指定 script_id in both directions
  // (`JS-Slash-Runner/src/function/variables.ts:85` and `:175`). Iris used to
  // invent an 'anonymous' partition here, which would have put every
  // unidentified caller's state in one shared table — and that table is now on
  // disk.
  for (const call of [
    () => handlers['script.getVariables']({ chatId, scope: 'script' }),
    () => handlers['script.setVariables']({ chatId, scope: 'script', op: 'replace', variables: { a: 1 } }),
  ]) {
    await assert.rejects(call, (error: unknown) => (error as { code?: string }).code === 'invalid-request')
  }

  // Named, it works — this is the shape the frame actually sends.
  const named = await handlers['script.setVariables']({
    chatId, scope: 'script', scriptId: 'panel', op: 'replace', variables: { a: 1 },
  })
  assert.deepEqual(named.variables, { a: 1 })
})
