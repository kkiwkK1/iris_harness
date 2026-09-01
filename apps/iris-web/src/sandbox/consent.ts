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
  /**
   * The host has not answered yet.
   *
   * Distinct from `unasked`, and the distinction is the same one this module
   * exists for, moved up a layer. A card whose answer is still in flight is not
   * a card nobody has asked about: rendering the question then puts it to a user
   * who already answered it, and — because only `allowed` runs anything — also
   * stops the scripts of a card that had said yes.
   *
   * The first version had three states and used `unasked` as the initial value,
   * which is exactly that collapse. It is the same shape as reading an absent
   * `scriptsAllowed` as a decline, one level further out: a state meaning "no
   * information" borrowed a state meaning "a specific answer".
   */
  | 'unknown'
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
  // `unknown` deliberately does not ask. A question that appears and then turns
  // out to have been answered already is worse than one that appears a beat
  // late: the user is asked to decide something they have decided, and the
  // interface has told them their earlier answer did not stick.
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

/** What the question has to state, counted once. */
export interface ConsentFigures {
  /** Scripts that would run today. */
  running: number
  /** Every script the answer covers. */
  total: number
  /** Size of the ones that would run. */
  runningBytes: number
  /** Size of all of them. */
  totalBytes: number
}

/**
 * Measure a card's scripts for the question, both ways, in one pass.
 *
 * Returned together rather than computed at the call site, because computing
 * them separately is how the first version came to count one thing and measure
 * another: `4 scripts (448 kB)` — four being the enabled ones at 17 kB, and
 * 448 kB being all nine, 423 kB of which were switched off. A user was told they
 * were about to run twenty-six times more code than they were.
 *
 * It survived review because the card it was checked against had two scripts and
 * both enabled, so the two rulers coincided exactly — another pair of
 * divergences that cancel on a single example.
 * @param scripts - the card's scripts.
 * @returns both counts and both sizes.
 */
export function consentFigures(
  scripts: readonly { bytes: number, enabled: boolean }[],
): ConsentFigures {
  const running = scripts.filter(script => script.enabled)
  return {
    running: running.length,
    total: scripts.length,
    runningBytes: totalBytes(running),
    totalBytes: totalBytes(scripts),
  }
}

/**
 * The sentence the question asks, both rulers included.
 *
 * Built here rather than in the component so it can be tested against the shapes
 * that catch its mistakes: a card where the enabled count and the total diverge,
 * and a card with exactly one script. The first version got the units wrong and
 * the second got the grammar wrong, and both were only visible on cards nobody
 * had checked against — two scripts both enabled hides the first, and any count
 * above one hides the second.
 *
 * The byte formatter is passed in because it belongs to the interface layer and
 * this module belongs to the sandbox; the sentence should not drag one into the
 * other.
 * @param figures - the counts and sizes, measured in one pass.
 * @param bytes - how to render a size.
 * @returns the sentence, ready to show.
 */
export function describeConsentAsk(
  figures: ConsentFigures,
  bytes: (count: number) => string,
): string {
  const dormant = figures.totalBytes - figures.runningBytes
  const opening =
    figures.running === figures.total
      ? `This card runs ${figures.running === 1 ? '1 script' : `${String(figures.running)} scripts`} (${bytes(figures.runningBytes)}).`
      : `${String(figures.running)} of ${String(figures.total)} scripts would run now (${bytes(figures.runningBytes)}).`
  const covered =
    dormant > 0
      ? ` Your answer covers all ${String(figures.total)}, including ${bytes(dormant)} switched off today.`
      : ''
  // Agrees with the number of scripts that would actually run — the subject of
  // the sentence — rather than with the card.
  const closing =
    figures.running === 1
      ? ' It runs in an isolated sandbox and cannot read your other chats unless you also grant page access.'
      : ' They run in an isolated sandbox and cannot read your other chats unless you also grant page access.'

  return `${opening}${covered}${closing}`
}
