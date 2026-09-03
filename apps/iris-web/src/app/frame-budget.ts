/**
 * How much frame the reading view may build, and what happens when it runs out.
 *
 * This is layer ③ of the windowing design (`WINDOWING.md` §三). Layer ② limits
 * how many messages are mounted; this limits how much *weight* the mounted ones
 * may turn into live frames, because the two are not the same constraint: the
 * corpus's worst chat for rendered bytes fits entirely inside a 100-floor
 * window, so a count limit gives it no protection at all.
 *
 * It replaces `render-window.ts`, which counted floors back from the end as a
 * stopgap for an unwindowed view. Two windows stacked would not be safer — it
 * would only give "why has this floor no interface?" two answers.
 *
 * Every figure here is a named constant citing `WINDOWING.md`, and rounded on
 * purpose: the measurements behind them drift with each build, and writing the
 * exact bytes into the code makes the code stale before it is wrong.
 *
 * @module iris-web/app/frame-budget
 */

import { encodedBytes } from '../sandbox/message-frames.ts'

/**
 * Bytes a frame costs before its card writes anything.
 *
 * [WINDOWING.md §三「每个 frame 的固定开销」] The bootstrap, the context
 * snapshot and the srcdoc wrapper are **inlined**, so they are paid per frame
 * with no cache. The preset and message-preset are not on this bill — they load
 * by content-hashed URL and are paid once for the page.
 *
 * Rounded **up** to the next whole KiB above the measured artifact, so a small
 * build-to-build drift does not make the figure wrong — only stale.
 *
 * It keeps moving, and that is now normal rather than alarming: 38.5 → 39.4 KiB
 * across two slimming passes, 41.8 when the script-button members joined the
 * frame's import chain, then a few hundred bytes each for the height reporter's
 * second observer, the height-source diagnostic, and the overlay report — and
 * about a kilobyte for the `loadWorldInfo` / `getLorebookSettings` facades, the
 * per-member argument translation that replaced a single shared fallthrough,
 * and the stack-frame reader; then another 1.8 KiB for floor-addressed variable
 * reads and the Tavern Helper surface an interface frame now gets, and 1.2 KiB
 * more for the prompt-injection façade, and 4.2 KiB for the `localStorage` a
 * frame on an opaque origin has to be given instead of having, then 0.7 KiB for
 * the lazy restore of floor tables the text transport made necessary, then the
 * read-only document state and the gap-note retraction, and 5 KiB for the three
 * SillyTavern anchor stand-ins, then 1.7 KiB for the overlay-region reporter.
 *
 * **That last jump is the one worth arguing about rather than absorbing.** Five
 * kilobytes of stand-in is paid *per live frame*, and the thing it buys is
 * needed by whichever frame the card's interface is in — not by all of them. The
 * bootstrap is inlined per frame because policy must not be substitutable; but
 * the preset is already served from this origin by content-hashed URL under the
 * same `script-src`, so "inline or fetch" is a question with a real answer
 * rather than a settled one. Raised with the coordinator rather than decided
 * here.
 *
 * **No current figure is written here on purpose.** Two earlier versions of this
 * comment carried "as this line is written" numbers and both were stale within
 * the day — a comment cannot track a number the build recomputes. `build:sandbox`
 * prints the live measurement beside this constant on every run, so the place to
 * read today's value is the build output, not this paragraph.
 *
 * **Only the first two were found by hand.** `tools/check-bootstrap.mjs`
 * compares this constant against the artifact on every sandbox build. It caught
 * the third retroactively — the documented figure had been 39 KiB against a real
 * 41.8, charging every frame about 2.9 KB less than it cost — and every move
 * since **in the same change that caused it**. The figure used to drift until
 * someone thought to re-measure; now it cannot.
 */
export const FRAME_OVERHEAD_BYTES = 65 * 1024

/**
 * The whole reading view's frame budget.
 *
 * [RENDER.md, restated in WINDOWING.md §三] 2 MiB. The reason it exists
 * alongside the floor count is that it has an upper bound in bytes and the
 * count does not: on this corpus the two happen to coincide (a 100-floor window
 * is about 2.1 MiB), but that is a property of this data, not of the structure.
 */
export const FRAME_BUDGET_BYTES = 2 * 1024 * 1024

