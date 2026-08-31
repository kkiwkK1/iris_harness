import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  mentionsViewportHeight,
  rewriteViewportUnits,
  VIEWPORT_PROPERTY,
} from '../src/sandbox/viewport-units.ts'

test('content with no viewport height is returned byte for byte', () => {
  // Card bodies run to megabytes, so the common case has to be a probe and a
  // return, not three replacements that each find nothing.
  const content = 'function hello() { return "height: 100%" }'
  assert.equal(rewriteViewportUnits(content), content)
  assert.equal(mentionsViewportHeight(content), false)
})

test('a full viewport becomes the property itself', () => {
  assert.equal(
    rewriteViewportUnits('.panel { min-height: 100vh; }'),
    `.panel { min-height: var(${VIEWPORT_PROPERTY}); }`,
  )
})

test('a partial viewport scales the property by a ratio', () => {
  // A ratio, not a percentage of a percentage: this is what upstream emits and
  // what resolves without a second unit.
  assert.equal(
    rewriteViewportUnits('.panel { min-height: 80vh }'),
    `.panel { min-height: calc(var(${VIEWPORT_PROPERTY}) * 0.8) }`,
  )
  assert.match(rewriteViewportUnits('min-height:37.5vh'), /\* 0\.375\)/)
})

test('all three measured forms are rewritten', () => {
  const declaration = rewriteViewportUnits('div { min-height: 50vh }')
  const attribute = rewriteViewportUnits('<div style="min-height:50vh">x</div>')
  const assignment = rewriteViewportUnits('el.style.minHeight = "50vh"')
  const setProperty = rewriteViewportUnits("el.style.setProperty('min-height', '50vh')")

  for (const [name, output] of Object.entries({ declaration, attribute, assignment, setProperty })) {
    assert.match(output, /calc\(var\(--TH-viewport-height\) \* 0\.5\)/, `${name} was not rewritten`)
    assert.doesNotMatch(output, /50vh/, `${name} kept its vh value`)
  }
})

test('height is deliberately left alone, only min-height is touched', () => {
  // Upstream only rewrites `min-height`. That looks like an oversight and is not
  // ours to correct: a compatibility layer that fixes its source stops being
  // compatible with it, and every card that works today works against this scope.
  const content = '.panel { height: 100vh; min-height: 100vh; max-height: 100vh }'
  const output = rewriteViewportUnits(content)

  assert.match(output, /height: 100vh;/, 'plain height should survive untouched')
  assert.match(output, /max-height: 100vh/, 'max-height should survive untouched')
  assert.match(output, /min-height: var\(--TH-viewport-height\)/)
})

test('a case-shifted or whitespace-loose declaration is still caught', () => {
  assert.match(rewriteViewportUnits('MIN-HEIGHT   :   70VH'), /calc\(var\(--TH-viewport-height\) \* 0\.7\)/)
})

test('a vh value on an unrelated property is not rewritten', () => {
  const content = '.panel { min-height: 40vh; top: 10vh }'
  const output = rewriteViewportUnits(content)

  assert.match(output, /top: 10vh/, 'only min-height is in scope')
  assert.doesNotMatch(output, /min-height: 40vh/)
})

test('the probe requires both a vh and a min-height, not either', () => {
  assert.equal(mentionsViewportHeight('min-height: 40px'), false)
  assert.equal(mentionsViewportHeight('top: 40vh'), false)
  assert.equal(mentionsViewportHeight('min-height: 40vh'), true)
})
