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
