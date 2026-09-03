/**
 * The height write-back loop, closed and stepped until it terminates.
 *
 * The flicker this file exists for was reported as "右侧和下侧疯狂闪烁" on four
 * real cards and is not a painting bug: it is a **message loop** between the
 * frame's reporter and the shell's applier, and a loop between two message
 * endpoints is computable here without a browser. One step is one round of it:
 *
 * 1. the frame measures `body.scrollHeight` against its viewport and answers
 *    through `heightSignal` — the real decision, imported, not paraphrased;
 * 2. the shell applies the answer exactly as `runner.ts` does — a `height`
 *    becomes an inline `style.height`, a `sizing` removes it, and the CSS
 *    fallback takes the box back;
 * 3. the resize observer the change fires is the next step's measurement.
 *
 * Stepping that loop and recording each write-back **is** the time series the
 * investigation asked for. Against the pre-fix decision it never terminates:
 * measured with content 900px in a 60vh slot it alternatingly wrote
 * 900px / removed / 900px / removed forever — the right and bottom edges of the
 * interface flickering at animation rate. The assertions below pin the
 * post-fix properties: the loop reaches a fixed point in a bounded number of
 * write-backs, the settled height is the content's, and the fixed point is
 * stable under the observer firing again.
 *
 * @module iris-web/tests/height-loop
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { heightSignal, type HeightSignal } from '../src/sandbox/frame-height.ts'

/**
 * One card's frame and one shell, wired the way `frame-entry.ts` and
 * `runner.ts` wire them, stepped one measurement at a time.
 *
 * The frame half mirrors `reportHeight`'s wiring exactly: it tracks what it
 * asked for (`appliedHeight`), hands that to `heightSignal`, and re-arms the
 * `sizing` announcement on every real height — the two lines of state the
 * real reporter keeps. The shell half mirrors the two handlers in `runner.ts`
 * plus the one stylesheet rule in `reading.css`: the slot's starting height,
 * and the taller fallback a `sizing` mark selects.
 */
class Loop {
  /** The card's content height, as `body.scrollHeight` would read it. */
  private content: number | 'pinned'
  /** The slot rule's starting height (`reading.css`, `60vh`). */
  private readonly cssHeight: number
  /** The fallback a `sizing` mark selects (`var(--iris-app-frame-height, 100vh)`). */
  private readonly fallbackHeight: number

  constructor(content: number | 'pinned', cssHeight: number, fallbackHeight: number) {
    this.content = content
    this.cssHeight = cssHeight
    this.fallbackHeight = fallbackHeight
  }

  /**
   * What the card measures right now.
   *
   * `'pinned'` is the unmeasurable card — the warhammer finding: a descendant
   * clips the overflow, so every ruler returns exactly the viewport no matter
   * what is drawn. A number is a genuinely measurable card.
   */
  private measured(): number {
    return this.content === 'pinned' ? this.viewport : this.content
  }

  /** The inline height the shell has applied, or none — `runner.ts`'s two cases. */
  private inline: number | undefined = undefined
  /** Whether the shell is marking the frame `data-iris-sizing='viewport'`. */
  private marking = false
  /** The frame's own half of the state, exactly as `reportHeight` keeps it. */
  private announced = false
  private appliedHeight: number | undefined = undefined

  /** The viewport the frame would measure right now. */
  get viewport(): number {
    if (this.inline !== undefined) return this.inline
    return this.marking ? this.fallbackHeight : this.cssHeight
  }

  /** What the frame's box height is, as a reader would see it. */
  get box(): number {
    return this.viewport
  }

  /** One observer tick: measure, decide, deliver, apply. */
  step(): HeightSignal {
    const signal = heightSignal(this.measured(), this.viewport, this.announced, this.appliedHeight)
    if (signal.kind === 'height') {
      // `runner.ts`, case 'height': inline, and the sizing mark comes off.
      this.inline = signal.pixels
      this.marking = false
      this.announced = false
      this.appliedHeight = signal.pixels
    } else if (signal.kind === 'sizing') {
      // `runner.ts`, case 'sizing': the inline height is removed, the mark set.
      this.inline = undefined
      this.marking = true
      this.announced = true
      this.appliedHeight = undefined
    }
    return signal
  }

  /** The write-back time series until silence or a cap, for the reader. */
  run(cap = 60): { signals: HeightSignal[], boxes: number[] } {
    const signals: HeightSignal[] = []
    const boxes: number[] = []
    for (let at = 0; at < cap; at += 1) {
      // The box *before* the step: the height a reader was shown while this
      // measurement was being answered. Consecutive equal entries are steps
      // that wrote nothing.
      boxes.push(this.box)
      const signal = this.step()
      signals.push(signal)
      if (signal.kind === 'silent') break
    }
    return { signals, boxes }
  }
}

