import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { parseChatFile, type SillyTavernChat } from '@iris/persistence'

import { ChatStore, parseCreateDate } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Chat import and export — the SillyTavern migration path (checklist A3).
 *
 * The storage layer is already SillyTavern's own JSONL with tested round-trip
 * fidelity; what A3 adds is the carrying. Four acceptance points, each with a
 * test below:
 *
 * 1. every real chat on this machine imports floor-for-floor equivalent;
 * 2. an imported branch reports the parent `chat_metadata.main_chat` names, and
 *    both ends of that link open;
 * 3. an exported chat re-imports — here into a fresh store, and on the real
 *    install by hand — and a second export is byte-stable;
 * 4. a file that is not a SillyTavern chat is refused with a named reason and
 *    nothing written.
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
  const dir = await mkdtemp(join(tmpdir(), 'iris-transfer-'))
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

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

/** A header plus message lines, exactly as SillyTavern writes them. */
function chatFile(options: {
  character?: string
  user?: string
  mainChat?: string
  metadata?: Record<string, unknown>
  messages?: { name: string, is_user: boolean, mes: string, swipes?: string[], swipeId?: number, extra?: Record<string, unknown> }[]
  createDate?: string
}): string {
  const header: Record<string, unknown> = {
    user_name: options.user ?? 'Traveller',
    character_name: options.character ?? 'Aria',
    create_date: options.createDate ?? '2026-01-04 @10h00m00s000ms',
    chat_metadata: {
      note_prompt: '',
      ...(options.metadata ?? {}),
      ...(options.mainChat === undefined ? {} : { main_chat: options.mainChat }),
    },
  }
  const lines = (options.messages ?? []).map(message => ({
    name: message.name,
    is_user: message.is_user,
    is_system: false,
    send_date: '2026-01-04T10:01:00.000Z',
    mes: message.mes,
    ...(message.extra === undefined ? {} : { extra: message.extra }),
    ...(message.swipes === undefined ? {} : { swipes: message.swipes }),
    ...(message.swipeId === undefined ? {} : { swipe_id: message.swipeId }),
  }))
  return [header, ...lines].map(line => JSON.stringify(line)).join('\n') + '\n'
}

async function importText(
  fix: Fixture,
  filename: string,
  text: string,
  characterId = 'aria',
): Promise<unknown> {
  return fix.handlers['chat.import']({ filename, content: b64(text), characterId })
}

test('create_date reads back as the moment it names', () => {
  const parsed = parseCreateDate('2026-01-18 @05h53m21s771ms')
  assert.ok(parsed !== undefined)
  // Local time, matching how `formatCreateDate` writes the same field.
  const expected = new Date(2026, 0, 18, 5, 53, 21, 771).getTime()
  assert.equal(parsed, expected)
  assert.equal(parseCreateDate('2026-01-18 @05h53m21sms'), undefined, 'malformed is refused, not guessed')
  assert.equal(parseCreateDate('2026-01-19T07:39:07.890Z'), undefined, 'ISO is a different field')
})

test('an imported chat keeps every floor it arrived with', async (t) => {
  const fix = await fixture(t)
  const text = chatFile({
    messages: [
      { name: 'Aria', is_user: false, mes: 'Opening line.', swipes: ['Opening line.', 'Alternate opening.'], swipeId: 1 },
      { name: 'Traveller', is_user: true, mes: 'A question.', extra: { token_count: 12 } },
      { name: 'Aria', is_user: false, mes: 'An answer.', extra: { reasoning: 'weighed it' } },
    ],
  })

  const { chat } = await importText(fix, 'Aria - 2026-01-04@10h00m00s.jsonl', text) as {
    chat: { chatId: string, title: string, messageCount: number, characterId: string }
  }

  assert.equal(chat.chatId, 'Aria - 2026-01-04@10h00m00s', 'the file stem is the chat id')
  assert.equal(chat.title, 'Aria - 2026-01-04@10h00m00s')
  assert.equal(chat.characterId, 'aria')
  assert.equal(chat.messageCount, 3)

  // Stored on disk as SillyTavern's own shape, header fields verbatim.
  const stored = parseChatFile(await readFile(join(fix.dir, 'chats', `${chat.chatId}.jsonl`), 'utf8'))
  assert.equal(stored.header.user_name, 'Traveller')
  assert.equal(stored.header.character_name, 'Aria')
  assert.deepEqual(stored.messages.map(message => message.mes), ['Opening line.', 'A question.', 'An answer.'])

  const opened = await fix.handlers['chat.open']({ chatId: chat.chatId })
  // Swipes are real candidates again: the alternate opening survives.
  assert.equal(opened.view.messages.length, 3)
})

