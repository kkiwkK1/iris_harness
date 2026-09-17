/**
 * What the frame says about its libraries, and which of two worlds to look in.
 *
 * A frame can observe that globals are absent. It cannot observe *why*, and the
 * two causes send a reader in opposite directions:
 *
 * - **The preset never ran.** One request to go and inspect — blocked, 404,
 *   parse error, a throw partway through. Every missing name is a consequence,
 *   and chasing them individually is wasted work.
 * - **The preset ran and does not carry these.** Real gaps, one decision each:
 *   bundle it, stub it, or leave it reported.
 *
 * Listing missing names alone cannot separate them, and the confusion is not
 * hypothetical. A `crossorigin` attribute made the browser block the preset, and
 * the frame reported nine missing libraries — a line that reads as nine
 * independent gaps and was one blocked request. Four of those nine had been
 * present for a dozen runs, which is the tell nobody had a way to see.
 *
 * So the preset sets a marker as its last statement and this decides between the
 * two, rather than leaving a reader to infer it from the length of a list.
 *
 * **When** the marker is read is as load-bearing as the marker itself, which is
 * the other half of this module (`reportLibraryState`). The sentence is written
 * in the present tense about a standing state, so it has to be composed at a
 * moment that state has actually reached.
 *
 * @module iris-web/sandbox/library-state
 */

/**
 * The frame's line about its libraries, or nothing when all is well.
 *
 * @param presetRan - whether the preset's end-of-file marker is present.
 * @param missing - expected globals the frame does not have.
 * @param presetUrl - where the preset was loaded from, so a blocked script names
 *   the thing to go and check.
 * @param presetError - what the preset recorded about its own throw, when it got
 *   far enough to record anything.
 * @returns the sentence to report, or undefined when there is nothing to say.
 */
export function describeLibraryState(
  presetRan: boolean,
  missing: readonly string[],
  presetUrl: string,
  presetError?: string,
): string | undefined {
  if (!presetRan) {
    /*
     * Two different failures wear the same missing marker, and they are as far
     * apart as failures get:
     *
     * - **The bundle ran and threw.** Its own wrapper caught the exception and
     *   wrote it down, so the name is available and it is the whole answer.
     * - **The bundle never executed.** Blocked, 404, a parse error — nothing of
     *   it ran, including the wrapper, so there is nothing to quote and the
     *   request itself is what to go and look at.
     *
     * Reported whether or not names are missing, because a preset that did not
     * finish is a finding on its own: something else may have supplied the
     * globals, and the frame is then working by accident in a way that will stop
     * without warning.
     */
    if (presetError !== undefined && presetError !== '') {
      return (
        `the library preset threw while loading (${presetUrl}): ${presetError}` +
        ' — every library below is a consequence of that one throw, not a separate gap' +
        `${missing.length === 0 ? '' : `: ${missing.join(', ')}`}`
      )
    }
    return (
      `the library preset never executed (${presetUrl}) — it did not run far enough to record` +
      ' a reason, so the request itself is what to check: blocked, missing, or unparseable.' +
      ' Every library below is a consequence of that one failure, not a separate gap' +
      `${missing.length === 0 ? '' : `: ${missing.join(', ')}`}`
    )
  }

  if (missing.length === 0) return undefined

  return (
    `libraries a card may expect are not present in this frame: ${missing.join(', ')}` +
    ' — the preset ran, so these are libraries Iris does not carry rather than a failed load'
  )
}

/**
 * How long a frame whose document is still parsing waits for the preset tag
 * before it reports that the preset never ran.
 *
 * The bound is a backstop, not the normal path. A preset that is **blocked, 404
 * or unparseable** does not stall the parser at all: the browser fires the tag's
 * `error` event and parsing continues, so the settle point below arrives within
 * milliseconds and the report is prompt. The only shape this timer covers is a
 * request that neither completes nor fails — a document that never finishes
 * parsing and therefore never reaches the settle point — where withholding the
 * diagnosis forever would be the worse failure.
 *
 * Same magnitude as `IMPORT_TIMEOUT_MS` in the frame entry, and for the same
 * reason: it is the frame's standing answer to "how long before I say so".
 */
