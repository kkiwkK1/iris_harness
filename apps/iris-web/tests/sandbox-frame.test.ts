import assert from 'node:assert/strict'
import { test } from 'node:test'

import { UnsupportedApiError } from '../src/sandbox/errors.ts'
import { CARD_METHODS, isCardMethod, isOnSillyTavernSurface } from '../src/sandbox/card-api.ts'
import { installSandbox, type FrameEnv } from '../src/sandbox/frame.ts'
import { UPSTREAM_MEMBERS } from '../src/sandbox/upstream-surface.ts'
import { SCRIPT_REGISTRY } from '../src/sandbox/preamble.ts'
import { SHARED_ORIGINAL } from '../src/sandbox/identity.ts'
import type { FromFrame, ToFrame } from '../src/sandbox/protocol.ts'

/** A frame realm made of stubs, plus the levers a test needs. */
function realm(): {
  posted: FromFrame[]
  send: (message: ToFrame) => void
  /** The globals the last evaluation was handed, by name. */
  globals: () => Record<string, unknown>
  /** Names the frame tried to define on its own window. */
  publishedNames: () => string[]
  /** Script ids the frame asked to be listed. */
  listed: () => string[]
  /** What a forwarding global currently reads. */
  forwarded: (name: string) => unknown
  /**
   * One published value.
   *
   * The per-script registry is reached through the window rather than handed in
   * as a shadowed parameter — module code has no parameters — so a harness that
   * only recorded names could not exercise the mechanism co-location rests on.
   */
  publishedValue: (name: string) => unknown
  /** What the next evaluation does with its globals. */
  run: (body: (globals: Record<string, unknown>) => void) => void
  /** Make the next module evaluation return this promise. */
  runAsync: (next: () => Promise<void>) => void
  container: { id: string }
} {
  const posted: FromFrame[] = []
  const listeners: ((message: ToFrame) => void)[] = []
  let handed: Record<string, unknown> = {}
  let published: string[] = []
  // The published *values* too: the per-script registry is reached through the
  // window rather than handed in as a shadowed parameter, so a test that only
  // saw names could not exercise it.
  let publishedValues: Record<string, unknown> = {}
  // Names the frame defined as forwarding getters, with their readers — the
  // mechanism that makes a waited-for global usable, which a harness recording
  // only published values could not see.
  const forwarded = new Map<string, () => unknown>()
  const listed: string[] = []
  let body: (globals: Record<string, unknown>) => void = () => undefined
  let asyncBody: (() => Promise<void>) | undefined
  const container = { id: 'card-root', querySelector: () => null, querySelectorAll: () => [] }

  const env: FrameEnv = {
    token: 'tok',
    container,
    factory: {
      createElement: tagName => ({ tagName }),
      createTextNode: data => ({ data }),
      createDocumentFragment: () => ({ fragment: true }),
    },
    // A stand-in for the frame's own window, with one real method to prove
    // pass-through keeps its binding.
    realWindow: {
      innerWidth: 320,
      setTimeout(): string {
        return this === undefined ? 'unbound' : 'bound'
      },
    },
    post: message => posted.push(message),
    defineForwarding: (name, read) => forwarded.set(name, read),
    listScript: id => { if (id !== undefined) listed.push(id) },
    onMessage: listener => listeners.push(listener),
    evaluate: (_source, mode, names, values) => {
      handed = Object.fromEntries(names.map((name, at) => [name, values[at]]))
      if (mode === 'module' && asyncBody !== undefined) return asyncBody()
      body(handed)
      return undefined
    },
    publishGlobals: entries => {
      published = entries.map(([name]) => name)
      publishedValues = Object.fromEntries(entries)
    },
  }

  installSandbox(env)
  return {
    posted,
    send: message => listeners.forEach(listener => listener(message)),
    globals: () => handed,
    publishedNames: () => published,
    publishedValue: (name: string) => publishedValues[name],
    forwarded: (name: string) => forwarded.get(name)?.(),
    listed: () => listed,
    run: next => {
      body = next
    },
    runAsync: next => {
      asyncBody = next
    },
    container,
  }
}

/** Ask the sandbox to evaluate, with `body` deciding what the "card" does. */
function evaluate(
  scope: ReturnType<typeof realm>,
  body: (globals: Record<string, unknown>) => void,
  scriptId?: string,
): void {
  /*
   * **An assertion inside the body has to be carried back out by hand.**
   *
   * The body runs where a card's body runs, which is inside the sandbox's own
   * try/catch — that is deliberate and correct in production: a card that throws
   * must be reported, not take the frame down with it. The consequence for this
   * file is severe, and it was live for a while: an assertion that failed inside
   * a body was caught, posted as a card error, and the test **passed**. A test
   * whose only assertions are in the body could not fail at all.
   *
   * Found by probing rather than by reading — a deliberately false assertion in
   * a body was still green.
   *
   * Only `AssertionError` is re-thrown. Several tests here throw from a body on
   * purpose, to check that a card's own failure is reported; those throws are
   * the subject under test and must stay inside.
   */
  let failure: unknown
  scope.run(globals => {
    try {
      body(globals)
    } catch (error) {
      if (error instanceof assert.AssertionError) failure = error
      else throw error
    }
  })
  scope.send({ iris: 'tok', type: 'run', code: '/* card */', mode: 'classic', scriptId })
  if (failure !== undefined) throw failure
}

test('installing announces nothing, because readiness is not this module to judge', () => {
  /*
   * `ready` used to be posted right here. It moved to the frame entry once the
   * frame began carrying the card's preset libraries: the shell answers `ready` by
   * immediately posting the card body, so announcing before Vue has loaded is a
   * race the card loses — and it loses it with `Vue is not defined`, a message
   * that names the symptom three steps downstream of the timing that caused it.
   *
   * Readiness depends on the document's subresources. This module deliberately
   * knows nothing about the document it is installed into, so it is not the thing
   * that can decide.
   */
  const scope = realm()
  assert.deepEqual(scope.posted, [], 'installing must not announce readiness')
})

test('exactly the outward-reaching names are shadowed', () => {
  const scope = realm()
  evaluate(scope, () => undefined)

  // The three outward-reaching names, plus the two bridged globals cards read
  // bare. `eventSource`, `event_types` and `TavernHelper` are absent on purpose:
  // unbridged, so a direct use should throw rather than find a stub.
  assert.deepEqual(Object.keys(scope.globals()), [
    'window',
    'self',
    'globalThis',
    'parent',
    'top',
    'SillyTavern',
    'extension_settings',
    'triggerSlash',
    'getScriptId',
    'EjsTemplate',
    'getVariables',
    'getAllVariables',
    'getLastMessageId',
    // All five are real now. They were stubs that answered and reported, which
    // was the right shape while there was no host arm and no bar — absence is
    // the one answer that breaks a card outright, since MVU calls three of them
    // while wiring up, before it has published anything.
    'getTavernHelperVersion',
    /*
     * Seeded because a card **calls** it: a bare identifier cannot be absent
     * politely, and `undefined` would only turn a `ReferenceError` into a
     * `TypeError` a line later. It reports and re-throws, as upstream does.
     */
    'errorCatched',
    'getScriptButtons',
    'getButtonEvent',
    'replaceScriptButtons',
    'appendInexistentScriptButtons',
    'updateScriptButtonsWith',
    'getCurrentMessageId',
    'getChatMessages',
    'getCharWorldbookNames',
    'getSwipes',
    'replaceVariables',
    'insertOrAssignVariables',
    'insertVariables',
    'deleteVariable',
    'updateVariablesWith',
    'getWorldbook',
    'replaceWorldbook',
    'updateWorldbookWith',
    'swipeTo',
    'generate',
    'substitudeMacros',
    'eventOn',
    'eventOnce',
    'eventMakeFirst',
    'eventMakeLast',
    'eventEmit',
    'eventRemoveListener',
    'eventClearEvent',
    'eventClearListener',
    'eventClearAll',
    'iframe_events',
    'tavern_events',
    'mvu_events',
    'TavernHelper',
  ])
})

test('window, self and globalThis are the same object a card can rely on', () => {
  const scope = realm()
  evaluate(scope, () => undefined)
  const globals = scope.globals()

  assert.equal(globals['window'], globals['self'])
  assert.equal(globals['window'], globals['globalThis'])
  assert.equal(globals['parent'], globals['top'])
  assert.notEqual(globals['window'], globals['parent'])
})

test('the card keeps its own realm through the window shadow', () => {
  // The shadow overrides three names and passes everything else through. A card
  // using `window.setTimeout` or its own DOM is doing nothing the sandbox cares
  // about, and breaking that would break every card for no gain.
  const scope = realm()
  evaluate(scope, globals => {
    const win = globals['window'] as Record<string, unknown>
    assert.equal(win['innerWidth'], 320)
    // Bound on the way out, or calling it off the proxy would be an illegal
    // invocation in a real browser.
    assert.equal((win['setTimeout'] as () => string)(), 'bound')
  })

  // `scriptId` rides on the outcome now: one frame runs a card's whole set, so
  // an unattributed `ran` would be credited to whichever script the shell was
  // tracking rather than the one that finished.
  assert.deepEqual(scope.posted.at(-1), { iris: 'tok', type: 'ran', scriptId: undefined })
})

test('parent.document is the virtual document, and body is the card container', () => {
  const scope = realm()
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    const doc = parent['document'] as Record<string, unknown>
    assert.equal(doc['body'], scope.container)
  })

  assert.equal(scope.posted.at(-1)?.type, 'ran')
})

test('the viewport a card reads is the one the shell reported', () => {
  const scope = realm()
  scope.send({ iris: 'tok', type: 'viewport', width: 1440, height: 900 })

  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    assert.equal(parent['innerWidth'], 1440)
    assert.equal(parent['innerHeight'], 900)
    const doc = parent['document'] as Record<string, unknown>
    const element = doc['documentElement'] as Record<string, unknown>
    assert.equal(element['clientWidth'], 1440)
  })

  assert.equal(scope.posted.at(-1)?.type, 'ran')
})

test('a resize reaches a card that reads the viewport again', () => {
  const scope = realm()
  scope.send({ iris: 'tok', type: 'viewport', width: 800, height: 600 })

  let read: (() => number) | undefined
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    read = () => parent['innerWidth'] as number
  })
  assert.equal(read?.(), 800)

  scope.send({ iris: 'tok', type: 'viewport', width: 1024, height: 768 })
  assert.equal(read?.(), 1024)
})

