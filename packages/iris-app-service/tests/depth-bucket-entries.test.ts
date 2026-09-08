import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import { MEMBER_JOIN } from '@iris/pipeline'
import { serializeRequest } from '@iris/llm-openai-compat'
import type { StreamFn } from '@iris/turn'

import { CacheTraceStore } from '../src/cache-trace.ts'
import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { classifyVolatility, emptyVolatility, markCachePhase } from '../src/cache-friendly.ts'
import { buildPrompt, DEFAULT_PRESET } from '../src/prompt.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { WorldbookStore } from '../src/worldbooks.ts'

/**
 * A world-info depth bucket, classified and placed entry by entry.
 *
 * **The measurement this exists for.** SillyTavern merges every entry sharing a
 * depth and a role into one newline-joined injection, and Iris reproduces that
 * to the byte. On 爱衣 that one injection is 19 KB at depth 0, its three entries
 * are byte-identical between adjacent turns, and the bucket was still judged
 * volatile every turn — because the *set* of entries changes as keywords match,
 * so the bucket's hash moves while nothing in it does. It could therefore never
 * be promoted, and the census attributed 7.4 of the 11 points still missing
 * from that conversation's adjacent-turn ceiling to exactly this block.
 * Splitting it raised the measured ceiling on **every one** of eight adjacent
 * pairs, by 5.0 to 7.1 points (`scripts/cache-friendly-probe.mjs`, ledger §46,
 * which also says why the *mean* of those eight is not the figure to quote).
 *
 * `cache-friendly.test.ts` owns the classifier and `@iris/pipeline`'s
 * `member-split.test.ts` owns the placement. This file owns the **wiring**,
 * which is where both could be right and the product still wrong: the prompt
 * builder has to mint an id per entry that survives the entry's neighbours
 * coming and going, the two joins have to be the same separator or the split is
 * silently refused, the verdict has to reach the members and not only the
 * bucket, and turning the setting off has to put the bucket back together byte
 * for byte.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'A retired cartographer.',
    personality: 'Dry.',
    scenario: 'A map room.',
    first_mes: 'Hello.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: 'Stay in character.',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '1',
    extensions: {},
  },
})

/**
 * One depth-0 bucket with four entries of three different kinds.
 *
 * The shape is 爱衣's, reduced: several constant entries that never change, one
 * that changes every expansion, and one that comes and goes with a keyword. All
 * four share `position: 4` (atDepth), `depth: 0` and `role: 0`, so world info
 * merges them into a single injection — which is the merge under test.
 *
 * **Non-ASCII, and of different lengths.** The corpus is CJK and the entries in
 * one bucket are nothing like the same size, so a fixture of equal-length ASCII
 * strings could not tell a byte offset from a character one nor catch an
 * off-by-one in the join.
 */
const BOOK = {
  entries: {
    10: {
      uid: 10, key: [], keysecondary: [], comment: '常驻·湖',
      content: '甲：这座城市建在一座干涸的湖上，湖床下面还埋着旧码头。', constant: true, disable: false,
      order: 100, position: 4, depth: 0, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 4, depth: 0, role: 0 },
    },
    11: {
      uid: 11, key: [], keysecondary: [], comment: '常驻·钟',
      content: '乙：地图室的钟停在三点。', constant: true, disable: false,
      order: 110, position: 4, depth: 0, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 4, depth: 0, role: 0 },
    },
    12: {
      uid: 12, key: [], keysecondary: [], comment: '每回都变·运势',
      content: '丙：这一场的运势是 {{roll::1d20}}。', constant: true, disable: false,
      order: 120, position: 4, depth: 0, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 4, depth: 0, role: 0 },
    },
    13: {
      // Keyword-triggered, so this entry joins and leaves the bucket as the
      // conversation talks about the lighthouse — which is what moves the
      // bucket's own hash while every other entry in it holds still.
      uid: 13, key: ['灯塔'], keysecondary: [], comment: '触发·灯塔',
      content: '丁：北岸的灯塔已经停了很多年。', constant: false, disable: false,
      order: 130, position: 4, depth: 0, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 4, depth: 0, role: 0 },
    },
    // A second bucket, at the same depth but **assistant** role, so world info
    // merges these two separately (the key is depth *and* role). It exists for
    // one case: a continue appends its separator to the request's last
    // assistant message, which is this bucket while its members are still
    // unsettled — the only shape in the product where a postfix lands on a slot
    // holding two recorded parts.
    20: {
      uid: 20, key: [], keysecondary: [], comment: '助手·笔记一',
      content: '（笔记：湖床。）', constant: true, disable: false,
      order: 100, position: 4, depth: 0, role: 2, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 4, depth: 0, role: 2 },
    },
    21: {
      uid: 21, key: [], keysecondary: [], comment: '助手·笔记二',
      content: '（笔记：钟。）', constant: true, disable: false,
      order: 110, position: 4, depth: 0, role: 2, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 4, depth: 0, role: 2 },
    },
  },
}

