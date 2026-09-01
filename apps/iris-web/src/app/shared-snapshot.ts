/**
 * One host event, one snapshot fetch.
 *
 * Lifted out of `MessageInterfaces.tsx` for two reasons, and the second is the
 * one that forced it: it holds no React, and a `.tsx` module cannot be loaded
 * by `node --test` at all — Node's type stripping does not do JSX. A helper
 * whose whole contract is "how many times did this call the host" has to be
 * reachable from a test, so it cannot live in a component file.
 *
 * @module iris-web/app/shared-snapshot
 */
import type { ScriptContext } from '@iris/protocol'

/**
 * The snapshot fetch belonging to one host event, shared by every message row.
 *
 * Every displayed interface wants the same newer snapshot when the chat moves,
 * and each one has its own subscription — so without this, a conversation
 * showing eight interfaces would make eight identical round trips per event, and
 * a card with several blocks would multiply that again.
 *
 * Keyed on the **event object itself** rather than on a counter. The same event
 * instance is handed to every listener, so identity already says "these calls
 * are the same occasion" exactly and with nothing to keep in sync. A counter
 * would be a second opinion about when an event began.
 */
let sharedFetch: { event: unknown, snapshot: Promise<ScriptContext | undefined> } | undefined

/**
 * The snapshot for one host event, fetched at most once.
 * @param event - the event that prompted the refresh, used as the identity key.
 * @param read - how to ask the host, called only for the first caller.
 * @returns the shared snapshot promise.
 *
 * Exported for its test rather than for a caller. The invariant it carries is a
 * *count* — one round trip per event, not eight — and a regression to per-row
 * fetching would break nothing visible: every row would still get the right
 * snapshot, just after N times the traffic. Nothing else here could notice.
 */
export function snapshotFor(
  event: unknown,
  read: () => Promise<ScriptContext | undefined>,
): Promise<ScriptContext | undefined> {
  if (sharedFetch !== undefined && sharedFetch.event === event) return sharedFetch.snapshot
  const snapshot = read()
  sharedFetch = { event, snapshot }
  return snapshot
}
