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
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  describeLibraryState,
  reportLibraryState,
  PRESET_SETTLE_TIMEOUT_MS,
  type LibraryProbe,
} from '../src/sandbox/library-state.ts'
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

test('the build still wraps the bundle so a throw can be recorded at all', t => {
  /*
   * The wrapper lives in `vite.preset.config.ts`, not in any source file, which
   * makes it the kind of thing a later config edit removes without any test
   * noticing. Everything above becomes decoration if the emitted bundle stops
   * catching: the frame would report "never executed" for a bundle that threw,
   * sending a reader to inspect a request that was perfectly fine.
   */
  const here = dirname(fileURLToPath(import.meta.url))
  /*
   * Resolved through the manifest: the artifact carries a content hash, so a
   * fixed name here would either miss the file entirely or — worse — find a
   * superseded one left behind by an earlier build and assert against that.
   */
  const dir = join(here, '..', 'public', 'sandbox')
  if (!existsSync(join(dir, 'manifest.json'))) {
    /*
     * Skipped aloud, not failed. `public/sandbox/` is gitignored, so a fresh
     * checkout has no artifact to inspect — and this used to die inside
     * `JSON.parse`, reporting a missing build as a syntax error and sending a
     * reader to look for a corrupt file that does not exist.
     */
    t.skip('no sandbox build in this checkout — run "npm run build:sandbox"')
    return
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    preset?: string
  }
  const name = manifest.preset
  assert.equal(typeof name, 'string', 'the sandbox manifest does not name a preset artifact')
  const built = readFileSync(join(dir, String(name)), 'utf8')
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

test('the preset check runs where Node\u2019s globals do not exist', () => {
  /*
   * The lesson from the bug that got furthest, made mechanical.
   *
   * The harness used to be `new Function(...)`, whose body resolves free
   * identifiers against Node's globals. It could therefore only ever fail on
   * things Node also lacked — and Vue's build reads `process.env.NODE_ENV`
   * unguarded, so a bundle that threw `ReferenceError: process is not defined`
   * on line 19 in every real frame passed this check every single time.
   *
   * The property is not "uses vm". It is that the executing context is built by
   * *addition* — start empty, add what a browser has — rather than by
   * subtraction from Node's. Reverting to `new Function` silently restores the
   * blind spot, and nothing downstream would notice for another eleven runs.
   */
  const here = dirname(fileURLToPath(import.meta.url))
  const harness = readFileSync(join(here, '..', 'tools', 'check-preset.mjs'), 'utf8')

  /*
   * Comments stripped first. The prose in that file explains what it replaced
   * and names the old mechanism, so a naive search finds the documentation and
   * reports it as the defect — a test failing on the sentence that describes the
   * fix is worse than no test, because the obvious way to quiet it is to delete
   * the explanation.
   *
   * Done with indexOf rather than a pattern, for the reason recorded in
   * `bundle-proxy.ts`: escapes in this project have been eaten in transit
   * repeatedly, and a collapsed one still parses while matching nothing. This
   * very block was written twice for that reason.
   */
  const NEWLINE = String.fromCharCode(10)
  const OPEN = String.fromCharCode(47, 42)
  const CLOSE = String.fromCharCode(42, 47)
  const LINE = String.fromCharCode(47, 47)

  let stripped = harness
  for (;;) {
    const at = stripped.indexOf(OPEN)
    if (at === -1) break
    const to = stripped.indexOf(CLOSE, at + OPEN.length)
    if (to === -1) break
    stripped = stripped.slice(0, at) + stripped.slice(to + CLOSE.length)
  }

  const code = stripped
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith(LINE))
    .join(NEWLINE)

  assert.ok(
    code.includes('runInContext'),
    'the preset is no longer executed in an isolated context, so Node globals leak into it',
  )
  assert.ok(
    !code.includes('new Function('),
    'a Function body resolves free names against Node, which is the blind spot this replaced',
  )
})

/*
 * ---------------------------------------------------------------------------
 * When the reading is taken.
 *
 * Everything above pins the sentence. These pin the *moment*, which is the half
 * that was wrong: the interface frame's only caller is the bootstrap tag, and
 * `srcdoc.ts` places that before the preset tag on purpose. Read there, the
 * marker is necessarily unset and the missing names are necessarily the preset's
 * own — so ten of eleven corpus cards carried "the library preset never
 * executed" on every floor that has a frame, naming the eight globals the preset
 * published a millisecond later (the REVIEW-5 re-run acceptance record, §6).
 * Not a race: a fixed document order, every run.
 * ---------------------------------------------------------------------------
 */

/** The eight names the shipped false report listed, verbatim. */
const PRESET_GLOBALS = ['$', 'jQuery', '_', 'z', 'YAML', 'showdown', 'Vue', 'VueRoute'] as const

/**
 * A frame whose document order can be driven a step at a time.
 *
 * The realm is mutable and the probe reads it through thunks, so a test can ask
 * for the report at the bootstrap's moment and then let the preset run — which
 * is exactly the sequence the browser performs and the one no test covered.
 */
function frame(initial: {
  presetRan: boolean
  missing: readonly string[]
  parsing: boolean
  presetError?: string
}): {
  probe: LibraryProbe
  posted: { message: string, channel: 'note' | 'error' }[]
  bounds: () => number[]
  presetRuns: (stillMissing?: readonly string[]) => void
  parseFinishes: () => void
  boundExpires: () => void
} {
  const state = {
    presetRan: initial.presetRan,
    missing: initial.missing,
    parsing: initial.parsing,
    presetError: initial.presetError,
  }
  const posted: { message: string, channel: 'note' | 'error' }[] = []
  const onParsed: (() => void)[] = []
  const timers: { ms: number, fire: () => void }[] = []

  return {
    probe: {
      presetRan: () => state.presetRan,
      presetError: () => state.presetError,
      missing: () => state.missing,
      // The tag is only in the document once the parser has reached it, which is
      // why the shipped line said "the preset script" instead of a URL.
      presetUrl: () => (state.parsing ? 'the preset script' : 'http://h/sandbox/preset.js'),
      parsing: () => state.parsing,
      onParsed: settled => onParsed.push(settled),
      after: (ms, expired) => timers.push({ ms, fire: expired }),
      report: (message, channel) => posted.push({ message, channel }),
    },
    posted,
    bounds: () => timers.map(timer => timer.ms),
    presetRuns: (stillMissing = []) => {
      state.presetRan = true
      state.missing = stillMissing
    },
    parseFinishes: () => {
      state.parsing = false
      for (const settled of onParsed.splice(0)) settled()
    },
    boundExpires: () => {
      for (const timer of timers.splice(0)) timer.fire()
    },
  }
}

test('the bootstrap’s own reading of the marker is never the report', () => {
  /*
   * Case (a), and the measured defect. At the moment the bootstrap asks, the
   * marker is unset and every preset global is absent — the eager code composed
   * "never executed" from exactly that and nothing later revised it.
   */
  const f = frame({ presetRan: false, missing: PRESET_GLOBALS, parsing: true })
  reportLibraryState(f.probe)
  assert.deepEqual(f.posted, [], 'the frame spoke about a document that had not finished parsing')

  // The preset tag, which is placed after the bootstrap tag, now has its turn.
  f.presetRuns()
  f.parseFinishes()
  assert.deepEqual(
    f.posted,
    [],
    'the preset ran and every library is present, so there is nothing to report',
  )
})

test('a marker still unset when the bound expires is reported once, by name', () => {
  /*
   * Case (b). The diagnosis is deferred, not deleted: a preset that really did
   * not run must still send a reader to the request. The bound covers the one
   * shape the settle point cannot — a parse that never finishes — so the frame
   * cannot be silenced by a request that neither completes nor fails.
   */
  const f = frame({ presetRan: false, missing: PRESET_GLOBALS, parsing: true })
  reportLibraryState(f.probe)
  assert.deepEqual(f.bounds(), [PRESET_SETTLE_TIMEOUT_MS], 'the wait is not bounded')
  assert.equal(f.posted.length, 0)

  f.boundExpires()
  assert.equal(f.posted.length, 1)
  assert.ok(f.posted[0]?.message.includes('never executed'))
  assert.ok(f.posted[0]?.message.includes('blocked, missing, or unparseable'))

  // And once. Both arrivals fire in a real document; the second must add nothing.
  f.parseFinishes()
  assert.equal(f.posted.length, 1, 'the settle point repeated a report the bound had already made')
})

test('a preset that ran but lacks a name gets the gap sentence, not "never executed"', () => {
  /*
   * Case (c). The two worlds stay two worlds across the deferral: the reading
   * taken at the settle point must be a fresh one, so a marker that flipped
   * changes which sentence is composed rather than only whether it is sent.
   */
  const f = frame({ presetRan: false, missing: PRESET_GLOBALS, parsing: true })
  reportLibraryState(f.probe)

  f.presetRuns(['showdown'])
  f.parseFinishes()

  assert.equal(f.posted.length, 1)
  const line = f.posted[0]
  assert.ok(line?.message.includes('showdown'))
  assert.ok(line?.message.includes('the preset ran'))
  assert.ok(
    line !== undefined && !line.message.includes('never executed'),
    'the stale verdict survived the re-read',
  )
  assert.equal(line?.channel, 'note', 'a library Iris does not carry is not a failed load')
})

test('a blocked preset is still reported the moment parsing has finished, not after the bound', () => {
  /*
   * The deferral must not cost promptness where the answer is already in. A
   * blocked, 404 or unparseable preset does not stall the parser — the browser
   * fires the tag's error event and parsing continues — so by the time the
   * document is parsed the verdict is final and waiting further would only
   * delay a true finding.
   */
  const f = frame({ presetRan: false, missing: PRESET_GLOBALS, parsing: false })
  reportLibraryState(f.probe)

  assert.equal(f.posted.length, 1)
  assert.ok(f.posted[0]?.message.includes('never executed'))
  assert.ok(
    f.posted[0]?.message.includes('http://h/sandbox/preset.js'),
    'the report names the request to go and check',
  )
  assert.deepEqual(f.bounds(), [], 'nothing was waited for, so nothing should have been scheduled')
})

test('a marker already true is answered immediately, with no wait at all', () => {
  const f = frame({ presetRan: true, missing: ['showdown'], parsing: true })
  reportLibraryState(f.probe)

  assert.equal(f.posted.length, 1, 'a settled marker was made to wait for the parser')
  assert.ok(f.posted[0]?.message.includes('the preset ran'))
  assert.deepEqual(f.bounds(), [])
})

test('a preset that recorded its own throw still reaches the error channel', () => {
  // The deferral must not flatten the three outcomes into two: a recorded throw
  // is a real failure and the panel has to keep counting it as one.
  const f = frame({
    presetRan: false,
    missing: PRESET_GLOBALS,
    parsing: true,
    presetError: 'TypeError: boom',
  })
  reportLibraryState(f.probe)
  f.parseFinishes()

  assert.equal(f.posted.length, 1)
  assert.ok(f.posted[0]?.message.includes('threw while loading'))
  assert.equal(f.posted[0]?.channel, 'error')
})

test('the frame entry reaches this sentence only through the settling wrapper', () => {
  /*
   * The defect was not in the sentence, so a future edit that composes it
   * directly in the entry would pass every assertion above while restoring the
   * eager read exactly. The entry's own hook is called from the bootstrap tag
   * and has no way to know it is early; the wrapper is the only thing that does.
   */
  const here = dirname(fileURLToPath(import.meta.url))
  const entry = readFileSync(join(here, '..', 'src', 'sandbox', 'frame-entry.ts'), 'utf8')
  assert.ok(
    entry.includes('reportLibraryState('),
    'frame-entry.ts no longer routes the library report through the settling wrapper',
  )
  assert.ok(
    !entry.includes('describeLibraryState('),
    'frame-entry.ts composes the library sentence itself again, which is the eager read'
    + ' that reported "never executed" against a preset that had simply not run yet',
  )
})

