import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { LlmError, createAssistantMessage, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { providerExcuse, type IrisEvent } from '@iris/protocol'
import { slotsOf, squashSystemRuns, type AssembledSlot, type PromptLayout, type StreamFn } from '@iris/turn'

import {
  CacheTraceStore,
  divergenceOf,
  spansOf,
  traceOf,
  type CacheTraceFile,
} from '../src/cache-trace.ts'
import { canonicalBody, fingerprintBody, serialiseRequest } from '../src/fingerprint.ts'
import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { WorldbookStore } from '../src/worldbooks.ts'

/**
 * The record that makes a cache miss answerable, and the arithmetic over it.
 *
 * Two properties carry everything else here, and both are about *offsets* rather
 * than about totals:
 *
 * 1. **A slot's byte range, cut out of the body, is that slot's text.** Not
 *    approximately, not modulo escaping — `JSON.parse('"' + slice + '"')` gives
 *    the text back. An offset that is one byte out reports a divergence in the
 *    neighbouring part, which reads as a finding rather than as a defect.
 * 2. **The ranges are disjoint, ascending, and cover every text byte.** A gap
 *    would silently move bytes into `structureBytes` and understate whichever
 *    part the gap belonged to.
 *
 * Every offset assertion is written against a body whose parts have **different
 * lengths and non-ASCII text**, because a fixture of equal-length ASCII parts
 * cannot distinguish a byte offset from a character offset, and CJK is what the
 * real corpus is made of.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: 'A retired cartographer of some renown.', personality: 'Dry.', scenario: 'A map room.',
    first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: 'Stay in character.', alternate_greetings: [],
    tags: [], creator: '', character_version: '1',
    // A note at depth 2, so the end-to-end fixture contains the placement the
    // whole record exists for. Without one the request is system sections plus
    // floors, and `injectAtDepth`'s provenance stamping — the line that decides
    // whether a depth injection can be named at all — is never executed.
    extensions: { depth_prompt: { prompt: 'Aria remembers the map room.', depth: 2, role: 'system' } },
  },
})

/**
 * A book with entries in three placements, taken from
 * `assembly-determinism.test.ts` so the two fixtures describe one request shape.
 *
 * The depth-0 constant entry is the load-bearing one: it is byte-identical every
 * turn and lands after the newest floor, which is the shape that costs the
 * user's own conversation 51%–76% of its unservable bytes.
 */
const BOOK = {
  entries: {
    0: {
      uid: 0, key: [], keysecondary: [], comment: 'always, before the card',
      content: 'The city is built on a drained lake.', constant: true, disable: false,
      order: 100, position: 0, depth: 4, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 0, depth: 4, role: 0 },
    },
    1: {
      uid: 1, key: [], keysecondary: [], comment: 'always, at depth zero',
      content: 'Answer in the present tense.', constant: true, disable: false,
      order: 100, position: 4, depth: 0, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 4, depth: 0, role: 0 },
    },
    2: {
      uid: 2, key: ['lake'], keysecondary: [], comment: 'keyword, at depth two',
      content: 'The lake was drained in the year of the long winter.', constant: false, disable: false,
      order: 100, position: 4, depth: 2, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 4, depth: 2, role: 0 },
    },
  },
}

/** A request with a system slot and two messages, non-ASCII throughout. */
function request(system: string, first: string, second: string): GenerateOptions {
  return {
    provider: 'test',
    model: 'test-model',
    system,
    messages: [
      createUserMessage({ content: [{ type: 'text', text: first }], source: { kind: 'user' } }),
      createAssistantMessage({
        content: [{ type: 'text', text: second }],
        source: { provider: 'iris', model: 'history' },
      }),
    ],
  }
}

/** The reference serialisation, written out rather than reused. */
function reference(options: GenerateOptions): string {
  return JSON.stringify({
    system: options.system ?? null,
    messages: options.messages.map(message => ({
      role: message.role,
      text: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    })),
  })
}

test('the canonical body is byte-for-byte the object form, chunk by chunk', () => {
  // The one reference worth checking a hand-written serialiser against is
  // `JSON.stringify` over the object it replaced — written out here rather than
  // imported, so this is two implementations and not one calling itself.
  //
  // Non-ASCII and an escape in the same fixture: `JSON.stringify` leaves CJK raw
  // and escapes the quote, and a chunked writer that got either wrong would pass
  // an ASCII-only test.
  const options = request('你是爱衣。', 'He said "hi" — 早上好', '地图\n绘制者')
  assert.equal(canonicalBody(options).body, reference(options))
  assert.equal(serialiseRequest(options), reference(options))
})

test('a slot cut out of the body at its offsets is that slot\'s text', () => {
  const options = request('你是爱衣。', 'He said "hi" — 早上好', '地图\n绘制者')
  const canonical = canonicalBody(options)
  const bytes = Buffer.from(canonical.body, 'utf8')

  assert.equal(canonical.bytes, bytes.length)
  assert.equal(canonical.slots.length, 3, 'one system slot and one per message')

  for (const slot of canonical.slots) {
    const slice = bytes.subarray(slot.start, slot.end).toString('utf8')
    // Parsed back rather than compared raw: the slice is the *escaped* form, and
    // asserting on the escaped form would let a writer that forgot to escape
    // pass by agreeing with itself.
    assert.equal(
      JSON.parse(`"${slice}"`),
      slot.text,
      `slot ${String(slot.message)} does not cut back to its own text`,
    )
  }

  // Byte offsets, not character offsets. `你是爱衣。` is 5 characters and 15
  // bytes, so a writer that counted characters would put the first message's
  // slot ten bytes early — and every offset after it too.
  const system = canonical.slots.find(slot => slot.message === -1)
  assert.ok(system !== undefined)
  assert.equal(system.end - system.start, Buffer.byteLength('你是爱衣。', 'utf8'))
  assert.equal(system.end - system.start, 15)
})

