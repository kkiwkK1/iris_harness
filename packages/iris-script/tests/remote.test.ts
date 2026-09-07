import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ALLOWED, checkScriptFetch } from '../src/remote.ts'

/**
 * Which hosts a card script may fetch code from.
 *
 * The set is a security boundary that exists in three notations across both
 * halves of the app, and until now nothing held them level.
 */

test('the host allowlist still agrees with the CSP the frame is served', async t => {
  // Three copies of one set exist, in three notations, across both halves:
  //   packages/iris-script/src/remote.ts   ALLOWED            — enforced here
  //   apps/iris-web/src/sandbox/policy.ts  REMOTE_ALLOWLIST   — the frame's copy
  //   docs/SANDBOX.md                      the CSP source list
  //
  // Nothing tied them together. The farthest copy from a definition is the one
  // that gets changed alone, and for a *security* set the divergence is silent
  // in the worst direction: a CSP that permits a host this refuses makes a card
  // fail with a 403 naming a host the browser was told it could use.
  //
  // This pins the pair that can be reached from this package — the enforcement
  // and the written policy. It cannot import the browser half, so it does the
  // next best thing: it fails when the document changes, which is the moment
  // someone has to look at all three.
  const { readFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const docPath = fileURLToPath(new URL('../../../docs/SANDBOX.md', import.meta.url))
  let doc: string
  try {
    doc = await readFile(docPath, 'utf8')
  } catch {
    /*
     * A missing document is two different situations, and this used to answer
     * both with `return` — a pass that asserted nothing.
     *
     * That mattered more than it looks. This test is the only thing holding
     * three copies of a **security** set level, and the document is the copy it
     * cannot import. Moving the file would therefore not have gone red: the
     * test would have kept passing while checking nothing, which is the failure
     * `scripts/check-corpus-skips.mjs` exists to catch elsewhere — "guarding by
     * returning early instead of skipping reports as a pass and proves nothing".
     * It was found by reading this catch while planning the move (2026-09-06,
     * SANDBOX.md → docs/), not by any signal the run produced.
     *
     * So: inside the repository the document must be there, and its absence is
     * a failure that names it. Outside — a published package, a consumer's
     * node_modules — there is no document to read and the claim genuinely does
     * not apply, which is a skip with its reason, not a silent pass.
     */
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
    if (existsSync(`${repoRoot}package.json`)) {
      assert.fail(
        'docs/SANDBOX.md is missing from this checkout, so the CSP list this test '
        + 'compares against cannot be read. If the document moved, update the path here: '
        + 'the three copies of the allowlist are only held level by this file.',
      )
    }
    t.skip('run outside the repository: docs/SANDBOX.md is not present to compare against')
    return
  }

  const line = doc.split(/\r?\n/).find(text => text.startsWith('script-src '))
  assert.ok(line !== undefined, 'docs/SANDBOX.md no longer states a script-src line')
  const documented = line.split(/\s+/).filter(token => token.startsWith('https://'))

  // Derived from the code, not restated in the test. A literal here would pin
  // the document to this file and leave `ALLOWED` free — so adding a domain to
  // the host allowlist would widen what the host fetches with every assertion
  // still green, and that is the direction that matters.
  const fromCode = ALLOWED.map(entry => `https://${entry.subdomains ? '*.' : ''}${entry.suffix}`)
  // The comparison below is only worth anything while the code side has entries
  // in it: two empty lists are deepEqual, and that is the one way a parse failure
  // could pass. `> 0` rather than `>= 2` on purpose — the invariant is "the
  // allowlist is not empty", and 2 is only what it happens to hold today.
  assert.ok(fromCode.length > 0, 'the host allowlist is empty, so this comparison proves nothing')
  assert.ok(documented.length > 0, 'the documented script-src names no https origin, so this comparison proves nothing')

  // Compared as sets, both ways. Asking only "is each of mine in the document"
  // passes when the document lists one more — which is exactly the case where
  // the browser is told it may load something this host will then refuse.
  assert.deepEqual(
    [...documented].sort(),
    [...fromCode].sort(),
    'the documented CSP and the host allowlist no longer name the same hosts',
  )

  // And what the document permits, this actually allows.
  assert.equal(checkScriptFetch('https://cdn.jsdelivr.net/npm/a@1/x.js').allowed, true)
  assert.equal(checkScriptFetch('https://testingcf.jsdelivr.net/gh/a/b.js').allowed, true)
  assert.equal(checkScriptFetch('https://raw.githubusercontent.com/u/r/main/x.js').allowed, true)
  // And nothing beyond it — the lookalikes a suffix match would have let through.
  for (const host of [
    'https://jsdelivr.net.evil.example/x.js',
    'https://notjsdelivr.net/x.js',
    'https://raw.githubusercontent.com.evil.example/x.js',
    'https://gist.githubusercontent.com/u/x.js',
  ]) {
    assert.equal(checkScriptFetch(host).allowed, false, `${host} was allowed`)
  }
})
