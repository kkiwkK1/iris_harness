/**
 * Routing a card's remote imports through the host.
 *
 * The property that matters most here is a negative one: rewriting must not let
 * a card reach anything it could not reach before. A URL the frame's CSP would
 * refuse must stay refused, and turning it into a same-origin request — which
 * CSP allows — would convert a blocked fetch into a served one, with only the
 * host's own allowlist left standing between a card and an arbitrary URL.
 *
 * @module iris-web/tests/bundle-proxy
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  BUNDLE_PROXY_PATH,
  bundleFailureReason,
  fromProxied,
  rewriteBundleImports,
  moduleSpecifiers,
  toProxied,
} from '../src/sandbox/bundle-proxy.ts'
import { remoteImports, requestedImports } from '../src/sandbox/script-source.ts'
import { describeAttempts } from '../src/sandbox/import-attempts.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ORIGIN = 'http://127.0.0.1:8787'
const BUNDLE = 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js'

test('an allowed import is routed through the host', () => {
  const source = rewriteBundleImports(`import '${BUNDLE}';`, ORIGIN)

  assert.ok(source.includes(`${ORIGIN}${BUNDLE_PROXY_PATH}?url=`))
  assert.ok(source.includes(encodeURIComponent(BUNDLE)), 'the upstream URL is carried encoded')
  assert.equal(source.startsWith('import '), true, 'the statement keeps its shape')
})

test('a URL the frame could not reach anyway is left exactly as written', () => {
  /*
   * The rewrite must not widen capability. `evil.example` is refused today by
   * the frame's CSP and never leaves the browser; routing it through a
   * same-origin path would make the request happen and leave only the host's
   * allowlist between a card and an arbitrary URL. Left alone, it fails where it
   * failed before.
   */
  const source = `import 'https://evil.example/x.js';`

  assert.equal(rewriteBundleImports(source, ORIGIN), source)
})

test('a host that merely ends with an allowed name is not allowed', () => {
  // The near-miss a suffix check would wave through. `jsdelivr.net.evil.example`
  // is not a jsdelivr subdomain, and rewriting it would hand the host a URL it
  // is then obliged to refuse.
  const source = `import 'https://jsdelivr.net.evil.example/x.js';`

  assert.equal(rewriteBundleImports(source, ORIGIN), source)
})

test('a line that is not an import is untouched, even if it names the URL', () => {
  /*
   * A card that displays or logs the URL is showing text, and rewriting text a
   * card shows is not this function's business — it would put our routing in
   * front of a reader who asked about the bundle.
   */
  const source = `const where = '${BUNDLE}';\nconsole.log(where);`

  assert.equal(rewriteBundleImports(source, ORIGIN), source)
})

test('rewriting twice does not nest', () => {
  // The pipeline runs once today; a second pass must not wrap the proxy URL in
  // another proxy URL, which would reach the host asking for itself.
  const once = rewriteBundleImports(`import '${BUNDLE}';`, ORIGIN)

  assert.equal(rewriteBundleImports(once, ORIGIN), once)
})

test('diagnostics name the bundle, not our routing', () => {
  /*
   * A stalled import is read by someone who wants to know which bundle is
   * missing. Reporting the proxy URL would answer a question nobody asked and
   * point them at our own host.
   */
  const rewritten = rewriteBundleImports(`import '${BUNDLE}';`, ORIGIN)

  assert.deepEqual(remoteImports(rewritten), [BUNDLE])
})

test('a proxied URL round-trips, and a plain one is recognised as not proxied', () => {
  assert.equal(fromProxied(toProxied(BUNDLE, ORIGIN)), BUNDLE)
  assert.equal(fromProxied(BUNDLE), undefined)
})

test('a malformed proxy tail yields nothing rather than a guess', () => {
  // Better no URL than an invented one in a diagnostic.
  assert.equal(fromProxied(`${ORIGIN}${BUNDLE_PROXY_PATH}?url=%E0%A4%A`), undefined)
})

test('several imports on separate lines are each handled on their merits', () => {
  const source = [
    `import '${BUNDLE}';`,
    `import 'https://evil.example/x.js';`,
    `import './local.js';`,
  ].join('\n')
  const out = rewriteBundleImports(source, ORIGIN).split('\n')

  assert.ok(out[0]?.includes(BUNDLE_PROXY_PATH))
  assert.equal(out[1], `import 'https://evil.example/x.js';`)
  assert.equal(out[2], `import './local.js';`)
})

