/**
 * The clip that decides which parts of a full-viewport card frame catch a click.
 *
 * @module iris-web/tests/overlay-regions
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  type Measured,
  type Region,
  clipPathFor,
  collectRegions,
  mergeRegions,
} from '../src/sandbox/overlay-regions.ts'

const at = (x: number, y: number, width: number, height: number): Region =>
  ({ x, y, width, height })

test('nothing built means nothing catches, which is not the same as no clip', () => {
  /*
   * **`none` would be the dangerous answer.** It means "no clip", so the frame
   * catches every click over the whole viewport — a card that has built nothing
   * yet would swallow the shell. Zero area keeps one code path: always
   * `pointer-events:auto`, always clipped, no second state to be in the wrong
   * one of.
   */
  const empty = clipPathFor([])
  assert.match(empty, /^path\("M0 0Z"\)$/)
  assert.doesNotMatch(empty, /none/)
})

test('a rectangle becomes a subpath a browser hit-tests', () => {
  // The shape was measured in a real frame: inside the path the frame catches,
  // outside it the click reaches the shell.
  assert.equal(clipPathFor([at(200, 200, 80, 80)]), 'path("M200 200H280V280H200Z")')
})

test('disjoint rectangles are separate subpaths, because a card builds several', () => {
  /*
   * A floating button **and** a panel. `polygon()` is one polygon and cannot
   * express two areas, so this has to be `path()` with several subpaths —
   * measured to hit-test correctly, with the gap between them passing through.
   */
  const path = clipPathFor([at(200, 200, 80, 80), at(600, 400, 120, 60)])
  assert.equal(path, 'path("M200 200H280V280H200Z M600 400H720V460H600Z")')
})

test('an empty rectangle contributes nothing', () => {
  // A card's hidden container measures 0×0 and would add a subpath that catches
  // nothing while making the path longer.
  assert.deepEqual(mergeRegions([at(10, 10, 0, 0), at(10, 10, 5, 0), at(10, 10, 0, 5)]), [])
})

test('a rectangle inside another is dropped, so the path tracks the interface not the DOM', () => {
  /*
   * A card's panel and every node inside it all report rectangles. Keeping the
   * children makes the path grow with the card's DOM for no change in what is
   * hit-testable — and this path crosses a message boundary on every mutation.
   */
  const merged = mergeRegions([at(0, 0, 100, 100), at(10, 10, 20, 20), at(50, 50, 10, 10)])
  assert.deepEqual(merged, [at(0, 0, 100, 100)])
})

test('a rectangle that only overlaps is kept, because part of it is still reachable', () => {
  // Containment is the test, not intersection: half of the second rectangle is
  // outside the first, and a click there must still reach the card.
  const merged = mergeRegions([at(0, 0, 100, 100), at(90, 90, 40, 40)])
  assert.equal(merged.length, 2)
})

test('sub-pixel rectangles round outward, never inward', () => {
  /*
   * `getBoundingClientRect` returns fractions. Rounding **outward** matters more
   * than rounding at all: a clip one pixel short of the node is an edge where a
   * card's own button stops responding, and "the corner doesn't work" is a bug
   * report nobody can reproduce.
   */
  const [region] = mergeRegions([at(10.4, 20.6, 30.3, 40.1)])
  assert.equal(region?.x, 10)
  assert.equal(region?.y, 20)
  // Right edge: 10.4 + 30.3 = 40.7 → 41, from x=10, so width 31.
  assert.equal((region?.x ?? 0) + (region?.width ?? 0) >= 40.7, true, 'the right edge shrank')
  assert.equal((region?.y ?? 0) + (region?.height ?? 0) >= 60.7, true, 'the bottom edge shrank')
})

/** A node in a tree the collector can walk. */
interface Node {
  rect: Region
  interactive?: boolean
  children?: Node[]
}

/** Measure one, the way the DOM collector will. */
function tree(node: Node): { measured: Measured, children: readonly Node[] } {
  return {
    measured: { rect: node.rect, interactive: node.interactive ?? true },
    children: node.children ?? [],
  }
}

test('a taken element prunes its children, keeping the walk proportional to the interface', () => {
  const child: Node = { rect: at(10, 10, 10, 10) }
  const root: Node = { rect: at(0, 0, 100, 100), children: [child] }
  const walked: Node[] = []

  const regions = collectRegions([root], node => {
    walked.push(node)
    return tree(node)
  })

  assert.deepEqual(regions, [at(0, 0, 100, 100)])
  assert.deepEqual(walked, [root], 'the children of a taken element were measured anyway')
})

test('a pointer-events:none wrapper is descended into, not taken', () => {
  /*
   * **The direction where a mistake is worse than the bug this fixes.** A card's
   * decorative layer declares `pointer-events:none` for itself; taking it would
   * make Iris block clicks that upstream lets through. But a
   * `pointer-events:none` wrapper *around* interactive content is a real
   * pattern — a full-screen backdrop that passes clicks except on its buttons —
   * so the walk goes in rather than stopping.
   */
  const button: Node = { rect: at(300, 300, 40, 40) }
  const backdrop: Node = { rect: at(0, 0, 1000, 1000), interactive: false, children: [button] }

  const regions = collectRegions([backdrop], node => tree(node))

  assert.deepEqual(regions, [at(300, 300, 40, 40)], 'the backdrop was clipped as interactive')
})

test('a pathological tree cannot hang the frame', () => {
  /*
   * This runs inside a card's frame, on a DOM the card controls, from a mutation
   * observer callback. A hung frame reports nothing at all — worse than a clip
   * that is merely incomplete — so the walk has a ceiling.
   */
  let made = 0
  const regions = collectRegions([0], () => {
    made += 1
    // Every node is a non-interactive wrapper with two more, forever.
    return {
      measured: { rect: at(0, 0, 10, 10), interactive: false },
      children: [made * 2, made * 2 + 1],
    }
  })
  assert.ok(made <= 2_001, `the walk did not stop: ${String(made)} nodes`)
  assert.deepEqual(regions, [])
})

test('the path a real card shape produces is short', () => {
  // The whole point of the pruning and rounding: this string is regenerated on
  // every mutation and crosses a message boundary.
  const path = clipPathFor([
    at(0, 0, 390.4, 844.2),
    at(20.1, 100.7, 350.2, 600.9),
    at(340, 780.3, 44, 44),
  ])
  assert.ok(path.length < 60, `${String(path.length)} characters: ${path}`)
})
