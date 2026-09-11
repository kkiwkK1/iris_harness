import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CHILD_CONCURRENCY_LIMIT,
  CHILD_MAX_OLD_SPACE_MB,
  DEFAULT_DEADLINE_MS,
  MAX_TEMPLATE_CHARS,
  childConcurrency,
  childExecArgv,
  evaluateBatch,
} from '../src/index.ts'
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
    lorebooks: { character: 'book' },
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
  assert.ok(argv.includes('--permission'), 'the permission model must be on')
  assert.equal(argv[0], `--max-old-space-size=${String(CHILD_MAX_OLD_SPACE_MB)}`)
  // Reads are confined to the package's own sources and its two dependencies.
  const reads = argv.filter(flag => flag.startsWith('--allow-fs-read='))
  assert.equal(reads.length, 3)
  for (const flag of reads) assert.match(flag, /^--allow-fs-read=.+\/\*$/)
  assert.ok(reads.some(flag => flag.includes('ejs')), 'the engine must be readable')
  assert.ok(reads.some(flag => flag.includes('lodash')), 'lodash must be readable')
  // Three flags plus the heap ceiling plus `--permission`: nothing else.
  assert.equal(argv.length, 5)
})

test('the heap ceiling is a measurement with a floor, and the child honours it', async () => {
  // 46.3 MiB peak on the heaviest batch this corpus can make — the 708,022-character
  // variable blob, 6.79 MiB of snapshot, all 203 templated world-info entries as
  // items — doubled is 93, and the floor of 128 wins.
  assert.equal(CHILD_MAX_OLD_SPACE_MB, 128)

  // And it is in force inside the child, not merely on the command line: a
  // template that allocates past the ceiling dies rather than taking the
  // machine's memory with it. The item comes back failed, which is the same
  // shape a timeout produces and needs no special case anywhere.
  const outcome = await evaluateBatch({
    items: [item('greedy', '<%_ var a = []; while (true) { a.push(new Array(100000).fill(7)) } _%>')],
    snapshot: snapshot(),
    deadlineMs: 30_000,
  })
  assert.equal(outcome.results[0]?.result.ok, false)
  assert.equal(outcome.timedOut, false, 'the heap ceiling must fire before the 30s deadline')
})

test('an oversized template is refused by name rather than by SIGKILL', () => {
  // Measured 2026-09-11 over the user's install: the largest single templated
  // field is 19,399 characters and every templated field in the whole 19-card
  // corpus comes to 560,233, so the cap clears the corpus by 1.87× even if one
  // assembled message carried all of it. What it buys is the error: a 50 MiB
  // template compiles for seconds and then dies by signal, which reaches the
  // caller as "timed out" and names no item.
  assert.equal(MAX_TEMPLATE_CHARS, 1_048_576)
  const huge = `<%= 1 %>${'x'.repeat(MAX_TEMPLATE_CHARS)}`
  return evaluateBatch({
    items: [item('huge', huge), item('fine', '<%= 2 %>')],
    snapshot: snapshot(),
  }).then((outcome) => {
    const refused = outcome.results[0]?.result as { ok: false, error: string }
    assert.equal(refused.ok, false)
    assert.match(refused.error, /over the 1048576 character limit/)
    assert.match(refused.error, new RegExp(String(huge.length)))
    // The rest of the batch is unaffected: one absurd item is not a lost batch.
    assert.deepEqual(outcome.results[1]?.result, { ok: true, text: '2' })
    assert.equal(outcome.timedOut, false)
  })
})

test('two batches at once still only ever have one child', async () => {
  // The queue, observed rather than believed. `peak` counts entries to the
  // child-owning section, so it reads 2 the moment two batches overlap — which
  // is what this assertion would see if the queue were removed.
  const before = childConcurrency().peak
  await Promise.all([
    evaluateBatch({ items: [item('a', '<%= 1 %>')], snapshot: snapshot() }),
    evaluateBatch({ items: [item('b', '<%= 2 %>')], snapshot: snapshot() }),
    evaluateBatch({ items: [item('c', '<%= 3 %>')], snapshot: snapshot() }),
  ])
  assert.equal(childConcurrency().inFlight, 0)
  assert.equal(Math.max(before, childConcurrency().peak), CHILD_CONCURRENCY_LIMIT)
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

/**
 * How many trivial batches a runaway batch's deadline is allowed to span.
 *
 * The runaway test used to pass `deadlineMs: 400` — a wall clock. What it
 * needs from the deadline is only that the item **before** the hang has
 * finished when the kill lands, and "finished within 400 ms" is a fact about
 * one machine (`notes/METHODS.md` §二): fork plus ready plus one item is ~70 ms
 * idle here, and a peer running headless Chrome alongside can multiply that.
 * So the deadline is now a multiple of a trivial batch measured in this same
 * process, through the same fork path; a uniformly slower machine moves both.
 *
 * Five is far enough from one that the first item cannot be caught short by
 * ordinary jitter, and close enough that the test still ends in well under a
 * second when idle. Same shape as the chat-search proportionality bound
 * (commit 21eb3cc).
 *
 * **This is a smoke bound.** It cannot measure how promptly the kill lands —
 * a hung template never finishes, so any finite deadline catches it — only
 * that it lands and that what finished first is kept.
 */
const RUNAWAY_SLACK = 5

test('a runaway template is killed, and what finished first is kept', async () => {
  // The deadline is enforced here, by killing the process. `vm`'s own `timeout`
  // bounds only synchronous execution and the corpus awaits, so it would not
  // have caught this — and a synchronous spin like this one cannot be
  // interrupted from inside the child either.
  //
  // Streaming per item is what makes the kill survivable: `before` has already
  // been sent by the time the third item hangs.

  // Baseline first: one trivial item through the same fork path, so the
  // deadline below is a ratio of what this process just did rather than a
  // number that was true of another machine.
  const baselineStarted = performance.now()
  const baseline = await evaluateBatch({ items: [item('probe', '<%= 1 %>')], snapshot: snapshot() })
  const baselineMs = performance.now() - baselineStarted
  assert.deepEqual(baseline.results[0]?.result, { ok: true, text: '1' }, 'the baseline batch must do real work to be a baseline')
  const deadlineMs = Math.ceil(baselineMs * RUNAWAY_SLACK)

  const outcome = await evaluateBatch({
    items: [
      item('before', '<%= 1 %>'),
      item('hang', '<%_ while (true) { } _%>'),
      item('after', '<%= 2 %>'),
    ],
    snapshot: snapshot(),
    deadlineMs,
  })
  assert.equal(outcome.timedOut, true)
  assert.deepEqual(
    outcome.results[0]?.result,
    { ok: true, text: '1' },
    `the item before the hang must have finished inside ${String(deadlineMs)}ms `
    + `(${String(RUNAWAY_SLACK)}× the ${baselineMs.toFixed(0)}ms baseline batch)`,
  )
  for (const id of ['hang', 'after']) {
    const result = outcome.results.find(entry => entry.id === id)?.result
    assert.equal(result?.ok, false, `${id} should be reported as a failure`)
    assert.match((result as { error: string }).error, new RegExp(`timed out after ${String(deadlineMs)}ms`))
  }
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
