import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseChatFile } from '@iris/persistence'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore, type SearchScanMeter } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { tempDir } from './support/temp-dir.ts'

/**
 * `chat.search`, against its acceptance line.
 *
 * Upstream answers "Previous Chats" filters from a linear scan
 * (`chats.js:874`), and that is what the host does too. The properties that
 * matter are: a fragment deep in a long conversation is found AND located (the
 * chat and the floor), nothing is reported that is not really in a floor's
 * text — no hit invented from JSON keys, speaker names or dates — and the scan
 * **stays proportional to the bytes it reads**. The last is held as counts, not
 * as a stopwatch: the scan reports the characters it folds and the lines it
 * parses (`SearchScanMeter`, an out-param only tests pass), and the large
 * scan's counts are bounded by the small scan's counts times the byte ratio.
 * The bound used to be a ratio of wall clocks, and before that an absolute
 * `elapsed < 1000` — each version a patch for a load shape the previous one
 * had not survived, because a clock measures the machine as much as the code.
 * The counts moved off the machine entirely; the history is on the 10 MiB
 * test, and the ledger records what the change gave up (constant-factor
 * regressions no longer have a witness) and why the trade is still right.
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
  const dir = await tempDir(t, 'iris-chat-search-')
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
 * How much waste a proportional scan may show and still count as linear.
 *
 * The bound is a ratio of **counts**, so there is no machine noise to
 * tolerate: 1.0 would be exact if characters were bytes, and the tenth is
 * left for the characters-vs-bytes difference (the fold sees characters; the
 * file is UTF-8 with a JSON-escaped middle) and for header lines. What the
 * old stopwatch slack (×3) existed to tolerate — a loaded machine moving one
 * wall clock and not the other — has no purchase here: two scans of the same
 * fixture in the same process count the same work whatever else the box is
 * doing. **This is a tightening, not a loosening.** The quantity deleted is
 * one the stopwatch never measured reliably; the replacing bound reds the
 * quadratic degradation on the synthetic 40-vs-400-floor fixture alone
 * (measured: re-folding every earlier line on each step lands ~100× the
 * allowed count), which the wall-clock version could not separate from noise
 * and honestly said so.
 */
const COUNT_SLACK = 1.1

/** The scan's work, zeroed. One meter per side of a comparison; never shared. */
function emptyMeter(): SearchScanMeter {
  return { foldedChars: 0, parsedLines: 0, scannedFiles: 0 }
}

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
 * **This test's history is why the bound is a count.** It began as
 * `elapsed < 1000`, went red at 1456 ms when a peer ran headless Chrome
 * alongside it on unchanged code, and became a ratio of wall clocks — first
 * against a single up-front baseline, then against alternating medians of
 * five, each step a patch for a load shape the previous shape had not
 * survived. The repair kept growing because the quantity was wrong: a wall
 * clock measures the machine as much as the code, and no amount of medians
 * changes that. What the invariant needs is a quantity only the code can
 * move, which is what the scan now reports — {@link SearchScanMeter} — so
 * this test reads the meter instead of a clock and needs one scan per side.
 *
 * **The honest version of the old test admitted it had no teeth here**: with
 * the scan made quadratic (re-folding every earlier line on each step), the
 * clock ratio stayed green — `small=19.6ms big=311.1ms allowed=645.7ms` —
 * because at 40 against 400 floors the quadratic term inflates the baseline
 * about as much as the large scan. The count bound has no such blind spot:
 * the same mutation lands the large scan at roughly one hundred times the
 * allowed folded characters, and reds this test on the synthetic fixture
 * alone, no corpus required. Measured, not assumed — the mutation is in the
 * ledger with its numbers.
 */
test('a 10 MiB-scale chat scans in proportion to its bytes', async (t) => {
  // One profile holding the baseline alone, one holding the baseline and the
  // large file: a search scans every chat in its profile, so the small scan's
  // meter must not include the large file's bytes.
  const baseline = await fixture(t)
  const scaled = await fixture(t)

  const smallBytes = await writeChat(baseline.dir, 'baseline', 40, 'thalassocracy-of-tyre')
  await writeChat(scaled.dir, 'baseline', 40, 'thalassocracy-of-tyre')
  // ~400 floors of ~25 KiB each: past the acceptance line in size, with the
  // marker deep in the file so the scan has to earn the hit.
  const bigBytes = await writeChat(scaled.dir, 'weighted', 400, 'quinquireme-of-nineveh')

  const smallMeter = emptyMeter()
  const small = await baseline.chats.search('thalassocracy-of-tyre', { meter: smallMeter })
  assert.equal(small.length, 1, 'the baseline scan must do real work to be a baseline')
  const bigMeter = emptyMeter()
  const big = await scaled.chats.search('quinquireme-of-nineveh', { meter: bigMeter })
  assert.equal(big.length, 1, 'the large scan found nothing, so it was not scanning')
  const located = big[0]?.matches[0]
  assert.equal(located?.messageId, 200)

  // The meter was written at all. Without this line, a passthrough dropped
  // between `search` and `searchChatText` leaves every count at zero and the
  // assertions below green — the one way this test can lie about the scan.
  assert.ok(smallMeter.foldedChars > 0,
    'the baseline scan wrote nothing into its meter, so the counts below are all zero and prove nothing')

  // The large profile holds both files; the ratio is over total bytes for that
  // reason, not over the large file alone.
  const ratio = (smallBytes + bigBytes) / smallBytes
  assert.ok(ratio > 8, `the two corpora must differ enough to discriminate (ratio ${ratio.toFixed(1)})`)
  assert.ok(
    bigMeter.foldedChars <= smallMeter.foldedChars * ratio * COUNT_SLACK,
    `the scan did not stay proportional to the bytes it read: folded ${String(bigMeter.foldedChars)} characters `
    + `for ${ratio.toFixed(1)}× the bytes, against a baseline of ${String(smallMeter.foldedChars)} `
    + `(allowed ${String(Math.floor(smallMeter.foldedChars * ratio * COUNT_SLACK))}) — `
    + 'per-line work is being repeated, the quadratic shape the scan\'s docblock warns about',
  )
  // Each scanned file pays one header parse; each reported match pays one line
  // parse. Anything more means lines are being parsed that the fold never
  // flagged — the cheap gate that keeps a 19 MiB file at a handful of parses.
  const bigMatches = big.reduce((sum, hit) => sum + hit.matches.length, 0)
  assert.ok(
    bigMeter.parsedLines <= bigMatches + bigMeter.scannedFiles,
    `JSON.parse ran ${String(bigMeter.parsedLines)} times for ${String(bigMatches)} matches across `
    + `${String(bigMeter.scannedFiles)} files — lines the fold never flagged are being parsed`,
  )
})

