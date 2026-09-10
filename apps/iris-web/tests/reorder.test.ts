/**
 * The arithmetic a drag runs on, and the markup rules it depends on.
 *
 * Two populations in one file because they fail for one reason. `reorder.ts`
 * decides *where a row lands*; `Sidebar.tsx` decides *what the row is made of*,
 * and the second is what makes the first reachable — a drop index computed
 * perfectly against rows whose trigger is inside a nested button is a correct
 * answer nobody can ask for.
 *
 * The source pins are written the way `sidebar-tabs.test.ts` writes its own,
 * and for the same reason: there is no DOM harness for a `.tsx` in this suite,
 * and a fact about markup is a fact about the file that writes it. Each of them
 * asserts the string it looks for is **there** before asserting anything about
 * it, so a rename cannot turn a pin into a silent pass.
 *
 * @module iris-web/tests/reorder
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { dropIndex, makeWay, moveItem } from '../src/app/reorder.ts'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app')
const sidebar = readFileSync(join(APP, 'Sidebar.tsx'), 'utf8')

/** Four 44px rows on a 4px rhythm: centres 22, 70, 118, 166. */
const CENTRES = [22, 70, 118, 166]

/**
 * One component's own JSX, so a correct row elsewhere in the file cannot
 * satisfy an assertion about a broken one.
 * @param declaration - the component's `function X(` line.
 * @returns its source, from the declaration to the closing brace at column 0.
 */
function componentBody(declaration: string): string {
  const opens = sidebar.indexOf(declaration)
  assert.ok(opens > 0, `${declaration} was renamed or removed`)
  const closes = sidebar.indexOf('\n}\n', opens)
  assert.ok(closes > opens, `${declaration} has no closing brace: the slice below would run to the file's end`)
  return sidebar.slice(opens, closes)
}

test('moveItem places the row at the index it will occupy afterwards', () => {
  /*
   * The convention is the whole point of the function, and both readings are
   * defensible: "move A to 2" of [A,B,C] is [B,C,A] if 2 counts in the finished
   * array and [B,A,C] if it counts in the original. `dropIndex` answers in the
   * first, so this is what the pair means.
   */
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a'])
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'])
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 2), ['a', 'c', 'b'])
})

test('moveItem never loses a row, and never invents one', () => {
  const ids = ['a', 'b', 'c', 'd']
  for (let from = 0; from < ids.length; from += 1) {
    for (let to = 0; to < ids.length; to += 1) {
      const moved = moveItem(ids, from, to)
      assert.equal(moved.length, ids.length, `${String(from)} to ${String(to)} changed the row count`)
      assert.deepEqual(
        [...moved].sort(),
        [...ids].sort(),
        `${String(from)} to ${String(to)} lost or duplicated a row`,
      )
    }
  }
})

test('a move that goes nowhere returns the order untouched, and the input is never mutated', () => {
  const ids = ['a', 'b', 'c']
  assert.deepEqual(moveItem(ids, 1, 1), ids)
  // Out of range in both directions: a drag can end on an index the list no
  // longer has, when a chat was deleted in another tab mid-gesture.
  assert.deepEqual(moveItem(ids, 0, 9), ids)
  assert.deepEqual(moveItem(ids, -1, 0), ids)
  assert.deepEqual(moveItem(ids, 0, -1), ids)
  assert.deepEqual(ids, ['a', 'b', 'c'], 'moveItem mutated its input')
})

test('dropIndex counts the resting centres above the pointer, ignoring the row in hand', () => {
  // Carrying the first row down past the second: the moment its centre passes
  // 70 it belongs after it.
  assert.equal(dropIndex(CENTRES, 0, 22), 0, 'a row that has not moved should stay where it is')
  assert.equal(dropIndex(CENTRES, 0, 69), 0)
  assert.equal(dropIndex(CENTRES, 0, 71), 1)
  assert.equal(dropIndex(CENTRES, 0, 119), 2)
  // And upward: the last row rises past the third's centre.
  assert.equal(dropIndex(CENTRES, 3, 166), 3)
  assert.equal(dropIndex(CENTRES, 3, 117), 2)
  assert.equal(dropIndex(CENTRES, 3, 21), 0)
})

