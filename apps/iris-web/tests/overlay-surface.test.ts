/**
 * The one box a card's overlay is told about.
 *
 * The surface used to be the whole window and the published viewport used to
 * be `window.innerWidth/innerHeight` — two sources for one fact, and the
 * mismatch between them is a failure a user measured before it had a name: a
 * frame laying out at 1449px against a viewport the shell believed was 1218px.
 * These tests pin the rule that ended that class: **the surface element is the
 * single source of truth**, and the window is only ever the answer for the one
 * state where no surface exists to measure.
 *
 * @module iris-web/tests/overlay-surface
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { overlayViewport } from '../src/app/overlay-surface.ts'

const WINDOW = { width: 1449, height: 900 }

test('the surface box is what the card hears', () => {
  /*
   * The surface is the reading column's box and the frame fills it, so its
   * content box *is* the frame's viewport. The numbers are deliberately not
   * the window's — that is the whole point.
   */
  const surface = { clientWidth: 1038, clientHeight: 612 }

  assert.deepEqual(overlayViewport(surface, WINDOW), { width: 1038, height: 612 })
})

test('before the surface exists, the window is the fallback', () => {
  /*
   * `mount.current === null` is the moment before the run's frame is attached —
   * no element has ever existed to measure, and the window is closer to the
   * truth than nothing.
   */
  assert.deepEqual(overlayViewport(null, WINDOW), WINDOW)
  assert.deepEqual(overlayViewport(undefined, WINDOW), WINDOW)
})

test('a zero-sized surface is reported as zero, not swapped for the window', () => {
  /*
   * The tempting rescue — "the box measured 0, so fall back to the window" —
   * is the two-sources mistake again, wearing a rescue costume: a frame inside
   * a zero box is zero-sized, and telling the card 1449×900 while its every
   * measurement returns zero is precisely the 1449-vs-1218 disagreement this
   * module exists to end, pointed in the opposite direction.
   */
  const surface = { clientWidth: 0, clientHeight: 0 }

  assert.deepEqual(overlayViewport(surface, WINDOW), { width: 0, height: 0 })
})
