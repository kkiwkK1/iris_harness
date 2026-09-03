import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { formatChatFile, type SillyTavernMessage } from '@iris/persistence'
import type { DebugReport, IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { CharacterLibrary } from '../src/library.ts'
import { DEFAULT_PRUNE } from '../src/prune.ts'
import { IrisAppService } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { materialisingChatStore } from './support/materialising-store.ts'

/**
 * The one report that cannot wait to be asked for.
 *
 * Every report is retained and readable through `debug.reports`. **Nothing in
 * the browser calls it** — a diagnostic surface is still to be built — so a
 * report about a deletion would otherwise be found, if at all, long after the
 * thing it describes was gone, with nothing here to replay it back. Pushing the
 * irreversible ones is the narrow fix; pushing all of them would put routine
 * parser chatter on a channel that exists for loss.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '',
    alternate_greetings: [], tags: [], creator: '', character_version: '1', extensions: {},
  },
})

/** A chat of `lines` rows, a reply on every even index, every reply carrying a table. */
function longChatFile(lines: number): string {
  const messages: SillyTavernMessage[] = Array.from({ length: lines }, (_unused, index) => index % 2 === 1
    ? { name: 'Traveller', is_user: true, mes: `line ${String(index)}` }
    : {
        name: 'Aria', is_user: false, mes: `line ${String(index)}`,
        swipes: [`line ${String(index)}`], swipe_id: 0,
        variables: [{ stat_data: { n: index }, schema: {}, event_chain: ['x'] }],
      })
  return formatChatFile({
    header: {
      user_name: 'Traveller', character_name: 'Aria',
      create_date: '2026-09-03 @00h00m00s', chat_metadata: {},
      iris: { chatId: 'long', characterId: 'aria', title: 'Aria', updatedAt: 0 },
    },
    messages,
  })
}

interface Fixture {
  handlers: ReturnType<InstanceType<typeof IrisAppService>['handlers']>
  events: IrisEvent[]
  settled: () => Promise<void>
}

async function fixture(t: TestContext, lines: number): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-report-event-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await mkdir(join(dir, 'chats'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  await writeFile(join(dir, 'chats', 'long.jsonl'), longChatFile(lines), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const events: IrisEvent[] = []
  let ends = 0
  let waited = 0
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = 'Understood.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => {
      events.push(event)
      if (event.type === 'stream.end') ends += 1
    },
    userName: 'Traveller',
    diagnostics: new DiagnosticBuffer(),
    pruneVariables: DEFAULT_PRUNE,
  }).handlers()

  return {
    handlers, events,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/** The pushed report frames, narrowed. */
function pushedReports(events: readonly IrisEvent[]): Extract<IrisEvent, { type: 'report' }>[] {
  return events.filter((event): event is Extract<IrisEvent, { type: 'report' }> => event.type === 'report')
}

test('a trim is pushed, and what it pushes is the record the buffer stored', async (t) => {
  // 673 rows plus this exchange is 675, a multiple of five, so a cleanup runs.
  const fixed = await fixture(t, 673)
  await fixed.handlers['chat.send']({ chatId: 'long', text: 'Go on.' })
  await fixed.settled()

  const pushed = pushedReports(fixed.events)
  assert.equal(pushed.length, 1, `expected one pushed report, got ${String(pushed.length)}`)
  const frame = pushed[0]
  assert.ok(frame !== undefined)
  assert.equal(frame.irreversible, true)
  assert.equal(frame.report.kind, 'variables')
  assert.match(frame.report.message, /trimmed [0-9]+ floor/u)

  // **Compared field by field against the producer's own output**, never against
  // a list written here. A hand-written list passes for exactly as long as
  // nobody adds a field to `DebugReport`, and the failure being guarded against
  // is the one where producer and consumer are both tested and the assembly
  // between them is not.
  const page = await fixed.handlers['debug.reports']({})
  const stored = page.reports.find((report: DebugReport) => report.message.includes('trimmed'))
  assert.ok(stored !== undefined, 'the trim was pushed but never retained')
  const carried = frame.report as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(stored)) {
    assert.deepEqual(carried[key], value, `the pushed report dropped ${key}`)
  }
  assert.deepEqual(
    Object.keys(frame.report).sort(),
    Object.keys(stored).sort(),
    'the pushed report and the stored one no longer have the same fields',
  )
})

test('the never-cleaned notice is retained but not pushed', async (t) => {
  const fixed = await fixture(t, 673)
  await fixed.handlers['chat.send']({ chatId: 'long', text: 'Go on.' })
  await fixed.settled()

  const page = await fixed.handlers['debug.reports']({})
  const notice = page.reports.find((report: DebugReport) => report.message.includes('never been cleaned'))
  assert.ok(notice !== undefined, 'the notice was not even retained')

  // It describes a state, not a loss. Pushing it would spend the channel that
  // exists so that a deletion cannot go unseen.
  const pushed = pushedReports(fixed.events)
  assert.equal(pushed.length, 1, 'something other than the trim was pushed')
  assert.equal(
    pushed.some(frame => frame.report.message.includes('never been cleaned')),
    false,
    'the notice was pushed',
  )
})

test('a turn that trims nothing pushes nothing', async (t) => {
  // Short enough that every layer sits inside the protection window.
  const fixed = await fixture(t, 3)
  await fixed.handlers['chat.send']({ chatId: 'long', text: 'Go on.' })
  await fixed.settled()

  assert.deepEqual(pushedReports(fixed.events), [])
})
