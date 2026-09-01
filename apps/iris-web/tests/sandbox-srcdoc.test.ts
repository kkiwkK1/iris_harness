import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildSrcdoc, framePolicy } from '../src/sandbox/srcdoc.ts'

/** Iris's own origin, as the runner supplies it. */
const SELF = 'http://127.0.0.1:5173'

test('the frame policy allows eval and pins where code comes from', () => {
  // The distinction SANDBOX.md now draws: CSP cannot forbid `eval` here, because
  // the card blobs are webpack output that evals per module. Restricting the
  // ORIGIN of code is a separate capability and it is fully available.
  const policy = framePolicy(false, SELF)

  assert.match(policy, /script-src[^;]*'unsafe-eval'/, 'the webpack blobs would not run')
  assert.match(policy, /script-src[^;]*https:\/\/\*\.jsdelivr\.net/)
  assert.match(policy, /script-src[^;]*https:\/\/raw\.githubusercontent\.com/)
  assert.doesNotMatch(policy, /script-src[^;]*https:(?!\/\/)/, 'script-src must not admit all of https')
})

test('blob: scripts are allowed, because the injection layer arrives that way', () => {
  // Measured in a live network trace: Tavern Helper delivers `predefine`,
  // `adjust_iframe_height` and `adjust_viewport` as blob URLs, not inline text.
  // Without this the injection layer is blocked before any card code exists, and
  // the symptom looks like a broken card rather than a wrong policy.
  const policy = framePolicy(false, SELF)
  assert.match(policy, /script-src[^;]*blob:/, 'the injected layer would be blocked')
})

test('the frame cannot open a nested context or post a form', () => {
  // Both are routes out of a frame whose entire purpose is not having one.
  const policy = framePolicy(false, SELF)
  assert.match(policy, /frame-src 'none'/)
  assert.match(policy, /form-action 'none'/)
  assert.match(policy, /default-src 'none'/)
})

test('the bootstrap is inlined, not fetched', () => {
  // An opaque-origin frame has no useful same-origin path, and a stable public
  // URL would be one more answer that could be substituted.
  const doc = buildSrcdoc('tok', 'console.log(1)', { networkGranted: false, libraries: [], selfOrigin: SELF })

  assert.match(doc, /<script>console\.log\(1\)<\/script>/)
  assert.doesNotMatch(doc, /<script[^>]+src=/, 'the frame should load nothing')
})

test('the run token reaches the bootstrap through the markup', () => {
  const doc = buildSrcdoc('abc123', '', { networkGranted: false, libraries: [], selfOrigin: SELF })
  assert.match(doc, /<meta name="iris-token" content="abc123">/)
})

test('a token containing markup cannot escape its attribute', () => {
  const doc = buildSrcdoc('a"><script>bad()</script>', '', { networkGranted: false, libraries: [], selfOrigin: SELF })

  assert.doesNotMatch(doc, /content="a"><script>bad/)
  assert.match(doc, /&quot;&gt;&lt;script&gt;/)
})

test('a bootstrap containing a closing script tag cannot break out', () => {
  // The one sequence that ends a script element early. Split rather than
  // HTML-escaped: the payload is JavaScript, and escaping inside it would change
  // the program.
  //
  // Asserted with a constructed string rather than a regex — in a test about
  // escaping, a literal backslash in the pattern is one more layer to reason
  // about than the thing under test.
  const BACKSLASH = String.fromCharCode(92)
  const doc = buildSrcdoc('tok', `const s = "</script><img onerror=bad()>"`, { networkGranted: false, libraries: [], selfOrigin: SELF })

  assert.equal(doc.includes('</script><img'), false, 'the payload broke out of its element')
  assert.equal(doc.includes(`<${BACKSLASH}/script`), true, 'the sequence was not neutralised')
  // Exactly one real script element: the one we opened.
  assert.equal(doc.match(/<[/]script>/g)?.length, 1)
})

test('the policy travels in the document, not as an attribute the host must set', () => {
  // The frame is built from `srcdoc`, so there is no response whose headers could
  // carry this. A meta element is the only place it can live.
  const doc = buildSrcdoc('tok', '', { networkGranted: false, libraries: [], selfOrigin: SELF })
  assert.match(doc, /<meta http-equiv="Content-Security-Policy" content="[^"]+">/)
})

test('the default network scope is closed, because an open one is an exit', () => {
  /*
   * An image request is an exfiltration channel wearing a costume: a card allowed
   * to load `https://anywhere/x.png?d=<conversation>` sends the conversation out
   * one pixel at a time. `connect-src` is the same capability without the
   * pretence. So both are closed by default even though closing them costs real
   * cards their appearance — that cost is what the per-card grant is for.
   */
  const policy = framePolicy(false, SELF)

  assert.match(policy, /connect-src 'none'/, 'fetch must be closed by default')
  assert.match(policy, /img-src data: blob:/, 'images must not reach arbitrary origins by default')
  assert.doesNotMatch(policy, /img-src[^;]*https:/, 'the default must not admit https images')
})

test('fonts are the one default widening, and they execute nothing', () => {
  // High coverage across real cards, and a stylesheet or a font file runs no
  // code. Both hosts or neither: googleapis serves the CSS, gstatic the faces.
  const policy = framePolicy(false, SELF)

  assert.match(policy, /style-src[^;]*https:\/\/fonts\.googleapis\.com/)
  assert.match(policy, /font-src[^;]*https:\/\/fonts\.gstatic\.com/)
})

