/**
 * How much frame the reading view may build, and what happens when it runs out.
 *
 * This is layer ③ of the windowing design (`notes/apps/iris-web/WINDOWING.md` §三). Layer ② limits
 * how many messages are mounted; this limits how much *weight* the mounted ones
 * may turn into live frames, because the two are not the same constraint: the
 * corpus's worst chat for rendered bytes fits entirely inside a 100-floor
 * window, so a count limit gives it no protection at all.
 *
 * It replaces `render-window.ts`, which counted floors back from the end as a
 * stopgap for an unwindowed view. Two windows stacked would not be safer — it
 * would only give "why has this floor no interface?" two answers.
 *
 * Every figure here is a named constant citing `notes/apps/iris-web/WINDOWING.md`, and rounded on
 * purpose: the measurements behind them drift with each build, and writing the
 * exact bytes into the code makes the code stale before it is wrong.
 *
 * @module iris-web/app/frame-budget
 */

import { encodedBytes } from '../sandbox/message-frames.ts'

/**
 * Bytes a frame costs before its card writes anything.
 *
 * [notes/apps/iris-web/WINDOWING.md §三「每个 frame 的固定开销」] **What this
 * measures, as of 2026-09-10: the `srcdoc` string a frame is built from, with
 * its card's body taken out.** Concretely — the doctype, the CSP meta, the token
 * and origin metas, the FontAwesome sentinel link, the reset stylesheet, the
 * body tag, three `<script>` tags (member table, bootstrap, one library) and the
 * inline bootstrap guard. Everything the frame *fetches* is off this bill,
 * because it is loaded by content-hashed URL under a `script-src` this policy
 * already admits: the preset, the message-preset, the member table — and, since
 * 2026-09-10, the bootstrap itself.
 *
 * **The bootstrap used to be on this bill and that is the whole history below.**
 * It was inlined into every `srcdoc`, so every kilobyte it grew was a kilobyte
 * charged twenty times, and the count gate was pushed down four times to pay for
 * it (39 → 52 → 53 → 54 KiB, gate 20 → 19 → 18). It is now a blocking classic
 * `<script src>` and the srcdoc wrapper is what is left: measured **3,006 bytes**
 * for the widest of eight shapes (interface frame, network ungranted, a
 * 51-character deployment origin; this machine's dev origin reads 2,766),
 * against 55,900-odd before. The shell's origin appears seven times in a frame
 * document, so the long origin is the one the budget is compared against and
 * both are printed. `notes/apps/iris-web/DEVIATIONS.md` §91 records the move.
 *
 * **The context snapshot is deliberately *not* covered, and never was.** A
 * message frame's snapshot is inlined and is card data — the worst single floor
 * measured is 283 KiB, five times this whole constant — so no fixed figure could
 * ever have included it. The earlier version of this sentence listed it here,
 * which read as an accounting claim the build's own check has never made: that
 * check compares the artifact and the wrapper, not the payload. Said plainly
 * now rather than left as a number that quietly excludes its largest term.
 *
 * Rounded **up** to the next whole KiB above the measurement, so a small
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
 * SillyTavern anchor stand-ins, then 1.7 KiB for the overlay-region reporter —
 * at which point it was 65 KiB and had forced the count gate down twice in one
 * day — and about a kilobyte for the same-origin fetch bridge the MVU bundles
 * needed.
 *
 * **Then it fell to 41 KiB, and the fall is the interesting number.** The
 * card-facing member table — the Tavern Helper surface, the storage façade, the
 * anchors, the overlay geometry — moved out of the inlined bootstrap into a
 * script fetched once per page by content-hashed URL. Measured, not projected:
 * the core builds to 40,058 bytes and the table to 27,601, against 65,512 for
 * the old single bundle. (The 2.2 KiB the two now duplicate is shared helpers
 * pulled into both, and is the honest price of the seam.)
 *
 * **What actually changed is the growth rate.** Every member added before this
 * was paid twelve to twenty times; a member added now does not touch this
 * constant at all. The line here is policy — the proxies, the refusals, the
 * evaluator, the install order — and policy is a bounded list of what a card may
 * not do, where the surface is an unbounded list of what it may.
 *
 * **That last jump is the one worth arguing about rather than absorbing.** Five
 * kilobytes of stand-in is paid *per live frame*, and the thing it buys is
 * needed by whichever frame the card's interface is in — not by all of them. The
 * bootstrap is inlined per frame because policy must not be substitutable; but
 * the preset is already served from this origin by content-hashed URL under the
 * same `script-src`, so "inline or fetch" is a question with a real answer
 * rather than a settled one. **Answered 2026-09-10, in favour of fetching**
 * (§91): the question was put to the coordinator here and stood open for two
 * gate moves before it was taken up. Raised with the coordinator rather than decided
 * here.
 *
 * **Two independent lines of work raised it, and neither branch's number
 * describes this tree.** The height reporter's 500ms timer rescue — real code
 * in the per-frame bootstrap, for the frame whose queued
 * `requestAnimationFrame` never fires — took the artifact from 48 to 49 KiB on
 * the branch that added it, with `check-bootstrap.mjs` catching the overrun in
 * the change that caused it; the mainline's own pass read 48.6 KiB and raised
 * this constant to 50 KiB. Merged, the two land inside the single higher
 * ceiling, and the *only* reading that counts is the build's: `build:sandbox`
 * measures the combined artifact against this constant on every run and prints
 * both figures. Two stale numbers agreeing is not a measurement of the tree
 * that has both changes in it.
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
 *
 * **51 KiB, and it is the largest value the gate survives.** The popup API
 * (`sandbox/popup-api.ts`) tripped the build's comparison. Its first shape put
 * the whole runtime in the bootstrap — 7.1 KiB, a seventh of the artifact, for
 * a dialog most frames never raise — and covering that needs 57 KiB, at which
 * `FRAME_BUDGET_BYTES / this` falls to ≈36 and the invariant below forces
 * `FRAME_COUNT_LIMIT` down to 17. So the API went into the **fetched member
 * table** instead, the way the member-table split answered this the last time,
 * and the bootstrap grew by 0.9 KiB rather than 7.1 (measured with one bundler
 * over both trees, so the delta describes the change and not the toolchain).
 *
 * One KiB is then the whole move, and 51 is deliberate rather than rounded up
 * from the reading: 52 KiB puts half the degradation point under a gate of 20
 * and would cost a live panel. **The headroom is about a kilobyte** — it was
 * about 0.8 before this change, so the tightness is not new — and the next
 * thing that grows the bootstrap has the same choice to make: put it in the
 * member table, or move the gate and say so.
 *
 * **52 KiB, and the predicted gate move came with it.** The stylesheet-proxy
 * policy (`srcdoc.ts`'s `rewriteStylesheetLinks` / `rewritingTemplate`, the
 * 人贩子物语 style-src-elem fix) is bootstrap policy — a template parse is the
 * last place a card's stylesheet URL choice is still unspent — so it could not
 * go into the member table without becoming substitutable, the one property the
 * inline/fetch seam exists to protect. Measured 52448 bytes against 51 KiB,
 * 224 over; not squeezable to the line without gambling on minifier weather.
 * So the constant moves as the table below always said it would, and the count
 * gate moves with it.
 *
 * **53 KiB, and this time the gate does not move.** `parent.postMessage` became
 * a bridged member (`frame.ts`, `sandbox/parent-messages.ts`): a card's upward
 * post used to throw, and the throw took the rest of a real card's interface
 * with it. The *policy* half is unavoidably inline — which name is bridged,
 * that it is read-only, and where its argument goes — while everything that
 * decides what the message *means* went into the fetched member table, the same
 * answer the popup API gave. That kept the increment to 311 bytes (52177 →
 * 52488), which is 264 past the 47 bytes of headroom 52 KiB had left. The
 * invariant holds at 53 KiB with `FRAME_COUNT_LIMIT` where it is — 19 against a
 * half-degradation point of 19.3 — which is what the 52 KiB paragraph meant by
 * "19 holds to about 55 KiB", and the row is in the table below.
 *
 * **54 KiB, and this time the gate moves to 18.** Two card-surface changes
 * landed on the same day: the four dialog names and the live `chat` array
 * (`frame.ts`, 52488 → 52947) and the `getContext()` absence report with its
 * three `has` repairs (→ 52825 on its own). Each kept its data in the fetched
 * member table and each fit under 53 KiB alone; together the bootstrap is
 * 53285 bytes, 37 past the line once the wrapper is counted. The 1.8 KiB the
 * 53 KiB paragraph said was left was spent by two branches that each measured
 * against the other's absence — which is the seam this constant exists to
 * catch. At 54 KiB the half-degradation point is 18.96, so 19 no longer sits
 * below it and the gate goes to 18; the row is in the table below.
 *
 * **4 KiB, and the eleven paragraphs above stop being a series.** Every one of
 * them is the same event — the per-frame bootstrap grew, the build's comparison
 * caught it, and the reading window paid. The answer each time was to move
 * something into the fetched member table, which worked and did not address why
 * the bootstrap was inlined at all. It was inlined because a card's markup reads
 * bridged names at **parse** time, so the bootstrap has to finish before the
 * body does — true, and satisfied by a blocking classic `<script src>`, which is
 * the mechanism the member table has run on since it was split out and the
 * mechanism the card libraries have always run on. That premise is now checked
 * three ways rather than assumed (build, frame, browser: §91).
 *
 * So this constant changes **dimension**, not value, and the distinction is the
 * one thing worth being careful about here. It has always meant "bytes of
 * `srcdoc` charged per frame"; what left the srcdoc is 53 KB of build artifact,
 * so the same measure of the same quantity now reads 3.0 KB. Nothing was
 * loosened, no threshold was widened, and the byte budget did not grow: the
 * denominator shrank because the numerator's largest term moved to a URL. The
 * frame still downloads those bytes — whether it downloads them *again* per
 * frame is a cache-partitioning question measured in §91 — and this bill has
 * excluded fetched artifacts since the member table split, so the bootstrap
 * joining them changes no rule.
 *
 * **What this means for the next person who grows the bootstrap: it costs
 * nothing here.** The pressure that moved the gate four times is gone, and the
 * pressure that replaces it is the one the preset already lives under — page
 * weight and a cold fetch, reported per frame by `describeTransferCost`. A
 * member added to the table and a policy line added to the bootstrap now cost
 * the same, which is the first time that has been true.
 *
 * What *is* still on this bill: the CSP (the longest single term in the
 * wrapper), the reset, the three tags, and the guard. A new `<meta>`, a widened
 * allowlist or a longer guard moves this figure; the build's comparison still
 * catches it in the change that caused it, and 4 KiB leaves 1,090 bytes over the
 * widest measured shape.
 *
 * **4 rather than 3, and the reason is the origin.** 3 KiB covers the widest
 * shape by 66 bytes, which is the headroom this file has watched two branches
 * spend simultaneously (§86). It is also headroom against a figure that moves
 * with the **deployment**, not only with the code: seven occurrences of the
 * shell origin means a longer hostname costs about 200 bytes that no commit
 * would show. 4 KiB is 1 KiB of slack for 80 KiB of a 2 MiB budget — and, since
 * the gate is no longer derived from this number, an overrun here is now a
 * one-line bump with no live panel attached to it, which is the first time that
 * has been true.
 */
