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
 * scan **stays proportional to the bytes it reads**. The last two are measured
 * against a real 677-floor, 19 MiB conversation from the SillyTavern install,
 * not a fixture written by the same belief as the code.
 *
 * The proportionality bound replaced an absolute `elapsed < 1000`, which was a
 * measurement of one machine wearing a constant's clothes; see the note on the
 * 10 MiB test.
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

/**
 * How much slower than proportional a scan may be before it counts as
 * degraded.
 *
 * A linear scan that got slower with size — an accidental `O(n²)` from
 * re-slicing, say — blows a 10× byte ratio out to ~100×, so a factor of 3
 * separates the failure this guards from the noise it must tolerate. Small
 * enough to catch the defect, wide enough that a loaded machine does not fail
 * a correct implementation.
 */
const SCAN_SLACK = 3

/**
 * Write one synthetic chat and return its size on disk.
 * @param dir - the fixture's profile directory.
 * @param stem - the chat id.
 * @param floors - how many floors to write.
 * @param marker - a phrase planted in the middle floor, unique to this file.
 * @returns the file's byte length.
 */
async function writeChat(dir: string, stem: string, floors: number, marker: string): Promise<number> {
  const filler = 'The harbour lights kept their own counsel. '.repeat(570)
  const lines: string[] = [JSON.stringify({
    user_name: 'Traveller',
    character_name: 'Aria',
    create_date: '2026-01-04 @10h00m00s',
    chat_metadata: {},
  })]
  for (let index = 0; index < floors; index += 1) {
    const mes = index === Math.floor(floors / 2) ? `${filler}and here, buried, ${marker} surfaces once` : filler
    lines.push(JSON.stringify({ name: 'Aria', is_user: index % 2 === 1, mes }))
  }
  const body = lines.join('\n') + '\n'
  await writeFile(join(dir, 'chats', `${stem}.jsonl`), body, 'utf8')
  return Buffer.byteLength(body)
}

/**
 * A 10 MiB-scale scan stays proportional to the bytes it reads.
 *
 * **The assertion used to be `elapsed < 1000`, and that was a measurement
 * wearing a constant's clothes** (§2 of `METHODS.md`: a number with no
 * caliper). What it actually pinned was "this machine, unloaded, in 2026" —
 * so it went red at 1456 ms when a peer ran headless Chrome alongside it, on
 * an implementation that had not changed. A test that fails for something the
 * code did not do costs more than it protects, because the next red is read as
 * noise too.
 *
 * The invariant worth holding is **"the scan does not degrade with size"**, and
 * that is a ratio, not a stopwatch: measure a small corpus in this same
 * process, then require the large one to cost no more than its share of bytes
 * times {@link SCAN_SLACK}. A uniformly slower machine moves both numbers and
 * the ratio survives, which is exactly the property an absolute bound lacks.
 *
 * The baseline carries a fixed per-call cost (listing the directory, opening
 * the store) that the ratio then credits to the large scan, so the bound is
 * **looser than pure linearity** — an error in the safe direction.
 *
 * **And this test on its own does not discriminate a degradation — measured,
 * not assumed.** Making the scan quadratic (re-folding every earlier line on
 * each step) leaves it green: `small=19.6ms big=311.1ms allowed=645.7ms`,
 * because at 40 against 400 floors the quadratic term inflates the *baseline*
 * about as much as the large scan, and neither is dominated by it. A warm-up
 * pass was tried and moved nothing (17.5ms). So this is a **smoke bound** —
 * it holds the shape and would catch an order-of-magnitude blowup — while the
 * test that actually has teeth is the 677-floor corpus one below, where the
 * same mutation fails loudly (`452ms against 115ms allowed`).
 *
 * The cost of that split is worth stating: **the corpus test is skipped when
 * the real chat is not on the machine**, so on a checkout without it, nothing
 * here would catch the scan degrading.
 */
test('a 10 MiB-scale chat scans in proportion to its bytes', async (t) => {
  const fix = await fixture(t)

  // Baseline first, and alone in the profile: a search scans every chat it can
  // see, so the small measurement has to be taken before the large file exists.
  const smallBytes = await writeChat(fix.dir, 'baseline', 40, 'thalassocracy-of-tyre')
  const smallStarted = performance.now()
  const small = await fix.handlers['chat.search']({ query: 'thalassocracy-of-tyre' })
  const smallElapsed = performance.now() - smallStarted
  assert.equal(small.hits.length, 1, 'the baseline scan must do real work to be a baseline')

  // ~400 floors of ~25 KiB each: past the acceptance line in size, with the
  // marker deep in the file so the scan has to earn the hit.
  const bigBytes = await writeChat(fix.dir, 'weighted', 400, 'quinquireme-of-nineveh')

  const started = performance.now()
  const { hits } = await fix.handlers['chat.search']({ query: 'quinquireme-of-nineveh' })
  const elapsed = performance.now() - started

  const hit = hits[0]
  assert.ok(hit !== undefined)
  assert.equal(hit.matches[0]?.messageId, 200)

  // The second scan reads both files; the ratio is over total bytes for that
  // reason, not over the large file alone.
  const ratio = (smallBytes + bigBytes) / smallBytes
  assert.ok(ratio > 8, `the two corpora must differ enough to discriminate (ratio ${ratio.toFixed(1)})`)
  const allowed = smallElapsed * ratio * SCAN_SLACK
  assert.ok(
    elapsed <= allowed,
    `scan grew faster than its bytes: ${elapsed.toFixed(0)}ms for ${ratio.toFixed(1)}× the bytes, `
    + `against ${smallElapsed.toFixed(0)}ms baseline (allowed ${allowed.toFixed(0)}ms)`,
  )
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

test('the real 677-floor chat is found by a message fragment, located, and scans in proportion',
  { skip: LONG_CHAT === undefined },
  async (t) => {
    const fix = await fixture(t)
    const longChat = LONG_CHAT as string

    // The baseline is measured **before** the real file is copied in: a search
    // scans every chat in the profile, so the only moment a small corpus can be
    // timed alone is before the large one exists. See the proportionality note
    // on the 10 MiB test for why this replaced an absolute wall clock.
    const smallBytes = await writeChat(fix.dir, 'baseline', 40, 'thalassocracy-of-tyre')
    const smallStarted = performance.now()
    const small = await fix.handlers['chat.search']({ query: 'thalassocracy-of-tyre' })
    const smallElapsed = performance.now() - smallStarted
    assert.equal(small.hits.length, 1, 'the baseline scan must do real work to be a baseline')

    // Copy, never point: the corpus stays read-only and the store sees a
    // profile of its own.
    const stem = longChat.split(/[\\/]/u).pop() ?? 'long-chat'
    const chatId = stem.replace(/\.jsonl$/u, '')
    await copyFile(longChat, join(fix.dir, 'chats', stem))
    const bigBytes = (await readFile(longChat)).byteLength

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
    const ratio = (smallBytes + bigBytes) / smallBytes
    assert.ok(ratio > 8, `the two corpora must differ enough to discriminate (ratio ${ratio.toFixed(1)})`)
    const allowed = smallElapsed * ratio * SCAN_SLACK
    assert.ok(
      elapsed <= allowed,
      `scan grew faster than its bytes: ${elapsed.toFixed(0)}ms for ${ratio.toFixed(1)}× the bytes, `
      + `against ${smallElapsed.toFixed(0)}ms baseline (allowed ${allowed.toFixed(0)}ms)`,
    )
})