test('a network grant widens fetch, images and styles — and nothing else', () => {
  const granted = framePolicy(true, SELF)

  assert.match(granted, /connect-src https:/)
  assert.match(granted, /img-src https:/)
  assert.match(granted, /style-src[^;]*https:/)

  // Not script origins. Letting a card fetch its author's images is a different
  // decision from letting it execute its author's code, and only the first is
  // what the grant is for.
  const scriptSrc = /script-src ([^;]*)/.exec(granted)?.[1] ?? ''
  assert.equal(scriptSrc, /script-src ([^;]*)/.exec(framePolicy(false, SELF))?.[1])
})

test('the only cleartext origin permitted is Iris own', () => {
  /*
   * This assertion used to be "no `http://` anywhere, granted or not", and it
   * caught a real collision the moment Iris's own origin joined the policy: in
   * development that origin IS `http://127.0.0.1`.
   *
   * The rule it was reaching for survives, restated precisely. A grant is the user
   * accepting that a card may talk to its author's server; it is not them
   * accepting that their conversation crosses a network they do not control in
   * clear text. Iris's own origin is not such a network — it is where the page
   * already is, so admitting it adds nothing the card did not already have.
   */
  for (const granted of [false, true]) {
    const policy = framePolicy(granted, SELF)
    const cleartext = [...policy.matchAll(/http:\/\/[^\s;]*/g)].map(match => match[0])
    assert.deepEqual(cleartext, [SELF], 'a cleartext origin other than Iris own reached the policy')
  }
})

test('the bootstrap is emitted before the libraries it must be able to report on', () => {
  // Order is the whole point. The bootstrap has to capture its channel and install
  // its error handling first, or a library that fails to load is a silent gap that
  // only surfaces later as `Vue is not defined` — a message naming the symptom and
  // hiding the cause.
  const doc = buildSrcdoc('tok', 'BOOTSTRAP', {
    networkGranted: false,
    libraries: ['https://cdn.example/vue.js', 'https://cdn.example/vue-router.js'],
    selfOrigin: SELF,
  })

  const bootstrapAt = doc.indexOf('BOOTSTRAP')
  const firstLibAt = doc.indexOf('vue.js')
  assert.ok(bootstrapAt !== -1 && firstLibAt !== -1)
  assert.ok(bootstrapAt < firstLibAt, 'the bootstrap must be able to watch the libraries load')
})

test('libraries keep their given order', () => {
  // `vue-router` expects `Vue` to already be a global.
  const doc = buildSrcdoc('tok', '', {
    networkGranted: false,
    libraries: ['https://cdn.example/vue.js', 'https://cdn.example/vue-router.js'],
    selfOrigin: SELF,
  })
  assert.ok(doc.indexOf('vue.js') < doc.indexOf('vue-router.js'))
})

test('library tags are marked so the bootstrap can find them', () => {
  const doc = buildSrcdoc('tok', '', { networkGranted: false, libraries: ['https://cdn.example/a.js'], selfOrigin: SELF })
  assert.ok(doc.includes('data-iris-lib'), 'the bootstrap watches for load failures by this marker')
})

test('a frame with no libraries emits no library tags', () => {
  const doc = buildSrcdoc('tok', '', { networkGranted: false, libraries: [], selfOrigin: SELF })
  assert.equal(doc.includes('data-iris-lib'), false)
})

test('the policy admits Iris own origin, named exactly and not as a wildcard', () => {
  // The card-library bundle is served from it. Without this the bundle is refused
  // by this very policy, and the symptom is `_ is not defined` — a message
  // pointing at a missing library rather than at the rule that blocked it.
  const policy = framePolicy(false, SELF)

  assert.match(policy, new RegExp(`script-src[^;]*${SELF.replace(/[.]/g, '[.]')}`))
  // One origin Iris controls end to end is a different thing from a wildcard.
  assert.doesNotMatch(policy, /script-src[^;]*\*:/)
})

test('a network grant does not quietly widen script origins', () => {
  // Fetching an author's images and executing an author's code are different
  // decisions, and only the first is what the grant is for.
  const ungranted = /script-src ([^;]*)/.exec(framePolicy(false, SELF))?.[1]
  const granted = /script-src ([^;]*)/.exec(framePolicy(true, SELF))?.[1]
  assert.equal(granted, ungranted)
})

test('a library tag requests CORS, so its errors arrive with names', () => {
  /*
   * Half of a pair. The other half — that the host actually answers with
   * `Access-Control-Allow-Origin` — is asserted in
   * `apps/iris/tests/sandbox-cors.test.ts`, because no test inside this package
   * can see the host, and this attribute without that header does not degrade
   * gracefully: the browser refuses to run the script at all.
   *
   * That is not a hypothetical. This assertion previously read the other way
   * round, pinning the *absence* of the attribute, because adding it without the
   * header had blocked the entire preset — no globals, no error, nine libraries
   * reported missing when the truth was one blocked request. Both states have
   * now been correct at different times, which is precisely why the pairing is
   * asserted somewhere that can see both sides rather than trusted to a comment.
   */
  const doc = buildSrcdoc('tok', '', {
    networkGranted: false,
    libraries: [`${SELF}/sandbox/preset.js`],
    selfOrigin: SELF,
  })

  assert.ok(doc.includes('/sandbox/preset.js'), 'the library tag should still be emitted')
  assert.ok(
    doc.includes('crossorigin="anonymous"'),
    'without this the preset\u2019s exceptions are redacted to "Script error." and the throw that' +
      ' stops a card\u2019s publish chain arrives carrying nothing',
  )
})
