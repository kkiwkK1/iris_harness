/**
 * Module specifiers, and the host's bundle route they can be rewritten onto.
 *
 * **Here rather than in either half, because both halves must rewrite and they
 * must agree.** The browser rewrites a card's own imports so the host can fetch
 * and cache them — every chat opens a frame in a fresh opaque origin and HTTP
 * caching is partitioned by origin, so a card's bundle is otherwise a cold
 * fetch every single time (measured: 307 KB across two mirrors at 9–12 seconds,
 * four timeouts in six openings). And the **host** must rewrite the bodies it
 * serves, for a reason that cost one card its whole interface:
 *
 * Rewriting moves a module's base URL. A jsDelivr `+esm` bundle imports its own
 * dependencies with **root-relative** specifiers — `import{…}from
 * "/npm/vue@3.5.41/+esm"` — which resolve against whatever origin served the
 * module. Served from jsDelivr they are correct; served from us they resolve to
 * `http://our-host/npm/vue@3.5.41/+esm`, which is a 404. The browser then
 * reports `Failed to fetch dynamically imported module: blob:null/…`, naming the
 * card's own top-level blob rather than the dependency, so the card looks broken
 * and the proxy looks innocent.
 *
 * The **discriminating** part of that, worth stating because it decided how long
 * the diagnosis took: a self-contained bundle has no nested specifiers, so the
 * proxy is perfectly correct for those. MagVarUpdate's two mirrors are exactly
 * that and went on loading while the one bundle with a dependency died — the
 * visible surface was biased towards the samples that could not show the bug.
 *
 * So there is one specifier walker and one route encoder, and neither side owns
 * them. What differs between the two sides is only **what a specifier should
 * become**, which is why `rewriteSpecifiers` takes that as a function.
 *
 * @module @iris/protocol/bundle-specifiers
 */

/**
 * The host's bundle route.
 *
 * A query parameter rather than a path segment, and not a free choice: a URL
 * inside a path needs double encoding and is still rewritten by path
 * normalisation. A mismatch surfaces as a 404, which `import()` reports as
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
 * @param url - a URL that may be one of ours.
 * @returns the upstream URL, or undefined when this is not a proxied URL.
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
 * No pattern matching, for the reason both halves already record: every escape
 * it could need has been eaten in transit repeatedly in this project, and a
 * collapsed escape still parses while matching nothing.
 * @param source - the module source.
 * @returns each specifier's quote span, in order.
 */
export function specifierSpans(source: string): { open: number, close: number }[] {
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
 * Rewrite every module specifier a piece of source contains.
 *
 * The walk and the replacement are separated because the two callers want
 * different replacements and the same walk:
 *
 * - the **browser** rewrites a card's already-allowed remote imports onto the
 *   host's route, and leaves everything else exactly as written so the frame's
 *   CSP refuses it the way it does today — rewriting an unreachable URL into a
 *   same-origin one would turn a refusal into a request;
 * - the **host** rewrites the specifiers inside a body it is about to serve,
 *   resolving each against the **upstream** URL first, so a root-relative
 *   dependency keeps pointing at the CDN it came from rather than at us.
 *
 * Replaced within the specifier only, and back to front so an earlier span's
 * offsets are still valid after a later one has become a longer string. A
 * blanket replacement across the whole source would also rewrite a URL a card
 * merely *mentions* — in a string it displays, say — and changing text a card
 * shows is not this function's business.
 *
 * @param source - the module source.
 * @param replace - what one specifier should become. Return the specifier
 *   unchanged (or anything falsy) to leave it exactly as written.
 * @returns the source with each specifier replaced.
 */
export function rewriteSpecifiers(
  source: string,
  replace: (specifier: string) => string | undefined,
): string {
  const spans = specifierSpans(source).reverse()
  let out = source
  for (const span of spans) {
    const specifier = out.slice(span.open + 1, span.close)
    const next = replace(specifier)
    if (next === undefined || next === specifier) continue
    out = out.slice(0, span.open + 1) + next + out.slice(span.close)
  }
  return out
}