test('the three formerly-unbridged parent globals reach the same objects as the bare ones', () => {
  /*
   * `eventSource` (8 measured sites), `event_types` (6) and `TavernHelper` (1)
   * used to be `UNBRIDGED_GLOBALS` entries that refused with "not yet". They are
   * built now, and the rule was always that an entry is deleted the day its
   * bridge lands.
   *
   * Sameness is the assertion, not mere presence. Upstream's `eventOn` is a
   * wrapper around `eventSource`, so a card that subscribes through one name and
   * emits through the other is talking to itself — two separate buses would make
   * that silently stop working.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let bridged: Record<string, unknown> | undefined
  let bare: Record<string, unknown> | undefined
  evaluate(scope, globals => {
    bridged = (globals['parent'] as Record<string, unknown>) as Record<string, unknown>
    bare = globals
  })

  const source = bridged?.['eventSource'] as { on: (e: string, l: () => void) => void }
  const heard: string[] = []
  source.on('message_received', () => heard.push('via parent.eventSource'))
  void (bare?.['eventEmit'] as (event: string) => Promise<void>)('message_received')

  assert.equal(bridged?.['event_types'], bare?.['tavern_events'], 'one table, two names')
  assert.equal(bridged?.['TavernHelper'], bare?.['TavernHelper'], 'one surface, two routes')
  return Promise.resolve().then(() => {
    assert.deepEqual(heard, ['via parent.eventSource'], 'one bus, two names')
  })
})

/*
 * The "not yet" wording has no live example: `UNBRIDGED_GLOBALS` is empty, which
 * is the rule working rather than a gap. Whoever adds the next entry should add
 * the test back alongside it — the distinction it protects (unbuilt is not
 * forbidden, and a card author debugging needs the right one) still matters.
 */

test('an unpublished parent member yields undefined and is reported, not thrown', () => {
  /*
   * This used to throw, and the throw cost a verification round. Upstream's
   * cross-script coordination opens with `_.get(window.parent, path, default)` —
   * read a slot that does not exist yet, then write it — so throwing on that
   * first read threw inside an init that swallows exceptions, and the publish
   * every consumer was waiting for never happened.
   *
   * Returning `undefined` is what a real parent window does. Saying nothing is
   * what loses a missing host capability, so the frame yields like upstream and
   * speaks unlike it.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let read: unknown = 'unset'
  let threw = false
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    try {
      read = parent['toastr']
    } catch {
      threw = true
    }
  })

  assert.equal(threw, false, 'throwing here breaks read-with-default, which is how publishing starts')
  assert.equal(read, undefined)
  const said = scope.posted.filter(m => m.type === 'note').map(m => (m as { message: string }).message)
  assert.match(said.join(' '), /parent\.toastr/, 'yielding quietly is what loses a gap')
  assert.match(said.join(' '), /not a statement that the host has no such member/)
})

test('a nested read-with-default works, because that is how a card publishes', () => {
  /*
   * The exact shape MVU's uniqueness election uses:
   * `_.get(window.parent, 'th_unique_check.MVU', new Set())` then a write back.
   * A frame where the first read throws cannot host a card that coordinates.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let slot: unknown = 'unset'
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    const existing = parent['th_unique_check']
    parent['th_unique_check'] = existing ?? { MVU: new Set(['script-1']) }
    slot = parent['th_unique_check']
  })

  assert.deepEqual((slot as { MVU: Set<string> }).MVU, new Set(['script-1']))
})

test('a plain bug in a card is reported without a member', () => {
  const scope = realm()
  evaluate(scope, () => {
    throw new TypeError('undefined is not a function')
  })

  const last = scope.posted.at(-1)
  assert.ok(last?.type === 'error')
  assert.equal(last.member, undefined)
  assert.match(last.message, /not a function/)
})

test('writing to parent is refused', () => {
  const scope = realm()
  let caught: unknown
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    try {
      parent['document'] = {}
    } catch (error: unknown) {
      caught = error
    }
  })

  assert.ok(caught instanceof UnsupportedApiError)
})

test('reassigning parent through the window shadow is refused', () => {
  // Otherwise the first thing a card does is `window.parent = theRealThing`.
  const scope = realm()
  let caught: unknown
  evaluate(scope, globals => {
    const win = globals['window'] as Record<string, unknown>
    try {
      win['parent'] = {}
    } catch (error: unknown) {
      caught = error
    }
  })

  assert.ok(caught instanceof UnsupportedApiError)
})

test('a card may use its own realm as a namespace', () => {
  const scope = realm()
  evaluate(scope, globals => {
    const win = globals['window'] as Record<string, unknown>
    win['myCardState'] = 42
    assert.equal(win['myCardState'], 42)
  })

  assert.equal(scope.posted.at(-1)?.type, 'ran')
})

/** The host snapshot, shaped as the contract defines it. */
function snapshot(overrides?: Record<string, unknown>) {
  return {
    chat: [{ mes: 'hello', is_user: false, swipes: ['hello'], swipe_id: 0 }],
    chatMetadata: { yinqi_phone: { unread: 2 } },
    name1: 'You',
    name2: '络络',
    characters: [],
    extensionSettings: {},
    variables: { 好感度: 32 },
    ...overrides,
  } as never
}

test('SillyTavern is falsy until the snapshot arrives, then truthy', () => {
  // The order matters and the coordinator's reasoning decided it: a probe that
  // answers true before the data exists sends the card past the fallback and
  // into a failure further from its cause.
  const scope = realm()
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    assert.equal(parent['SillyTavern'], undefined)
  })

  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    assert.ok(parent['SillyTavern'], 'the probe 12 of 15 sites make must pass')
  })
  assert.equal(scope.posted.at(-1)?.type, 'ran')
})

test('the bridge answers both shapes cards are written against', () => {
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    // The bare global — the branch a compatibility-shaped card takes first.
    const bare = globals['SillyTavern'] as Record<string, unknown>
    // And through parent, which is the other measured shape.
    const viaParent = (globals['parent'] as Record<string, unknown>)['SillyTavern']
    assert.equal(bare, viaParent)

    // getContext() and direct member reads both work, as upstream's do.
    const context = (bare['getContext'] as () => Record<string, unknown>)()
    assert.equal(context['name2'], '络络')
    assert.equal(bare['name2'], '络络')
    assert.deepEqual(bare['chatMetadata'], { yinqi_phone: { unread: 2 } })
  })

  assert.equal(scope.posted.at(-1)?.type, 'ran')
})

test('extension_settings is reachable bare and through parent', () => {
  // The corpus has cards that try the bare global and fall back to the parent
  // one, so bridging a single path would miss whichever branch they took.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ extensionSettings: { seen: true } }) })

  evaluate(scope, globals => {
    const bare = globals['extension_settings'] as Record<string, unknown>
    const viaParent = (globals['parent'] as Record<string, unknown>)['extension_settings']
    assert.equal(bare, viaParent)
    assert.equal(bare['seen'], true)
  })

  assert.equal(scope.posted.at(-1)?.type, 'ran')
})

test('a write into extension settings is reported, not swallowed', () => {
  // The read-or-initialise-then-write-back shape. Without this the card
  // recomputes the same value on every run and stores it into a discarded
  // snapshot — the same result forever, with no sound.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    const settings = globals['extension_settings'] as Record<string, unknown>
    if (settings['xierStatusRule'] === undefined) settings['xierStatusRule'] = 'computed'
  })

  const reported = scope.posted.filter(message => message.type === 'settings')
  assert.equal(reported.length, 1)
  assert.ok(reported[0]?.type === 'settings')
  assert.deepEqual(reported[0].settings, { xierStatusRule: 'computed' })
})

test('a member the bridge does not carry is named in a report, not thrown', () => {
  /*
   * The context is the keys cards were measured to touch, not the 145 ST has. A
   * card reaching outside that set must still be told **which** member — but by
   * being told, not by being interrupted.
   *
   * This test asserted a throw until the surface was brought into line with the
   * virtual parent, which had already learned the lesson and paid for it: every
   * measured `SillyTavern` access in the corpus sits behind a truthiness guard,
   * so `if (ctx.setVariable)` — a card degrading on purpose — threw at the read
   * and the guard triggered what it existed to prevent.
   *
   * What is asserted has therefore changed shape but not intent: absence is
   * still named. Both halves are checked, because either alone is the wrong
   * behaviour — silent `undefined` loses the diagnosis, and a report without a
   * usable return value does not fix the guard.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  let read: unknown = 'unset'
  let threw = false
  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    try {
      read = bare['generateQuietPrompt']
    } catch {
      threw = true
    }
  })

  assert.equal(threw, false, 'throwing here breaks the truthiness guards every measured card uses')
  assert.equal(read, undefined, 'upstream yields undefined for an absent property')

  const reports = scope.posted.filter(message => message.type === 'note')
  assert.ok(
    reports.some(message => message.type === 'note' && message.message.includes('generateQuietPrompt')),
    'the member was not named anywhere — silence is what turns a gap into a failure three steps away',
  )
})

test('a member read in a loop is reported once, not once per read', () => {
  // A card polling a slot would otherwise turn one gap into a stream, which is
  // the failure the card-report list was introduced to end.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    for (let turn = 0; turn < 5; turn += 1) void bare['generateQuietPrompt']
  })

  const named = scope.posted.filter(
    message => message.type === 'note' && message.message.includes('generateQuietPrompt'),
  )
  assert.equal(named.length, 1)
})

test('`in` and a read agree about an unbuilt member', () => {
  /*
   * They did not. `has` returned `false` while `get` threw, so `'x' in
   * SillyTavern` and `SillyTavern.x` disagreed about the same name — found by
   * probing the surface rather than by reading it. Consistency here is a
   * consequence of the change above rather than a separate fix, which is exactly
   * why it needs its own assertion: nothing else would notice it regressing.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    assert.equal('deleteAllChats' in bare, false)
    assert.equal(bare['deleteAllChats'], undefined)
  })
})

test('the bridged globals are published, and the window aliases are not', () => {
  // Module code cannot be handed shadowed parameters, so in module mode the
  // published globals are the only bridge — which is how upstream does it too: a
  // classic script flattens its API onto the child window before the module runs.
  //
  // `window` / `self` / `globalThis` are excluded because redefining them is not
  // ours to do and would be circular anyway.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  evaluate(scope, () => undefined)

  assert.deepEqual(scope.publishedNames(), [
    'parent',
    'top',
    'SillyTavern',
    'extension_settings',
    'triggerSlash',
    'getScriptId',
    'EjsTemplate',
    'getVariables',
    'getAllVariables',
    'getLastMessageId',
    // All five are real now. They were stubs that answered and reported, which
    // was the right shape while there was no host arm and no bar — absence is
    // the one answer that breaks a card outright, since MVU calls three of them
    // while wiring up, before it has published anything.
    'getTavernHelperVersion',
    /*
     * Seeded because a card **calls** it: a bare identifier cannot be absent
     * politely, and `undefined` would only turn a `ReferenceError` into a
     * `TypeError` a line later. It reports and re-throws, as upstream does.
     */
    'errorCatched',
    'getScriptButtons',
    'getButtonEvent',
    'replaceScriptButtons',
    'appendInexistentScriptButtons',
    'updateScriptButtonsWith',
    'getCurrentMessageId',
    'getChatMessages',
    'getCharWorldbookNames',
    'getSwipes',
    'replaceVariables',
    'insertOrAssignVariables',
    'insertVariables',
    'deleteVariable',
    'updateVariablesWith',
    'getWorldbook',
    'replaceWorldbook',
    'updateWorldbookWith',
    'swipeTo',
    'generate',
    'substitudeMacros',
    'eventOn',
    'eventOnce',
    'eventMakeFirst',
    'eventMakeLast',
    'eventEmit',
    'eventRemoveListener',
    'eventClearEvent',
    'eventClearListener',
    'eventClearAll',
    'iframe_events',
    'tavern_events',
    'mvu_events',
    'TavernHelper',
    // The per-script registry, published with the rest so a failure to define
    // it is reported like anything else — rather than leaving co-located scripts
    // to fail on a preamble whose lookup does not exist.
    '__iris_script__',
  ])
})

