/**
 * Which hosts a card script may fetch code from.
 *
 * Card scripts import from CDNs — MVU's own installation instructions tell the
 * user to import a bundle from jsDelivr — so refusing every remote import means
 * refusing the ecosystem. The answer is a whitelist, and the shape of it was
 * settled by measurement rather than by picking the well-known hostname:
 * across the local corpus's 15 remote imports, **14 use `testingcf.jsdelivr.net`
 * and one uses `cdn.jsdelivr.net`**. Tavern Helper's own injected jQuery and Vue
 * also come from `testingcf`. Allowing only the hostnames a person would think
 * of first would have failed 14 of 15 real imports.
 *
 * So the allowance is per-registrable-domain, not per-hostname.
 *
 * @module @iris/script/remote
 */

/**
 * Domains a script may import from.
 *
 * `jsdelivr.net` covers every hostname it serves under, which is the point.
 * `raw.githubusercontent.com` is exact: `githubusercontent.com` as a suffix
 * would also cover user-content hosts that serve arbitrary uploads.
 *
 * Exported so the drift test can compare **this list** against the `script-src`
 * line in `SANDBOX.md`, rather than against a copy of it written in the test. A
 * test holding its own literal pins the document to the test and leaves the code
 * free: widening this array would then change what the host fetches while every
 * assertion stayed green, which is the one direction that matters.
 */
export const ALLOWED = [
  { suffix: 'jsdelivr.net', subdomains: true },
  { suffix: 'raw.githubusercontent.com', subdomains: false },
] as const

/** Why a fetch was refused, or that it was allowed. */
export type FetchVerdict =
  | { allowed: true, url: string }
  | { allowed: false, reason: string }

/**
 * Decide whether a script may fetch a URL.
 *
 * Refusals name the host. A card that fails to load a dependency has to be
 * diagnosable by the person holding the card, and "blocked" without a host is
 * indistinguishable from a network fault.
 * @param input - the URL the script asked for.
 * @returns the verdict, with the normalized URL when allowed.
 */
export function checkScriptFetch(input: string): FetchVerdict {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { allowed: false, reason: `not a URL: ${input.slice(0, 120)}` }
  }

  // Only https. `http:` is refused rather than upgraded: silently rewriting a
  // request means the script gets code from a URL it did not name, and on this
  // path that code is about to be executed.
  if (url.protocol !== 'https:') {
    return { allowed: false, reason: `only https is allowed, not ${url.protocol}` }
  }

  const host = url.hostname.toLowerCase()
  for (const entry of ALLOWED) {
    if (host === entry.suffix) return { allowed: true, url: url.toString() }
    // The dot matters: a bare `endsWith` would also match `evil-jsdelivr.net`.
    if (entry.subdomains && host.endsWith(`.${entry.suffix}`)) return { allowed: true, url: url.toString() }
  }

  return {
    allowed: false,
    reason: `${host} is not an allowed script source (allowed: ${ALLOWED.map(e => e.subdomains ? `*.${e.suffix}` : e.suffix).join(', ')})`,
  }
}

/** The whitelist, for display in a settings pane. */
export function allowedScriptSources(): string[] {
  return ALLOWED.map(entry => entry.subdomains ? `*.${entry.suffix}` : entry.suffix)
}
