/**
 * How a refused subresource reads in the panel.
 *
 * Two frame kinds report refusals — a card's script frame and a message
 * interface frame — and both used to compose this sentence themselves, in two
 * places, identically. That was survivable while the sentence was one template.
 * It stopped being survivable the moment refusals had to be **graded**: a rule
 * about which refusals are not failures, written twice, is a rule that will
 * disagree with itself, and the half that stays wrong is the half nobody looks
 * at because its reports look fine.
 *
 * So the decision lives here, and it is testable — neither caller is, being a
 * `.tsx` module `node --test` cannot load.
 *
 * @module iris-web/app/blocked-line
 */

/** How a report should be read. */
export type ReportGrade = 'failure' | 'note'

/** One refusal, ready for the panel. */
export interface Refusal {
  /** The sentence to show. */
  text: string
  /** Whether it describes something broken. */
  grade: ReportGrade
  /**
   * Whether it is worth a transient notice as well as a durable report.
   *
   * False for the covered case, and this is the only place the distinction can
   * be made. A notice bar exists to interrupt; interrupting someone to say that
   * nothing is wrong is how a channel gets tuned out, and the next thing tuned
   * out with it is the refusal that *did* cost the card something. The durable
   * report still carries it, so nothing is lost — only the interruption.
   */
  notify: boolean
}

/**
 * Describe one refused request.
 *
 * @param host - the host the frame named, or `inline`/`eval`/`data` when the
 *   policy refused something with no host at all.
 * @param directive - the CSP directive that did the refusing.
 * @param detail - the path and requester, present only when the host cannot
 *   identify the request on its own.
 * @param covered - the preseeded library the request was reaching for, decided
 *   in the frame because the shell never sees the URL. See `blocked-report.ts`.
 * @returns the sentence, its grade, and whether to interrupt with it.
 */
export function describeRefusal(
  host: string,
  directive: string,
  detail?: string,
  covered?: string,
): Refusal {
  const where = detail === undefined ? '' : detail
  const line = `blocked ${host}${where} (${directive})`
  if (covered === undefined) return { text: line, grade: 'failure', notify: true }
  /*
   * **The sentence says what to do about it, because the answer is "nothing".**
   *
   * A refusal graded as a note but phrased identically to a failure is worse
   * than an ungraded one: the reader has to already know the rule to read the
   * colour, and the line still says the frightening thing. The card's guard
   * looked for a `<link>` it did not find, took its CDN fallback, and hit the
   * policy — while the library had been in the frame since before the card ran.
   */
  return {
    text: `${line} — ${covered} is already preseeded, so the card is not missing it`,
    grade: 'note',
    notify: false,
  }
}