test('a module body reports ran only after it has loaded', async () => {
  // A module loads asynchronously, so `ran` cannot be posted on the next line.
  // Getting this wrong would report success before the card had done anything.
  const scope = realm()
  let release: (() => void) | undefined
  scope.runAsync(
    () =>
      new Promise<void>(resolve => {
        release = resolve
      }),
  )
  scope.send({ iris: 'tok', type: 'run', code: 'export {}', mode: 'module', scriptId: undefined })

  assert.equal(scope.posted.some(message => message.type === 'ran'), false, 'ran was posted too early')
  release?.()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(scope.posted.at(-1)?.type, 'ran')
})

test('a module that fails to load is reported as an error, not as a run', async () => {
  const scope = realm()
  scope.runAsync(() => Promise.reject(new SyntaxError('Cannot use import statement outside a module')))
  scope.send({ iris: 'tok', type: 'run', code: 'import "x"', mode: 'module' , scriptId: undefined })

  await Promise.resolve()
  await Promise.resolve()
  const last = scope.posted.at(-1)
  assert.ok(last?.type === 'error')
  assert.match(last.message, /import statement/)
})

test('triggerSlash exists so the probe that guards it cannot fail silently', () => {
  // The measured call site is `if (typeof triggerSlash === 'function')`. An
  // undefined global makes the card skip the branch without a sound, which is the
  // failure mode this sandbox keeps choosing against. A definition that hands the
  // string onward is a card that visibly did something.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    assert.equal(typeof globals['triggerSlash'], 'function')
  })

  assert.equal(scope.posted.at(-1)?.type, 'ran')
})

test('a slash command travels raw, unparsed', () => {
  // Parsing means reproducing upstream's pipe escaping, and that semantic already
  // exists once host-side. A second copy in the browser is the shape that caused
  // this project's worst bug, where two halves each held their own idea of a
  // convention and agreed only in tests.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    const trigger = globals['triggerSlash'] as (command: string) => Promise<void>
    void trigger('/send 你好|/trigger')
  })

  const sent = scope.posted.find(message => message.type === 'slash')
  assert.ok(sent?.type === 'slash')
  assert.equal(sent.command, '/send 你好|/trigger', 'the shell must receive exactly what the card wrote')
})

test('triggerSlash returns something awaitable', () => {
  // Upstream's returns a promise. Returning undefined would make `.then()` on it
  // a TypeError in any card that chains — even though the measured call site does
  // not. The promise resolves on dispatch, not completion, which is a documented
  // deviation rather than a hidden one.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  let returned: unknown
  evaluate(scope, globals => {
    returned = (globals['triggerSlash'] as (command: string) => unknown)('/trigger')
  })

  assert.ok(returned instanceof Promise)
})

test('the actions are reachable both directly and through getContext', () => {
  // The gap a real card found: data members were reachable both ways and the
  // actions neither. Upstream exposes both — `SillyTavern.saveMetadata` at six
  // measured sites, `context.saveChat` at eight, and MVU's own bundle calling
  // `SillyTavern.saveChat` directly.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    const viaContext = (bare['getContext'] as () => Record<string, unknown>)()

    for (const name of ['saveChat', 'saveMetadata', 'generateRaw']) {
      assert.equal(typeof bare[name], 'function', `${name} missing from the facade`)
      assert.equal(typeof viaContext[name], 'function', `${name} missing from getContext()`)
    }
    // One surface, two entry points — not two objects that could drift.
    assert.equal(bare, viaContext)
  })

  assert.equal(scope.posted.at(-1)?.type, 'ran')
})

test('saveMetadata sends the metadata the card has been mutating', () => {
  // Upstream takes no argument: a card mutates `chatMetadata` in place and then
  // asks for it to be saved. Sending whatever the card passed would save nothing
  // it had changed.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    void (bare['saveMetadata'] as () => Promise<unknown>)()
  })

  const call = scope.posted.find(message => message.type === 'call')
  assert.ok(call?.type === 'call')
  assert.equal(call.method, 'saveMetadata')
  assert.deepEqual(call.params, { metadata: { yinqi_phone: { unread: 2 } } })
})

test('an unmeasured call shape is refused by name rather than guessed at', () => {
  // `generateRaw`'s upstream signature varies by caller. Guessing would send a
  // malformed request that fails as a host error rather than as a shape problem,
  // and the next real card would teach us nothing.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  let caught: unknown
  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    try {
      void (bare['generateRaw'] as (...args: unknown[]) => unknown)(42)
    } catch (error: unknown) {
      caught = error
    }
  })

  assert.ok(caught instanceof UnsupportedApiError)
  assert.match(caught.message, /has not been measured yet/)
  assert.match(caught.message, /number/, 'the refusal should say what it actually got')
})

test('a member outside the measured set is still reported', () => {
  /*
   * The original point of this test survives the policy change and is worth
   * keeping separate from the one above: the earlier gap here was a **missing
   * entry point**, not a refusal that was too wide, and widening what the bridge
   * silently tolerates is not the fix. Every unbuilt member is still named.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    assert.equal(bare['deleteAllChats'], undefined)
  })

  assert.ok(
    scope.posted.some(
      message => message.type === 'note' && message.message.includes('deleteAllChats'),
    ),
    'an unbuilt member went unnamed',
  )
})

test('getScriptId answers with the id the runner dispatched', () => {
  const scope = realm()
  let answered: unknown
  evaluate(
    scope,
    globals => {
      answered = (globals['getScriptId'] as () => unknown)()
    },
    'script-7',
  )

  assert.equal(answered, 'script-7', 'the card must be able to name the script it is')
})

test('getScriptId answers undefined for a body with no entry in the list', () => {
  /*
   * A file dragged in from disk has no id, and neither does the probe. Answering
   * with a synthesised one would be worse than answering with nothing: cards use
   * this to key `getVariables({type:'script'})`, so an id invented per run would
   * write state into a scope that cannot be read back on the next one.
   */
  const scope = realm()
  let answered: unknown = 'unset'
  evaluate(scope, globals => {
    answered = (globals['getScriptId'] as () => unknown)()
  })

  assert.equal(answered, undefined, 'an unidentified body must not be given an id')
})

test('a reused frame keeps one shared identity across runs', () => {
  /*
   * This test used to assert the opposite, and both versions were right for
   * their own arrangement. When a frame ran exactly one script, re-answering per
   * run was correct — the probe reuses its frame, and each run genuinely was a
   * different script.
   *
   * A frame now holds a whole card, and every run in it is a *sibling*. Code the
   * card imports reads this shared global, so a value that moved between runs
   * would move underneath a bundle between two of its own calls. Per-script
   * identity did not disappear; it moved to the preamble, which is the only
   * place that can be right about it.
   *
   * The probe is unaffected: it builds a new frame per run, so nothing is fixed
   * across the scripts it observes.
   */
  const scope = realm()
  const seen: unknown[] = []
  const record = (globals: Record<string, unknown>): void => {
    seen.push((globals['getScriptId'] as () => unknown)())
  }
  evaluate(scope, record, 'first')
  evaluate(scope, record, 'second')

  assert.deepEqual(seen, ['first', 'first'])
})

