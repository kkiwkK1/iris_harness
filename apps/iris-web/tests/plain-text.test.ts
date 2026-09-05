/**
 * Markdown read back as plain text — the demo floor action's transform.
 *
 * The cases here are the common shapes a roleplay floor actually carries
 * (emphasis, quotes, lists, fences, links) plus the two traps that make a
 * naive regex version lie: `**x**` read as two emphasis pairs, and
 * `some_var_name` read as emphasis.
 *
 * @module iris-web/tests/plain-text
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { plainText } from '../src/app/plain-text.ts'

test('inline markers come off, content stays', () => {
  assert.equal(
    plainText('She said **stay**, *wait*, and ~~maybe~~ _listen_.'),
    'She said stay, wait, and maybe listen.',
  )
})

test('snake_case and file names are not emphasis', () => {
  /*
   * Underscore emphasis only counts at word edges; inside a word it is just
   * an underscore. A naive strip turns `some_var_name` into `somevarname`,
   * which is how a "plain text" copy silently mangles what it copies.
   */
  assert.equal(plainText('read `some_var_name` first'), 'read some_var_name first')
  assert.equal(plainText('open main_config.json'), 'open main_config.json')
})

test('fenced code keeps its body and drops its markers', () => {
  assert.equal(
    plainText('before\n```js\nconst a = 1\n```\nafter'),
    'before\nconst a = 1\nafter',
  )
})

test('links and images keep their address', () => {
  assert.equal(plainText('[docs](https://example.com) and ![a cat](https://example.com/cat.png)'),
    'docs (https://example.com) and a cat (https://example.com/cat.png)')
})

test('headings, quotes, list markers and rules lose their markup', () => {
  assert.equal(
    plainText('## The scene\n> a quiet line\n- first\n2. second\n---\nafter the rule'),
    'The scene\na quiet line\nfirst\nsecond\nafter the rule',
  )
})

test('three or more blank lines collapse, edges trim', () => {
  assert.equal(plainText('a\n\n\n\n\nb\n'), 'a\n\nb')
})