// ---------------------------------------------------------------------------
// The acceptance conversation: 677 real floors and 19 MiB when it was measured
// (2026-01), still being played, written by SillyTavern. Copied read-only into
// a scratch profile — never searched in place, and never written to. Nothing
// below asserts the 677; the file is its own oracle for how long it is now.

const CORPUS = process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern'
const CHATS = `${CORPUS}/data/default-user/chats`

/** The long acceptance conversation on this machine, if it is here. */
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

test('the real acceptance chat is found by a message fragment, located, and scans in proportion',
  { skip: LONG_CHAT === undefined && `no long acceptance chat under ${CHATS}; point IRIS_CORPUS at the SillyTavern install that has it` },
  async (t) => {
    // Two profiles, for the same reason as the synthetic test: the small
    // scan's meter must not include the real file's bytes, so the baseline
    // lives in a profile that never receives it.
    const baseline = await fixture(t)
    const fix = await fixture(t)
    const longChat = LONG_CHAT as string

    const smallBytes = await writeChat(baseline.dir, 'baseline', 40, 'thalassocracy-of-tyre')
    await writeChat(fix.dir, 'baseline', 40, 'thalassocracy-of-tyre')

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

    // The functional half goes through the RPC handler as before. The
    // proportionality half reads the meter, through the same store method the
    // handler calls — the meter is a measurement out-param, not a wire field.
    const smallMeter = emptyMeter()
    const small = await baseline.chats.search('thalassocracy-of-tyre', { meter: smallMeter })
    assert.equal(small.length, 1, 'the baseline scan must do real work to be a baseline')
    const bigMeter = emptyMeter()
    const hits = await fix.chats.search(fragment, { meter: bigMeter })

    assert.equal(hits.length, 1)
    const hit = hits[0]
    assert.ok(hit !== undefined)
    assert.equal(hit.chatId, chatId)
    // Against the file's own floor count, not against the 677 it held when this
    // was written: the operator plays this conversation, and a pin on today's
    // length goes red on the next reply with nothing wrong in the store. The
    // property is that **every** floor was in scope, and the file says how many
    // that is; the floor below keeps "in scope" from being satisfied by a file
    // that shrank to nothing.
    assert.ok(chat.messages.length >= 500, `the acceptance chat is down to ${String(chat.messages.length)} floors; it is no longer the large one`)
    assert.equal(hit.messageCount, chat.messages.length, 'every floor of the real file was in scope')
    assert.ok(
      hit.matches.some(match => match.messageId === floor),
      `floor ${String(floor)} is named as a match`,
    )
    const located = hit.matches.find(match => match.messageId === floor)
    assert.ok(located?.snippet.includes(fragment), 'the snippet carries the fragment')

    assert.ok(smallMeter.foldedChars > 0,
      'the baseline scan wrote nothing into its meter, so the counts below are all zero and prove nothing')
    // The large profile holds the baseline file as well as the real one, so the
    // ratio is over the bytes that scan actually reads.
    const ratio = (smallBytes + bigBytes) / smallBytes
    assert.ok(ratio > 8, `the two corpora must differ enough to discriminate (ratio ${ratio.toFixed(1)})`)
    assert.ok(
      bigMeter.foldedChars <= smallMeter.foldedChars * ratio * COUNT_SLACK,
      `the scan did not stay proportional to the bytes it read: folded ${String(bigMeter.foldedChars)} characters `
      + `for ${ratio.toFixed(1)}× the bytes, against a baseline of ${String(smallMeter.foldedChars)} `
      + `(allowed ${String(Math.floor(smallMeter.foldedChars * ratio * COUNT_SLACK))})`,
    )
    const bigMatches = hits.reduce((sum, row) => sum + row.matches.length, 0)
    assert.ok(
      bigMeter.parsedLines <= bigMatches + bigMeter.scannedFiles,
      `JSON.parse ran ${String(bigMeter.parsedLines)} times for ${String(bigMatches)} matches across `
      + `${String(bigMeter.scannedFiles)} files — lines the fold never flagged are being parsed`,
    )
})

