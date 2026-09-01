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

/** What resource timing reports; only the name is needed here. */
export interface TimedResource {
  name: string
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

  const attempted = targets.filter(target => entries.some(entry => entry.name === target))
  if (attempted.length === targets.length) {
    return 'the browser did send the request, so this is the network or the server, not the frame'
  }
  if (attempted.length === 0) {
    return 'the browser never sent the request, so it was refused or unresolvable before the wire'
  }
  return `only some were sent (${attempted.join(', ')})`
}
