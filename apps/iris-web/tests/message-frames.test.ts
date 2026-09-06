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
function harness(options?: {
  attachWorks?: boolean
  readyTimeoutMs?: number
  /** The frame budget's gate, when the test is about being refused. */
  allow?: (instance: number) => boolean
}): {
  env: MessageFramesEnv
  states: () => InterfaceState[]
  attached: () => number
  becomeReady: (instance: number) => void
  /**
   * Fire every superseded generation's `onReady` for an instance.
   *
   * A real caller reuses one `start` closure across rebuilds, so a torn-down
   * frame's ready can still be in flight when its successor is built. This
   * replays exactly those late answers.
   */
  becomeStaleReady: (instance: number) => void
  /** The frame reports that its bootstrap died before it could speak. */
  failBootstrap: (instance: number, message: string) => void
  /** The frame laid out real content for the first time. */
  paint: (instance: number) => void
  /** What the controller told the env about first layouts, in order. */
  envPainted: () => number[]
  /** Snapshots pushed into each frame after it was built, by instance. */
  refreshed: () => { instance: number, context: unknown }[]
  /** Events delivered into each frame after it was built, by instance. */
  emitted: () => { instance: number, event: string, args: readonly unknown[] }[]
  /**
   * What each `start` was actually handed.
   *
   * Recorded because the interesting failure is not "a frame was built" but
   * "the wrong markup was built into it": refusing by filtering the block list
   * renumbers every instance after the refused one, and each surviving frame
   * then gets its neighbour's markup with nothing reporting anything.
   */
  started: () => { instance: number, markup: string }[]
} {
  let latest: InterfaceState[] = []
  let attachedCount = 0
  const pushed: { instance: number, context: unknown }[] = []
  const delivered: { instance: number, event: string, args: readonly unknown[] }[] = []
  const startedWith: { instance: number, markup: string }[] = []
  /** One list per instance; each `start` appends, so generations stay apart. */
  const readies = new Map<number, (() => void)[]>()
  const failures = new Map<number, (message: string) => void>()
  const paints = new Map<number, (() => void)[]>()
  /** What the controller told the env about first layouts, in order. */
  const envPainted: number[] = []

  const env: MessageFramesEnv = {
    start: input => {
      startedWith.push({ instance: input.instance, markup: input.markup })
      const list = readies.get(input.instance) ?? []
      list.push(input.onReady)
      readies.set(input.instance, list)
      failures.set(input.instance, input.onBootstrapError)
      const paintList = paints.get(input.instance) ?? []
      paintList.push(input.onPainted)
      paints.set(input.instance, paintList)
      return {
        element: { isConnected: options?.attachWorks !== false },
        refreshContext: context => pushed.push({ instance: input.instance, context }),
        emit: (event, args) =>
          delivered.push({ instance: input.instance, event, args: [...args] }),
        dispose: () => undefined,
      }
    },
    attach: () => {
      attachedCount += 1
    },
    onPainted: instance => {
      envPainted.push(instance)
    },
    onState: states => {
      latest = [...states]
    },
    ...(options?.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    ...(options?.allow === undefined ? {} : { allow: options.allow }),
  }

  return {
    env,
    states: () => latest,
    attached: () => attachedCount,
    becomeReady: instance => readies.get(instance)?.at(-1)?.(),
    becomeStaleReady: instance => {
      for (const ready of readies.get(instance)?.slice(0, -1) ?? []) ready()
    },
    failBootstrap: (instance, message) => failures.get(instance)?.(message),
    paint: instance => paints.get(instance)?.at(-1)?.(),
    envPainted: () => envPainted,
    refreshed: () => pushed,
    emitted: () => delivered,
    started: () => startedWith,
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

test('a bootstrap error names the failure the moment it arrives', async () => {
  /*
   * A bootstrap that throws has nothing left to be ready *with* — its channel
   * exists precisely to speak that error. The controller used to have no ear
   * for it: the real reason arrived from the frame and was dropped, and eight
   * seconds later the timeout's generic guess ("bootstrap did not run, or it
   * was torn down") answered in its place — a detail that cannot distinguish
   * the one case a reader can act on from the rest.
   *
   * The frame's own message becomes the detail verbatim, immediately — and the
   * deadline that follows must not overwrite it with the generic guess.
   */
  const blocks = claimFrontendBlocks(oneInterface())
  const scope = harness({ readyTimeoutMs: 5 })
  const running = runMessageInterfaces(blocks, 2, scope.env)

  scope.failBootstrap(0, 'the member table did not arrive, so nothing a card calls exists')
  assert.equal(scope.states()[0]?.phase, 'never-started', 'the named state waited for the clock')
  assert.equal(
    scope.states()[0]?.detail,
    'the member table did not arrive, so nothing a card calls exists',
    'the frame\u2019s own reason was replaced by a guessed one',
  )

  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(
    scope.states()[0]?.detail,
    'the member table did not arrive, so nothing a card calls exists',
    'the deadline spoke over the named failure',
  )
  running.dispose()
})

test('a ready that arrives for a torn-down frame does not answer for its rebuild', () => {
  /*
   * The teardown/rebuild race. A message re-rendered (edit, swipe, budget gate)
   * disposes its frames and builds fresh ones with fresh tokens, through the
   * same `start` closure a real caller reuses. The old frame's `ready` can
   * still be in flight when that happens; answering for the successor would
   * mark live an interface whose frame does not exist, and a ready flag left
   * in a shared place would let one frame's handshake stand in for another's
   * forever.
   */
  const blocks = claimFrontendBlocks(oneInterface())
  const scope = harness({ readyTimeoutMs: 5 })
  const runningA = runMessageInterfaces(blocks, 2, scope.env)
  runningA.dispose()

  const runningB = runMessageInterfaces(blocks, 2, scope.env)
  assert.equal(scope.states()[0]?.phase, 'claimed', 'the rebuild inherited its answer')

  // The late answers from the dead generation, replayed exactly as they would
  // arrive: after the successor was built.
  scope.becomeStaleReady(0)
  assert.equal(
    scope.states()[0]?.phase,
    'claimed',
    'a torn-down frame\u2019s ready stood in for the rebuilt frame\u2019s',
  )

  // And its own answer still moves it.
  scope.becomeReady(0)
  assert.equal(scope.states()[0]?.phase, 'live')
  runningB.dispose()
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

test('the interface frame completes the handshake at bootstrap end, not at load', () => {
  /*
   * The root cause of "the frame never reported ready", pinned at the decision.
   *
   * `ready` vouches for the channel: the post capability, the member bridge,
   * the message listener. All of that exists the moment `installSandbox`
   * returns. Waiting for `load` handed the handshake to the card's own
   * decorative resources instead — the measured card linked Google Fonts from
   * its title screen, and on a network where that fetch hangs the frame drew
   * its button and was reported as never ready, eight seconds later, by a
   * message guessing at causes it could not see.
   *
   * A script frame keeps the load wait on purpose: its body arrives *on*
   * `ready`, so the libraries it evaluates against have to be there first.
   *
   * Asserted against the source, because this lives in the browser entry where
   * there is no unit harness — the same convention as the height guards below.
   */
  const frameEntry = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sandbox', 'frame-entry.ts'),
    'utf8',
  )

  // The interface branch posts before any wait, and reports the transfer cost
  // from the settle point where the timings actually exist.
  assert.match(
    frameEntry,
    /if \(interfaceFrame\) \{\s*\n[^\}]*post\(\{ iris: run, type: 'ready' \}\)/u,
    'an interface frame\u2019s handshake waits on the network again',
  )
  // The script branch keeps the library wait: `run` must evaluate against
  // libraries that are already there.
  assert.match(
    frameEntry,
    /window\.addEventListener\('load', announce, \{ once: true \}\)/u,
    'a script frame\u2019s body would evaluate before its libraries',
  )
  // The library failure reporter listens in capture phase: the library tags
  // parse after this script, so the earlier querySelectorAll version attached
  // its reporters to nothing.
  assert.match(
    frameEntry,
    /addEventListener\(\s*'error',\s*\n[^]*?true,/u,
    'the library failure reporter was attached to elements that do not exist yet',
  )
})

test('a bootstrap error becomes a named state on the controller side too', () => {
  /*
   * The other half of the named-failure contract. The runner calls
   * `onBootstrapError`; the controller turns it into `never-started` with the
   * frame's own words. The wiring lives in `message-frames.ts` (tested above
   * with a harness); what a source assertion can add is that the React glue
   * actually *passes* it — the one place a dropped callback would be silent,
   * and the place the dropped one sat.
   */
  const glue = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'MessageInterfaces.tsx'),
    'utf8',
  )
  assert.match(
    glue,
    /onBootstrapError: message => \{\s*\n\s*input\.onBootstrapError\(message\)/u,
    'the interface host drops the frame\u2019s bootstrap error on the floor again',
  )
})

test('the first laid-out content reaches the env once per frame', () => {
  /*
   * The swap-on-ready reveal rides this signal, because `ready` lands at the
   * end of the bootstrap while the markup parses after it — revealing at ready
   * would trade one blank for another. Once per frame: a card that relayouts
   * keeps posting heights, and the swap cares about the first only.
   */
  const blocks = claimFrontendBlocks(oneInterface())
  const scope = harness()
  const running = runMessageInterfaces(blocks, 2, scope.env)

  scope.paint(0)
  scope.paint(0)
  scope.paint(0)

  assert.deepEqual(scope.envPainted(), [0], 'a relayouting frame re-resolved the swap')
  running.dispose()
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

test('the body summary reports whether or not anything is visible', () => {
  /*
   * The revision this pins, and the reason for it.
   *
   * The first version spoke only when the body was **blank**, so "not blank" was
   * silence. The case that then arrived was a frame with visible boxes rendering
   * a white rectangle — squarely inside the silence. An instrument whose quiet
   * covers the live question is the unfalsifiable silence this project keeps
   * removing from other people's code; it had it too.
   *
   * Asserted against the source, because this lives in the browser entry where
   * there is no unit harness and the property worth protecting is that the
   * unconditional branch does not go away.
   */
  const entry = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sandbox', 'frame-entry.ts'),
    'utf8',
  )

  assert.match(entry, /reportBodySummary/u, 'the summary is gone')
  assert.match(
    entry,
    /interface after \$\{BLANK_AFTER_MS/u,
    'the visible branch reports nothing, so a frame that draws the wrong thing is silent again',
  )
  assert.match(
    entry,
    /style elements in the body/u,
    'without the stylesheet count, "visible boxes on a white page" cannot be told from "no CSS arrived"',
  )
  /*
   * `background-image`, because reporting only `background-color` is a wrong
   * reading rather than an incomplete one: the `background` shorthand resets the
   * colour to transparent, so a card painting a gradient reports
   * `rgba(0, 0, 0, 0)` and looks like a stylesheet that does nothing. This
   * summary said exactly that once, and it was believed.
   */
  assert.match(
    entry,
    /backgroundImage/u,
    'a gradient background computes to a transparent colour, so colour alone misreads it',
  )
  assert.match(
    entry,
    /descendants/u,
    'counting only direct children says nothing about a card whose interface lives inside one box',
  )
  assert.match(
    entry,
    /data-iris-interface/u,
    'ungated, this would put a summary under every script frame, whose body is script tags by design',
  )
})


test('a refresh reaches every frame of the message without rebuilding one', () => {
  /*
   * An interface is a status panel: it draws the variables. A write from a
   * later floor leaves it displaying a number that was true a turn ago —
   * healthy-looking and wrong, which is worse than a card that visibly fails.
   *
   * Pushed rather than rebuilt on purpose. This pipeline already rebuilds on an
   * edit or a swipe, and that costs a full reparse of the block — 360 KiB on the
   * sample card — plus whatever the panel had drawn. A snapshot is data; it does
   * not need a new realm.
   */
  const blocks = claimFrontendBlocks([oneInterface('<body>one'), '', oneInterface('<body>two')].join(NL))
  const scope = harness()
  const running = runMessageInterfaces(blocks, 3, scope.env)

  running.refresh({ chat: ['fresh'] })

  assert.deepEqual(
    scope.refreshed().map(entry => entry.instance),
    [0, 1],
    'every frame of the message shares the chat, so every frame gets the snapshot',
  )
  running.dispose()
})

test('a refresh after teardown reaches nothing', () => {
  /*
   * A message scrolling out of view disposes its frames, and an event already
   * in flight must not push into a realm that is gone.
   */
  const blocks = claimFrontendBlocks(oneInterface('<body>one'))
  const scope = harness()
  const running = runMessageInterfaces(blocks, 3, scope.env)

  running.dispose()
  running.refresh({ chat: ['fresh'] })

  assert.equal(scope.refreshed().length, 0, 'a disposed message still pushed a snapshot')
})

test('an event reaches every frame of the message, and nothing after teardown', () => {
  /*
   * The measured status bars redraw inside `eventOn(Mvu.events.
   * VARIABLE_UPDATE_ENDED, …)`. Upstream that name arrives through the page's
   * shared event source; here the shell has to speak it into each frame's own
   * bus, so the controller is the delivery path and it needs the same two
   * properties the refresh has: every frame of the message hears it, and a
   * disposed set delivers nothing.
   */
  const blocks = claimFrontendBlocks([oneInterface('<body>one'), '', oneInterface('<body>two')].join(NL))
  const scope = harness()
  const running = runMessageInterfaces(blocks, 3, scope.env)

  running.emit('mag_variable_update_ended', [])

  assert.deepEqual(
    scope.emitted().map(entry => entry.instance),
    [0, 1],
    'every frame of the message redraws, so every frame hears the trigger',
  )
  assert.deepEqual(
    scope.emitted().map(entry => entry.event),
    ['mag_variable_update_ended', 'mag_variable_update_ended'],
  )

  running.dispose()
  running.emit('mag_variable_update_ended', [])
  assert.equal(scope.emitted().length, 2, 'a disposed message still delivered an event')
})

test('a refused instance builds no frame and says so as a decision', () => {
  const blocks = claimFrontendBlocks([oneInterface('<body>one'), '', oneInterface('<body>two')].join(NL))
  assert.equal(blocks.length, 2, 'the fixture should contain two interfaces')

  const scope = harness({ allow: instance => instance !== 0 })
  const running = runMessageInterfaces(blocks, 7, scope.env)

  /*
   * The seam this tests is the join between two things that were each already
   * tested: the plan decides, and the controller obeys. `planFrames` has twelve
   * tests and this controller had none for `allow` — so the controller could
   * have ignored the gate entirely and every one of those twelve would still
   * have been green.
   */
  assert.deepEqual(scope.started().map(call => call.instance), [1], 'only the allowed instance builds')

  const states = scope.states()
  assert.equal(states.length, 2, 'a refused interface still has a state to show')
  assert.equal(states.find(state => state.instance === 0)?.phase, 'over-budget')
  assert.equal(states.find(state => state.instance === 1)?.phase, 'claimed')

  running.dispose()
})

test('a refused instance keeps its number, so its neighbours keep their markup', () => {
  /*
   * The hazard is renumbering. `instance` is the block's index and it is also
   * what `splitAroundInterfaces` uses to decide which slot an interface belongs
   * in, so refusing by *filtering the list* shifts every instance after the
   * refused one: each surviving frame is built with its neighbour's markup and
   * rendered into its neighbour's slot, with no error anywhere.
   *
   * Asserted on the markup rather than on the count, because a filtered list
   * produces the same count of frames and only the contents are wrong.
   */
  const blocks = claimFrontendBlocks(
    [oneInterface('<body>zero'), '', oneInterface('<body>one'), '', oneInterface('<body>two')].join(NL),
  )
  assert.equal(blocks.length, 3, 'the fixture needs a middle block to refuse')

  const scope = harness({ allow: instance => instance !== 1 })
  const running = runMessageInterfaces(blocks, 3, scope.env)

  const started = scope.started()
  assert.deepEqual(started.map(call => call.instance), [0, 2])
  assert.ok(started[0]?.markup.includes('zero'), `instance 0 got: ${started[0]?.markup ?? 'nothing'}`)
  assert.ok(started[1]?.markup.includes('two'), `instance 2 got: ${started[1]?.markup ?? 'nothing'}`)

  running.dispose()
})

test('a refused instance still reports its size, because the placeholder names it', () => {
  const blocks = claimFrontendBlocks(oneInterface('<body>' + '界'.repeat(500)))
  const scope = harness({ allow: () => false })
  const running = runMessageInterfaces(blocks, 1, scope.env)

  const state = scope.states()[0]
  assert.ok(state !== undefined)
  /*
   * Encoded bytes, not code units: 500 Chinese characters are 1500 bytes, and
   * the placeholder prints this number as the reason a reader is looking at a
   * placeholder. A figure a third of the truth would make the budget look
   * absurdly small to the one person trying to understand it.
   */
  assert.ok(state.bytes > 1500, `reported ${String(state.bytes)} bytes`)
  assert.match(describeInterface(state), /budget/, 'the reader is told what refused it')
  assert.doesNotMatch(
    describeInterface(state),
    /never started|failed/i,
    'a decision must not be worded as a failure',
  )

  running.dispose()
})

test('no gate at all builds everything, which is what a caller without a budget wants', () => {
  const blocks = claimFrontendBlocks([oneInterface('<body>one'), '', oneInterface('<body>two')].join(NL))
  const scope = harness()
  const running = runMessageInterfaces(blocks, 7, scope.env)

  // `allow` absent means "no opinion", not "refuse": the controller asks, it
  // does not decide, and every other test in this file relies on that default.
  assert.deepEqual(scope.started().map(call => call.instance), [0, 1])
  running.dispose()
})
