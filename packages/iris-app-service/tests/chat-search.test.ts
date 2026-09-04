import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseChatFile } from '@iris/persistence'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * `chat.search`, against its acceptance line.
 *
 * Upstream answers "Previous Chats" filters from a linear scan
 * (`chats.js:874`), and that is what the host does too. The properties that
 * matter are: a fragment deep in a long conversation is found AND located (the
 * chat and the floor), nothing is reported that is not really in a floor's
 * text — no hit invented from JSON keys, speaker names or dates — and the
 * scan of a 10 MiB-scale file stays under a second. The last two are measured
 * against a real 677-floor, 19 MiB conversation from the SillyTavern install,
 * not a fixture written by the same belief as the code.
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
  /** Write a chat file of 64 floors, one line of text each. */
  writeChat: (chatId: string, floors: (index: number) => string) => Promise<string>
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-chat-search-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  await chats.ensure()

  const handlers = new IrisAppService({
    stream: scripted(['A reply.']),
    library,
    chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (_event: IrisEvent) => {},
    userName: 'Traveller',
  }).handlers()

  const header = JSON.stringify({
    user_name: 'Traveller',
    character_name: 'Aria',
    create_date: '2026-01-04 @10h00m00s',
    chat_metadata: {},
  })

  return {
    dir,
    handlers,
    chats,
    writeChat: async (chatId, floors) => {
      const lines = [header]
      for (let index = 0; index < 64; index += 1) {
        lines.push(JSON.stringify({ name: 'Aria', is_user: index % 2 === 1, mes: floors(index) }))
      }
      await writeFile(join(dir, 'chats', `${chatId}.jsonl`), lines.join('\n') + '\n', 'utf8')
      return chatId
    },
  }
}

test('a fragment deep in a conversation is found and located', async (t) => {
  const fix = await fixture(t)
  await fix.writeChat('deep', index => index === 42
    ? 'the first half of the floor, and then the tide remembers the old name Elowen, and the rest'
    : `floor ${String(index)} says something ordinary`)

  const { hits } = await fix.handlers['chat.search']({ query: 'tide remembers the old name' })

  assert.equal(hits.length, 1, 'exactly the one conversation matched')
  const hit = hits[0]
  assert.ok(hit !== undefined)
  assert.equal(hit.chatId, 'deep')
  assert.equal(hit.messageCount, 64)
  const match = hit.matches[0]
  assert.ok(match !== undefined)
  assert.equal(match.messageId, 42, 'the hit names the floor it lives on')
  assert.ok(match.snippet.includes('tide remembers the old name'), 'the snippet shows the match')
  assert.equal(match.isUser, false)
})

test('no result is no hit, and a match outside the floor text is not a hit', async (t) => {
  const fix = await fixture(t)
  // Every line carries `"name":"Aria"`, so the name is all over the raw JSON —
  // but it is in no floor's text. Searching for it must invent nothing.
  await fix.writeChat('plain', index => `floor ${String(index)} says something ordinary`)

  const none = await fix.handlers['chat.search']({ query: 'zzz-no-floor-says-this-zzz' })
  assert.deepEqual(none.hits, [], 'a gibberish query returns no hits rather than something')

  const nameOnly = await fix.handlers['chat.search']({ query: 'Aria' })
  assert.deepEqual(nameOnly.hits, [], 'a name that appears only in JSON keys is not a content hit')
})

test('the search is case-insensitive unless it is asked not to be', async (t) => {
  const fix = await fixture(t)
  await fix.writeChat('casing', index => index === 7 ? 'a Galaxy Brain moment' : `floor ${String(index)}`)

  const folded = await fix.handlers['chat.search']({ query: 'galaxy brain' })
  assert.equal(folded.hits.length, 1)

  const literalMiss = await fix.handlers['chat.search']({ query: 'galaxy brain', caseSensitive: true })
  assert.deepEqual(literalMiss.hits, [])

  const literalHit = await fix.handlers['chat.search']({ query: 'Galaxy Brain', caseSensitive: true })
  assert.equal(literalHit.hits.length, 1)
})

test('a file that cannot be parsed is skipped, the rest still searched', async (t) => {
  const fix = await fixture(t)
  await writeFile(join(fix.dir, 'chats', 'broken.jsonl'), '{not json at all', 'utf8')
  await fix.writeChat('whole', index => `floor ${String(index)} mentions a keepsake`)

  const { hits } = await fix.handlers['chat.search']({ query: 'keepsake' })
  assert.deepEqual(hits.map(hit => hit.chatId), ['whole'], 'one corrupt file must not take the search down')
})

test('the per-chat cap limits the matches reported, in file order', async (t) => {
  const fix = await fixture(t)
  await fix.writeChat('many', index => `floor ${String(index)} carries the word lantern`)

  const capped = await fix.handlers['chat.search']({ query: 'lantern', limit: 3 })
  const hit = capped.hits[0]
  assert.ok(hit !== undefined)
  assert.deepEqual(hit.matches.map(match => match.messageId), [0, 1, 2])

  const defaulted = await fix.handlers['chat.search']({ query: 'lantern' })
  assert.equal(defaulted.hits[0]?.matches.length, 5, 'the default cap is five')
})

