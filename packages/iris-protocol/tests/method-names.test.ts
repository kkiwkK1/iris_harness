import assert from 'node:assert/strict'
import { test } from 'node:test'

import { requestSchemas } from '../src/index.ts'

/**
 * The shape of a static RPC method name, and the counting trap it hides.
 *
 * This exists because of a real miscount. A survey of the protocol table read
 * the literal with the grep `^  '[a-zA-Z]*\.[a-zA-Z]*': z\.` — a pattern that
 * matches exactly two segments — and reported a total that every later reader
 * inherited. It was wrong: `stCompat.plane.attach` and `stCompat.plane.detach`
 * have three, so they were dropped in silence, and the per-domain row for
 * `stCompat` was halved with them. Nothing went red, because a two-segment
 * regex over a table that is mostly two-segment names produces a plausible
 * number rather than an error.
 *
 * So the rule is pinned here instead of the number. A name is dotted segments
 * of ASCII letters, *two or more* — that is what the table has always meant,
 * and it is the claim a counting tool has to honour. The total is deliberately
 * not asserted: it moves every time a method is added, and a test that fails
 * on correct changes gets its number bumped without being read. Where the
 * total matters it appears in a failure message, computed at run time.
 */

/** Dotted ASCII segments, two or more. */
const METHOD_NAME = /^[a-zA-Z]+(\.[a-zA-Z]+)+$/

test('every static method name is dotted ASCII segments, two or more', () => {
  const names = Object.keys(requestSchemas)

  // Without this, an empty or unreadable table passes the loop below by
  // never entering it.
  assert.ok(names.length > 50, `expected the static table to be populated, saw ${names.length} names`)

  for (const name of names) {
    assert.match(name, METHOD_NAME, `method name ${JSON.stringify(name)} is not dotted ASCII segments`)
  }
})

test('names deeper than two segments exist, so a two-segment-only count undercounts the table', t => {
  const names = Object.keys(requestSchemas)
  const deeper = names.filter(name => name.split('.').length > 2)
  // What the survey's pattern would have matched.
  const naive = names.filter(name => /^[a-zA-Z]+\.[a-zA-Z]+$/.test(name))

  // Reported on every run, not asserted: the counts are evidence about this
  // commit and they move with the table, while the claim being defended —
  // "two segments is not the whole shape" — does not.
  t.diagnostic(
    `${names.length} static method names: ${naive.length} of exactly two segments, ` +
      `${deeper.length} deeper (${deeper.join(', ') || 'none'})`,
  )

  assert.ok(
    deeper.length > 0,
    `every static method name now has exactly two segments (${names.length} of them), so a ` +
      'two-segment-only pattern would no longer undercount the table and this test has nothing ' +
      'to defend. Delete it rather than relaxing it. It exists because a survey counted the ' +
      "table with the grep `^  '[a-zA-Z]*\\.[a-zA-Z]*': z\\.`, silently dropped every deeper " +
      'name, and published a total that read as complete. Count over the keys of ' +
      'requestSchemas, never over a grep of the source literal.',
  )
})