test('an imported branch is linked to the parent its own field names', async (t) => {
  const fix = await fixture(t)
  const parentStem = 'Aria - 2026-01-04@10h00m00s'
  const branchStem = 'Branch #6 - 2026-01-04@11h00m00s'

  await importText(fix, `${parentStem}.jsonl`, chatFile({
    createDate: '2026-01-04 @10h00m00s000ms',
    messages: [{ name: 'Aria', is_user: false, mes: 'Opening.' }],
  }))
  // The branch file carries `main_chat`, the parent's chat *name* — and no
  // `iris` block at all, which is exactly the shape real SillyTavern data has.
  await importText(fix, `${branchStem}.jsonl`, chatFile({
    createDate: '2026-01-04 @11h00m00s000ms',
    mainChat: parentStem,
    messages: [{ name: 'Aria', is_user: false, mes: 'Opening.' }, { name: 'Traveller', is_user: true, mes: 'And then?' }],
  }))

  const { chats } = await fix.handlers['chat.list']({})
  const branch = chats.find(row => row.chatId === branchStem)
  assert.equal(branch?.parentChatId, parentStem, 'main_chat resolves to the parent chat')

  // Both ends of the link open: jumping back to the parent works.
  await fix.handlers['chat.open']({ chatId: branchStem })
  await fix.handlers['chat.open']({ chatId: parentStem })
})

test('the link survives importing the child before its parent', async (t) => {
  const fix = await fixture(t)
  const parentStem = 'Aria - 2026-01-04@10h00m00s'
  await importText(fix, 'Branch #1 - 2026-01-05@09h00m00s.jsonl', chatFile({
    mainChat: parentStem,
    messages: [{ name: 'Aria', is_user: false, mes: 'Orphan, for now.' }],
  }))
  await importText(fix, `${parentStem}.jsonl`, chatFile({
    messages: [{ name: 'Aria', is_user: false, mes: 'Opening.' }],
  }))

  const { chats } = await fix.handlers['chat.list']({})
  const branch = chats.find(row => row.chatId.startsWith('Branch #1'))
  assert.equal(branch?.parentChatId, parentStem, 'list() resolves the link whenever both ends exist')
})

