/**
 * The host report list's two display decisions.
 *
 * Both were written inside `HostReports.tsx` first, where `node --test` cannot
 * reach them. They are out here because they decide something, and the rule this
 * project paid for is that a decision in an unloadable file is a decision
 * nothing asserts.
 *
 * @module iris-web/tests/host-report-rows
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DebugReport } from '@iris/protocol'

import { classForReport, collapseRuns } from '../src/app/host-report-rows.ts'

/** A record, with only the fields these decisions read spelled out. */
function report(seq: number, kind: string, message: string, at = seq * 1000): DebugReport {
  return { grade: 'note', seq, at, kind, message }
}

test('a run of identical reports becomes one row that counts them', () => {
  /*
   * The case this exists for: "6 script injections are still live on this chat
   * from an earlier session" is a standing condition the host raises **once per
   * chat open**, so after a few opens the buffer is mostly that one sentence and
   * everything else is off the screen.
   */
  const rows = collapseRuns([
    report(1, 'script', 'still live from an earlier session', 1_000),
    report(2, 'script', 'still live from an earlier session', 2_000),
    report(3, 'script', 'still live from an earlier session', 3_000),
  ])

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.count, 3)
  // The newest is the row, so `at` reads as "the last time this was true".
  assert.equal(rows[0]?.report.seq, 3)
  assert.equal(rows[0]?.report.at, 3_000)
  // And the first time survives, or "when did this start?" gets a wrong answer.
  assert.equal(rows[0]?.firstAt, 1_000)
})

test('only consecutive repeats merge, because merging globally reorders evidence', () => {
  /*
   * `A A B A` collapsed across the whole list reads as "A ×3, then B", which
   * asserts that A stopped happening after B. That is a claim about the
   * sequence, made by the display, out of nothing.
   */
  const rows = collapseRuns([
    report(1, 'variables', 'trimmed 21 floors'),
    report(2, 'variables', 'trimmed 21 floors'),
    report(3, 'template', 'evaluated a template'),
    report(4, 'variables', 'trimmed 21 floors'),
  ])

  assert.deepEqual(
    rows.map(row => `${row.report.kind}:${row.count}`),
    ['variables:2', 'template:1', 'variables:1'],
  )
  // The last one is its own row and did not join the first pair.
  assert.equal(rows.length, 3)
  assert.equal(rows[2]?.report.seq, 4)
})

test('identity is the kind and the message, not the seq', () => {
  // Every record has a distinct `seq`, so including it in the identity would
  // collapse nothing at all — the change would look like it worked while doing
  // nothing, which is the failure mode of a display fix.
  const rows = collapseRuns([
    report(1, 'storage', 'the same sentence'),
    report(2, 'storage', 'the same sentence'),
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.count, 2)
})

test('the same sentence from two areas stays two rows', () => {
  // A message alone is not an identity: two areas saying the same thing are two
  // findings, and one of them would vanish.
  const rows = collapseRuns([
    report(1, 'variables', 'nothing to do'),
    report(2, 'template', 'nothing to do'),
  ])
  assert.equal(rows.length, 2)
})

test('a single report keeps its own time as both ends', () => {
  const rows = collapseRuns([report(7, 'host', 'started', 7_000)])
  assert.equal(rows[0]?.count, 1)
  assert.equal(rows[0]?.firstAt, 7_000)
  assert.equal(rows[0]?.report.at, 7_000)
})

test('an empty list collapses to nothing rather than to one empty row', () => {
  assert.deepEqual(collapseRuns([]), [])
})

test('only a fault is marked, and the mark is the grade the reporter set', () => {
  assert.equal(classForReport({ grade: 'fault' }), 'iris-script__report iris-script__report--fault')
  assert.equal(classForReport({ grade: 'note' }), 'iris-script__report')
})
