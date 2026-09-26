/**
 * Branch-segment summaries: the store, and the side call that fills it.
 *
 * Two halves, as the feature has two:
 *
 * - **The store** (`segment-summaries.ts`): a summary is keyed by the segment's
 *   content identity, reads stale once a floor of it is edited or the run
 *   changes, is written once for a prefix every branch shares and found from
 *   each of them, and is forgotten with its conversation.
 * - **The request** (`chat.summarizeSegment`): a side call through `#stream`,
 *   billed on the header as `segmentSummary`, not moving the calibration, sent
 *   only the segment's floors (plus one line of what came before), and stopped
 *   by Stop.
 *
 * The provider here reports usage on every request, and the summary's figures
 * differ from a turn's in every bucket, so a record filed off the wrong request
 * shows as a wrong number rather than as a coincidence.
 *
 * @module @iris/app-service/tests/segment-summaries
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import type { ChatStore } from '../src/chats.ts'
import { matchSegmentSummary, SegmentSummaryStore, segmentIdentity } from '../src/segment-summaries.ts'
import type { IrisAppService, Handlers } from '../src/service.ts'
import { readSideUsage } from '../src/side-usage.ts'
import { createTestService } from './support/service.ts'

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: 'An archivist.', personality: '', scenario: '',
    first_mes: 'The shelves are quiet tonight.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

const TURN_USAGE = { inputTokens: 300, outputTokens: 40, cacheReadTokens: 0 }
const SUMMARY_USAGE = { inputTokens: 1_234, outputTokens: 77, cacheReadTokens: 11 }
const SUMMARY_TEXT = 'Aria shows the traveller the archive. He asks for the map room; she hesitates.'

/** Whether a request is a segment summary: its last message is the directive. */
function isSummary(options: GenerateOptions): boolean {
  return JSON.stringify(options.messages.at(-1)?.content ?? '').includes('summarizer for one stretch')
}

interface Fixture {
  service: IrisAppService
  handlers: Handlers
  chats: ChatStore
  store: SegmentSummaryStore
  dir: string
  /** Every summary request the provider was handed. */
  summaries: GenerateOptions[]
  /** Holds the next summary request open until released or aborted. */
  hold: () => { entered: Promise<void>, release: () => void }
  send: (chatId: string, text: string) => Promise<void>
}