test('an export round-trips: fresh store, new turn, stable bytes', async (t) => {
  const fix = await fixture(t, ['The reply.'])
  const original = chatFile({
    metadata: { note_interval: 1, tainted: true },
    messages: [
      { name: 'Aria', is_user: false, mes: 'Take one.', swipes: ['Take one.', 'Take two.'], swipeId: 1, extra: { token_count: 9 } },
    ],
  })
  const imported = await importText(fix, 'Aria - 2026-01-04@10h00m00s.jsonl', original) as {
    chat: { chatId: string }
  }
  const chatId = imported.chat.chatId

  // The conversation carries on in Iris, then goes back out.
  await fix.handlers['chat.send']({ chatId, text: 'A question?' })
  await fix.settled()

  const exported = await fix.handlers['chat.export']({ chatId })
  assert.equal(exported.filename, `${chatId}.jsonl`)
  assert.ok(exported.content.endsWith('\n'), 'JSONL, newline-terminated')

  const round = parseChatFile(exported.content)
  assert.deepEqual(round.header.chat_metadata['tainted'], true, 'chat_metadata survives')
  assert.equal(round.messages.length, 3, 'greeting + user line + the new reply')
  assert.equal(round.messages[0]?.swipe_id, 1, 'the shown swipe is the one exported')
  assert.deepEqual(round.messages[0]?.swipes, ['Take one.', 'Take two.'])
  assert.deepEqual(round.messages[0]?.extra, { token_count: 9 })

  // Re-imported into a fresh store, it is the same conversation again — and a
  // second export is stable, which is what makes the path usable in both
  // directions more than once.
  const again = await fixture(t)
  const reimported = await importText(again, exported.filename, exported.content) as {
    chat: { chatId: string }
  }
  const secondExport = await again.handlers['chat.export']({ chatId: reimported.chat.chatId })
  assert.equal(secondExport.content, exported.content)
})

test('a wild JSONL is refused by name, and nothing is written', async (t) => {
  const fix = await fixture(t)
  // Something in the store first, so the assertion below means "no NEW file".
  const good = await importText(fix, 'Aria - 2026-01-04@10h00m00s.jsonl', chatFile({
    messages: [{ name: 'Aria', is_user: false, mes: 'Opening.' }],
  })) as { chat: { chatId: string } }
  const before = await fix.chats.ids()

  const refusals: [string, () => Promise<unknown>, RegExp][] = [
    ['not base64',
      () => fix.handlers['chat.import']({ filename: 'wild-a.jsonl', content: '!!!not base64 at all!!!', characterId: 'aria' }),
      /not a base64-encoded file/u],
    ['empty payload',
      () => importText(fix, 'wild-b.jsonl', '   \n'),
      /empty/u],
    ['no ST header',
      () => importText(fix, 'wild-c.jsonl', '{"foo": 1}\n{"foo": 2}\n'),
      /no "user_name" string/u],
    ['no chat_metadata',
      () => importText(fix, 'wild-d.jsonl', JSON.stringify({ user_name: 'U', character_name: 'A' }) + '\n'),
      /no "chat_metadata" object/u],
    ['message without text',
      () => importText(fix, 'wild-e.jsonl', chatFile({ messages: [] }).split('\n')[0] + '\n{"name":"Aria","is_user":false}\n'),
      /message 1 has no "mes" text/u],
    ['message not an object',
      () => importText(fix, 'wild-f.jsonl', chatFile({ messages: [] }).split('\n')[0] + '\n[1, 2, 3]\n'),
      /message 1 is not an object/u],
    ['broken JSON line',
      () => importText(fix, 'wild-g.jsonl', chatFile({ messages: [] }).split('\n')[0] + '\n{"name": oops}\n'),
      /not a SillyTavern chat file/u],
  ]
  for (const [name, attempt, reason] of refusals) {
    await assert.rejects(
      attempt,
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'invalid-request', `${name}: refused by name`)
        assert.match((error as Error).message, reason, `${name}: the reason is named`)
        return true
      },
    )
  }

  assert.deepEqual(await fix.chats.ids(), before, 'a refusal never leaves a half-imported file')
  assert.ok(existsSync(join(fix.dir, 'chats', `${good.chat.chatId}.jsonl`)), 'the chat that was there is untouched')
})

