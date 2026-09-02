import assert from 'node:assert/strict'
import { test } from 'node:test'

import { importChat, parseChatFile } from '@iris/persistence'

import { ChatEntry } from '../src/entry.ts'

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
