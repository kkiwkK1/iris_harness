/**
 * What a refused subresource is reported as.
 *
 * The frame's own policy blocks the request and the browser fires
 * `securitypolicyviolation` in the frame, so the frame is the only party that
 * sees it and the shell is the only party that can tell the user. The question
 * this module answers is what to carry across that hop.
 *
 * Naming the host was enough while every refusal was a card reaching for a
 * foreign CDN. It stopped being enough the moment one pointed at **us**: a
 * srcdoc frame resolves relative URLs against the parent's base URL, so an
 * unqualified `fetch('/x')` in any card resolves to Iris's own origin — and
 * `connect-src` does not list that origin, while `script-src` does. Every such
 * refusal then reports the identical sentence, `blocked 127.0.0.1:8787
 * (connect-src)`, which is the one string that cannot tell them apart.
 *
 * A live instance of exactly that cost a round of "who, and fetching what?"
 * that no reading of the report could answer, while the event object had
 * carried both answers the whole time. So the rule here is not "report more":
 * it is that a report must be able to distinguish the cases it will be read to
 * distinguish.
 *
 * Separated from `frame-entry.ts` for its test. The listener needs a document
 * and a policy to fire; the decision needs neither, and the decision is the part
 * that was wrong.
 *
 * @module iris-web/sandbox/blocked-report
 */

/** What the frame says about one refused request. */
export interface BlockedReport {
  /** The host, which is what identifies a foreign origin. */
  host: string
  /**
   * The path and source location, when the host does not identify the request.
   *
   * Absent rather than empty for a foreign origin: the shell appends this
   * verbatim, and an empty string would put a stray space in every line.
   */
  detail?: string
}

/** The parts of a `SecurityPolicyViolationEvent` this decision reads. */
export interface BlockedViolation {
  /** The URI the policy refused. Not always a URL: `inline`, `eval`, `data`. */
  blockedURI: string
  /** The document the request came from, when the browser knows one. */
  sourceFile?: string | null
  /** Where in that document, 0 when unknown. */
  lineNumber?: number
}

/**
 * The tail of a URL, which is the part that identifies a file.
 * @param url - a URL or path.
 * @returns the last segment.
 */
function tailOf(url: string): string {
  const at = url.lastIndexOf('/')
  return at === -1 ? url : url.slice(at + 1)
}

/**
 * Describe one refusal.
 *
 * @param event - the violation, or the parts of it that matter.
 * @param selfOrigin - the origin Iris serves from, as `location.origin` gives
 *   it. The comparison is against this rather than against a hardcoded
 *   `127.0.0.1` because the dev port is not the deployed one, and a check that
 *   only recognised the dev origin would go quiet exactly where a refusal is
 *   hardest to reproduce.
 * @returns the host, and the detail when the host cannot stand alone.
 */
export function describeBlocked(event: BlockedViolation, selfOrigin: string): BlockedReport {
  let url: URL
  try {
    url = new URL(event.blockedURI)
  } catch {
    /*
     * `inline`, `eval`, `data` and `blob` all arrive here. Passed through
     * unchanged: naming something unparseable beats dropping it, and these four
     * are already the most identifying string available — there is no path to
     * add.
     */
    return { host: event.blockedURI }
  }

  const host = url.host === '' ? event.blockedURI : url.host
  if (url.origin !== selfOrigin) return { host }

  /*
   * Our own origin. The path is the identity, and the source location is who
   * asked — a card's own bundle and the frame's bootstrap are both possible
   * requesters here, and the difference decides whose bug it is.
   */
  const where = event.sourceFile === undefined || event.sourceFile === null
    || event.sourceFile === ''
    ? ''
    : ` from ${tailOf(event.sourceFile)}:${String(event.lineNumber ?? 0)}`
  return { host, detail: `${url.pathname}${url.search}${where}` }
}