test('a host event forwarded by the shell reaches a listener the card registered', async () => {
  /*
   * The whole point of the bus being the frame's: a card subscribes before any
   * host event exists, and the shell posts into that same bus later.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  const heard: unknown[] = []
  evaluate(scope, globals => {
    ;(globals['eventOn'] as (event: string, listener: (value: unknown) => void) => void)(
      'message_received',
      value => heard.push(value),
    )
  })

  scope.send({ iris: 'tok', type: 'event', event: 'message_received', args: [7] })
  // The bus awaits each listener, so the emit settles a microtask later.
  await Promise.resolve()

  assert.deepEqual(heard, [7])
})

test('a card emitting on its own bus does not put the event on the wire', () => {
  /*
   * Measured on MVU: 53 emit sites against 17 subscriptions, so most of what a
   * card emits it is saying to itself. Forwarding that outward would be traffic
   * nobody reads, and would let a card's internal names reach the shell.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  evaluate(scope, globals => {
    void (globals['eventEmit'] as (event: string) => Promise<void>)('mag_command_parsed')
  })

  assert.equal(
    scope.posted.some(message => (message as { type: string }).type === 'event'),
    false,
    'the frame must not post its own emissions outward',
  )
})

test('a card can publish to its own scripts through parent, and take it back', async () => {
  /*
   * The mechanism a real provider uses. MVU writes
   * `_.set(window.parent, 'Mvu', mvu)` and removes it with `_.unset` on
   * teardown; upstream's own `initializeGlobal` writes to the parent window too.
   * There is no version of this feature that does not involve writing to parent.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let readBack: unknown
  let presentAfterDelete = true
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    parent['Mvu'] = { getMvuData: () => 'data' }
    readBack = (parent['Mvu'] as { getMvuData: () => string }).getMvuData()
    delete parent['Mvu']
    presentAfterDelete = 'Mvu' in parent
  })

  assert.equal(readBack, 'data', 'a published interface must be usable, not just stored')
  assert.equal(presentAfterDelete, false, 'a provider must be able to retract its interface')
})

test('hasOwnProperty sees a published name, because that is what the poll uses', () => {
  /*
   * `waitGlobalInitialized` polls with lodash `_.has`, which is built on
   * `hasOwnProperty` — and `hasOwnProperty` does not go through the proxy's
   * `has` trap. Without `getOwnPropertyDescriptor` the poll answers false
   * forever while `in` answers true, and the feature fails with both halves
   * looking correct.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let owned = false
  let listed: string[] = []
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    parent['Mvu'] = 1
    owned = Object.prototype.hasOwnProperty.call(parent, 'Mvu')
    listed = Object.keys(parent)
  })

  assert.equal(owned, true, 'the trap lodash actually reaches')
  assert.deepEqual(listed, ['Mvu'], 'and only what this card published')
})


test('a bridged member cannot be overwritten by a card', () => {
  // Publishing is for names the frame does not own. Letting a card assign
  // `parent.document` would let it redefine the frame's view of the host.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let caught: unknown
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    try {
      parent['document'] = { evil: true }
    } catch (error: unknown) {
      caught = error
    }
  })

  assert.ok(caught instanceof UnsupportedApiError)
  assert.match(caught.message, /not writable/)
})

test('two co-located scripts get their own identity, from one frame', () => {
  /*
   * The property the whole cohabitation design exists to preserve. Upstream
   * gives each script its own frame, so "who is asking" is answered by the frame
   * itself; sharing a realm means a single `getScriptId` would answer for
   * whichever script ran last, and sixteen members depend on that answer.
   *
   * This exercises the registry the preamble reads from, which is the mechanism
   * the module-scope bindings are built out of.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  const seen: unknown[] = []
  evaluate(scope, globals => {
    void globals
    const registry = scope.publishedValue('__iris_script__') as (id: string) => Record<string, unknown>
    seen.push((registry('first')['getScriptId'] as () => unknown)())
    seen.push((registry('second')['getScriptId'] as () => unknown)())
  })

  assert.deepEqual(seen, ['first', 'second'], 'one frame must still answer per script')
})

test('a co-located script tears down only its own listeners', async () => {
  /*
   * Measured upstream: the listener registry is keyed by iframe name and
   * `eventClearAll` deletes only that frame's entry, fired on `pagehide`. One
   * frame per card would turn that into a card-wide wipe, and the symptom — an
   * event that stops arriving — is indistinguishable from one never emitted.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  const heard: string[] = []
  let emit: ((event: string) => Promise<void>) | undefined
  evaluate(scope, globals => {
    const registry = scope.publishedValue('__iris_script__') as (id: string) => Record<string, unknown>
    const one = registry('one')
    const two = registry('two')
    ;(one['eventOn'] as (e: string, l: () => void) => void)('tick', () => heard.push('one'))
    ;(two['eventOn'] as (e: string, l: () => void) => void)('tick', () => heard.push('two'))
    ;(one['eventClearAll'] as () => void)()
    emit = globals['eventEmit'] as (event: string) => Promise<void>
  })

  await emit?.('tick')

  assert.deepEqual(heard, ['two'], "a sibling's listener was removed by a teardown that was not its own")
})

test('a consumer waiting on a provider resolves when the provider publishes', async () => {
  /*
   * The whole point of the feature, in one frame. OVERLORD's shape: one script
   * imports a bundle that publishes `Mvu`, three others wait for it before doing
   * anything.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let waited: Promise<void> | undefined
  let published = false
  evaluate(scope, () => {
    const registry = scope.publishedValue('__iris_script__') as (id: string) => Record<string, unknown>
    const consumer = registry('consumer')
    const provider = registry('provider')
    waited = (consumer['waitGlobalInitialized'] as (n: string) => Promise<void>)('Mvu').then(() => {
      published = true
    })
    ;(provider['initializeGlobal'] as (n: string, v: unknown) => void)('Mvu', { ok: true })
  })

  await waited
  assert.equal(published, true, 'the consumer never saw its provider')
  assert.deepEqual(
    scope.posted.filter(m => m.type === 'waiting').map(m => (m as { global: string }).global),
    ['Mvu'],
    'the wait is reported, because hanging is the failure with no voice',
  )
  const done = scope.posted.filter(m => m.type === 'waited')[0] as { arrived: boolean, scriptId: string }
  assert.equal(done.arrived, true)
  assert.equal(done.scriptId, 'consumer', 'the report names who was waiting')
})

test('a global already published resolves without reporting a wait', async () => {
  // A consumer that runs after its provider must not be reported as blocked;
  // otherwise the ordinary case looks like the failure case.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let settled: Promise<void> | undefined
  evaluate(scope, () => {
    const registry = scope.publishedValue('__iris_script__') as (id: string) => Record<string, unknown>
    ;(registry('provider')['initializeGlobal'] as (n: string, v: unknown) => void)('Mvu', 1)
    settled = (registry('consumer')['waitGlobalInitialized'] as (n: string) => Promise<void>)('Mvu')
  })

  await settled
  assert.deepEqual(scope.posted.filter(m => m.type === 'waiting'), [])
})

test('a stalled import says whether the fetch or the imported module is at fault', async () => {
  /*
   * One sentence for two very different failures is what made a production
   * regression unreadable: "import timed out" cannot distinguish a fetch that
   * never returned from an imported module that hangs on its own.
   *
   * Imports are hoisted, so the module body running at all proves every static
   * import was fetched and evaluated. The preamble's registry call is the first
   * statement of every co-located body, which makes "did the body begin" free to
   * collect and decisive to know.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  // A body that began: it reached the registry before its import stalled.
  scope.runAsync(async () => {
    scope.publishedValue('__iris_script__')
    ;(scope.publishedValue('__iris_script__') as (id: string) => unknown)('slow')
    throw new Error('import timed out after 15s — the module never finished loading')
  })
  scope.send({ iris: 'tok', type: 'run', code: 'x', mode: 'module', scriptId: 'slow' })
  await new Promise(resolve => setTimeout(resolve, 5))

  const reported = scope.posted.filter(m => m.type === 'error').at(-1) as { message: string }
  assert.match(reported.message, /the body had begun, so the imported module is stalling on its own/)
})

test('a stalled import with no body blames the fetch', async () => {
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  scope.runAsync(async () => {
    throw new Error('import timed out after 15s — the module never finished loading')
  })
  scope.send({ iris: 'tok', type: 'run', code: 'x', mode: 'module', scriptId: 'never' })
  await new Promise(resolve => setTimeout(resolve, 5))

  const reported = scope.posted.filter(m => m.type === 'error').at(-1) as { message: string }
  assert.match(reported.message, /the body never began, so this is the fetch itself/)
})

test('a waited-for global becomes usable, and follows the provider if it is withdrawn', async () => {
  /*
   * Waiting is only half of the contract. Upstream's description is explicit —
   * it resolves *and* makes the name available in the calling iframe — and a
   * real card proved why: `await waitGlobalInitialized('Mvu')` succeeded and the
   * next line still threw `Mvu is not defined`.
   *
   * A forwarding getter rather than a copy, because a provider can retract its
   * interface on teardown and a snapshot would leave consumers holding an object
   * that has been withdrawn.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let waited: Promise<void> | undefined
  evaluate(scope, globals => {
    const registry = scope.publishedValue('__iris_script__') as (id: string) => Record<string, unknown>
    waited = (registry('consumer')['waitGlobalInitialized'] as (n: string) => Promise<void>)('Mvu')
    // Exactly what MVU does: a raw write to parent, then the announcement.
    // The write alone does not wake a waiter — upstream keys on the event too —
    // so a fixture that only wrote would be testing a provider no card is.
    ;(globals['parent'] as Record<string, unknown>)['Mvu'] = { version: 1 }
    void (globals['eventEmit'] as (event: string) => Promise<void>)('global_Mvu_initialized')
  })
  await waited

  assert.deepEqual(scope.forwarded('Mvu'), { version: 1 }, 'the name never became usable')

  // The provider retracts it, as MVU does on teardown.
  evaluate(scope, globals => {
    delete (globals['parent'] as Record<string, unknown>)['Mvu']
  })
  assert.equal(scope.forwarded('Mvu'), undefined, 'a copy would still be handing out a dead object')
})

test('a wait that has not been answered stays open, and defines nothing yet', async () => {
  /*
   * There is no timeout to test any more, and its removal was the fix. Upstream
   * never bounds this wait; the five seconds here came from the Mvu `stat_data`
   * poll, which runs *after* the global is present. Applied to the wait itself
   * it became a race that a cold fetch loses — and every chat is a fresh opaque
   * origin, so a card's bundle is always a cold fetch.
   *
   * So an unanswered wait simply stays open. It reports that it is waiting, and
   * it defines nothing: a getter over an absent value would hand the card
   * `undefined` where a `ReferenceError` names the problem.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let settled = false
  evaluate(scope, () => {
    const registry = scope.publishedValue('__iris_script__') as (id: string) => Record<string, unknown>
    void (registry('consumer')['waitGlobalInitialized'] as (n: string) => Promise<void>)('Absent').then(
      () => {
        settled = true
      },
    )
  })
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(settled, false, 'the wait must not resolve on its own')
  assert.equal(scope.forwarded('Absent'), undefined, 'and must not define an absent name')
  const reported = scope.posted.filter(m => m.type === 'waiting')
  assert.equal(reported.length, 1, 'it says once that it is waiting')
})

test('a module knowingly waiting is not declared stalled by the deadline', async () => {
  /*
   * Two rules contradicted each other. The wait is unbounded on purpose —
   * upstream never abandons one — while the module deadline calls anything
   * unfinished after fifteen seconds stalled. A module parked on a named global
   * has not stalled, and the deadline speaking over it did two kinds of damage:
   * it reported a healthy park as a failure, and it *erased the state naming
   * what the module was waiting for*.
   *
   * That erasure is why two verification rounds could not distinguish a waiter
   * that was woken from one that never ran: both ended on the same sentence.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  // A body that parks on a global nobody will publish, then hits the deadline.
  scope.runAsync(async () => {
    const registry = scope.publishedValue('__iris_script__') as (id: string) => Record<string, unknown>
    void (registry('consumer')['waitGlobalInitialized'] as (n: string) => Promise<void>)('Mvu')
    await Promise.resolve()
    throw new Error('still evaluating after 15s — this module has no remote imports')
  })
  scope.send({ iris: 'tok', type: 'run', code: 'x', mode: 'module', scriptId: 'consumer' })
  await new Promise(resolve => setTimeout(resolve, 20))

  const errors = scope.posted.filter(m => m.type === 'error')
  assert.deepEqual(errors, [], 'a knowing wait must not be reported as a failure')
  const waits = scope.posted.filter(m => m.type === 'waiting') as { global: string }[]
  assert.ok(waits.length >= 2, 'the wait is re-announced instead of being overwritten')
  assert.equal(waits.at(-1)?.global, 'Mvu', 'and it still names what it waits on')
})

test('a module with no known reason to be stuck is still declared stalled', async () => {
  // The deadline keeps its job. Standing down for a *known* wait is not the same
  // as standing down.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  scope.runAsync(async () => {
    throw new Error('still evaluating after 15s — this module has no remote imports')
  })
  scope.send({ iris: 'tok', type: 'run', code: 'x', mode: 'module', scriptId: 'quiet' })
  await new Promise(resolve => setTimeout(resolve, 20))

  const errors = scope.posted.filter(m => m.type === 'error')
  assert.equal(errors.length, 1)
})

test('the shared getScriptId never changes underneath a reader', () => {
  /*
   * The invariant an imported bundle depends on. A card body gets its true
   * identity from the preamble; code it *imports* is its own module and reads the
   * global instead, so a value that moved with each run could differ between two
   * of that bundle's own calls.
   *
   * MVU registers under `getScriptId()` and later enables itself only when
   * `preferred === getScriptId()`. Those two reads must agree, and nothing the
   * card can see would explain it if they did not.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  const seen: unknown[] = []
  const read = (globals: Record<string, unknown>): void => {
    seen.push((globals['getScriptId'] as () => unknown)())
  }
  evaluate(scope, read, 'provider')
  evaluate(scope, read, 'consumer-one')
  evaluate(scope, read, 'consumer-two')

  assert.deepEqual(seen, ['provider', 'provider', 'provider'], 'the shared answer must not move')
})

test('a per-script binding still answers for its own script', () => {
  // Fixing the shared global must not flatten the per-script identity: the
  // preamble's bindings are what keep sixteen members answering correctly.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  const seen: unknown[] = []
  evaluate(scope, () => {
    const registry = scope.publishedValue('__iris_script__') as (id: string) => Record<string, unknown>
    seen.push((registry('one')['getScriptId'] as () => unknown)())
    seen.push((registry('two')['getScriptId'] as () => unknown)())
  }, 'one')

  assert.deepEqual(seen, ['one', 'two'])
})

test('each run is listed once, in card order', () => {
  /*
   * The list a card's election reads. Listed once per script because an election
   * that takes the last match would otherwise depend on how many times a script
   * had been run rather than on which scripts exist.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  evaluate(scope, () => undefined, 'first')
  evaluate(scope, () => undefined, 'second')
  evaluate(scope, () => undefined, 'first')

  assert.deepEqual(scope.listed(), ['first', 'second', 'first'], 'the frame reports every run')
})

test('a metadata edit survives a snapshot refresh landing before the save', () => {
  /*
   * The idiom this protects, which is upstream’s and is documented on
   * `saveMetadata` itself: a card **mutates `chatMetadata` in place** and then
   * asks for it to be saved. Upstream can do that because its metadata object
   * is the live one in the same realm.
   *
   * Ours is a snapshot, and snapshots are now replaced wholesale on every
   * `chat.updated` and `stream.end` — which is new, and is what makes this
   * reachable. Between a card writing a key and calling `saveMetadata`, any
   * reply settling anywhere in the chat swaps the object out from under it. The
   * write is then not merely lost: the save proceeds, reports success, and
   * stores the version without it.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  let bridge: Record<string, unknown> | undefined
  evaluate(scope, globals => {
    bridge = globals['SillyTavern'] as Record<string, unknown>
  })

  // The card writes, the way upstream tells it to.
  const metadata = bridge?.['chatMetadata'] as Record<string, unknown>
  metadata['iris_test_key'] = 'written by the card'

  // A reply settles somewhere in the chat. Nothing to do with this card.
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  // Only now does the card get round to saving.
  void (bridge?.['saveMetadata'] as () => unknown)()

  const call = scope.posted.find(
    message => message.type === 'call' && message.method === 'saveMetadata',
  )
  assert.ok(call?.type === 'call', 'the save never reached the host')

  const sent = (call.params as { metadata?: Record<string, unknown> }).metadata ?? {}
  assert.equal(
    sent['iris_test_key'],
    'written by the card',
    'the refresh discarded the card’s edit, and the save reported success anyway',
  )
})

test('everything except the metadata still refreshes', () => {
  /*
   * The other half of the fix above, and the reason it is a separate test: the
   * cheapest way to stop a refresh from discarding a write is to stop
   * refreshing, and that would pass the previous test perfectly while undoing
   * the live-snapshot work entirely. A card would then read the floor it was
   * built with forever, which is the bug the refresh exists to fix.
   *
   * So the exemption is asserted to be exactly one field wide.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  let bridge: Record<string, unknown> | undefined
  evaluate(scope, globals => {
    bridge = globals['SillyTavern'] as Record<string, unknown>
  })

  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({
      chat: [{ mes: 'a newer floor', is_user: false, swipes: ['a newer floor'], swipe_id: 0 }],
      name2: '新的名字',
    }),
  })

  const chat = (bridge as Record<string, unknown>)['chat'] as { mes: string }[]
  assert.equal(
    chat[0]?.mes,
    'a newer floor',
    'the chat stopped refreshing — the exemption is too wide',
  )
  assert.equal(
    (bridge as Record<string, unknown>)['name2'],
    '新的名字',
    'an ordinary field stopped refreshing',
  )
})

test('a nested metadata edit survives too, which is what the real card makes', () => {
  /*
   * The measured shape, from the one card in the corpus that calls
   * `updateChatMetadata` (`银麒赎世`, its phone UI):
   *
   *   var meta = SillyTavern.chatMetadata || {}
   *   if (!meta.yinqi_phone) meta.yinqi_phone = {}
   *   meta.yinqi_phone[key] = value          // in place, and **nested**
   *   SillyTavern.updateChatMetadata({ yinqi_phone: meta.yinqi_phone }, false)
   *
   * So the object the card actually writes into is one level down. Carrying the
   * top-level object across a refresh only helps because the nested objects
   * come with it by reference — which is true, and is exactly the sort of
   * "true today" that deserves an assertion rather than a paragraph.
   *
   * The window this protects is not instantaneous: that card saves on a 2000ms
   * debounce which every further keystroke resets, so under continuous use it
   * stays open indefinitely, and what would be lost is every write since the
   * last save rather than one.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  let bridge: Record<string, unknown> | undefined
  evaluate(scope, globals => {
    bridge = globals['SillyTavern'] as Record<string, unknown>
  })

  const meta = bridge?.['chatMetadata'] as Record<string, Record<string, unknown> | undefined>
  const phone = meta['yinqi_phone']
  assert.ok(phone !== undefined, 'the fixture lost its nested object')
  phone['unread'] = 7

  // A reply settles while the card is still inside its debounce.
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  void (bridge?.['saveMetadata'] as () => unknown)()

  const call = scope.posted.find(
    message => message.type === 'call' && message.method === 'saveMetadata',
  )
  assert.ok(call?.type === 'call')
  const sent = (call.params as { metadata?: Record<string, Record<string, unknown>> }).metadata
  assert.equal(
    sent?.['yinqi_phone']?.['unread'],
    7,
    'the nested edit was lost — carrying the top-level object is not enough',
  )
})

/**
 * A frame with a snapshot delivered and the SillyTavern surface in hand.
 *
 * The metadata is overridable because the default fixture cannot tell a shallow
 * merge from a deep one: its nested object holds a single key, so both produce
 * the same result. Discovered by mutating the code to merge deeply and watching
 * the test that exists to forbid that pass anyway.
 */
function withBridge(chatMetadata?: Record<string, unknown>) {
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: chatMetadata === undefined ? snapshot() : snapshot({ chatMetadata }),
  })
  let bridge: Record<string, unknown> | undefined
  evaluate(scope, globals => {
    bridge = globals['SillyTavern'] as Record<string, unknown>
  })
  return { scope, bridge: bridge as Record<string, unknown> }
}

