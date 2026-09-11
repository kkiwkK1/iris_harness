import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { SHELL_CSP_DIRECTIVES, shellPolicy, stampShellIndex } from '../src/shell-csp.ts'

/**
 * The shell page's policy, and the tap that puts it there.
 *
 * The interesting assertions here are the **absences**. The directive set is
 * short because a `srcdoc` card frame inherits the shell's policy and every
 * fetch-directive narrows the cards (`shell-csp.ts` carries the browser
 * measurement); a future change that "strengthens" this by adding `default-src`
 * or `script-src` would break every card interface in the product and nothing
 * in the web app's own tests would say so, because the frames are built in a
 * browser and the breakage is a *refusal inside the frame*. So the guard
 * against it lives here, next to the reason.
 *
 * @module @iris/app-service/tests/shell-csp
 */

/** The built shell's index, which is what the tap actually receives. */
function shellIndex(): string {
  return readFileSync(
    fileURLToPath(new URL('../../../apps/iris-web/index.html', import.meta.url)),
    'utf8',
  )
}

test('the tap puts exactly one policy into the head, before the first script', () => {
  const out = stampShellIndex(shellIndex())
  assert.equal(out.refusal, undefined, 'the shipped index must be tappable')

  const metas = [...out.html.matchAll(/<meta[^>]*http-equiv\s*=\s*"Content-Security-Policy"[^>]*>/gi)]
  assert.equal(metas.length, 1, 'exactly one policy, or the browser enforces an intersection nobody wrote')

  // A `<meta>` policy governs only what the parser reaches after it, and the
  // first thing in this head is an inline script. Position is the assertion.
  const policyAt = out.html.indexOf('http-equiv="Content-Security-Policy"')
  const firstScript = out.html.indexOf('<script')
  assert.ok(firstScript !== -1, 'the shell index has no script at all: this test compares nothing')
  assert.ok(
    policyAt < firstScript,
    'the policy is written after the first script, so that script runs unpoliced',
  )
  assert.ok(policyAt > out.html.indexOf('<head'), 'the policy is outside the head')
})

test('the policy carries base-uri, object-src and form-action, all none', () => {
  const policy = shellPolicy()
  assert.match(policy, /(^|; )base-uri 'none'(;|$)/)
  assert.match(policy, /(^|; )object-src 'none'(;|$)/)
  assert.match(policy, /(^|; )form-action 'none'(;|$)/)
})

test('no directive here narrows a card frame, which is why the set is this short', () => {
  /*
   * The measurement this pins: `about:srcdoc` is a local scheme, so a card
   * frame's document inherits this policy *in addition to* its own `<meta>`,
   * and the two are enforced together. Adding `script-src`, `default-src`,
   * `style-src`, `img-src`, `font-src` or `connect-src` here would intersect
   * with the frame's permissive policy and leave nothing that runs — measured
   * in headless Chrome, where the frame's first inline script stopped running
   * the moment the parent carried `script-src 'self' 'nonce-…'`.
   *
   * The three that survive are the three a frame either already enforces on
   * itself (`object-src`, `form-action`, via its `default-src 'none'`) or
   * wants enforced (`base-uri`, which has no fallback and so was open).
   */
  const forbidden = ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src']
  for (const directive of forbidden) {
    assert.ok(
      !SHELL_CSP_DIRECTIVES.some(row => row.startsWith(`${directive} `)),
      `${directive} is in the shell policy; a srcdoc card frame inherits it and cannot survive it`
        + ' — read the measurement table in shell-csp.ts before changing this',
    )
  }
  // `frame-src` is omitted for the other half of the same measurement: Chrome
  // does not apply it to a srcdoc navigation, so every value is either a no-op
  // or, if that ever changed, the one line that kills every card at once.
  assert.ok(!SHELL_CSP_DIRECTIVES.some(row => row.startsWith('frame-src ')))
})

test('nothing in the shell policy carries unsafe-inline or unsafe-eval', () => {
  assert.ok(!shellPolicy().includes("'unsafe-inline'"))
  assert.ok(!shellPolicy().includes("'unsafe-eval'"))
})

test('a page that already declares a policy is left exactly as it was, and said so', () => {
  const already = '<!doctype html><html><head>'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'
    + '<title>t</title></head><body></body></html>'

  const out = stampShellIndex(already)

  assert.equal(out.html, already, 'the body must not be touched')
  assert.ok(out.refusal !== undefined, 'and the refusal has to be reportable')
  assert.match(out.refusal, /already declares/)
})

test('a second pass over the tap’s own output changes nothing', () => {
  // Idempotence is not a separate rule here — it falls out of the refusal
  // above. Asserted anyway, because the carrier applies taps in registration
  // order and nothing stops a future row from rendering an index twice.
  const once = stampShellIndex(shellIndex())
  const twice = stampShellIndex(once.html)

  assert.equal(twice.html, once.html)
  assert.ok(twice.refusal !== undefined)
  assert.equal(
    [...twice.html.matchAll(/http-equiv="Content-Security-Policy"/gi)].length,
    1,
  )
})

test('a body with no head is refused rather than guessed at', () => {
  const out = stampShellIndex('<p>not a document</p>')

  assert.equal(out.html, '<p>not a document</p>')
  assert.match(out.refusal ?? '', /no <head>/)
})

test('the head’s attributes do not decide whether the policy lands', () => {
  const out = stampShellIndex('<!doctype html><html><head lang="zh" data-x="1"><title>t</title></head><body></body></html>')

  assert.equal(out.refusal, undefined)
  assert.match(out.html, /<head lang="zh" data-x="1"><meta http-equiv="Content-Security-Policy"/)
})