/** The bucket id every member's id is prefixed with. */
const BUCKET = 'worldInfo.depth.0.0'

/** The assistant-role bucket at the same depth, which the continue case needs. */
const ASSISTANT_BUCKET = 'worldInfo.depth.0.2'

// -------------------------------------------------------- the prompt builder

/**
 * The book as the product's own reader normalizes it.
 *
 * Read through {@link WorldbookStore.read} rather than handed to the scan as
 * the literal above, because the store's `parseLorebook` is what fills in the
 * fields a raw ST export omits — `triggers` and `key` among them, which the
 * activation loop reads without a default. A hand-built entry list is a
 * different object from the one the product scans, and the first version of
 * this fixture crashed twice proving it. `read`, not `get`: `get` projects onto
 * the wire view, which is not what the scan takes.
 */
const ENTRIES = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-depth-members-book-'))
  await mkdir(join(dir, 'worlds'), { recursive: true })
  await writeFile(join(dir, 'worlds', 'atlas.json'), JSON.stringify(BOOK), 'utf8')
  const book = await new WorldbookStore(join(dir, 'worlds')).read('atlas')
  await rm(dir, { recursive: true, force: true })
  return Object.values(book.entries)
})()

/** Build one prompt over the book, with the history the caller wants scanned. */
function built(history: { role: 'user' | 'assistant', text: string }[]) {
  return buildPrompt({
    card: JSON.parse(CARD) as never,
    worldbook: {
      entries: ENTRIES,
      source: 'named',
      world: 'atlas',
      additional: [],
      global: [],
    },
    preset: DEFAULT_PRESET,
    userName: 'Traveller',
    characterName: 'Aria',
    history,
    count: text => text.length,
    worldInfoBudget: 10_000,
  })
}

test('a depth bucket carries one member per entry, named by book and uid', () => {
  const bucket = built([{ role: 'user', text: '灯塔在哪里？' }])
    .contributions.find(item => item.id === BUCKET)
  assert.ok(bucket !== undefined, 'the fixture must produce a depth bucket at all')

  // Identity is the book plus the uid, prefixed by the bucket — uids collide
  // across a global, a character and a chat book, and one entry can sit in two
  // buckets at different depths.
  assert.deepEqual(bucket.members?.map(member => member.id), [
    `${BUCKET}#atlas.10`,
    `${BUCKET}#atlas.11`,
    `${BUCKET}#atlas.12`,
    `${BUCKET}#atlas.13`,
  ])
  // The entry's own `comment`, which is what SillyTavern's editor shows: this
  // is routinely the largest row in the itemization, and `#13` names nothing.
  assert.deepEqual(bucket.members?.map(member => member.label), [
    '常驻·湖', '常驻·钟', '每回都变·运势', '触发·灯塔',
  ])
})

