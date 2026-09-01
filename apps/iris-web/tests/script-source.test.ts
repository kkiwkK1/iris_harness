import assert from 'node:assert/strict'
import { test } from 'node:test'

import { modeFor, remoteImports, stripCodeFence } from '../src/sandbox/script-source.ts'
import { librariesFor } from '../src/sandbox/libraries.ts'

/** Built from a code point: a literal backtick run in a heredoc-authored file is
 * one more layer to reason about than the thing under test. */
const F = String.fromCharCode(96).repeat(3)

test('a fence wrapping the whole body is removed', () => {
  // Card scripts are edited in Markdown-showing fields, so authors fence them and
  // the fence gets stored.
  assert.equal(stripCodeFence(`${F}javascript\nconst a = 1\n${F}`), 'const a = 1')
  assert.equal(stripCodeFence(`${F}\nconst a = 1\n${F}`), 'const a = 1')
})

test('surrounding whitespace does not defeat the fence', () => {
  assert.equal(stripCodeFence(`\n  ${F}js\nconst a = 1\n${F}  \n`), 'const a = 1')
})

test('a fence in the middle of a script is left alone', () => {
  // Upstream's pattern is anchored to the whole string, so it either consumes the
  // entire body or does nothing. A body containing a fenced example is not a
  // fenced body, and rewriting it would corrupt the script.
  const withExample = `const doc = "${F}js\nexample\n${F}"\nrun(doc)`
  assert.equal(stripCodeFence(withExample), withExample)
})

test('an unfenced body is returned byte for byte', () => {
  const plain = 'import "https://cdn/x.js"\nconsole.log(1)'
  assert.equal(stripCodeFence(plain), plain)
})

test('a multi-line fenced body keeps its interior newlines', () => {
  assert.equal(stripCodeFence(`${F}js\nlet a\nlet b\n${F}`), 'let a\nlet b')
})

test('card scripts are modules, and it is not decided by sniffing the source', () => {
  // Upstream runs every script iframe as `<script type="module">` with no
  // per-script branch. A sniffer would make cards behave differently for reasons
  // no card author could predict.
  assert.equal(modeFor('card-script'), 'module')
  // Classic remains for Iris's own probe, which exercises the shadowed globals a
  // module cannot be handed.
  assert.equal(modeFor('probe'), 'classic')
})

test('remote import targets are named so a stalled load can be acted on', () => {
  // A module whose remote import never settles does not throw, so nothing can
  // catch it and the frame simply stops. Naming the host it was waiting on is
  // what turns "it stopped" into something someone can do about.
  const body = [
    "import 'https://testingcf.jsdelivr.net/npm/vue/dist/vue.js'",
    'import { x } from "https://cdn.jsdelivr.net/npm/lodash/lodash.js"',
    'console.log(1)',
  ].join('\n')

  assert.deepEqual(remoteImports(body), [
    'https://testingcf.jsdelivr.net/npm/vue/dist/vue.js',
    'https://cdn.jsdelivr.net/npm/lodash/lodash.js',
  ])
})

test('only remote specifiers are named, and only from import lines', () => {
  const body = [
    "import './local.js'",
    "const url = 'https://not-an-import.example/x.js'",
    "import 'https://real.example/y.js'",
  ].join('\n')

  assert.deepEqual(remoteImports(body), ['https://real.example/y.js'])
})

test('a body with no remote imports names nothing rather than guessing', () => {
  assert.deepEqual(remoteImports('console.log(1)'), [])
})

test('the same host twice is named once', () => {
  const body = ["import 'https://a.example/x.js'", "import 'https://a.example/x.js'"].join('\n')
  assert.deepEqual(remoteImports(body), ['https://a.example/x.js'])
})

test('a card frame gets Iris’s own bundle, and the probe gets none', () => {
  // The probe gets none because it exercises the frame, not a card. Making a
  // diagnostic depend on a fetch would let a network problem and a sandbox
  // problem produce the same symptom.
  assert.deepEqual(librariesFor('probe', 'http://x'), [])

  const libs = librariesFor('card-script', 'http://x')
  assert.equal(libs.length, 1)
  assert.ok(libs[0]?.endsWith('/sandbox/preset.js'))
})

test('nothing in a frame’s boot path comes off the network', () => {
  /*
   * The invariant that replaced the allowlist check here, and the stronger one.
   *
   * This used to permit `testingcf.jsdelivr.net` because upstream's Vue tags
   * lived there. Those tags are gone: Iris opens each chat in a fresh opaque
   * origin where the HTTP cache is partitioned, so a CDN tag was a cold fetch
   * every time — and a classic script that fails to load fails *silently*, which
   * cost eleven runs of a card whose provider was waiting on a Vue that never
   * arrived.
   *
   * So the rule is no longer "from an allowed origin" but "from ours". A card
   * may still import from the allowlisted CDNs; the difference is that the
   * frame's own startup no longer depends on one.
   */
  for (const url of librariesFor('card-script', 'http://x')) {
    assert.ok(
      url.startsWith('http://x/'),
      `${url} is off Iris’s origin, so a frame’s startup depends on the network again`,
    )
  }
})