export const FRAME_OVERHEAD_BYTES = 4 * 1024

/**
 * The whole reading view's frame budget.
 *
 * [notes/apps/iris-web/RENDER.md, restated in notes/apps/iris-web/WINDOWING.md §三] 2 MiB. The reason it exists
 * alongside the floor count is that it has an upper bound in bytes and the
 * count does not: on this corpus the two happen to coincide (a 100-floor window
 * is about 2.1 MiB), but that is a property of this data, not of the structure.
 */
export const FRAME_BUDGET_BYTES = 2 * 1024 * 1024

/**
 * The most frames that may be live at once, whatever they weigh.
 *
 * [notes/apps/iris-web/WINDOWING.md §三「数量闸是必需的」] Structurally necessary, not a
 * precaution: at `FRAME_BUDGET_BYTES / FRAME_OVERHEAD_BYTES` frames — a figure
 * read from the table below rather than written here — the fixed overhead eats
 * the entire budget on its own and not one byte of card content fits. A pure
 * byte budget therefore degrades into "all scaffolding, no content" exactly
 * when there are most frames.
 *
 * **The overhead's share is now small, which changes why the gate exists rather
 * than whether it does.** 20 frames of wrapper is 80 KiB of the 2 MiB budget,
 * about 4% — where at a 54 KiB inlined bootstrap the same 20 frames were 1,060
 * KiB, 51%, and the sentence here read "20 leaves about 1 MiB for content". So
 * the byte budget is close to measuring only card content, which is what its own
 * citation was always about (`notes/apps/iris-web/RENDER.md` measured *rendered*
 * bytes, three orders of magnitude apart between chats). The gate is not
 * redundant: a live frame costs a realm, two observers, a message channel and a
 * layout, and none of that is bytes of markup. It is a trade-off point rather
 * than a threshold — moving it means revisiting the two measured values above,
 * not just this line.
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
 * | 41 KiB | 50.0 | 25.0 | **20** | held, with room |
 * | 42 KiB | 48.8 | 24.4 | 20 | held |
 * | 43 KiB | 47.6 | 23.8 | 20 | held |
 * | 44 KiB | 46.5 | 23.3 | 20 | held |
 * | 45 KiB | 45.5 | 22.8 | 20 | held |
 * | 46 KiB | 44.5 | 22.3 | 20 | held |
 * | 47 KiB | 43.6 | 21.8 | 20 | held |
 * | 48 KiB | 42.7 | 21.3 | 20 | held |
 * | 49 KiB | 41.8 | 20.9 | 20 | held |
 * | 50 KiB | 41.0 | 20.5 | 20 | held, half a frame from the line; 52 KiB would move the gate |
 * | 52 KiB | 39.4 | 19.7 | 20 | **false** → gate 19, the move 50 said 52 would cost |
 * | 53 KiB | 38.6 | 19.3 | 19 | held — the first increment since 41 KiB that cost no frame |
 * | 54 KiB | 37.9 | 19.0 | 19 | **false** → gate 18, two same-day branches spent the 1.8 KiB together |
 * | 4 KiB | 512.0 | 256.0 | **20** | held, and the column no longer describes a bootstrap |
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
 * **The pattern was the finding, and it has been acted on.** Two gate moves in
 * one day was not the frame budget being tuned; it was the per-frame bootstrap
 * growing faster than the budget could absorb. Splitting the member table out
 * answered it, and the gate is back at 20 — where the design put it, and this
 * time chosen by "how many live panels is still reading" rather than by bytes.
 *
 * The invariant is what carried this from a nuisance to a decision: it failed
 * twice, was not widened either time, and the second failure is what made the
 * structural question unavoidable.
 *
 * **This is a behaviour change and it is small in the only place it shows.**
 * Frames past the gate on one screen get a named placeholder instead of a live
 * panel, and the placeholder is openable. (Written when the gate was 16; the
 * number has been 12, 19, 18 and 20 since, and the sentence is about the
 * mechanism rather than the value.) `notes/apps/iris-web/WINDOWING.md` measured
 * 189 rendered interface floors across the corpus with no chat putting sixteen
 * on one screen, so no measured reading scenario reaches the gate at all.
 *
 * The design named ≈53 and 38%, computed against a 39 KiB overhead; a later
 * pass read ≈43 and 47% at 48 KiB. Those are the same statement about a smaller
 * frame, and the drift is the reason the test beside this asserts the
 * **relationship** — that the gate sits well below the degradation point —
 * rather than any of the three numbers. Every figure in this paragraph is stale
 * the moment the bootstrap moves; the guard in `build:sandbox` is what is not.
 *
 * **19, at 52 KiB, by the same table.** The stylesheet-proxy bootstrap crossed
 * the line 50 KiB warned about, and 19 is the largest value the invariant
 * holds — it holds to about 55 KiB, so the next bootstrap increment that trips
 * `build:sandbox` has real room to answer with a slimming pass instead of
 * another frame.
 *
 * **That room was spent once and the gate stayed at 19.** The bridged
 * `parent.postMessage` took the bootstrap to 53 KiB (the constant above says
 * why, and how much of the change went into the member table instead), and 19
 * against a half-degradation point of 19.3 is the first increment since 41 KiB
 * that cost no frame. About 2 KiB of the room is left.
 *
 * **18, at 54 KiB, by the same table.** The room was spent by two branches at
 * once (the constant above says how), and 19 against a half-degradation point
 * of 18.96 fails the invariant by four hundredths of a frame. 18 is the largest
 * value that holds, and it holds to about 58 KiB. The alternative — trimming
 * 37 bytes out of a minified bootstrap to keep 19 — would have been repairing
 * the reading to fit the instrument, the move the table above refused twice.
 *
 * **20, and back to being decided by reading rather than by bytes.** The
 * bootstrap left the `srcdoc` (2026-09-10, §91), so the fixed overhead is a 3.0
 * KiB wrapper budgeted at 4 KiB, and the degradation point is **512 frames**.
 * The invariant holds by a factor of thirteen, which means it has stopped being
 * the thing
 * that decides this number — and that is the point of the move rather than a
 * side effect of it. 20 is the design's own figure, chosen because twenty live
 * panels on one screen is already past any reading scenario, and it is now
 * chosen on that ground alone. The corpus agrees from the other direction:
 * `notes/apps/iris-web/WINDOWING.md` measured 189 rendered interface floors
 * across every chat with none putting sixteen on one screen, so no measured
 * reading reaches the gate at all.
 *
 * **What no longer protects anything, said out loud.** For eleven increments the
 * count gate was doubling as a brake on the inlined bootstrap: it was the number
 * that moved when the bootstrap grew. It cannot serve that purpose any more, and
 * nothing should try to make it — the bootstrap's weight is a fetch cost now,
 * reported per frame by `describeTransferCost` and argued about there. The gate
 * protects what it was designed to protect: how many live realms, live observers
 * and live message channels one screen may hold, which is a cost in memory and
 * main-thread work that no byte budget measures.
 *
 * The test beside this asserts the **relationship** and, since the dimension
 * changed, a units rail on the overhead itself: a wrapper is kilobytes, and a
 * reading in the tens of kilobytes means the bootstrap is back inside the
 * document. That is the one regression this constant can no longer feel.
 */
export const FRAME_COUNT_LIMIT = 20

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
   * Carried so the plan can report one. [notes/apps/iris-web/WINDOWING.md §三「预算只数 AI 楼」]
   * measured 0 user rows among 189 rendered interface floors and noted that
   * nothing enforced it — `applyRegexScripts` treats `USER_INPUT` and
   * `AI_OUTPUT` alike.
   *
   * That measurement is now history rather than premise: user rows route
   * through `MessageInterfaces` like assistant rows (upstream renders message
   * HTML wherever the floor sits, and a console can write a floor of markup
   * onto a user row), so a user row's blocks are candidates on the same terms —
   * the same byte charge, the same count gate, no second quieter accounting.
   * The flag feeds the plan's report, which is how the accounting stays
   * observable now that "user rows carry nothing" can no longer be assumed.
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
   * Empty on all measured data — a fact this field turned into an account.
   * User floors now claim and render interfaces like assistant floors and pay
   * for them from the same pool, so a non-empty list is no longer a dead
   * premise firing: it is the record of which on-screen frames a user floor is
   * responsible for, and of how far the corpus has drifted from the
   * measurement that named this field.
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
 * 2. **What is already rendering** keeps rendering. [notes/apps/iris-web/WINDOWING.md §三] This is
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