/** A stand-in for the host's answer. */
const answering = (ok: boolean, reason?: string) => async () => ({
  ok,
  headers: { get: (name: string) => (name === 'x-iris-reason' && reason !== undefined ? reason : null) },
})

test('the shell can read the reason the frame structurally cannot', async () => {
  /*
   * `x-iris-reason` is unreachable from the frame twice over: a failed
   * `import()` never hands over the response, and a deliberate re-fetch from an
   * opaque origin is cross-origin, where that header is not on the CORS
   * safelist. The shell is same-origin with the host, so it just asks — which is
   * why the host does not have to lie about its status code to smuggle the
   * reason through a body.
   */
  const reason = await bundleFailureReason(
    BUNDLE,
    ORIGIN,
    answering(false, encodeURIComponent('403: host not on the allowlist')),
  )

  assert.equal(reason, '403: host not on the allowlist')
})

test('a successful answer has no reason to report', async () => {
  assert.equal(await bundleFailureReason(BUNDLE, ORIGIN, answering(true)), undefined)
})

test('asking about a URL the host would never serve is not asked at all', async () => {
  // No round trip for a URL that was never rewritten: it failed in the frame,
  // and the host has nothing to say about a request it never received.
  let asked = 0
  await bundleFailureReason('https://evil.example/x.js', ORIGIN, async () => {
    asked += 1
    return answering(false, 'x')()
  })

  assert.equal(asked, 0)
})

test('an explanation that itself fails stays quiet', async () => {
  /*
   * The caller already has a failure to show. A second error about our attempt
   * to explain the first would bury the one the reader needs.
   */
  const reason = await bundleFailureReason(BUNDLE, ORIGIN, async () => {
    throw new Error('offline')
  })

  assert.equal(reason, undefined)
})

test('a rewritten import is named to the reader but checked by what was requested', () => {
  /*
   * The pairing that broke, pinned as a pair.
   *
   * `remoteImports` unwraps a proxied URL back to the card's own, which is right
   * for the sentence a person reads and wrong for the lookup against resource
   * timing — the browser only ever records what it actually fetched. Both
   * callers were fed the unwrapped list, so the lookup asked for a name that
   * could not exist and answered "never sent" no matter what happened.
   */
  const rewritten = rewriteBundleImports(`import '${BUNDLE}';`, ORIGIN)

  assert.deepEqual(remoteImports(rewritten), [BUNDLE], 'the reader should see the card\u2019s URL')

  const requested = requestedImports(rewritten)
  assert.equal(requested.length, 1)
  assert.ok(
    requested[0]?.startsWith(ORIGIN),
    'the check should use the proxy URL, which is what the browser fetches',
  )
  assert.notEqual(requested[0], BUNDLE)
})

test('a proxied import that WAS fetched is reported as sent, not as refused', () => {
  /*
   * The assertion the old arrangement could never pass. This is the regression
   * itself: a healthy, cache-warm proxy fetch was being reported as "refused or
   * unresolvable before the wire", which sent a reader to look at CSP and DNS
   * for a request the browser had made and completed.
   */
  const rewritten = rewriteBundleImports(`import '${BUNDLE}';`, ORIGIN)
  const requested = requestedImports(rewritten)
  const timing = [{ name: requested[0] ?? '' }]

  const verdict = describeAttempts(requested, timing)
  assert.ok(verdict.includes('did send'), `expected a sent verdict, got: ${verdict}`)

  // And the old way round still produces the false answer, which is what makes
  // this test meaningful rather than decorative.
  const wrong = describeAttempts(remoteImports(rewritten), timing)
  assert.ok(wrong.includes('never sent'))
})

