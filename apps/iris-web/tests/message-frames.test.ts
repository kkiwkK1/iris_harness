/**
 * One frame per claimed interface, and the three silences it must not produce.
 *
 * Each discriminator tested here was paid for in the script-frame work, and each
 * catches something the others cannot see. The most important is the second: a
 * contract that *requires* an `attach` makes a caller supply one, and does not
 * make theirs work — a no-op satisfies the compiler and reproduces the original
 * failure exactly.
 *
 * @module iris-web/tests/message-frames
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { claimFrontendBlocks } from '../src/sandbox/frontend-blocks.ts'
import {
  describeInterface,
  runMessageInterfaces,
  type InterfaceState,
  type MessageFramesEnv,
} from '../src/sandbox/message-frames.ts'

const TICKS = String.fromCharCode(96, 96, 96)
const NL = String.fromCharCode(10)

/** A message with one interface in it. */
function oneInterface(markup = '<body><h1>console</h1></body>'): string {
  return [TICKS + 'html', markup, TICKS].join(NL)
}

/**
 * A harness over the injected `start`, so no browser is involved.
 *
 * The controller takes `start` as a function precisely so this is possible —
 * every reference to `runCard`, `window` and the srcdoc lives in the caller, and
 * this file exercises the part that decides *what a reader is told*.
 */