test('updateChatMetadata merges one level deep, exactly as upstream does', () => {
  /*
   * `chat_metadata = { ...chat_metadata, ...newValues }` (`script.js:8918`).
   * One level. Replacing a nested key discards its siblings, and a deep merge is
   * the friendlier behaviour that would silently keep keys upstream drops.
   *
   * **The nested object needs a sibling key or this test cannot fail.** With a
   * single-key nested object, shallow and deep merge agree, so the assertion
   * passes under either implementation — which it did, until a mutation that
   * should have reddened it did nothing. `muted` is here so the two disagree.
   */
  const { bridge } = withBridge({ yinqi_phone: { unread: 2, muted: true } })
  const update = bridge['updateChatMetadata'] as (values: unknown, reset?: unknown) => void

  update({ yinqi_phone: { unread: 9 } })

  const meta = bridge['chatMetadata'] as Record<string, Record<string, unknown>>
  assert.deepEqual(
    meta['yinqi_phone'],
    { unread: 9 },
    'the sibling key survived, so this merged deeply — upstream drops it',
  )
})

test('updateChatMetadata keeps sibling top-level keys', () => {
  const { bridge } = withBridge()
  const update = bridge['updateChatMetadata'] as (values: unknown, reset?: unknown) => void

  update({ another: 'key' })

  const meta = bridge['chatMetadata'] as Record<string, unknown>
  assert.deepEqual(meta['yinqi_phone'], { unread: 2 }, 'an untouched key was dropped')
  assert.equal(meta['another'], 'key')
})

test('reset replaces the whole of the metadata', () => {
  const { bridge } = withBridge()
  const update = bridge['updateChatMetadata'] as (values: unknown, reset?: unknown) => void

  update({ only: 'this' }, true)

  assert.deepEqual(bridge['chatMetadata'], { only: 'this' })
})

test('updateChatMetadata does not save, because upstream does not', () => {
  /*
   * Persistence is `saveMetadata`, separately. The corpus’s one caller debounces
   * that by 2000ms and has an explicit `skipSave` path, so folding a write in
   * here would defeat a debounce its author chose and remove a capability they
   * use. "It obviously should persist" is the improvement this refuses.
   */
  const { scope, bridge } = withBridge()
  const update = bridge['updateChatMetadata'] as (values: unknown, reset?: unknown) => void

  update({ written: true })

  assert.equal(
    scope.posted.some(message => message.type === 'call'),
    false,
    'updating metadata reached the host, which upstream never does',
  )
})

test('an update is visible to the save that follows it', () => {
  // The two halves of the idiom, joined: update publishes, save persists.
  const { scope, bridge } = withBridge()
  const update = bridge['updateChatMetadata'] as (values: unknown, reset?: unknown) => void

  update({ written: true })
  void (bridge['saveMetadata'] as () => unknown)()

  const call = scope.posted.find(
    message => message.type === 'call' && message.method === 'saveMetadata',
  )
  assert.ok(call?.type === 'call')
  assert.equal(
    (call.params as { metadata?: Record<string, unknown> }).metadata?.['written'],
    true,
  )
})