test('the frame checks timing against the requested URL, not the displayed one', () => {
  /*
   * A wiring pin, because the wiring is what broke and nothing else covers it.
   *
   * Everything above proves the two lists differ and that using the wrong one
   * produces the wrong verdict. None of it notices if the frame goes back to
   * passing the display list — that call sits in the browser entry, which has no
   * unit harness, and the failure it produces is a *confident wrong answer*
   * rather than a crash. That is the shape most likely to survive another
   * refactor unnoticed, so it gets an explicit guard.
   */
  const here = dirname(fileURLToPath(import.meta.url))
  const entry = readFileSync(join(here, '..', 'src', 'sandbox', 'frame-entry.ts'), 'utf8')

  assert.ok(
    entry.includes('describeAttempts(requested'),
    'the stalled-import check is not using the requested URLs, so its verdict is unfalsifiable again',
  )
})
test('a minified module is rewritten by specifier, not by counting quotes', () => {
  /*
   * **The shape the previous scanner got wrong.** It took any line whose trimmed
   * start was `import` and walked *every* quote pair on it — which is the whole
   * program when a module is minified onto one line. A quote inside a regex
   * literal shifts the pairing, and it stays shifted for the rest of the line,
   * so a later specifier is never seen: it goes direct to the CDN and
   * `script-src` blocks it. Silently, from the card's point of view.
   *
   * Measured before assuming the worst: the consequence is a **missed** rewrite,
   * not a corrupted source. That is why this is a correctness test about which
   * specifiers were found, not a test that the output still parses.
   */
  const source = 'import a from "https://cdn.jsdelivr.net/npm/a";'
    + 'const re=/["]/g;'
    + 'const b=await import("https://cdn.jsdelivr.net/npm/b");'
  const out = rewriteBundleImports(source, 'http://host')

  assert.equal(out.includes('"https://cdn.jsdelivr.net/npm/a"'), false, 'the first was missed')
  assert.equal(out.includes('"https://cdn.jsdelivr.net/npm/b"'), false, 'the second was missed')
  // The regex is untouched: it is not a specifier, and rewriting inside one
  // would change the pattern the card matches with.
  assert.ok(out.includes('/["]/g'), 'the regex literal was altered')
})

test('a URL a card merely mentions is left alone', () => {
  // Replacing it would change text the card displays, which is not this
  // function's business — and the anchor is what makes the distinction possible.
  const source = 'const shown = "https://cdn.jsdelivr.net/npm/a";'
  assert.equal(rewriteBundleImports(source, 'http://host'), source)
})

test('the keyword must be a word, not a suffix', () => {
  // `important`, `informant`, `x.from` — three ways a naive `indexOf` finds a
  // keyword that is not one.
  const source = 'const important = "https://cdn.jsdelivr.net/npm/a";'
    + 'const y = x.from("https://cdn.jsdelivr.net/npm/b");'
  assert.equal(rewriteBundleImports(source, 'http://host'), source)
})

test('an escaped quote inside a specifier does not end it', () => {
  // Pathological but cheap to be right about: the close quote is found by
  // respecting backslashes rather than by taking the next quote character.
  assert.deepEqual(
    moduleSpecifiers('import a from "https://cdn.jsdelivr.net/npm/a\\"x"'),
    ['https://cdn.jsdelivr.net/npm/a\\"x'],
  )
})

test('every import spelling is found', () => {
  const source = [
    'import "a"',
    "import b from 'b'",
    'import * as c from "c"',
    'const d = await import("d")',
    'export { e } from "e"',
  ].join(';')
  assert.deepEqual(moduleSpecifiers(source), ['a', 'b', 'c', 'd', 'e'])
})
test('a root-relative specifier is left alone, which is why the host must rewrite bodies', () => {
  /*
   * **The shape that cost one card its whole interface**, pinned here because
   * the frame's half is correct and looks like the whole story.
   *
   * A jsDelivr `+esm` bundle imports its own dependencies root-relatively:
   * `import{…}from"/npm/vue@3.5.41/+esm"`. This function leaves those exactly
   * as written — correct, since a root-relative URL is not an allowed remote
   * and rewriting it would invent a request. But the *consequence* is that once
   * we serve that bundle from our own origin, the browser resolves them against
   * **us**: measured, all three of pinia's nested specifiers are 404 on our
   * host, and the failure surfaces as `Failed to fetch dynamically imported
   * module: blob:null/…` — naming the card's top-level blob rather than the
   * dependency.
   *
   * So this assertion is not "the rewriter handles it". It is the opposite: the
   * rewriter cannot, and the host must rewrite the bodies it serves. If someone
   * later makes this function rewrite them, this test should fail and be read
   * before it is updated — a root-relative specifier rewritten here points at a
   * bundle the card never asked for.
   */
  const nested = 'import{x}from"/npm/vue@3.5.41/+esm";import"/npm/side/+esm";'
  assert.equal(rewriteBundleImports(nested, ORIGIN), nested)
})

test('an absolute allowed remote is still rewritten, minified or not', () => {
  // The real card's first line is minified with no space after `from`, which is
  // the form a whitespace-anchored pattern would miss entirely.
  const minified = "import{createPinia as e}from'https://testingcf.jsdelivr.net/npm/pinia/+esm';"
  const out = rewriteBundleImports(minified, ORIGIN)
  assert.match(out, /\/iris\/script-bundle\?url=https%3A%2F%2Ftestingcf\.jsdelivr\.net/)
  assert.ok(out.startsWith("import{createPinia as e}from'"), out.slice(0, 40))
})