function harness(options?: { attachWorks?: boolean, readyTimeoutMs?: number }): {
  env: MessageFramesEnv
  states: () => InterfaceState[]
  attached: () => number
  becomeReady: (instance: number) => void
} {
  let latest: InterfaceState[] = []
  let attachedCount = 0
  const readies = new Map<number, () => void>()

  const env: MessageFramesEnv = {
    start: input => {
      readies.set(input.instance, input.onReady)
      return {
        element: { isConnected: options?.attachWorks !== false },
        dispose: () => undefined,
      }
    },
    attach: () => {
      attachedCount += 1
    },
    onState: states => {
      latest = [...states]
    },
    ...(options?.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
  }

  return {
    env,
    states: () => latest,
    attached: () => attachedCount,
    becomeReady: instance => readies.get(instance)?.(),
  }
}

test('each claimed block becomes its own frame, reported before it can be ready', () => {
  const blocks = claimFrontendBlocks([oneInterface('<body>one'), '', oneInterface('<body>two')].join(NL))
  assert.equal(blocks.length, 2, 'the fixture should contain two interfaces')

  const scope = harness()
  const running = runMessageInterfaces(blocks, 7, scope.env)

  const states = scope.states()
  assert.equal(states.length, 2)
  // `claimed`, not `live`: the frame exists and its markup has not parsed. The
  // script-frame work learned this distinction the hard way — calling a
  // dispatched frame "running" sent an observer hunting a fault in code that had
  // never been reached.
  assert.deepEqual(
    states.map(state => state.phase),
    ['claimed', 'claimed'],
  )
  assert.deepEqual(
    states.map(state => state.floor),
    [7, 7],
  )
  running.dispose()
})

test('an attach that does nothing is caught by the DOM, not trusted', () => {
  /*
   * The failure this exists for: `runCard` builds an iframe and does not insert
   * it, so an un-inserted frame never loads, the bootstrap never parses, and the
   * frame never says anything. Requiring an `attach` in the contract does not
   * make the caller's work — a no-op compiles.
   *
   * `isConnected` is the DOM answering, which is a source independent of the
   * code that claimed to have attached.
   */
  const blocks = claimFrontendBlocks(oneInterface())
  const scope = harness({ attachWorks: false })
  const running = runMessageInterfaces(blocks, 3, scope.env)

  const state = scope.states()[0]
  assert.equal(state?.phase, 'never-started')
  assert.match(state?.detail ?? '', /never put into the document/)
  running.dispose()
})

test('a frame that never reports ready stops resting in "starting"', async () => {
  // `starting…` is not a state anything may sit in forever; silence has to
  // become a finding on its own.
  const blocks = claimFrontendBlocks(oneInterface())
  const scope = harness({ readyTimeoutMs: 5 })
  const running = runMessageInterfaces(blocks, 1, scope.env)

  assert.equal(scope.states()[0]?.phase, 'claimed')
  await new Promise(resolve => setTimeout(resolve, 25))

  const state = scope.states()[0]
  assert.equal(state?.phase, 'never-started')
  assert.match(state?.detail ?? '', /never reported ready/)
  running.dispose()
})

test('a frame that reports ready becomes live, and the timeout stands down', async () => {
  /*
   * The happy path, and the reason it is tested next to the timeout: the
   * deadline must not fire for a frame that already answered. A deadline that
   * spoke over a healthy frame is exactly what the script-frame work had to
   * undo once — it destroyed the state that said what was really happening.
   */
  const blocks = claimFrontendBlocks(oneInterface())
  const scope = harness({ readyTimeoutMs: 5 })
  const running = runMessageInterfaces(blocks, 2, scope.env)

  scope.becomeReady(0)
  assert.equal(scope.states()[0]?.phase, 'live')

  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(scope.states()[0]?.phase, 'live', 'the deadline overwrote a frame that was fine')
  running.dispose()
})

test('disposing drops the states rather than leaving stale rows', () => {
  /*
   * A message that scrolled out of view has no interfaces. Keeping their last
   * state would let a reader take a stale row for a live one, which is the
   * mistake the report list's generations exist to prevent.
   */
  const blocks = claimFrontendBlocks(oneInterface())
  const scope = harness()
  const running = runMessageInterfaces(blocks, 1, scope.env)

  assert.equal(scope.states().length, 1)
  running.dispose()
  // Disposal is silent by design: `onState` is not called after it, because a
  // torn-down set has nothing to say and a final empty publish would race a
  // freshly mounted message's first one.
  assert.equal(scope.states().length, 1, 'the last publish stands; the set is simply gone')
})

test('a message with no interfaces builds no frames at all', () => {
  const scope = harness()
  const running = runMessageInterfaces([], 4, scope.env)

  assert.deepEqual(scope.states(), [])
  running.dispose()
})

test('the reader line says "live", not "rendered"', () => {
  /*
   * The frame's markup parsed. Whether the card drew anything is its own
   * business and is not observable from here — the same distinction as `ran` not
   * meaning `working` for script frames.
   */
  const live = describeInterface({ floor: 1, instance: 0, phase: 'live', bytes: 369_000 })
  assert.ok(live.includes('live'))
  assert.ok(!live.includes('rendered'))
  // The markup's size is the frame's construction cost, and 360 KiB is a real
  // measured block — worth showing rather than hiding.
  assert.ok(live.includes('360 KB'), `expected the size, got: ${live}`)

  assert.equal(describeInterface({ floor: 1, instance: 0, phase: 'claimed', bytes: 0 }), 'starting…')
})

test('a height of zero is refused at both ends, because applying it is unrecoverable', () => {
  /*
   * The self-reinforcing zero that made an interface invisible, pinned at the
   * two places it has to be stopped.
   *
   * The loop: the frame starts with no height → a card whose root is
   * `html,body{height:100%}` renders 100% of nothing → the frame measures 0 and
   * reports it → the shell writes `height: 0px` **inline**, which beats every
   * CSS floor → the frame can never be seen again. Upstream refuses at the
   * reporting end (`iframe/adjust_iframe_height.js:17-19`); this project needs
   * it at the applying end too, because "the frame will not send zero" is a
   * property of our bootstrap and not of whatever document is in there.
   *
   * Asserted against the sources rather than a live DOM: both guards are one
   * line in a file that has no unit harness, and the property worth protecting
   * is that **neither line goes away**.
   */
  const frameEntry = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sandbox', 'frame-entry.ts'),
    'utf8',
  )
  const runner = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sandbox', 'runner.ts'),
    'utf8',
  )

  assert.match(
    frameEntry,
    /pixels <= 0\) return/u,
    'the frame would report a zero height, which the shell then makes permanent',
  )
  assert.match(
    runner,
    /message\.pixels > 0/u,
    'the shell would apply a zero height inline, beating any CSS floor',
  )
  assert.match(
    frameEntry,
    /document\.body\.scrollHeight/u,
    'documentElement on a card with html{height:100%} reports the frame back to itself',
  )
})

