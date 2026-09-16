/**
 * A card's `console.*` call, turned into one bounded line (owner task W7).
 *
 * The serializer is the part of console capture that has arithmetic worth
 * pinning and needs no `window`, no `postMessage` and no frame. The wrapper
 * around it is exercised by `console-capture-live.test.ts` under a real
 * browser; what is checked here is what the line says and how big it can get,
 * which is what a bounded diagnostics buffer depends on.
 *
 * @module iris-web/tests/console-capture
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CONSOLE_LEVELS,
  installConsoleCapture,
  MAX_DEPTH,
  MAX_ENTRIES,
  MAX_LINE_CHARS,
  MAX_VALUE_CHARS,
  RateGate,
  serializeConsole,
} from '../src/sandbox/console-capture.ts'

test('the level and every argument are in the line, and a string is quoted', () => {
  const entry = serializeConsole('warn', ['a message', 1, true, null, undefined], 1_700_000_000_000)
  assert.equal(entry.level, 'warn')
  assert.equal(entry.at, 1_700_000_000_000)
  // Quoted, so `console.log('a b')` and `console.log('a', 'b')` do not read
  // identically — the console distinguishes them and a summary must too.
  assert.equal(entry.message, 'warn: "a message" 1 true null undefined')
})

test('an object is described to a depth, and the elision is visible', () => {
  const deep = { a: { b: { c: { d: { e: 'past the ceiling' } } } } }
  const entry = serializeConsole('log', [deep], 0)
  // Depth 4 means the fifth level is elided, not omitted: a reader can tell a
  // short object from a truncated one.
  assert.match(entry.message, /\{…\}/, 'the depth ceiling did not elide visibly')
  assert.doesNotMatch(entry.message, /past the ceiling/)
})

test('a long array reports how many entries it did not show', () => {
  const entry = serializeConsole('log', [Array.from({ length: 35 }, (_v, i) => i)], 0)
  assert.match(entry.message, /…23 more/, 'the entry ceiling did not say how many were left')
  // Twelve values named, and the count of the ones left; 35 - 12 = 23.
  assert.equal((entry.message.match(/\b\d+\b/g) ?? []).length, MAX_ENTRIES + 1)
})

test('a circular object does not throw, and says so', () => {
  const cycle: Record<string, unknown> = { name: 'loop' }
  cycle['self'] = cycle
  const entry = serializeConsole('log', [cycle], 0)
  assert.match(entry.message, /\[Circular\]/)
})

test('a repeated but non-circular reference is described each time', () => {
  // A WeakSet that never removed would call the second occurrence circular,
  // which is the opposite of what it is.
  const shared = { value: 1 }
  const entry = serializeConsole('log', [shared, shared], 0)
  assert.doesNotMatch(entry.message, /\[Circular\]/)
  assert.equal((entry.message.match(/value: 1/g) ?? []).length, 2)
})

test('a throwing getter is named rather than failing the call', () => {
  const hostile = {
    get boom(): string {
      throw new Error('nope')
    },
    fine: 1,
  }
  const entry = serializeConsole('log', [hostile], 0)
  assert.match(entry.message, /boom: \[getter threw\]/)
  assert.match(entry.message, /fine: 1/)
})

test('a 10 MB string is cut to the value ceiling, visibly', () => {
  const huge = 'x'.repeat(10 * 1024 * 1024)
  const entry = serializeConsole('log', [huge], 0)
  assert.ok(entry.message.length <= MAX_LINE_CHARS, `line was ${String(entry.message.length)} chars`)
  assert.match(entry.message, /chars$/, 'the truncation left no marker')
  // The value ceiling, not the line ceiling, is what bound it here.
  assert.ok(entry.message.length <= MAX_VALUE_CHARS + 40)
})

test('a huge object graph is bounded by depth and entries together', () => {
  // 200 keys × 20 keys of nested objects: pathological, and the point.
  const wide = Object.fromEntries(
    Array.from({ length: 200 }, (_v, i) => [
      `k${String(i)}`,
      Object.fromEntries(Array.from({ length: 20 }, (_w, j) => [`n${String(j)}`, j])),
    ]),
  )
  const entry = serializeConsole('log', [wide], 0)
  assert.ok(entry.message.length <= MAX_LINE_CHARS)
  // Two ceilings can bind here — the entry count and the character count — and
  // whichever binds last is the one whose marker survives. Either way the text
  // says it was cut: a line that stopped silently would report 12 keys as if
  // the object had 12.
  assert.match(entry.message, /…\d+ more|…\+\d+ chars/, 'the bound left no marker')
})

test('a Map and a Set read as their size, not as empty', () => {
  // `Object.keys(new Map([['a',1]]))` is `[]`, so a walk would report every
  // non-empty Map as empty — a wrong reading, not a partial one.
  const map = serializeConsole('log', [new Map([['a', 1], ['b', 2]])], 0)
  assert.match(map.message, /Map\(2\) \{.*a.*1.*b.*2/)
  const set = serializeConsole('log', [new Set([1, 2, 3])], 0)
  assert.match(set.message, /Set\(3\) \{.*1.*2.*3/)
})

test('an Error is its name and message, and a function its name', () => {
  assert.match(serializeConsole('error', [new TypeError('bad shape')], 0).message, /TypeError: bad shape/)
  function namedFn(): void {}
  assert.match(serializeConsole('log', [namedFn], 0).message, /\[Function: namedFn\]/)
})

test('the depth and entry ceilings are the constants the docblock names', () => {
  // Pinned, because a test proving the ceiling by building a 10 000-deep object
  // would prove nothing the constant does not.
  assert.equal(MAX_DEPTH, 4)
  assert.equal(MAX_ENTRIES, 12)
  assert.equal(MAX_VALUE_CHARS, 512)
  assert.equal(MAX_LINE_CHARS, 4_000)
})

test('every level the capture wraps is a level the serializer names', () => {
  // The wrapper and the serializer have to agree on the set; `console.debug` is
  // deliberately in neither.
  assert.deepEqual([...CONSOLE_LEVELS], ['log', 'info', 'warn', 'error'])
})

// ---------------------------------------------------------------------------
// The rate gate
// ---------------------------------------------------------------------------

test('the gate admits its budget per second and counts what it dropped', () => {
  const gate = new RateGate(3, 0)
  assert.deepEqual(gate.admit(0), { dropped: 0 })
  assert.deepEqual(gate.admit(1), { dropped: 0 })
  assert.deepEqual(gate.admit(2), { dropped: 0 })
  // Over budget: dropped, and not reported until something is admitted.
  assert.equal(gate.admit(3), undefined)
  assert.equal(gate.admit(4), undefined)
  // The next window opens and the count travels on the line that is allowed.
  assert.deepEqual(gate.admit(1_000), { dropped: 2 })
  // And the counter reset, so the line after it carries no stale number.
  assert.deepEqual(gate.admit(1_001), { dropped: 0 })
})

test('a card logging in a tight loop cannot evict the buffer', () => {
  // The number the frame actually uses; a buffer holds 2 000 records, so fifty
  // a second from one card leaves every other report where it was. The clock is
  // monotonic — a real one is, and a test that jumped it backwards would
  // measure the gate's window arithmetic instead of its ceiling.
  const gate = new RateGate(50, 0)
  let admitted = 0
  for (let i = 0; i < 5_000; i += 1) {
    if (gate.admit(i) !== undefined) admitted += 1
  }
  // Five one-second windows at fifty each: the ceiling holds end to end.
  assert.equal(admitted, 250)
})

// ---------------------------------------------------------------------------
// The wrapper: forward, then pass through
// ---------------------------------------------------------------------------

test('the wrapper forwards and still calls the original, with the console as receiver', () => {
  const forwarded: string[] = []
  const originals: string[] = []
  const fake: Record<string, unknown> = {}
  for (const level of CONSOLE_LEVELS) {
    fake[level] = function (this: unknown, ...args: unknown[]): void {
      // A receiver check: some engines require the console as `this`, and a
      // bare call would pass `undefined` in strict mode.
      originals.push(`${level}:${this === fake ? 'bound' : 'unbound'}:${args.join(',')}`)
    }
  }
  const wrapped = installConsoleCapture(fake, (level, message) => { forwarded.push(`${level}:${message}`) })
  assert.equal(wrapped, 4, 'not every captured level was wrapped')

  ;(fake['log'] as (...a: unknown[]) => void)('a', 1)
  assert.deepEqual(forwarded, ['log:log: "a" 1'])
  assert.deepEqual(originals, ['log:bound:a,1'], 'the original was not called, or not with the console as receiver')
})

test('a serializer failure does not stop the original from running', () => {
  const originals: string[] = []
  const fake: Record<string, unknown> = {
    log: (...args: unknown[]) => { originals.push(`ran:${String(args.length)}`) },
  }
  // A sink that throws: the wrapper catches around the forward, so the browser
  // console line must still happen.
  installConsoleCapture(fake, () => { throw new Error('sink exploded') })
  ;(fake['log'] as (...a: unknown[]) => void)(1, 2)
  assert.deepEqual(originals, ['ran:2'], 'a throwing sink swallowed the browser console line')
})

test('the wrapper only takes the four levels, and leaves debug alone', () => {
  const fake: Record<string, unknown> = {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    // Deliberately present and deliberately not captured.
    debug: () => {},
    trace: () => {},
  }
  const debugBefore = fake['debug']
  const traceBefore = fake['trace']
  const wrapped = installConsoleCapture(fake, () => {})
  assert.equal(wrapped, 4)
  assert.equal(fake['debug'], debugBefore, 'debug was captured, which upstream does not do')
  assert.equal(fake['trace'], traceBefore)
})

test('the wrapper counts what the budget dropped onto the next admitted line', () => {
  let clock = 0
  const lines: string[] = []
  const fake: Record<string, unknown> = { log: () => {} }
  // A one-line budget, so the second call in the same window is dropped.
  installConsoleCapture(fake, (_level, message) => { lines.push(message) }, { now: () => clock })
  // Override the gate's budget by constructing many calls in one second: the
  // shipped budget is 50, so 52 calls in the same window lose two.
  for (let i = 0; i < 52; i += 1) (fake['log'] as (...a: unknown[]) => void)(i)
  assert.equal(lines.length, 50, 'the budget did not cap the lines')
  assert.doesNotMatch(lines[49] ?? '', /dropped/, 'the count appeared before anything was dropped')
  clock = 1_000
  ;(fake['log'] as (...a: unknown[]) => void)('after')
  assert.match(lines[50] ?? '', /2 earlier line\(s\) from this card were dropped/, 'the drops were not counted')
  // And the count does not repeat on the line after.
  clock = 1_001
  ;(fake['log'] as (...a: unknown[]) => void)('later')
  assert.doesNotMatch(lines[51] ?? '', /dropped/)
})

// ---------------------------------------------------------------------------
// The wiring: the frame installs it, the runner routes it
// ---------------------------------------------------------------------------

test('the frame bootstrap installs the capture before any body, and the runner routes the message', () => {
  // The wrapper itself is driven above; what a unit test cannot drive is the
  // plumbing between the wrapper and the wire. Pinned at the source for the
  // same reason `frame-scroll.test.ts` pins its call site: the call site is
  // what a refactor drops, and dropping it is silent — the card's console
  // simply stops reaching the panel while every serializer test stays green.
  const here = fileURLToPath(new URL('..', import.meta.url))
  const entry = readFileSync(join(here, 'src', 'sandbox', 'frame-entry.ts'), 'utf8')
  assert.match(entry, /installConsoleCapture\(/u, 'the bootstrap never installs the console capture')
  // Installed after `installSandbox`, so the sandbox's own diagnostics keep
  // reaching the real console unwrapped. Matched on the call line (with its
  // leading whitespace) rather than on the bare name, which also appears in
  // the function's own definition and would read as "installed first" there.
  const callAt = entry.split(/\r?\n/u).findIndex(line => /^\s{2}reportConsole\(\)$/u.test(line))
  assert.ok(callAt !== -1, 'the console capture is defined but never called')
  assert.ok(
    callAt > entry.slice(0, entry.indexOf('installSandbox({')).split(/\r?\n/u).length - 1,
    'the console capture was installed before the sandbox, so it would wrap the sandbox’s own output',
  )
  const runner = readFileSync(join(here, 'src', 'sandbox', 'runner.ts'), 'utf8')
  assert.match(runner, /case 'console':/u, 'the runner never routes the console message')
  assert.match(runner, /host\.onConsole\?\.\(/u, 'the console message is routed but the hook is never called')
})
