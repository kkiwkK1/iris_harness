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
 * Three properties this must not lose:
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
 *
 * @module iris-web/sandbox/bundle-proxy
 */
import { isAllowedRemote } from './policy.ts'

/**
 * The host's route.
 *
 * A query parameter rather than a path segment, and not a free choice: a URL
 * inside a path needs double encoding and is still rewritten by path
 * normalisation. A mismatch here surfaces as a 404, which `import()` reports as
 * "failed to fetch dynamically imported module" — a sentence that names nothing.
 */
export const BUNDLE_PROXY_PATH = '/iris/script-bundle'

/**
 * Wrap an upstream URL in the host's route.
 * @param url - the URL the card asked for.
 * @param origin - the host's origin.
 * @returns the URL to import instead.
 */
export function toProxied(url: string, origin: string): string {
  return `${origin}${BUNDLE_PROXY_PATH}?url=${encodeURIComponent(url)}`
}

/**
 * Recover the upstream URL from a proxied one.
 *
 * Used wherever a URL is shown or reported, so our routing never appears in
 * something a card author reads.
 * @param url - a possibly-proxied URL.
 * @returns the original, or undefined when this was not proxied.
 */
export function fromProxied(url: string): string | undefined {
  const at = url.indexOf(`${BUNDLE_PROXY_PATH}?url=`)
  if (at === -1) return undefined
  const encoded = url.slice(at + BUNDLE_PROXY_PATH.length + '?url='.length)
  try {
    return decodeURIComponent(encoded)
  } catch {
    // A malformed tail is not an upstream URL, and guessing at one would put a
    // fabricated address in a diagnostic.
    return undefined
  }
}

/**
 * Where each module specifier sits in a piece of source.
 *
 * **Anchored to the `import` and `from` tokens, not to quotes.** The version
 * this replaced took any line whose trimmed start was `import` and then walked
 * *every* quote pair on it — which is the whole program when the module is
 * minified onto one line. Naive pairing then goes wrong at the first quote
 * inside a regex literal or a string with an escaped quote, and the pairing
 * stays shifted for the rest of the line.
 *
 * Measured consequence, before assuming the worst: it is a **missed** rewrite,
 * not corruption. A quote inside a regex shifts the pairing so a later URL is
 * not seen, the specifier goes direct to the CDN, and `script-src` blocks it —
 * which lands in the "nested specifier goes direct" family rather than breaking
 * the source. Corruption needs a regex literal that itself contains a quoted
 * allowlisted URL, which is vanishingly unlikely; the missed rewrite is not.
 *
 * No pattern matching, for the reason this file already records: every escape
 * it could need has been eaten in transit repeatedly in this project, and a
 * collapsed escape still parses while matching nothing.
 * @param source - the module source.
 * @returns each specifier's quote span, in order.
 */
function specifierSpans(source: string): { open: number, close: number }[] {
  const spans: { open: number, close: number }[] = []
  const isWord = (char: string): boolean => /[A-Za-z0-9_$]/u.test(char)

  let at = 0
  while (at < source.length) {
    const keyword = source.startsWith('import', at)
      ? 'import'
      : source.startsWith('from', at) ? 'from' : undefined
    if (keyword === undefined) {
      at += 1
      continue
    }
    // A word boundary on both sides, so `important` and `informant` are not
    // keywords and `x.from` is not either.
    const before = at === 0 ? '' : source[at - 1] ?? ''
    if (before !== '' && (isWord(before) || before === '.')) {
      at += keyword.length
      continue
    }

    let cursor = at + keyword.length
    // Whitespace, and `(` for a dynamic `import(...)`.
    while (cursor < source.length && ' \t\r\n('.includes(source[cursor] ?? '')) cursor += 1
    const quote = source[cursor]
    if (quote !== '"' && quote !== "'") {
      at += keyword.length
      continue
    }

    // The matching close, respecting backslash escapes.
    let end = cursor + 1
    while (end < source.length) {
      const char = source[end]
      if (char === '\\') {
        end += 2
        continue
      }
      if (char === quote) break
      // A specifier cannot span a line; a newline here means this was not one.
      if (char === '\n') break
      end += 1
    }
    if (source[end] !== quote) {
      at += keyword.length
      continue
    }

    spans.push({ open: cursor, close: end })
    at = end + 1
  }
  return spans
}

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
  // Back to front, so an earlier span's offsets are still valid after a later
  // one has been replaced with a longer string.
  const spans = specifierSpans(source).reverse()
  let out = source
  for (const span of spans) {
    const candidate = out.slice(span.open + 1, span.close)
    if (!isAllowedRemote(candidate) || fromProxied(candidate) !== undefined) continue
    out = out.slice(0, span.open + 1) + toProxied(candidate, origin) + out.slice(span.close)
  }
  return out
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