test('the route is not in the hash, so switching models is not a prompt change', () => {
  /*
   * The 2026-09-08 correction. The canonical body used to open with
   * `{"provider":…,"model":…`, and the prefix window is the first 4 096 bytes of
   * that string — so a model switch moved `prefixHash` while the prompt was
   * untouched, and the switch read as "the head of the prompt changed". The
   * composer can switch model per conversation, so this is a shape the user
   * produces, not a hypothetical.
   *
   * A cache does live on one model, so a route change is a real and sufficient
   * reason for a miss. It is reported as a *route* change — the trace's own
   * `model` / `provider` fields, which `divergenceOf` carries through — and not
   * as bytes moving.
   */
  const prompt = { system: '一模一样的提示词', first: 'q', second: 'a' } as const
  const here = request(prompt.system, prompt.first, prompt.second)
  const elsewhere: GenerateOptions = { ...here, provider: 'other', model: 'other-model' }

  assert.equal(serialiseRequest(here), serialiseRequest(elsewhere))
  assert.deepEqual(fingerprintBody(serialiseRequest(here)), fingerprintBody(serialiseRequest(elsewhere)))
  assert.equal(serialiseRequest(here).startsWith('{"system":'), true, 'the body opens on the prompt')
  assert.equal(serialiseRequest(here).includes('test-model'), false, 'no route in the hashed bytes')
})

test('a route change is reported as a route change, beside identical bytes', () => {
  const side = {
    system: '一模一样',
    first: 'q',
    second: 'a',
    segments: [{ id: 'main', text: '一模一样' }],
    ids: ['history.0', 'history.1'],
  }
  const [previous, current] = pair(side, side)
  const switched: CacheTraceFile = { ...current, model: 'deepseek-chat', provider: 'deepseek' }
  const row = divergenceOf(previous, switched)

  // Not one byte moved, and the request could still not hit — which is a
  // complete answer, and one no byte comparison can give.
  assert.equal(row.divergedAt, switched.bytes)
  assert.equal(row.uncacheableBytes, 0)
  assert.equal(row.previousModel, previous.model)
  assert.equal(row.model, 'deepseek-chat')
  assert.notEqual(row.model, row.previousModel)
})

test('a request with no system slot records null and no system span', () => {
  const options: GenerateOptions = {
    provider: 'test',
    model: 'test-model',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
  }
  const canonical = canonicalBody(options)
  assert.equal(canonical.body, reference(options))
  assert.ok(canonical.body.includes('"system":null'))
  assert.deepEqual(canonical.slots.map(slot => slot.message), [0])
})

/** A layout describing one system segment per text, and one part per message. */
function layoutFor(segments: readonly { id: string, text: string }[], roles: readonly ('user' | 'assistant' | 'system')[], texts: readonly string[]): PromptLayout {
  return {
    system: segments.map(segment => ({ ...segment })),
    messages: roles.map((role, index) => ({
      parts: [{ id: `slot.${String(index)}`, text: texts[index] as string }],
      role,
    })),
  }
}

test('spans are disjoint, ascending, and cover every text byte', () => {
  const first = '第一段：稳定的世界观'
  const second = '第二段'
  const options = request(`${first}\n\n${second}`, '早上好', '你好')
  const canonical = canonicalBody(options)
  const layout = layoutFor(
    [{ id: 'main', text: first }, { id: 'worldInfoAfter', text: second }],
    ['user', 'assistant'],
    ['早上好', '你好'],
  )

  const { spans, attributed } = spansOf(canonical, layout)
  assert.equal(attributed, true)
  assert.equal(spans.length, 4, 'two system segments and two messages')

  // Disjoint and ascending, asserted as a walk rather than as a set property:
  // the failure this catches is an off-by-one overlap, which a set of unique
  // ids would not notice.
  let cursor = -1
  for (const span of spans) {
    assert.ok(span.start >= cursor, `span ${span.id} starts before the previous one ended`)
    assert.ok(span.end > span.start, `span ${span.id} is empty`)
    cursor = span.end
  }

  // Coverage, stated exactly rather than as "almost all of it". The spans cover
  // every text byte **except the separators the renderer put between segments**:
  // `renderSystem` joins with a blank line, and that blank line is not any
  // segment's text. Four bytes here, because `\n\n` escapes to `\\n\\n`.
  //
  // The equality is written with the separator term on the left rather than
  // subtracted from the right, so a change that started attributing separators
  // fails loudly instead of shifting a tolerance.
  const covered = spans.reduce((total, span) => total + (span.end - span.start), 0)
  const inSlots = canonical.slots.reduce((total, slot) => total + (slot.end - slot.start), 0)
  const separators = (layout.system.length - 1) * '\\n\\n'.length
  assert.equal(covered + separators, inSlots)
  assert.equal(separators, 4, 'one blank line between two segments, escaped')
  assert.ok(inSlots > 0, 'the fixture must actually carry text, or the equality above is 0 === 0')
})