test('the builder\'s join and the assembler\'s separator are the same string', () => {
  const bucket = built([{ role: 'user', text: '灯塔在哪里？' }])
    .contributions.find(item => item.id === BUCKET)
  // The invariant the whole split rests on, and the one that would fail
  // silently: the assembler refuses a member list that does not rejoin, so a
  // builder joining with a blank line would produce a bucket that is simply
  // never split — no error, no split, and the ceiling back where §38 left it.
  // The two
  // separators are written out on both sides on purpose (they are two
  // independent upstream lines), which is why this comparison is a test rather
  // than a comment.
  assert.equal(
    bucket?.members?.map(member => member.text).join(MEMBER_JOIN),
    bucket?.text,
    'a bucket whose members do not rejoin its text can never be split')
})

test('an entry joining the bucket does not change the other entries\' ids or text', () => {
  const without = built([{ role: 'user', text: '早上好' }])
    .contributions.find(item => item.id === BUCKET)
  const with13 = built([{ role: 'user', text: '灯塔在哪里？' }])
    .contributions.find(item => item.id === BUCKET)

  // The bucket's own text differs — that is the membership change, and it is
  // why the bucket's hash moves every turn.
  assert.notEqual(without?.text, with13?.text)
  // The three constant entries are the same entries under the same names, and
  // two of them are byte-identical. That is the whole finding: the loss was
  // never in the entries.
  const stable = (bucket: typeof without): [string, string][] =>
    (bucket?.members ?? [])
      .filter(member => !member.id.endsWith('.12'))
      .map(member => [member.id, member.text])
  assert.deepEqual(stable(without), stable(with13).slice(0, 2))
  assert.equal(with13?.members?.length, 4)
  assert.equal(without?.members?.length, 3)
})

test('the classifier records a row per member and settles them on their own', () => {
  const bucket = built([{ role: 'user', text: '灯塔在哪里？' }])
    .contributions.find(item => item.id === BUCKET)
  assert.ok(bucket !== undefined)

  // Three generations of the same bucket, then one where the keyword entry has
  // left. The `{{roll}}` member is given a different number each time, which is
  // what it really does.
  const roll = (turn: number) => {
    const members = (bucket.members ?? []).map(member => member.id.endsWith('.12')
      ? { ...member, text: `丙：这一场的运势是 ${String(turn)}。` }
      : member)
    // The text is rebuilt from the members, not carried over: a contribution
    // whose text and members disagree is one the assembler refuses to split,
    // so a fixture that did not rebuild it would be testing an invalid input —
    // and, in this case, would leave the bucket's own hash constant and hide
    // the very verdict this test is about.
    return { ...bucket, members, text: members.map(member => member.text).join(MEMBER_JOIN) }
  }
  let record = emptyVolatility()
  let verdict = classifyVolatility(record, [roll(1)])
  for (let turn = 2; turn <= 4; turn += 1) {
    record = verdict.next
    verdict = classifyVolatility(record, [roll(turn)])
  }

  // The two constant entries have held still for three generations, so they are
  // settled — individually, under their own ids.
  assert.ok(verdict.settled.has(`${BUCKET}#atlas.10`))
  assert.ok(verdict.settled.has(`${BUCKET}#atlas.11`))
  // The die roll is measured volatile and holds.
  assert.ok(verdict.volatile.has(`${BUCKET}#atlas.12`))
  // And the bucket itself is volatile, because its own text moves with the
  // roll — which is exactly the verdict that used to hold the other two out.
  assert.ok(verdict.volatile.has(BUCKET))
  assert.equal(verdict.settled.has(BUCKET), false)

  // The marks reach the members, not just the bucket: the assembler places by
  // the member's flag, so a verdict that stopped at the bucket would read as
  // the split doing nothing.
  const marked = markCachePhase([roll(5)], verdict).find(item => item.id === BUCKET)
  // Three settled, one volatile, in bucket order — and the keyword entry is
  // settled here because this fixture kept it activated throughout, which is
  // what "held still" means: the member did not change, its bucket did.
  assert.deepEqual(
    marked?.members?.map(member => [member.settled === true, member.volatile === true]),
    [[true, false], [true, false], [false, true], [true, false]])
  // The scan's own objects are untouched: this verdict is per turn.
  assert.equal(bucket.members?.[0]?.settled, undefined)
})

