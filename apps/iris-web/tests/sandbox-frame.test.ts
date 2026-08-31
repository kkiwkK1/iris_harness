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
    onMessage: listener => listeners.push(listener),
    evaluate: (_source, mode, names, values) => {
      handed = Object.fromEntries(names.map((name, at) => [name, values[at]]))
      if (mode === 'module' && asyncBody !== undefined) return asyncBody()
      body(handed)
      return undefined
    },
    publishGlobals: entries => {
      published = entries.map(([name]) => name)
    },
  }

  installSandbox(env)
  return {
    posted,
    send: message => listeners.forEach(listener => listener(message)),
    globals: () => handed,
    publishedNames: () => published,
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
    'getCurrentMessageId',
    'getChatMessages',
    'getSwipes',
    'replaceVariables',
    'insertOrAssignVariables',
    'insertVariables',
    'deleteVariable',
    'updateVariablesWith',
    'swipeTo',
    'generate',
    'substidudeMacros',
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

  assert.deepEqual(scope.posted.at(-1), { iris: 'tok', type: 'ran' })
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

test('an unbridged global says "not yet", not "no"', () => {
  // Telling a card author something is forbidden when it is merely unbuilt sends
  // them looking for the wrong thing. `eventSource` has 8 measured sites and no
  // bridge yet, so it is the live example.
  const scope = realm()
  let caught: unknown
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    try {
      void parent['eventSource']
    } catch (error: unknown) {
      caught = error
    }
  })

  assert.ok(caught instanceof UnsupportedApiError)
  assert.equal(caught.member, 'parent.eventSource')
  assert.match(caught.message, /not bridged it yet/)
  assert.match(caught.message, /event bus/)
})

test('an unknown parent member is refused without a plan attached', () => {
  const scope = realm()
  let caught: unknown
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    try {
      void parent['localStorage']
    } catch (error: unknown) {
      caught = error
    }
  })

  assert.ok(caught instanceof UnsupportedApiError)
  assert.equal(caught.member, 'parent.localStorage')
  assert.doesNotMatch(caught.message, /planned/)
})

test('a refusal reaches the shell carrying the member name', () => {
  // This is how the shell tells "the card asked for something we do not give"
  // from "the card has a bug", and it decides which of two very different
  // messages the user sees.
  const scope = realm()
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    void parent['cookie']
  })

  const last = scope.posted.at(-1)
  assert.ok(last?.type === 'error')
  assert.equal(last.member, 'parent.cookie')
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
    'getCurrentMessageId',
    'getChatMessages',
    'getSwipes',
    'replaceVariables',
    'insertOrAssignVariables',
    'insertVariables',
    'deleteVariable',
    'updateVariablesWith',
    'swipeTo',
    'generate',
    'substidudeMacros',
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

test('a second run re-answers getScriptId rather than keeping the first id', () => {
  /*
   * The frame is reused across runs in the probe. An id captured at install
   * would make every later script claim to be the first one.
   */
  const scope = realm()
  const seen: unknown[] = []
  const record = (globals: Record<string, unknown>): void => {
    seen.push((globals['getScriptId'] as () => unknown)())
  }
  evaluate(scope, record, 'first')
  evaluate(scope, record, 'second')

  assert.deepEqual(seen, ['first', 'second'], 'each run must answer with its own id')
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
