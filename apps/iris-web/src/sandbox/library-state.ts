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
 * @returns the sentence to report, or undefined when there is nothing to say.
 */
export function describeLibraryState(
  presetRan: boolean,
  missing: readonly string[],
  presetUrl: string,
): string | undefined {
  if (!presetRan) {
    /*
     * Reported whether or not names are missing. A preset that did not run is a
     * finding on its own: something else may have supplied the globals, and the
     * frame is then working by accident in a way that will stop without warning.
     */
    return (
      `the library preset never finished running (${presetUrl}) — every library below is a` +
      ' consequence of that one failure, not a separate gap, so check that request before' +
      ` anything else${missing.length === 0 ? '' : `: ${missing.join(', ')}`}`
    )
  }

  if (missing.length === 0) return undefined

  return (
    `libraries a card may expect are not present in this frame: ${missing.join(', ')}` +
    ' — the preset ran, so these are libraries Iris does not carry rather than a failed load'
  )
}