test('a user floor reports itself as the user\'s', async (t) => {
  const fix = await fixture(t)
  await fix.writeChat('voices', index => index === 5 ? 'my own question about the sea' : `floor ${String(index)}`)

  const { hits } = await fix.handlers['chat.search']({ query: 'question about the sea' })
  assert.equal(hits[0]?.matches[0]?.isUser, true)
})

test('an empty query is refused, not answered with everything', async (t) => {
  const fix = await fixture(t)
  await fix.writeChat('any', index => `floor ${String(index)}`)

  await assert.rejects(
    () => fix.handlers['chat.search']({ query: '   ' }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
})

test('a 10 MiB-scale chat scans in under a second', async (t) => {
  const fix = await fixture(t)

  // ~400 floors of ~25 KiB each: past the acceptance line in size, with the
  // marker deep in the file so the scan has to earn the hit.
  const filler = 'The harbour lights kept their own counsel. '.repeat(570)
  const lines: string[] = [JSON.stringify({
    user_name: 'Traveller',
    character_name: 'Aria',
    create_date: '2026-01-04 @10h00m00s',
    chat_metadata: {},
  })]
  for (let index = 0; index < 400; index += 1) {
    const mes = index === 300
      ? `${filler}and here, buried, the phrase quinquireme-of-nineveh surfaces once`
      : filler
    lines.push(JSON.stringify({ name: 'Aria', is_user: index % 2 === 1, mes }))
  }
  await writeFile(join(fix.dir, 'chats', 'weighted.jsonl'), lines.join('\n') + '\n', 'utf8')

  const started = performance.now()
  const { hits } = await fix.handlers['chat.search']({ query: 'quinquireme-of-nineveh' })
  const elapsed = performance.now() - started

  const hit = hits[0]
  assert.ok(hit !== undefined)
  assert.equal(hit.matches[0]?.messageId, 300)
  assert.ok(elapsed < 1000, `expected the 10 MiB scan under 1s, took ${elapsed.toFixed(0)}ms`)
})

// ---------------------------------------------------------------------------
// The acceptance conversation: 677 real floors, 19 MiB, written by
// SillyTavern. Copied read-only into a scratch profile — never searched in
// place, and never written to.

const CORPUS = process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern'
const CHATS = `${CORPUS}/data/default-user/chats`

/** The 677-floor conversation on this machine, if it is here. */
async function findLongChat(): Promise<string | undefined> {
  if (!existsSync(CHATS)) return undefined
  for (const character of await readdir(CHATS)) {
    let files: string[]
    try {
      files = await readdir(join(CHATS, character))
    } catch {
      continue
    }
    for (const file of files) {
      if (file.startsWith('22 - 2026-01-20')) return join(CHATS, character, file)
    }
  }
  return undefined
}

const LONG_CHAT = await findLongChat()

test('the real 677-floor chat is found by a message fragment, located, and scans under a second',
  { skip: LONG_CHAT === undefined },
  async (t) => {
    const fix = await fixture(t)
    const longChat = LONG_CHAT as string

    // Copy, never point: the corpus stays read-only and the store sees a
    // profile of its own.
    const stem = longChat.split(/[\\/]/u).pop() ?? 'long-chat'
    const chatId = stem.replace(/\.jsonl$/u, '')
    await copyFile(longChat, join(fix.dir, 'chats', stem))

    // A fragment from a deep floor — the middle of its text, and a window with
    // no escape or quote in it, so what the test searches is text as a reader
    // would type it rather than bytes as JSON happens to encode it. The floor's
    // opening lines can be a template several floors share, so the window is
    // required to be unique across the whole file: the point is a hit that can
    // name THIS floor, and a phrase five floors carry would only cap out.
    const chat = parseChatFile(await readFile(longChat, 'utf8'))
    const wantFloor = 600
    let fragment: string | undefined
    let floor = wantFloor
    for (; floor < chat.messages.length && fragment === undefined; floor += 1) {
      const mes = chat.messages[floor]?.mes ?? ''
      if (mes.length < 80) continue
      for (let start = 0; start + 40 <= mes.length && fragment === undefined; start += 1) {
        const window = mes.slice(start, start + 40)
        if (/[\\\n\r\t"]/u.test(window)) continue
        if (chat.messages.filter(row => row.mes.includes(window)).length === 1) fragment = window
      }
    }
    floor -= 1
    assert.ok(fragment !== undefined, `found a unique plain-text window from floor ${String(wantFloor)} on`)

    const gibberish = await fix.handlers['chat.search']({ query: 'zzz-nothing-real-zzz' })
    assert.deepEqual(gibberish.hits, [], 'the real file invents no hits either')

    const started = performance.now()
    const { hits } = await fix.handlers['chat.search']({ query: fragment })
    const elapsed = performance.now() - started

    assert.equal(hits.length, 1)
    const hit = hits[0]
    assert.ok(hit !== undefined)
    assert.equal(hit.chatId, chatId)
    assert.equal(hit.messageCount, 677, 'every floor of the real file was in scope')
    assert.ok(
      hit.matches.some(match => match.messageId === floor),
      `floor ${String(floor)} is named as a match`,
    )
    const located = hit.matches.find(match => match.messageId === floor)
    assert.ok(located?.snippet.includes(fragment), 'the snippet carries the fragment')
    assert.ok(elapsed < 1000, `expected the 19 MiB scan under 1s, took ${elapsed.toFixed(0)}ms`)
})