// ------------------------------------------------------- through the real host

interface Fixture {
  handlers: Handlers
  chatId: string
  traces: CacheTraceStore
  /** Send one line and wait for the generation to settle. */
  send: (text: string) => Promise<void>
  /** Wait for one more generation, for a caller that started it itself. */
  settledOnce: () => Promise<void>
  /** Re-assemble the newest turn and hand back the request that would be sent. */
  assemble: () => Promise<GenerateOptions>
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-depth-members-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await mkdir(join(dir, 'worlds'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  await writeFile(join(dir, 'worlds', 'atlas.json'), JSON.stringify(BOOK), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const worldbooks = new WorldbookStore(join(dir, 'worlds'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  await settings.load()
  const chats = new ChatStore(
    join(dir, 'chats'), library, undefined, undefined, worldbooks, () => settings.globalSelect())
  const traces = new CacheTraceStore(join(dir, 'cache-trace'), { keep: 8 })

  const captured: GenerateOptions[] = []
  let replies = 0
  const stream: StreamFn = async function* (options) {
    captured.push(options)
    replies += 1
    const text = `回复 ${String(replies)}。`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  let ends = 0
  let waited = 0
  const handlers = new IrisAppService({
    stream,
    library,
    chats,
    settings,
    worldbooks,
    cacheTrace: traces,
    broadcast: (event: IrisEvent) => {
      if (event.type === 'stream.end' || event.type === 'stream.error') ends += 1
    },
    userName: 'Traveller',
  }).handlers()

  // Selected BEFORE the chat is created: the store reads the selection through a
  // closure when a chat opens, so a book chosen afterwards reaches this
  // conversation only on the next open — and every assertion below would pass
  // against a request with no world info in it at all.
  await handlers['worldbook.setGlobalSelect']({ names: ['atlas'] })
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  const settle = async (): Promise<void> => {
    waited += 1
    for (let tick = 0; tick < 8_000 && ends < waited; tick += 1) {
      await new Promise(done => { setTimeout(done, 1) })
    }
    assert.equal(ends >= waited, true, 'a generation never settled')
  }

  return {
    handlers,
    chatId,
    traces,
    send: async (text: string) => {
      await handlers['chat.send']({ chatId, kind: 'send', text })
      await settle()
    },
    settledOnce: settle,
    assemble: async () => {
      const before = captured.length
      await handlers['chat.regenerate']({ chatId })
      await settle()
      assert.equal(captured.length, before + 1, 'expected exactly one captured request')
      return captured[captured.length - 1] as GenerateOptions
    },
  }
}

/** The system prompt and every message, as `role text` rows in request order. */
function rows(options: GenerateOptions): { role: string, text: string }[] {
  const out = options.system === undefined || options.system === ''
    ? []
    : [{ role: 'system', text: options.system }]
  for (const message of options.messages) {
    out.push({
      role: message.role,
      text: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    })
  }
  return out
}

const body = (options: GenerateOptions): string => JSON.stringify(serializeRequest(options))

/**
 * Which ids the itemization says moved, rows and members alike.
 *
 * `rows` and `members` are kept apart because they answer different questions:
 * a mark on the bucket's row means "all of it went", and a mark on a member
 * means "this entry did". A collector that merged them could not tell the two
 * apart, which is the distinction the split created.
 */
async function moved(fix: Fixture): Promise<{
  deferredRows: string[]
  promotedRows: string[]
  deferredMembers: string[]
  promotedMembers: string[]
}> {
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: fix.chatId })
  const rowsWith = (mark: 'deferred' | 'promoted'): string[] =>
    itemization.entries.filter(entry => entry[mark] === true).map(entry => entry.id)
  const membersWith = (mark: 'deferred' | 'promoted'): string[] => itemization.entries
    .flatMap(entry => (entry.members ?? []).filter(member => member[mark] === true))
    .map(member => member.id)
  return {
    deferredRows: rowsWith('deferred'),
    promotedRows: rowsWith('promoted'),
    deferredMembers: membersWith('deferred'),
    promotedMembers: membersWith('promoted'),
  }
}

test('the stable entries of a bucket reach the prefix while the rest stay at depth 0', async (t) => {
  const fix = await fixture(t)
  await fix.send('灯塔在哪里？')
  // Two more assemblies, which is what the classifier needs to have watched an
  // entry hold still (`DEFAULT_SETTLE_AFTER`).
  await fix.assemble()
  const request = await fix.assemble()

  const lines = rows(request)
  const floor = lines.findIndex(line => line.text.includes('灯塔在哪里'))
  const lake = lines.findIndex(line => line.text.includes('干涸的湖'))
  const clock = lines.findIndex(line => line.text.includes('钟停在三点'))
  const roll = lines.findIndex(line => /运势是 \d+/u.test(line.text))

  assert.ok(floor > 0, 'the fixture must have a conversation for anything to be anchored to')
  // The two constant entries are now their own messages ahead of the
  // conversation. Before the split they were bytes 0–56 of a single depth-0
  // message *behind* it, and were re-sent in full on every turn.
  assert.ok(lake > 0 && lake < floor, `the lake entry is at ${String(lake)}, the floor at ${String(floor)}`)
  assert.ok(clock > 0 && clock < floor, `the clock entry is at ${String(clock)}, the floor at ${String(floor)}`)
  // Upstream's own order inside the bucket, kept across the split: `order` 100
  // before `order` 110.
  assert.ok(lake < clock, 'the promoted entries must keep the order the bucket joined them in')
  // The die roll stays at depth 0 — it really does change, and depth 0 has
  // nowhere later to send it.
  assert.ok(roll > floor, 'a volatile entry must not be promoted')

  // Each promoted entry is one message, not two entries in one: the whole point
  // is that the bucket stopped being the unit.
  const promotedRow = lines[lake]
  assert.equal(promotedRow?.text.includes('钟停在三点'), false)

  const marks = await moved(fix)
  // The two constant entries are promoted **as members**; the die roll is not.
  // Asserted as the whole promoted-member set for this bucket rather than as
  // "contains", so an implementation that promoted everything would go red.
  assert.deepEqual(
    marks.promotedMembers.filter(id => id.startsWith(`${BUCKET}#`) && !id.endsWith('.13')),
    [`${BUCKET}#atlas.10`, `${BUCKET}#atlas.11`])
  assert.equal(marks.promotedMembers.includes(`${BUCKET}#atlas.12`), false,
    'an entry whose text changes every expansion must not reach the prefix')
  // And the bucket's own row carries neither mark, because its members went
  // different ways and no single mark is true of it.
  assert.equal(marks.promotedRows.includes(BUCKET), false)
  assert.equal(marks.deferredRows.includes(BUCKET), false)
})

test('a keyword entry joining the bucket costs only itself', async (t) => {
  const fix = await fixture(t)
  // Two turns that do not mention the lighthouse, so the bucket has three
  // entries and the constant ones settle.
  await fix.send('早上好')
  await fix.assemble()
  const before = await fix.assemble()

  // Now the keyword fires: the bucket's membership — and therefore its hash —
  // changes. Under the whole-bucket rule this is the moment the entire 19 KB
  // block was marked volatile for twenty generations.
  await fix.send('北岸的灯塔呢？')
  const after = await fix.assemble()

  const lighthouse = rows(after).findIndex(line => line.text.includes('北岸的灯塔已经停了'))
  const floor = rows(after).findIndex(line => line.text.includes('北岸的灯塔呢'))
  assert.ok(lighthouse > 0, 'the keyword entry must have activated, or this test proves nothing')
  assert.ok(lighthouse > floor, 'a newly activated entry has not been observed holding still')

  // The two settled entries are still promoted, and still byte-identical: a
  // membership change no longer reaches them.
  const text = (options: GenerateOptions, needle: string): string | undefined =>
    rows(options).find(line => line.text.includes(needle))?.text
  assert.equal(text(after, '干涸的湖'), text(before, '干涸的湖'))
  assert.equal(text(after, '钟停在三点'), text(before, '钟停在三点'))
  const marks = await moved(fix)
  assert.ok(marks.promotedMembers.includes(`${BUCKET}#atlas.10`))
  assert.ok(marks.promotedMembers.includes(`${BUCKET}#atlas.11`))
  // The bucket itself is volatile — its text moved when the entry joined — and
  // that verdict now reaches nothing but the bucket. Before the split it was
  // the whole story: this row's mark held every entry in the bucket at depth 0
  // for the full twenty-generation hold.
  assert.equal(marks.promotedRows.includes(BUCKET), false)
})

test('turning the setting off puts the bucket back into one message, byte for byte', async (t) => {
  const fix = await fixture(t)
  await fix.send('灯塔在哪里？')
  await fix.assemble()
  // Warmed with the setting on, so the classifier has settled two members and
  // the comparison is not accidentally between two unclassified assemblies.
  const on = await fix.assemble()
  assert.ok(rows(on).some(line => line.text === '甲：这座城市建在一座干涸的湖上，湖床下面还埋着旧码头。'),
    'the fixture must actually be splitting the bucket before the off case means anything')

  await fix.handlers['settings.set']({ chatId: fix.chatId, settings: { cacheFriendly: false } })
  const off = await fix.assemble()
  const offAgain = await fix.assemble()

  // One message holding every activated entry, joined the way upstream joins
  // them — the exact shape `assembly-determinism` and `history-stability` pin.
  const bucket = rows(off).find(line => line.text.includes('干涸的湖'))
  assert.ok(bucket !== undefined)
  assert.ok(bucket.text.startsWith('甲：'), 'the join must lead with the lowest-order entry')
  assert.ok(bucket.text.includes(`旧码头。${MEMBER_JOIN}乙：`),
    'the entries must be newline-joined into one message with no extra separator')
  assert.ok(bucket.text.includes('北岸的灯塔已经停了'), 'every activated entry belongs in the one message')

  // And nothing about the request depends on the member list: two assemblies
  // with the setting off differ only in the die roll.
  assert.equal(
    body(off).replace(/运势是 \d+/gu, '运势是 N'),
    body(offAgain).replace(/运势是 \d+/gu, '运势是 N'))
  assert.equal(rows(off).length, rows(offAgain).length)
  // The itemization stops reporting members too, because the split is what the
  // members are for: a panel showing a split the request did not make would be
  // describing a different request.
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: fix.chatId })
  assert.equal(itemization.entries.find(entry => entry.id === BUCKET)?.members, undefined)
})

test('the trace names each entry of a split bucket, and the divergence points at one', async (t) => {
  const fix = await fixture(t)
  await fix.send('灯塔在哪里？')
  await fix.send('钟呢？')
  await fix.send('湖床下面有什么？')

  const seqs = await fix.traces.list(fix.chatId)
  assert.ok(seqs.length >= 2, `expected at least two traces, got ${seqs.join(', ')}`)
  const trace = await fix.traces.read(fix.chatId, seqs[seqs.length - 1] as number)
  assert.ok(trace !== undefined)
  // The whole record refuses to report offsets it cannot stand behind, so an
  // unattributed trace here would mean the parts stopped laying back down onto
  // their slot — which is exactly what a wrong member list produces.
  assert.equal(trace.attributed, true, trace.attributionNote ?? '')

  // Byte ranges for the entries, not for the bucket: the promoted ones as their
  // own spans, and the remainder subdivided inside its slot.
  const ids = trace.spans.map(span => span.id)
  const members = ids.filter(id => id.startsWith(`${BUCKET}#`))
  assert.ok(members.length >= 2, `no member spans among ${ids.join(', ')}`)
  // Each span cuts back to its own text, which is the property every offset
  // here rests on.
  const bytes = Buffer.from(trace.body, 'utf8')
  let checked = 0
  for (const span of trace.spans) {
    if (!span.id.startsWith(`${BUCKET}#`)) continue
    const text = JSON.parse(`"${bytes.subarray(span.start, span.end).toString('utf8')}"`) as string
    assert.ok(text.length > 0, `span ${span.id} cut back to nothing`)
    assert.equal(span.kind, 'depth')
    checked += 1
  }
  assert.ok(checked >= 2, `only ${String(checked)} member spans were cut back`)

  // And the comparison speaks the same vocabulary: the entries are aligned by
  // their own ids across two requests, so a reader is told which entry was
  // re-sent rather than that "the depth injection" was.
  const { divergence } = await fix.handlers['prompt.divergence']({ chatId: fix.chatId })
  assert.ok(divergence !== undefined)
  const named = divergence.items.filter(item => item.id.startsWith(`${BUCKET}#`))
  assert.ok(named.length >= 2, `the divergence named no entry among ${divergence.items.map(i => i.id).join(', ')}`)
  assert.ok(named.some(item => item.state === 'same'),
    'the settled entries were byte-identical between the two turns and must be reported so')
  // The label a person reads travels with the id, or the panel shows a row
  // called `worldInfo.depth.0.0#atlas.10`.
  assert.ok(named.some(item => item.label === '常驻·湖'), 'a member span must carry the entry\'s own comment')
})

test('a continue\'s separator lands on the last part of a split slot, not beside it', async (t) => {
  const fix = await fixture(t)
  // **No warm-up.** The two assistant-role entries have to still be *in* their
  // slot for the postfix to meet a two-part slot at all; once they settle they
  // leave for the prefix as their own single-part messages and this case stops
  // existing. Checked by warming first: with three assemblies the slot holds
  // nothing and the test passes with the fix reverted.
  await fix.send('灯塔在哪里？')
  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'continue' })
  await fix.settledOnce()

  const seqs = await fix.traces.list(fix.chatId)
  const trace = await fix.traces.read(fix.chatId, seqs[seqs.length - 1] as number)
  assert.ok(trace !== undefined)
  assert.equal(trace.kind, 'continue')

  // The slot the postfix landed on, and the property at stake: the recorded
  // parts have to lay back down onto the slot they describe. A postfix appended
  // to the message but not to any part leaves them a separator short, and the
  // trace refuses the whole request's offsets — correctly, but the report is
  // then useless for the turn a user is looking at.
  assert.equal(trace.attributed, true, trace.attributionNote ?? '')
  const members = trace.spans.filter(span => span.id.startsWith(`${ASSISTANT_BUCKET}#`))
  assert.equal(members.length, 2,
    `the assistant bucket must still hold both entries; got ${trace.spans.map(s => s.id).join(', ')}`)
  // And the separator is inside the last part's range, not in nobody's: the
  // spans of a subdivided slot are contiguous and reach its end.
  const slotEnd = Math.max(...members.map(span => span.end))
  const bytes = Buffer.from(trace.body, 'utf8')
  const last = JSON.parse(`"${bytes.subarray(members[1]?.start ?? 0, slotEnd).toString('utf8')}"`) as string
  assert.ok(last.endsWith(' '), `the last part ends ${JSON.stringify(last.slice(-4))}, not with the separator`)
})
