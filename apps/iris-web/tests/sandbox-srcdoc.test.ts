import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildSrcdoc, framePolicy } from '../src/sandbox/srcdoc.ts'

test('the frame policy allows eval and pins where code comes from', () => {
  // The distinction SANDBOX.md now draws: CSP cannot forbid `eval` here, because
  // the card blobs are webpack output that evals per module. Restricting the
  // ORIGIN of code is a separate capability and it is fully available.
  const policy = framePolicy(false)

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
  const policy = framePolicy(false)
  assert.match(policy, /script-src[^;]*blob:/, 'the injected layer would be blocked')
})

test('the frame cannot open a nested context or post a form', () => {
  // Both are routes out of a frame whose entire purpose is not having one.
  const policy = framePolicy(false)
  assert.match(policy, /frame-src 'none'/)
  assert.match(policy, /form-action 'none'/)
  assert.match(policy, /default-src 'none'/)
})

test('the bootstrap is inlined, not fetched', () => {
  // An opaque-origin frame has no useful same-origin path, and a stable public
  // URL would be one more answer that could be substituted.
  const doc = buildSrcdoc('tok', 'console.log(1)', false)

  assert.match(doc, /<script>console\.log\(1\)<\/script>/)
  assert.doesNotMatch(doc, /<script[^>]+src=/, 'the frame should load nothing')
})

test('the run token reaches the bootstrap through the markup', () => {
  const doc = buildSrcdoc('abc123', '', false)
  assert.match(doc, /<meta name="iris-token" content="abc123">/)
})

test('a token containing markup cannot escape its attribute', () => {
  const doc = buildSrcdoc('a"><script>bad()</script>', '', false)

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
  const doc = buildSrcdoc('tok', `const s = "</script><img onerror=bad()>"`, false)

  assert.equal(doc.includes('</script><img'), false, 'the payload broke out of its element')
  assert.equal(doc.includes(`<${BACKSLASH}/script`), true, 'the sequence was not neutralised')
  // Exactly one real script element: the one we opened.
  assert.equal(doc.match(/<[/]script>/g)?.length, 1)
})

test('the policy travels in the document, not as an attribute the host must set', () => {
  // The frame is built from `srcdoc`, so there is no response whose headers could
  // carry this. A meta element is the only place it can live.
  const doc = buildSrcdoc('tok', '', false)
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
  const policy = framePolicy(false)

  assert.match(policy, /connect-src 'none'/, 'fetch must be closed by default')
  assert.match(policy, /img-src data: blob:/, 'images must not reach arbitrary origins by default')
  assert.doesNotMatch(policy, /img-src[^;]*https:/, 'the default must not admit https images')
})

test('fonts are the one default widening, and they execute nothing', () => {
  // High coverage across real cards, and a stylesheet or a font file runs no
  // code. Both hosts or neither: googleapis serves the CSS, gstatic the faces.
  const policy = framePolicy(false)

  assert.match(policy, /style-src[^;]*https:\/\/fonts\.googleapis\.com/)
  assert.match(policy, /font-src[^;]*https:\/\/fonts\.gstatic\.com/)
})

test('a network grant widens fetch, images and styles — and nothing else', () => {
  const granted = framePolicy(true)

  assert.match(granted, /connect-src https:/)
  assert.match(granted, /img-src https:/)
  assert.match(granted, /style-src[^;]*https:/)

  // Not script origins. Letting a card fetch its author's images is a different
  // decision from letting it execute its author's code, and only the first is
  // what the grant is for.
  const scriptSrc = /script-src ([^;]*)/.exec(granted)?.[1] ?? ''
  assert.equal(scriptSrc, /script-src ([^;]*)/.exec(framePolicy(false))?.[1])
})

test('http is refused whether or not the card was granted the network', () => {
  // A grant is the user accepting that a card may talk to its author's server. It
  // is not them accepting that the conversation travels in clear text over a
  // network they do not control.
  for (const policy of [framePolicy(false), framePolicy(true)]) {
    assert.doesNotMatch(policy, /http:\/\//, 'a plain-http origin reached the policy')
  }
})
