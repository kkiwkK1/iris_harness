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
  toProxied,
} from '../src/sandbox/bundle-proxy.ts'
import { remoteImports } from '../src/sandbox/script-source.ts'

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
