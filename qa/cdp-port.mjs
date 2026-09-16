/**
 * The one CDP debug-port rule for every QA script.
 *
 * A default port is offset by `pid % 100` so two runs back to back do not fight
 * over one debug port; the loser dies as `chrome never came up`, which reads as
 * a broken environment rather than as a collision (qa/README.md). An explicit
 * `CDP_PORT` — or the legacy `CHROME_DEBUG_PORT`, where a script still accepts
 * it — is honoured verbatim: you named the port, so you own it.
 *
 * This lives in one module because seven scripts carried seven copies of the
 * same three lines in two spellings, and `z1-e2e.mjs` had drifted all the way
 * to a bare `process.env.CDP_PORT ?? '9343'` — the fixed port that collides
 * with `notice-center-baseline.mjs`'s default.
 * @module qa/cdp-port
 */

/**
 * Resolve the debug port from the environment, defaulting to `base` and offset
 * by the pid when the caller did not name one.
 * @param base - this script's default port.
 * @param legacy - an older environment variable name still accepted, if any.
 * @returns the port number to pass to `--remote-debugging-port`.
 */
export function cdpPort(base, legacy) {
  const named = process.env.CDP_PORT ?? (legacy === undefined ? undefined : process.env[legacy])
  return Number(named ?? base) + (named === undefined ? process.pid % 100 : 0)
}