test('a card feature-testing with `in` finds updateChatMetadata', () => {
  // It is built in the frame, so the method table does not know about it. Every
  // measured `SillyTavern` access in the corpus is behind a guard, so a member
  // that answers but denies existing is a member cards skip.
  const { bridge } = withBridge()
  assert.equal('updateChatMetadata' in bridge, true)
})

test('a typeof guard degrades too, which the throw also defeated', () => {
  /*
   * The corpus uses two guard styles and the throw broke both. This is the
   * second, and it is the one that looks safest:
   *
   *   if (ctx && typeof ctx.setExtensionPrompt === 'function') { … }
   *
   * `typeof obj.x` still **evaluates** `obj.x`, so a getter that throws throws
   * right through it. `typeof` guards an undeclared *identifier*, never a
   * missing property — which is exactly the confusion that makes this style
   * feel defensive.
   *
   * **`setExtensionPrompt` is no longer the example**, because it has since been
   * built — the corpus's own guard now takes its true branch, which is the
   * outcome that was wanted. The test kept asserting `'undefined'` for it and
   * went on passing anyway: its assertion lived inside a body, where a failure
   * was being swallowed. Both halves are fixed here; the subject is the
   * degradation, so it needs a member that is actually absent.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>

    // Built: the guard a card writes around this one succeeds.
    assert.equal(typeof bare['setExtensionPrompt'], 'function')

    /*
     * Absent, and the point of the test: reading it neither throws nor produces
     * a stub that would pass a `typeof … === 'function'` check. A card guarding
     * this way takes its fallback path, which is what a card guarding this way
     * asked for.
     */
    assert.equal(typeof bare['printMessages'], 'undefined')
    assert.equal(typeof bare['getRequestHeaders'], 'undefined')
  })
})

test('the bus reached through getContext is the same bus as everywhere else', () => {
  /*
   * Two cards read `ctx.eventSource` and `ctx.event_types` across nine sites
   * each, always as a pair and always behind
   * `if (ctx && ctx.eventSource && ctx.event_types)`. This surface carried
   * neither, so that guard was false and every one of those sites took a
   * fallback path without anything being wrong.
   *
   * Identity is the assertion, not presence: `eventOn` wraps `eventSource`, so
   * a card subscribing by one route and emitting by the other is talking to
   * itself. Two equivalent-but-separate buses would satisfy a presence check
   * and silently drop every message between the two routes.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  const heard: string[] = []
  let bare: Record<string, unknown> | undefined
  evaluate(scope, globals => {
    bare = globals
    const ctx = (globals['SillyTavern'] as Record<string, unknown>)
    const viaContext = (ctx['getContext'] as () => Record<string, unknown>)()

    assert.equal(
      viaContext['eventSource'],
      (globals['parent'] as Record<string, unknown>)['eventSource'],
      'getContext() handed out a different bus than parent did',
    )
    assert.equal(
      viaContext['event_types'],
      (globals['parent'] as Record<string, unknown>)['event_types'],
      'two event tables means a name that matches nothing',
    )

    const source = viaContext['eventSource'] as { on: (e: string, l: () => void) => void }
    source.on('message_received', () => heard.push('via getContext'))
  })

  void (bare?.['eventEmit'] as (event: string) => Promise<void>)('message_received')
  return Promise.resolve().then(() => {
    assert.deepEqual(heard, ['via getContext'], 'the subscription did not reach the emitting bus')
  })
})

/** The params of the one `setExtensionPrompt` call a scope recorded. */
function promptCall(scope: ReturnType<typeof realm>) {
  const call = scope.posted.find(
    message => message.type === 'call' && message.method === 'setExtensionPrompt',
  )
  assert.ok(call?.type === 'call', 'no setExtensionPrompt reached the host')
  return call.params as Record<string, unknown>
}

test('the corpus call shape reaches the host translated', () => {
  /*
   * Measured, verbatim, from `银麒赎世 · 手机UI` — the only caller:
   *
   *   ctx.setExtensionPrompt("yinqi-npc-messages", header + summary, 1, 0)
   *
   * A bare `1`, meaning `IN_CHAT`.
   */
  const { scope, bridge } = withBridge()
  const set = bridge['setExtensionPrompt'] as (...args: unknown[]) => unknown

  void set('yinqi-npc-messages', 'body text', 1, 0)

  assert.deepEqual(promptCall(scope), {
    key: 'yinqi-npc-messages',
    value: 'body text',
    position: 'at-depth',
    depth: 0,
  })
})

test('the positions upstream uses map to the ones this contract names', () => {
  /*
   * The test that stops this working by luck. The corpus only ever passes `1`,
   * which happens to be the contract’s own default — so an implementation that
   * forwarded the raw number, or dropped it entirely, would satisfy every
   * measured call and be wrong for the other two.
   *
   * The mapping is read off upstream’s use of the enum rather than its names:
   * `script.js:4641-4642` fetches BEFORE_PROMPT as the anchor’s before and
   * IN_PROMPT as its after.
   */
  for (const [upstream, named] of [[2, 'before'], [0, 'after'], [1, 'at-depth']] as const) {
    const { scope, bridge } = withBridge()
    void (bridge['setExtensionPrompt'] as (...args: unknown[]) => unknown)('k', 'v', upstream, 3)
    assert.equal(
      promptCall(scope)['position'],
      named,
      `upstream position ${String(upstream)} must arrive as ${named}`,
    )
  }
})

test('an omitted position is left to the contract rather than guessed', () => {
  // One place decides the default. Sending a value here would be a second.
  const { scope, bridge } = withBridge()
  void (bridge['setExtensionPrompt'] as (...args: unknown[]) => unknown)('k', 'v')

  const params = promptCall(scope)
  assert.equal('position' in params, false)
  assert.equal('depth' in params, false)
})

test('NONE is refused by name instead of landing somewhere', () => {
  /*
   * `-1` means "registered but not positionally injected". This vocabulary
   * cannot express that at all, and the alternative to refusing is putting the
   * card's text exactly where it asked for it not to go.
   */
  const { bridge } = withBridge()
  const set = bridge['setExtensionPrompt'] as (...args: unknown[]) => unknown

  assert.throws(() => set('k', 'v', -1, 0), (error: unknown) => {
    assert.ok(error instanceof UnsupportedApiError)
    assert.match(String(error.message), /no counterpart/u)
    return true
  })
})

test('arguments this contract does not carry are reported, not dropped quietly', () => {
  /*
   * Upstream takes seven; this contract carries four. No measured card passes
   * the others, but one that did would have `scan` and `role` silently ignored
   * — and those change where and how the prompt is scanned, so the symptom
   * would be a worse reply rather than an error.
   */
  const { scope, bridge } = withBridge()
  const set = bridge['setExtensionPrompt'] as (...args: unknown[]) => unknown

  void set('k', 'v', 1, 0, true, 1, null)

  assert.ok(
    scope.posted.some(
      message => message.type === 'note' && message.message.includes('setExtensionPrompt'),
    ),
    'the dropped arguments went unmentioned',
  )
})

test('the SillyTavern surface carries exactly these members', () => {
  /*
   * Pinned by name, because `CARD_METHODS` answers two questions that used to
   * be one: *may the shell route this* and *does a card find it on
   * `SillyTavern`*. They came apart when the chat journal needed to reach
   * `createChatMessages` — a Tavern Helper member. Routing it without this
   * split would have invented `SillyTavern.createChatMessages`, a member
   * upstream does not have, on a surface whose whole job is to mirror one.
   *
   * `OFF_ST_SURFACE` is a deny list, so a future entry defaults to *exposed*.
   * That is the weaker default and it is taken knowingly — this test is what
   * makes the weakness visible instead of silent. A new routable action shows
   * up here as a diff, and whoever adds it has to say which side it belongs on.
   *
   * **This list records what the surface carries today, not what upstream says
   * it should.** Several entries are Tavern Helper members that may not belong
   * on a SillyTavern context object at all — `getVariables`, `setVariables` and
   * `generateRaw` are the candidates — and none of them has been checked against
   * `st-context.js`'s 145 keys. They are pinned so that a change is visible, not
   * because they are ratified. Read as an inventory; do not read as approval.
   */
  const scope = realm()
  

  /*
   * Candidates are **derived**, not listed. The first version of this test
   * filtered a hand-written array, which meant it could only ever report on
   * names somebody had thought of — so a member reachable but unlisted was
   * invisible to the very test written to make the surface visible. It pinned 18
   * of 25.
   *
   * That is this repo's oldest recurring failure ("a checklist can only speak
   * about names that are on it") appearing inside the checklist's own guard. The
   * fix is to enumerate from the sources the surface is actually built from:
   * every routable action, every snapshot field, plus the handful the proxy
   * answers itself.
   */
  /*
   * The snapshot here carries **every** `ScriptContext` field, not the shared
   * fixture's subset. Deriving candidates from a partial snapshot was the same
   * incompleteness one level down: fields the fixture happens not to set are
   * reachable on the surface and invisible to the probe. Adding a field to the
   * contract without adding it here silently shrinks what this test can see —
   * which is why the list is spelled out rather than spread from a helper.
   */
  const full: Record<string, unknown> = {
    chat: [],
    chatMetadata: {},
    name1: 'You',
    name2: 'Her',
    characterId: 'char-1',
    chatId: 'chat-1',
    characters: [],
    extensionSettings: {},
    variables: {},
    variableLayers: { global: {}, character: {}, script: {}, chat: {} },
    charWorldbooks: { primary: null, additional: [] },
    floor: { messageId: 0, variables: {} },
  }
  const answeredByProxy = ['getContext', 'extensionSettings', 'eventSource', 'event_types', 'updateChatMetadata']
  const candidates = [...new Set([
    ...Object.keys(CARD_METHODS),
    ...Object.keys(full),
    ...answeredByProxy,
  ])]

  scope.send({ iris: 'tok', type: 'context', context: full as never })

  let present: string[] = []
  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    present = candidates.filter(name => name in bare).sort()
  })

  assert.deepEqual(present, [
    'charWorldbooks',
    'characterId',
    'characters',
    'chat',
    'chatId',
    'chatMetadata',
    'eventSource',
    'event_types',
    'extensionSettings',
    'floor',
    'generate',
    'generateRaw',
    'getContext',
    'name1',
    'name2',
    'saveChat',
    'saveMetadata',
    'setExtensionPrompt',
    'setVariables',
    'swipeTo',
    'updateChatMetadata',
    'variableLayers',
    'variables',
  ])
})

test('the chat-write arms are routable but not on the SillyTavern surface', () => {
  // The specific thing the split exists for, asserted in both directions so a
  // future "simplification" that collapses them fails here rather than in a card.
  for (const name of ['setChatMessages', 'createChatMessages', 'deleteChatMessages']) {
    assert.equal(isCardMethod(name), true, `${name} must stay routable`)
    assert.equal(
      isOnSillyTavernSurface(name),
      false,
      `${name} is a Tavern Helper member; upstream has no SillyTavern.${name}`,
    )
  }
})

