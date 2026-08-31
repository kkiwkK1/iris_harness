import assert from 'node:assert/strict'
import { test } from 'node:test'

import { modeFor, stripCodeFence } from '../src/sandbox/script-source.ts'

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
