import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { DebugReport, IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ConnectionStore } from '../src/connections.ts'
import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * What a page is told when the reply was generated and could not be stored.
 *
 * `#settle` runs the variable records, the rewrite and the save inside one
 * `try`, and that `catch` used to file a report and stop. Every other terminal
 * path broadcasts, so on a full disk or a permission error the reply existed in
 * the host's memory, the report panel knew, and the page sat in the generating
 * state with a cursor blinking under a reply it would never be sent — until
 * somebody reloaded it.
 *
 * Upstream cannot reach this state: its save is a request the browser makes
 * after the generation has already ended, and `saveChat`'s catch toasts
 * `Chat could not be saved` (`public/script.js:7417-7423`) while `chat[]` keeps
 * the reply for the next save that succeeds. These tests hold the same two
 * facts here — the reader is told, and the reply is not lost — plus the
 * property that makes the first one safe: the success path still emits exactly
 * one terminal frame.
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

/** What the model says when it is allowed to speak. */
const REPLY = 'Understood.'

/** An injected disk failure, worded the way the platform words one. */
const DISK = 'ENOSPC: no space left on device, write'

/**
 * How long a test waits for a turn to end.
 *
 * A deadline rather than an open loop: a regression that drops the terminal
 * frame does not make these tests fail, it makes them **hang** — which is the
 * product failure itself, reproduced inside its own suite — and a hang and a
 * slow pass have the same output.
 */
const DEADLINE = 5000

interface Host {
  handlers: Handlers
  dir: string
  /** Every terminal frame this host broadcast, in order. */
  terminal: Extract<IrisEvent, { type: 'stream.end' | 'stream.error' }>[]
  /** Every frame, in order, so a test can assert what came before what. */
  events: IrisEvent[]
  /** Make the next `chats.save` reject with this, or stop failing. */
  failSave: (message: string | undefined) => void
  /** Make `chats.list` reject, which is how `#announceChats` is failed. */
  failList: (message: string | undefined) => void
  /** The retained reports, newest last. */
  reports: () => Promise<DebugReport[]>
  /** Resolve once one more turn has ended, however it ended. */
  settled: () => Promise<void>
}

/**
 * One host over a fresh data directory, with the two stores it saves through
 * made failable.
 * @param t - the test context, for cleaning the directory up.
 * @param options.throwing - the stream raises instead of speaking, which is how
 * `#fail`'s own save sites are reached.
 * @returns the host's handlers and what it recorded.
 */
async function fixture(t: TestContext, options: { throwing?: boolean } = {}): Promise<Host> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-settle-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 3 }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'default', model: 'local-model' })
  const connections = new ConnectionStore(join(dir, 'connections.json'))
  await settings.load()

  // Wrapped rather than replaced: every assertion about what survives depends
  // on the real store doing its real work in the turns that are allowed to
  // save, so the fixture can only add a failure, never stand in for the file.
  const realSave = chats.save.bind(chats)
  const realList = chats.list.bind(chats)
  let saveFailure: string | undefined
  let listFailure: string | undefined
  chats.save = async (entry, onReport) => {
    if (saveFailure !== undefined) throw new Error(saveFailure)
    await realSave(entry, onReport)
  }
  chats.list = async (onReport) => {
    if (listFailure !== undefined) throw new Error(listFailure)
    return realList(onReport)
  }

  const events: IrisEvent[] = []
  const terminal: Extract<IrisEvent, { type: 'stream.end' | 'stream.error' }>[] = []
  const diagnostics = new DiagnosticBuffer()

  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.throwing === true) throw new Error('the provider refused')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: REPLY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const service = new IrisAppService({
    stream, library, chats, settings, connections, diagnostics,
    env: {},
    userName: 'Traveller',
    broadcast: (event: IrisEvent) => {
      events.push(event)
      if (event.type === 'stream.end' || event.type === 'stream.error') terminal.push(event)
    },
  })
  const handlers = service.handlers()

  let waited = 0
  return {
    handlers, dir, events, terminal,
    failSave: (message) => { saveFailure = message },
    failList: (message) => { listFailure = message },
    reports: async () => (await handlers['debug.reports']({})).reports,
    settled: async () => {
      waited += 1
      const until = Date.now() + DEADLINE
      while (terminal.length < waited) {
        if (Date.now() > until) {
          throw new Error(`no terminal frame after ${String(DEADLINE)} ms; the turn never ended`)
        }
        await new Promise(resolve => setTimeout(resolve, 2))
      }
    },
  }
}

/** The stored conversation, as bytes, without going through the live entry. */
async function storedText(host: Host, chatId: string): Promise<string> {
  return readFile(join(host.dir, 'chats', `${chatId}.jsonl`), 'utf8')
}

