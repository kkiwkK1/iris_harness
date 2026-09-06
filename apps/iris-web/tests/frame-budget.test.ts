/**
 * The frame budget's decisions, and the cases where a plausible wrong
 * implementation disagrees with the right one.
 *
 * @module iris-web/tests/frame-budget
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FRAME_BUDGET_BYTES,
  FRAME_COUNT_LIMIT,
  FRAME_OVERHEAD_BYTES,
  frameKey,
  frameWeight,
  planFrames,
  type FrameCandidate,
} from '../src/app/frame-budget.ts'

/** A candidate with a body of `size` ASCII characters. */
function candidate(floor: number, size = 100, instance = 0): FrameCandidate {
  return { floor, instance, body: 'x'.repeat(size) }
}

/** No previous grants and nothing opened — a first plan. */
const fresh = { granted: new Set<string>(), opened: new Set<string>() }

test('every candidate is either rendered or refused, and never both', () => {
  const candidates = Array.from({ length: 30 }, (_unused, at) => candidate(at))
  const plan = planFrames(candidates, fresh)

  /*
   * The completeness check, not a formality. A candidate that falls out of both
   * sets renders nothing and shows no placeholder — the silent disappearance the
   * placeholder exists to prevent — and every other assertion in this file would
   * still pass.
   */
  for (const item of candidates) {
    const key = frameKey(item.floor, item.instance)
    assert.equal(
      plan.render.has(key) !== plan.refused.has(key),
      true,
      `${key} is in neither set or in both`,
    )
  }
  assert.equal(plan.render.size + plan.refused.size, candidates.length)
})

test('the count gate stops at the limit, counting frames rather than floors', () => {
  // Two interfaces on every floor, so a floor count and a frame count differ.
  const candidates = Array.from({ length: 40 }, (_unused, at) =>
    candidate(Math.floor(at / 2), 100, at % 2),
  )
  const plan = planFrames(candidates, fresh)

  assert.equal(plan.render.size, FRAME_COUNT_LIMIT)
  // Well inside the byte budget, so this run is gated by the count alone.
  assert.ok(plan.spent < FRAME_BUDGET_BYTES, `spent ${String(plan.spent)}`)
})

test('spending runs newest floor first, and top to bottom inside a floor', () => {
  const candidates = [
    candidate(0, 100, 0),
    candidate(1, 100, 0),
    candidate(1, 100, 1),
  ]
  // A limit of one would be the clean way to ask this, but the limit is a
  // constant; instead fill the gate with held frames and see which one is left.
  const filler = Array.from({ length: FRAME_COUNT_LIMIT - 2 }, (_unused, at) =>
    candidate(100 + at),
  )
  const plan = planFrames([...candidates, ...filler], fresh)

  assert.equal(plan.render.has(frameKey(1, 0)), true, 'the newest floor renders')
  assert.equal(plan.render.has(frameKey(1, 1)), true, 'its second block renders')
  assert.equal(plan.render.has(frameKey(0, 0)), false, 'the older floor is refused')
})

test('a frame already rendering is not revoked when a newer floor arrives', () => {
  /*
   * The layer's one hard invariant, and the only test in this file that
   * distinguishes it. Loading *backwards* cannot threaten an existing frame —
   * newest-first ordering alone protects that, so a test built on "load more"
   * would pass with the invariant deleted. The chat growing at the **newest**
   * end is where the two implementations part: a fresh plan puts floor 21 first
   * and pushes floor 1 out of the count gate.
   */
  const first = planFrames(
    Array.from({ length: FRAME_COUNT_LIMIT }, (_unused, at) => candidate(at + 1)),
    fresh,
  )
  assert.equal(first.render.size, FRAME_COUNT_LIMIT)

  const grown = [
    ...Array.from({ length: FRAME_COUNT_LIMIT }, (_unused, at) => candidate(at + 1)),
    candidate(FRAME_COUNT_LIMIT + 1),
  ]
  const second = planFrames(grown, { granted: first.render, opened: new Set() })

  for (const key of first.render) {
    assert.equal(second.render.has(key), true, `${key} was revoked`)
  }
  assert.equal(second.render.size, FRAME_COUNT_LIMIT + 1, 'the new floor renders too')
})

