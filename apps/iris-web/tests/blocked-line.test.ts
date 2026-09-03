/**
 * How a refusal reads, and which channel it goes to.
 *
 * The rule under test is one both frame kinds now share. It used to be written
 * twice — once in `useCardScripts.tsx`, once in `MessageInterfaces.tsx` — and
 * neither file can be loaded by `node --test`, so the sentence a reader actually
 * sees had never been asserted anywhere.
 *
 * @module iris-web/tests/blocked-line
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { describeRefusal } from '../src/app/blocked-line.ts'

test('an ordinary refusal keeps the sentence it always had', () => {
  const refusal = describeRefusal('cdn.example.com', 'script-src')
  assert.equal(refusal.text, 'blocked cdn.example.com (script-src)')
  assert.equal(refusal.grade, 'failure')
  assert.equal(refusal.notify, true)
})

test('the detail is appended without a separator, as the host reads it', () => {
  // The frame composes `detail` to follow the host directly — the shell used to
  // concatenate it in two places, and this is the shape both produced.
  const refusal = describeRefusal('127.0.0.1:8787', 'connect-src', '/api/x from card.js:3')
  assert.equal(refusal.text, 'blocked 127.0.0.1:8787/api/x from card.js:3 (connect-src)')
})

test('a covered refusal is a note, says so in words, and does not interrupt', () => {
  /*
   * All three at once, on purpose. A grade that changes the colour while the
   * sentence still reads like a failure asks the reader to know the rule; a
   * sentence that says nothing is wrong while a notice bar interrupts to
   * announce it contradicts itself in the same second. The three have to agree
   * or the report is worse than the ungraded one it replaced.
   */
  const refusal = describeRefusal(
    'cdnjs.cloudflare.com',
    'style-src-elem',
    undefined,
    'FontAwesome',
  )
  assert.equal(refusal.grade, 'note')
  assert.equal(refusal.notify, false)
  assert.match(refusal.text, /FontAwesome is already preseeded/)
  // The host and directive survive. Someone reading a devtools log full of red
  // requests needs to match this line to one of them.
  assert.match(refusal.text, /^blocked cdnjs\.cloudflare\.com \(style-src-elem\)/)
})

test('a covered refusal from our own origin keeps its path too', () => {
  const refusal = describeRefusal(
    '127.0.0.1:8787',
    'connect-src',
    '/lib/jquery.min.js from card.js:9',
    'jQuery',
  )
  assert.equal(refusal.grade, 'note')
  assert.match(refusal.text, /\/lib\/jquery\.min\.js from card\.js:9/)
  assert.match(refusal.text, /jQuery is already preseeded/)
})
