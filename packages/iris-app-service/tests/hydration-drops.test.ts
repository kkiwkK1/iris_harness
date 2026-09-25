import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { importChat, parseChatFile } from '@iris/persistence'

import { ChatStore } from '../src/chats.ts'
import { ChatEntry } from '../src/entry.ts'
import { CharacterLibrary } from '../src/library.ts'
import { tempDir } from './support/temp-dir.ts'

/**
 * Tables `hydrateVariables` cannot attach, and the report that says so.
 *
 * Two `continue`s in that loop drop a table: one when the line carries more
 * tables than the turn has candidates, one when a table is not an object.
 * Dropping is correct — there is no candidate to hang it on, and inventing one
 * would fabricate a swipe the conversation never had — but both were silent,
 * and a silent drop is indistinguishable from a file that never carried the
 * table. What the user sees is variables quietly resetting, with nothing
 * anywhere naming the cause.
 *
 * 44 found one real instance in the corpus: 1 line in 1235, a surplus table at
 * `floor 6: variables[2] vs swipes[1]`. The rate is low; the reason to fix it
 * is that the failure is unattributable, not that it is common.
 */

const HEADER = {
  user_name: 'U',
  character_name: 'Aria',
  create_date: '2026-01-01@00h00m00s000ms',
  chat_metadata: {},
}

/**
 * A one-turn chat file whose single assistant line carries the given tables.
 * @param variables - whatever sits in the line's `variables` field.
 * @returns the file text, in the JSONL shape SillyTavern writes.
 */
function chatText(variables: unknown): string {
  const user = { name: 'U', is_user: true, is_system: false, send_date: 0, mes: 'hi' }
  const reply = {
    name: 'Aria',
    is_user: false,
    is_system: false,
    send_date: 0,
    mes: 'one',
    swipe_id: 0,
    swipes: ['one'],
    variables,
  }
  return [HEADER, user, reply].map(row => JSON.stringify(row)).join('\n')
}

/**
 * Hydrate a one-turn file and collect whatever the drop reporter said.
 * @param variables - the line's `variables` field.
 * @returns every reported message, in order.
 */
function reportsFor(variables: unknown): string[] {
  const file = parseChatFile(chatText(variables))
  const session = importChat(file, 'drops')
  const entry = new ChatEntry({ chatId: 'drops', header: file.header, session, card: undefined })

  const reports: string[] = []
  entry.hydrateVariables(file.messages, message => { reports.push(message) })
  return reports
}

test('a surplus table is reported, not dropped in silence', () => {
  // Two tables, one swipe. The second has nowhere to go.
  const reports = reportsFor([{ stat_data: { a: 1 } }, { stat_data: { a: 2 } }])

  assert.equal(reports.length, 1, `expected one report, got ${JSON.stringify(reports)}`)
  assert.match(reports[0] ?? '', /2 table\(s\)/u)
  assert.match(reports[0] ?? '', /1 candidate\(s\)/u)
  assert.match(reports[0] ?? '', /table 1 dropped/u)
})

test('a table that is not an object is reported by what it actually is', () => {
  const reports = reportsFor([['not', 'an', 'object']])

  // Named rather than lumped into "invalid": an array here means a writer put
  // the candidate list where the table belongs, which is a different bug from
  // a string or a number arriving.
  assert.equal(reports.length, 1, `expected one report, got ${JSON.stringify(reports)}`)
  assert.match(reports[0] ?? '', /is an array, not an object/u)
})

test('the ordinary case reports nothing', () => {
  // The other half of the discipline. An instrument that also speaks on the
  // healthy path teaches its reader to ignore it, and then it is no instrument.
  assert.deepEqual(reportsFor([{ stat_data: { a: 1 } }]), [])
})

test('hydration behaves the same when nobody is listening', () => {
  // The reporter is optional, so the drop must not depend on it being passed.
  const file = parseChatFile(chatText([{ stat_data: { a: 1 } }, { stat_data: { a: 2 } }]))
  const session = importChat(file, 'silent')
  const entry = new ChatEntry({ chatId: 'silent', header: file.header, session, card: undefined })
  assert.doesNotThrow(() => { entry.hydrateVariables(file.messages) })
})

/**
 * A store over a temporary directory holding one chat file, whose sink
 * collects what it was told.
 * @param t - the test, for cleanup.
 * @param variables - the reply line's `variables` field.
 * @returns the store, the chat's id, and the collected reports.
 */
async function storeWith(
  t: TestContext,
  variables: unknown,
): Promise<{ store: ChatStore, chatId: string, reports: { message: string, kind: string, chatId: string }[] }> {
  const dir = await tempDir(t, 'iris-hydrate-sink-')
  await mkdir(join(dir, 'chats'), { recursive: true })
  const chatId = 'surplus'
  await writeFile(join(dir, 'chats', `${chatId}.jsonl`), chatText(variables), 'utf8')
  const reports: { message: string, kind: string, chatId: string }[] = []
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const store = new ChatStore(
    join(dir, 'chats'), library,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    (message, context) => { reports.push({ message, ...context }) },
  )
  return { store, chatId, reports }
}

test('opening a chat reports its dropped tables through the store, once per line', async (t) => {
  // Finding hydrate-drops-silent-on-load: the open path called all three
  // hydrates with no reporter, so the corpus's one surplus table was dropped in
  // silence on every open and then left the file at the next save. Three
  // tables on a one-swipe line is two tables with nowhere to go, and one fact.
  const { store, chatId, reports } = await storeWith(t, [{ a: 1 }, { a: 2 }, { a: 3 }])
  const entry = await store.open(chatId)

  assert.equal(reports.length, 1, `expected one report, got ${JSON.stringify(reports)}`)
  assert.equal(reports[0]?.kind, 'variables')
  assert.equal(reports[0]?.chatId, chatId)
  assert.match(reports[0]?.message ?? '', /3 table\(s\) but the turn has 1 candidate\(s\); tables 1-2 dropped/u)

  // The save that follows writes the one table the line can hold, and says
  // nothing more: the loss was named when it happened, on the open.
  await store.save(entry)
  assert.equal(reports.length, 1, `the save reported again: ${JSON.stringify(reports)}`)
})

test('a healthy chat opens and saves through the store without a word', async (t) => {
  const { store, chatId, reports } = await storeWith(t, [{ a: 1 }])
  await store.save(await store.open(chatId))
  assert.deepEqual(reports, [])
})
