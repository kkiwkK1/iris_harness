/**
 * The library report, checked for the distinction it exists to draw.
 *
 * Every assertion here is about one question: does a reader come away knowing
 * *which* of two worlds to look in — a request that failed, or libraries Iris
 * does not carry? A report that lists names without answering that reads as a
 * list of independent gaps, and one blocked script produced exactly that: nine
 * names, four of which had worked for a dozen runs.
 *
 * @module iris-web/tests/library-state
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { describeLibraryState } from '../src/sandbox/library-state.ts'
import { PRESET_ERROR, PRESET_MARKER } from '../src/sandbox/preset-globals.ts'

test('a preset that never ran is reported as one failure, not as many gaps', () => {
  const line = describeLibraryState(false, ['$', '_', 'YAML', 'Vue'], 'http://h/sandbox/preset.js')
  assert.ok(line !== undefined)
  assert.ok(line.includes('never executed'))
  // The reader is sent to the request, and told not to chase the names.
  assert.ok(line.includes('http://h/sandbox/preset.js'))
  assert.ok(line.includes('not a separate gap'))
})

test('a preset that never ran is reported even when nothing is missing', () => {
  /*
   * Something else supplying the globals is not a reason to stay quiet: the
   * frame is then working by accident and will stop without warning. An
   * instrument that only speaks when it also sees absences would be silent in
   * precisely the case that is hardest to diagnose later.
   */
  const line = describeLibraryState(false, [], 'http://h/sandbox/preset.js')
  assert.ok(line !== undefined)
  assert.ok(line.includes('never executed'))
})

test('missing libraries after a successful preset are named as gaps, not as a failed load', () => {
  const line = describeLibraryState(true, ['showdown', 'VueRouter'], 'http://h/sandbox/preset.js')
  assert.ok(line !== undefined)
  assert.ok(line.includes('showdown'))
  assert.ok(line.includes('VueRouter'))
  assert.ok(line.includes('the preset ran'))
  assert.ok(!line.includes('never executed'))
})

test('the two findings are never confusable with each other', () => {
  const blocked = describeLibraryState(false, ['showdown'], 'http://h/p.js')
  const gap = describeLibraryState(true, ['showdown'], 'http://h/p.js')
  assert.notEqual(blocked, gap, 'the same missing name must read differently in the two worlds')
})

test('a healthy frame says nothing', () => {
  assert.equal(describeLibraryState(true, [], 'http://h/p.js'), undefined)
})

test('the marker name is the same string in the bundle, the frame, and the check', () => {
  /*
   * Three places hardcode it and none can import from the others: the preset
   * bundle runs in a frame, the check runs in Node against built output, and the
   * frame entry reads it off `window`. A rename that missed one would leave the
   * frame permanently reporting "the preset never ran" against a preset that
   * runs perfectly — a false alarm on the one instrument that is supposed to end
   * an ambiguity.
   */
  const here = dirname(fileURLToPath(import.meta.url))
  const check = readFileSync(join(here, '..', 'tools', 'check-preset.mjs'), 'utf8')
  assert.ok(
    check.includes(PRESET_MARKER),
    `check-preset.mjs does not mention ${PRESET_MARKER}, so it no longer verifies the marker`,
  )

  const entry = readFileSync(join(here, '..', 'src', 'sandbox', 'preset-entry.ts'), 'utf8')
  assert.ok(
    entry.includes('PRESET_MARKER'),
    'the preset bundle no longer sets the marker the frame checks for',
  )
})

test('the marker is the preset\u2019s last statement, which is what makes it proof', () => {
  /*
   * Its position is the property, not its presence. Set anywhere earlier it
   * would prove only that the bundle *started*, and a throw after it would leave
   * the frame reporting a healthy load with libraries silently missing.
   */
  const here = dirname(fileURLToPath(import.meta.url))
  const entry = readFileSync(join(here, '..', 'src', 'sandbox', 'preset-entry.ts'), 'utf8')
  const code = entry
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('*') && !line.startsWith('/*') && !line.startsWith('//'))
  assert.ok(
    code.at(-1)?.includes('PRESET_MARKER'),
    `the last statement of preset-entry.ts is "${String(code.at(-1))}", not the marker`,
  )
})

test('a preset that threw is reported by its own words, not by its consequences', () => {
  const line = describeLibraryState(
    false,
    ['$', '_', 'Vue'],
    'http://h/sandbox/preset.js',
    'TypeError: Cannot read properties of null (reading \u2018createElement\u2019)',
  )
  assert.ok(line !== undefined)
  assert.ok(line.includes('threw while loading'))
  assert.ok(line.includes('Cannot read properties of null'))
  assert.ok(line.includes('not a separate gap'))
})

test('threw and never-executed are different findings with different next steps', () => {
  /*
   * Both leave the marker unset, and from the missing names alone they are
   * indistinguishable — but one hands over a name to fix and the other hands
   * over a request to inspect. Collapsing them would waste the whole point of
   * the bundle recording its own exception.
   */
  const threw = describeLibraryState(false, ['$'], 'http://h/p.js', 'Error: boom')
  const never = describeLibraryState(false, ['$'], 'http://h/p.js')
  assert.notEqual(threw, never)
  assert.ok(never?.includes('never executed'))
  assert.ok(never?.includes('blocked, missing, or unparseable'))
  assert.ok(never !== undefined && !never.includes('threw'))
})

test('an empty recorded error is treated as no record, not as a nameless throw', () => {
  // The global is written by a catch block that may itself have failed; an empty
  // string would otherwise render as "threw while loading (url): " with nothing
  // after the colon, which looks like a truncated report rather than a fact.
  const line = describeLibraryState(false, ['$'], 'http://h/p.js', '')
  assert.ok(line?.includes('never executed'))
})

test('the build still wraps the bundle so a throw can be recorded at all', () => {
  /*
   * The wrapper lives in `vite.preset.config.ts`, not in any source file, which
   * makes it the kind of thing a later config edit removes without any test
   * noticing. Everything above becomes decoration if the emitted bundle stops
   * catching: the frame would report "never executed" for a bundle that threw,
   * sending a reader to inspect a request that was perfectly fine.
   */
  const here = dirname(fileURLToPath(import.meta.url))
  const built = readFileSync(join(here, '..', 'public', 'sandbox', 'preset.js'), 'utf8')
  assert.ok(built.startsWith('try{'), 'the emitted preset is no longer wrapped in a try')
  assert.ok(
    built.trimEnd().endsWith('}'),
    'the emitted preset does not close its wrapper',
  )
  assert.ok(
    built.includes(PRESET_ERROR),
    `the emitted preset never writes ${PRESET_ERROR}, so a throw would leave no name`,
  )
})

