import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { branchTitle, ChatStore, stripBranchSuffix } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Branching, against SillyTavern's own semantics.
 *
 * Measured from `bookmarks.js` rather than assumed: the cut is inclusive
 * (`chat.slice(0, mesId + 1)`), a swipe id branches from an alternate
 * generation, the title strips an existing branch suffix before adding one, and
 * the parent records its children on the message they left from.
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

interface Fixture {
  dir: string
  handlers: Handlers
  chats: ChatStore
  settled: () => Promise<void>
}

async function fixture(t: TestContext, replies: readonly string[] = ['A reply.']): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-branch-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  let ends = 0
  let waited = 0

  const handlers = new IrisAppService({
    stream: scripted(replies),
    library,
    chats,
    settings,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  return {
    dir,
    handlers,
    chats,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/** A chat with a greeting, an exchange, and a second exchange. */
async function conversation(fix: Fixture): Promise<string> {
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await fix.handlers['chat.send']({ chatId, text: 'First question?' })
  await fix.settled()
  await fix.handlers['chat.send']({ chatId, text: 'Second question?' })
  await fix.settled()
  return chatId
}

test('a branch title strips an existing suffix instead of stacking them', () => {
  // Upstream removes the modern suffix and a legacy prefix before adding its
  // own, so branching a branch does not accumulate.
  assert.equal(stripBranchSuffix('Aria - Branch #3'), 'Aria')
  assert.equal(stripBranchSuffix('Branch #2 - Aria'), 'Aria')
  assert.equal(stripBranchSuffix('Aria'), 'Aria')

  const taken = new Set(['Aria - Branch #1'])
  assert.equal(branchTitle('Aria', title => taken.has(title)), 'Aria - Branch #2')
  assert.equal(branchTitle('Aria - Branch #1', title => taken.has(title)), 'Aria - Branch #2')
})

test('the cut is inclusive, and the parent is untouched', async (t) => {
  const fix = await fixture(t, ['First reply.', 'Second reply.'])
  const chatId = await conversation(fix)

  const before = (await fix.handlers['chat.open']({ chatId })).view
  assert.equal(before.messages.length, 5, 'greeting + two exchanges')

  // Branch at the first reply: index 2 of [greeting, user, reply, user, reply].
  const { view, chats } = await fix.handlers['chat.branch']({ chatId, id: 2 })

  assert.deepEqual(view.messages.map(message => message.text), ['Hello.', 'First question?', 'First reply.'])
  assert.equal(view.chatId !== chatId, true, 'a branch is a new conversation')
  assert.match(view.title, / - Branch #1$/u)

  // The parent keeps everything: branching is not truncation.
  const after = (await fix.handlers['chat.open']({ chatId })).view
  assert.equal(after.messages.length, 5)
  assert.equal(chats.length, 2)
})

test('the branch records its parent, in both Iris’s field and upstream’s', async (t) => {
  const fix = await fixture(t)
  const chatId = await conversation(fix)
  const parentTitle = (await fix.handlers['chat.open']({ chatId })).view.title

  const { view, chats } = await fix.handlers['chat.branch']({ chatId, id: 2 })
  const summary = chats.find(entry => entry.chatId === view.chatId)

  // The id, so a rename of the parent cannot break the link.
  assert.equal(summary?.parentChatId, chatId)

  // And upstream's own `chat_metadata.main_chat`, so a branch exported to
  // SillyTavern still knows where it came from.
  const file = await readFile(join(fix.dir, 'chats', `${view.chatId}.jsonl`), 'utf8')
  const header = JSON.parse(file.split('\n')[0] ?? '{}') as { chat_metadata?: Record<string, unknown> }
  assert.equal(header.chat_metadata?.['main_chat'], parentTitle)
})

test('the parent records the branch on the message it left from', async (t) => {
  const fix = await fixture(t)
  const chatId = await conversation(fix)

  const { view } = await fix.handlers['chat.branch']({ chatId, id: 2 })

  // Upstream writes the child's name into `chat[mesId].extra.branches`, which is
  // how a parent can show where its branches leave.
  const file = await readFile(join(fix.dir, 'chats', `${chatId}.jsonl`), 'utf8')
  const lines = file.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  const branchPoint = lines[3] as { extra?: { branches?: unknown } }
  assert.deepEqual(branchPoint.extra?.branches, [view.title])
})

test('branching from a swipe opens on that generation, not the one showing', async (t) => {
  const fix = await fixture(t, ['First take.', 'Second take.'])
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await fix.handlers['chat.send']({ chatId, text: 'Hello?' })
  await fix.settled()
  await fix.handlers['chat.regenerate']({ chatId })
  await fix.settled()

  const current = (await fix.handlers['chat.open']({ chatId })).view
  assert.equal(current.messages[2]?.text, 'Second take.', 'the second take is the one showing')

  // This is what makes branching useful beside swipes: keep this reply here and
  // explore the other one over there.
  const { view } = await fix.handlers['chat.branch']({ chatId, id: 2, swipeId: 0 })

  assert.equal(view.messages[2]?.text, 'First take.')
  assert.equal((await fix.handlers['chat.open']({ chatId })).view.messages[2]?.text, 'Second take.')
})

test('a branch carries the variables attached to the messages it kept', async (t) => {
  const reply = "Noted.<UpdateVariable>_.set('mood', 'calm');</UpdateVariable>"
  const fix = await fixture(t, [reply])
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await fix.handlers['chat.send']({ chatId, text: 'Hello?' })
  await fix.settled()

  const parentVariables = (await fix.handlers['chat.open']({ chatId })).view.variables
  const { view } = await fix.handlers['chat.branch']({ chatId, id: 2 })

  // Per-candidate state travels with the message it belongs to, or a branch
  // would open with a status panel that silently reset.
  assert.deepEqual(view.variables, parentVariables)
})

test('an out-of-range message or swipe is refused', async (t) => {
  const fix = await fixture(t)
  const chatId = await conversation(fix)

  for (const params of [{ chatId, id: 99 }, { chatId, id: 2, swipeId: 7 }]) {
    await assert.rejects(
      () => fix.handlers['chat.branch'](params),
      (error: unknown) => (error as { code?: string }).code === 'invalid-request',
    )
  }
  await assert.rejects(
    () => fix.handlers['chat.branch']({ chatId: 'nope', id: 0 }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
})

test('a branch imported from SillyTavern is linked by its own lineage field', async (t) => {
  const fix = await fixture(t)
  await fix.chats.ensure()

  // Exactly the shape real SillyTavern data has: no `iris` block at all, and
  // the only lineage is `chat_metadata.main_chat` naming the parent chat. The
  // user's own library is all like this — `extra.branches` is absent from every
  // one of it, so a reader that only understood Iris's own field would show
  // these as unrelated conversations.
  const header = (name: string, mainChat?: string): string => JSON.stringify({
    user_name: 'Traveller',
    character_name: 'Aria',
    create_date: '2026-01-04 @10h00m00s',
    chat_metadata: mainChat === undefined ? {} : { main_chat: mainChat },
  })
  const line = JSON.stringify({ name: 'Aria', is_user: false, mes: 'Hello.' })
  const write = async (id: string, mainChat?: string): Promise<void> => {
    await writeFile(join(fix.dir, 'chats', `${id}.jsonl`), `${header(id, mainChat)}\n${line}\n`, 'utf8')
  }

  await write('Aria - 2026-01-04@10h00m00s')
  await write('Branch #6 - 2026-01-04@11h00m00s', 'Aria - 2026-01-04@10h00m00s')
  await write('Orphan - 2026-01-04@12h00m00s', 'a chat that is not here')

  const chats = await fix.chats.list()
  const child = chats.find(entry => entry.chatId.startsWith('Branch #6'))
  const orphan = chats.find(entry => entry.chatId.startsWith('Orphan'))

  assert.equal(child?.parentChatId, 'Aria - 2026-01-04@10h00m00s')
  // A name nothing answers to is left unlinked: a wrong parent is worse than none.
  assert.equal(orphan?.parentChatId, undefined)
})

test('the old prefix naming is stripped as well as the modern suffix', () => {
  // The user's real branches are the legacy `Branch #N - <timestamp>` form, and
  // upstream keeps a stripper for it precisely because that data still exists.
  assert.equal(stripBranchSuffix('Branch #6 - 2026-01-04@11h00m00s'), '2026-01-04@11h00m00s')
  assert.equal(branchTitle('Branch #6 - Aria', () => false), 'Aria - Branch #1')
})
