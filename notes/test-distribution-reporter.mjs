/**
 * node:test custom reporter for the quality audit: JSONL per test event.
 *
 * The spec reporter flattens top-level tests and carries no file attribution,
 * so per-package distribution and per-test durations cannot be parsed from it.
 * This reporter records the raw event stream instead — every `test:*` event
 * becomes one JSON line with the fields the distribution table needs:
 * `type`, `name`, `file`, `duration_ms`, `skip`.
 *
 * Usage (written for notes/AUDIT-SYSTEM-QUALITY-RELIABILITY.md, read-only
 * with respect to product code) — the same globs `npm test` uses, quoted:
 *
 *   node --test --test-reporter ./notes/test-distribution-reporter.mjs \
 *     --test-reporter-destination out.jsonl "packages and apps test globs"
 *
 * @module notes/test-distribution-reporter
 */

export default async function* jsonlReporter(source) {
  let buffer = ''
  for await (const event of source) {
    const { type, data } = event
    if (typeof type !== 'string' || !type.startsWith('test:')) {
      continue
    }
    const record = {
      type,
      name: data?.name,
      file: data?.file,
      duration_ms: data?.details?.duration_ms,
      skip: data?.skip === undefined ? undefined : (data.skip === true ? true : String(data.skip)),
      nesting: data?.nesting,
    }
    buffer += `${JSON.stringify(record)}\n`
    if (buffer.length >= 65536) {
      yield buffer
      buffer = ''
    }
  }
  if (buffer.length > 0) yield buffer
}