test('a system segment cut at its span is that segment, not its neighbour', () => {
  // Deliberately different lengths: two equal-length segments would agree at the
  // wrong offsets, which is the shape of the bug this exists to catch.
  const first = '短'
  const second = '长得多的一段文字，用来把偏移推开'
  const options = request(`${first}\n\n${second}`, 'x', 'y')
  const bytes = Buffer.from(canonicalBody(options).body, 'utf8')
  const { spans } = spansOf(
    canonicalBody(options),
    layoutFor([{ id: 'main', text: first }, { id: 'jailbreak', text: second }], ['user', 'assistant'], ['x', 'y']),
  )

  const cut = (id: string): string => {
    const span = spans.find(row => row.id === id)
    assert.ok(span !== undefined, `no span for ${id}`)
    return JSON.parse(`"${bytes.subarray(span.start, span.end).toString('utf8')}"`) as string
  }
  assert.equal(cut('main'), first)
  assert.equal(cut('jailbreak'), second)
})

test('a squashed run is subdivided, and a run that does not reconstruct is refused', () => {
  const parts = ['注入一', '注入二的内容更长一点']
  /*
   * The merged slot comes out of the driver's **own** squash rather than out of
   * a join written here. `spansOf` has to lay the parts back down with the same
   * separator the squash used — upstream's one newline (`openai.js:3846`), not
   * the blank line `renderSystem` puts between system sections — and the two are
   * written out in both places on purpose. A fixture that joined the parts
   * itself would agree with a stale reader: producer and consumer both green
   * while the hand-copy between them used the other separator, which is exactly
   * the seam this test sits on. This is also why it merged with `\n\n` before
   * #32 corrected the driver, and why nothing went red then.
   */
  const slots = squashSystemRuns(slotsOf(
    parts.map((text, index) => ({ role: 'system' as const, text, id: `script.${String(index)}` })),
  ))
  assert.equal(slots.length, 1, 'the two system messages did not merge, so nothing here is a squashed run')
  const run = slots[0] as AssembledSlot
  const merged = run.message.text
  assert.equal(run.parts.length, 2, 'a merged run must carry both parts, or the subdivision has nothing to do')
  const options = request('系统段', merged, '回复')
  const canonical = canonicalBody(options)

  const squashed: PromptLayout = {
    system: [{ id: 'main', text: '系统段' }],
    messages: [
      { parts: run.parts.map(part => ({ ...part })), role: 'system' },
      { parts: [{ id: 'history.1', text: '回复' }], role: 'assistant' },
    ],
  }
  const good = spansOf(canonical, squashed)
  assert.equal(good.attributed, true)
  assert.deepEqual(
    good.spans.map(span => span.id),
    ['main', 'script.0', 'script.1', 'history.1'],
    'a merged run must still name each injection inside it',
  )

  // A template rewrote the slot after the layout was recorded: the parts no
  // longer lay back down onto it. The trace must say so rather than emit
  // offsets that are confidently wrong, which is the one output that would make
  // a reader distrust every other line.
  const stale: PromptLayout = {
    system: [{ id: 'main', text: '系统段' }],
    messages: [
      { parts: [{ id: 'script.0', text: '注入一' }, { id: 'script.1', text: 'something else entirely' }], role: 'system' },
      { parts: [{ id: 'history.1', text: '回复' }], role: 'assistant' },
    ],
  }
  const bad = spansOf(canonical, stale)
  assert.equal(bad.attributed, false)
  assert.match(bad.note ?? '', /does not reconstruct/)
  // And it still attributes the slot whole, to the first part: a reader gets a
  // coarse answer plus a warning, rather than nothing.
  assert.deepEqual(bad.spans.map(span => span.id), ['main', 'script.0', 'history.1'])
})

test('a request with no layout is recorded and marked unattributed', () => {
  const options = request('系统段', 'x', 'y')
  const trace = traceOf(options, { chatId: 'c', kind: 'script.generateRaw', turn: -1 }, 1000)
  assert.equal(trace.attributed, false)
  assert.equal(trace.spans.length, 0)
  assert.equal(trace.coveredBytes, 0)
  // The body is still kept: an unattributed trace still answers "did the bytes
  // change", which is the older and more important half of the question.
  assert.equal(trace.body, serialiseRequest(options))
  assert.match(trace.attributionNote ?? '', /no layout/)
})

/** Two traces of one conversation, built from bodies rather than described. */
function pair(
  before: { system: string, first: string, second: string, segments: readonly { id: string, text: string }[], ids: readonly string[] },
  after: { system: string, first: string, second: string, segments: readonly { id: string, text: string }[], ids: readonly string[] },
): [CacheTraceFile, CacheTraceFile] {
  const build = (side: typeof before, seq: number): CacheTraceFile => {
    const options = request(side.system, side.first, side.second)
    const layout: PromptLayout = {
      system: side.segments.map(segment => ({ ...segment })),
      messages: [
        { parts: [{ id: side.ids[0] as string, text: side.first }], role: 'user' },
        { parts: [{ id: side.ids[1] as string, text: side.second }], role: 'assistant' },
      ],
    }
    return { ...traceOf({ ...options, layout }, { chatId: 'c', kind: 'send', turn: seq }, 1000 + seq), seq }
  }
  return [build(before, 0), build(after, 1)]
}

