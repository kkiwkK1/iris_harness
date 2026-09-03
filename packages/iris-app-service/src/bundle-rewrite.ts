/**
 * Nested module specifiers inside a proxied bundle.
 *
 * **The bug this exists for.** The route forwarded jsDelivr's bytes verbatim,
 * and a jsDelivr bundle names its dependencies with **root-relative**
 * specifiers — `from"/npm/vue@3.5.41/+esm"`. A root-relative specifier resolves
 * against the origin of the module that contains it, and that origin is now
 * *ours*, so three dependencies were requested from `127.0.0.1:8787/npm/...`,
 * answered 404, and Chrome reported the whole top-level module as having failed
 * to load. The card's overlay never appeared.
 *
 * Forwarding bytes is therefore not enough: a bundle that is served from a
 * different origin than it was written for has to have its specifiers moved
 * with it.
 *
 * **Every form is resolved against the upstream URL, not against ours.** That
 * is the one base that makes a relative specifier mean what its author meant.
 * The result goes back through the same route, so a dependency of a dependency
 * is proxied on the same terms as the top-level import — including the
 * allowlist, which is why a nested specifier pointing somewhere unlisted is
 * **refused rather than wrapped**: wrapping it would launder a URL through our
 * route that the same route would have refused if a card had asked for it
 * directly.
 *
 * @module @iris/app-service/bundle-rewrite
 */

import { specifierSpans, toProxied } from '@iris/protocol'
import { checkScriptFetch } from '@iris/script'

/** What one rewrite pass did, for the report. */
export interface NestedRewrite {
  /** The source, with every resolvable specifier pointed back at this host. */
  source: string
  /** How many specifiers were rewritten. */
  rewritten: number
  /** Specifiers that resolved somewhere the allowlist does not cover. */
  refused: string[]
  /** Bare specifiers, left alone because nothing here can resolve them. */
  bare: string[]
  /**
   * Spans holding a template placeholder, left alone and **not reported**.
   *
   * Two things land here and neither is worth a line in a log. A genuinely
   * computed specifier cannot be rewritten by anyone — its target is not known
   * until it runs. And the span may not be an import at all: measured on the
   * real `pinia@2.1.7` bundle, the scanner takes the quote pair in
   * ``d(`Global state imported from "${s.name}".`)`` — ordinary prose inside a
   * template literal, where the words `imported from "` are indistinguishable
   * from a real `from "…"`. Calling that a bare specifier would tell a card
   * author their bundle needs an import map, about a sentence.
   */
  dynamic: string[]
}

/**
 * Whether a specifier names a location that can be resolved against a base.
 *
 * **A bare specifier has to be recognised before resolution, not after.**
 * `new URL('vue', 'https://cdn.jsdelivr.net/npm/pinia/+esm')` does not throw —
 * it happily yields `https://cdn.jsdelivr.net/npm/vue`, a URL nobody asked for.
 * Resolving first and catching failures would therefore proxy a fabricated
 * address instead of reporting an unresolvable one.
 * @param specifier - the specifier as written.
 * @returns true when a base can give it a meaning.
 */
function isResolvable(specifier: string): boolean {
  if (specifier.startsWith('/')) return true
  if (specifier.startsWith('./') || specifier.startsWith('../')) return true
  // A scheme, which makes it absolute. Deliberately permissive about which
  // scheme: the allowlist below decides, and it refuses everything but https.
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(specifier)
}

/**
 * Point every nested specifier in a bundle back at this host's route.
 * @param source - the bundle as upstream sent it.
 * @param upstream - the URL the bundle was fetched from, as the resolution base.
 * @returns the rewritten source and what happened to each specifier.
 */
/**
 * Whether a specifier is glued to something else by a `+`.
 *
 * One operand of a concatenated specifier is a fragment of a path, not a path.
 * Measured: the fixed span walker reports `./locale/` for
 * `import('./locale/' + lang + '.js')`, which is correct — that *is* where a
 * specifier begins — and rewriting it would replace the fragment with a proxy
 * URL that the rest of the expression then appends to.
 * @param source - the module source.
 * @param span - the quote span to examine.
 * @returns true when a `+` sits against either quote.
 */
function joinedToNeighbour(source: string, span: { open: number, close: number }): boolean {
  // **No regex here, deliberately.** The first version tested `/\s/u` and reached
  // the file as `/s/u` — an escape collapsed in transit, so it matched the letter
  // `s` and skipped nothing. It type-checked, and the guard silently did nothing.
  const blank = (at: number): boolean => {
    const code = source.charCodeAt(at)
    return code === 32 || code === 9 || code === 10 || code === 13
  }
  let before = span.open - 1
  while (before >= 0 && blank(before)) before -= 1
  let after = span.close + 1
  while (after < source.length && blank(after)) after += 1
  return source[before] === '+' || source[after] === '+'
}

export function rewriteNestedSpecifiers(source: string, upstream: string): NestedRewrite {
  const refused: string[] = []
  const bare: string[] = []
  const dynamic: string[] = []
  let rewritten = 0

  // **Spans rather than `rewriteSpecifiers`, because the decision needs the
  // characters around the quotes.** A specifier that is one operand of a
  // concatenation — `import('./locale/' + lang + '.js')` — is a *fragment*, and
  // rewriting a fragment does not merely miss a dependency, it corrupts the
  // expression that builds one. The specifier text alone cannot show that.
  let out = source
  for (const span of [...specifierSpans(source)].reverse()) {
    const specifier = out.slice(span.open + 1, span.close)
    if (specifier.length === 0) continue

    if (specifier.includes('${') || joinedToNeighbour(out, span)) {
      dynamic.push(specifier)
      continue
    }

    if (!isResolvable(specifier)) {
      // Left exactly as written. It would not have resolved before this route
      // existed either, so rewriting it would invent a dependency rather than
      // preserve one — but it is worth a line, because a bundle that needs an
      // import map is a different problem from a bundle we mis-proxied.
      bare.push(specifier)
      continue
    }

    let resolved: string
    try {
      resolved = new URL(specifier, upstream).href
    } catch {
      bare.push(specifier)
      continue
    }

    const verdict = checkScriptFetch(resolved)
    if (!verdict.allowed) {
      refused.push(resolved)
      continue
    }

    rewritten += 1
    // **Origin-relative on purpose.** The bundle is served from this host, so a
    // root-relative route resolves against us without the body having to name
    // which address we were reached at — the cached copy would otherwise be
    // wrong for every other way in.
    out = out.slice(0, span.open + 1) + toProxied(verdict.url, '') + out.slice(span.close)
  }

  return { source: out, rewritten, refused, bare, dynamic }
}