/**
 * The most frames that may be live at once, whatever they weigh.
 *
 * [WINDOWING.md §三「数量闸是必需的」] Structurally necessary, not a
 * precaution: at `FRAME_BUDGET_BYTES / FRAME_OVERHEAD_BYTES` ≈ 31 frames the
 * fixed overhead eats the entire budget on its own and not one byte of card
 * content fits. A pure byte budget therefore degrades into "all scaffolding, no
 * content" exactly when there are most frames.
 *
 * 12 leaves about 1.25 MiB for content (overhead ≈ 768 KiB, 38%), and 12 live
 * panels on one screen is already past any reading scenario. It is a trade-off
 * point rather than a threshold — moving it means revisiting the two measured
 * values above, not just this line.
 *
 * **It was 20, then 16, and the test beside this moved it both times.** The
 * design's own invariant is that the gate stays *well* below the degradation
 * point, written down as `FRAME_COUNT_LIMIT < degradesAt / 2`. Each bootstrap
 * increment lowers `degradesAt`:
 *
 * | frame | degradesAt | half | gate | invariant |
 * | --- | --- | --- | --- | --- |
 * | 39 KiB | 53.9 | 26.9 | 20 | held |
 * | 53 KiB | 38.6 | 19.3 | 20 | **false** → gate 16 |
 * | 57 KiB | 35.9 | 18.0 | 16 | held |
 * | 64 KiB | 32.0 | 16.0 | 16 | **false** → gate 12 |
 * | 65 KiB | 31.5 | 15.8 | 12 | held |
 *
 * Both times the reasonable-looking response was to raise the constant above and
 * treat the ratio as incidental; both times the invariant said otherwise, and
 * both times the alternative — widening the test's own sanity band — would have
 * been repairing the instrument to fit the reading.
 *
 * 12 rather than 15, which is the largest value satisfying it today: the 16
 * chosen at 53 KiB was meant to hold "to about 64 KiB" and it did, exactly, for
 * two changes. Picking the boundary again would buy one more change. 12 holds to
 * about 87 KiB.
 *
 * **The pattern is now the finding.** Two gate moves in one day is not the frame
 * budget being tuned; it is the per-frame bootstrap growing faster than the
 * budget can absorb, and the honest next step is to ask whether all of it has to
 * be inlined per frame — see the note on `FRAME_OVERHEAD_BYTES` above.
 *
 * **This is a behaviour change and it is small in the only place it shows.**
 * Frames past the sixteenth on one screen now get a named placeholder instead
 * of a live panel, and the placeholder is openable. `WINDOWING.md` measured 189
 * rendered interface floors across the corpus with no chat putting sixteen on
 * one screen, so no measured reading scenario reaches the gate at all.
 *
 * The design named ≈53 and 38%, computed against a 39 KiB overhead; a later
 * pass read ≈43 and 47% at 48 KiB. Those are the same statement about a smaller
 * frame, and the drift is the reason the test beside this asserts the
 * **relationship** — that the gate sits well below the degradation point —
 * rather than any of the three numbers. Every figure in this paragraph is stale
 * the moment the bootstrap moves; the guard in `build:sandbox` is what is not.
 */
export const FRAME_COUNT_LIMIT = 12

/** One interface block that could become a frame. */
export interface FrameCandidate {
  /** The floor's index in the conversation. */
  floor: number
  /** Which interface block within that floor, in prose order. */
  instance: number
  /** What the frame will run — the block body, not the whole message. */
  body: string
  /**
   * Whether this floor is a user row.
   *
   * Carried only so the plan can report one. [WINDOWING.md §三「预算只数 AI 楼」]
   * measured 0 user rows among 189 rendered interface floors and noted that
   * nothing enforced it — `applyRegexScripts` treats `USER_INPUT` and
   * `AI_OUTPUT` alike.
   *
   * In this view something does: `Message.tsx` routes only `role ===
   * 'assistant'` through `MessageInterfaces`, so a user row has no path to a
   * frame at all. That makes this field a second line rather than the only one —
   * it fires if that routing ever changes, which is the change that would
   * quietly invalidate the measurement above.
   */
  isUser?: boolean
}

/** What the previous plan handed out, and what the reader has asked for. */
export interface FrameGrants {
  /** Keys already rendering, which growth may not revoke. */
  granted: ReadonlySet<string>
  /** Keys the reader opted into in place, which no gate refuses. */
  opened: ReadonlySet<string>
}

/** The decision for one window. */
export interface FramePlan {
  /** Keys that may build a frame. */
  render: ReadonlySet<string>
  /** Keys that must show a named placeholder instead. */
  refused: ReadonlySet<string>
  /** Bytes charged, including the fixed overhead per rendered frame. */
  spent: number
  /**
   * User rows that carried an interface, if any.
   *
   * Empty on all measured data. Non-empty means the premise under "user rows
   * are free" has died, and the reader of this field is the mechanism that was
   * missing.
   */
  userInterfaces: readonly string[]
}