test('the divergence offset is the first differing byte, and the four terms sum exactly', () => {
  const stable = '稳定的世界观，逐字不变'
  const depth = '变量表：当前时间 08:00'
  const [previous, current] = pair(
    {
      system: `${stable}\n\n${depth}`,
      first: '第一轮提问',
      second: '第一轮回复',
      segments: [{ id: 'main', text: stable }, { id: 'worldInfo.depth.0.0', text: depth }],
      ids: ['history.0', 'history.1'],
    },
    {
      // Same stable head, a changed depth block, and a longer conversation.
      system: `${stable}\n\n变量表：当前时间 09:30`,
      first: '第二轮提问，更长一些',
      second: '第二轮回复',
      segments: [{ id: 'main', text: stable }, { id: 'worldInfo.depth.0.0', text: '变量表：当前时间 09:30' }],
      ids: ['history.0', 'history.1'],
    },
  )

  const row = divergenceOf(previous, current)

  // The first differing byte is inside the depth block, not at the start of the
  // body: the stable head is byte-identical and the offsets must show that.
  assert.ok(row.divergedAt > 0)
  assert.equal(row.divergedIn?.id, 'worldInfo.depth.0.0')

  // Verified against the bodies rather than trusted: this is the one number the
  // whole record rests on, and it is cheap to check twice.
  const before = Buffer.from(previous.body, 'utf8')
  const after = Buffer.from(current.body, 'utf8')
  assert.ok(before.subarray(0, row.divergedAt).equals(after.subarray(0, row.divergedAt)))
  assert.notEqual(before[row.divergedAt], after[row.divergedAt])

  assert.equal(row.uncacheableBytes, current.bytes - row.divergedAt)

  /*
   * **The part the divergence lands inside is charged only from that byte on.**
   * The depth block's leading `变量表：当前时间 0` is identical on both sides, so
   * those bytes were served; only the tail was not.
   *
   * Counting the straddled part whole is the plausible wrong implementation, and
   * it is invisible to every total-based check: it moves bytes from
   * `structureBytes` into `changedBytes` and the four terms still sum. This
   * fixture is the one place a straddle is guaranteed — the end-to-end test's
   * divergence lands in JSON framing — so the assertion belongs here.
   */
  const landed = row.items.find(item => item.id === row.divergedIn?.id)
  assert.ok(landed !== undefined)
  assert.ok(landed.uncachedBytes > 0, 'the tail of the straddled part is unservable')
  assert.ok(
    landed.uncachedBytes < landed.bytes,
    `the straddled part is charged whole (${String(landed.uncachedBytes)} of ${String(landed.bytes)}) rather than from the divergence on`,
  )
  // Exact, and this is the assertion §1.2 of CACHE-PREFIX.md could not make: its
  // two-term split left a few hundred bytes unexplained, and a reader who adds
  // these up has to get the total.
  assert.equal(
    row.addedBytes + row.changedBytes + row.repeatedBytes + row.structureBytes,
    row.uncacheableBytes,
  )
  assert.ok(row.structureBytes >= 0, 'framing cannot be negative; a span outside the body would make it so')
})

test('a part that did not change is still charged for, when it sits after the divergence', () => {
  // The measured shape, and the reason the record exists: `爱衣`'s depth-0 block
  // is byte-identical every turn and unservable every turn, 51%–76% of the loss
  // on five of nine adjacent pairs. A report that only asked "what changed"
  // would call this section innocent.
  const stable = '稳定的世界观'
  const depth = '逐字不变的深度注入，很长的一段'
  const [previous, current] = pair(
    {
      system: `${stable}\n\n${depth}`,
      first: '第一轮',
      second: '短回复',
      segments: [{ id: 'main', text: stable }, { id: 'worldInfo.depth.0.0', text: depth }],
      ids: ['history.0', 'history.1'],
    },
    {
      // Only the *system head* changed; the depth block is identical.
      system: `${stable}改了一个字\n\n${depth}`,
      first: '第一轮',
      second: '短回复',
      segments: [{ id: 'main', text: `${stable}改了一个字` }, { id: 'worldInfo.depth.0.0', text: depth }],
      ids: ['history.0', 'history.1'],
    },
  )

  const row = divergenceOf(previous, current)
  const stranded = row.items.find(item => item.id === 'worldInfo.depth.0.0')
  assert.ok(stranded !== undefined)
  assert.equal(stranded.state, 'same', 'its bytes are identical to last turn')
  assert.equal(
    stranded.uncachedBytes,
    stranded.bytes,
    'and every one of them is after the divergence, so none of them can be served',
  )
  assert.ok(row.repeatedBytes >= stranded.bytes)
})

test('a part that vanished is listed, and one that arrived is marked new', () => {
  const [previous, current] = pair(
    {
      system: '甲\n\n乙',
      first: 'q',
      second: 'a',
      segments: [{ id: 'main', text: '甲' }, { id: 'worldInfoBefore', text: '乙' }],
      ids: ['history.0', 'history.1'],
    },
    {
      system: '甲\n\n丙',
      first: 'q',
      second: 'a',
      segments: [{ id: 'main', text: '甲' }, { id: 'worldInfoAfter', text: '丙' }],
      ids: ['history.0', 'history.1'],
    },
  )
  const row = divergenceOf(previous, current)
  const states = new Map(row.items.map(item => [item.id, item.state]))
  assert.equal(states.get('worldInfoBefore'), 'gone')
  assert.equal(states.get('worldInfoAfter'), 'added')
  assert.equal(states.get('main'), 'same')
  // A part that is gone costs nothing now, so it must not be counted into the
  // loss — a `gone` row inflating `addedBytes` would double-count the swap.
  const vanished = row.items.find(item => item.id === 'worldInfoBefore')
  assert.equal(vanished?.uncachedBytes, 0)
  assert.equal(vanished?.bytes, 0)
  assert.ok((vanished?.previousBytes ?? 0) > 0)
})

