/**
 * The browser's remote allowlist, tied to the written policy.
 *
 * The set of CDNs a card may import from exists in three places and three
 * notations: the host's `checkScriptFetch`, which enforces it; this half's
 * `REMOTE_ALLOWLIST`, from which the frame's `script-src` is derived; and the
 * `script-src` line recorded in `SANDBOX.md`. Nothing levelled them.
 *
 * The drift is asymmetric and both directions are bad. **CSP wider than the
 * host**: a card's import passes in the browser and the proxy answers 403,
 * naming a host the frame's own policy plainly allows. **Host wider than CSP**:
 * the host fetches and caches something the frame can never load, so the cost
 * this proxy exists to remove is paid for nothing.
 *
 * The host side pins itself against the same documented line
 * (`packages/iris-script/tests/remote.test.ts`). This is the other pairing, so
 * the document becomes the hub and all three are closed. Neither test can import
 * the other's package — the browser's allowlist is deliberately unreachable from
 * the host and vice versa — and the shared document is what both can read.
 *
 * @module iris-web/tests/allowlist-drift
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { isAllowedRemote, REMOTE_ALLOWLIST } from '../src/sandbox/policy.ts'
import { BUNDLE_PROXY_PATH } from '../src/sandbox/bundle-proxy.ts'

/** The frozen policy, read whole. */
function sandboxDoc(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  return readFileSync(join(root, 'SANDBOX.md'), 'utf8')
}

/** The `script-src` line as the frozen policy records it. */
function documentedScriptSrc(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const doc = readFileSync(join(root, 'SANDBOX.md'), 'utf8')
  const line = doc.split('\n').find(row => row.trim().startsWith('script-src '))
  assert.ok(line !== undefined, 'SANDBOX.md no longer records a script-src line')
  return line
}

test('the documented policy and this half of the code list the same origins', () => {
  /*
   * Compared by *set*, not by substring: a check that only asked "is each of
   * mine mentioned" would pass while the document listed an extra origin, which
   * is the exact direction that produces a CSP wider than the host.
   */
  const documented = documentedScriptSrc()
    // Trimmed per token: this repository is CRLF, so splitting on the newline
    // leaves a carriage return on the last one. A drift detector that trips over
    // line endings is a detector someone will loosen instead of read.
    .split(' ')
    .map(token => token.trim())
    .filter(token => token.startsWith('https://'))
    .map(token => token.slice('https://'.length))
    .sort()

  assert.deepEqual(
    documented,
    [...REMOTE_ALLOWLIST].sort(),
    'SANDBOX.md and REMOTE_ALLOWLIST disagree about which CDNs a card may import from;' +
      ' the host enforces its own copy, so a disagreement here is a refusal the frame cannot explain',
  )
})

test('every documented origin actually passes the check the frame applies', () => {
  // The notations differ — the document writes `https://*.jsdelivr.net`, the code
  // writes `*.jsdelivr.net` — so matching the strings is not the same as agreeing
  // on behaviour. This asserts the behaviour.
  for (const host of REMOTE_ALLOWLIST) {
    const sample = host.startsWith('*.') ? `https://cdn${host.slice(1)}/x.js` : `https://${host}/x.js`
    assert.equal(isAllowedRemote(sample), true, `${sample} is documented but the frame refuses it`)
  }
})

test('a host that merely ends with an allowed name is still refused', () => {
  // Pinned on this side too, not only on the host's. A suffix check would wave
  // this through, and the two halves must refuse it for the same reason rather
  // than one relying on the other to catch it.
  assert.equal(isAllowedRemote('https://jsdelivr.net.evil.example/x.js'), false)
  assert.equal(isAllowedRemote('https://notjsdelivr.net/x.js'), false)
  assert.equal(isAllowedRemote('https://raw.githubusercontent.com.evil.example/x.js'), false)
})

test('the proxy route this half calls is the route the policy records', () => {
  /*
   * The route string existed in four places across two trust domains — one
   * constant here, a documented default, a schema default and a fallback on the
   * host — and in no document, so nothing could tie the halves together.
   *
   * A mismatch is a 404, and `import()` reports a 404 as "failed to fetch
   * dynamically imported module": a sentence that names nothing and sends the
   * reader to the network. Of all the ways these two halves can disagree, this
   * is the one whose symptom hides its own cause.
   *
   * The document is the hub because it is the only thing both sides can read —
   * the architecture allowlist stops each from importing the other, and should.
   */
  assert.ok(
    sandboxDoc().includes(`GET ${BUNDLE_PROXY_PATH}?url=`),
    `SANDBOX.md does not record ${BUNDLE_PROXY_PATH} as the bundle route;` +
      ' the host reads the same document, and a silent disagreement here is a 404' +
      ' that import() reports as an unnamed fetch failure',
  )
})
