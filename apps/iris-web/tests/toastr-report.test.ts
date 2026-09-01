/**
 * The toastr substitute, checked for the one thing it must never do.
 *
 * A stub that answers is only defensible while it still carries the card's
 * words. The moment it accepts a call and drops the text it becomes the silent
 * no-op this module was written to avoid — and that failure is invisible from
 * every other test, because everything keeps running and the panel simply says
 * less. So the assertions here are mostly about the text arriving, not about the
 * formatting around it.
 *
 * @module iris-web/tests/toastr-report
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  TOASTR_SUBSTITUTION_NOTICE,
  createReportingToastr,
  describeToast,
} from '../src/sandbox/toastr-report.ts'

/** A frame's gap channel, recording rather than posting. */
function recorder(): { lines: string[], report: (message: string) => void } {
  const lines: string[] = []
  return { lines, report: message => lines.push(message) }
}

test('the card\u2019s own message reaches the report line intact', () => {
  const line = describeToast('error', 'variable framework failed to load', undefined)
  assert.ok(line.includes('variable framework failed to load'))
  assert.ok(line.includes('toastr.error'), 'the level a card chose is part of what it meant')
})

test('a title and a message are both carried', () => {
  const line = describeToast('warning', 'no models returned', 'Model list')
  assert.ok(line.includes('no models returned'))
  assert.ok(line.includes('Model list'))
})

test('each level is named distinctly, so a notice is not read as a fault', () => {
  const levels = (['error', 'warning', 'info', 'success'] as const).map(level =>
    describeToast(level, 'same text', undefined),
  )
  assert.equal(new Set(levels).size, 4)
})

test('an Error argument reports its message, not [object Object]', () => {
  const line = describeToast('error', new Error('Vue is not defined'), undefined)
  assert.ok(line.includes('Vue is not defined'))
  assert.ok(!line.includes('[object'))
})

test('a plain object is rendered rather than flattened to [object Object]', () => {
  const line = describeToast('info', { stage: 'init' }, undefined)
  assert.ok(line.includes('stage'))
  assert.ok(!line.includes('[object Object]'))
})

test('an unreadable argument still produces a line, because the call happened', () => {
  const circular: Record<string, unknown> = {}
  circular['self'] = circular
  const line = describeToast('error', circular, undefined)
  assert.ok(line.includes('toastr.error'))
  assert.ok(line.length > 0)
})

test('a wordless toast says so instead of rendering an empty line', () => {
  const line = describeToast('info', undefined, undefined)
  assert.ok(line.includes('no text'))
})

test('long text is truncated but the opening \u2014 which names the fault \u2014 survives', () => {
  const long = `the real fault is here ${'x'.repeat(2000)}`
  const line = describeToast('error', long, undefined)
  assert.ok(line.includes('the real fault is here'))
  assert.ok(line.length < 400, `expected truncation, got ${String(line.length)} characters`)
})

test('the first call declares the substitution, and only the first', () => {
  const { lines, report } = recorder()
  const toastr = createReportingToastr(report)
  toastr.error('one')
  toastr.error('two')
  assert.equal(lines.filter(line => line === TOASTR_SUBSTITUTION_NOTICE).length, 1)
  // Named absence is kept: the panel says plainly that this is not a real toastr.
  assert.ok(lines[0]?.includes('no toastr'))
})

test('every level forwards; none of them is a silent drop', () => {
  const { lines, report } = recorder()
  const toastr = createReportingToastr(report)
  toastr.error('E-text')
  toastr.warning('W-text')
  toastr.info('I-text')
  toastr.success('S-text')
  for (const marker of ['E-text', 'W-text', 'I-text', 'S-text']) {
    assert.ok(
      lines.some(line => line.includes(marker)),
      `${marker} was accepted and dropped, which is the failure this stub exists to avoid`,
    )
  }
})

test('clear and remove exist and do nothing, rather than being absent', () => {
  const { lines, report } = recorder()
  const toastr = createReportingToastr(report)
  // A card dismissing a toast must not die on a member we forgot; providing the
  // four levels and omitting these would rebuild the trap one method along.
  assert.doesNotThrow(() => {
    toastr.clear()
    toastr.remove()
  })
  assert.equal(lines.length, 0, 'dismissing a toast that was never shown is not worth a report')
})

test('options is assignable, because configuring toastr is a common first line', () => {
  const { report } = recorder()
  const toastr = createReportingToastr(report)
  assert.doesNotThrow(() => {
    toastr.options = { timeOut: 3000 }
    toastr.options['positionClass'] = 'toast-top-right'
  })
})
