/**
 * Choosing the transport, and admitting which one was chosen.
 *
 * The choice itself is two lines. The reason this file exists is the failure it
 * is built to prevent, which already happened once: the host served this app,
 * the app ran on the fake client, and an observer checked that the assets loaded
 * and that RPC answered — both green — without ever checking that the *page* was
 * using RPC. Two true statements composed into a false one, and the seeded
 * character names sat on screen next to the real ones for two days without being
 * noticed.
 *
 * So the selection is a pure function with tests, and the result is reported to
 * the interface, which says so on screen whenever the data is not real. "You are
 * looking at invented data" is worth a permanent line; its absence is the normal
 * case and needs no decoration.
 *
 * The decision lives here and the construction lives in `create-client.ts`.
 * The split is not tidiness: this module has no value imports, which is what
 * lets the rule be tested under plain `node --test`. A rule this consequential
 * that could only be exercised by opening a browser is a rule nobody checks.
 *
 * @module iris-web/client/transport
 */

/** Which transport is in use. */
export type Transport = 'rpc' | 'fake'

/**
 * Decide which transport to build.
 *
 * The default is the real one: this is a product that talks to a host, and a
 * default that quietly invents data is how the confusion above happened. The fake
 * is the *development* default only because `vite dev` serves the page from an
 * origin with no host behind it, so the real client would have nothing to talk to
 * and the dev loop would stop working.
 *
 * An explicit `?transport=` wins either way, because both overrides are real
 * workflows: developing against a live host (with Vite proxying the two paths),
 * and opening the host-served build on seeded data to look at the interface
 * without touching a model.
 * @param search - the page's query string.
 * @param dev - whether this is a development build.
 * @returns the transport to construct.
 */
export function chooseTransport(search: string, dev: boolean): Transport {
  const requested = new URLSearchParams(search).get('transport')
  if (requested === 'rpc' || requested === 'fake') return requested
  return dev ? 'fake' : 'rpc'
}
