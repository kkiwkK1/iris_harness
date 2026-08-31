import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_DEADLINE_MS, childExecArgv, evaluateBatch } from '../src/index.ts'
import type { EvalItem, Snapshot } from '../src/index.ts'

/**
 * The process boundary, exercised for real: every test here forks a child.
 *
 * Measured cost is about 42 ms to fork and reach ready plus 24 ms to build the
 * realm, which is what makes one child per batch affordable and is why there is
 * no pooling to test.
 */

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    variables: { global: {}, initial: {}, local: {}, message: { counter: 1, name: '未央' } },
    chatMetadata: {},
    worldInfo: [
      { world: 'book', uid: '1', comment: 'Persona_Wary', content: '戒备中。' },
    ],
    scalars: { charName: '未央' },
    traceId: 1,
    ...overrides,
  }
}

function item(id: string, text: string, locals?: EvalItem['locals']): EvalItem {
  return locals === undefined ? { id, text, origin: id } : { id, text, origin: id, locals }
}

test('the child is locked down by construction, not by convention', () => {
  // `--permission` denies filesystem writes, `child_process`, `worker`, addons
  // and wasi. It does **not** deny the network: Node 24 has no `--allow-net`, so
  // this list is only half the story and the other half is the `vm` realm
  // refusing dynamic import.
  const argv = childExecArgv()
  assert.equal(argv[0], '--permission')
  // Reads are confined to the package's own sources and its two dependencies.
  const reads = argv.slice(1)
  assert.equal(reads.length, 3)
  for (const flag of reads) assert.match(flag, /^--allow-fs-read=.+\/\*$/)
  assert.ok(reads.some(flag => flag.includes('ejs')), 'the engine must be readable')
  assert.ok(reads.some(flag => flag.includes('lodash')), 'lodash must be readable')
})

test('results come back in request order, whatever order they finished in', () => {
  // The caller indexes by position as well as by id; a batch that reordered
  // would be a very quiet bug.
  return evaluateBatch({
    items: [
      item('a', "<%= getvar('name') %>"),
      item('b', 'no tags here'),
      item('c', '<%= 1 + 1 %>'),
    ],
    snapshot: snapshot(),
  }).then((outcome) => {
    assert.deepEqual(outcome.results.map(entry => entry.id), ['a', 'b', 'c'])
    assert.deepEqual(outcome.results.map(entry => entry.result), [
      { ok: true, text: '未央' },
      { ok: true, text: 'no tags here' },
      { ok: true, text: '2' },
    ])
    assert.equal(outcome.timedOut, false)
    assert.deepEqual(outcome.ops, [])
  })
})

test('a write in one item is visible to the next, and both writes are reported', () => {
  // Upstream writes to the live application, so later entries in one generation
  // see what earlier ones did. The change set carries them in that same order.
  return evaluateBatch({
    items: [
      item('first', "<%_ setvar('counter', getvar('counter') + 10) _%>"),
      item('second', "<%= getvar('counter') %>"),
      item('third', "<%_ setvar('flag', true, { scope: 'local' }) _%>done"),
    ],
    snapshot: snapshot(),
  }).then((outcome) => {
    assert.deepEqual(outcome.results[1]?.result, { ok: true, text: '11' })
    assert.deepEqual(outcome.ops, [
      { op: 'setvar', scope: 'message', key: 'counter', value: 11 },
      { op: 'setvar', scope: 'local', key: 'flag', value: true },
    ])
  })
})

test('an item that writes and then throws keeps the write', () => {
  // Upstream applies a `setvar` the moment it runs, so a template that writes
  // and then fails has already written. Discarding the write here would be
  // tidier and would not match what the user's SillyTavern does.
  return evaluateBatch({
    items: [item('boom', "<%_ setvar('counter', 99) _%><%= nope.missing %>")],
    snapshot: snapshot(),
  }).then((outcome) => {
    const result = outcome.results[0]?.result
    assert.equal(result?.ok, false)
    assert.match((result as { error: string }).error, /nope is not defined/)
    assert.deepEqual(outcome.ops, [{ op: 'setvar', scope: 'message', key: 'counter', value: 99 }])
  })
})

