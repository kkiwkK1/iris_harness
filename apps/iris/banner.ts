/**
 * The two sentences the host's startup line cannot derive from itself.
 *
 * `bin.ts` boots a composition and prints a URL. Both of the cases here are
 * about the **port**, and both exist because the port is the one piece of
 * configuration that another process can take away.
 *
 * A module of its own, not lines inside `bin.ts`, because `bin.ts` boots on
 * import: there is no way to ask it what it would print. These are pure
 * functions over the two numbers and the error, so a test can.
 *
 * @module @iris/app/banner
 */

/**
 * The line for a configured port that is not the bound one.
 *
 * `port: 0` asks the operating system for any free port, so a bound port that
 * differs from `0` is the request being honoured and not drift — it is the one
 * exemption, and without it every headless test would print a warning about
 * working correctly. An absent configured port is likewise no comparison: the
 * default lives in `cordis.yml` and this bin deliberately does not restate it,
 * because a constant copied into two files is a constant that drifts.
 *
 * **Measured 2026-09-11, and it changes what this line is for.** On this build
 * a taken configured port does *not* let the host start on another one: the
 * carrier's `listen` rejects, `boot` rejects with `EADDRINUSE`, and `bin.ts`
 * never reaches its banner (probed against `apps/iris/cordis.yml`'s own rows
 * with a squatter on the configured port). So the drift this announces is
 * reachable only if the carrier ever gains a fall-back-to-ephemeral behaviour.
 * It is kept as the standing net for that, and {@link describePortInUse} is the
 * half that fires today.
 * @param configured - the port asked for, or undefined when unset.
 * @param bound - the port the carrier actually listened on.
 * @returns the line, or undefined when there is nothing to announce.
 */
export function describePortDrift(configured: number | undefined, bound: number | undefined): string | undefined {
  if (configured === undefined || bound === undefined) return undefined
  if (!Number.isInteger(configured) || configured === 0) return undefined
  if (configured === bound) return undefined
  return `  note:      port ${String(configured)} was configured but ${String(bound)} was bound — `
    + 'something else holds it, and another Iris instance is the likeliest something.'
}

/**
 * The sentence for a boot that died because the port was taken.
 *
 * Without it the person gets a Cordis plugin-tree stack trace naming
 * `@deepseek-ai/dsh-host-webserver`, which says where the failure was raised
 * and nothing about what to do. Upstream prints the equivalent and exits
 * (`src/server-startup.js:238-240`, "Another SillyTavern instance may already
 * be running. Stop the other process or change "port" in config.yaml.").
 *
 * The address is read out of the error rather than out of the environment: the
 * configured port is written in `cordis.yml` as an expression this bin does not
 * evaluate, and the error already carries the exact `host:port` the bind was
 * attempted on. Reading it there is one source instead of two that can disagree.
 *
 * The `code` is looked for down the whole `cause` chain **and** the message is
 * matched, because the boot wraps the original: measured, the outer error
 * carries no `code` at all and only its message names `EADDRINUSE`.
 * @param cause - whatever `boot` rejected with.
 * @returns the sentence, or undefined when this was not a taken port.
 */
export function describePortInUse(cause: unknown): string | undefined {
  const address = addressInUse(cause)
  if (address === undefined) return undefined
  return `iris: ${address} is already in use, so the host did not start. Another Iris instance is `
    + 'the likeliest holder — note that a second host on the **same data directory** is refused '
    + 'separately and for a different reason. Stop that process, or set IRIS_PORT to a free port.'
}

/**
 * The `host:port` an `EADDRINUSE` was raised for, from an error or its causes.
 * @param cause - an error, its wrapper, or anything at all.
 * @returns the address, or undefined when no layer reports a taken address.
 */
function addressInUse(cause: unknown): string | undefined {
  const seen = new Set<unknown>()
  let at: unknown = cause
  while (at !== undefined && at !== null && !seen.has(at)) {
    seen.add(at)
    const layer = at as { code?: unknown, message?: unknown, cause?: unknown }
    const message = typeof layer.message === 'string' ? layer.message : ''
    if (layer.code === 'EADDRINUSE' || message.includes('EADDRINUSE')) {
      // `listen EADDRINUSE: address already in use 127.0.0.1:8787`
      const match = /EADDRINUSE[^\n]*?\s(\S+:\d+)\s*$/mu.exec(message)
      return match?.[1] ?? 'the configured port'
    }
    at = layer.cause
  }
  return undefined
}