test('two byte-identical requests diverge at the end, not at the beginning', () => {
  const side = {
    system: '一模一样',
    first: 'q',
    second: 'a',
    segments: [{ id: 'main', text: '一模一样' }],
    ids: ['history.0', 'history.1'],
  }
  const [previous, current] = pair(side, side)
  const row = divergenceOf(previous, current)
  // `divergedAt === bytes` is how "nothing changed" has to read, because the
  // alternative — a sentinel like `-1` — would make every consumer's arithmetic
  // (`bytes - divergedAt`) produce a loss where there is none.
  assert.equal(row.divergedAt, current.bytes)
  assert.equal(row.uncacheableBytes, 0)
  assert.equal(row.repeatedBytes, 0)
  assert.equal(row.divergedIn, undefined)
  assert.ok(row.items.every(item => item.state === 'same'))
})

test('an interrupted trace records no usage and no zeroes, and the comparison carries the error', () => {
  /*
   * The 2026-09-09 shape, from the report side in. A reply the provider cut
   * short reports no usage — the usage chunk rides the end of the stream and
   * never arrived — and a trace must record that as an *absence*, not as zero,
   * or a reader comparing two adjacent turns would mistake an interrupted turn
   * for a free one. The error field is what says the absence is real.
   */
  const options = request('你是爱衣。', '第一轮提问', '第一轮回复')
  const layout: PromptLayout = {
    system: [{ id: 'main', text: '你是爱衣。' }],
    messages: [
      { parts: [{ id: 'history.0', text: '第一轮提问' }], role: 'user' },
      { parts: [{ id: 'history.1', text: '第一轮回复' }], role: 'assistant' },
    ],
  }
  const before = { ...traceOf({ ...options, layout }, { chatId: 'c', kind: 'send', turn: 0 }, 1000, {
    inputTokens: 100,
    cacheReadTokens: 50,
  }), seq: 0 }
  const interrupted = {
    ...traceOf(
      { ...options, layout },
      { chatId: 'c', kind: 'send', turn: 1 },
      2000,
      // No usage object at all — the turn never reached the end of the stream.
      undefined,
      'connection to http://127.0.0.1:1/v1/chat/completions was closed by the peer while the reply was streaming; no usage was reported for this turn',
    ),
    seq: 1,
  }
  const next = { ...traceOf({ ...options, layout }, { chatId: 'c', kind: 'send', turn: 2 }, 3000, {
    inputTokens: 120,
    cacheReadTokens: 60,
  }), seq: 2 }
  assert.equal('error' in interrupted, true, 'the trace file carries the failure verbatim')
  assert.match(interrupted.error as string, /closed by the peer|no usage was reported/iu)

  // The comparison copies the newer request's error the same way it copies its
  // usage figures — a reader of this pair sees that the turn it is looking at
  // never finished, so its absent numbers are the absence of a bill, not a zero.
  const row = divergenceOf(before, interrupted)
  assert.equal(row.error, interrupted.error)
  assert.equal(row.inputTokens, undefined)
  assert.equal(row.cacheReadTokens, undefined)
  // And the excuse answers "why nothing was served" without sending a reader
  // hunting for a prompt defect in a request that was never answered.
  assert.equal(providerExcuse(row), 'interrupted')

  // A healthy turn that follows the interrupted one is an ordinary pair again:
  // the interruption is the interrupted turn's own fact, not a property the
  // conversation carries.
  const after = divergenceOf(interrupted, next)
  assert.equal(after.error, undefined)
  assert.equal(after.inputTokens, 120)
  assert.equal(after.cacheReadTokens, 60)
})

test('the store keeps the newest N and deletes only its own files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-trace-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const store = new CacheTraceStore(dir, { keep: 3 })

  const options = request('系统', 'q', 'a')
  for (let index = 0; index < 6; index += 1) {
    const seq = await store.write(traceOf(options, { chatId: 'chat-a', kind: 'send', turn: index }, index))
    assert.equal(seq, index, 'sequence numbers are assigned in order')
  }

  assert.deepEqual(await store.list('chat-a'), [3, 4, 5])

  // Nothing the store did not write is touched, and no temporary file survives —
  // a `.tmp` left behind would be a body on disk that no rotation ever removes.
  await writeFile(join(dir, 'chat-a', 'notes.txt'), 'mine', 'utf8')
  await store.write(traceOf(options, { chatId: 'chat-a', kind: 'send', turn: 6 }, 6))
  const names = (await readdir(join(dir, 'chat-a'))).sort()
  assert.deepEqual(names, ['4.json', '5.json', '6.json', 'notes.txt'])

  // One conversation's rotation does not reach another's.
  await store.write(traceOf(options, { chatId: 'chat-b', kind: 'send', turn: 0 }, 0))
  assert.deepEqual(await store.list('chat-b'), [0])
  assert.deepEqual(await store.list('chat-a'), [4, 5, 6])
})

test('a retention of zero records nothing at all', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-trace-off-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const store = new CacheTraceStore(dir, { keep: 0 })

  assert.equal(store.enabled, false)
  assert.equal(await store.write(traceOf(request('系统', 'q', 'a'), { chatId: 'c', kind: 'send', turn: 0 }, 1)), undefined)
  // Not even the directory: a switch that still created the folder would leave a
  // reader unable to tell "off" from "nothing sent yet".
  await assert.rejects(readdir(join(dir, 'c')))
  assert.deepEqual(await store.list('c'), [])
  assert.equal(await store.divergence('c'), undefined)
})

