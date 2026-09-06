/**
 * Growing the reading window must not rebuild a frame that is already up.
 *
 * `notes/apps/iris-web/WINDOWING.md` §七 acceptance 2 is worded as a browser observation — press
 * "show earlier" and watch that no existing frame is rebuilt. The mechanism
 * underneath is not visual, though: a message frame is rebuilt exactly when its
 * row unmounts or when one of `useMessageInterfaces`'s effect dependencies
 * changes — `floor`, `text`, `allowed`, `gate`. So the criterion holds if and
 * only if those five things are stable across the growth, and that is
 * computable here without a browser.
 *
 * This does not replace looking at the page. It replaces *trusting* that the
 * plan and the window agree, which is the part a person watching a page cannot
 * check and cannot re-check on every change.
 *
 * @module iris-web/tests/window-growth
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_WINDOW, readingWindow } from '../src/app/reading-window.ts'
import {
  floorOf,
  instancesOf,
  planFrames,
  type FrameCandidate,
} from '../src/app/frame-budget.ts'

/** One synthetic row, shaped like the fields the window and the plan read. */
interface Row {
  id: number
  key: string
  text: string
  turn: number
  /** How big this row's interface is, or 0 for a row that has none. */
  interfaceBytes: number
}

/**
 * A conversation of `floors` rows, one in `every` of them carrying an interface.
 *
 * Sizes vary so the budget actually has decisions to make: a fixture where
 * everything fits would agree with any implementation of the invariant.
 *
 * `every` is a parameter because the two properties here need opposite
 * fixtures, and one fixture serving both measured nothing in the second. Dense
 * interfaces exhaust the budget, which is what "nothing was revoked" needs to
 * mean anything. But dense interfaces also fill the count gate entirely from
 * the newest floors — so every granted frame is inside even the narrow window,
 * no frame ever leaves it, and the test for what happens when one does ran its
 * loop zero times while passing.
 * @param floors - how many rows.
 * @param every - one row in this many carries an interface.
 * @returns the rows, oldest first.
 */
function conversation(floors: number, every = 3): Row[] {
  return Array.from({ length: floors }, (_unused, at) => ({
    id: at,
    key: `row-${String(at)}`,
    text: `floor ${String(at)}`,
    // Two rows per turn, so a window boundary can fall inside one.
    turn: Math.floor(at / 2) + 1,
    interfaceBytes: at % every === 0 ? 20_000 + (at % 7) * 30_000 : 0,
  }))
}

/** The candidates a mounted window offers the plan. */
function candidatesOf(rows: readonly Row[]): FrameCandidate[] {
  return rows
    .filter(row => row.interfaceBytes > 0)
    .map(row => ({ floor: row.id, instance: 0, body: 'x'.repeat(row.interfaceBytes) }))
}

/**
 * This floor's gate signature, the effect dependency the row actually sees.
 *
 * Built from `instancesOf` rather than by splitting keys here. The first
 * version of this helper re-derived the key format, which made it agree with a
 * broken `frameKey` exactly as readily as with a working one — a check must not
 * be same-source as the thing it checks.
 */
function gateOf(floor: number, refused: ReadonlySet<string>): string {
  return instancesOf(floor, refused).join(',')
}

