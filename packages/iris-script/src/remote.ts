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
 * So the allowance is per-registrable-domain, not per-hostname — and, since
 * 2026-09-11, per *subdomain* of it and not the apex, which is what the CSP
 * grammar on the other half has always meant. A re-count on the same corpus the
 * same day, through the census reader rather than by hand, found 43
 * `testingcf.jsdelivr.net`, 13 `cdn.jsdelivr.net` and 0 apex; the wider
 * plaintext sweep adds two mentions of `fastly.jsdelivr.net` in an extension's
 * changelog, a fourth hostname the original "14 and 1" reading did not name and
 * which this list already covers.
 *
 * @module @iris/script/remote
 */

/**
 * Domains a script may import from.
 *
 * `jsdelivr.net` covers every hostname *under* it, which is the point — and,
 * since 2026-09-11, not the apex itself, because that is what the CSP side's
 * `https://*.jsdelivr.net` has always meant and no card in the corpus asks for
 * it (see {@link checkScriptFetch}).
 * `raw.githubusercontent.com` is exact: `githubusercontent.com` as a suffix
 * would also cover user-content hosts that serve arbitrary uploads.
 *
 * Exported so the drift test can compare **this list** against the `script-src`
 * line in `docs/SANDBOX.md`, rather than against a copy of it written in the test. A
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
    /*
     * A `subdomains` entry admits **only** subdomains, never the apex.
     *
     * Until 2026-09-11 this loop opened with `if (host === entry.suffix)` for
     * *every* entry, so the bare `jsdelivr.net` passed here while the frame's
     * `script-src https://*.jsdelivr.net` — which per the CSP grammar does not
     * match the apex — refused it. One character of drift, in the direction
     * that matters: the host would fetch and cache a bundle the frame could
     * never load, and the card's failure would name neither side.
     *
     * Narrowed here rather than widened on the CSP side because the corpus
     * asked for nothing. Measured 2026-09-11 over 1,888 card, interface, preset
     * and world-book bodies (19 cards, 6 presets, 18 books, read through
     * `scripts/card-surface-census.mjs`'s own reader — a raw grep over the PNGs
     * answers zero for everything, because the card JSON is base64 in a `tEXt`
     * chunk): the apex appears **0** times, against 43 uses of
     * `testingcf.jsdelivr.net` and 13 of `cdn.jsdelivr.net`. `apps/iris-web`'s
     * `isAllowedRemote` already read the list this way, with a comment saying
     * so; this is the half that did not.
     *
     * The dot matters: a bare `endsWith` would also match `evil-jsdelivr.net`.
     */
    if (entry.subdomains) {
      if (host.endsWith(`.${entry.suffix}`)) return { allowed: true, url: url.toString() }
      continue
    }
    // An exact entry is exactly itself. `raw.githubusercontent.com` is served
    // by this branch and by no other, which is why the apex comparison was
    // gated rather than deleted.
    if (host === entry.suffix) return { allowed: true, url: url.toString() }
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
