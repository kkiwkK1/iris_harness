/**
 * `allow-forms` and the frame's own submission neutraliser — the pair that
 * makes a card's `<form>` behave the way it does upstream.
 *
 * The two halves live in different files and neither can see the other:
 * `policy.ts` grants the flag, `frame-entry.ts` eats the navigation. Granting
 * the flag without the neutraliser lets a real submission navigate a `srcdoc`
 * frame away from the card's own document; installing the neutraliser without
 * the flag leaves the browser blocking the submission before any card code
 * runs, which is the silent failure this pair exists to close — a card's
 * opening page whose "翻开序章" button did nothing, with no error on any
 * channel Iris watches.
 *
 * A refactor can drop either side while every test that drives the other stays
 * green, so the pairing is pinned here, at the source. That is the shape the
 * neighbouring `console-capture.test.ts` guards its own call site with, and for
 * the same reason.
 *
 * @module iris-web/tests/sandbox-forms
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const entry = readFileSync(join(here, 'src', 'sandbox', 'frame-entry.ts'), 'utf8')
const policy = readFileSync(join(here, 'src', 'sandbox', 'policy.ts'), 'utf8')

test('the sandbox grants allow-forms', () => {
  // Without the flag the browser blocks the submission before the frame has a
  // listener, and the click does nothing on no channel Iris watches.
  assert.match(policy, /allow-forms/u, 'frameSandbox no longer grants allow-forms')
})

test('the frame neutralises submissions in the capture phase', () => {
  // A plain bubble-phase listener would lose to a card that never installed
  // one: the navigation happens first. Capture is the whole point, so the
  // boolean is asserted rather than the call alone.
  assert.match(
    entry,
    /addEventListener\(\s*'submit',[\s\S]*?preventDefault\(\)[\s\S]*?true\s*,/u,
    'the frame no longer preventDefaults submit in the capture phase',
  )
})

test('the neutraliser is installed before the document body parses', () => {
  // An interface frame's inline markup executes during parse, so a listener
  // installed at `load` would miss the first form a reader touches. The
  // bootstrap is a blocking classic `<script src>`, so executing in its own
  // top-level flow is what guarantees precedence — pinned by position against
  // `announceReady`, which is the frame telling the shell it is up.
  const submitAt = entry.indexOf("'submit'")
  const readyAt = entry.indexOf('announceReady(run, post,')
  assert.ok(submitAt !== -1, 'the frame never listens for submit')
  assert.ok(readyAt !== -1, 'the frame never announces ready')
  assert.ok(
    submitAt < readyAt,
    'the submit neutraliser was installed after announceReady, so it can miss the first form',
  )
})
