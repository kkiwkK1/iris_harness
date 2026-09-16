/**
 * W7's round trip on the fake: `script.report` files a line and `debug.reports`
 * reads it back.
 *
 * The fake seeds no invented failures (`debug.reports`'s own docblock is the
 * argument), but a console line is not a failure — it is what the caller told
 * the host, so retaining it is the fake remembering its own input rather than
 * imagining a broken host. The loop is the one the shell's console capture is
 * written against, and a fake that dropped the report would let a page ship
 * with the forward wired to nothing.
 *
 * @module iris-client-fake/tests/card-console
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { testClient } from './helpers.ts'

test('W7: a console line survives the round trip with its level, time and script id', async () => {
  const client = testClient()
  const at = 1_700_000_000_000

  const answer = await client.call('script.report', {
    chatId: 'chat-1',
    at,
    level: 'error',
    message: 'error: "the card printed this"',
    scriptId: 'script-a',
  })
  assert.equal(answer.report.kind, 'card-console')
  assert.equal(answer.report.grade, 'note', 'a console call was filed as a fault')
  assert.equal(answer.report.at, at, 'the frame\'s clock was replaced by the arrival time')
  assert.equal(answer.report.scriptId, 'script-a')

  const page = await client.call('debug.reports', {})
  const stored = page.reports.find(report => report.kind === 'card-console')
  assert.ok(stored !== undefined, 'the fake dropped the console report')
  assert.equal(stored.chatId, 'chat-1')
  assert.equal(stored.message, 'error: "the card printed this"')
  // The kind is declared as wired, so an empty page would not be ambiguous.
  assert.ok(page.kinds.includes('card-console'), 'the fake declared no card-console kind')
  client.dispose()
})

test('W7: an empty console report leaves the buffer empty rather than inventing one', async () => {
  const client = testClient()
  const page = await client.call('debug.reports', {})
  // Still the honest empty: the fake retains only what it was told, and it was
  // told nothing.
  assert.deepEqual(page.reports, [])
  assert.equal(page.dropped, 0)
  assert.equal(page.oldest, 0)
  client.dispose()
})
