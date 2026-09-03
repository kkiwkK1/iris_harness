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

/**
 * Libraries the frame already has, keyed by what their CDN URLs contain.
 *
 * **Only what is genuinely seeded**, and each entry is a claim that can be
 * checked: the seven scripts are the ones `preset-entry.ts` imports and
 * `check-preset.mjs` exercises by calling them, and FontAwesome's rules are
 * inlined by `message-preset-styles.ts`.
 *
 * Over-claiming here is the dangerous direction. A refusal graded as "already
 * covered" is a refusal a reader stops looking at, so an entry for something we
 * do *not* seed would hide a real breakage behind a reassuring line. Under-
 * claiming only leaves an ordinary red report, which is where we started. That
 * asymmetry is why the list is short and why `js-yaml` is deliberately absent:
 * we seed the `yaml` package as `YAML`, and a card asking for `js-yaml` wants
 * `jsyaml`, a different global with a different API. It is a near-miss, which
 * is exactly the kind of entry that would be wrong in the quiet direction.
 *
 * Ordered, and it has to be: `vue-router` contains `vue`, so the longer name is
 * tested first or every router refusal would be reported as Vue's.
 */
const PRESEEDED: readonly (readonly [string, string])[] = [
  ['vue-router', 'vue-router'],
  ['vuerouter', 'vue-router'],
  ['font-awesome', 'FontAwesome'],
  ['fontawesome', 'FontAwesome'],
  ['jquery', 'jQuery'],
  ['lodash', 'lodash'],
  ['showdown', 'showdown'],
  ['zod', 'zod'],
  ['vue', 'Vue'],
]

/**
 * Which preseeded library a refused URL was reaching for, if any.
 *
 * Matched on the **whole URL**, lower-cased. Not the filename alone: cards
 * reach for `.../npm/vue@3/dist/vue.global.prod.js` and for `.../vue/3.5.13/vue.min.js`,
 * and the identifying word is in the path in one and the file in the other.
 * @param url - the refused URL, or any string standing in for it.
 * @returns the library's name as a reader would recognise it.
 */
function preseededIn(url: string): string | undefined {
  const haystack = url.toLowerCase()
  for (const [needle, name] of PRESEEDED) {
    if (haystack.includes(needle)) return name
  }
  return undefined
}

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
  /**
   * The preseeded library this request was reaching for, when it was one.
   *
   * Present means **nothing is missing**: the card's guard did not find the
   * evidence it looks for, took its fallback path, and the fallback was refused
   * — while the library itself was in the frame the whole time. A reader needs
   * that graded differently from a refusal that cost the card a capability,
   * because the two want opposite responses: fix nothing, versus fix something.
   *
   * Decided here rather than in the shell because it **cannot** be decided
   * there. A foreign-origin refusal reports the host alone — `detail` is
   * deliberately absent for those — so by the time the shell sees it, the path
   * that names the library is gone. The frame is the only party that ever holds
   * the whole URL.
   */
  covered?: string
}

/** The parts of a `SecurityPolicyViolationEvent` this decision reads. */
export interface BlockedViolation {
  /** Which directive did the refusing. */
  effectiveDirective?: string
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
 * The whole message the frame sends about one refusal.
 *
 * **Assembled here rather than in the listener, and that is the repair of a real
 * failure.** `covered` was added to this module and to the protocol and to the
 * shell, with tests either side — one proving this module returns it, one
 * proving the panel renders it — and the listener that copies fields from here
 * into the message was never updated. So the field was computed and dropped on
 * the floor, both tests stayed green, and the grade never once reached a reader.
 *
 * The listener is in `frame-entry.ts`, an entry module `node --test` cannot
 * load, so nothing there can be covered. Moving the assembly into the tested
 * module is the only version of this fix that cannot silently happen again: a
 * field added to the report is now added to the message in the same file, and
 * one test sees both.
 *
 * @param run - the frame's token, which stamps every message.
 * @param event - the violation.
 * @param shellOrigin - the origin Iris serves from. **Not `location.origin`**:
 *   this frame's origin is opaque, so that reads the string `"null"` and the
 *   self-origin comparison below can never succeed.
 * @returns the `blocked` message, with the optional fields present only when
 *   they carry something.
 */
export function blockedMessageFor(
  run: string,
  event: BlockedViolation,
  shellOrigin: string,
): {
  iris: string
  type: 'blocked'
  host: string
  directive: string
  detail?: string
  covered?: string
} {
  const { host, detail, covered } = describeBlocked(event, shellOrigin)
  return {
    iris: run,
    type: 'blocked',
    host,
    directive: event.effectiveDirective ?? 'unknown',
    ...(detail === undefined ? {} : { detail }),
    ...(covered === undefined ? {} : { covered }),
  }
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
  const covered = preseededIn(event.blockedURI)
  if (url.origin !== selfOrigin) {
    return { host, ...(covered === undefined ? {} : { covered }) }
  }

  /*
   * Our own origin. The path is the identity, and the source location is who
   * asked — a card's own bundle and the frame's bootstrap are both possible
   * requesters here, and the difference decides whose bug it is.
   */
  const where = event.sourceFile === undefined || event.sourceFile === null
    || event.sourceFile === ''
    ? ''
    : ` from ${tailOf(event.sourceFile)}:${String(event.lineNumber ?? 0)}`
  return {
    host,
    detail: `${url.pathname}${url.search}${where}`,
    /*
     * Our own origin can be the covered case too, and one path reaches it: a
     * card fetching a library by an unqualified URL. A srcdoc frame resolves
     * relative URLs against the parent's base, so `fetch('/lib/jquery.min.js')`
     * is refused as *us* rather than as a CDN.
     */
    ...(covered === undefined ? {} : { covered }),
  }
}
