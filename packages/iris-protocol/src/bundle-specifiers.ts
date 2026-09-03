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
/**
 * Whether a `/` here opens a regex literal rather than dividing.
 *
 * The standard disambiguation, and the only one available without a parser:
 * **what came before decides.** A regex may follow an operator, a comma, an
 * opening bracket, or the start of the source; a division must follow a value —
 * an identifier, a number, a closing bracket or a string. The ambiguous case is
 * a word before the slash, which is a keyword (`return /x/`) or a variable
 * (`a / b`), so the keyword list is checked by name.
 *
 * Wrong in the safe direction when it is wrong: calling a division a regex
 * would skip to the next `/`, which the caller rejects if it is not terminated
 * on this line, and calling a regex a division is where this started.
 * @param source - the module source.
 * @param at - the index of the `/`.
 * @returns true when a regex literal begins here.
 */
function startsRegex(source: string, at: number): boolean {
  let back = at - 1
  while (back >= 0 && ' \t\r\n'.includes(source[back] ?? '')) back -= 1
  if (back < 0) return true
  const previous = source[back] ?? ''
  if ('([{,;:=!&|?+-*/%~^<>'.includes(previous)) return true
  if (!/[A-Za-z0-9_$]/u.test(previous)) return false

  // A word: a keyword can precede a regex, a value cannot.
  let start = back
  while (start >= 0 && /[A-Za-z0-9_$]/u.test(source[start] ?? '')) start -= 1
  const word = source.slice(start + 1, back + 1)
  return [
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'case', 'do', 'else', 'yield', 'await', 'throw',
  ].includes(word)
}

/**
 * Where the regex literal starting here ends, flags included.
 *
 * @param source - the module source.
 * @param at - the index of the opening `/`.
 * @returns the index just past the literal, or undefined when it is not
 *   terminated on this line — in which case the `/` was division after all.
 */
function regexEnd(source: string, at: number): number | undefined {
  let cursor = at + 1
  let inClass = false
  while (cursor < source.length) {
    const char = source[cursor]
    if (char === '\\') {
      cursor += 2
      continue
    }
    /*
     * A character class matters because `/` inside one needs no escape —
     * `/[/]/` is a valid regex matching a slash — so a scan that ignored
     * classes would end the literal early and read the rest of the pattern as
     * code.
     */
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) {
      cursor += 1
      // Flags, so `/x/gi` does not leave `gi` to be read as an identifier.
      while (cursor < source.length && /[a-z]/u.test(source[cursor] ?? '')) cursor += 1
      return cursor
    } else if (char === '\n') {
      // A regex literal cannot span lines, so this was division.
      return undefined
    }
    cursor += 1
  }
  return undefined
}

/**
 * Skip a string, template or comment that starts here.
 *
 * Deliberately narrow: it answers "does something that is not code begin at
 * this index, and where does it end", and nothing else. A specifier's own quote
 * is never reached through this function — the walk consults it *before*
 * looking for a keyword, so by the time a specifier's quote is read, the
 * keyword in front of it has already been accepted.
 *
 * A template literal is skipped **whole**, `${…}` included. A specifier cannot
 * live inside a template's substitution: a dynamic `import(`…`)` with a
 * template argument uses a backtick, and this walk only accepts `"` and `'`, so
 * nothing is lost by not descending. What *is* gained is that prose containing
 * `from "…"` inside a template stops producing spans.
 *
 * An unterminated string or comment consumes the rest of the source, which is
 * the correct reading of a truncated file: everything after an unclosed quote
 * is inside it.
 * @param source - the module source.
 * @param at - the index to test.
 * @returns the index just past the skipped run, or undefined when code begins
 *   here.
 */