test('importing for a character that is not in the library is refused', async (t) => {
  const fix = await fixture(t)
  await assert.rejects(
    () => importText(fix, 'Aria.jsonl', chatFile({ messages: [] }), 'no-such-character'),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
})

test('a filename the filesystem cannot hold still imports, under a safe id', async (t) => {
  const fix = await fixture(t)
  const { chat } = await importText(fix, 'chat:v1.jsonl', chatFile({
    messages: [{ name: 'Aria', is_user: false, mes: 'Opening.' }],
  })) as { chat: { chatId: string } }
  assert.equal(chat.chatId, 'chatv1')
  await fix.handlers['chat.open']({ chatId: chat.chatId })
})

// ---------------------------------------------------------------------------
// The real install: every chat on this machine, imported and compared floor by
// floor. Skipped where the install is not mounted, like every corpus test.
// ---------------------------------------------------------------------------

const CHATS_DIR = `${(process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern')}/data/default-user/chats`

/** Every chat file in the install, read-only. */
async function realChats(): Promise<{ name: string, path: string }[]> {
  if (!existsSync(CHATS_DIR)) return []
  const files: { name: string, path: string }[] = []
  for (const character of await readdir(CHATS_DIR)) {
    let names: string[]
    try {
      names = await readdir(join(CHATS_DIR, character))
    } catch {
      continue
    }
    for (const name of names) {
      if (name.endsWith('.jsonl')) files.push({ name, path: join(CHATS_DIR, character, name) })
    }
  }
  return files
}

const INSTALL = await realChats()

/** Why the two install-wide tests below skip, when they do: what is missing and where it comes from. */
const NO_INSTALL = INSTALL.length === 0 && `no chats under ${CHATS_DIR}; point IRIS_CORPUS at a SillyTavern install`

test('every real chat imports floor-for-floor equivalent', { skip: NO_INSTALL }, async (t) => {
  const fix = await fixture(t)
  assert.ok(INSTALL.length >= 31, `expected the whole install, found ${String(INSTALL.length)} files`)

  for (const file of INSTALL) {
    const text = await readFile(file.path, 'utf8')
    const original: SillyTavernChat = parseChatFile(text)
    const { chat } = await fix.handlers['chat.import']({
      filename: file.name,
      content: b64(text),
      characterId: 'aria',
    }) as { chat: { chatId: string } }

    const stored = parseChatFile(
      await readFile(join(fix.dir, 'chats', `${chat.chatId}.jsonl`), 'utf8'),
    )

    // Header: the fields SillyTavern wrote are verbatim, `main_chat` included
    // — an export has to be able to put the file back.
    assert.equal(stored.header.user_name, original.header.user_name, `${file.name}: user_name`)
    assert.equal(stored.header.character_name, original.header.character_name, `${file.name}: character_name`)
    assert.deepEqual(stored.header.chat_metadata, original.header.chat_metadata, `${file.name}: chat_metadata`)

    // Floors: one line in, one line out, and every field the original carried
    // comes back equal — `mes`, `swipes`, `extra`, `send_date`, `variables`,
    // everything, including what Iris does not model. The stored file is the
    // import written verbatim, so equality here is exact.
    assert.equal(stored.messages.length, original.messages.length, `${file.name}: floor count`)
    for (let index = 0; index < original.messages.length; index += 1) {
      const before = original.messages[index] as Record<string, unknown>
      const after = stored.messages[index] as Record<string, unknown>
      for (const [key, value] of Object.entries(before)) {
        assert.deepEqual(after[key], value, `${file.name}: floor ${String(index)} field "${key}"`)
      }
    }
  }
})

test('imported real branches report the parent their main_chat names', { skip: NO_INSTALL }, async (t) => {
  const fix = await fixture(t)
  let branches = 0
  for (const file of INSTALL) {
    const text = await readFile(file.path, 'utf8')
    await fix.handlers['chat.import']({ filename: file.name, content: b64(text), characterId: 'aria' })
      .then(() => {}, () => { /* counted by the equivalence test above */ })
  }

  const { chats } = await fix.handlers['chat.list']({})
  for (const row of chats) {
    if (row.parentChatId === undefined) continue
    branches += 1
    // The parent exists and is openable: "跳回父聊天" has to hold for every
    // branch the install actually has.
    await fix.handlers['chat.open']({ chatId: row.parentChatId })
  }
  assert.ok(branches >= 7, `expected the install's branch families, linked ${String(branches)}`)
})
