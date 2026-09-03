/**
 * Routing a card's remote imports through the host's bundle proxy.
 *
 * Every chat opens a frame in a **fresh opaque origin**, and HTTP caching is
 * partitioned by origin — so a card's bundle is a cold fetch every single time.
 * Measured: 307 KB across two mirrors at 9–12 seconds, four timeouts in six
 * openings. Upstream never pays this because its script frames are same-origin
 * with the page and share its cache; ours structurally cannot.
 *
 * The host can, so the host fetches and caches it, and the frame asks the host.
 *
 * Four properties this must not lose:
 *
 * - **Rewriting must not widen what a card can reach.** Only URLs that would
 *   already have been allowed are rewritten. Anything else is left exactly as
 *   written so the frame's CSP refuses it the way it does today — rewriting an
 *   unreachable URL into a same-origin one would turn a refusal into a request.
 * - **Diagnostics name the real resource.** A reader of a stalled import cares
 *   about the bundle, not about our routing, so anything reported unwraps back
 *   to the URL the card asked for.
 * - **The allowlist here is advice.** The host enforces with its own list and
 *   refuses again regardless; this one exists so a card is not rewritten into a
 *   round trip that was never going to be served.
 * - **Rewriting moves the module's base URL, so the host must rewrite the
 *   bodies it serves.** This is the fourth property and it was missing from
 *   this list, which cost one card its whole interface. A jsDelivr `+esm`
 *   bundle imports its own dependencies with **root-relative** specifiers —
 *   `import{…}from"/npm/vue@3.5.41/+esm"` — which resolve against whatever
 *   origin served the module. Served from jsDelivr they are correct; served
 *   from us they resolve to `http://our-host/npm/vue@3.5.41/+esm`, which is a
 *   404 (measured: all three of pinia's nested specifiers). The browser then
 *   reports `Failed to fetch dynamically imported module: blob:null/…` — naming
 *   the card's own top-level blob, not the dependency — so the card looks
 *   broken and the proxy looks innocent.
 *
 *   Nothing on this side can fix it: root-relative resolution ignores the
 *   proxy's path, and the frame cannot fetch the upstream itself
 *   (`connect-src 'none'` without a grant). The host has to resolve each nested
 *   specifier against the **upstream** URL and re-wrap it in this same route,
 *   which also keeps the whole dependency tree cached and keeps `script-src`
 *   at nothing but our own origin.
 *
 *   Why it looks like it works: a self-contained bundle has no nested
 *   specifiers, so the proxy is correct for those — MagVarUpdate's two mirrors
 *   are exactly that, and they went on loading while the one bundle with a
 *   dependency died.
 *
 * @module iris-web/sandbox/bundle-proxy
 */
/*
 * **A relative path, not `@iris/protocol`, and the reason is a constraint.**
 *
 * Every other reference to the contract in this app is `import type`, which is
 * erased — so the package has never needed to resolve at *runtime*, and it does
 * not: `apps/iris-web/node_modules/@iris/` links `client-fake` and
 * `compat-tavernhelper-core` and nothing else. `tsc` resolves the bare name
 * through `tsconfig`'s `paths`; `node --test` does not, and the suite fails to
 * load with `ERR_MODULE_NOT_FOUND` the moment a value is imported from there.
 *
 * The fix is not a link in shared `node_modules`: adding to a dependency tree
 * three sessions share is the class of change that has already cost this
 * project a peer's package once. This path costs one ugly line in one file.
 *
 * It also reaches the module **directly** rather than through the package
 * index, which matters beyond tidiness: the index pulls in `rpc.ts` and its
 * `zod` dependency, and this module has none.
 */
import {
  BUNDLE_PROXY_PATH,
  fromProxied,
  rewriteSpecifiers,
  specifierSpans,
  toProxied,
} from '../../../../packages/iris-protocol/src/bundle-specifiers.ts'

import { isAllowedRemote } from './policy.ts'

/*
 * Re-exported so this module stays the app's one door to the bundle route.
 *
 * Every call site in the app already imports from here, and the point of moving
 * the implementation was to have **one** implementation — not to send half the
 * app to a second import path for the same three names.
 */
export { BUNDLE_PROXY_PATH, fromProxied, toProxied }

/**
 * Every module specifier in a piece of source.
 *
 * Shared with `script-source.ts`, which used to do its own naive quote walk for
 * the read-only census. That one only mis-*reported*, so it was the cheaper bug
 * — but two scanners for one question is how they come to disagree about which
 * imports a card has.
 * @param source - the module source.
 * @returns the specifiers, in order, with duplicates kept.
 */
export function moduleSpecifiers(source: string): string[] {
  return specifierSpans(source).map(span => source.slice(span.open + 1, span.close))
}

/**
 * Point a card's allowed remote imports at the host.
 *
 * Replaced **within the specifier only**. A blanket replacement across the
 * whole source would also rewrite the URL where a card merely *mentions* it —
 * in a string it displays, say — and changing text a card shows is not this
 * function's business.
 * @param source - the card's module source.
 * @param origin - the host's origin.
 * @returns the source with allowed remote imports routed through the host.
 */
export function rewriteBundleImports(source: string, origin: string): string {
  return rewriteSpecifiers(source, specifier => (
    /*
     * The **policy** stays here and the walk does not. Which specifiers may be
     * rewritten is this app's decision — only URLs that would already have been
     * allowed, so a refusal never becomes a request — while *finding* them is a
     * parser both halves need to agree on, and it now lives in the contract.
     *
     * A specifier that is already proxied is left alone: rewriting it again
     * would nest one route inside another and the upstream URL would be
     * recoverable only by unwrapping twice.
     */
    isAllowedRemote(specifier) && fromProxied(specifier) === undefined
      ? toProxied(specifier, origin)
      : undefined
  ))
}

/**
 * Ask the host why a proxied bundle failed.
 *
 * The reason exists as `x-iris-reason` on the failed response, and the frame can
 * never read it: a failed `import()` does not hand the response to the caller,
 * and even a deliberate re-fetch from the frame is cross-origin against an
 * opaque origin, where that header is not on the CORS safelist. It is a
 * diagnostic sitting where its only reader cannot go.
 *
 * The shell is same-origin with the host, so it can simply ask — no header
 * exposure, no lying about status codes to smuggle the reason through a body.
 * The host keeps a failed reason for a short window, so this second request
 * answers from memory rather than repeating the fetch that just failed.
 *
 * @param url - the upstream URL the card asked for.
 * @param origin - the host's origin.
 * @param request - how to fetch, injected so this is testable without a network.
 * @returns the host's stated reason, or undefined when there is none to be had.
 */
export async function bundleFailureReason(
  url: string,
  origin: string,
  request: (input: string) => Promise<{ ok: boolean, headers: { get: (name: string) => string | null } }>,
): Promise<string | undefined> {
  if (!isAllowedRemote(url)) return undefined
  let response: { ok: boolean, headers: { get: (name: string) => string | null } }
  try {
    response = await request(toProxied(url, origin))
  } catch {
    // The explanation failing is not itself worth reporting: the caller already
    // has a failure to show, and a second one about our attempt to explain the
    // first would bury it.
    return undefined
  }
  if (response.ok) return undefined
  const raw = response.headers.get('x-iris-reason')
  if (raw === null || raw === '') return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    // Percent-encoded by the host; an undecodable value is shown as sent rather
    // than dropped, because a mangled reason still names something.
    return raw
  }
}
