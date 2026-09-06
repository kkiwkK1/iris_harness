/**
 * The clip that decides which parts of a full-viewport card frame catch a click.
 *
 * @module iris-web/tests/overlay-regions
 */

import { join, dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  type Measured,
  type Region,
  type Visibility,
  clipPathFor,
  collectRegions,
  describeEmptySurface,
  describeFrameViewport,
  describeVisibility,
  mergeRegions,
  regionsKey,
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

test('the reporter survives a frame Chrome refuses to paint', () => {
  /*
   * The shell attaches the frame with the zero-area clip this reporter exists
   * to replace, and Chrome skips rendering a frame whose clip paints nothing:
   * no paint runs, so the frame's `requestAnimationFrame` never fires, so no
   * measurement is asked for, so the clip stays zero-area. Measured end to end
   * on a real card — the shell running its own animation frames at 120 fps
   * beside a frame whose count was zero, its interface fully mounted and laid
   * out inside, and the screen showing the chat through it.
   *
   * `reportRegions` lives in the frame entry, where there is no unit harness,
   * so — as with the height guards in `message-frames.test.ts` — the property
   * is pinned against the source: the schedule must arm a timer beside the
   * animation frame, and the timer must run `send` only while the animation
   * frame it rescues has not. The interval matches the height reporter's
   * non-`rAF` fallback, and the reason is the same sentence in both places.
   */
  const entry = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sandbox', 'frame-entry.ts'),
    'utf8',
  )
  const schedule = entry.slice(entry.indexOf('const schedule = (): void => {'), entry.indexOf('Both observers, for the two ways'))

  assert.match(schedule, /requestAnimationFrame\(send\)/u, 'the batching path is gone')
  assert.match(schedule, /setTimeout\(send, 0\)/u, 'the hidden-tab path is gone')
  assert.match(
    schedule,
    /if \(scheduled\) send\(\)/u,
    'the rescue timer is gone — a zero-area clip then seals its own silence forever',
  )
  assert.match(schedule, /, 500\)/u, 'the rescue interval no longer matches the height fallback')
/*
 * ── The zero-area instrument ────────────────────────────────────────────────
 *
 * All of the following exist because of one live reading: a card's overlay came
 * back `clip-path: path("M 0 0 Z")` — zero area, a blank screen — beside a
 * report that said only "this card built 2 element(s)". Four different repairs
 * fit that sentence (hidden, detached, sized zero, measured before layout) and
 * nothing in the report chose between them. Each test below pins the one fact
 * that eliminates one of those repairs.
 */

/** A measured element with the fields the tests under study care about. */
const shown = (over: Partial<Visibility>): Visibility => ({
  label: 'div',
  rect: { x: 0, y: 0, width: 100, height: 50 },
  display: 'block',
  connected: true,
  // `text` and `paints` are required, and spreading a `Partial` over them would
  // reintroduce `undefined` under `exactOptionalPropertyTypes`.
  text: over.text ?? true,
  paints: over.paints ?? true,
  ...over,
})

test('a zero box is reported even though nothing about it is unusual', () => {
  /*
   * The rest of this description lists deviations — an opacity that is not 1, a
   * display that is not block. A zero box is not a deviation from anything; it
   * is the finding, so it is unconditional, and it is marked so a reader
   * scanning a row of numbers cannot slide past it.
   */
  const line = describeVisibility(shown({ rect: { x: 12, y: 34, width: 0, height: 0 } }))
  assert.ok(line !== undefined, 'a zero-area element must produce a line')
  assert.match(line, /ZERO BOX 0x0 at 12,34/)
})

test('a healthy box still reports its size, so a reader can compare', () => {
  const line = describeVisibility(shown({}))
  assert.ok(line !== undefined && line.includes('100x50'), `no box in: ${String(line)}`)
  assert.ok(!line.includes('ZERO BOX'), `a 100x50 box was called zero: ${line}`)
})

test('display:none and being detached are told apart, because the fixes differ', () => {
  const hidden = describeVisibility(
    shown({ display: 'none', rect: { x: 0, y: 0, width: 0, height: 0 } }),
  )
  const detached = describeVisibility(
    shown({ connected: false, rect: { x: 0, y: 0, width: 0, height: 0 } }),
  )
  assert.match(hidden ?? '', /display none/)
  assert.ok(!(hidden ?? '').includes('NOT IN THE DOCUMENT'), 'a hidden node is in the document')
  assert.match(detached ?? '', /NOT IN THE DOCUMENT/)
})

test('the inline style rides along on a zero box, and only there', () => {
  /*
   * **This is the field that decides the card under investigation.** It sets
   * seven properties on its overlay frame with `!important` after appending it
   * (`display:block`, `width:100vw`, `height:100vh`), and hides itself later
   * with `display:none !important`. The computed `display` cannot say which of
   * those happened; the attribute text can, because `!important` survives in it
   * verbatim.
   *
   * And only on a zero box: it is long, and a healthy element does not need it.
   */
  const style = 'display: none !important; width: 100vw !important'
  const empty = describeVisibility(
    shown({ inline: style, rect: { x: 0, y: 0, width: 0, height: 0 } }),
  )
  assert.ok((empty ?? '').includes(style), `the attribute text was dropped: ${String(empty)}`)
  const healthy = describeVisibility(shown({ inline: style }))
  assert.ok(
    !(healthy ?? '').includes('style="'),
    `a healthy element carried its inline style: ${String(healthy)}`,
  )
})

test('our stand-in is named as ours, so the owner of the bug is not guessed', () => {
  const ours = describeVisibility(shown({ standIn: true }))
  assert.match(ours ?? '', /our nested-frame stand-in/)
  const theirs = describeVisibility(shown({}))
  assert.ok(
    !(theirs ?? '').includes('stand-in'),
    `a card's own element was claimed as ours: ${String(theirs)}`,
  )
})

test('the empty-surface sentence fires only when every element is empty', () => {
  /*
   * `zero < total` and not `zero > 0`: one empty element among four is normal
   * (a spacer, a collapsed panel), and saying "the clip is empty" then would be
   * false — the clip has the other three in it.
   */
  assert.match(
    describeEmptySurface(2, 2) ?? '',
    /all 2 element\(s\).*measured zero area.*clip is empty/,
  )
  assert.equal(describeEmptySurface(1, 4), undefined)
  assert.equal(describeEmptySurface(0, 0), undefined, 'a card that built nothing is not this')
})

test('a frame with no layout says so, because vh explains the zeros', () => {
  /*
   * The reading that made this necessary: the same card in the same chat was
   * empty once and full-screen once. A frame that has never been laid out
   * reports `clientHeight === 0`, and an element sized `height:100vh` inside it
   * measures zero **with entirely correct CSS**. Without this clause the report
   * blames the card's styles for something the frame never gave it.
   */
  assert.match(describeFrameViewport({ width: 2498, height: 1353 }), /viewport is 2498x1353/)
  const unlaid = describeFrameViewport({ width: 2498, height: 0 })
  assert.match(unlaid, /NO LAYOUT/)
  assert.match(unlaid, /vw\/vh/)
})

test('the dedup key changes when the viewport does, so recovery is reported', () => {
  /*
   * The failure this prevents is subtle and was real: keyed on the clip alone,
   * the empty diagnosis is sent once and then suppressed forever, because an
   * all-zero card produces the identical empty clip on every pass. The states
   * that must re-report are exactly the ones that keep the clip the same.
   */
  const box = { width: 2498, height: 1297 }
  const same = regionsKey('path("M0 0Z")', 2, 2, box)
  assert.equal(same, regionsKey('path("M0 0Z")', 2, 2, box), 'a still card must stay quiet')
  assert.notEqual(
    same,
    regionsKey('path("M0 0Z")', 2, 2, { width: 2498, height: 1353 }),
    'the frame was laid out at a new size and the report was suppressed',
  )
  assert.notEqual(
    same,
    regionsKey('path("M0 0Z")', 3, 2, box),
    'a third element appeared and the report was suppressed',
  )
  assert.notEqual(
    same,
    regionsKey('path("M0 0Z")', 2, 1, box),
    'one element gained area and the report was suppressed',
  )
})
/*
 * ── The gap the tests above could not see ───────────────────────────────────
 *
 * Every test above hands `describeVisibility` a `Visibility` directly, so they
 * prove the *formatter* handles a zero box. They cannot prove anything about
 * whether a zero box ever **reaches** it, and it did not: the collector took
 * the record only on the branch that accepts a region, so an all-zero card
 * produced an empty clip, an empty `seen`, a zero count of 0 and no sentence.
 * The instrument built to explain a blank screen was silent on a blank screen,
 * with nine green teeth-checks behind it.
 *
 * These tests go through `collectRegions`, which is where that decision lives.
 */

/** A node for the walk: a box, a visibility record, and children. */
interface Labelled {
  rect: Region
  label: string
  children?: Labelled[]
}

const walk = (roots: Labelled[]): { regions: Region[], seen: Visibility[] } => {
  const seen: Visibility[] = []
  const regions = collectRegions<Labelled>(roots, node => ({
    measured: {
      rect: node.rect,
      interactive: true,
      visibility: shown({ label: node.label, rect: node.rect }),
    },
    children: node.children ?? [],
  }), seen)
  return { regions, seen }
}

test('a zero-area root is still described, or nothing explains the blank screen', () => {
  const { regions, seen } = walk([
    { rect: at(0, 0, 0, 0), label: 'div#app' },
    { rect: at(0, 0, 0, 0), label: 'iframe' },
  ])
  assert.deepEqual(regions, [], 'two empty boxes clip to nothing')
  assert.deepEqual(
    seen.map(it => it.label),
    ['div#app', 'iframe'],
    'both roots must be described even though neither became a region',
  )
  // And the two together are what the reader actually gets.
  assert.match(describeEmptySurface(seen.length, seen.length) ?? '', /clip is empty/)
})

test('a descendant is described only when it becomes a region', () => {
  /*
   * The anti-flood half of the same rule. The walk descends through anything
   * that is not a usable region, so describing every node it touches would put
   * a card's entire subtree — hundreds of lines — through a message channel on
   * every mutation.
   */
  const { seen } = walk([
    {
      rect: at(0, 0, 0, 0),
      label: 'div#wrapper',
      children: [
        { rect: at(0, 0, 0, 0), label: 'div.empty-inner' },
        { rect: at(5, 5, 40, 40), label: 'button' },
      ],
    },
  ])
  assert.deepEqual(
    seen.map(it => it.label),
    ['div#wrapper', 'button'],
    'the zero-area descendant must not be listed, the real button must',
  )
})

test('a healthy root is described too, so the report is comparable', () => {
  const { regions, seen } = walk([{ rect: at(0, 0, 390, 844), label: 'div#app' }])
  assert.equal(regions.length, 1)
  assert.deepEqual(seen.map(it => it.label), ['div#app'])
})
