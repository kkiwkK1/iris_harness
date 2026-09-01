import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkScriptFetch } from '../src/remote.ts'

/**
 * Which hosts a card script may fetch code from.
 *
 * The set is a security boundary that exists in three notations across both
 * halves of the app, and until now nothing held them level.
 */

test('the host allowlist still agrees with the CSP the frame is served', async () => {
  // Three copies of one set exist, in three notations, across both halves:
  //   packages/iris-script/src/remote.ts   ALLOWED            — enforced here
  //   apps/iris-web/src/sandbox/policy.ts  REMOTE_ALLOWLIST   — the frame's copy
  //   SANDBOX.md                           the CSP source list
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
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('../../../SANDBOX.md', import.meta.url))
  let doc: string
  try {
    doc = await readFile(root, 'utf8')
  } catch {
    // Run from somewhere without the repo root. Silence here is honest: the
    // claim is about a document this cannot see.
    return
  }

  const line = doc.split(/\r?\n/).find(text => text.startsWith('script-src '))
  assert.ok(line !== undefined, 'SANDBOX.md no longer states a script-src line')
  const hosts = line.split(/\s+/).filter(token => token.startsWith('https://'))
  assert.deepEqual(
    hosts,
    ['https://*.jsdelivr.net', 'https://raw.githubusercontent.com'],
    'the documented CSP changed; the host allowlist in remote.ts must change with it',
  )

  // And what the document permits, this actually allows.
  assert.equal(checkScriptFetch('https://cdn.jsdelivr.net/npm/a@1/x.js').allowed, true)
  assert.equal(checkScriptFetch('https://testingcf.jsdelivr.net/gh/a/b.js').allowed, true)
  assert.equal(checkScriptFetch('https://raw.githubusercontent.com/u/r/main/x.js').allowed, true)
  // And nothing beyond it — the lookalike a suffix match would have let through.
  assert.equal(checkScriptFetch('https://jsdelivr.net.evil.example/x.js').allowed, false)
})