/**
 * Whether a surface hands back a live reference into the snapshot.
 *
 * One fresh realm per probe, and that is not fastidiousness: sharing a realm
 * across probes let an earlier `push` move which floor `getSwipes()` addressed,
   and two of six answers came back wrong **in opposite directions**. A
 * contaminated probe does not error; it produces a complete-looking table.
 * @param read - how to obtain the value under test.
 * @param mutate - how to mark it.
 * @returns true when the mark survives into a second read.
 */
function handsBackLiveState(
  read: (globals: Record<string, unknown>) => unknown,
  mutate: (value: never) => void,
): boolean {
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({ variableLayers: { global: { g: 1 }, character: {}, script: {}, chat: {} } }),
  })
  let live = false
  evaluate(scope, globals => {
    const first = read(globals) as never
    mutate(first)
    live = JSON.stringify(read(globals) ?? null).includes('IRIS_PROBE')
  })
  return live
}

test('the two surfaces have opposite rules about live state, on purpose', () => {
  /*
   * Not one rule with an exception — two surfaces whose upstreams disagree, and
   * getting either backwards is silent.
   *
   * **Tavern Helper clones on the way out** (21 `klona` calls across 10
   * modules). Handing a live reference there is Iris-only behaviour in the
   * worse direction: the card's mutation works here and does nothing on real
   * SillyTavern, so it invites a dependency no other host honours.
   *
   * **The SillyTavern context object is live upstream**, and cards mutate it as
   * the documented idiom. Cloning `chat` here would not make Iris safer, it
   * would break `chat.push(...)` — which the journal exists to carry to the
   * host.
   */
  assert.equal(
    handsBackLiveState(g => (g['getVariables'] as (o: unknown) => unknown)({ type: 'global' }),
      v => { (v as Record<string, unknown>)['IRIS_PROBE'] = 1 }),
    false,
    'getVariables is a Tavern Helper member; upstream klonas it',
  )
  assert.equal(
    handsBackLiveState(g => (g['getChatMessages'] as (r: unknown) => unknown[])(0),
      v => { ((v as Record<string, unknown>[])[0] ?? {})['mes'] = 'IRIS_PROBE' }),
    false,
    'the array was already fresh; its elements were not',
  )
  assert.equal(
    handsBackLiveState(g => (g['getSwipes'] as () => unknown)(),
      v => { (v as string[]).push('IRIS_PROBE') }),
    false,
  )

  assert.equal(
    handsBackLiveState(g => (g['SillyTavern'] as Record<string, unknown>)['chat'],
      v => { (v as Record<string, unknown>[]).push({ mes: 'IRIS_PROBE' }) }),
    true,
    'context.chat must stay live — cloning it would break the idiom, not protect it',
  )
})

test('the shared tables keep their identity through the clone layer', () => {
  /*
   * The reason the clone layer copies **call results** and not properties. A
   * card may subscribe through one name and emit through another; two equal but
   * separate event tables would satisfy every equality check a card is likely to
   * write and then match nothing at dispatch.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    assert.equal(parent['event_types'], globals['tavern_events'], 'one table, two names')
    assert.equal(parent['TavernHelper'], globals['TavernHelper'], 'one surface, two routes')
  })
})

/**
 * The one corpus card's lookup, performed exactly as its source performs it.
 *
 * Measured: `ctx.characters[ctx.characterId]` → `.data.character_book.entries`
 * → `for (i = 0; i < entries.length; i++)`. Every level is guarded, which is
 * precisely why every level's failure is silent.
 * @param globals - what the card was handed.
 * @returns the entries it would iterate.
 */
function readEmbeddedBook(globals: Record<string, unknown>): unknown[] {
  const ctx = globals['SillyTavern'] as Record<string, unknown>
  const characters = ctx['characters'] as Record<string, unknown>[] | undefined
  const characterId = ctx['characterId'] as string | undefined
  if (characters === undefined || characterId === undefined) return []
  const card = characters[characterId as unknown as number] as
    | { data?: { character_book?: { entries?: unknown[] } } }
    | undefined
  return card?.data?.character_book?.entries ?? []
}

/** A snapshot whose **second** character is the one being played, with a book. */
function withEmbeddedBook(): ReturnType<typeof snapshot> {
  return snapshot({
    characterId: 'card-abc',
    characters: [
      { characterId: 'other', name: 'Someone Else', tags: [] },
      {
        characterId: 'card-abc',
        name: 'Yinqi',
        tags: [],
        /*
         * An **array**, which is the V2/V3 card-spec shape and what this repo's
         * own `decodeCardPng` produces. SillyTavern's *disk* world books key
         * `entries` by uid instead, and both shapes exist here.
         */
        data: {
          character_book: {
            entries: [
              { id: 0, comment: 'plain', content: 'no template here' },
              { id: 1, comment: '[EJS] worldview', content: 'level <%= 1 %>' },
            ],
          },
        },
      },
    ],
  })
}

test('characterId is a stringified array index, so the card lookup hits', () => {
  /*
   * The break this repairs was invisible. Iris's character ids are opaque
   * strings, and `array["card-abc"]` is `undefined` while `characters` and
   * `characterId` are both truthy — so every guard the card wrote passes and the
   * indexed read is simply absent.
   *
   * What follows: `charData` undefined → `entries` stays `[]` → the render loop
   * runs zero times → `evalTemplate` is never called. **An acceptance run goes
   * green because nothing executed**, which is the failure this project has now
   * named often enough to test for directly.
   *
   * Matching the field would not have been enough either: array indexing with a
   * non-numeric string finds nothing whatever the ids are, so making the values
   * agree would have looked like a fix and changed no behaviour.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: withEmbeddedBook() })

  let id: unknown
  let found = 0
  evaluate(scope, globals => {
    id = (globals['SillyTavern'] as Record<string, unknown>)['characterId']
    found = readEmbeddedBook(globals).length
  })

  assert.equal(id, '1', 'upstream this_chid is String(characters.indexOf(value))')
  assert.match(String(id), /^[0-9]+$/u, 'a non-numeric string indexes to nothing')
  assert.equal(found, 2, 'the lookup missed, and that miss is the silent failure')
})

test('character_book.entries stays an array rather than the disk keyed object', () => {
  /*
   * The card walks it with `.length` and `[i]`. A keyed object gives
   * `entries.length === undefined`, zero iterations, and a green run — the same
   * false green as above, one level down.
   *
   * Our reader already yields an array, so this asks only that the mirror does
   * not helpfully normalise it into the disk shape.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: withEmbeddedBook() })

  let entries: unknown[] = []
  evaluate(scope, globals => {
    entries = readEmbeddedBook(globals)
  })

  assert.ok(Array.isArray(entries), 'a keyed object here would iterate zero times')
  assert.equal(entries.length, 2)
  assert.equal((entries[1] as { comment: string }).comment, '[EJS] worldview')
})

test('the book stays nested, because the first guard reads the nesting', () => {
  // `charData.data && charData.data.character_book && …` — flattening any level
  // makes that guard read "this card has no world book" and take the fallback.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: withEmbeddedBook() })

  evaluate(scope, globals => {
    const ctx = globals['SillyTavern'] as Record<string, unknown>
    const card = (ctx['characters'] as Record<string, unknown>[])[1] as Record<string, unknown>
    assert.ok(card['data'] !== undefined, 'CharacterSummary must carry data')
    const data = card['data'] as Record<string, unknown>
    assert.ok(data['character_book'] !== undefined, 'the nesting collapsed')
  })
})

test('no character selected leaves characterId falsy, stopping the outer guard', () => {
  /*
   * `undefined` rather than `'-1'`. Both stop the indexed read, but only this
   * stops `if (ctx.characters && ctx.characters[ctx.characterId])` at its first
   * term — which is what upstream does with nothing selected, and keeps a card
   * out of a branch it would enter believing a character was chosen.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characters: [] }) })

  evaluate(scope, globals => {
    assert.equal((globals['SillyTavern'] as Record<string, unknown>)['characterId'], undefined)
  })
})

test('EjsTemplate is a real function on parent, not a reporting getter', () => {
  /*
   * The measured caller feature-tests with
   * `typeof tw.EjsTemplate.evalTemplate === 'function'`, so the report-on-read
   * path the rest of this proxy uses for absent names would fail that test —
   * correctly while we had nothing to offer, wrongly now that we do.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    const ejs = parent['EjsTemplate'] as Record<string, unknown> | undefined
    assert.ok(ejs !== undefined, 'the card reaches this through window.parent')
    assert.equal(typeof ejs['evalTemplate'], 'function')
  })
})

test('a template goes to the host, and a rejection is left for the card to catch', () => {
  /*
   * The caller wraps its call in `console.warn` plus a fall back to the
   * unrendered text, and that path is only reachable if the rejection arrives.
   * The fence's own refusals — the `initial`/`cache` scopes, `insvar` with an
   * `index` — carry a specific reason, and **wrapping them into `undefined`
   * would be the wrong direction on this surface**: on `$.fn` an `undefined` is
   * honest because the plugin is genuinely absent, whereas here the capability
   * exists and is deliberately withheld. Erasing a decision into an absence
   * sends the card down a path the refusal was not written for.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  let pending: Promise<unknown> | undefined
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    const ejs = parent['EjsTemplate'] as { evalTemplate: (text: string) => Promise<unknown> }
    pending = ejs.evalTemplate('level <%= 1 %>')
  })

  const call = scope.posted.find(
    message => message.type === 'call' && message.method === 'evalTemplate',
  )
  assert.ok(call?.type === 'call', 'the template never reached the host')
  assert.deepEqual(call.params, { content: 'level <%= 1 %>' })

  // The frame's own reply channel, carrying a refusal the fence produced.
  scope.send({
    iris: 'tok',
    type: 'call:error',
    id: call.id,
    message: 'the initial scope is not available inside the fence',
  } as never)

  return assert.rejects(
    pending as Promise<unknown>,
    /initial scope is not available/u,
    'the card must receive the reason, not undefined',
  )
})

/**
 * The published names and their values are index-matched by hand, and a
 * mismatch is silent: it slides every later binding one place along, so a card
 * calling `getChatMessages` gets whatever function happened to sit next to it.
 * That failure has no symptom at the boundary — the name is present, the value
 * is callable, and only the card's own behaviour goes wrong.
 *
 * This checks the alignment against a source that does not share the array:
 * the parent proxy resolves each member by name, independently. Same-source
 * checking would be no check at all here, because the names and the values that
 * could disagree both come out of the same two literals.
 */
test('every published binding matches what the parent proxy answers for that name', () => {
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  evaluate(scope, () => undefined)

  const virtualParent = scope.publishedValue('parent') as Record<string, unknown>
  /*
   * Most Tavern Helper members are not on `parent` directly — upstream reaches
   * them as `window.parent.TavernHelper.getChatMessages` — so this table is the
   * second place to look. It is still an independent source for what this test
   * is about: the hazard is a shifted **index**, and both `parent` and this
   * table answer by **name**.
   */
  const onTable = virtualParent['TavernHelper'] as Record<string, unknown>
  const checked: string[] = []
  for (const name of scope.publishedNames()) {
    // The window aliases are the frame's own realm, not members to compare.
    if (name === 'parent' || name === 'top') continue
    const onParent = virtualParent[name] ?? onTable[name]
    if (onParent === undefined) continue
    checked.push(name)
    /*
     * Unwrapped first. A published `identity` member is wrapped so that calling
     * it through the shared surface reports that attribution is impossible
     * there, and the wrapper is a different function object. It carries the
     * member it wraps under `SHARED_ORIGINAL` precisely so this check keeps its
     * reach — excusing those names would blind it exactly where an index shift
     * is hardest to notice.
     */
    const published = scope.publishedValue(name)
    const unwrapped = (published as Record<string, unknown> | undefined)?.[SHARED_ORIGINAL]
      ?? published
    assert.equal(
      unwrapped,
      onParent,
      `published ${name} is not the member the parent proxy answers for that name`,
    )
  }

  /*
   * The count is asserted because the loop's `continue` is the way this test
   * can pass while measuring nothing: one wrong `undefined` on the parent proxy
   * would skip a name silently, and a whole-list regression would leave the
   * loop with nothing to compare. The number is a floor, not a pin — new
   * members should raise it, and only a drop means the check stopped reaching.
   */
  assert.ok(
    checked.length >= 20,
    `only ${String(checked.length)} names were actually compared: ${checked.join(', ')}`,
  )
})

test('getScriptButtons answers this script’s table from the snapshot, unfiltered', () => {
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({
      scriptButtons: {
        mine: [
          { name: '开始', visible: true },
          { name: '调试', visible: false },
          { name: '结束', visible: true },
        ],
        theirs: [{ name: 'not mine', visible: true }],
      },
    }),
  })

  evaluate(
    scope,
    globals => {
      const helper = globals['getScriptButtons'] as () => { name: string, visible: boolean }[]
      const answered = helper()

      /*
       * All three, hidden one included. `visible: false` hides a button from the
       * bar; it does not remove it from the table. Cards read this list, edit one
       * entry and write the whole thing back, so a filtered answer would make
       * that read-modify-write delete every hidden button — and the card author
       * would report it as "toggling one button deleted the others".
       */
      assert.deepEqual(answered.map(button => button.name), ['开始', '调试', '结束'])
      assert.deepEqual(
        answered.map(button => button.visible),
        [true, false, true],
      )
    },
    'mine',
  )
})

test('a script with no published table gets an empty list, not undefined', () => {
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(
    scope,
    globals => {
      const helper = globals['getScriptButtons'] as () => { name: string, visible: boolean }[]
      /*
       * MVU passes this straight into `_.intersectionBy`, which given
       * `undefined` returns an empty array and reports nothing. The shape a card
       * destructures matters more than the emptiness it finds.
       */
      const answered = helper()
      assert.equal(Array.isArray(answered), true)
      assert.equal(answered.length, 0)
    },
    'unpublished',
  )
})

test('a body with no script id gets an empty list rather than another script’s', () => {
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({ scriptButtons: { mine: [{ name: '开始', visible: true }] } }),
  })

  // No third argument: a body with no entry in the host's script list.
  evaluate(scope, globals => {
    const helper = globals['getScriptButtons'] as () => { name: string, visible: boolean }[]
    assert.equal(helper().length, 0)
  })
})