test('budget comes back when a floor leaves the window', () => {
  const held = new Set([frameKey(1, 0), frameKey(2, 0)])
  // Floor 1 is no longer offered: the window shrank past it.
  const plan = planFrames([candidate(2), candidate(3)], { granted: held, opened: new Set() })

  assert.equal(plan.render.has(frameKey(1, 0)), false, 'an unmounted floor is not planned')
  assert.equal(plan.spent, frameWeight(candidate(2)) + frameWeight(candidate(3)))
})

test('an interface the reader opened renders past both gates', () => {
  const candidates = Array.from({ length: FRAME_COUNT_LIMIT + 5 }, (_unused, at) =>
    candidate(at),
  )
  const opened = new Set([frameKey(0, 0)])
  const plan = planFrames(candidates, { granted: new Set(), opened })

  /*
   * Floor 0 is the oldest, so it is last in the walk and the count gate would
   * have refused it. The placeholder promises the reader this one interface;
   * a gate that could still refuse it would make that promise false.
   */
  assert.equal(plan.render.has(frameKey(0, 0)), true)
  assert.ok(plan.render.size > FRAME_COUNT_LIMIT, `rendered ${String(plan.render.size)}`)
})

test('opening one interface does not refuse a frame that was already rendering', () => {
  const candidates = Array.from({ length: FRAME_COUNT_LIMIT + 1 }, (_unused, at) =>
    candidate(at),
  )
  const first = planFrames(candidates, fresh)
  const oldest = frameKey(0, 0)
  assert.equal(first.render.has(oldest), false, 'the fixture needs the oldest refused')

  const second = planFrames(candidates, {
    granted: first.render,
    opened: new Set([oldest]),
  })

  for (const key of first.render) {
    assert.equal(second.render.has(key), true, `opening ${oldest} took away ${key}`)
  }
})

test('the byte gate refuses one heavy interface without closing the budget behind it', () => {
  /*
   * A quarter of the budget each, so four fit and the fifth does not — while the
   * count gate is nowhere near. The small floor behind them is the point: an
   * implementation that stops the walk at the first refusal reports "nothing
   * below here fits", which reads to a user as the rest of the chat being broken.
   */
  const heavy = Math.floor(FRAME_BUDGET_BYTES / 4)
  const candidates = [
    candidate(0, 100),
    ...Array.from({ length: 5 }, (_unused, at) => candidate(at + 1, heavy)),
  ]
  const plan = planFrames(candidates, fresh)

  assert.ok(plan.render.size < 5, `rendered ${String(plan.render.size)} heavy frames`)
  assert.ok(plan.render.size < FRAME_COUNT_LIMIT, 'this run must be gated by bytes')
  assert.equal(plan.render.has(frameKey(0, 0)), true, 'the small floor still fits')
  assert.ok(plan.spent <= FRAME_BUDGET_BYTES, `spent ${String(plan.spent)}`)
})

test('the weight is encoded bytes, not code units', () => {
  /*
   * The corpus is Chinese. `body.length` reports UTF-16 code units, so it would
   * charge a third of what the browser inlines — an undercount of 3× on the real
   * data, which is the whole quantity this layer exists to bound.
   */
  const chinese = { floor: 0, instance: 0, body: '界面'.repeat(1000) }
  assert.equal(frameWeight(chinese), 6000 + FRAME_OVERHEAD_BYTES)

  const ascii = { floor: 0, instance: 0, body: 'x'.repeat(2000) }
  assert.equal(frameWeight(ascii), 2000 + FRAME_OVERHEAD_BYTES)
})

test('an empty interface still costs a whole frame', () => {
  // The overhead is the bootstrap and the srcdoc wrapper, which a card with no
  // markup pays in full; a plan that charged only the body would count it free.
  assert.equal(frameWeight({ floor: 0, instance: 0, body: '' }), FRAME_OVERHEAD_BYTES)
})