export const PRESET_SETTLE_TIMEOUT_MS = 15_000

/**
 * The frame realm, as the report needs to see it.
 *
 * Injected rather than read directly so the *timing* — the part that was wrong —
 * can be driven in a test without a browser. Every reader is a thunk, because
 * the whole point is that they may be called later than the call that asks for
 * the report, and must then answer for that later moment rather than for this
 * one.
 */
export interface LibraryProbe {
  /** Whether the preset's end-of-file marker is present **now**. */
  presetRan: () => boolean
  /** What the preset recorded about its own throw, when it recorded anything. */
  presetError: () => string | undefined
  /** Expected globals the frame does not have **now**. */
  missing: () => readonly string[]
  /** Where the preset was loaded from, read back off the document. */
  presetUrl: () => string
  /** Whether the document is still parsing, so later tags have not run yet. */
  parsing: () => boolean
  /** Register for the moment parsing finishes and every blocking tag has run. */
  onParsed: (settled: () => void) => void
  /** The bounded backstop, for a parse that never finishes. */
  after: (ms: number, expired: () => void) => void
  /** Emit the line on the channel the sentence agrees with. */
  report: (message: string, channel: 'note' | 'error') => void
}

/**
 * Compose the library line at a moment the sentence can honestly describe.
 *
 * The bug this exists to end: the frame's only caller for an **interface** frame
 * is the bootstrap, which runs from a blocking `<script src>` placed *before*
 * the preset tag. Reading the marker there is reading it at a moment that has
 * always already passed by the time anyone opens the panel — the marker is
 * necessarily unset and the missing names are necessarily the preset's own, so
 * the frame said "the library preset never executed" and listed the eight
 * globals the preset was about to publish. Measured on ten of eleven corpus
 * cards, one line per floor that has a frame, every run: not a race, a fixed
 * document order. The report was about a moment and read as a standing fact.
 *
 * So: if the marker is already true there is nothing to wait for, and any
 * remaining absence is a genuine gap that gets the gap sentence. If the document
 * has finished parsing, the preset tag has had its turn — run or definitively
 * not — and a marker still unset is the real finding, reported by name. Only
 * while parsing is still in flight is the reading deferred, to whichever of the
 * settle point or the bound comes first, and **re-read** there rather than
 * replayed: a marker that flipped in between means there was never anything to
 * say.
 *
 * Reported at most once per call, whichever of the two arrives first.
 *
 * @param probe - the frame realm, injected.
 */
export function reportLibraryState(probe: LibraryProbe): void {
  const emit = (): void => {
    const recorded = probe.presetError()
    const message = describeLibraryState(
      probe.presetRan(),
      probe.missing(),
      probe.presetUrl(),
      recorded,
    )
    if (message === undefined) return

    /*
     * **The channel has to agree with the sentence.**
     *
     * This was always posted as an `error`, and the panel renders an error under
     * the card-script heading as *failed*. So a frame whose preset loaded fine
     * and merely lacks `showdown` announced "card scripts: failed" — while the
     * message itself said "the preset ran, so these are libraries Iris does not
     * carry **rather than a failed load**". The text and the channel contradicted
     * each other, and the channel is what a reader sees first.
     *
     * A recorded preset throw is a real failure and stays an error. Absent
     * libraries with a preset that ran are a **note**: a fact worth having when
     * something else goes wrong, and not itself something going wrong.
     */
    probe.report(message, recorded !== undefined && recorded !== '' ? 'error' : 'note')
  }

  // Nothing to wait for: either the preset has already spoken for itself, or the
  // document has stopped handing out turns and its silence is the answer.
  if (probe.presetRan() || !probe.parsing()) {
    emit()
    return
  }

  let spoken = false
  const settled = (): void => {
    if (spoken) return
    spoken = true
    emit()
  }
  probe.onParsed(settled)
  probe.after(PRESET_SETTLE_TIMEOUT_MS, settled)
}
