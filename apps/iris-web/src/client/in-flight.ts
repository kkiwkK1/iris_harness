/**
 * One request in the air per question, however many frames ask it.
 *
 * ## The traffic this exists to stop
 *
 * Every displayed message row mounts its own `MessageInterfaces`, and each one
 * asks the host for the card's script context and script list before it can
 * build a frame. The deps of that effect are the chat, the card and the consent
 * answer — identical for every row — so React commits them together and the
 * page issues N copies of one question in a single tick. Measured on a cold
 * load of one real conversation (8789, 2026-09-07): **22 `script.context` calls
 * inside the same millisecond**, all with the same response size, plus 22
 * `script.list`. Re-measured headless against a copy of that profile
 * (`scripts/script-context-probe.mjs`, 2026-09-08): one snapshot is about
 * 145 KB of JSON and the host takes ~1.75 s to build it. The size is quoted
 * loosely on purpose — it tracks the conversation, and two runs an hour apart
 * read 145,282 and 147,385 bytes as the log grew. The 1.75 s does not: it is
 * almost all card-library decoding, and the chat is a rounding error in it.
 *
 * The host answers RPCs one at a time, so the batch took 9 s for the first row
 * and 47 s for the last, and a `connection.test` the reader fired afterwards
 * sat behind them for 30.7 s.
 *
 * ## Why sharing only the *flight*, and how stale a joiner's answer can be
 *
 * A card script's context is a **snapshot taken when the script runs** — that is
 * upstream's semantics, and it is why the naive fix (remember the answer and
 * hand it out again) needs an invalidation rule, and why any such rule is a
 * second place to be wrong about what changes a snapshot.
 *
 * There is no such rule here. An entry lives only from the moment the request
 * is issued to the moment it settles, and the first caller after a flight
 * settles asks the host again. So the bound, stated exactly: **a joiner's
 * answer is no older than the moment its flight was issued** — for the caller
 * that opened the flight that means "taken after I asked", and for a joiner it
 * means "taken at most one request's duration before I asked". Not, as a first
 * draft of this comment claimed, always after the joiner asked.
 *
 * Two things make that the right bound to accept. The host is single-threaded,
 * so a joiner's own request would have **queued behind** this flight and been
 * answered later — at the price of the reader waiting for two requests instead
 * of one, which is the fault this exists to fix. And anything happening inside
 * the window that changes what the snapshot says arrives as a host event, on
 * which `MessageInterfaces`' `watchContext` opens a fresh flight and pushes the
 * newer snapshot into every live frame. The window is bounded *and*
 * self-correcting.
 *
 * This subsumes the event-keyed sharing that used to live in
 * `app/shared-snapshot.ts`. A host event is fanned out to the taps in one
 * synchronous loop (`store.ts`), so every row's listener calls within the same
 * flight — one round trip per event, which is what that module guaranteed —
 * while two separate events, being sequential, each get their own. One
 * mechanism now covers both the mount burst and the refresh burst.
 *
 * ## What it is not
 *
 * Not a cache: nothing outlives the request, so there is no entry left to go
 * stale between one turn and the next. Not a queue — it changes how many
 * requests are made, never the order the host serves them in.
 *
 * @module iris-web/client/in-flight
 */

/**
 * The requests each client has in the air, by key.
 *
 * A `WeakMap` on the client rather than a module-level map, for the reason
 * `TAPS` gives: a hot reload leaves two stores alive, tests stand up several
 * clients at once, and a shared registry would hand one client's answer to
 * another's caller — which for a fake client is a different host entirely.
 */
const FLIGHTS = new WeakMap<object, Map<string, Promise<unknown>>>()

/**
 * Ask once for something several callers want at the same moment.
 *
 * @param scope - the client the request goes to; flights are never shared
 *   across two of them.
 * @param key - what is being asked. Two callers share a flight exactly when
 *   their keys are equal, so the key has to name every argument that changes
 *   the answer — see {@link requestKey}.
 * @param send - issues the request. Called only for the caller that opens the
 *   flight.
 * @returns the flight's promise, resolving or rejecting for every joiner alike.
 */
export function inFlight<T>(scope: object, key: string, send: () => Promise<T>): Promise<T> {
  let open = FLIGHTS.get(scope)
  if (open === undefined) {
    open = new Map<string, Promise<unknown>>()
    FLIGHTS.set(scope, open)
  }
  const joined = open.get(key)
  if (joined !== undefined) return joined as Promise<T>

  const flight = send()
  open.set(key, flight)
  /*
   * Dropped the moment it settles, in both directions — a rejected flight must
   * not be handed to the next caller, who is asking later and may well get an
   * answer. Guarded on identity so a flight opened after this one (same key,
   * later moment) is not deleted by its predecessor's cleanup.
   *
   * `then(drop, drop)` rather than `finally`: `finally` returns a promise that
   * inherits the rejection, and nothing would be handling *that* one — an
   * unhandled rejection warning for a failure the actual callers all handled.
   */
  const drop = (): void => {
    if (open.get(key) === flight) open.delete(key)
  }
  void flight.then(drop, drop)
  return flight
}

/**
 * The key for one RPC, method and arguments together.
 *
 * The arguments are part of it because they are what the host answers about:
 * two rows asking about the same chat share a flight, and a row asking about
 * another chat must not. `JSON.stringify` over a literal written at the call
 * site keeps the key's field order fixed, which is what makes equal requests
 * produce equal strings.
 * @param method - the RPC name.
 * @param params - its arguments.
 * @returns the flight key.
 */
export function requestKey(method: string, params: Record<string, unknown>): string {
  return `${method} ${JSON.stringify(params)}`
}