test('a user row carrying an interface is reported, not silently absorbed', () => {
  const plan = planFrames(
    [{ floor: 3, instance: 0, body: 'x', isUser: true }, candidate(4)],
    fresh,
  )

  /*
   * Zero user rows carried an interface across 189 measured interface floors,
   * and nothing enforces that — so this field is the mechanism that observation
   * never had. It renders normally; the report is about the accounting premise,
   * not about the card. User rows now route through the interface pipeline
   * (upstream renders message HTML wherever the floor sits), so a non-empty
   * report is expected wherever a console wrote markup onto a user floor.
   */
  assert.deepEqual([...plan.userInterfaces], [frameKey(3, 0)])
  assert.equal(plan.render.has(frameKey(3, 0)), true, 'reporting is not refusing')
})

test('a user floor pays the frame budget exactly like an assistant floor', () => {
  /*
   * The two roles are one pipeline and one pool. The role-blindness of the
   * walk itself is what makes the report above accounting rather than gating:
   * identical candidates must plan identically whatever the flag says, or a
   * user floor's region would be a quieter frame — charged or refused by a
   * rule nobody can see.
   */
  const floor = 3
  const body = 'x'.repeat(1000)
  const user = planFrames([{ floor, instance: 0, body, isUser: true }], fresh)
  const assistant = planFrames([candidate(floor, 1000)], fresh)

  assert.deepEqual([...user.render], [...assistant.render])
  assert.equal(user.spent, assistant.spent)
})

test('the count gate sits below the point where overhead eats the whole budget', () => {
  /*
   * The relationship, not the numbers. The gate exists because a pure byte
   * budget degrades to "all scaffolding, no content" at about 53 frames; a
   * change to either constant that put the gate above that point would remove
   * the reason the gate is there, and no other test in this file would notice.
   */
  const degradesAt = FRAME_BUDGET_BYTES / FRAME_OVERHEAD_BYTES

  /*
   * A wide band, and it has moved twice: the design derived ≈53 from a 39 KiB
   * frame, a later pass read ≈49 at 42 KiB, and it is ≈38.6 at 53 KiB. All three
   * are the same statement — the ratio moves whenever the bootstrap does.
   *
   * So this band is only a sanity rail against a constant being changed by an
   * order of magnitude or having its units confused; it is **not** the design,
   * and widening it is not how a breach gets resolved. The assertion that
   * carries the design is the next one, and when that one failed the gate moved
   * rather than the band: `FRAME_COUNT_LIMIT` went 20 → 16 because 53 KiB put
   * half the degradation point under it. Widening this rail to accommodate that
   * would have been repairing the instrument to fit the reading.
   */
  assert.ok(degradesAt > 30 && degradesAt < 60, `derived ${degradesAt.toFixed(1)}`)
  assert.ok(
    FRAME_COUNT_LIMIT < degradesAt / 2,
    `the gate at ${String(FRAME_COUNT_LIMIT)} leaves no room below ${degradesAt.toFixed(1)}`,
  )
})

test('planning twice is the same as planning once, which is what makes the ref write safe', () => {
  /*
   * `FrameBudgetProvider` writes the plan's grants into a ref **during render**,
   * which is normally a mistake: React may invoke a render twice in development,
   * and a render that mutates is a render whose second run sees different input.
   *
   * The comment there claims that is safe because grants are monotone within one
   * window. That claim is the kind this project has been burned by — an
   * invariant asserted in prose and never checked — so it is checked here, on
   * the pure function the provider delegates to.
   */
  const candidates = Array.from({ length: FRAME_COUNT_LIMIT + 6 }, (_unused, at) =>
    candidate(at),
  )
  const opened = new Set([frameKey(1, 0)])

  const once = planFrames(candidates, { granted: new Set(), opened })
  const twice = planFrames(candidates, { granted: once.render, opened })

  assert.deepEqual([...twice.render].sort(), [...once.render].sort())
  assert.deepEqual([...twice.refused].sort(), [...once.refused].sort())
  assert.equal(twice.spent, once.spent)
})