test('dropIndex clamps to the list rather than running off either end', () => {
  // A pointer dragged far above or below the panel — which happens on every
  // drag that ends near the window's edge — must still name a real index.
  assert.equal(dropIndex(CENTRES, 1, -4000), 0)
  assert.equal(dropIndex(CENTRES, 1, 4000), CENTRES.length - 1)
  assert.equal(dropIndex([], 0, 10), 0, 'an empty list has no index to name but must not throw')
})

test('dropIndex and moveItem agree: passing one neighbour swaps with that neighbour', () => {
  /*
   * The property that matters, stated over the pair rather than over either.
   * Each alone can be self-consistently wrong, and the classic failure needs
   * both to show: an index computed against the list *including* the dragged
   * row and applied to the list without it lands every downward drag one row
   * short, and looks perfectly sensible in either function on its own.
   *
   * The boundary is asymmetric on purpose, and this is what it means: a row has
   * to carry its centre **past** a neighbour's to swap with it, so the pointer
   * goes one pixel beyond in the direction of travel. Testing at the centre
   * exactly would be testing a tie-break, which is a different question and not
   * one a reader can aim at.
   */
  const ids = ['a', 'b', 'c', 'd']
  for (let from = 0; from < ids.length; from += 1) {
    for (let passed = 0; passed < ids.length; passed += 1) {
      if (passed === from) continue
      const down = passed > from
      const to = dropIndex(CENTRES, from, (CENTRES[passed] ?? 0) + (down ? 1 : -1))
      assert.equal(to, passed, `carrying row ${String(from)} past row ${String(passed)} named index ${String(to)}`)
      const moved = moveItem(ids, from, to)
      assert.equal(moved[passed], ids[from], 'the carried row did not land where the drop index said')
      assert.equal(
        moved[down ? passed - 1 : passed + 1],
        ids[passed],
        'the row that was passed is not on the other side of the carried one',
      )
    }
  }
})

test('makeWay shifts exactly the rows between the row in hand and where it lands', () => {
  // Downward: everything it passes rises by one.
  assert.equal(makeWay(0, 0, 2), 0, 'the row in hand does not make way for itself')
  assert.equal(makeWay(1, 0, 2), -1)
  assert.equal(makeWay(2, 0, 2), -1)
  assert.equal(makeWay(3, 0, 2), 0, 'a row past the drop point must not move')
  // Upward: everything it passes falls by one.
  assert.equal(makeWay(1, 3, 1), 1)
  assert.equal(makeWay(2, 3, 1), 1)
  assert.equal(makeWay(0, 3, 1), 0)
  // A drag that has not left its own slot moves nothing at all.
  for (const index of [0, 1, 2, 3]) assert.equal(makeWay(index, 2, 2), 0)
})

test('makeWay opens exactly one row of space, wherever the row is going', () => {
  /*
   * The invariant behind the animation: the rows that shift are exactly the
   * ones between the two positions, so the gap that opens is one row wide. Two
   * gaps in a four-row list is what an off-by-one in either bound looks like on
   * screen, and it is not something the numbers above would catch on their own.
   */
  for (let from = 0; from < 4; from += 1) {
    for (let to = 0; to < 4; to += 1) {
      const shifted = [0, 1, 2, 3].map(index => makeWay(index, from, to))
      const moving = shifted.filter(step => step !== 0)
      assert.equal(
        moving.length,
        Math.abs(to - from),
        `${String(from)} to ${String(to)} moved the wrong number of rows`,
      )
      assert.equal(
        new Set(moving).size,
        moving.length === 0 ? 0 : 1,
        `${String(from)} to ${String(to)} moved rows in two directions at once`,
      )
    }
  }
})

// ------------------------------------------------------------- source pins

