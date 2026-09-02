/**
 * The reading view's tail window.
 *
 * @module iris-web/tests/reading-window
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { DEFAULT_WINDOW, grow, readingWindow } from '../src/app/reading-window.ts'

/** A conversation of numbered messages, oldest first. */
function chat(count: number): number[] {
  return Array.from({ length: count }, (_unused, at) => at)
}

test('the window is a tail, so the newest messages are always the mounted ones', () => {
  /*
   * A tail rather than a range with an offset, and that choice does the work:
   * a chat growing while the reader watches needs no recalculation, and the
   * anchor is the end of the conversation — which is where a reader of a live
   * chat already is.
   */
  const { visible, hidden } = readingWindow(chat(10), 3)

  assert.deepEqual(visible, [7, 8, 9])
  assert.equal(hidden, 7)
})

test('zero means everything, matching both upstream and the frame window', () => {
  /*
   * Upstream's `power_user.chat_truncation || Number.MAX_SAFE_INTEGER`
   * (`script.js:1477`): dragging the slider to zero switches truncation *off*.
   * The frame layer used to spell a depth the same way, in `render-window.ts`;
   * that file is gone and the frame layer rations bytes instead, so this is now
   * the only window in the product with a count.
   *
   * The convention still has to be right here. One number meaning "everything"
   * in one place and "nothing" in another, inside one product, is a defect lying in wait for
   * whoever reads only one of them — and the reading of it that produces an
   * empty screen looks like a crash rather than a setting.
   */
  assert.deepEqual(readingWindow(chat(5), 0), { visible: [0, 1, 2, 3, 4], hidden: 0 })
  assert.deepEqual(readingWindow(chat(5), -1), { visible: [0, 1, 2, 3, 4], hidden: 0 })
})

test('a conversation shorter than the window is shown whole, with nothing hidden', () => {
  // The common case by a wide margin: 30 of the corpus's 31 chats are under 100
  // messages, so for almost every conversation this is an identity.
  assert.deepEqual(readingWindow(chat(4), DEFAULT_WINDOW), {
    visible: [0, 1, 2, 3],
    hidden: 0,
  })
})

test('an empty conversation windows to nothing without special-casing', () => {
  assert.deepEqual(readingWindow([], DEFAULT_WINDOW), { visible: [], hidden: 0 })
  assert.deepEqual(readingWindow([], 0), { visible: [], hidden: 0 })
})

test('the returned list is a copy, so mounting cannot edit the conversation', () => {
  const source = chat(3)
  const { visible } = readingWindow(source, 0)
  visible.push(99)

  assert.deepEqual(source, [0, 1, 2])
})

test('growing adds another window and stops at the whole conversation', () => {
  // Upstream adds the same amount each press and drops the control at zero
  // (`script.js:1447`, `:1462`), so the caller can remove a button rather than
  // leave one that does nothing.
  assert.equal(grow(100, 100, 677), 200)
  assert.equal(grow(600, 100, 677), 677)
  assert.equal(grow(677, 100, 677), 677, 'growing past the end must not exceed it')
})

test('growing an unlimited window is a no-op, not an accidental limit', () => {
  /*
   * `0` already means everything. Adding a step to it would turn "show all" into
   * "show 100" — a control that silently *removes* messages while claiming to
   * add them.
   */
  assert.equal(grow(0, 100, 677), 0)
})

test('the window and the count it reports always agree', () => {
  /*
   * The two halves are read by different parts of the view — one mounts rows,
   * the other labels the control — so a disagreement would show as a button
   * offering to reveal messages that are already on screen.
   */
  for (const shown of [1, 7, 99, 100, 101]) {
    const windowed = readingWindow(chat(150), shown)
    assert.equal(
      windowed.visible.length + windowed.hidden,
      150,
      `the window loses or invents messages at ${String(shown)}`,
    )
  }
})