test('a reply that cannot be stored ends the turn, and says where the reply is', async (t) => {
  const host = await fixture(t)
  const chat = (await host.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  host.failSave(DISK)

  await host.handlers['chat.send']({ chatId: chat, text: 'Go on.' })
  await host.settled()

  assert.equal(host.terminal.length, 1, 'the turn ended more than once, or not at all')
  const only = host.terminal[0]
  assert.ok(only !== undefined)
  assert.equal(only.type, 'stream.error', 'a save that failed was announced as a completed turn')
  assert.equal(only.code, 'storage-error')
  // The three things the sentence has to carry: what failed, what the platform
  // said about it, and where the reply is now — the last being the half a page
  // cannot see, and the difference between "not written" and "lost".
  assert.match(only.message, /could not be saved/u)
  assert.match(only.message, /ENOSPC/u)
  assert.match(only.message, /held in this host's memory/u)
  assert.match(only.message, /next save that succeeds/u)

  // The reply itself went out first, on the one frame that is not terminal, so
  // the reader sees the text the sentence is about instead of an error over a
  // conversation that appears not to have answered.
  const updates = host.events.filter(event => event.type === 'chat.updated')
  assert.equal(updates.length, 1, 'the view holding the unsaved reply was never sent')
  assert.ok(JSON.stringify(updates[0]).includes(REPLY), 'the view went out without the reply in it')
  assert.ok(
    host.events.indexOf(updates[0] as IrisEvent) < host.events.indexOf(only),
    'the failure was announced before the view it is about',
  )

  // Reported as well as broadcast: the panel keeps the platform's own error.
  const said = (await host.reports()).filter(report => report.message.includes('ENOSPC'))
  assert.equal(said.length, 1, 'the storage failure was not reported')
  assert.equal(said[0]?.grade, 'fault')
})

test('the unsaved reply is still there, and the next save that succeeds writes it', async (t) => {
  const host = await fixture(t)
  const chat = (await host.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  host.failSave(DISK)
  await host.handlers['chat.send']({ chatId: chat, text: 'First.' })
  await host.settled()

  // Nothing of the turn reached disk — which is the premise the sentence makes
  // a promise about, and a test that skipped it could pass against a save that
  // half worked.
  assert.ok(!(await storedText(host, chat)).includes('First.'), 'the failing save wrote anyway')

  // The chat is idle, so the next turn is even possible: a host that left it
  // generating answers this with `busy` rather than with a turn. The release
  // that matters here is the `entry.finish()` in the body, above the save —
  // the `catch` calls it again for the failures that happen higher up, and in
  // this path that second call is a belt.
  host.failSave(undefined)
  await host.handlers['chat.send']({ chatId: chat, text: 'Second.' })
  await host.settled()

  assert.equal(host.terminal.length, 2)
  assert.equal(host.terminal[1]?.type, 'stream.end', 'the recovered turn did not settle')
  const stored = await storedText(host, chat)
  assert.ok(stored.includes('First.'), 'the user line of the unsaved turn was lost')
  assert.ok(stored.includes('Second.'))
  // Both replies, the one that could not be written among them: the save writes
  // the whole log, and the log is what the failed turn left in memory. Counted
  // in **lines** rather than occurrences, because one stored floor names its
  // text twice (`mes` and its own `swipes` entry) and a count of matches would
  // be asserting the file format instead of the recovery.
  const replies = stored.split('\n').filter(line => line.includes(REPLY))
  assert.equal(replies.length, 2, 'the unsaved reply did not reach disk with the next save')
})

test('a settle that succeeds and then fails announcing keeps its one terminal frame', async (t) => {
  const host = await fixture(t)
  const chat = (await host.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  // The save works; what fails is `#announceChats`, inside the same `try` and
  // after the turn has already ended. A second terminal frame here would
  // contradict the first — the page would be told the reply failed immediately
  // after being handed the reply.
  host.failList('EMFILE: too many open files, scandir')

  await host.handlers['chat.send']({ chatId: chat, text: 'Go on.' })
  await host.settled()

  assert.equal(host.terminal.length, 1, 'the turn was ended twice')
  assert.equal(host.terminal[0]?.type, 'stream.end')
  assert.equal(
    host.events.filter(event => event.type === 'chat.updated').length, 0,
    'a settled turn sent the unsaved-reply view',
  )
  assert.ok(
    (await host.reports()).some(report => report.message.includes('EMFILE')),
    'the announcement failure was swallowed',
  )
  host.failList(undefined)
  assert.ok((await storedText(host, chat)).includes(REPLY), 'the reply was not stored')
})

test('an ordinary turn that stores its reply says so once', async (t) => {
  const host = await fixture(t)
  const chat = (await host.handlers['chat.create']({ characterId: 'aria' })).view.chatId

  await host.handlers['chat.send']({ chatId: chat, text: 'Go on.' })
  await host.settled()

  assert.equal(host.terminal.length, 1)
  assert.equal(host.terminal[0]?.type, 'stream.end')
  assert.equal(
    host.events.filter(event => event.type === 'chat.updated').length, 0,
    'a healthy turn sent the frame that only an unsaved reply sends',
  )
})

test('a provider failure whose save also fails still ends the turn as a provider failure', async (t) => {
  const host = await fixture(t, { throwing: true })
  const chat = (await host.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  host.failSave(DISK)

  await host.handlers['chat.send']({ chatId: chat, text: 'Go on.' })
  await host.settled()

  assert.equal(host.terminal.length, 1, 'the failed turn ended more than once, or not at all')
  const only = host.terminal[0]
  assert.ok(only !== undefined)
  assert.equal(only.type, 'stream.error')
  // The generation is what failed and the provider's words are the diagnosis;
  // the storage failure underneath it is a report, not a relabelling of the
  // turn. `#fail` broadcasts its own frame after that save either way.
  assert.equal(only.code, 'provider-error')
  assert.match(only.message, /the provider refused/u)
  assert.ok(
    (await host.reports()).some(report => report.message.includes('ENOSPC')),
    'the save that failed on the way out was not reported',
  )
})

test('an impersonation whose save fails ends the turn once, from the same site', async (t) => {
  const host = await fixture(t, { throwing: true })
  const chat = (await host.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  host.failSave(DISK)

  await host.handlers['chat.send']({ chatId: chat, kind: 'impersonate' })
  await host.settled()

  assert.equal(host.terminal.length, 1, 'the impersonation ended more than once, or not at all')
  assert.equal(host.terminal[0]?.type, 'stream.error')
  assert.equal(host.terminal[0]?.code, 'provider-error')
  assert.ok(
    (await host.reports()).some(report => report.message.includes('ENOSPC')),
    'the impersonation branch swallowed its save failure',
  )
})