function skipNonCode(source: string, at: number): number | undefined {
  const char = source[at]

  if (char === '/' && source[at + 1] === '/') {
    const end = source.indexOf('\n', at + 2)
    return end === -1 ? source.length : end + 1
  }
  if (char === '/' && source[at + 1] === '*') {
    const end = source.indexOf('*/', at + 2)
    return end === -1 ? source.length : end + 2
  }
  /*
   * **A regex literal, and skipping it is not optional any more.**
   *
   * Before strings were skipped at all, a token-anchored walk stepped over
   * `/["]/g` without noticing: it was looking for `import` and `from`, and a
   * quote inside a regex was just a character. Skipping strings changed that —
   * the walk now *stops* at that quote, treats it as a string opener, and runs
   * forward to the next `"` in the file, which is the opening quote of the very
   * next specifier. So the regex swallows the import after it.
   *
   * That is a **regression against the previous design**, not a pre-existing
   * gap, which is why the heuristic below is worth its weight: skipping strings
   * without also recognising regexes is worse than doing neither.
   */
  if (char === '/' && startsRegex(source, at)) {
    const end = regexEnd(source, at)
    if (end !== undefined) return end
    // Not a terminated regex after all, so the `/` was division. Fall through.
  }
  if (char !== '"' && char !== "'" && char !== '`') return undefined

  let cursor = at + 1
  while (cursor < source.length) {
    const inner = source[cursor]
    if (inner === '\\') {
      cursor += 2
      continue
    }
    if (inner === char) return cursor + 1
    /*
     * A `"` or `'` string cannot span a line, so a newline ends the run and the
     * quote was not a string opener after all. Returning the position after the
     * newline keeps the walk moving and lets the next line be read as code —
     * the alternative, treating the rest of the file as a string, would hide
     * every real import below a stray apostrophe in a comment-free file.
     */
    if (inner === '\n' && char !== '`') return cursor + 1
    cursor += 1
  }
  return source.length
}

export function specifierSpans(source: string): { open: number, close: number }[] {
  const spans: { open: number, close: number }[] = []
  const isWord = (char: string): boolean => /[A-Za-z0-9_$]/u.test(char)

  let at = 0
  while (at < source.length) {
    /*
     * **A keyword inside a string or a comment is prose, not a keyword.**
     *
     * Measured on the real pinia bundle: a template literal containing
     * `` `imported from "${s.name}"` `` made `from` look like a keyword, and the
     * walk then paired the quote before `${` with the quote after `}` and
     * emitted `${s.name}` as a specifier. Harmless in the browser — it is not
     * an allowed remote, so nothing rewrites it — and **not** harmless in the
     * host, which resolves every specifier against the upstream URL and
     * re-wraps it, so a span over real code becomes corrupted source.
     *
     * So the scan skips string, template and comment bodies. Regex literals are
     * deliberately *not* handled: telling `/` as division from `/` as a regex
     * needs the preceding token's grammar, and this file's own note records
     * where that lands — a stray quote in a regex makes a later specifier
     * invisible, which is a **missed rewrite** (the import goes direct and CSP
     * refuses it) rather than damage to what the card runs.
     */
    const skipped = skipNonCode(source, at)
    if (skipped !== undefined) {
      at = skipped
      continue
    }

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

    /*
     * **`from` must follow an import or export clause.** Measured on three real
     * bundles served by the host — mathjs, typed-function and MagVarUpdate's
     * `bundle.js` — which between them produced 32 false spans, every one of
     * them one of two shapes: `from` as an element of a string array
     * (`["from","…"]`) or `from` pressed against the closing quote of a
     * concatenation (`'"'+h+'"'`).
     *
     * The token before `from` in a real import is the end of its clause — `}`
     * for named bindings, an identifier for a default or a namespace alias, `*`
     * for `export*from` — and never a quote, a comma or a bracket. A **bare**
     * `from` is prose.
     *
     * **Measured honestly: on those four real bundles this rule catches
     * nothing that the string skip has not already caught** (23 false spans
     * before either guard, 0 with the skip alone). Keeping it is not
     * belt-and-braces, because there is one context the skip structurally
     * cannot reach — a **regex literal**, which needs the preceding token's
     * grammar to recognise. `const re = /from"/;const after = "tail";` yields
     * the span `/;const after = ` without this rule and nothing with it, and
     * that span is over live code, which is the damaging kind.
     *
     * So: the skip does the work on real bundles, and this covers part of the
     * hole the skip's own doc admits. That split is worth stating, or the next
     * reader has no way to tell which of the two is earning its place.
     *
     * `import` needs no such test: it opens a statement, so there is nothing in
     * front of it to constrain, and a bare `import "./x"` is a real form.
     */
    if (keyword === 'from') {
      let back = at - 1
      while (back >= 0 && ' \t\r\n'.includes(source[back] ?? '')) back -= 1
      const previous = back < 0 ? '' : source[back] ?? ''
      if (!(previous === '}' || previous === '*' || isWord(previous))) {
        at += keyword.length
        continue
      }
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

    /*
     * A second guard on the same failure, and it is not redundant with the
     * context skip above: `${` inside a `"`-quoted span means the quote pairing
     * went wrong, whatever route led there. A real specifier cannot contain it
     * — a template-literal specifier is backtick-quoted and this walk never
     * accepts a backtick — so this can only ever reject a false positive, and
     * the cost of the one it catches is corrupted source in the host.
     */
    if (source.slice(cursor + 1, end).includes('${')) {
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