/** Count the write-backs that actually changed the frame's box. */
function writeBacks(boxes: readonly number[]): number {
  let count = 0
  for (let at = 1; at < boxes.length; at += 1) {
    if (boxes[at] !== boxes[at - 1]) count += 1
  }
  return count
}

test('a measurable card settles on its content height in one write-back', () => {
  /*
   * The Lights ON / 尸变纪元 shape, measured: a 900px-tall interface in a 60vh
   * slot with a full-screen sizing fallback. This is the loop that flickered.
   */
  const loop = new Loop(900, 600, 1000)
  const { signals, boxes } = loop.run()

  assert.deepEqual(
    signals.map(signal => signal.kind),
    // One real report, then the echo — which the fixed decision recognises as
    // its own write and refuses to answer. Pre-fix this read
    // height/sizing/height/sizing/… until the cap.
    ['height', 'silent'],
    `the loop did not close: ${JSON.stringify(boxes)}`,
  )
  const applied = signals.find(signal => signal.kind === 'height')
  assert.ok(applied !== undefined && applied.kind === 'height')
  assert.equal(applied.pixels, 900, 'the shell must be told the content height')
  assert.equal(writeBacks(boxes), 1, `the box kept moving: ${JSON.stringify(boxes)}`)
  assert.equal(loop.box, 900, 'the frame did not settle at the content height')
})

test('the write-back time series is bounded no matter which state starts first', () => {
  /*
   * The oscillation needed no unusual numbers — any card whose measurement
   * equals the viewport after the shell applied what we asked for. Stepped from
   * the sizing side first (a card unmeasurable until the fallback gives it a
   * screen), the loop must also close.
   */
  const loop = new Loop('pinned', 600, 1000)
  const { signals, boxes } = loop.run()

  assert.deepEqual(
    signals.map(signal => signal.kind),
    ['sizing', 'silent'],
    `the unmeasurable path looped: ${JSON.stringify(boxes)}`,
  )
  assert.equal(writeBacks(boxes), 1)
  assert.equal(loop.box, 1000, 'an unmeasurable card did not keep the screen it was given')
})

test('a card that shrinks reports the smaller height and settles there', () => {
  const loop = new Loop(400, 600, 1000)
  const { signals, boxes } = loop.run()

  assert.deepEqual(
    signals.map(signal => signal.kind),
    ['height', 'silent'],
    `a short card looped: ${JSON.stringify(boxes)}`,
  )
  assert.equal(loop.box, 400)
})

test('the echo does not spend the single sizing announcement', () => {
  /*
   * The regression the fix had to avoid: the echo must be *silence*, not
   * silence-by-having-announced. A card that fits its applied height, then has
   * the viewport taken away underneath it (a shell resize re-deciding the
   * box), still gets its one unmeasurable announcement afterwards.
   */
  const loop = new Loop(900, 600, 1000)
  loop.run()
  assert.equal(loop.box, 900)

  // The shell re-decides: no inline height, no mark — the bare slot rule. And
  // the card measures pinned to whatever it is given now (the unmeasurable
  // shape). Reaching in is legitimate here: this is the state `runner.ts` never
  // sees, a box change the frame did not cause and cannot predict.
  loop['inline'] = undefined
  loop['marking'] = false
  loop['appliedHeight'] = undefined
  loop['content'] = 600

  const signal = loop.step()
  assert.deepEqual(signal, { kind: 'sizing' }, 'the announcement had been spent on the echo')
})

test('a later screen that clips itself stays at the last real height, and this is said', () => {
  /*
   * The documented trade. A card that *becomes* unmeasurable after having
   * reported a real height measures exactly its applied viewport, which the
   * echo rule cannot distinguish from the card merely fitting — no ruler can;
   * that is the finding recorded on `informsShell`. So the frame keeps the last
   * real height instead of escalating to a full screen. Pinned here as stated
   * behaviour, not left to be rediscovered: the alternative (escalating on
   * every echo) is the flicker loop this file opens with.
   */
  const loop = new Loop(900, 600, 1000)
  loop.run()
  assert.equal(loop.box, 900)

  // The card swaps to a screen that clips its own overflow: the measurement
  // pins to the viewport while the drawn content is taller than it.
  loop['content'] = 'pinned'
  const signal = loop.step()
  assert.equal(signal.kind, 'silent')
  assert.equal(loop.box, 900, 'the frame changed height on an uninformative measurement')
})

test('the three-argument call keeps answering exactly as before', () => {
  /*
   * `applied` is optional, and a caller without a shell to echo off gets the
   * untouched decision — the pre-fix semantics, which the existing
   * `frame-height.test.ts` pins. One direct assertion here too, so this file
   * carries the boundary: omitting the parameter must not half-apply the echo
   * rule.
   */
  assert.deepEqual(heightSignal(900, 900, false), { kind: 'sizing' })
  assert.deepEqual(heightSignal(900, 900, true), { kind: 'silent' })
  assert.deepEqual(heightSignal(900, 600, false), { kind: 'height', pixels: 900 })
})
