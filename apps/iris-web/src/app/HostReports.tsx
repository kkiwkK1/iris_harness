/**
 * The host's own diagnostics, on screen.
 *
 * **Why this exists.** The host has held a report buffer for a while and
 * `debug.reports` has been in the contract the whole time, with no caller
 * anywhere in this app: the records had no exit to the screen. That is not an
 * abstract gap — the variables cleanup is on by default and really deletes a
 * user's message data, and "we trimmed it correctly" and "the user knows we
 * trimmed it" are two different claims. Only the second one needs a view.
 *
 * **Not dependent on a script frame**, which is the requirement that decides
 * where it lives. `ScriptPanel` is about a card's run and is empty in a chat
 * with no scripts; the host trims, materialises books and evaluates templates
 * regardless. Verifying this in a chat that *has* scripts would prove nothing
 * about the case it was built for.
 *
 * Pulled on demand, not polled. The charter is explicit that this is a debug
 * page and not an observability platform, and a poll costs something while
 * nobody is looking. The one class of record that cannot wait to be asked for —
 * an irreversible deletion — is pushed as an event and toasted instead
 * (`store.ts`, the `report` frame), so this view is for reading the rest and
 * for looking again afterwards.
 *
 * Typography follows `StatePanel`'s rules rather than a debugger's: no colour
 * carries meaning on its own, kinds are set in the annotation sans, and a long
 * message wraps instead of opening a horizontal scrollbar.
 *
 * @module iris-web/app/HostReports
 */

import { useMemo, useState, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ReportGrade } from '@iris/protocol'

import { useIris, useIrisStore } from '../client/provider.tsx'
import { actionsOf } from '../client/store.ts'

/**
 * How one row should be read.
 *
 * **`grade` and nothing else.** The two rejected alternatives are worth naming,
 * because both were plausible and both invent a severity the reporter never
 * stated:
 *
 * - *by `kind`* — `kind` is the **area** (`mvu | template | prompt | script |
 *   variables | storage | host`), and every area reports ordinary traffic as
 *   well as failures. A list of "error-ish kinds" is wrong in both directions
 *   at once: a failure in a quiet area reads as routine, a routine record in a
 *   noisy one reads as broken.
 * - *by `stack`* — closer, since the protocol says a stack is present only when
 *   an error was caught, but most report sites write their own sentence without
 *   catching anything. That makes "no stack" mean two different things.
 *
 * So the **report site** decides, the same way it decides `irreversible`, and
 * the field is required — a new site that says nothing about severity does not
 * compile. There is deliberately **no fallback to `stack`**: a fallback is how
 * an unset grade would keep working while meaning nothing, and the reason to
 * make the field required was to stop exactly that.
 *
 * Painting the whole list red is a mistake this app has already made once: a
 * class applied to every row cannot also mean "broken".
 * @param report - one record.
 * @returns the row's class list.
 */
function classFor(report: { grade: ReportGrade }): string {
  return report.grade === 'fault'
    ? 'iris-script__report iris-script__report--fault'
    : 'iris-script__report'
}

/** A local time, to the second. Reports arrive as epoch milliseconds. */
function timeOf(at: number): string {
  try {
    return new Date(at).toLocaleTimeString()
  } catch {
    // An implausible timestamp. Shown as given rather than as "Invalid Date",
    // which reads as a bug in the page rather than in the record.
    return String(at)
  }
}

/**
 * The host report list, with a kind filter.
 *
 * @returns the section.
 */
export function HostReports(): ReactElement {
  const store = useIrisStore()
  const reports = useIris(state => state.hostReports)
  const dropped = useIris(state => state.hostReportsDropped)
  const kinds = useIris(state => state.hostReportKinds)
  const loading = useIris(state => state.hostReportsLoading)
  const [hidden, setHidden] = useState<readonly string[]>([])

  /*
   * The kinds offered are the union of what the host says it holds and what the
   * fetched records actually carry. The two can disagree — the buffer's `kinds`
   * is what the host has *ever* recorded, and a kind can age out of a bounded
   * buffer — and a filter that offered only one of them would either hide a
   * visible row or offer a button that filters nothing.
   */
  const offered = useMemo(() => {
    const seen = new Set<string>(kinds)
    for (const report of reports ?? []) seen.add(report.kind)
    return [...seen].sort()
  }, [kinds, reports])

  const shown = (reports ?? []).filter(report => !hidden.includes(report.kind))

  return (
    <section className="iris-reports">
      <div className="iris-reports__head">
        <span className="iris-field__label">Host reports</span>
        {/*
          The drawer's own control, not a new one. A debug read that invents its
          own button styling is a second visual language in a panel that already
          has one — and this app has just paid for a class that looked like a
          control and resolved to nothing.
        */}
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => {
            void actionsOf(store).loadHostReports()
          }}
        >
          {loading ? 'Reading…' : reports === undefined ? 'Read' : 'Read again'}
        </Button>
      </div>

      {offered.length > 1 && (
        <div className="iris-reports__kinds">
          {offered.map(kind => {
            const off = hidden.includes(kind)
            return (
              <button
                type="button"
                key={kind}
                className={off ? 'iris-reports__filter iris-reports__filter--off' : 'iris-reports__filter'}
                aria-pressed={!off}
                onClick={() => {
                  setHidden(off ? hidden.filter(it => it !== kind) : [...hidden, kind])
                }}
              >
                {kind}
              </button>
            )
          })}
        </div>
      )}

      {/*
        Three states, told apart on purpose. "Not read yet" and "read, and the
        host had nothing" are opposite answers that an empty list renders
        identically — and the second one is evidence, so it has to be sayable.
      */}
      {reports === undefined ? (
        <p className="iris-field__note">Not read yet.</p>
      ) : shown.length === 0 ? (
        <p className="iris-field__note">
          {reports.length === 0
            ? 'The host has reported nothing.'
            : 'Every fetched report is filtered out.'}
        </p>
      ) : (
        <ol className="iris-reports__list">
          {shown.map(report => (
            <li
              key={report.seq}
              className={classFor(report)}
            >
              <span className="iris-reports__area">{report.kind}</span>
              <span className="iris-reports__at">{timeOf(report.at)}</span>
              <span className="iris-reports__message">{report.message}</span>
              {/*
                The stack only when there is one. An empty `<details>` beside
                every ordinary record would train a reader to ignore the
                disclosure exactly where it matters.
              */}
              {report.stack !== undefined && report.stack !== '' && (
                <details className="iris-reports__stack">
                  <summary>stack</summary>
                  <pre>{report.stack}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}

      {/*
        What the buffer lost, which is a fact about the *instrument* rather than
        about the host. A bounded buffer that quietly drops the oldest records
        would let a reader conclude that nothing happened before the oldest line
        they can see.
      */}
      {dropped > 0 && (
        <p className="iris-field__note">
          {dropped} older {dropped === 1 ? 'report' : 'reports'} were dropped before the oldest
          shown.
        </p>
      )}
    </section>
  )
}
