import assert from 'node:assert/strict'
import { test } from 'node:test'

import { UnsupportedApiError } from '../src/sandbox/errors.ts'
import { installSandbox, type FrameEnv } from '../src/sandbox/frame.ts'
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
  scope.run(body)
  scope.send({ iris: 'tok', type: 'run', code: '/* card */', mode: 'classic', scriptId })
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
    'getVariables',
    'getAllVariables',
    'getLastMessageId',
    // Answered, not implemented: the version is real (transcribed from the
    // installed extension), the four button members are reporting stubs. They
    // are here because absence is the one answer that breaks a card outright —
    // MVU calls three of them while wiring up, before it publishes anything.
    'getTavernHelperVersion',
    'getScriptButtons',
    'getButtonEvent',
    'replaceScriptButtons',
    'appendInexistentScriptButtons',
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
  const said = scope.posted.filter(m => m.type === 'error').map(m => (m as { message: string }).message)
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

test('a member the bridge does not carry is refused by name', () => {
  // The context is the 19 keys cards were measured to touch, not the 145 ST has.
  // A card reaching outside that set should be told which member, not handed
  // undefined and left to fail later.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  let caught: unknown
  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    try {
      void bare['generateQuietPrompt']
    } catch (error: unknown) {
      caught = error
    }
  })

  assert.ok(caught instanceof UnsupportedApiError)
  assert.equal(caught.member, 'SillyTavern.generateQuietPrompt')
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
    'getVariables',
    'getAllVariables',
    'getLastMessageId',
    // Answered, not implemented: the version is real (transcribed from the
    // installed extension), the four button members are reporting stubs. They
    // are here because absence is the one answer that breaks a card outright —
    // MVU calls three of them while wiring up, before it publishes anything.
    'getTavernHelperVersion',
    'getScriptButtons',
    'getButtonEvent',
    'replaceScriptButtons',
    'appendInexistentScriptButtons',
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

test('a member outside the measured set is still refused', () => {
  // The gap was a missing entry point, not a refusal that was too wide. The
  // refusal stays.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  let caught: unknown
  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    try {
      void bare['deleteAllChats']
    } catch (error: unknown) {
      caught = error
    }
  })

  assert.ok(caught instanceof UnsupportedApiError)
  assert.equal(caught.member, 'SillyTavern.deleteAllChats')
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