test('a chat id cannot name a file outside the trace directory', async (t) => {
  // The store is given a **subdirectory** of the temporary tree rather than the
  // tree itself, so the escape this looks for lands somewhere the fixture owns
  // and `t.after` deletes. Pointing it at `tmpdir()` directly would, when the
  // guard is broken, leave a stray directory in the machine's temp folder that
  // no cleanup removes — and every later run of this test would then fail on
  // debris from an earlier one. (Measured: it did.)
  const root = await mkdtemp(join(tmpdir(), 'iris-trace-guard-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const dir = join(root, 'cache-trace')
  const store = new CacheTraceStore(dir, { keep: 4 })

  // The id reaches this process from a browser. `list` answers empty for a
  // refused id — a read of nowhere is nothing — and `write` swallows the
  // refusal, because a trace must never fail a generation. What must not happen
  // is a file appearing outside `dir`.
  for (const hostile of ['../escape', 'a/b', 'c:\\x']) {
    assert.deepEqual(await store.list(hostile), [], `list accepted ${hostile}`)
    assert.equal(await store.write(traceOf(request('s', 'q', 'a'), { chatId: hostile, kind: 'send', turn: 0 }, 1)), undefined)
  }
  // Written after the hostile ids, so the directory the check reads exists for a
  // legitimate reason and an empty listing cannot pass by accident.
  await store.write(traceOf(request('s', 'q', 'a'), { chatId: 'ordinary', kind: 'send', turn: 0 }, 1))
  assert.deepEqual((await readdir(dir)).sort(), ['ordinary'], 'something other than a chat directory was created')
  assert.deepEqual(await readdir(root), ['cache-trace'], 'a trace escaped the trace directory')
})

test('a file from another version is refused rather than read with today\'s meanings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-trace-version-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const store = new CacheTraceStore(dir, { keep: 4 })
  await mkdir(join(dir, 'c'), { recursive: true })
  await writeFile(join(dir, 'c', '0.json'), JSON.stringify({ version: 99, body: '{}', spans: [] }), 'utf8')

  assert.deepEqual(await store.list('c'), [0], 'the file is there')
  assert.equal(await store.read('c', 0), undefined, 'and it is not read')
})

// ------------------------------------------------------- through the real host

/** A stream that answers once and reports a cache figure. */
function scripted(cacheRead: number): StreamFn {
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'A reply.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'A reply.' } }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 4, cacheReadTokens: cacheRead } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  traces: CacheTraceStore
  dir: string
  settled: () => Promise<void>
}

async function fixture(t: TestContext, keep = 8): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-trace-host-'))
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
  const traces = new CacheTraceStore(join(dir, 'cache-trace'), { keep })
  let ends = 0
  let waited = 0

  const handlers = new IrisAppService({
    stream: scripted(64),
    library,
    chats,
    settings,
    worldbooks,
    cacheTrace: traces,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  // Selected BEFORE the chat is created: the store reads the selection through a
  // closure when a chat opens, so a book chosen afterwards reaches this
  // conversation only on the next open — and the fixture would then be
  // measuring an assembly with no world info in it at all, which is exactly the
  // mistake `assembly-determinism.test.ts` records having made.
  await handlers['worldbook.setGlobalSelect']({ names: ['atlas'] })

  return {
    handlers,
    chats,
    traces,
    dir,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

test('two real turns leave two traces whose spans cut back to their own text', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['chat.send']({ chatId, text: '早上好' })
  await fix.settled()
  await fix.handlers['chat.send']({ chatId, text: '今天天气怎么样' })
  await fix.settled()

  const seqs = await fix.traces.list(chatId)
  assert.deepEqual(seqs, [0, 1], `expected two traces, got ${seqs.join(', ')}`)

  // The end-to-end property: the map the driver recorded, carried through the
  // template pass and the serialiser, still cuts the body into its own parts.
  // Every unit test above builds its own layout; this one is the only place the
  // real `assemble` → `injectAtDepth` → `layoutOf` → `canonicalBody` chain is
  // asserted, and it is the chain that would break silently.
  let checked = 0
  for (const seq of seqs) {
    const trace = await fix.traces.read(chatId, seq)
    assert.ok(trace !== undefined)
    assert.equal(trace.attributed, true, `trace ${String(seq)}: ${trace.attributionNote ?? ''}`)
    assert.equal(trace.kind, 'send')
    assert.equal(trace.model, 'test-model')
    assert.equal(trace.cacheReadTokens, 64, 'the provider figure rides on the same record')
    assert.equal(trace.inputTokens, 100)
    assert.ok(trace.spans.length > 0)

    const bytes = Buffer.from(trace.body, 'utf8')
    assert.equal(bytes.length, trace.bytes)
    assert.equal(
      trace.coveredBytes,
      trace.spans.reduce((total, span) => total + (span.end - span.start), 0),
      'the stored covered figure must be the spans it was computed from',
    )

    let cursor = -1
    for (const span of trace.spans) {
      assert.ok(span.start >= cursor, `trace ${String(seq)}: span ${span.id} overlaps its predecessor`)
      cursor = span.end
      const text = JSON.parse(`"${bytes.subarray(span.start, span.end).toString('utf8')}"`) as string
      assert.equal(typeof text, 'string')
      assert.ok(span.end <= trace.bytes, `trace ${String(seq)}: span ${span.id} runs past the body`)
      checked += 1
    }
    // The floors are named one by one, which is what makes two turns comparable
    // at the floor level rather than as "the conversation".
    assert.ok(
      trace.spans.some(span => span.kind === 'history'),
      `trace ${String(seq)} named no floor among ${trace.spans.map(span => span.id).join(', ')}`,
    )
    // And so are the depth injections — the placement this whole record exists
    // for. Asserted as a presence check on the *fixture* as much as on the code:
    // a fixture with no depth injection cannot show whether one can be named,
    // and the first version of this file had exactly that fixture.
    assert.ok(
      trace.spans.some(span => span.kind === 'depth'),
      `trace ${String(seq)} named no depth injection among ${trace.spans.map(span => span.id).join(', ')}`,
    )
    assert.ok(
      trace.spans.some(span => span.kind === 'system'),
      `trace ${String(seq)} named no system section`,
    )
  }
  // The loop's own sample size, asserted as a floor: a `continue` that skipped
  // every span would leave every assertion above unexecuted and this test green.
  assert.ok(checked >= 4, `only ${String(checked)} spans were checked`)
})

test('the second turn diverges at the new floor, and the host reports it', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['chat.send']({ chatId, text: '早上好' })
  await fix.settled()
  await fix.handlers['chat.send']({ chatId, text: '今天天气怎么样' })
  await fix.settled()

  const { divergence } = await fix.handlers['prompt.divergence']({ chatId })
  assert.ok(divergence !== undefined, 'two traces exist, so there is a comparison')
  assert.equal(divergence.chatId, chatId)
  assert.equal(divergence.seq, 1)
  assert.equal(divergence.previousSeq, 0)
  assert.equal(divergence.attributed, true)

  // The character card and the preset are byte-identical between the two turns,
  // so the divergence has to be past them — in the conversation. A divergence at
  // 0 would mean the host is jittering something in its own head matter, which
  // is the defect this instrument exists to detect and must not itself produce.
  assert.ok(divergence.divergedAt > 0, 'the head matter must be byte-stable across turns')
  assert.equal(divergence.addedBytes + divergence.changedBytes + divergence.repeatedBytes + divergence.structureBytes,
    divergence.uncacheableBytes)

  // The provider's own figure travels with it: the whole point of the pairing is
  // that a reader can see the ceiling and what was actually served side by side.
  assert.equal(divergence.cacheReadTokens, 64)
  assert.equal(divergence.inputTokens, 100)

  const added = divergence.items.filter(item => item.state === 'added')
  assert.ok(added.length > 0, 'the second turn added floors and they must be listed as new')
  assert.ok(
    added.every(item => item.previousBytes === 0),
    'a part reported as new cannot also have had bytes last turn',
  )

  /*
   * **A floor keeps its id from one turn to the next.** This is the property the
   * whole item-by-item alignment rests on and the one that fails silently: an
   * id counted from the *end* of the conversation renumbers every floor on every
   * turn, so nothing ever matches, every floor reads as new, and the loss splits
   * into `addedBytes` — a report that looks complete and blames the wrong thing.
   * The opening greeting is byte-identical across these two turns, so `same` is
   * the only correct reading of it.
   */
  const states = new Map(divergence.items.map(item => [item.id, item.state]))
  assert.equal(states.get('history.0'), 'same', `floor ids are not stable: ${[...states.keys()].join(', ')}`)
  assert.equal(states.get('history.1'), 'same')

  // The depth-0 world-info entry: identical bytes, and entirely after the newest
  // floor, so not one byte of it can be served. The measured shape, asserted on
  // a real assembly rather than on a hand-built fixture.
  const stranded = divergence.items.filter(item => item.state === 'same' && item.uncachedBytes > 0)
  assert.ok(
    stranded.some(item => item.kind === 'depth'),
    `no unchanged depth injection was charged for: ${divergence.items.map(item => `${item.id}=${item.state}/${String(item.uncachedBytes)}`).join(' ')}`,
  )
  assert.ok(
    stranded.every(item => item.uncachedBytes === item.bytes),
    'a depth injection sits wholly after the divergence, so all of its bytes are unservable',
  )

  /*
   * Where the divergence lands on *this* fixture: in the JSON framing, not in a
   * part. Both turns' system sections and depth injections are byte-identical,
   * so the first difference is at the message boundary where the second turn's
   * new floor begins — inside `"role":"user","text":"`, which belongs to no
   * contribution.
   *
   * Asserted rather than left open, because the alternative reading of an
   * absent `divergedIn` is "the mapping failed to find it", and those are
   * opposite facts. The partial-charging rule that applies when a divergence
   * *does* land inside a part is asserted in the unit test above, on a fixture
   * that guarantees the straddle.
   */
  assert.equal(divergence.divergedIn, undefined)
  assert.ok(divergence.structureBytes > 0, 'the framing before a new floor is unservable and belongs to no part')
})

test('one turn is not a pair, and the answer is absence rather than a refusal', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // Before anything is sent.
  assert.deepEqual(await fix.handlers['prompt.divergence']({ chatId }), {})

  await fix.handlers['chat.send']({ chatId, text: '早上好' })
  await fix.settled()

  // And after exactly one request: one trace, still no pair.
  assert.deepEqual(await fix.traces.list(chatId), [0])
  assert.deepEqual(await fix.handlers['prompt.divergence']({ chatId }), {})
})

test('a card\'s own generation is recorded too, labelled as not a turn', async (t) => {
  /*
   * The gap this closes. `#sideGenerate` and `#generateRaw` call `#stream` with
   * **no `entry`**, and `noteUsage` / `notePromptFingerprint` / `noteRoute` are
   * all guarded on `entry?.pending?.turn` — so a card that fires one of these
   * every turn (MVU does) spends the user's tokens and appears on no page at
   * all. It is billed, it goes to the same provider on the same route, and it
   * lands *between* two turns' traces: a reader comparing adjacent sequence
   * numbers would otherwise meet a request nobody sent.
   *
   * `turn: -1` is asserted rather than assumed. Folding a card's request onto
   * whatever turn happened to be pending would file it against the user's own,
   * and the two costs would then be one number.
   */
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await fix.handlers['chat.send']({ chatId, text: '早上好' })
  await fix.settled()
  await fix.handlers['script.generate']({ chatId, userInput: '在旁边算一件事' })
  await fix.handlers['script.generateRaw']({ chatId, prompt: '只发这一句' })

  const traces = await fix.traces.list(chatId)
  assert.deepEqual(traces, [0, 1, 2], `the two side generations were not recorded: ${traces.join(', ')}`)

  const assembled = await fix.traces.read(chatId, 1)
  assert.ok(assembled !== undefined)
  assert.equal(assembled.kind, 'side')
  assert.equal(assembled.caller, 'script.generate')
  assert.equal(assembled.turn, -1)
  // `script.generate` assembles the preset, the world info and the history, so
  // its bytes *can* be attributed — and are, which is what makes a card's own
  // request comparable with a turn's rather than a black box beside it.
  assert.equal(assembled.attributed, true, assembled.attributionNote ?? '')
  assert.ok(assembled.spans.some(span => span.id === 'script.userInput'), 'the card\'s prompt is named')

  const raw = await fix.traces.read(chatId, 2)
  assert.ok(raw !== undefined)
  assert.equal(raw.kind, 'side')
  assert.equal(raw.caller, 'script.generateRaw')
  // `generateRaw` sends only what it was handed — no assembly, so no layout, so
  // no attribution. Recorded and marked, rather than recorded and trusted.
  assert.equal(raw.attributed, false)
  assert.match(raw.attributionNote ?? '', /no layout/)
  assert.ok(raw.body.length > 0, 'the bytes are kept even when they cannot be attributed')
})

test('a host with no trace store answers with no comparison rather than failing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-trace-none-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const handlers = new IrisAppService({
    stream: scripted(0),
    library,
    chats,
    settings,
    broadcast: () => {},
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  assert.deepEqual(await handlers['prompt.divergence']({ chatId: created.view.chatId }), {})
  // And nothing was written where a store would have written: a host without one
  // must not create the directory as a side effect of being asked.
  await assert.rejects(readFile(join(dir, 'cache-trace', created.view.chatId, '0.json'), 'utf8'))
})

