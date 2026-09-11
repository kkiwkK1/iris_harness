import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { AppError } from '../src/errors.ts'
import { CharacterLibrary } from '../src/library.ts'
import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * What a conversation whose file was cut short looks like from the outside.
 *
 * **The state this describes was reachable.** The chat file is rewritten whole
 * on every turn — the largest conversation in the local corpus is 677 floors and
 * 19 MiB — and until 2026-09-11 that rewrite was a plain `writeFile`, which
 * truncates before it streams. A crash, a power cut, a full disk or a kill
 * inside that window left a file that exists and stops mid-line. `chat.open`
 * then parsed *outside* its `try`, so the raw `SyntaxError` went out on the
 * wire ("Unexpected token … in JSON at position …"), and `chat.list` skipped
 * the file without a word — the conversation simply was not in the sidebar any
 * more, which reads as a deletion nobody performed.
 *
 * **Where the two halves actually meet, measured rather than assumed.**
 * `#summarize` parses only the *first* line, so the two symptoms do not happen
 * to the same file: a chat cut anywhere after its header keeps its sidebar row
 * and fails on open, while only a chat whose header line is damaged drops out
 * of the list. The tests below are split along that seam because a single test
 * asserting both of a tail-truncated file would be asserting something untrue.
 *
 * The write is atomic now, so the state should not arise again. These tests are
 * about the other half: a file damaged by anything else — a half-finished
 * manual edit, a sync client, a disk error, a chat written by an older build —
 * has to be *named* rather than swallowed on one path and leaked raw on the
 * other. Both assertions are about the sentence a person sees.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'M0', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  dir: string
  chatId: string
  /** Every report the service has raised, newest last. */
  reports: () => string[]
  /** This chat's file on disk. */
  file: string
}

/** A service over a scratch profile, with one conversation of `count` exchanges. */
async function fixture(t: TestContext, count = 2): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-chat-integrity-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  let ends = 0
  let reply = 0
  const stream: StreamFn = async function* () {
    const text = `A${String(reply)}`
    reply += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  // The real buffer, not a spy: the rule is that these reports reach the same
  // channel `debug.reports` serves, and a stub beside it would prove only that
  // a callback was called.
  const diagnostics = new DiagnosticBuffer()
  const handlers = new IrisAppService({
    stream, library, chats, diagnostics,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'U',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  for (let turn = 0; turn < count; turn += 1) {
    await handlers['chat.send']({ chatId, text: `U${String(turn)}` })
    while (ends < turn + 1) await new Promise(resolve => setTimeout(resolve, 1))
  }

  return {
    handlers, chats, dir, chatId,
    file: join(dir, 'chats', `${chatId}.jsonl`),
    reports: () => diagnostics.read().reports.map(report => report.message),
  }
}

test('an intact conversation still round-trips through the atomic write, byte for byte', async (t) => {
  const subject = await fixture(t)
  const before = await readFile(subject.file, 'utf8')

  // The floor under everything else here. `atomicWriteFile` changed *where* the
  // bytes are written first, and nothing about what they are: the byte-stable
  // export pins in `chat-transfer.test.ts` and `key-order.test.ts` cover the
  // projection, and this covers the file the projection lands in.
  const exported = await subject.handlers['chat.export']({ chatId: subject.chatId })
  assert.equal(exported.content, before, 'the file on disk is not what the export writes')

  await subject.chats.save(await subject.chats.open(subject.chatId))
  assert.equal(await readFile(subject.file, 'utf8'), before,
    'a re-save of an unchanged conversation changed the file')

  // And nothing of the mechanism is left in the directory a user browses.
  const stray = (await readdir(join(subject.dir, 'chats'))).filter(name => name.endsWith('.tmp'))
  assert.deepEqual(stray, [], 'a save left its temporary in the chats directory')
})

test('a chat truncated after its header still lists, and open refuses it by name', async (t) => {
  const subject = await fixture(t)
  const whole = await readFile(subject.file, 'utf8')

  // Cut inside the last line, which is exactly the shape a non-atomic rewrite
  // leaves behind — a valid header, some valid floors, and then a fragment.
  await writeFile(subject.file, whole.slice(0, whole.length - 40), 'utf8')
  // A second store over the same directory: a restart, with no live entry to
  // answer from. `open` on a cached conversation never reads the file at all.
  const reopened = new ChatStore(join(subject.dir, 'chats'),
    new CharacterLibrary(join(subject.dir, 'characters'), '/iris/avatar'))

  // `open`: an invalid-request naming the file and carrying the parser's reason,
  // never the bare `SyntaxError` that used to escape the method.
  const refusal = await reopened.open(subject.chatId).then(
    () => undefined, (error: unknown) => error)
  assert.ok(refusal instanceof AppError, 'a corrupt chat did not refuse as an AppError')
  assert.equal(refusal.code, 'invalid-request',
    'a chat whose file is there was reported as not-found')
  assert.ok(refusal.message.includes(subject.chatId), 'the refusal does not name the conversation')
  assert.ok(refusal.message.includes(subject.file), 'the refusal does not name the file')
  assert.equal(/^Unexpected/u.test(refusal.message), false,
    'the raw parser error reached the wire as the whole message')

  // **And the listing is untouched, which this test found and the audit's
  // premise did not.** `#summarize` parses only the first line, so a chat cut
  // anywhere after its header is summarised fine and keeps its sidebar row —
  // the "disappears from the list" half of the incident needs the *header* to
  // be damaged, which the next test covers. A reader whose last turn was lost
  // still sees the conversation, and what they get on clicking it is the
  // refusal above rather than a blank.
  const said: string[] = []
  const rows = await reopened.list(message => { said.push(message) })
  assert.deepEqual(rows.map(row => row.chatId), [subject.chatId],
    'a chat cut after its header lost its sidebar row')
  assert.deepEqual(said, [], 'a chat that summarised fine was reported as a problem')
})

test('a chat whose header will not parse is left out of the list and named once', async (t) => {
  const subject = await fixture(t)

  // Written straight into the directory rather than through `chat.create`,
  // because a conversation the service has opened is answered from its live
  // entry and never reaches the file at all — which is how the first draft of
  // this test passed for the wrong reason.
  const damaged = join(subject.dir, 'chats', 'wrecked.jsonl')
  await writeFile(damaged, '{"user_name":"U"\n{"mes":"hello"}\n', 'utf8')

  const before = subject.reports().length
  const listed = await subject.handlers['chat.list']({})
  assert.equal(listed.chats.some(row => row.chatId === 'wrecked'), false,
    'a chat whose header will not parse was listed')
  assert.equal(listed.chats.some(row => row.chatId === subject.chatId), true,
    'one damaged file took the other conversations out of the sidebar with it')

  // The wiring, which is the point: the store takes a callback and the service
  // hands it one that writes into the same buffer `debug.reports` serves. A
  // version that threaded nothing through would still list correctly and leave
  // the operator with no way to see this.
  const added = subject.reports().slice(before)
  assert.equal(added.filter(line => line.includes(damaged)).length, 1,
    'the damaged chat did not reach the report buffer exactly once')
  assert.ok(added.some(line => line.includes('wrecked')), 'the report does not name the chat')
})