test('a row is one button, and its own controls are that button’s siblings', () => {
  /*
   * The redesign's structural rule, and the one that fails invisibly: a
   * `<button>` inside a `<button>` renders, looks right, and is repaired by the
   * parser hoisting the inner one *out* of the outer — so the control the
   * reader sees inside the row is somewhere else in the DOM, at a different tab
   * position, with a different event target.
   */
  for (const component of ['function ChatRow(', 'function CharacterRow(']) {
    const body = componentBody(component)
    /*
     * Anchored on the row button's own two-class name rather than on the
     * `iris-row` prefix. The prefix also matches `iris-row__slot`, the dashed
     * well a lifted row draws *before* its button — so the first version of
     * this pin sliced from the well and read the markup around the button
     * instead of the markup inside it, and still passed.
     */
    const named = body.indexOf('className="iris-row iris-row--')
    assert.ok(named > 0, `${component} no longer renders a row with a kind`)
    const rowOpens = body.lastIndexOf('<button', named)
    assert.ok(rowOpens > 0, `${component}'s row is not a button any more`)
    const rowCloses = body.indexOf('</button>', rowOpens)
    assert.ok(rowCloses > named, `${component}'s row button never closes`)
    const inside = body.slice(rowOpens + '<button'.length, rowCloses)
    assert.doesNotMatch(
      inside,
      /<button/,
      `${component} nests a button inside the row button; the browser will hoist it out of the row`,
    )
    // And the controls are there, outside it — a row with no second control at
    // all would satisfy the assertion above for the wrong reason.
    const acts = body.indexOf('className="iris-row__acts"')
    assert.ok(acts > rowCloses, `${component} has no actions cell after the row button`)
    assert.match(body.slice(acts), /className="iris-row__more"/, `${component}'s actions cell is empty`)
  }
})

test('the reorder request carries the whole visible order, branches included', () => {
  /*
   * Two facts about one call, and the second is the one that was got wrong
   * first. The host treats an id its arrangement does not name as newer than
   * the arrangement and puts it on top — so sending only the root rows would
   * detach every branch from the conversation it left, the moment anything is
   * dragged.
   */
  const commit = sidebar.slice(sidebar.indexOf('const commitDrag ='))
  assert.ok(commit.length > 0, 'the drag no longer has a committer')
  const body = commit.slice(0, commit.indexOf('reorderChats') + 'reorderChats(flat)'.length)
  assert.ok(body.includes('moveItem('), 'the drag no longer computes its order with moveItem')
  assert.match(
    body,
    /flatMap\(id => \[id, \.\.\.childrenOf\(id\)/,
    'the reorder request no longer flattens each root together with its branches',
  )
  assert.match(body, /actions\.reorderChats\(flat\)/, 'the flattened order is not what gets sent')
})

test('only a root row offers a handle, because a branch’s place is derived', () => {
  // A branch renders under the conversation it left, so a handle on one would
  // offer a move the list undoes on the next render.
  assert.match(
    sidebar,
    /drag=\{depth > 0 \? undefined : \{/,
    'a branch row is being given a drag handle, or the guard was renamed',
  )
})

test('the keyboard alternative is Alt+arrow, and it is on the row itself', () => {
  /*
   * Alt, not a bare arrow: the arrows scroll the list, and a reader stepping
   * through rows with them must not reorder the list by accident. On the row's
   * own button, so it is reachable by Tab — a handle only a pointer can grip is
   * a feature with a keyboard hole in it.
   */
  const body = componentBody('function ChatRow(')
  const key = body.slice(body.indexOf('onKeyDown={event => {'))
  assert.ok(key.length > 0, 'the row has no key handler')
  assert.match(key, /event\.altKey/, 'the keyboard move no longer requires Alt')
  assert.match(key, /ArrowUp/, 'there is no keyboard move upward')
  assert.match(key, /ArrowDown/, 'there is no keyboard move downward')
  assert.match(key, /event\.preventDefault\(\)/, 'the keyboard move lets the list scroll under it')
})