// ------------------------------------------------- an interrupted turn, in full

/**
 * A stream that writes a reply and then fails the way the adapter reports a
 * peer closing the connection mid-stream.
 *
 * What reaches the host is the adapter's `TRANSPORT` `LlmError` — shaped after
 * the sentence the fix in `packages/iris-llm-openai-compat/src/index.ts` writes
 * in place of undici's bare `TypeError: terminated`. Some text has already been
 * written, and no usage chunk has: the usage rides the end of the stream, which
 * the peer never reached. This is the whole interrupted-turn shape in one
 * injected stream, asserted end to end.
 */
function interruptingStream(): StreamFn {
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '*The map rustles, and then' }
    throw new LlmError(
      'connection to http://endpoint/v1/chat/completions was closed by the peer while the reply was streaming; '
      + 'no usage was reported for this turn',
      'TRANSPORT',
    )
  }
}

test('an interrupted turn records the failure on the trace, and never a zero for the usage it was not given', async (t) => {
  /*
   * The whole path the 2026-09-09 report was missing, in one turn. Measured on
   * the user's own host, a saved profile whose replies were all cut short left
   * five traces with `provider: 'deepseek'` and **no** `inputTokens` /
   * `cacheReadTokens`, while the report panel showed the bare word `terminated`
   * and the trace said nothing about the turn having failed. A reader comparing
   * adjacent sequence numbers would have read an interrupted turn as a free one.
   *
   * This pins the record side: the error the report shows is the error the trace
   * keeps, and the absent usage stays absent — zero would be a measurement of a
   * bill that never arrived.
   */
  const dir = await mkdtemp(join(tmpdir(), 'iris-trace-interrupted-'))
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
  const errors: IrisEvent[] = []
  const handlers = new IrisAppService({
    stream: interruptingStream(),
    library,
    chats,
    settings,
    worldbooks,
    cacheTrace: traces,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.error') errors.push(event) },
    userName: 'Traveller',
  }).handlers()
  await handlers['worldbook.setGlobalSelect']({ names: ['atlas'] })

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: '早上好' })

  // The report panel gets the readable sentence — the fix in the adapter — and
  // never the bare word it used to broadcast verbatim.
  let failure: Extract<IrisEvent, { type: 'stream.error' }> | undefined
  for (let waited = 0; waited < 200 && failure === undefined; waited += 1) {
    failure = errors[0] as Extract<IrisEvent, { type: 'stream.error' }> | undefined
    if (failure === undefined) await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.ok(failure !== undefined, 'no stream.error was broadcast')
  assert.equal(failure.code, 'provider-error', 'a mid-stream peer close is a provider error, not a timeout and not an abort')
  assert.notEqual(failure.message, 'terminated')
  assert.match(failure.message, /closed by the peer|no usage was reported/iu)

  // The trace that turn left carries the same sentence, and no zero-fill.
  const seqs = await traces.list(chatId)
  assert.deepEqual(seqs, [0], `expected one trace, got ${seqs.join(', ')}`)
  const trace = await traces.read(chatId, 0)
  assert.ok(trace !== undefined)
  assert.equal(trace.error, failure.message, 'the report and the record describe the same failure')
  assert.equal(trace.inputTokens, undefined, 'no input figure was invented')
  assert.equal(trace.cacheReadTokens, undefined, 'no cache figure was invented')
  assert.equal(trace.kind, 'send')
  assert.ok(trace.spans.length > 0, 'the assembled parts are still named')
  assert.ok(trace.body.length > 0, 'the body that was sent is still kept')
  assert.equal(chats.cached(chatId)?.generating, false, 'a failed turn releases the chat')
})