/**
 * The stable identity of one candidate frame.
 *
 * A floor can carry several interfaces, so the floor index alone does not name
 * a frame — and the count gate counts frames, not floors.
 * @param floor - the floor index.
 * @param instance - the block's position within the floor.
 * @returns the key used throughout the plan.
 */
export function frameKey(floor: number, instance: number): string {
  return `${String(floor)}:${String(instance)}`
}

/**
 * Which instances of one floor a plan refused.
 *
 * Here rather than at the call sites because the key's format was being written
 * in one place and taken apart by hand in three others — a component, and two
 * helpers inside the tests that were supposed to be checking it. A test that
 * re-derives the format it is verifying agrees with a broken implementation as
 * readily as with a working one.
 * @param floor - the floor index.
 * @param keys - a plan's `refused` (or `render`) set.
 * @returns the instances belonging to that floor, ascending.
 */
export function instancesOf(floor: number, keys: ReadonlySet<string>): number[] {
  const mine: number[] = []
  for (const key of keys) {
    const [at, instance] = key.split(':')
    if (at === String(floor) && instance !== undefined) mine.push(Number(instance))
  }
  return mine.sort((left, right) => left - right)
}

/**
 * The floor a key belongs to.
 * @param key - a key from a plan's sets.
 * @returns the floor index, or undefined for a string that is not a key.
 */
export function floorOf(key: string): number | undefined {
  const [at] = key.split(':')
  if (at === undefined || at === '') return undefined
  const floor = Number(at)
  return Number.isInteger(floor) ? floor : undefined
}

/**
 * What one candidate costs, in the bytes that actually get inlined.
 *
 * The measure comes from `message-frames.ts` rather than being repeated here,
 * because the same number is printed under an interface as its construction
 * cost. Two measures would let the panel explain a decision it does not
 * describe — and both were `String.length` until this layer was built, which on
 * a Chinese corpus is about a third of the bytes actually paid.
 * @param candidate - the block.
 * @returns the encoded body plus the fixed per-frame overhead.
 */
export function frameWeight(candidate: FrameCandidate): number {
  return encodedBytes(candidate.body) + FRAME_OVERHEAD_BYTES
}

/**
 * Decide which candidates may build frames.
 *
 * Spends from the newest floor backwards, because that is the screen the reader
 * is on. Three claims on the budget are settled in order, and the order is the
 * design:
 *
 * 1. **What the reader opted into** renders unconditionally. The budget is a
 *    default, not a ceiling — the placeholder's third promise is "you can have
 *    this one", and a gate that could refuse it would make that a lie.
 * 2. **What is already rendering** keeps rendering. [WINDOWING.md §三] This is
 *    the one hard invariant of the layer: loading older messages must never take
 *    a panel away from the floor the reader is looking at. Budget comes back
 *    only when the window *shrinks* and a candidate stops being offered.
 * 3. **Everything else**, newest first, until the bytes or the count run out.
 *
 * @param candidates - every interface block in the mounted window, in
 * conversation order.
 * @param grants - what the previous plan granted, and what the reader opened.
 * @returns the plan for this window.
 */
export function planFrames(
  candidates: readonly FrameCandidate[],
  grants: FrameGrants,
): FramePlan {
  const render = new Set<string>()
  const refused = new Set<string>()
  const userInterfaces: string[] = []
  let spent = 0

  /*
   * Newest first. Sorted by floor descending, and by instance *ascending*
   * within a floor: the blocks of one message are read top to bottom, so when
   * only part of a floor fits, the part the reader reaches first is the part
   * that renders.
   */
  const order = [...candidates].sort((left, right) =>
    left.floor === right.floor ? left.instance - right.instance : right.floor - left.floor,
  )

  for (const candidate of order) {
    const key = frameKey(candidate.floor, candidate.instance)
    if (candidate.isUser === true) userInterfaces.push(key)

    const opened = grants.opened.has(key)
    const held = grants.granted.has(key)

    /*
     * Held frames are charged but never gated. Charging them is what makes the
     * invariant mean something: they hold their allocation against the older
     * floors arriving behind them, rather than being re-decided from zero and
     * possibly losing.
     */
    if (opened || held) {
      render.add(key)
      spent += frameWeight(candidate)
      continue
    }

    if (render.size >= FRAME_COUNT_LIMIT) {
      refused.add(key)
      continue
    }

    const weight = frameWeight(candidate)
    /*
     * Refusing one candidate does not stop the walk. A large interface early in
     * the walk would otherwise close the budget for every smaller one behind
     * it, which reads as "everything below here is broken" rather than "this one
     * did not fit".
     */
    if (spent + weight > FRAME_BUDGET_BYTES) {
      refused.add(key)
      continue
    }

    render.add(key)
    spent += weight
  }

  return { render, refused, spent, userInterfaces }
}
