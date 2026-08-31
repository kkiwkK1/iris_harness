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

test('a card frame gets upstream two libraries, the probe gets none', () => {
  // Copied from `src/iframe/third_party_script.html` in the installed extension:
  // two tags for a script frame, nothing else. The probe gets none — making a
  // diagnostic depend on two CDN fetches would let a network problem and a sandbox
  // problem produce the same symptom.
  assert.deepEqual(librariesFor('probe', 'http://x'), [])

  const libs = librariesFor('card-script', 'http://x')
  // Two from upstream's list plus Iris's own library bundle.
  assert.equal(libs.length, 3)
  assert.ok(libs[0]?.includes('/npm/vue/dist/vue.runtime.global.prod.min.js'))
  assert.ok(libs[1]?.includes('/npm/vue-router/dist/vue-router.global.prod.min.js'))
})

test('every library comes from an origin the policy names', () => {
  // Two from the measured CDN, one from Iris itself. Nothing else should creep in
  // unnoticed, because anything that does is refused by the frame's own policy.
  for (const url of librariesFor('card-script', 'http://x')) {
    const allowed = url.startsWith('https://testingcf.jsdelivr.net/') || url.startsWith('http://x/')
    assert.ok(allowed, `${url} is off the allowlist`)
  }
})

test('Iris own bundle loads after upstream libraries, as upstream orders it', () => {
  // Upstream runs its third-party tags first and seeds the library globals
  // afterwards, in `predefine`.
  const libs = librariesFor('card-script', 'http://x')
  assert.ok(libs.at(-1)?.endsWith('/sandbox/preset.js'))
})