async function fixture(t: TestContext): Promise<Fixture> {
  const summaries: GenerateOptions[] = []
  let ends = 0
  let held: { resolveEntered: () => void, released: Promise<void> } | undefined
  const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    const summary = isSummary(options)
    if (summary) summaries.push(options)
    const text = summary ? SUMMARY_TEXT : `Reply ${String(ends)}.`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (summary && held !== undefined) {
      const gate = held
      held = undefined
      gate.resolveEntered()
      // Held until released, or until the request's own signal stops it —
      // the shape of a real provider mid-stream when Stop lands.
      await new Promise<void>((resolve, reject) => {
        void gate.released.then(resolve)
        options.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: summary ? { ...SUMMARY_USAGE } : { ...TURN_USAGE } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  let store: SegmentSummaryStore | undefined
  const built = await createTestService(t, async ({ dir }) => {
    await mkdir(join(dir, 'characters'), { recursive: true })
    await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
    store = new SegmentSummaryStore(join(dir, 'segment-summaries'))
    return {
      stream,
      segmentSummaries: store,
      broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
      userName: 'Traveller',
    }
  }, 'iris-segment-summaries-')
  assert.ok(store !== undefined)
  return {
    service: built.service,
    handlers: built.handlers,
    chats: built.options.chats,
    store,
    dir: built.dir,
    summaries,
    hold: () => {
      let resolveEntered = (): void => {}
      let release = (): void => {}
      const entered = new Promise<void>(resolve => { resolveEntered = resolve })
      const released = new Promise<void>(resolve => { release = resolve })
      held = { resolveEntered, released }
      return { entered, release }
    },
    send: async (chatId, text) => {
      const waited = ends + 1
      await built.handlers['chat.send']({ chatId, text })
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/**
 * A root of five floors (0–4) and a branch made from floor 2 that wrote two
 * of its own (3–4): segments root 0–2, root 3–4, branch 3–4.
 */
async function forked(f: Fixture): Promise<{ root: string, branch: string }> {
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  await f.send(view.chatId, 'Where are the maps?')
  await f.send(view.chatId, 'And the map room?')
  const { view: branched } = await f.handlers['chat.branch']({ chatId: view.chatId, id: 2 })
  await f.send(branched.chatId, 'Let us go another way.')
  return { root: view.chatId, branch: branched.chatId }
}

test('the tree’s segments are the ones the host summarizes: root 0–2 and 3–4, branch 3–4', async (t) => {
  const f = await fixture(t)
  const { root, branch } = await forked(f)
  // Premise: the graph has the shape the rest of the file assumes.
  const { tree } = await f.handlers['chat.tree']({ chatId: branch })
  assert.deepEqual(tree.chats.map(node => [node.chatId, node.floorCount, node.fork?.shared]), [[root, 5, undefined], [branch, 5, 3]])

  await assert.rejects(
    () => f.handlers['chat.summarizeSegment']({ chatId: root, fromFloor: 0, toFloor: 3 }),
    /not one branch segment/u,
    'a range that is not one segment was summarized',
  )
  assert.equal(f.summaries.length, 0, 'a refused range still reached the provider')
})

test('a summary is billed as side usage and does not move the calibration', async (t) => {
  const f = await fixture(t)
  const { root } = await forked(f)
  // Premise: the turns did feed the calibration, so "unchanged" discriminates.
  const before = f.service.calibration.samples
  assert.ok(before >= 3, `the turns fed the calibration ${String(before)} times`)
  const sideBefore = readSideUsage((await f.chats.open(root)).header).length

  const { summary } = await f.handlers['chat.summarizeSegment']({ chatId: root, fromFloor: 0, toFloor: 2 })
  assert.equal(summary.summary, SUMMARY_TEXT)
  assert.deepEqual([summary.chatId, summary.from, summary.to, summary.stale], [root, 0, 2, false])
  assert.equal(summary.model, 'test-model')

  assert.equal(f.service.calibration.samples, before, 'the segment summary moved the turn calibration')
  const records = readSideUsage((await f.chats.open(root)).header)
  assert.equal(records.length, sideBefore + 1, 'the summary request left no side-usage record')
  const record = records.at(-1)
  assert.ok(record !== undefined)
  assert.equal(record.usage.source, 'segmentSummary', 'filed under the wrong source')
  assert.equal(record.caller, 'chat.summarizeSegment')
  assert.equal(record.usage.inputTokens, SUMMARY_USAGE.inputTokens)
  assert.equal(record.usage.outputTokens, SUMMARY_USAGE.outputTokens)

  // And it reaches the usage page's figure under its own share.
  const { summary: usage } = await f.handlers['usage.summary']({})
  assert.equal(usage.totals.segmentSummary?.turns, 1, 'the usage summary has no segment-summary share')
})

test('only the segment’s floors are sent, with one line of what came before on a later segment', async (t) => {
  const f = await fixture(t)
  const { root, branch } = await forked(f)
  await f.handlers['chat.summarizeSegment']({ chatId: root, fromFloor: 0, toFloor: 2 })
  await f.handlers['chat.summarizeSegment']({ chatId: branch, fromFloor: 3, toFloor: 4 })

  const [first, second] = f.summaries
  assert.ok(first !== undefined && second !== undefined)
  const texts = (options: GenerateOptions): string[] => options.messages.map(message => JSON.stringify(message.content))
  // Root segment: three floors and the directive, no lead-in, no system prompt.
  assert.equal(first.system, undefined, 'the conversation’s system prompt was sent')
  assert.equal(first.messages.length, 4)
  assert.ok(texts(first)[0]?.includes('The shelves are quiet tonight.'), 'the greeting is not the first floor sent')
  // Branch segment: the lead-in, its two floors, the directive — and nothing of floors 0–2.
  assert.equal(second.messages.length, 4)
  const lead = texts(second)[0] ?? ''
  assert.ok(lead.includes('begins at message 3'), `no lead-in: ${lead}`)
  assert.ok(lead.includes('Aria shows the traveller the archive.'), 'the lead-in does not carry the earlier segment’s summary')
  assert.ok(!texts(second).slice(1).some(text => text.includes('Where are the maps?')), 'a floor before the segment was sent')
  assert.ok(texts(second)[1]?.includes('Let us go another way.'), 'the branch’s own first floor was not sent')
})

test('the shared prefix is summarized once and read from every branch', async (t) => {
  const f = await fixture(t)
  const { root, branch } = await forked(f)
  // Asked from the branch: the prefix is the root's, so the record is the root's.
  const { summary } = await f.handlers['chat.summarizeSegment']({ chatId: branch, fromFloor: 0, toFloor: 2 })
  assert.equal(summary.chatId, root, 'the shared prefix was filed under the branch')
  assert.equal((await f.store.list(root)).length, 1)
  assert.equal((await f.store.list(branch)).length, 0, 'a second copy was written for the branch')

  const fromRoot = (await f.handlers['chat.segmentSummaries']({ chatId: root })).summaries
  const fromBranch = (await f.handlers['chat.segmentSummaries']({ chatId: branch })).summaries
  assert.deepEqual(fromRoot, fromBranch, 'the two conversations of one family disagree about its summaries')
  assert.deepEqual(fromRoot.map(view => [view.chatId, view.from, view.to, view.stale]), [[root, 0, 2, false]])
})

test('editing a floor of a summarized segment makes its summary stale, and a re-summary makes it fresh', async (t) => {
  const f = await fixture(t)
  const { root } = await forked(f)
  await f.handlers['chat.summarizeSegment']({ chatId: root, fromFloor: 3, toFloor: 4 })
  const read = async (): Promise<boolean | undefined> =>
    (await f.handlers['chat.segmentSummaries']({ chatId: root })).summaries.find(view => view.from === 3)?.stale
  assert.equal(await read(), false)

  // A floor outside the segment moves nothing.
  await f.handlers['chat.editMessage']({ chatId: root, id: 1, text: 'Where are the old maps?' })
  assert.equal(await read(), false, 'an edit above the segment made it stale')

  await f.handlers['chat.editMessage']({ chatId: root, id: 4, text: 'An edited reply.' })
  assert.equal(await read(), true, 'an edited floor left the summary current')

  await f.handlers['chat.summarizeSegment']({ chatId: root, fromFloor: 3, toFloor: 4 })
  assert.equal(await read(), false, 're-summarizing did not replace the stale record')
  assert.equal((await f.store.list(root)).length, 1, 'the re-summary kept the stale record beside the new one')
})

test('a segment that grew reads stale rather than vanishing', async (t) => {
  const f = await fixture(t)
  const { branch } = await forked(f)
  await f.handlers['chat.summarizeSegment']({ chatId: branch, fromFloor: 3, toFloor: 4 })
  await f.send(branch, 'Onwards.')
  const views = (await f.handlers['chat.segmentSummaries']({ chatId: branch })).summaries
  assert.deepEqual(views.map(view => [view.chatId, view.from, view.to, view.stale]), [[branch, 3, 6, true]])
})

// A timeout, so a Stop that does not reach the request fails rather than hangs.
test('Stop aborts a summary in flight, and nothing is stored', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t)
  const { root } = await forked(f)
  const gate = f.hold()
  const pending = f.handlers['chat.summarizeSegment']({ chatId: root, fromFloor: 0, toFloor: 2 })
  await gate.entered
  await f.handlers['chat.abort']({ chatId: root })
  await assert.rejects(pending, /stopped before it finished/u, 'Stop did not reach the summary')
  gate.release()
  assert.deepEqual(await f.store.list(root), [], 'a stopped summary was stored')
})

test('deleting a branch forgets the summaries it owns and keeps the root’s', async (t) => {
  const f = await fixture(t)
  const { root, branch } = await forked(f)
  await f.handlers['chat.summarizeSegment']({ chatId: branch, fromFloor: 3, toFloor: 4 })
  await f.handlers['chat.summarizeSegment']({ chatId: root, fromFloor: 0, toFloor: 2 })
  assert.equal((await f.store.list(branch)).length, 1, 'premise: the branch owns a summary')
  assert.ok(existsSync(join(f.dir, 'segment-summaries', `${branch}.json`)), 'premise: its file exists')

  await f.handlers['chat.delete']({ chatId: branch })

  assert.equal(existsSync(join(f.dir, 'segment-summaries', `${branch}.json`)), false, 'the deleted branch’s summaries are still on disk')
  assert.equal((await f.store.list(root)).length, 1, 'the root’s summary went with its branch')
})

test('the match policy: exact is fresh, same first floor otherwise is the newest, stale', () => {
  const lines = [
    { name: 'A', is_user: false, mes: 'one', iris_id: 'x0' },
    { name: 'U', is_user: true, mes: 'two' },
    { name: 'A', is_user: false, mes: 'three', iris_id: 'x2' },
  ] as never[]
  const now = segmentIdentity('c', lines, 0, 2)
  // An imported line with no id keys by position.
  assert.equal(segmentIdentity('c', lines, 1, 1).first, '@c#1')
  assert.deepEqual([now.first, now.last], ['x0', 'x2'])
  const exact = { ...now, from: 0, to: 2, summary: 'fresh', at: 1 }
  const older = { ...now, last: 'x9', from: 0, to: 9, summary: 'older', at: 2 }
  const newer = { ...now, last: 'x8', from: 0, to: 8, summary: 'newer', at: 3 }
  assert.deepEqual(matchSegmentSummary([older, exact, newer], now), { record: exact, stale: false })
  assert.deepEqual(matchSegmentSummary([older, newer], now), { record: newer, stale: true })
  assert.equal(matchSegmentSummary([older], segmentIdentity('c', lines, 1, 2)), undefined)
})
