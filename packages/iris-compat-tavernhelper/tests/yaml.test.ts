import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatYamlBlock } from '../src/yaml.ts'

/**
 * The YAML block `{{format_*_variable::…}}` produces, pinned in its new home.
 *
 * The function moved here from `@iris/mvu` on 2026-09-12 (root
 * `notes/DEVIATIONS.md`, stage 0) and arrived with no tests of its own — it was
 * covered only end to end, by `@iris/app-service`'s `helper-macros.test.ts`,
 * which asserts that a block reached the prompt and that no macro survived
 * verbatim. That test would stay green through every rewrite below, because
 * each still produces *a* block.
 *
 * What is pinned here is the three decisions its docblock calls load-bearing,
 * each of which reads as a tidy-up and each of which changes what a model is
 * shown:
 *
 * - `lineWidth: -1`. `js-yaml` wraps at 80 columns by default, and a wrapped
 *   value in a status block reads to a model as two values.
 * - `noCompatMode: true`. Without it `js-yaml` quotes YAML 1.1 booleans —
 *   `yes`, `on`, `off` — which the `yaml` package upstream uses (1.2) leaves
 *   plain, so the same state file would render differently here than in
 *   SillyTavern.
 * - A string is returned as itself. Upstream substitutes a string value raw;
 *   passing it through `dump` would put quotation marks into prose.
 */

test('a long value is not wrapped', () => {
  const long = 'x'.repeat(200)
  const block = formatYamlBlock({ note: long })

  assert.equal(block.includes('\n'), false, 'js-yaml wrapped at 80 columns')
  assert.equal(block, `note: ${long}`)
})

test('YAML 1.1 booleans stay plain', () => {
  // `noCompatMode: false` renders these as 'yes' / 'on' with quotes.
  assert.equal(formatYamlBlock({ a: 'yes', b: 'on', c: 'off' }), 'a: yes\nb: on\nc: off')
})

test('a string value is returned as itself', () => {
  assert.equal(formatYamlBlock('15:00'), '15:00')
  assert.equal(formatYamlBlock('a: b'), 'a: b', 'a string that looks like YAML is still a string')
})

test('a multi-line string comes out as a literal block', () => {
  // What upstream's `blockQuote: 'literal'` asks for, measured against the
  // worked example in JS-Slash-Runner's CHANGELOG (4.1.4).
  assert.equal(formatYamlBlock({ log: 'one\ntwo' }), 'log: |-\n  one\n  two')
})

test('there is no trailing newline', () => {
  // `dump` ends every document with one; the block is substituted mid-sentence.
  assert.equal(formatYamlBlock({ a: 1 }), 'a: 1')
})
