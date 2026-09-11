import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  countMarkupScripts,
  countMarkupScriptsIn,
  countScriptTags,
} from '../src/sandbox/markup-scripts.ts'
import { interfacesMayBuild } from '../src/sandbox/consent.ts'

/**
 * Counting the code a card runs that its script list never mentions (F9).
 *
 * A newline is built rather than escaped for the reason `script-source.ts`
 * gives: a single backslash in this repository has collapsed in transit more
 * than once, and a collapsed one still parses.
 */
const NL = String.fromCharCode(10)

/** A fenced block the frames would claim, because its body contains `<body`. */
function fenced(body: string): string {
  return ['```html', body, '```'].join(NL)
}

test('a tag name is what ends it, not what merely starts with it', () => {
  assert.equal(countScriptTags('<script>x</script>'), 1)
  assert.equal(countScriptTags('<script >x</script>'), 1)
  assert.equal(countScriptTags('<script/>'), 1)
  assert.equal(countScriptTags(`<script${NL}src="a.js"></script>`), 1)
  assert.equal(countScriptTags('<SCRIPT>x</SCRIPT>'), 1, 'HTML tag names are case-insensitive')
  // `<script type="module">` counts. In a srcdoc body a module script is
  // deferred, not skipped — it still runs, which is the whole question.
  assert.equal(countScriptTags('<script type="module">import "x"</script>'), 1)

  assert.equal(countScriptTags('<scripting>'), 0, 'a longer tag name is a different element')
  assert.equal(countScriptTags('<script'), 0, 'an unterminated name at the end is not an element')
  assert.equal(countScriptTags('script'), 0)
  assert.equal(countScriptTags(''), 0)
})

test('a <script inside a comment counts, and that is the pinned choice', () => {
  /*
   * It does not run. Counting it anyway is the safe direction and the decision
   * is pinned here so a later "fix" has to argue with it: stripping comments
   * correctly needs a parser, and every failure of a hand-rolled one is quiet —
   * a `<!--` inside an attribute value swallows the real script after it and
   * the number drops to zero on the one card where it mattered. Over-counting
   * shows a warning about markup that does not run; under-counting shows
   * nothing about markup that does. `frontend-blocks.ts` makes the same trade
   * one layer up, where the claim is substring containment rather than parsing.
   */
  assert.equal(countScriptTags('<!-- <script>never runs</script> -->'), 1)
  assert.equal(countScriptTags('<!-- <script> --><script>runs</script>'), 2)
})

test('many scripts in one body are all counted', () => {
  const body = [
    '<body>',
    '<script src="a.js"></script>',
    '<div>panel</div>',
    '<script>const a = 1</script>',
    '<script type="module">import "./b.js"</script>',
    '</body>',
  ].join(NL)
  assert.equal(countScriptTags(body), 3)
})

test('only markup a frame would claim is counted', () => {
  // Prose that talks about a script is not a script. The count walks
  // `claimMessageSurfaces`, the frames' own claim, rather than the message.
  assert.equal(countMarkupScripts('I put a <script> in my card, honest.'), 0)
  // An unclaimed fence — no `html>`, `<head>` or `<body` in it — never becomes
  // a frame, so nothing in it parses.
  assert.equal(countMarkupScripts(['```js', '<script>x</script>', '```'].join(NL)), 0)
  // And a claimed one is counted.
  assert.equal(countMarkupScripts(fenced('<body><script>x</script></body>')), 1)
})

test('the greeting case the finding was found on', () => {
  // A card whose `scripts` array is empty, whose greeting embeds a script, and
  // whose consent state is `unasked`: the frame is built without the question
  // ever being put, and the markup runs at parse time.
  const greeting = fenced('<body><div id="panel"></div><script>boot()</script></body>')
  assert.equal(interfacesMayBuild('unasked', 0), true, 'the parity behaviour must not change')
  assert.equal(countMarkupScripts(greeting), 1, 'and it must be countable')
})

test('a conversation sums its messages, in any order, and starts at zero', () => {
  assert.equal(countMarkupScriptsIn([]), 0)
  assert.equal(countMarkupScriptsIn(['just words']), 0)
  assert.equal(
    countMarkupScriptsIn([
      fenced('<body><script>a</script></body>'),
      'a reply with nothing in it',
      fenced('<body><script>b</script><script>c</script></body>'),
    ]),
    3,
  )
})