test('an existence check never throws, on any surface, for any upstream member', () => {
  /*
   * **`typeof x` must be safe even where `x()` is refused.**
   *
   * [OVERLAY-CARDS.md, V1.5.4] That card probes every Tavern Helper member with
   * `typeof … === 'function'` and warns-and-degrades when one is missing. If a
   * refusal threw at *property access* time, the probe itself would explode and
   * the card's own fallback — the thing it wrote to survive a missing member —
   * would never run. A named refusal that prevents the degradation it was meant
   * to make legible is worse than an absence.
   *
   * `COHABITATION.md` already fixes this for `has`/`in` on the virtual parent.
   * This walks the whole declared upstream surface across all three faces, so
   * the rule cannot hold in one place and lapse in another.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  const threw: string[] = []
  let probed = 0
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    const sillyTavern = parent['SillyTavern'] as Record<string, unknown>
    const helper = parent['TavernHelper'] as Record<string, unknown>

    for (const name of [...UPSTREAM_MEMBERS, 'noSuchMemberAnywhere']) {
      for (const [face, object] of [
        ['parent', parent],
        ['SillyTavern', sillyTavern],
        ['TavernHelper', helper],
      ] as [string, Record<string, unknown>][]) {
        probed += 1
        try {
          // Deliberately only `typeof`: this is the probe a card makes, and it
          // must not become a call.
          void (typeof object[name])
        } catch {
          threw.push(`${face}.${name}`)
        }
      }
    }
  })

  assert.deepEqual(threw, [], `existence checks threw on: ${threw.slice(0, 8).join(', ')}`)
  /*
   * The count is asserted because every read above sits inside a `try`: if the
   * loop stopped early, or a face came back undefined and the inner loop turned
   * into nothing, this test would report "nothing threw" having probed almost
   * nothing.
   */
  assert.ok(probed > 400, `only ${String(probed)} probes ran`)
})

test('the one-argument button write lands under the calling script, not the last one', () => {
  /*
   * **The family-level risk in accepting the one-argument form.**
   *
   * Upstream resolves the omitted script id from `this` — bound to the calling
   * frame's window — because upstream runs **one script per frame**. Iris runs a
   * card's scripts together in one frame, so "the frame's script" is not a
   * question with an answer: a shared surface would answer for whichever script
   * ran last, and MVU's `appendInexistentScriptButtons(buttons)` would write its
   * table under a neighbour's id.
   *
   * It resolves correctly because these members are classified `identity` in
   * `MEMBER_KINDS` and `viewFor` builds each script its own bound surface. That
   * classification was made when the writers still took the id explicitly and
   * did not need it — "classify by what they are, not by what the current
   * implementation happens to require" — and this is the change that cashed it.
   */
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({ characterId: 'char', scriptButtons: { first: [], second: [] } }),
  })

  // One evaluate to install and publish; the registry is a **published** global,
  // not one of the shadowed names handed to a body, so it is reached here rather
  // than from inside the card code.
  evaluate(scope, () => undefined, 'first')
  const registry = scope.publishedValue(SCRIPT_REGISTRY) as (id: string) => Record<string, unknown>
  assert.equal(typeof registry, 'function', 'the script registry must be published')

  for (const [scriptId, label] of [['first', '甲'], ['second', '乙']] as [string, string][]) {
    /*
     * Through the registry, because that is the path a card's script takes:
     * `withPreamble` prepends one line destructuring the identity-bearing
     * members out of `globalThis[SCRIPT_REGISTRY](id)`, so a bare
     * `appendInexistentScriptButtons(...)` in a script body resolves to that
     * script's own binding.
     *
     * An earlier version of this test read the **published global of the same
     * name** — the shared surface — and both writes landed under `first`. That
     * is not a bug in the writers; it is the thing `MEMBER_KINDS`'s `identity`
     * classification exists to say, and the test was reaching past it to the one
     * surface that cannot answer the question.
     */
    const append = registry(scriptId)['appendInexistentScriptButtons'] as
      (buttons: unknown) => void
    // One argument, exactly as MVU's bundle calls it.
    append([{ name: label, visible: false }])
  }

  const writes = scope.posted
    .filter(message => message.type === 'call')
    .map(message => message as unknown as { method: string, params: Record<string, unknown> })
    .filter(message => message.method === 'replaceScriptButtons')

  assert.equal(writes.length, 2, `expected one write per script: ${JSON.stringify(writes)}`)
  assert.deepEqual(
    writes.map(write => write.params['scriptId']),
    ['first', 'second'],
    'each script wrote under its own id',
  )
  assert.deepEqual(
    writes.map(write => (write.params['buttons'] as { name: string }[])[0]?.name),
    ['甲', '乙'],
  )
})
test('a refusal and a gap leave the frame on different channels', () => {
  /*
   * **The teeth for the split.** The panel groups by channel before a reader
   * reads a word, so the channel is the report's first sentence — and for a
   * while every report Iris made said the same one. `reportGap`'s own contract
   * read "not an error: the card carries on" while its wiring posted
   * `type: 'error'` for all seventeen call sites, which put "a card read
   * parent.Mvu, which nothing has published" directly under a heading counting
   * scripts that failed to start. Three true sentences and one true heading
   * composed into a false causal story, twice, in front of the user.
   *
   * Both halves are asserted in one test on purpose. Pinning only the fault
   * side passes for an implementation that posts everything as `error` — which
   * is the implementation this replaced.
   */
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({ characterId: 'char', scriptButtons: { first: [] } }),
  })
  evaluate(scope, () => undefined, 'first')

  const registry = scope.publishedValue(SCRIPT_REGISTRY) as (id: string) => Record<string, unknown>
  const append = registry('first')['appendInexistentScriptButtons'] as (buttons: unknown) => void

  // A malformed row rejects the **whole** table and stores nothing, so the card
  // did not get what it asked for even though nothing threw.
  append([{ name: 'ok', visible: true }, { name: 'no boolean' }])

  const faults = scope.posted
    .filter(message => message.type === 'error')
    .map(message => (message as unknown as { message: string }).message)
  assert.equal(
    faults.filter(line => line.includes('visible')).length,
    1,
    `a rejected write must be a fault: ${JSON.stringify(scope.posted)}`,
  )

  // And the other direction, in the same frame: reading a member the host does
  // not carry is served — `undefined` is what upstream answers too — so it is a
  // note, and a note is what must come out.
  const parent = scope.globals()['parent'] as Record<string, unknown>
  void parent['SomeGlobalNobodyPublished']

  const notes = scope.posted
    .filter(message => message.type === 'note')
    .map(message => (message as unknown as { message: string }).message)
  assert.equal(
    notes.filter(line => line.includes('SomeGlobalNobodyPublished')).length,
    1,
    `an unpublished read must be a note: ${JSON.stringify(notes)}`,
  )
  assert.equal(
    faults.filter(line => line.includes('SomeGlobalNobodyPublished')).length,
    0,
    'the note must not also be filed as a failure',
  )
})
