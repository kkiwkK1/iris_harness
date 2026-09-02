/**
 * The two frame hooks that seed and report libraries, and the order between them.
 *
 * Both were uncovered until the change that added `provideToastr`, and the
 * ordering between them is the kind of constraint that cannot announce its own
 * violation: put the seeding after the report and everything still runs, cards
 * still work, and the only symptom is a panel line naming a library the frame
 * does in fact have. A reader sent after that gap looks for a fault that is not
 * there — the same cost as omitting a library the frame lacks, in the opposite
 * direction.
 *
 * @module iris-web/tests/frame-libraries
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { installSandbox, type FrameEnv } from '../src/sandbox/frame.ts'
import type { FromFrame, ToFrame } from '../src/sandbox/protocol.ts'

/** A frame driven far enough to reach the library hooks. */
function scope(): {
  run: () => void
  order: string[]
  posted: FromFrame[]
  reportFromToastr: () => ((message: string, channel: 'note' | 'error') => void) | undefined
} {
  const order: string[] = []
  const posted: FromFrame[] = []
  const listeners: ((message: ToFrame) => void)[] = []
  let captured: ((message: string, channel: 'note' | 'error') => void) | undefined

  const env: FrameEnv = {
    token: 'tok',
    container: { id: 'card-root', querySelector: () => null, querySelectorAll: () => [] },
    factory: {
      createElement: tagName => ({ tagName }),
      createTextNode: data => ({ data }),
      createDocumentFragment: () => ({ fragment: true }),
    },
    realWindow: { innerWidth: 320 },
    post: message => posted.push(message),
    onMessage: listener => listeners.push(listener),
    evaluate: () => undefined,
    publishGlobals: () => undefined,
    provideToastr: report => {
      order.push('provideToastr')
      captured = report
    },
    reportMissingGlobals: () => {
      order.push('reportMissingGlobals')
    },
  }

  installSandbox(env)
  return {
    run: () =>
      listeners.forEach(listener =>
        listener({ iris: 'tok', type: 'run', code: '/* card */', mode: 'classic', scriptId: 's1' }),
      ),
    order,
    posted,
    reportFromToastr: () => captured,
  }
}

test('toastr is seeded before the frame reports which libraries are missing', () => {
  const frame = scope()
  frame.run()

  assert.deepEqual(
    frame.order,
    ['provideToastr', 'reportMissingGlobals'],
    'reversing these makes the banner name a library the frame is about to provide',
  )
})

test('the toastr stub is handed the frame\u2019s real gap channel, not a stub of one', () => {
  const frame = scope()
  frame.run()

  const report = frame.reportFromToastr()
  assert.notEqual(report, undefined, 'provideToastr was never called with a channel')

  const before = frame.posted.length
  report?.('a card\u2019s toast', 'error')
  const added = frame.posted.slice(before)

  /*
   * The point of the assertion: a channel that accepted the call and posted
   * nothing would satisfy every other test in this file while silently deleting
   * every toast a card emits — which is exactly the silent no-op the toastr
   * substitute exists to avoid.
   */
  assert.equal(added.length, 1, 'the toast did not reach the frame\u2019s outbound channel')
  const message = added[0] as { type?: string, message?: string }
  assert.equal(message.type, 'error')
  assert.ok(message.message?.includes('a card\u2019s toast'))

  /*
   * And that the channel is a channel rather than a decoration: the same
   * reporter asked for a note must produce a note. Without this half, handing
   * the toastr stub a reporter that ignored its second argument would pass —
   * and ignoring it is the shape the bug had when there was no second argument.
   */
  const noted = frame.posted.length
  report?.('a card\u2019s notice', 'note')
  assert.equal((frame.posted[noted] as { type?: string }).type, 'note')
})

test('the gap channel still discards an exact repeat, which is a toast loop\u2019s de-duplication', () => {
  const frame = scope()
  frame.run()
  const report = frame.reportFromToastr()

  const before = frame.posted.length
  report?.('same text', 'note')
  report?.('same text', 'note')
  assert.equal(frame.posted.length - before, 1)
})
