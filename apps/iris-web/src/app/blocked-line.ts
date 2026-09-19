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
 * The grant question joined it for the same reason one round later. The panel
 * offers to turn the network grant on beside a refusal the grant could fix, and
 * that offer needs to know which directives the grant widens — a fact that lives
 * in `policy.ts` and must not be restated here or in the view.
 *
 * So the decision lives here, and it is testable — neither caller is, being a
 * `.tsx` module `node --test` cannot load.
 *
 * @module iris-web/app/blocked-line
 */

import { grantOffer } from '../sandbox/policy.ts'

/**
 * How a report should be read.
 *
 * **There is no `'failure'` default, and that was a real mistake worth naming.**
 * The first version of this graded an ungraded report as a failure, and the
 * panel painted every entry in the report list red — because most entries are
 * not failures at all: what a frame paid for its libraries, a card's own
 * `toastr.info`, the overlay's visibility summary. Absent means **neutral**, and
 * only a channel that knows it is describing something broken says so.
 */
export type ReportGrade = 'fault' | 'note'

/**
 * What a refusal implies about the network grant.
 *
 * Carried on the refusal rather than recomputed by the panel, because the panel
 * does not have the directive-to-grant mapping and should not grow one — see
 * `GRAFTED_WIDENED_DIRECTIVES`'s note in `policy.ts` for why one copy of that
 * fact is the point.
 */
export type RefusalGrant = 'offer' | 'already-on' | 'no'

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
  /**
   * Whether the network grant could fix this, and whether it is already on.
   *
   * The panel turns `'offer'` into a button beside the line. **Absent means
   * `'no'`**, deliberately: a caller that predates this field keeps working, and
   * a refusal with no directive to judge is one no offer should sit beside.
   */
  grant?: RefusalGrant
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
 * @param networkGranted - whether this card's network grant is already on, which
 *   decides between offering it and saying it is already on. Defaulted rather
 *   than required so a caller with no opinion (a test, the probe) still gets a
 *   refusal; the offer is the only thing that needs the answer.
 * @returns the sentence, its grade, and whether to interrupt with it.
 */
export function describeRefusal(
  host: string,
  directive: string,
  detail?: string,
  covered?: string,
  networkGranted = false,
): Refusal {
  const where = detail === undefined ? '' : detail
  const line = `blocked ${host}${where} (${directive})`
  /*
   * Judged for every refusal, including the covered one below.
   *
   * A covered refusal is graded as a note because nothing is missing — but the
   * grant question is a *separate* fact about it, and the covered case is where
   * conflating them would bite: a card whose guard falls back to a CDN for a
   * library we already seed would be offered a grant to fetch what it already
   * has. The offer's own rule (only a directive the grant widens) is what keeps
   * that from mattering, and it is better stated once here than argued at each
   * grade.
   */
  const grant = grantOffer(directive, networkGranted)
  if (covered === undefined) {
    return { text: line, grade: 'fault', notify: true, grant }
  }
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
    grant,
  }
}
