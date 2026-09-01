/**
 * Whether the browser ever put a stalled import's request on the wire.
 *
 * Extracted from the frame entry so it can be tested, and it is the piece of
 * that file most worth testing: it decides which half of the world a reader goes
 * to look at. "The fetch never returned" has two causes needing opposite fixes —
 * the browser declined to dispatch (policy, resolution, our fault) or it
 * dispatched and nothing came back (the network, theirs) — and from inside a
 * frame they are identical.
 *
 * It has already been wrong once, in the way an instrument is worst wrong: with
 * **no targets at all** it reported "the browser never sent the request", which
 * is not merely unhelpful but false — there was no request to send. A module
 * parked on a top-level `await` was therefore reported as a network problem, and
 * the reader was sent to the wrong half of the world.
 *
 * That is the reason this file exists rather than the logic living inline. An
 * instrument that only speaks on an exception has **unfalsifiable silence**:
 * saying nothing could mean nothing went wrong, or that it is broken. The only
 * way to know is a test that hands it the trigger and requires it to speak.
 *
 * @module iris-web/sandbox/import-attempts
 */

/**
 * What resource timing reports.
 *
 * The numbers are optional because they are **not always readable**. A frame
 * here is an opaque origin, so every entry is cross-origin, and a cross-origin
 * entry is opaque about its timings unless the server sends
 * `Timing-Allow-Origin` — the name and the entry's existence are visible either
 * way, but every duration reads as zero.
 *
 * That is why this used to answer only "sent or not". Iris's own routes now send
 * the header, so the numbers are real for them and the answer can be finer; for
 * anything else the zeros are still zeros, which is why nothing here treats a
 * zero as a measurement.
 */
export interface TimedResource {
  name: string
  /** When the response finished. Zero means "not finished" *or* "not readable". */
  responseEnd?: number
  /** When the browser started fetching. */
  startTime?: number
  domainLookupStart?: number
  domainLookupEnd?: number
  connectStart?: number
  connectEnd?: number
  requestStart?: number
  responseStart?: number
  /** Bytes over the wire; zero for a cache hit as well as for an opaque entry. */
  transferSize?: number
}

/**
 * Say what the browser attempted, for the targets a stalled module was awaiting.
 *
 * Reading resource timing is not itself a fetch, so it works under
 * `connect-src 'none'`. Cross-origin entries are opaque about durations without
 * `Timing-Allow-Origin`, but their existence and name are visible regardless,
 * and existence is the whole question.
 *
 * Two limits, so a reading is not over-trusted: the entry buffer holds a few
 * hundred and drops the rest, and a redirected request is recorded under the URL
 * first asked for. "No entry" is evidence, not proof.
 *
 * @param targets - the URLs the module was waiting on; empty when it has none.
 * @param entries - resource timing entries, or undefined when unavailable.
 * @returns a phrase naming what the browser did, or what cannot be known.
 */
export function describeAttempts(
  targets: readonly string[],
  entries: readonly TimedResource[] | undefined,
): string {
  if (entries === undefined) {
    // A frame that cannot answer says so, rather than letting a missing API read
    // as a missing request.
    return 'resource timing is unavailable here, so whether the request was sent is unknown'
  }
  if (targets.length === 0) {
    /*
     * The case this got wrong. No targets means nothing was ever going to be
     * fetched, so neither "sent" nor "not sent" is a true answer — and the
     * false one pointed at the network while the module sat on a top-level
     * await of its own.
     */
    return 'this module has no remote imports, so nothing was waiting on the network'
  }

  // Names and entries kept separately: the partial answer needs the URLs a
  // reader can act on, the completed answer needs the numbers behind them.
  const sent = targets.filter(target => entries.some(entry => entry.name === target))
  const found = targets
    .map(target => entries.find(entry => entry.name === target))
    .filter((entry): entry is TimedResource => entry !== undefined)

  if (sent.length === targets.length) {
    /*
     * "Did send" was true and not enough.
     *
     * A real card sat here for fifteen seconds while `curl` answered the same
     * URL in 46ms, and this sentence sent a reader to "the network or the
     * server" — which was, as far as it went, correct and useless. Sent and
     * *finished* is a completely different finding from sent and still
     * outstanding: the first means the delay is after the fetch, the second
     * means it is in it.
     */
    const detail = found.map(entry => describeOne(entry)).filter(part => part !== undefined)
    if (detail.length === 0) {
      return (
        'the browser did send the request, but this frame cannot read its timings' +
        ' (no Timing-Allow-Origin from that host), so where the time went is not visible here'
      )
    }
    return `the browser did send the request — ${detail.join('; ')}`
  }
  if (sent.length === 0) {
    return 'the browser never sent the request, so it was refused or unresolvable before the wire'
  }
  return `only some were sent (${sent.join(', ')})`
}

/**
 * What one timing entry says about where the time went.
 *
 * Returns undefined when the entry carries no readable numbers at all, so the
 * caller can say *that* rather than print a row of confident zeroes. A zero is
 * never reported as a measurement: for a cross-origin entry without
 * `Timing-Allow-Origin` every field reads zero, and "0ms DNS, 0ms connect" is a
 * sentence that looks like data and is an absence.
 *
 * @param entry - the resource timing entry.
 * @returns a phrase describing the fetch, or undefined when nothing is readable.
 */
function describeOne(entry: TimedResource): string | undefined {
  const end = entry.responseEnd ?? 0
  const start = entry.startTime ?? 0

  if (end === 0) {
    /*
     * Either still in flight, or opaque. The two are distinguished by whether
     * *anything* else is readable: an entry with a readable start and no end is
     * genuinely outstanding, while an entry that is all zeroes is simply not
     * telling us.
     */
    if (start === 0 && (entry.responseStart ?? 0) === 0) return undefined
    return 'and it has not completed — the time is being spent in the fetch itself'
  }

  const total = Math.round(end - start)
  const parts: string[] = [`it completed in ${String(total)}ms`]

  const span = (from: number | undefined, to: number | undefined): number | undefined => {
    if (from === undefined || to === undefined || from === 0 || to === 0) return undefined
    const value = Math.round(to - from)
    return value > 0 ? value : undefined
  }

  const dns = span(entry.domainLookupStart, entry.domainLookupEnd)
  const connect = span(entry.connectStart, entry.connectEnd)
  const waiting = span(entry.requestStart, entry.responseStart)
  const download = span(entry.responseStart, entry.responseEnd)

  if (dns !== undefined) parts.push(`${String(dns)}ms dns`)
  if (connect !== undefined) parts.push(`${String(connect)}ms connect`)
  if (waiting !== undefined) parts.push(`${String(waiting)}ms waiting for the server`)
  if (download !== undefined) parts.push(`${String(download)}ms downloading`)

  const bytes = entry.transferSize ?? 0
  if (bytes === 0 && total > 0) {
    // Nothing over the wire but time on the clock: a cache hit, or a revalidation.
    parts.push('nothing transferred, so this came from a cache')
  }

  /*
   * The conclusion, not just the numbers. A fetch that finished quickly and a
   * module that never began means the delay is *after* the response — parsing,
   * instantiation, or a nested import — and that is a different place to look.
   */
  parts.push('so the fetch is not where the time went')
  return parts.join(', ')
}
