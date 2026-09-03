/**
 * What the host report list shows, as opposed to what the host holds.
 *
 * Two decisions live here, and they are here rather than in `HostReports.tsx`
 * for one reason: **`node --test` cannot load a `.tsx`**, so a decision left in
 * the component is a decision nothing can assert. This project has already paid
 * for that once — a field computed in a tested module and dropped by an
 * untested line between it and its consumer — so anything that decides
 * something moves out of the view and the view keeps only rendering.
 *
 * @module iris-web/app/host-report-rows
 */

import type { DebugReport, ReportGrade } from '@iris/protocol'

/** One row as shown: a report, plus how many identical ones it stands for. */
export interface ReportRun {
  /** The newest of the run, which is what the row renders. */
  report: DebugReport
  /** How many consecutive identical reports it stands for. At least 1. */
  count: number
  /** When the first of them arrived. Equal to `report.at` for a run of one. */
  firstAt: number
}

/**
 * Collapse **consecutive** identical reports into one row.
 *
 * Some host reports arrive once per chat open by design — "6 script injections
 * are still live on this chat from an earlier session" is a standing condition,
 * not an event — so a buffer read after a few opens is mostly one sentence
 * repeated, and everything else is pushed off the screen by it.
 *
 * **Display only. Neither the host's buffer nor the fetched array is touched:**
 * two records are two records, and the host's count is the fact. What changes is
 * how many lines they occupy, and the row shows `×N` with both timestamps so
 * nothing about the repetition is hidden — a collapse that dropped the first
 * time would answer "when did this start?" with the wrong number.
 *
 * **Consecutive only**, deliberately. Merging across the whole list reorders
 * evidence: `A A B A` collapsed globally reads as "A ×3, then B", which asserts
 * that A stopped happening after B. Run-based collapsing says `A ×2, B, A`,
 * which is what occurred.
 *
 * Identity is `(kind, message)`. Not `seq` — every record has a distinct one,
 * so nothing would ever collapse — and not the message alone, because the same
 * sentence from two areas is two different findings.
 *
 * @param reports - the fetched reports, in the host's order.
 * @returns one entry per run, in the same order.
 */
export function collapseRuns(reports: readonly DebugReport[]): ReportRun[] {
  const runs: ReportRun[] = []
  for (const report of reports) {
    const last = runs.at(-1)
    if (
      last !== undefined
      && last.report.kind === report.kind
      && last.report.message === report.message
    ) {
      /*
       * The **newest** of the run becomes the row, so `seq` and `at` read as
       * "the last time this was true" — the question someone looking at a
       * standing condition is actually asking. `firstAt` keeps the other half.
       */
      runs[runs.length - 1] = { report, count: last.count + 1, firstAt: last.firstAt }
      continue
    }
    runs.push({ report, count: 1, firstAt: report.at })
  }
  return runs
}

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
 *   catching anything, so "no stack" would mean two different things.
 *
 * So the **report site** decides, the same way it decides `irreversible`, and
 * the field is required — a new site that says nothing about severity does not
 * compile. There is deliberately **no fallback to `stack`**: a fallback is how
 * an unset grade would keep working while meaning nothing, and making the field
 * required was the point.
 *
 * Painting the whole list red is a mistake this app has already made once: a
 * class applied to every row cannot also mean "broken".
 * @param report - one record.
 * @returns the row's class list.
 */
export function classForReport(report: { grade: ReportGrade }): string {
  return report.grade === 'fault'
    ? 'iris-script__report iris-script__report--fault'
    : 'iris-script__report'
}