test('growing the window changes nothing a mounted row would rebuild on', () => {
  const all = conversation(677)

  const before = readingWindow(all, DEFAULT_WINDOW, row => row.turn)
  const firstPlan = planFrames(candidatesOf(before.visible), {
    granted: new Set(),
    opened: new Set(),
  })

  // The fixture has to be one where the budget refuses something, or "nothing
  // was revoked" is true of a plan that never decided anything.
  assert.ok(firstPlan.refused.size > 0, 'the fixture must exhaust the budget')
  assert.ok(firstPlan.render.size > 0, 'the fixture must also build something')

  const after = readingWindow(all, DEFAULT_WINDOW * 2, row => row.turn)
  const secondPlan = planFrames(candidatesOf(after.visible), {
    granted: firstPlan.render,
    opened: new Set(),
  })

  assert.ok(after.visible.length > before.visible.length, 'the window did not grow')

  const stillMounted = new Map(after.visible.map(row => [row.id, row]))
  for (const row of before.visible) {
    const now = stillMounted.get(row.id)
    assert.ok(now !== undefined, `floor ${String(row.id)} was unmounted by growth`)

    // React's key: a changed key is a different component, so the frame goes.
    assert.equal(now.key, row.key, `floor ${String(row.id)} changed identity`)
    // `text` is an effect dependency, because an edit or a swipe *should* rebuild.
    assert.equal(now.text, row.text, `floor ${String(row.id)} changed text`)
    // And the gate, which is the dependency this layer introduced.
    assert.equal(
      gateOf(row.id, secondPlan.refused),
      gateOf(row.id, firstPlan.refused),
      `floor ${String(row.id)} had its budget decision changed by growth`,
    )
  }
})

test('the frames that were up are all still up after two growths', () => {
  /*
   * Stated on the render set as well as on the gate, because they are two
   * different claims and only one of them is about rebuilding. A frame could
   * keep an unchanged gate and still be gone if the plan simply stopped
   * offering it — this asserts the set itself only grows.
   *
   * Twice, because the invariant is carried forward through `granted`: a
   * version that held grants for one round and then recomputed from scratch
   * would pass a single-step test.
   */
  const all = conversation(677)
  let granted: ReadonlySet<string> = new Set()
  const seen: ReadonlySet<string>[] = []

  for (const shown of [DEFAULT_WINDOW, DEFAULT_WINDOW * 2, DEFAULT_WINDOW * 3]) {
    const mounted = readingWindow(all, shown, row => row.turn)
    const plan = planFrames(candidatesOf(mounted.visible), { granted, opened: new Set() })
    granted = plan.render
    seen.push(plan.render)
  }

  const [first, second, third] = seen
  assert.ok(first !== undefined && second !== undefined && third !== undefined)
  for (const key of first) assert.ok(second.has(key), `${key} lost after one growth`)
  for (const key of second) assert.ok(third.has(key), `${key} lost after two growths`)
})

test('a floor that leaves the window is the one case a frame does go', () => {
  /*
   * The counterpart, so "nothing is ever revoked" is not read as stronger than
   * it is. Unmounting is how a frame is *supposed* to end — it is the lifecycle
   * anchor — and the budget it held has to come back, or the view would leak its
   * whole budget over a long session.
   */
  /*
   * Sparse interfaces, so the plan reaches back past the narrow window. With
   * one interface every third row the count gate is filled by the newest floors
   * alone, every grant sits inside both windows, and the loop below has nothing
   * to examine — which is how the first version of this test passed while
   * checking nothing.
   */
  const all = conversation(677, 15)
  const wide = readingWindow(all, DEFAULT_WINDOW * 2, row => row.turn)
  const widePlan = planFrames(candidatesOf(wide.visible), {
    granted: new Set(),
    opened: new Set(),
  })

  // Opening another chat resets the window; here, the same arithmetic shrinking.
  const narrow = readingWindow(all, DEFAULT_WINDOW, row => row.turn)
  const narrowPlan = planFrames(candidatesOf(narrow.visible), {
    granted: widePlan.render,
    opened: new Set(),
  })

  const mounted = new Set(narrow.visible.map(row => row.id))
  let examined = 0
  for (const key of widePlan.render) {
    const floor = floorOf(key)
    if (floor === undefined || mounted.has(floor)) continue
    examined += 1
    assert.equal(narrowPlan.render.has(key), false, `${key} survived its row unmounting`)
  }

  // The loop skips every frame still mounted, so without this the test passes
  // by examining none of them.
  assert.ok(examined > 0, 'no granted frame left the window — the fixture proves nothing')
  assert.ok(
    narrowPlan.spent < widePlan.spent,
    `the shrunk window returned no budget (${String(narrowPlan.spent)} vs ${String(widePlan.spent)})`,
  )
})