test('one broken item does not cost the batch', () => {
  // The reason failures are values and not exceptions: a card with one bad
  // entry is still a usable card, and upstream keeps generating.
  return evaluateBatch({
    items: [
      item('good', '<%= 1 %>'),
      item('bad', '<%= nope.missing %>'),
      item('alsoGood', '<%= 2 %>'),
    ],
    snapshot: snapshot(),
  }).then((outcome) => {
    assert.deepEqual(outcome.results[0]?.result, { ok: true, text: '1' })
    assert.equal(outcome.results[1]?.result.ok, false)
    assert.deepEqual(outcome.results[2]?.result, { ok: true, text: '2' })
  })
})

test('an error message does not point the card author at EJS-Lint', () => {
  // Upstream comments that suggestion out. Iris has no EJS-Lint, so leaving it
  // in would send a card author after a tool that is not there.
  return evaluateBatch({
    items: [item('syntax', '<% if (true) { %>')],
    snapshot: snapshot(),
  }).then((outcome) => {
    const result = outcome.results[0]?.result as { ok: false, error: string }
    assert.equal(result.ok, false)
    assert.doesNotMatch(result.error, /EJS-Lint/)
    assert.match(result.error, /while compiling ejs/)
  })
})

test('getwi crosses the boundary intact', () => {
  return evaluateBatch({
    items: [item('fetch', "<%- await getwi(null, 'Persona_Wary') %>", { world_info: { world: 'book' } })],
    snapshot: snapshot(),
  }).then((outcome) => {
    assert.deepEqual(outcome.results[0]?.result, { ok: true, text: '戒备中。' })
  })
})

test('saveMetadata comes back as a described write', () => {
  return evaluateBatch({
    items: [item('meta', "<%_ SillyTavern.chatMetadata.flag = 1; SillyTavern.saveMetadata() _%>ok")],
    snapshot: snapshot({ chatMetadata: {} }),
  }).then((outcome) => {
    assert.deepEqual(outcome.results[0]?.result, { ok: true, text: 'ok' })
    assert.deepEqual(outcome.ops, [{ op: 'saveMetadata', value: { flag: 1 } }])
  })
})

test('a runaway template is killed, and what finished first is kept', () => {
  // The deadline is enforced here, by killing the process. `vm`'s own `timeout`
  // bounds only synchronous execution and the corpus awaits, so it would not
  // have caught this — and a synchronous spin like this one cannot be
  // interrupted from inside the child either.
  //
  // Streaming per item is what makes the kill survivable: `before` has already
  // been sent by the time the third item hangs.
  return evaluateBatch({
    items: [
      item('before', '<%= 1 %>'),
      item('hang', '<%_ while (true) { } _%>'),
      item('after', '<%= 2 %>'),
    ],
    snapshot: snapshot(),
    deadlineMs: 400,
  }).then((outcome) => {
    assert.equal(outcome.timedOut, true)
    assert.deepEqual(outcome.results[0]?.result, { ok: true, text: '1' })
    for (const id of ['hang', 'after']) {
      const result = outcome.results.find(entry => entry.id === id)?.result
      assert.equal(result?.ok, false, `${id} should be reported as a failure`)
      assert.match((result as { error: string }).error, /timed out after 400ms/)
    }
  })
})

test('the default deadline is the measured one', () => {
  // About 28× the measured 71 ms for 200 templates. Stated as a constant so a
  // change to it is a visible decision.
  assert.equal(DEFAULT_DEADLINE_MS, 2000)
})

test('an empty batch is not an error', () => {
  return evaluateBatch({ items: [], snapshot: snapshot() }).then((outcome) => {
    assert.deepEqual(outcome.results, [])
    assert.deepEqual(outcome.ops, [])
    assert.equal(outcome.timedOut, false)
  })
})

test('a template in the child cannot reach the filesystem or the module system', () => {
  // The two layers, observed from outside: the realm has no `require`, no
  // `process` and no working dynamic import, and the process behind it has no
  // filesystem to offer even if the realm were escaped.
  return evaluateBatch({
    items: [
      item('require', '<%= typeof require %>'),
      item('process', '<%= typeof process %>'),
      item('fetch', '<%= typeof fetch %>'),
      item('import', '<%= await (async () => { try { await import("node:fs"); return "REACHED" } catch (e) { return e.constructor.name } })() %>'),
    ],
    snapshot: snapshot(),
  }).then((outcome) => {
    assert.deepEqual(outcome.results.map(entry => entry.result), [
      { ok: true, text: 'undefined' },
      { ok: true, text: 'undefined' },
      { ok: true, text: 'undefined' },
      { ok: true, text: 'TypeError' },
    ])
  })
})
