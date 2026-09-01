/**
 * Whether a card's scripts may start, from the host's three-state answer.
 *
 * This is one line of logic in its own module because getting it wrong is
 * silent. `script.list` reports `scriptsAllowed` as **absent**, `false`, or
 * `true`, and the three mean *never asked*, *asked and declined*, and *asked and
 * allowed*. Reading it as `response.scriptsAllowed ?? false` folds the first into
 * the second: the question is never put, scripts never start, and nothing
 * anywhere reports a problem — the feature simply does not exist, and looks
 * deliberate.
 *
 * The trap is sharper than it sounds because the **sibling field on the same
 * object uses the opposite convention**. `documentGranted` deliberately stores
 * "revoked" and "never granted" as one state, because those two should be
 * indistinguishable — revoking access must not leave a trace that says access
 * once existed. For consent the distinction *is* the feature: a user who
 * declined must not be asked again on every chat they open.
 *
 * So `documentGranted` is read with `??` and `scriptsAllowed` never is, in two
 * fields of one response.
 *
 * Presence testing is not the answer either — see `consentState`.
 *
 * @module iris-web/sandbox/consent
 */

/** What the host's answer means. */
export type ConsentState =
  /** Nobody has been asked. Put the question. */
  | 'unasked'
  /** Asked, and declined. Do not ask again; the panel can still change it. */
  | 'declined'
  /** Asked, and allowed. */
  | 'allowed'

/**
 * Read the consent state from a `script.list` response.
 *
 * Takes the whole response rather than the field, because the distinction being
 * preserved is *presence*, and a caller that destructured the field first would
 * already have lost it.
 * @param listed - the `script.list` response, or whatever stood in for it.
 * @returns which of the three states the host reported.
 */
export function consentState(
  // `| undefined` on the property, not just optional: under
  // `exactOptionalPropertyTypes` those are different types, and the explicit
  // shape is the one this function exists to survive. Declaring it is what makes
  // the tolerance visible rather than something a test has to cast its way into.
  listed: { scriptsAllowed?: boolean | undefined } | undefined,
): ConsentState {
  /*
   * Switched on the value in three ways rather than tested for presence.
   *
   * The advice this was written from said to use `'scriptsAllowed' in listed`
   * instead of `?? false`, which is right about the bug it names and wrong at one
   * edge: `{ scriptsAllowed: undefined }` *has* the key, so `in` calls it answered
   * and it falls through to `declined` — the same silent suppression, reached by
   * the fix rather than by the mistake. A spread or an optional property produces
   * that shape without anyone intending it.
   *
   * Naming all three outcomes has no such edge, and it fails safe: anything that
   * is not literally `true` or `false` is nobody's answer, so the question gets
   * asked rather than quietly treated as refused.
   */
  if (listed?.scriptsAllowed === true) return 'allowed'
  if (listed?.scriptsAllowed === false) return 'declined'
  return 'unasked'
}

/**
 * Whether the consent gate should put the question to the user.
 * @param state - the consent state.
 * @returns true only when nobody has been asked yet.
 */
export function shouldAsk(state: ConsentState): boolean {
  return state === 'unasked'
}

/**
 * Whether scripts may start.
 *
 * Only an explicit yes. Both "not asked" and "declined" mean nothing runs — they
 * differ in what the interface does next, not in what executes.
 * @param state - the consent state.
 * @returns true only when the user has allowed it.
 */
export function mayRun(state: ConsentState): boolean {
  return state === 'allowed'
}

/**
 * How many bytes a card's scripts come to, for the question.
 *
 * `bytes` is UTF-8 bytes, so dividing by 1024 is correct with no conversion.
 *
 * It was not always. The field shipped holding `content.length`, which counts
 * UTF-16 code units — roughly characters — while being named `bytes`, and the
 * type system had nothing to say because both are `number`. Across the corpus
 * that understated the real size by 1.13x overall and 2.07x on the worst single
 * script. The direction is what makes it worth remembering: it never threw and
 * never logged, it just printed a smaller number on the one screen whose entire
 * purpose is helping someone size up a risk before accepting it.
 * @param scripts - the card's scripts.
 * @returns total size in bytes.
 */
export function totalBytes(scripts: readonly { bytes: number, enabled: boolean }[]): number {
  return scripts.reduce((sum, script) => sum + script.bytes, 0)
}
