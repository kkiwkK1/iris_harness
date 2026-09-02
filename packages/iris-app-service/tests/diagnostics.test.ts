import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { DiagnosticBuffer, WIRED_KINDS } from '../src/diagnostics.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Retention for the diagnostic bus, and the read surface over it.
 *
 * The host reported every survived failure to a logger and kept nothing, so a
 * debug page had nothing to ask for. What is added is retention and a pull
 * surface — no new report sites, because the charter asks for context on the
 * reports that exist rather than for more of them.
 *
 * Three properties here are load-bearing rather than incidental, and each is
 * pinned because getting it wrong produces a page that lies:
 *
 * - **`dropped` must be reported.** A truncated bundle and a complete one are
 *   otherwise identical.
 * - **A stack appears only when one was caught.** A stack naming the reporter
 *   reads as the origin of the failure.
 * - **An empty answer must say which empty it is.** "Collected and quiet" and
 *   "never wired" are different states, and a page cannot tell them apart from
 *   a count of zero.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
    character_book: {
      entries: [{
        keys: [], content: 'count: 0', comment: '[InitVar]', name: '[InitVar]',
        enabled: false, constant: false, insertion_order: 0, extensions: {},
      }],
    },
  },
})

interface Fixture {
  handlers: Handlers
  diagnostics: DiagnosticBuffer
  chatId: string
  settled: () => Promise<void>
}

/**
 * A host whose replies fold a command against a path that does not exist, which
 * is the cheapest way to make the MVU report site fire for real.
 * @param t - the test context, for cleanup.
 * @param withBuffer - whether the host retains reports at all.
 * @returns the handlers, the buffer, and a settle barrier.
 */
async function fixture(t: TestContext, withBuffer = true): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-diag-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const diagnostics = new DiagnosticBuffer()
  let ends = 0
  let waited = 0
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // `nowhere.at.all` is not in the tree, so the fold refuses it and reports.
    const text = "Reply. _.set('nowhere.at.all', 1);"
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: event => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
    ...withBuffer ? { diagnostics } : {},
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  return {
    handlers,
    diagnostics,
    chatId: created.view.chatId,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

test('a real fold failure is retained, attributed, and readable', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['chat.send']({ chatId: fixed.chatId, text: 'hi' })
  await fixed.settled()

  const page = await fixed.handlers['debug.reports']({})

  // The precondition: if the fixture stopped producing reports, everything
  // below would compare empties and pass while testing nothing.
  assert.ok(page.reports.length > 0, 'the fixture produced no report to retain')
  const report = page.reports[0]
  assert.equal(report?.kind, 'mvu')
  assert.equal(report?.chatId, fixed.chatId, 'the report is not attributed to its conversation')
  assert.equal(report?.characterId, 'aria')
  assert.match(report?.message ?? '', /nowhere\.at\.all/u)
})

test('a report the host wrote itself carries no stack', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['chat.send']({ chatId: fixed.chatId, text: 'hi' })
  await fixed.settled()

  const page = await fixed.handlers['debug.reports']({})
  assert.ok(page.reports.length > 0, 'no report to check')

  // The MVU site writes its own sentence. A stack here would name `#report`
  // and read as the place the fold failed, which is a worse answer than no
  // stack at all — so its absence is the assertion, not an omission.
  for (const report of page.reports) {
    assert.equal(report.stack, undefined, `${report.kind} invented a stack for a message it wrote`)
  }
})

test('a caught error keeps its stack', () => {
  // The other half of the rule, at the buffer's own boundary: what makes the
  // distinction structural is that a caught error is passed as an Error and a
  // written sentence as a string, so a site cannot get it wrong by accident.
  const buffer = new DiagnosticBuffer()
  const caught = new Error('the provider hung up')
  buffer.record({ kind: 'host' }, caught.message, caught.stack)
  buffer.record({ kind: 'mvu' }, 'a path did not exist')

  const page = buffer.read()
  assert.match(page.reports[0]?.stack ?? '', /Error: the provider hung up/u)
  assert.equal(page.reports[1]?.stack, undefined)
})

test('the cursor pages forward and never repeats a record', () => {
  const buffer = new DiagnosticBuffer()
  for (let index = 0; index < 5; index += 1) buffer.record({ kind: 'mvu' }, `report ${String(index)}`)

  const first = buffer.read(undefined, 2)
  assert.deepEqual(first.reports.map(report => report.seq), [1, 2])

  const second = buffer.read(first.reports[first.reports.length - 1]?.seq, 2)
  assert.deepEqual(second.reports.map(report => report.seq), [3, 4])

  // And a cursor at the end returns nothing rather than wrapping.
  assert.deepEqual(buffer.read(5).reports, [])
})

test('the count cap evicts the oldest and says how many it dropped', () => {
  const buffer = new DiagnosticBuffer({ maxRecords: 3, maxBytes: 1_000_000 })
  for (let index = 0; index < 6; index += 1) buffer.record({ kind: 'mvu' }, `report ${String(index)}`)

  const page = buffer.read()
  assert.equal(page.reports.length, 3)
  assert.deepEqual(page.reports.map(report => report.seq), [4, 5, 6])

  // `dropped` is the whole reason a reader can trust the rest. Without it a
  // truncated window is indistinguishable from a complete one.
  assert.equal(page.dropped, 3)
  assert.equal(page.oldest, 4, 'a page cannot tell its cursor fell outside the buffer')
})

test('the byte cap binds independently of the count', () => {
  // The cap that actually matters: the measured 41 B mean describes the MVU
  // path, while a template failure can carry a whole rendered output. The cap
  // exists for that tail, not for the mean.
  const buffer = new DiagnosticBuffer({ maxRecords: 1000, maxBytes: 500 })
  for (let index = 0; index < 10; index += 1) buffer.record({ kind: 'template' }, 'x'.repeat(200))

  const page = buffer.read()
  assert.ok(page.reports.length < 10, 'the byte cap never bound')
  assert.ok(page.dropped > 0)
  // A single oversized record still lands rather than being censored: it is
  // the one most likely to matter, and the cap bounds the buffer, not entries.
  const single = new DiagnosticBuffer({ maxRecords: 1000, maxBytes: 10 })
  single.record({ kind: 'template' }, 'y'.repeat(5000))
  assert.equal(single.read().reports.length, 1)
})

test('the answer declares which kinds are collected, so empty is not ambiguous', async (t) => {
  const fixed = await fixture(t)
  const page = await fixed.handlers['debug.reports']({})

  // Nothing has happened yet, and the page must still be able to tell that
  // apart from "nothing is watching". The declared set is what makes the
  // difference visible: a kind listed with no records is quiet, a kind absent
  // from the list is uninstrumented.
  assert.deepEqual(page.reports, [])
  assert.deepEqual([...page.kinds].sort(), [...WIRED_KINDS].sort())
  assert.ok(page.kinds.length > 0, 'an empty answer with no declared kinds is a bare blank')
})

test('a host that retains nothing refuses instead of reporting all clear', async (t) => {
  const fixed = await fixture(t, false)
  await fixed.handlers['chat.send']({ chatId: fixed.chatId, text: 'hi' })
  await fixed.settled()

  // The reports still reached the logger; they were simply not kept. Answering
  // with an empty page here would declare the kinds and show no records, which
  // reads as "collected, nothing happened" — false, and false in the direction
  // a diagnostic page can least afford. Refusing says "nothing was watching".
  await assert.rejects(
    () => fixed.handlers['debug.reports']({}),
    (error: unknown) => (error as { code?: string }).code === 'unsupported',
  )
})
