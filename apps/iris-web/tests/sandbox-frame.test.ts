import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { UnsupportedApiError } from '../src/sandbox/errors.ts'
import { CARD_METHODS, isCardMethod, isOnSillyTavernSurface } from '../src/sandbox/card-api.ts'
import { installSandbox, VIRTUAL_PARENT_SCHEDULER_MEMBERS, type FrameEnv, type FrameSchedulers } from '../src/sandbox/frame.ts'
import { MEMBERS } from './members-table.ts'
import { UPSTREAM_MEMBERS } from '../src/sandbox/upstream-surface.ts'
import { SCRIPT_REGISTRY } from '../src/sandbox/preamble.ts'
import { SHARED_ORIGINAL } from '../src/sandbox/identity.ts'
import type { FromFrame, ToFrame } from '../src/sandbox/protocol.ts'
import type { ScriptContext } from '@iris/protocol'

/**
 * A frame realm made of stubs, plus the levers a test needs.
 * @param options - which kind of frame to install. An interface frame carries a
 *   card's markup and never receives a `run` message, so it is served at
 *   install; a script frame is served on `run`. Defaults to a script frame,
 *   which is what every test written before the distinction existed assumes.
 *   `seeded` hands the frame the inlined-snapshot seed a srcdoc would carry —
 *   the document-order guarantee that lets a parse-time call answer truth.
 */
function realm(options?: {
  interfaceFrame?: boolean
  seeded?: ScriptContext
  eventTarget?: EventTarget
  schedulers?: FrameSchedulers
  postToParent?: (message: unknown, targetOrigin?: unknown, transfer?: unknown) => void
}): {
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
  /** What a `predefine`-shaped global reads, and whether one was installed. */
  predefined: (name: string) => unknown
  predefinedExists: (name: string) => boolean
  /** Nodes the sandbox appended to the container itself. */
  appended: () => unknown[]
  /** Requests the frame handed to the native fetch, exactly as passed. */
  nativeFetches: () => { input: unknown, init: unknown }[]
  /** The reporter the toastr substitute was handed, if it was handed one. */
  reportFromToastr: () => ((message: string, channel: 'note' | 'error') => void) | undefined
  /** The `localStorage` the frame asked to have installed, if it asked. */
  storage: () => Record<string, unknown> | undefined
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
  /**
   * The stub standing in for the frame's own window.
   *
   * Exposed so a test can seed a global the way the **preset** does — by
   * running after the frame is installed. `parent.$` is read live off this for
   * exactly that reason, and a test that could only seed it up front could not
   * tell a live read from a captured one.
   */
  realWindow: Record<string, unknown>
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
  const predefinedNames = new Map<string, () => unknown>()
  const listed: string[] = []
  let body: (globals: Record<string, unknown>) => void = () => undefined
  let asyncBody: (() => Promise<void>) | undefined
  /*
   * The container answers queries with what the sandbox has actually appended.
   *
   * A stub that always returned `[]` would let the frame's own frame-element go
   * missing without a test noticing — and "a card enumerates frames and finds
   * none" is exactly the silent failure this element exists to fix.
   */
  const appended: unknown[] = []
  const container = {
    id: 'card-root',
    querySelector: () => null,
    querySelectorAll: (selector: string) =>
      appended.filter(
        node => (node as { tagName?: string }).tagName?.toLowerCase() === selector.toLowerCase(),
      ),
  }

  let toastrReport: ((message: string, channel: 'note' | 'error') => void) | undefined
  let installedStorage: Record<string, unknown> | undefined
  const nativeCalls: { input: unknown, init: unknown }[] = []
  const env: FrameEnv = {
    // The real table: a test has no document to load the members script
    // into, so it hands the core the same members `members-entry.ts`
    // publishes. The core takes it as a parameter, which is the split.
    members: MEMBERS,
    token: 'tok',
    container,
    ...(options?.interfaceFrame === true ? { interfaceFrame: true } : {}),
    ...(options?.eventTarget === undefined ? {} : { eventTarget: options.eventTarget }),
    ...(options?.schedulers === undefined ? {} : { schedulers: options.schedulers }),
    ...(options?.postToParent === undefined ? {} : { postToParent: options.postToParent }),
    // The seed a srcdoc would have inlined ahead of this bootstrap. The real
    // reader (frame-entry) consumes and deletes the global; here the snapshot
    // itself is the fixture, and "was it read before the body ran" is what the
    // test below asserts.
    ...(options?.seeded === undefined ? {} : { seededContext: () => options.seeded }),
    provideToastr: report => {
      toastrReport = report
    },
    provideStorage: value => {
      installedStorage = value as Record<string, unknown>
    },
    appendToContainer: node => {
      appended.push(node)
    },
    factory: {
      createElement: tagName => ({
        // Upper-cased like a real element's, because the container's query and
        // a card's own `tagName` check both read it.
        tagName: String(tagName).toUpperCase(),
        style: {} as Record<string, string>,
        setAttribute: () => undefined,
      }),
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
      // The native fetch of the realm, defined before install: the frame
      // captures it at install time, so a fetch seeded later would never be
      // seen — which is exactly the property the bridge relies on.
      fetch: (input: unknown, init?: unknown) => {
        nativeCalls.push({ input, init })
        return Promise.resolve(new Response('native body'))
      },
    },
    // The srcdoc's inherited base: the shell page's URL.
    baseUrl: 'http://127.0.0.1:8791/chats/current',
    post: message => posted.push(message),
    defineForwarding: (name, read) => forwarded.set(name, read),
    /*
     * Its own map, not `forwarded`. The two doors differ in their setter, and a
     * test that could not tell them apart would pass whichever one the code
     * called — which is the whole property the predefine tests below assert.
     */
    definePredefined: (name, read) => predefinedNames.set(name, read),
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
    predefined: (name: string) => predefinedNames.get(name)?.(),
    predefinedExists: (name: string) => predefinedNames.has(name),
    listed: () => listed,
    realWindow: env.realWindow as unknown as Record<string, unknown>,
    /** What the sandbox put into the container, in order. */
    appended: () => appended,
    nativeFetches: () => nativeCalls,
    reportFromToastr: () => toastrReport,
    storage: () => installedStorage,
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
    // The same-origin fetch bridge, which replaces the name outright.
    'fetch',
    /*
     * The dialog trio, bridged for the same reason `fetch` is: without
     * `allow-modals` the browser answers all three with silence, which is how a
     * card's chosen failure channel was swallowed. They sit at `core`'s tail,
     * immediately after `fetch` — the position the values array must mirror,
     * because the name-to-value pairing is positional (pinned by the alignment
     * test below).
     */
    'alert',
    'confirm',
    'prompt',
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
    'getWorldbookNames',
    'getCharWorldbookNames',
    'getLorebookSettings',
    'injectPrompts',
    'uninjectPrompts',
    'getSwipes',
    'replaceVariables',
    'insertOrAssignVariables',
    'insertVariables',
    'deleteVariable',
    'updateVariablesWith',
    'getWorldbook',
    'replaceWorldbook',
    'updateWorldbookWith',
    // The chat-book and creation family, added for the card that mints a chat
    // world book at runtime and appends entries to it while playing.
    // (`getWorldbookNames` itself is listed above, where the page-globals merge
    // placed it.)
    'getGlobalWorldbookNames',
    'getChatWorldbookName',
    'rebindChatWorldbook',
    'rebindGlobalWorldbooks',
    'createWorldbook',
    'getOrCreateChatWorldbook',
    'createWorldbookEntries',
    'swipeTo',
    // The chat-patch member, bare like upstream's injected iframe API, with
    // the append and delete arms that share its route.
    'setChatMessages',
    'createChatMessages',
    'deleteChatMessages',
    'generate',
    'generateRaw',
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
    // —— family②: regex ——
    // Bare as well as under `TavernHelper`, like every member above: upstream
    // seeds the whole surface into each frame as bare globals (`predefine.js`),
    // and both spellings appear in real cards. `TavernHelper` stays last
    // because it is assigned after the literal rather than inside it.
    'getTavernRegexes',
    'replaceTavernRegexes',
    'updateTavernRegexesWith',
    'isCharacterTavernRegexesEnabled',
    'formatAsTavernRegexedString',
    'TavernHelper',
  ])
})

test('the dialog bridges sit at their own names, and no Tavern Helper member slid', () => {
  /*
   * The shadowed names pair with their values **positionally** (`new
   * Function(...names)` fed the values in order), and the hazard note on
   * `resolveValues` records a real incident of the silent shift. The dialog
   * bridges were appended at `core`'s tail — immediately after `fetch`, ahead
   * of the Tavern Helper block — so their values have to sit at the same three
   * indexes. One round of calls tells every wrong arrangement apart: a bridge
   * under a helper's name posts a dialog; a helper under a bridge's name posts
   * no dialog at all.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  let confirmed: unknown
  let answered: unknown
  evaluate(scope, globals => {
    ;(globals['alert'] as (text: string) => undefined)('发送失败: 400')
    confirmed = (globals['confirm'] as (text: string) => boolean)('proceed?')
    answered = (globals['prompt'] as (text: string) => string | null)('name?')
  })

  assert.deepEqual(
    scope.posted.filter(message => message.type === 'dialog'),
    [
      { iris: 'tok', type: 'dialog', kind: 'alert', text: '发送失败: 400' },
      { iris: 'tok', type: 'dialog', kind: 'confirm', text: 'proceed?' },
      { iris: 'tok', type: 'dialog', kind: 'prompt', text: 'name?' },
    ],
    'each name must reach the shell as its own kind, in call order',
  )
  assert.equal(confirmed, false, 'confirm answers what a browser without modals answers')
  assert.equal(answered, null, 'prompt answers what a browser without modals answers')

  // And the direction the dialog assertions cannot see: the first Tavern
  // Helper name must still reach the first Tavern Helper member. With the
  // values left where "appended last" put them, this name would answer the
  // member three places later — `getTavernHelperVersion`'s string, not a table.
  // The snapshot's own variables table is what a correct pairing answers with.
  const variables = (scope.globals()['getVariables'] as () => unknown)()
  assert.deepEqual(variables, { 好感度: 32 }, 'the first helper name still reaches its own member')
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

test('parent.document delegates its event surface to the frame document', () => {
  /*
   * 人贩子物语's 黑市手机 walks `window.parent` outwards until a document
   * reads — here that walk stops at the virtual parent, whose `.document` is
   * this stand-in — and its next statement is
   * `hostDocument.addEventListener('click', …, true)`. The bus is asserted to
   * be the **frame's own document** (the realm's event target), not the parent
   * proxy's message bus: the handler reads `event.target` off a real DOM event,
   * which only the document produces.
   */
  const target = new EventTarget()
  const scope = realm({ eventTarget: target })
  // The event itself, held to compare against what was dispatched. Typed
  // `unknown` because what a listener receives is exactly that — the assertion
  // below compares it by identity, which needs no more than that.
  let registered: unknown
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    const doc = parent['document'] as Record<string, unknown>
    const add = doc['addEventListener'] as ((type: string, listener: (event: unknown) => void) => void)
      | undefined
    assert.notEqual(add, undefined, 'the document stand-in answered addEventListener with undefined')
    // The assert above is the test's guard, and it is a runtime one; the
    // non-null assertion carries it to the compiler without changing what the
    // test checks.
    add!('click', event => { registered = event })
  })

  const event = new Event('click')
  target.dispatchEvent(event)
  assert.equal(registered, event, 'the listener ran against something other than the frame document')
})

test('parent answers the scheduler set with the frame realm\'s own timers', () => {
  /*
   * 人贩子物语's 黑市手机 arms its delays and animation frames through the
   * window its outward walk produced — `hostWindow.setTimeout is not a
   * function`, one measured line after the document it walks to. Upstream's
   * `hostWindow` is a real same-origin window whose scheduler **is** the
   * scheduler; here the walk stops at this proxy, and the honest delegation is
   * to the one realm a timer can fire in — the frame's own, the same functions
   * a bare `window.setTimeout` reaches, so handles armed either way cancel each
   * other's timers.
   *
   * The calls are recorded, not replayed: the assertion is that the **injected**
   * scheduler ran with the arguments the card passed, and that the handle it
   * returned is what reaches the cancel — the property a recording stub that
   * only counted calls would not have checked.
   */
  const calls: { name: string, args: unknown[] }[] = []
  const handle = { timer: 'one' }
  const frameHandle = { frame: 'raf' }
  const schedulers: FrameSchedulers = {
    setTimeout: (...args: unknown[]) => {
      calls.push({ name: 'setTimeout', args })
      return handle
    },
    clearTimeout: (...args: unknown[]) => { calls.push({ name: 'clearTimeout', args }) },
    setInterval: (...args: unknown[]) => {
      calls.push({ name: 'setInterval', args })
      return 'interval'
    },
    clearInterval: (...args: unknown[]) => { calls.push({ name: 'clearInterval', args }) },
    requestAnimationFrame: () => {
      calls.push({ name: 'requestAnimationFrame', args: [] })
      return frameHandle
    },
    cancelAnimationFrame: (...args: unknown[]) => { calls.push({ name: 'cancelAnimationFrame', args }) },
  }
  const scope = realm({ schedulers })
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    for (const name of VIRTUAL_PARENT_SCHEDULER_MEMBERS) {
      assert.equal(typeof parent[name], 'function', `parent.${name} was not answered`)
    }

    const armed = (parent['setTimeout'] as (...args: unknown[]) => unknown)(
      () => undefined, 5,
    )
    assert.equal(armed, handle, 'the handle did not come from the frame realm')
    ;(parent['clearTimeout'] as (h: unknown) => void)(armed)
    ;(parent['requestAnimationFrame'] as (cb: (time: number) => void) => unknown)(() => undefined)
    ;(parent['cancelAnimationFrame'] as (h: unknown) => void)(frameHandle)
  })

  // asserted piecewise: a callback function compares by reference, so a whole-
  // record deepEqual would be comparing arrow identities, not behaviour.
  assert.deepEqual(calls.map(call => call.name), [
    'setTimeout',
    'clearTimeout',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ])
  assert.equal(calls[0]?.args[1], 5, 'the delay did not reach the frame realm')
  assert.equal(calls[1]?.args[0], handle, 'the armed handle did not reach the cancel')
  assert.equal(calls[3]?.args[0], frameHandle, 'the animation handle did not reach its cancel')
})

test('a parent without schedulers refuses them by name', () => {
  // The unpublished-name policy, the same one a misspelled slot gets: the read
  // yields `undefined` and says so once, rather than answering with something
  // that fails three lines later with nothing pointing here.
  const scope = realm()
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    for (const name of VIRTUAL_PARENT_SCHEDULER_MEMBERS) {
      assert.equal(parent[name], undefined, `parent.${name} was answered without a realm`)
    }
  })

  const note = scope.posted.find(
    message => (message as { type?: string }).type === 'note'
      && String((message as { message?: string }).message).includes('parent.setTimeout'),
  )
  assert.notEqual(note, undefined, 'the absent scheduler read was silent')
})

test('parent.postMessage hands the card\'s own arguments to the injected sink', () => {
  /*
   * The measured fault, 2026-09-09 on the live host with the preset-embedded
   * regex tier switched on: every message reported *"an uncaught error before
   * the card body message arrived: TypeError: window.parent.postMessage is not
   * a function at about:srcdoc:922:31"*, from
   * `[主预设] V19.5 狐神抚 · 毓忻`'s 【行动选项美化 · 狐策】 —
   * `window.parent.postMessage({type:'resizeIframe', height:
   * document.body.scrollHeight}, '*')`. That markup runs while the document
   * parses, so the throw took the rest of the interface with it.
   *
   * All three arguments are asserted, and by identity: the sink decides what
   * the message *means*, and a bridge that dropped `targetOrigin` or the
   * transfer list would leave that decision reading a different call than the
   * card made.
   */
  const calls: unknown[][] = []
  const port = { name: 'a transferable' }
  const scope = realm({
    postToParent: (message, targetOrigin, transfer) => {
      calls.push([message, targetOrigin, transfer])
    },
  })

  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    assert.equal(typeof parent['postMessage'], 'function', 'parent.postMessage was not answered')
    // The membership probe with it: `has` must agree with `get`, or a card that
    // feature-tests before calling skips a member that works.
    assert.equal('postMessage' in parent, true, 'has must agree with get')

    const message = { type: 'resizeIframe', height: 912 }
    ;(parent['postMessage'] as (...args: unknown[]) => void)(message, '*', [port])
    // The bare-global path too: a card holding `window.parent` and one holding
    // the shadowed `window` reach the same member.
    const own = globals['window'] as Record<string, unknown>
    const viaWindow = (own['parent'] as Record<string, unknown>)['postMessage']
    assert.equal(viaWindow, parent['postMessage'], 'two reads answered two different sinks')
    ;(viaWindow as (...args: unknown[]) => void)('toggle-forum-overlay')
  })

  assert.equal(calls.length, 2, 'the card\'s posts did not reach the sink')
  assert.deepEqual(calls[0]?.[0], { type: 'resizeIframe', height: 912 })
  assert.equal(calls[0]?.[1], '*', 'the target origin was dropped')
  assert.equal((calls[0]?.[2] as unknown[] | undefined)?.[0], port, 'the transfer list was dropped')
  assert.equal(calls[1]?.[0], 'toggle-forum-overlay', 'a bare string message was not carried')
})

test('a card may not overwrite parent.postMessage', () => {
  /*
   * Read-only like `document` and the schedulers, and here the rule is
   * load-bearing rather than merely faithful: this frame runs all of a card's
   * scripts, so a script assigning `parent.postMessage` would be replacing
   * every sibling's sink — and the name is one character away from the
   * shell's own channel, which `tools/check-bootstrap.mjs` keeps captured once
   * at boot precisely so that no late read of it exists to hijack.
   */
  const scope = realm({ postToParent: () => undefined })
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    assert.throws(() => {
      parent['postMessage'] = () => undefined
    }, UnsupportedApiError)
    assert.throws(() => {
      delete parent['postMessage']
    }, UnsupportedApiError)
  })
})

test('a parent without a message sink refuses the name instead of pretending', () => {
  // The unpublished-name policy, as the schedulers and the document stand-in's
  // members follow it: `undefined` plus one report. A half-working stub that
  // swallowed the post would be the silence this whole path exists to remove.
  const scope = realm()
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    assert.equal(parent['postMessage'], undefined, 'postMessage was answered with no sink')
    assert.equal('postMessage' in parent, false, 'has must agree with get')
  })

  const note = scope.posted.find(
    message => (message as { type?: string }).type === 'note'
      && String((message as { message?: string }).message).includes('parent.postMessage'),
  )
  assert.notEqual(note, undefined, 'the absent sink read was silent')
})

test('a membership probe answers for every injected parent member', () => {
  /*
   * `has` disagreeing with `get` is a shape this proxy has already shipped
   * once: `_.has(window, 'Mvu')` polled false forever while `in` said true,
   * and the feature failed with both halves apparently correct. The schedulers
   * had the same disagreement facing the other way — six working functions
   * that `in` denied — which is why this walks the injected set rather than a
   * hand-written list of names.
   */
  const scope = realm({
    postToParent: () => undefined,
    schedulers: {
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      setInterval: () => 0,
      clearInterval: () => undefined,
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => undefined,
    },
  })

  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    let checked = 0
    for (const name of [...VIRTUAL_PARENT_SCHEDULER_MEMBERS, 'postMessage']) {
      assert.equal(typeof parent[name], 'function', `parent.${name} was not answered`)
      assert.equal(name in parent, true, `'${name}' in parent disagreed with the read`)
      checked += 1
    }
    // The compared count as a floor: a loop that silently skipped its own
    // sample would otherwise pass with nothing compared.
    assert.equal(checked, VIRTUAL_PARENT_SCHEDULER_MEMBERS.length + 1)
    // And a name nothing bridges stays absent on both traps.
    assert.equal('cookie' in parent, false)
  })
})

/**
 * Every name the virtual parent's `get` trap answers by name, and every name
 * `isBridged` holds read-only, read out of `frame.ts` itself.
 *
 * **Brittle against our own source, deliberately, and it refuses rather than
 * shrinks.** The alternative was a hand-kept list of bridged names in this
 * file, and a hand-kept list is exactly what the audit below exists to catch:
 * the failure it looks for is a member added to one trap and not the other, and
 * a second hand list would be a third place to forget. So the names come from
 * the implementation, and the floors asserted at the call site turn a broken
 * extraction into a red test instead of a quiet "0 inconsistencies".
 *
 * The regex takes `property === 'name'`, which is how both traps dispatch. Two
 * exclusions, both real:
 *
 * - `typeof property === 'symbol'` matches the shape, so `'symbol'` is dropped
 *   by name — it is a type test, not a member;
 * - the two list-driven families (the schedulers here, the published bag) carry
 *   no literal, so the caller adds `VIRTUAL_PARENT_SCHEDULER_MEMBERS` and the
 *   published names are exercised by their own tests above.
 * @returns the two name sets, in source order.
 */
function parentTrapNames(): { bridged: string[], answered: string[] } {
  const source = readFileSync(new URL('../src/sandbox/frame.ts', import.meta.url), 'utf8')
  const bridgedAt = source.indexOf('const isBridged =')
  const proxyAt = source.indexOf('const virtualParent = new Proxy', bridgedAt)
  const setAt = source.indexOf('    set(_target, property, value): boolean {', proxyAt)
  assert.ok(bridgedAt > 0 && proxyAt > bridgedAt && setAt > proxyAt, 'the trap extraction lost its landmarks in frame.ts')

  const namesIn = (text: string): string[] => [
    ...new Set([...text.matchAll(/property === '([A-Za-z_$][A-Za-z0-9_$]*)'/g)].map(match => match[1] as string)),
  ].filter(name => name !== 'symbol')

  return {
    bridged: namesIn(source.slice(bridgedAt, proxyAt)),
    answered: namesIn(source.slice(proxyAt, setAt)),
  }
}

test('every name the parent answers is a name a membership probe finds', () => {
  /*
   * The audit `#48` asked for, over the **whole** bridged surface rather than
   * over the family that happened to be under repair.
   *
   * That report found `parent.setTimeout` working while `'setTimeout' in parent`
   * said false, and the fix added the schedulers to `has`. The fix was right and
   * the *shape* of the finding was the real result: a proxy where the two traps
   * are two hand-written lists drifts every time one member is added, and the
   * drift is silent in the worst direction — a card that feature-tests before
   * calling (this corpus does, at hundreds of sites) skips a member that works.
   * So this walks every name either trap knows and requires the two to agree.
   *
   * Three context states, because the gates differ by state and a single state
   * cannot tell a gate from a constant:
   *
   * - **nothing pushed** — `SillyTavern` and `extension_settings` must both be
   *   absent, and the schedulers present, so a card's `if (parent.SillyTavern)`
   *   probe takes its own-window branch rather than a half-built host;
   * - **a snapshot pushed** — the normal script-frame state;
   * - **a seeded snapshot, nothing pushed** — an interface frame, whose context
   *   arrives inline in the srcdoc. This state is not a formality: it is where
   *   `extension_settings` disagrees, because the object is built in the
   *   `context` message handler and the seed never reaches it.
   */
  const { bridged, answered } = parentTrapNames()
  const names = [...new Set([...answered, ...bridged, ...VIRTUAL_PARENT_SCHEDULER_MEMBERS])]

  // Floors, not equalities: the point is that the extraction saw the surface.
  // An `assert.equal` on a count here would go red for a correct new member,
  // which is how a guard turns into something people edit past.
  assert.ok(bridged.length >= 14, `only ${String(bridged.length)} bridged names extracted from frame.ts`)
  assert.ok(answered.length >= 15, `only ${String(answered.length)} answered names extracted from frame.ts`)

  const schedulers = {
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
  }

  const states: { label: string, scope: ReturnType<typeof realm> }[] = []
  states.push({ label: 'no context pushed', scope: realm({ postToParent: () => undefined, schedulers }) })
  const pushed = realm({ postToParent: () => undefined, schedulers })
  pushed.send({ iris: 'tok', type: 'context', context: snapshot() })
  states.push({ label: 'a snapshot pushed', scope: pushed })
  states.push({
    label: 'a seeded interface frame',
    scope: realm({ interfaceFrame: true, seeded: snapshot(), postToParent: () => undefined, schedulers }),
  })

  const disagreed: string[] = []
  let compared = 0
  for (const state of states) {
    evaluate(state.scope, globals => {
      const parent = globals['parent'] as Record<string, unknown>
      for (const name of names) {
        /*
         * `in` against a read, which is the pair a card actually writes:
         * `_.has(parent, name)` or `'x' in parent` deciding whether to call
         * `parent.x`. `getOwnPropertyDescriptor` is a third trap with its own
         * test above (lodash's `_.has` reaches that one), and it answers only
         * for published names by design — so it is not folded in here, where a
         * bridged member would have to become an own property to satisfy it.
         */
        const present = name in parent
        const read = parent[name] !== undefined
        compared += 1
        if (present !== read) {
          disagreed.push(`[${state.label}] ${name}: in=${String(present)} get=${read ? 'a value' : 'undefined'}`)
        }
      }
    })
  }

  /*
   * The compared count as a floor. Every read above sits inside a body the
   * sandbox runs in its own try/catch, and `evaluate` only carries assertion
   * failures back out — so a loop that ended early, or a `parent` that came
   * back empty, would report "nothing disagreed" having compared nothing.
   */
  assert.equal(compared, names.length * states.length, `only ${String(compared)} comparisons ran`)
  assert.ok(compared >= 60, `only ${String(compared)} comparisons ran`)
  assert.deepEqual(disagreed, [], `a card probing with \`in\` gets a different answer than reading:\n  ${disagreed.join('\n  ')}`)
})

test('the parent scheduler list is exactly the standard set', () => {
  /*
   * The list is the dispatch: a name added to it becomes a member a card can
   * call, so the list itself is pinned by name. Anything beyond the six the
   * platform defines has to say why it belongs beside them.
   */
  assert.deepEqual([...VIRTUAL_PARENT_SCHEDULER_MEMBERS], [
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ])
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

test('the parent window event surface subscribes on the same bus as eventSource', () => {
  /*
   * Upstream's parent is a real window, so `window.top.addEventListener` is the
   * browser's own bus and a dispatch anywhere on the page is heard. Here the
   * stand-in routes onto the frame's EventBus — the same one `eventSource`
   * wraps — because two buses would split "subscribe through the parent, emit
   * through `eventEmit`" the way the eventSource bridging note describes. The
   * projector card registers `MvuFloatingBgRequest` through `window.top` and
   * the status bar dispatches it from another frame; neither name is in any TH
   * table, which is why this registers without the name guard.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let parent: Record<string, unknown> | undefined
  let bare: Record<string, unknown> | undefined
  evaluate(scope, globals => {
    parent = globals['parent'] as Record<string, unknown>
    bare = globals
  })

  const heard: unknown[] = []
  ;(parent?.['addEventListener'] as (event: string, listener: (event: unknown) => void) => void)(
    'MvuFloatingBgRequest',
    event => heard.push(event),
  )
  void (bare?.['eventEmit'] as (event: string, ...args: unknown[]) => Promise<void>)(
    'MvuFloatingBgRequest',
    { type: 'MvuFloatingBgRequest', detail: { action: 'show', src: 'x.png' } },
  )

  return Promise.resolve().then(() => {
    assert.deepEqual(heard, [{ type: 'MvuFloatingBgRequest', detail: { action: 'show', src: 'x.png' } }])
  })
})

test('parent.removeEventListener removes what addEventListener registered', () => {
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let parent: Record<string, unknown> | undefined
  let emit: ((event: string, ...args: unknown[]) => Promise<void>) | undefined
  const heard: string[] = []
  evaluate(scope, globals => {
    parent = globals['parent'] as Record<string, unknown>
    emit = globals['eventEmit'] as (event: string, ...args: unknown[]) => Promise<void>
  })

  const add = parent?.['addEventListener'] as (event: string, listener: (event: unknown) => void) => void
  const remove = parent?.['removeEventListener'] as (
    event: string,
    listener: (event: unknown) => void,
  ) => void
  const listener = (): void => {
    heard.push('fired')
  }
  add('MvuFloatingBgRequest', listener)
  remove('MvuFloatingBgRequest', listener)
  void emit?.('MvuFloatingBgRequest')

  return Promise.resolve().then(() => {
    assert.deepEqual(heard, [], 'a removed listener was still called')
  })
})

test('parent.dispatchEvent posts a winevent carrying the type and the detail', () => {
  /*
   * The dispatch cannot deliver into a sibling frame itself — no opaque origin
   * can reach one — so it travels to the shell, which rebroadcasts to every
   * frame of the card. What this frame owes the shell is the event's own two
   * facts, named as the protocol names them.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    const dispatch = parent['dispatchEvent'] as (event: unknown) => boolean
    assert.equal(dispatch({ type: 'MvuFloatingBgRequest', detail: { action: 'hide' } }), true)
  })

  const sent = scope.posted.find(message => message.type === 'winevent')
  assert.ok(sent !== undefined, 'a dispatch never reached the shell')
  assert.deepEqual(
    sent,
    { iris: 'tok', type: 'winevent', event: 'MvuFloatingBgRequest', detail: { action: 'hide' } },
  )
})

test('parent.dispatchEvent without a type is refused by name', () => {
  // A null or typeless argument is a card bug, and the refusal should say which
  // member refused rather than dying as `Cannot read properties of undefined`.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let caught: unknown
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    try {
      ;(parent['dispatchEvent'] as (event: unknown) => boolean)({})
      caught = undefined
    } catch (error: unknown) {
      caught = error
    }
  })

  assert.ok(caught instanceof UnsupportedApiError)
  assert.match((caught as Error).message, /parent\.dispatchEvent/u)
})

test('the window event surface is read-only on the parent, like its native namesakes', () => {
  // On a real window these are host-implemented and unwritable; a card that
  // overwrites `parent.addEventListener` would be redefining the page itself.
  const scope = realm()
  let caught: unknown
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    try {
      parent['addEventListener'] = () => undefined
    } catch (error: unknown) {
      caught = error
    }
  })

  assert.ok(caught instanceof UnsupportedApiError)
})


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
   *
   * **The fixture was `parent.toastr` and had to move.** That name is bridged
   * now, so the assertion went red on a change that was correct — the test was
   * pinning an incidental absence rather than the policy it is about. Its
   * replacement is chosen to be durable: `markdown_parser` is a real corpus read
   * (魔法少女的扣扣审判's `if (top.showdown && top.markdown)` chain) whose value
   * on upstream's own page is `undefined`, and it is on the recorded
   * never-to-build list for exactly that reason (DEVIATIONS web §85). A fixture
   * for "an unbridged name" must be a name nobody will bridge.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  let read: unknown = 'unset'
  let threw = false
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    try {
      read = parent['markdown_parser']
    } catch {
      threw = true
    }
  })

  assert.equal(threw, false, 'throwing here breaks read-with-default, which is how publishing starts')
  assert.equal(read, undefined)
  const said = scope.posted.filter(m => m.type === 'note').map(m => (m as { message: string }).message)
  assert.match(said.join(' '), /parent\.markdown_parser/, 'yielding quietly is what loses a gap')
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

test('the facade says which kind of absence it is, upstream’s or nobody’s', () => {
  /*
   * One sentence used to cover two situations that need opposite readings, and
   * the corpus supplies both:
   *
   * - `printMessages` is one of the 145 keys upstream's `getContext()` returns,
   *   and 銀麒赎世 reaches for it behind a `typeof` guard. That is **our**
   *   missing scope, and it belongs in the ledger rather than in a bug report
   *   about the card;
   * - `deleteAllChats` is on nobody's list. A card reaching for it gets
   *   `undefined` on the real SillyTavern page too, so the honest report says
   *   the read found nothing *and* that upstream has nothing of that name — the
   *   defensive-probe idiom ST-CONTEXT-SURFACE-AUDIT §4.2.3 measured 19 times
   *   (branch `dev/audit-st-context-surface`; see
   *   `notes/apps/iris-web/CARD-SURFACE.md`).
   *
   * The list that tells them apart is fetched with the member table rather than
   * inlined per frame, so this also pins that it arrives: a table without it
   * would throw here rather than answer the wrong sentence.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    void bare['printMessages']
    void bare['deleteAllChats']
  })

  const noteFor = (name: string): string => {
    const note = scope.posted.find(
      message => message.type === 'note' && message.message.includes(`SillyTavern.${name}`),
    )
    assert.notEqual(note, undefined, `nothing was said about ${name}`)
    return note?.type === 'note' ? note.message : ''
  }

  const declared = noteFor('printMessages')
  assert.ok(
    declared.includes('missing scope here, not a fault in the card'),
    `a member upstream carries was not attributed to Iris: ${declared}`,
  )
  const invented = noteFor('deleteAllChats')
  assert.ok(
    invented.includes('carries no such member either'),
    `a name upstream does not have was reported as our gap: ${invented}`,
  )
  /*
   * And the two sentences are actually different. Asserting only the substrings
   * above would pass if one branch were dead and both reads produced the
   * *declared* sentence, because that string contains neither of the other's
   * markers — the shape a mutation that deletes the condition takes.
   */
  assert.notEqual(declared, invented, 'both reads produced the same sentence, so the branch is dead')
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

test('a seeded frame answers a parse-time snapshot read with no context push at all', () => {
  /*
   * The timing invariant the srcdoc's seed position exists for, asserted on the
   * consuming side. A message frame's inline card script runs while the
   * document is still parsing, and the pushed `context` message cannot arrive
   * yet — the runner sends it only after the frame reports ready, a full
   * postMessage round trip later. 新·架空政治经济模拟器's status bar calls
   * `getAllVariables()` exactly there, and with the seed unread the call was
   * refused by name and the panel shipped dead.
   *
   * No `context` message is sent in this test at all: with the seed in place
   * the first answer must be the floor's own truth, not a refusal. The seed
   * making the call answer is what "the window is closed" means.
   */
  const scope = realm({
    interfaceFrame: true,
    seeded: snapshot({
      variableLayers: { global: {}, character: {}, script: {}, chat: { hp: 5 } },
    }),
  })

  let answer: unknown = 'unset'
  let threw: string | undefined
  evaluate(scope, globals => {
    try {
      answer = (globals['getAllVariables'] as () => unknown)()
    } catch (error: unknown) {
      threw = String(error instanceof Error ? error.message : error).slice(0, 120)
    }
  })

  assert.equal(threw, undefined, `a parse-time read was refused: ${threw ?? ''}`)
  assert.deepEqual(answer, { hp: 5 }, 'the seed was not the snapshot the call answered from')
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
    // The same-origin fetch bridge, published so imported bundles find it.
    'fetch',
    // The dialog trio, published like every bridged name so a module reaches
    // the bridges too.
    'alert',
    'confirm',
    'prompt',
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
    'getWorldbookNames',
    'getCharWorldbookNames',
    'getLorebookSettings',
    'injectPrompts',
    'uninjectPrompts',
    'getSwipes',
    'replaceVariables',
    'insertOrAssignVariables',
    'insertVariables',
    'deleteVariable',
    'updateVariablesWith',
    'getWorldbook',
    'replaceWorldbook',
    'updateWorldbookWith',
    // The chat-book and creation family, added for the card that mints a chat
    // world book at runtime and appends entries to it while playing.
    // (`getWorldbookNames` itself is listed above, where the page-globals merge
    // placed it.)
    'getGlobalWorldbookNames',
    'getChatWorldbookName',
    'rebindChatWorldbook',
    'rebindGlobalWorldbooks',
    'createWorldbook',
    'getOrCreateChatWorldbook',
    'createWorldbookEntries',
    'swipeTo',
    // The chat-patch member, bare like upstream's injected iframe API, with
    // the append and delete arms that share its route.
    'setChatMessages',
    'createChatMessages',
    'deleteChatMessages',
    'generate',
    // The caller-ordered generate, now on the bare surface where a card's
    // script reads it. It was documented in this file's mapping table and never
    // published — a bare `generateRaw(...)` was a ReferenceError inside the
    // card's own catch, which reads to its player as "the plugin is missing".
    'generateRaw',
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
    // —— family②: regex ——
    'getTavernRegexes',
    'replaceTavernRegexes',
    'updateTavernRegexesWith',
    'isCharacterTavernRegexesEnabled',
    'formatAsTavernRegexedString',
    'TavernHelper',
    // The per-script registry, published with the rest so a failure to define
    // it is reported like anything else — rather than leaving co-located scripts
    // to fail on a preamble whose lookup does not exist.
    '__iris_script__',
    // The shadowed window, for the preamble's `const window`: a module cannot
    // be handed the shadow as a parameter and `top` cannot be published onto
    // the real window, so it rides its own name.
    '__iris_window__',
    // The coordination pair, bare. A card's scripts reach these through the
    // preamble, but the interface markup a script frame carries (神隐挑战's
    // overlay renders into this very body) reads them as bare globals, and it
    // opens with `typeof waitGlobalInitialized === 'undefined'` — upstream's
    // predefine.js answers that in every iframe, so this surface does too.
    'initializeGlobal',
    'waitGlobalInitialized',
  ])
})

test('an interface frame’s bare SillyTavern answers once the context lands, not never', () => {
  /*
   * The interface install publishes the surface **before** any context can have
   * arrived, and `resolveValues()` answered `undefined` for the two
   * context-dependent names at that moment — an answer `defineProperty` then
   * froze onto the window. Bare `SillyTavern` in interface markup therefore
   * read absent forever, which is the exact answer "this host is not SillyTavern"
   * that a plugin self-check fails on; the parent spelling was never wrong,
   * because `parent.SillyTavern` answers live. So the context handler
   * re-publishes the two names when they first have an answer, and the bare
   * spelling agrees with the parent spelling from then on — checked here
   * against the parent proxy, which is a source this list does not share.
   */
  const scope = realm({ interfaceFrame: true })
  assert.equal(scope.publishedValue('SillyTavern'), undefined, 'published before the context arrived')
  // The install-time parent proxy, captured before the re-publish narrows this
  // test's recording of the published bag: the real frame defines properties
  // additively, but the recorded snapshot here is whole-list.
  const parent = scope.publishedValue('parent') as Record<string, unknown>

  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  const bare = scope.publishedValue('SillyTavern')
  assert.notEqual(bare, undefined, 'still undefined after the context landed')
  assert.equal(bare, parent['SillyTavern'], 'bare and parent spellings disagree')

  // `extension_settings` under the same rule, and re-published per snapshot:
  // the settings proxy is rebuilt for every context message, and a stale one
  // under the bare name would take a card's write to a dead object.
  const first = scope.publishedValue('extension_settings')
  assert.notEqual(first, undefined, 'extension_settings stayed absent after the context landed')
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'next' }) })
  assert.notEqual(
    scope.publishedValue('extension_settings'),
    first,
    'extension_settings was not re-published on the next snapshot',
  )
})

test('an interface frame publishes the Tavern Helper surface bare', () => {
  /*
   * Upstream injects the Tavern Helper API into every message iframe as plain
   * globals, so a message frame's own inline script reaches
   * `setChatMessages(...)` bare. Namespaced-only here meant the measured card's
   * start button clicked, ran, and died on a ReferenceError its own try/catch
   * swallowed — the player saw a button that does nothing. The bare spellings
   * must be the *same objects* the `parent.TavernHelper` spelling hands out:
   * one surface, two ways to reach it.
   */
  const scope = realm({ interfaceFrame: true })
  const parent = scope.publishedValue('parent') as Record<string, unknown>
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  const namespaced = parent['TavernHelper'] as Record<string, unknown>
  assert.notEqual(namespaced, undefined, 'the parent spelling of the surface was absent')
  for (const name of ['triggerSlash', 'setChatMessages', 'getChatMessages', 'eventOn']) {
    assert.equal(
      scope.publishedNames().includes(name),
      true,
      `the bare name ${name} stayed absent, so a card's own script cannot call it`,
    )
    assert.equal(
      scope.publishedValue(name),
      (namespaced as Record<string, unknown>)[name],
      `the bare ${name} disagrees with the parent.TavernHelper spelling`,
    )
  }
  // And the namespace itself is reachable bare too, matching the parent's copy.
  assert.deepEqual(scope.publishedValue('TavernHelper'), namespaced)
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

test('getCurrentMessageId answers the floor a message frame was built for', () => {
  // 建国控制台 opens with `typeof getCurrentMessageId === 'function'` — true for
  // any function, including one that only throws — then calls it to name the
  // floor whose MVU layer it writes. A member that passes the probe and fails
  // the call silently skips the whole write. The shell now tells the frame its
  // floor, and the member answers with it.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot(), floor: 3 })

  evaluate(scope, globals => {
    const read = globals['getCurrentMessageId'] as () => number
    globals['__read'] = read()
  })
  assert.equal(scope.globals()['__read'], 3)
})

test('getCurrentMessageId keeps the upstream throw in a script frame', () => {
  // No `floor` on the context: a script frame is not a message iframe, and
  // upstream throws there on purpose. The contract survives the message-frame
  // half gaining the real answer.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    const read = globals['getCurrentMessageId'] as () => number
    try {
      globals['__read'] = read()
      globals['__threw'] = false
    } catch {
      globals['__threw'] = true
    }
  })
  assert.equal(scope.globals()['__threw'], true)
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

/*
 * The same-origin fetch bridge. The measured casualty it exists for:
 * MagVarUpdate's bundle — imported by every MVU card — opens with
 * `fetch('/version')`, which under `connect-src 'none'` was refused with a
 * banner naming Iris's own host.
 */

/** Let the bridge's promise callbacks run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

test('a same-origin relative fetch rides the bridge and returns the content', async () => {
  const scope = realm()
  let response: Response | undefined
  evaluate(scope, globals => {
    void (globals['fetch'] as (input: string) => Promise<Response>)('/version').then(
      answered => {
        response = answered
      },
    )
  })

  const sent = scope.posted.find(message => message.type === 'fetch')
  assert.ok(sent?.type === 'fetch', 'the request never went to the shell')
  assert.equal(sent.url, 'http://127.0.0.1:8791/version', 'the card must not be asked to resolve it')
  assert.deepEqual(scope.nativeFetches(), [], 'the native fetch would be refused by CSP again')

  scope.send({
    iris: 'tok',
    type: 'fetch:ok',
    id: sent.id,
    content: '{"pkgVersion":"1.12.2"}',
    status: 200,
    contentType: 'application/json',
  })
  await settle()

  assert.ok(response instanceof Response, 'the promise never resolved')
  assert.equal(response.status, 200)
  assert.equal(response.ok, true)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.equal(await response.text(), '{"pkgVersion":"1.12.2"}', 'a real Response, so .json() works')
})

test('a fetch answer without status or type still reads as a plain 200', () => {
  // The remote-dependency path predates the two fields and sends neither.
  const scope = realm()
  let response: Response | undefined
  evaluate(scope, globals => {
    void (globals['fetch'] as (input: string) => Promise<Response>)('/anything').then(
      answered => {
        response = answered
      },
    )
  })
  const sent = scope.posted.find(message => message.type === 'fetch')
  assert.ok(sent?.type === 'fetch')
  scope.send({ iris: 'tok', type: 'fetch:ok', id: sent.id, content: 'body' })
  return Promise.resolve().then(async () => {
    assert.equal(response?.status, 200)
    assert.equal(await response?.text(), 'body')
  })
})

test('a cross-origin fetch is left native, where CSP refuses and reports it', () => {
  // Not bridging is the policy: the shell must not become a proxy for whatever
  // host a card names. The native request is what trips `securitypolicyviolation`
  // and produces the blocked report the shell displays.
  const scope = realm()
  evaluate(scope, globals => {
    void (globals['fetch'] as (input: string) => Promise<Response>)(
      'https://cdn.jsdelivr.net/npm/vue',
    )
  })

  assert.equal(scope.posted.some(message => message.type === 'fetch'), false)
  assert.equal(scope.nativeFetches().length, 1)
  assert.equal(scope.nativeFetches()[0]?.input, 'https://cdn.jsdelivr.net/npm/vue')
})

test('a POST to our own origin is not bridged', () => {
  /*
   * GET is retrieval; a POST with the user's credentials attached could be a
   * state-changing call to Iris itself. Upstream cards fetch their own server's
   * endpoints that way, and here the refusal is honest: the endpoint does not
   * exist, and the banner says so, instead of the shell executing the call.
   */
  const scope = realm()
  evaluate(scope, globals => {
    void (globals['fetch'] as (i: string, init?: unknown) => Promise<Response>)(
      '/api/chats/export',
      { method: 'POST', body: '{"format":"jsonl"}' },
    )
  })

  assert.equal(scope.posted.some(message => message.type === 'fetch'), false)
  assert.equal(scope.nativeFetches().length, 1)
})

test('a request with headers is not bridged, because the wire carries none', () => {
  // A bridge that quietly dropped a card's headers would answer a different
  // request than the one it made; going native keeps the refusal truthful.
  const scope = realm()
  evaluate(scope, globals => {
    void (globals['fetch'] as (i: string, init?: unknown) => Promise<Response>)('/version', {
      headers: { accept: 'application/json' },
    })
  })

  assert.equal(scope.posted.some(message => message.type === 'fetch'), false)
  assert.equal(scope.nativeFetches().length, 1)
})

test('an absolute URL on the shell origin rides the bridge too', () => {
  const scope = realm()
  evaluate(scope, globals => {
    void (globals['fetch'] as (input: string) => Promise<Response>)(
      'http://127.0.0.1:8791/api/thing',
    )
  })

  const sent = scope.posted.find(message => message.type === 'fetch')
  assert.ok(sent?.type === 'fetch')
  assert.equal(sent.url, 'http://127.0.0.1:8791/api/thing')
})

test('a refused ride rejects the way a network failure would', async () => {
  const scope = realm()
  let failure: unknown
  evaluate(scope, globals => {
    void (globals['fetch'] as (input: string) => Promise<Response>)('/gone').catch(
      error => {
        failure = error
      },
    )
  })

  const sent = scope.posted.find(message => message.type === 'fetch')
  assert.ok(sent?.type === 'fetch')
  scope.send({ iris: 'tok', type: 'fetch:error', id: sent.id, message: 'HTTP 404' })
  await settle()

  assert.ok(failure instanceof Error)
  assert.match((failure as Error).message, /404/)
})

test('a bodyless empty-status answer is still a Response', async () => {
  // 204 forbids a body; building one would make the Response constructor throw
  // inside the frame instead of answering the card.
  const scope = realm()
  let response: Response | undefined
  evaluate(scope, globals => {
    void (globals['fetch'] as (input: string) => Promise<Response>)('/done').then(
      answered => {
        response = answered
      },
    )
  })

  const sent = scope.posted.find(message => message.type === 'fetch')
  assert.ok(sent?.type === 'fetch')
  scope.send({ iris: 'tok', type: 'fetch:ok', id: sent.id, content: '', status: 204 })
  await settle()

  assert.equal(response?.status, 204)
  assert.equal(await response?.text(), '')
})

test('the fetch bridge is published for module code as well', () => {
  // Imported bundles read the window, not a parameter — the bridge only exists
  // for them if publishing puts it there.
  const scope = realm({ interfaceFrame: true })
  assert.equal(typeof scope.publishedValue('fetch'), 'function')
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

test('a card\'s in-place chat edits reach the host when it calls saveChat', async () => {
  /*
   * **The module was built and never wired.** `chat-journal.ts` — the Proxy, the
   * ordered journal, the replay — was designed against the two measured cards
   * and shipped green, and until now its only consumer was its own test file.
   * So `SillyTavern.chat` was a plain copy, and the sequence those cards write
   * (`chat[i].mes = x` then `saveChat()`) put the edit in the copy and the save
   * in the host, with nothing thrown and nothing said. A test suite can be
   * entirely green about a fix nobody installed.
   *
   * This is the assertion that could not be made from inside `chat-journal.ts`:
   * it faces the seam, not the module. The card writes through the surface a
   * card actually holds — `getContext().chat` — and the wire is what is
   * inspected.
   *
   * The exact corpus shape, from `notes/apps/iris-web/CHAT-WRITES.md`: a rewrite
   * and a delete in one batch, saved once at the end.
   */
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({
      chat: [
        { mes: 'first', is_user: false },
        { mes: 'second', is_user: true },
      ],
    }),
  })
  evaluate(scope, () => undefined, 'first')

  const surface = scope.globals()['SillyTavern'] as Record<string, unknown>
  const chat = (surface['getContext'] as () => Record<string, unknown>)()['chat'] as Record<string, unknown>[]

  // The two measured mutations, in the order a card makes them.
  ;(chat[0] as Record<string, unknown>)['mes'] = 'rewritten'
  ;(chat as unknown as { splice: (i: number, n: number) => unknown }).splice(1, 1)
  // The card's own read-back must show the change — upstream's live array does
  // that for free, and a recorder that only journalled would regress it.
  assert.equal((chat[0] as Record<string, unknown>)['mes'], 'rewritten')
  assert.equal(chat.length, 1, 'the working copy did not follow the splice')

  const saved = (surface['saveChat'] as () => Promise<void>)()

  /** Answer whatever call is outstanding, so the sequential replay can proceed. */
  const answerNext = async (seen: number): Promise<{ method: string, params: Record<string, unknown> }> => {
    for (let tries = 0; tries < 50; tries += 1) {
      const calls = scope.posted.filter(message => message.type === 'call') as unknown as
        { id: string, method: string, params: Record<string, unknown> }[]
      const next = calls[seen]
      if (next !== undefined) {
        scope.send({ iris: 'tok', type: 'call:ok', id: next.id, result: {} })
        return { method: next.method, params: next.params }
      }
      await Promise.resolve()
    }
    throw new Error(`no call number ${String(seen)} was made`)
  }

  const first = await answerNext(0)
  const second = await answerNext(1)
  const third = await answerNext(2)
  await saved

  /*
   * Order is the assertion, not merely membership. One measured card works back
   * to front so that each index is valid against the array as the earlier
   * entries in the same batch left it; a replay that sorted, batched or
   * deduplicated these would delete different floors, silently.
   */
  assert.equal(first.method, 'setChatMessages')
  assert.deepEqual(first.params, { messages: [{ messageId: 0, message: 'rewritten' }] })
  assert.equal(second.method, 'deleteChatMessages')
  assert.deepEqual(second.params, { messageIds: [1] })
  // One commit at the end, not one per entry: upstream's save is debounced, so a
  // card making ten edits produces one save there too.
  assert.equal(third.method, 'saveChat')

  const calls = scope.posted.filter(message => message.type === 'call')
  assert.equal(calls.length, 3, 'the replay sent more calls than the journal held')
})

test('a floor a card pushes onto getContext().chat reaches the host', async () => {
  /*
   * 銀麒赎世's 手机UI, transcribed rather than invented (L19167-19185, and the
   * same block at five more sites):
   *
   *   var chat = context.chat;
   *   var newMessage = { name, is_user: true, is_system: false, mes, extra: {}, send_date };
   *   chat.push(newMessage);
   *   if (typeof context.saveChat === "function") context.saveChat();
   *
   * The card is inserting a forum event as a user floor so the next generation
   * sees it. Before the journal was wired the push landed in a copy, the save
   * stored the host's array without it, and the card logged *"已插入楼层"* — a
   * success message for a floor that did not exist. Six sites, one card, no
   * error anywhere.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ chat: [{ mes: 'first', is_user: false }] }) })
  evaluate(scope, () => undefined, 'first')

  const surface = scope.globals()['SillyTavern'] as Record<string, unknown>
  const context = (surface['getContext'] as () => Record<string, unknown>)()
  const chat = context['chat'] as Record<string, unknown>[]

  const newMessage = {
    name: context['name1'],
    is_user: true,
    is_system: false,
    mes: '<ForumMeetEvent>…</ForumMeetEvent>',
    extra: {},
    send_date: 1_700_000_000_000,
  }
  ;(chat as unknown as { push: (m: unknown) => number }).push(newMessage)
  assert.equal(chat.length, 2, 'the card must read back the floor it just pushed')

  const saved = (surface['saveChat'] as () => Promise<void>)()
  const drain = async (): Promise<{ method: string, params: Record<string, unknown> }[]> => {
    const seen: { method: string, params: Record<string, unknown> }[] = []
    for (let tries = 0; tries < 80; tries += 1) {
      const calls = scope.posted.filter(message => message.type === 'call') as unknown as
        { id: string, method: string, params: Record<string, unknown> }[]
      const next = calls[seen.length]
      if (next === undefined) { await Promise.resolve(); continue }
      seen.push({ method: next.method, params: next.params })
      scope.send({ iris: 'tok', type: 'call:ok', id: next.id, result: {} })
      if (next.method === 'saveChat') return seen
    }
    throw new Error('the replay never reached its commit')
  }
  const sent = await drain()
  await saved

  assert.deepEqual(sent.map(call => call.method), ['createChatMessages', 'saveChat'])
  /*
   * Every field this card sets survives — `name`, `is_user`, `is_system`, `mes`,
   * `extra` and `send_date` are all fields the host's append arm understands.
   * Asserted whole rather than field by field: a narrowing that quietly dropped
   * `is_user` would file the forum event as the character's line, which reads as
   * a plausible chat and is wrong in a way no later step can detect.
   */
  assert.deepEqual(sent[0]?.params, { messages: [newMessage] })
})

test('a saveChat with nothing to replay is still a save', () => {
  /*
   * The shape every non-mutating caller has — 銀麒赎世's
   * `if (typeof context.saveChat === "function") context.saveChat()` closing a
   * read-only refresh. `replayChatEdits` returns without committing when the
   * journal is empty, so a wiring that routed every save through it would turn
   * the commonest call into a no-op: the card would be told it saved and nothing
   * would have been written.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    void (bare['saveChat'] as () => Promise<void>)()
  })

  const calls = scope.posted.filter(message => message.type === 'call') as unknown as
    { method: string, params: Record<string, unknown> }[]
  assert.deepEqual(calls.map(call => call.method), ['saveChat'])
  assert.deepEqual(calls[0]?.params, {})
})

test('the chat a card holds keeps its floor tables lazy', () => {
  /*
   * The order the recorder and `restoreFloorTables` are installed in, asserted
   * from the outside because getting it wrong is invisible: the recorder copies
   * each row, so a copy taken *after* the getters were installed would spread
   * through every one of them — parsing every floor's variable tables eagerly,
   * which is the exact cost the string encoding exists to avoid, and losing the
   * self-replacing cache with it. Nothing would throw and no assertion about
   * values would change; only the bill would.
   *
   * The instrument is a floor whose `variables` text is **unparseable**: a
   * getter that has not been read reports nothing, and an eager spread would
   * have read all of them before any card ran.
   */
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({
      chat: [
        { mes: 'a', is_user: false, variables: '{{{ not json' },
        { mes: 'b', is_user: false, variables: '[{"x":1}]' },
      ],
    }),
  })
  evaluate(scope, () => undefined, 'first')

  /**
   * Everything the frame has said, on both report channels.
   *
   * `error`, not `fault`: the fault channel posts `type: 'error'` and there is
   * no `'fault'` message at all. Naming a type the protocol does not have was
   * this test's first mistake — the filter then collected nothing and
   * `doesNotMatch` passed against an empty string whatever the code did. Found
   * because the mutation that swaps the two installs turned two *pre-existing*
   * tests red and left this one green.
   * @returns the messages, joined.
   */
  const said = (): string =>
    scope.posted
      .filter(message => message.type === 'note' || message.type === 'error')
      .map(message => String((message as { message?: string }).message ?? ''))
      .join(' ')

  const quiet = said()

  const surface = scope.globals()['SillyTavern'] as Record<string, unknown>
  const chat = (surface['getContext'] as () => Record<string, unknown>)()['chat'] as Record<string, unknown>[]
  // The getter still works when a card does read it: lazy, not absent.
  assert.deepEqual((chat[1] as Record<string, unknown>)['variables'], [{ x: 1 }])

  /*
   * **The positive control, and it is what makes the silence above a
   * judgement.** Reading the unparseable floor must produce exactly the report
   * the earlier assertion says had not happened yet; without this the whole
   * test is "we looked for a string and did not find one", which is also what a
   * broken matcher, a renamed message and a wrong channel all look like.
   */
  assert.deepEqual((chat[0] as Record<string, unknown>)['variables'], [])
  assert.match(said(), /variable tables could not be parsed/, 'the instrument cannot see the thing it is looking for')
  assert.doesNotMatch(
    quiet,
    /variable tables could not be parsed/,
    'a floor table was parsed before any card read it',
  )
})

test('a chat mutation Iris cannot save is refused in the card\'s own stack', () => {
  /*
   * Constraint 1 of the journal design, asserted through the wired surface: a
   * mutation with no counterpart must throw where the card made it, not vanish
   * at save time. `sort` is the clearest case — it changes every index the later
   * entries were recorded against.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })
  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    const chat = (bare['getContext'] as () => Record<string, unknown>)()['chat'] as Record<string, unknown>[]
    assert.throws(
      () => { (chat as unknown as { sort: () => unknown }).sort() },
      UnsupportedApiError,
      'a mutation with no counterpart must be refused, not silently dropped',
    )
  })
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
    'loadWorldInfo',
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
   * [notes/apps/iris-web/OVERLAY-CARDS.md, V1.5.4] That card probes every Tavern Helper member with
   * `typeof … === 'function'` and warns-and-degrades when one is missing. If a
   * refusal threw at *property access* time, the probe itself would explode and
   * the card's own fallback — the thing it wrote to survive a missing member —
   * would never run. A named refusal that prevents the degradation it was meant
   * to make legible is worse than an absence.
   *
   * `notes/apps/iris-web/COHABITATION.md` already fixes this for `has`/`in` on the virtual parent.
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
test('loadWorldInfo keeps its three answers apart', async () => {
  /*
   * **Three answers, not two.** Upstream opens with `if (!name) return`, so a
   * card that asked nothing gets `undefined` without storage being touched;
   * a card that named a book nobody has gets `null`. Collapsing them answers
   * "there is no such book" to a card that never named one — and MVU's own
   * guard reads `loaded.entries`, so it distinguishes them by whether it may
   * index the result at all.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const surface = scope.globals()['SillyTavern'] as Record<string, unknown>
  const load = surface['loadWorldInfo'] as (name?: unknown) => Promise<unknown>
  assert.equal(typeof load, 'function', 'the member a real card found missing')

  // Nothing asked: no wire call at all, which is the half a mock could not show
  // if the call were merely ignored.
  const before = scope.posted.filter(message => message.type === 'call').length
  assert.equal(await load(), undefined, 'an absent name must not become a lookup')
  assert.equal(await load(''), undefined, 'upstream takes the empty string through the same return')
  assert.equal(
    scope.posted.filter(message => message.type === 'call').length,
    before,
    'a name-less call reached the wire',
  )
})

test('loadWorldInfo hands back the raw uid-keyed object, not our entry array', async () => {
  /*
   * The shape is the point. `getWorldbook` normalises to an array of entries;
   * this returns the book as saved, keyed by uid, because MVU guards with
   * `isPlainObject(loaded.entries)` and then indexes by uid — an array passes
   * that guard's spirit-less form and fails at the first index, which is the
   * failure this project keeps paying for.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const surface = scope.globals()['SillyTavern'] as Record<string, unknown>
  const load = surface['loadWorldInfo'] as (name?: unknown) => Promise<unknown>

  const pending = load('\u4e16\u754c\u4e66')
  const call = scope.posted.find(
    message => message.type === 'call'
      && (message as unknown as { method: string }).method === 'loadWorldInfo',
  ) as unknown as { id: string, params: Record<string, unknown> } | undefined
  assert.notEqual(call, undefined, 'the lookup never reached the wire')
  assert.equal(call?.params['name'], '\u4e16\u754c\u4e66')

  const book = { entries: { '0': { uid: 0, comment: 'a' }, '7': { uid: 7, comment: 'b' } } }
  scope.send({ iris: 'tok', type: 'call:ok', id: call?.id ?? '', result: { book } })
  const loaded = await pending
  assert.deepEqual(loaded, book, 'the book must arrive in the shape it is saved in')
  assert.equal(Array.isArray((loaded as { entries: unknown }).entries), false)
})

test('a book nobody has is null, which is not the same as not asking', async () => {
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const surface = scope.globals()['SillyTavern'] as Record<string, unknown>
  const load = surface['loadWorldInfo'] as (name?: unknown) => Promise<unknown>

  const pending = load('missing')
  const call = scope.posted.find(
    message => message.type === 'call'
      && (message as unknown as { method: string }).method === 'loadWorldInfo',
  ) as unknown as { id: string } | undefined
  // The contract's reply is `{ book?: unknown }`, so an absent key is the host
  // saying it looked and found nothing.
  scope.send({ iris: 'tok', type: 'call:ok', id: call?.id ?? '', result: {} })
  assert.equal(await pending, null)
})

test('getLorebookSettings answers synchronously, from the snapshot', () => {
  /*
   * **Synchronous is the requirement, not a convenience.** The MVU bundle has a
   * call site that does not `await` it; as an RPC that site would hold a
   * `Promise` and read sixteen `undefined` fields off it without throwing, then
   * configure its scan against nothing. So this asserts the return is not a
   * promise — a test that only checked the values would pass on the async
   * implementation the moment someone "tidied" this onto the wire.
   */
  const settings = {
    selected_global_lorebooks: ['a', 'b'],
    scan_depth: 4,
    context_percentage: 25,
    budget_cap: 0,
    min_activations: 0,
    max_depth: 0,
    max_recursion_steps: 0,
    insertion_strategy: 'evenly' as const,
    include_names: true,
    recursive: false,
    case_sensitive: false,
    match_whole_words: true,
    use_group_scoring: false,
    overflow_alert: false,
  }
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({ characterId: 'char', lorebookSettings: settings }),
  })
  evaluate(scope, () => undefined, 'first')

  const read = scope.globals()['getLorebookSettings'] as () => unknown
  assert.equal(typeof read, 'function', 'the bare global a real card found undefined')

  const got = read() as Record<string, unknown>
  assert.equal(typeof (got as { then?: unknown }).then, 'undefined', 'it must not be a promise')
  assert.deepEqual(got, settings)

  // No wire call: reading settings must not be a round trip, or the synchronous
  // answer above would be a lie about where the value came from.
  assert.equal(
    scope.posted.filter(message => message.type === 'call').length,
    0,
    'a snapshot read reached the wire',
  )
})

test('the settings a card is handed cannot be edited under the next reader', () => {
  // Same reasoning as `getCharWorldbookNames`: this surface is shared between a
  // card's scripts, and `selected_global_lorebooks` is an array a card could
  // sort in place.
  const settings = {
    selected_global_lorebooks: ['b', 'a'],
    scan_depth: 4,
    context_percentage: 25,
    budget_cap: 0,
    min_activations: 0,
    max_depth: 0,
    max_recursion_steps: 0,
    insertion_strategy: 'evenly' as const,
    include_names: true,
    recursive: false,
    case_sensitive: false,
    match_whole_words: true,
    use_group_scoring: false,
    overflow_alert: false,
  }
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({ characterId: 'char', lorebookSettings: settings }),
  })
  evaluate(scope, () => undefined, 'first')

  const read = scope.globals()['getLorebookSettings'] as () => {
    selected_global_lorebooks: string[]
  }
  const first = read()
  first.selected_global_lorebooks.sort()
  assert.deepEqual(read().selected_global_lorebooks, ['b', 'a'], 'the card mutated the snapshot')
})

test('no settings in the snapshot is reported, not defaulted', () => {
  /*
   * Sixteen invented values would each be plausible and the composite would be a
   * configuration nobody chose — a card would then configure its scan against
   * it and produce a subtly wrong prompt with nothing to read. Absent says
   * absent, on the note channel, because nothing failed.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const read = scope.globals()['getLorebookSettings'] as () => unknown
  assert.equal(read(), undefined)

  const notes = scope.posted
    .filter(message => message.type === 'note')
    .map(message => (message as unknown as { message: string }).message)
  assert.equal(notes.filter(line => line.includes('getLorebookSettings')).length, 1, notes.join(' | '))
  assert.match(notes.join(' '), /not a statement that none are set/)
})

test('a surface member with no argument translation is refused, not sent as a generation', () => {
  /*
   * **The misroute this closes.** Every SillyTavern-surface member without its
   * own branch used to fall into a body that called `script.generateRaw`
   * whatever name had been read — so `SillyTavern.generate('hi')` ran
   * `generateRaw`, which takes `prompt` and carries no history, in place of
   * `generate`, which takes `userInput` and does. The surface pin asserts the
   * member *names*, which is precisely the assertion a misroute passes.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const surface = scope.globals()['SillyTavern'] as Record<string, unknown>

  // `generate` now sends its own method, with its own field name.
  void (surface['generate'] as (input: unknown) => unknown)('hi')
  void (surface['generateRaw'] as (input: unknown) => unknown)('hi')
  const calls = scope.posted
    .filter(message => message.type === 'call')
    .map(message => message as unknown as { method: string, params: Record<string, unknown> })
  assert.deepEqual(calls.map(call => call.method), ['generate', 'generateRaw'])
  assert.equal(calls[0]?.params['userInput'], 'hi')
  assert.equal(calls[1]?.params['prompt'], 'hi')

  // And a routable member whose arguments nobody has translated says so by name
  // rather than being handed to whichever branch is last.
  assert.throws(
    () => (surface['setVariables'] as (input: unknown) => unknown)('a string'),
    /has not built the translation/,
    'a string argument used to be sent as a generation',
  )
})
test('an interface frame gets the same Tavern Helper surface, without being asked to run', () => {
  /*
   * **The bug this exists for.** Everything a card can touch — the bare Tavern
   * Helper globals, the `toastr` substitute, the missing-libraries report — was
   * published on the `run` message. An interface frame never receives one: its
   * markup, `<script>` elements included, executes while the document parses. So
   * it reached its card code with an *empty* surface, and a real card produced
   * `ReferenceError: errorCatched is not defined` from markup upstream serves
   * without trouble.
   *
   * Upstream has no such split: `predefine.js` goes into both frame kinds with
   * the same member set, and in places the interface side is the *only* side a
   * member is used from — 44 measured `triggerSlash` in 7 interface-side cards
   * and zero script-side.
   */
  const scope = realm({ interfaceFrame: true })

  const names = scope.publishedNames()
  for (const name of ['errorCatched', 'triggerSlash', 'getChatMessages', 'waitGlobalInitialized']) {
    assert.ok(names.includes(name), `${name} was not published: ${names.join(', ')}`)
  }
  // And `errorCatched` in particular is callable, not merely named: the card
  // *calls* it, so a name bound to undefined trades a ReferenceError for a
  // TypeError one line later.
  const wrap = scope.publishedValue('errorCatched') as (fn: unknown) => unknown
  assert.equal(typeof wrap, 'function')
  assert.equal((wrap(() => 7) as () => number)(), 7)

  // The toastr substitute too, since a card's `catch` block reaches for it and
  // an absent one turns a handled error into the cause of death.
  assert.notEqual(scope.reportFromToastr?.(), undefined, 'provideToastr was never called')
})

test('an interface frame publishes no script registry, because it has no scripts', () => {
  /*
   * Deliberately absent, not forgotten. The registry hands out per-script
   * bindings, and this frame holds no script identity — so the identity-bearing
   * members answer through the shared surface and report the ambiguity, which is
   * the honest answer, rather than a registry issuing bindings for an id nobody
   * holds.
   */
  const scope = realm({ interfaceFrame: true })
  assert.equal(
    scope.publishedNames().includes(SCRIPT_REGISTRY),
    false,
    'a frame with no scripts published a per-script registry',
  )

  // And it does not claim to have run anything, or the panel's script
  // accounting would count a frame that has no scripts.
  assert.equal(scope.posted.some(message => message.type === 'ran'), false)
})

test('a script frame still publishes nothing before it is asked to run', () => {
  /*
   * The other half, and the one that keeps the change honest: publishing at
   * install for *every* frame would have made the test above pass while giving
   * a script frame its surface before the `run` message that carries its
   * identity — so `getScriptId()` would answer for a script that had not
   * started.
   */
  const scope = realm()
  assert.deepEqual(scope.publishedNames(), [], 'a script frame published before running')
  assert.deepEqual(scope.posted, [], 'installing must not announce anything')
})
test('a frame is given a localStorage before its card code runs', () => {
  /*
   * **Before**, not merely at some point. pinia pulls in `@vue/devtools-kit`,
   * which decides whether it has storage with `typeof localStorage > 'u'` — and
   * on an opaque origin *that read itself throws*. So the shadow has to be in
   * place before the preset's modules evaluate, which is why the frame offers it
   * ahead of the libraries rather than beside the card's body.
   */
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({ characterId: 'char', storage: { wallpaper: 'data:abc' } }),
  })
  evaluate(scope, () => undefined, 'first')

  const storage = scope.storage()
  assert.notEqual(storage, undefined, 'the frame never asked for storage to be installed')
  assert.equal((storage?.['getItem'] as (key: string) => unknown)('wallpaper'), 'data:abc')
  // The property spelling too, which is how 44's four bare startup points reach
  // it — all four are `localStorage.x` at module top level.
  assert.equal(storage?.['wallpaper'], 'data:abc')
})

test('an interface frame gets storage too, since its markup runs at parse time', () => {
  // Interface-side storage use is not zero: 44 measured 5 cards and 50 access
  // points, none at top level but all in interaction handlers. A frame that
  // received storage only on `run` would serve none of them.
  const scope = realm({ interfaceFrame: true })
  assert.notEqual(scope.storage(), undefined)
})

test('a card write goes out as a routed action, attributed to the card', async () => {
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({ characterId: 'char', storage: {} }),
  })
  evaluate(scope, () => undefined, 'first')

  const storage = scope.storage() as Record<string, unknown>
  ;(storage['setItem'] as (key: string, value: string) => void)('theme', 'dark')

  // Visible immediately, which the overlay is what provides: the write has not
  // reached the host yet, and a card reading back its own value must not miss.
  assert.equal((storage['getItem'] as (key: string) => unknown)('theme'), 'dark')

  await Promise.resolve()
  const call = scope.posted.find(
    message => message.type === 'call'
      && (message as unknown as { method: string }).method === 'storageSet',
  ) as unknown as { params: Record<string, unknown> } | undefined
  assert.notEqual(call, undefined, `the write never reached the wire: ${JSON.stringify(scope.posted)}`)
  assert.equal(call?.params['key'], 'theme')
  assert.equal(call?.params['value'], 'dark')
  /*
   * `characterId` is attribution, not ownership: the store is one profile-wide
   * store, so the id records who wrote a key last — which is what lets a later
   * `clear()` report whose keys it took.
   */
  assert.equal(call?.params['characterId'], 'char')
})

test('a write with no character open is reported rather than attributed to nobody', async () => {
  /*
   * The contract requires a `characterId` and the frame will not invent one. A
   * write in this window is reachable while a chat is closing, and the honest
   * outcome is the value living in this frame and a report saying it will not
   * survive — which is exactly what a rejected write-through produces.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ storage: {} }) })
  evaluate(scope, () => undefined, 'first')

  const storage = scope.storage() as Record<string, unknown>
  ;(storage['setItem'] as (key: string, value: string) => void)('k', 'v')
  await Promise.resolve()
  await Promise.resolve()

  const said = scope.posted
    .filter(message => message.type === 'error')
    .map(message => (message as unknown as { message: string }).message)
  assert.equal(said.filter(line => line.includes('no character is open')).length, 1, said.join(' | '))
  assert.match(said.join(' '), /gone when this chat is opened again/)
  assert.equal(
    scope.posted.some(
      message => message.type === 'call'
        && (message as unknown as { method: string }).method === 'storageSet',
    ),
    false,
    'an unattributable write must not reach the host',
  )
})
test('a card reading chat[i].variables directly gets the tables, not the JSON text', () => {
  /*
   * **The silent failure this closes, in the card's own words.** MVU's restore
   * guard is `_.has(chat[i].variables[swipe_id], 'stat_data')`. The floor tables
   * cross the wire as JSON text, and on a string `variables[swipe_id]` is one
   * **character** — so `_.has` of it is false, forever, with nothing thrown and
   * nothing reported. The card concludes there is nothing to restore and starts
   * from defaults over a live save.
   *
   * So the assertion is written the way the card reads it, not the way the
   * facade returns it: index the field, then look for the key.
   */
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({
      characterId: 'char',
      chat: [
        {
          name: 'Her',
          is_user: false,
          mes: 'reply',
          swipe_id: 1,
          variables: JSON.stringify([{ stat_data: { hp: 1 } }, { stat_data: { hp: 2 } }]),
        },
      ],
    }),
  })
  evaluate(scope, () => undefined, 'first')

  const surface = scope.globals()['SillyTavern'] as { getContext: () => { chat: unknown[] } }
  const row = surface.getContext().chat[0] as { variables: unknown[], swipe_id: number }

  assert.equal(Array.isArray(row.variables), true, 'the card was handed the JSON text')
  const table = row.variables[row.swipe_id] as Record<string, unknown>
  assert.deepEqual(table, { stat_data: { hp: 2 } })
  assert.equal(
    Object.hasOwn(table, 'stat_data'),
    true,
    'this is the guard MVU actually writes, and on a string it is false forever',
  )
})

test('the tables are parsed per row, not for the whole chat at once', () => {
  /*
   * The laziness is the reason the encoding was worth adopting: parsing all 677
   * rows of the longest corpus chat costs the 7.75 ms the text transport exists
   * to avoid, while one floor costs 0.01 ms. A card that iterates the chat
   * reading only `mes` must pay for none of them.
   *
   * Asserted by counting parses through a getter that cannot be reached without
   * one — reading `mes` on every row, then `variables` on exactly one.
   */
  const rows = Array.from({ length: 6 }, (_unused, at) => ({
    name: 'Her',
    is_user: false,
    mes: `floor ${String(at)}`,
    variables: JSON.stringify([{ n: at }]),
  }))
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({ characterId: 'char', chat: rows }),
  })
  evaluate(scope, () => undefined, 'first')

  const surface = scope.globals()['SillyTavern'] as { getContext: () => { chat: unknown[] } }
  const chat = surface.getContext().chat as { mes: string, variables: unknown[] }[]

  // Every row still holds text until something reads its tables, which is what
  // the own-property descriptor shows: a getter, not a value.
  for (const row of chat) void row.mes
  const untouched = Object.getOwnPropertyDescriptor(chat[3] as object, 'variables')
  assert.equal(typeof untouched?.get, 'function', 'the row was resolved without being read')

  // And reading one gives that one's tables.
  assert.deepEqual((chat[3] as { variables: unknown[] }).variables, [{ n: 3 }])
})

test('a floor whose tables cannot be parsed is reported, and reads as empty', () => {
  /*
   * A truncated table is a transport fault. Letting the parse throw out of a
   * synchronous read no card guards would turn one bad floor into a dead card,
   * so it reads as empty — and says so, because an empty table is exactly what
   * makes MagVarUpdate re-initialise over live state, and nobody should have to
   * guess whether the floor was empty or unreadable.
   */
  const scope = realm()
  scope.send({
    iris: 'tok',
    type: 'context',
    context: snapshot({
      characterId: 'char',
      chat: [{ name: 'Her', is_user: false, mes: 'reply', variables: '{"truncated": ' }],
    }),
  })
  evaluate(scope, () => undefined, 'first')

  const surface = scope.globals()['SillyTavern'] as { getContext: () => { chat: unknown[] } }
  const row = surface.getContext().chat[0] as { variables: unknown[] }
  assert.deepEqual(row.variables, [])

  const said = scope.posted
    .filter(message => message.type === 'error')
    .map(message => (message as unknown as { message: string }).message)
  assert.equal(said.filter(line => line.includes('could not be parsed')).length, 1, said.join(' | '))
})
test('a gap note about a name is retracted once something publishes it', () => {
  /*
   * **A gap report is a statement about a moment, and the panel shows it as a
   * standing one.** Cross-script coordination is written as a poll: 创世回廊's
   * two scripts read `parent.__辅助计算脚本_loaded__` until the other one sets
   * it, so the first read is *guaranteed* to find nothing and the note it
   * produces stays on screen after the flag arrives. Read later it says a
   * capability is missing when it is present — which cost a round of "is our
   * `window.parent` even the virtual one?" (it is; measured).
   *
   * Same shape as the storage probe whose sentence became false the moment the
   * façade landed. Both are reports whose truth depends on when they were made,
   * and both needed a way to stop being true.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const parent = scope.globals()['parent'] as Record<string, unknown>

  // The poll's first read, which finds nothing and says so.
  void parent['__helper_loaded__']
  const notes = () => scope.posted
    .filter(message => message.type === 'note')
    .map(message => (message as unknown as { message: string }).message)
  assert.equal(notes().filter(line => line.includes('__helper_loaded__')).length, 1)

  // Then the other script sets the flag, exactly as the card does.
  parent['__helper_loaded__'] = true
  const about = notes().filter(line => line.includes('__helper_loaded__'))
  assert.equal(about.length, 2, `the note was never retracted: ${about.join(' | ')}`)
  assert.match(about[1] ?? '', /has since been published/)

  // Both lines stay, which is the point: together they read as a resolved
  // sequence, while the first alone reads as a standing fault.
  assert.match(about[0] ?? '', /nothing has published/)
})

test('a publish nobody asked about first says nothing extra', () => {
  // Otherwise every publish would emit a retraction for a note that was never
  // made — an instrument that cannot be quiet is not an instrument.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const parent = scope.globals()['parent'] as Record<string, unknown>
  parent['__never_read__'] = true

  assert.equal(
    scope.posted
      .filter(message => message.type === 'note')
      .filter(message => (message as unknown as { message: string }).message.includes('__never_read__'))
      .length,
    0,
  )
})
test('parent.$ answers with this frame’s jQuery, so a card’s guard does not swallow it', () => {
  /*
   * **258 silent no-ops.** 銀麒赎世's system panel wraps every lookup in
   * `$p(sel){ var jq = _pw.$ || _pw.jQuery; if (!jq) return $(); ... }` and calls
   * it 258 times [3c]. With `$` absent from the parent proxy every one of those
   * took the guard, returned an empty jQuery set, and did nothing — no error,
   * no report, no render. The panel would have shown a card that loaded and
   * listened while drawing nothing, which is the failure this project is least
   * able to see.
   *
   * Upstream's `parent_jquery.js` is `window.$ = window.parent.$`, so a card's
   * `$` there is the host page's instance bound to the document that carries the
   * overlay. This frame's own jQuery is bound to this frame's document, which is
   * that surface — the equivalence holds where it matters.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const parent = scope.globals()['parent'] as Record<string, unknown>
  // The realm stub has no jQuery seeded, so absent must read as absent rather
  // than as a broken stand-in: the card's own guard is then correct.
  assert.equal(parent['$'], undefined)
  assert.equal('$' in parent, false, 'has must agree with get')

  // Seeded the way the preset seeds it, on the frame's own window.
  const marker = { jquery: '3.5.1' }
  ;(scope.realWindow as Record<string, unknown>)['$'] = marker
  ;(scope.realWindow as Record<string, unknown>)['jQuery'] = marker

  assert.equal(parent['$'], marker)
  assert.equal(parent['jQuery'], marker)
  assert.equal('$' in parent, true, 'has must agree with get')

  /*
   * Read **live**, not captured: the preset loads as a script and may not have
   * run when this proxy is built, so a captured value would be `undefined`
   * forever for every card whose preset arrived a tick late.
   */
  const replaced = { jquery: '3.5.1-later' }
  ;(scope.realWindow as Record<string, unknown>)['$'] = replaced
  assert.equal(parent['$'], replaced)

  /*
   * **`top` too, and it is the same object.** 魔法少女的扣扣审判1.0's interface
   * code uses `top.jQuery('#send_textarea').val(...)` then
   * `top.jQuery('#send_but').trigger('click')` as a fallback send path, 6 times
   * [44] — so a fix that reached only `parent` would leave that card silently
   * doing nothing. The shadow returns one object for both names, which is why
   * this holds; asserted because nothing else says so, and because 3c measured
   * `parent === top` as a zero-risk axis (no card depends on telling them
   * apart).
   */
  const top = scope.globals()['top'] as Record<string, unknown>
  assert.equal(top, parent, 'top and parent must be the same virtual object')
  assert.equal(top['$'], replaced)
  // `jQuery` was seeded once and not replaced, so it still reads the first
  // marker — which also shows the two names are read independently rather
  // than one aliasing the other.
  assert.equal(top['jQuery'], marker)
})

test('a card cannot replace parent.$ for its siblings', () => {
  // Read-only like `document`, and for the same reason: one card's scripts share
  // this frame, so an assignment here would replace every sibling's selector
  // engine. Upstream cannot be written to either — there it is SillyTavern's own
  // global, and a card overwriting it would break the host UI, not a neighbour's.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const parent = scope.globals()['parent'] as Record<string, unknown>
  assert.throws(() => { parent['$'] = () => undefined }, /not writable|parent\.\$/)
})

test('parent.alert, parent.confirm and parent.prompt are the frame\'s own bridges', () => {
  /*
   * **11 unguarded throws in one card.** 銀麒赎世's 银麒系统面板 holds
   * `var _pw = window.parent` and calls `_pw.alert(...)` at 10 sites and
   * `_pw.confirm(...)` at one — measured through the product's own readers over
   * both corpora, every site a bare call with no `typeof` guard in front of it.
   * With the three names absent from this proxy each read answered `undefined`
   * and the call threw `TypeError: _pw.alert is not a function`. The worst of
   * them is the first, L52 `_pw.alert("未找到API通道，请确保手机UI脚本已加载")`:
   * the line whose job is to *report* a missing API channel was the line that
   * killed the script, so the card's own diagnostic destroyed the diagnosis.
   *
   * The bare spelling has been bridged since `bridgedDialogs` landed. Nobody
   * asked whether a card reaches for the parent's copy first, and that unasked
   * question is the whole defect — not a ruling anyone recorded.
   *
   * Asserted **by identity**, not by behaviour: one implementation per name and
   * two spellings is the rule `eventSource` set, and two objects that merely
   * behave alike today are two objects that can come apart tomorrow.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })

  let confirmed: unknown
  let answered: unknown
  let checked = 0
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    for (const name of ['alert', 'confirm', 'prompt']) {
      assert.equal(typeof parent[name], 'function', `parent.${name} was not answered`)
      assert.equal(name in parent, true, `'${name}' in parent disagreed with the read`)
      assert.equal(parent[name], globals[name], `parent.${name} is not the bare binding`)
      checked += 1
    }
    // The compared count as a floor: a loop that skipped its own sample would
    // otherwise pass having compared nothing.
    assert.equal(checked, 3)

    // `top` too, and the same object — 魔法少女的扣扣审判 reaches the host window
    // through `top`, so a fix that reached only `parent` leaves it throwing.
    const top = globals['top'] as Record<string, unknown>
    assert.equal(top['alert'], parent['alert'])

    ;(parent['alert'] as (text: string) => undefined)('未找到API通道，请确保手机UI脚本已加载')
    confirmed = (parent['confirm'] as (text: string) => boolean)('确定导入存档？当前游戏数据将被覆盖。')
    answered = (parent['prompt'] as (text: string) => string | null)('📝 使用备注（可选）：')
  })

  assert.deepEqual(
    scope.posted.filter(message => message.type === 'dialog'),
    [
      { iris: 'tok', type: 'dialog', kind: 'alert', text: '未找到API通道，请确保手机UI脚本已加载' },
      { iris: 'tok', type: 'dialog', kind: 'confirm', text: '确定导入存档？当前游戏数据将被覆盖。' },
      { iris: 'tok', type: 'dialog', kind: 'prompt', text: '📝 使用备注（可选）：' },
    ],
    'the parent spelling must reach the shell on the same channel as the bare one',
  )
  // The two synchronous answers a no-modal sandbox gives, unchanged by the route
  // the card took to reach them: 銀麒赎世's `if (!_pw.confirm(...)) return;`
  // therefore returns, which is the safe reading of an unanswerable question.
  assert.equal(confirmed, false)
  assert.equal(answered, null)
})

test('a card may not replace the parent dialogs for its siblings', () => {
  // Read-only like `$` and `postMessage`: one card's scripts share this frame,
  // and native window methods cannot be assigned upstream either.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, globals => {
    const parent = globals['parent'] as Record<string, unknown>
    let refused = 0
    for (const name of ['alert', 'confirm', 'prompt']) {
      assert.throws(() => { parent[name] = () => undefined }, UnsupportedApiError)
      assert.throws(() => { delete parent[name] }, UnsupportedApiError)
      refused += 1
    }
    assert.equal(refused, 3)
  })
})

test('parent.toastr is the frame\'s own notifier, read live', () => {
  /*
   * 4 owners, 144 lines, and **all of them guarded** — `if (_pw.toastr)
   * _pw.toastr.success("API设置已保存")` in 銀麒赎世, `window.parent.toastr ? …
   * : window.toastr` in another. So the absence cost silence rather than a
   * throw: 銀麒赎世 skipped every one of its hundred-odd notifications with
   * nothing said, which is the degradation this sandbox keeps choosing against.
   *
   * Live off the frame's window, exactly as `$` is, and for a second reason
   * besides load order: `provideToastr` deliberately does **not** overwrite a
   * toastr a card brought itself, so a captured value could hand out the
   * adapter after the card had installed the real library.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const parent = scope.globals()['parent'] as Record<string, unknown>
  // Absent reads as absent, so the card's own guard is right rather than sent
  // into a branch that throws one line later.
  assert.equal(parent['toastr'], undefined)
  assert.equal('toastr' in parent, false, 'has must agree with get')

  const adapter = { success: () => undefined, error: () => undefined }
  ;(scope.realWindow as Record<string, unknown>)['toastr'] = adapter
  assert.equal(parent['toastr'], adapter)
  assert.equal('toastr' in parent, true, 'has must agree with get')

  // Live, not captured: a card replacing the seeded adapter with its own real
  // library must be the thing its own `parent.toastr` then reaches.
  const own = { success: () => undefined }
  ;(scope.realWindow as Record<string, unknown>)['toastr'] = own
  assert.equal(parent['toastr'], own)

  // And not writable through the proxy: an assignment here would replace every
  // sibling script's notifier.
  assert.throws(() => { parent['toastr'] = {} }, UnsupportedApiError)
})
test('a card drives the composer through document.getElementById, in both spellings', async () => {
  /*
   * **The path nine cards take**, eight of them from interface code [44]:
   * write `#send_textarea.value`, then click `#send_but`. Asserted through the
   * *virtual document*, because that is the object a card actually holds — a
   * test against `createStAnchors` alone would pass with the lookup unwired,
   * which is the shape the `replaceScriptButtons` gap had.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const parent = scope.globals()['parent'] as { document: Record<string, unknown> }
  const doc = parent.document
  const byId = doc['getElementById'] as (id: string) => Record<string, unknown> | null
  const bySelector = doc['querySelector'] as (sel: string) => Record<string, unknown> | null

  const field = byId('send_textarea')
  assert.notEqual(field, null, 'the composer was not reachable by id')
  // Both spellings reach the same object: a card writing `querySelector('#x')`
  // and one writing `getElementById('x')` are asking the same question, and
  // upstream answers both.
  assert.equal(bySelector('#send_textarea'), field)

  field!['value'] = 'written by a card'
  assert.equal(field!['value'], 'written by a card', 'the card must read back its own write')

  await Promise.resolve()
  const draft = scope.posted.find(
    message => message.type === 'call'
      && (message as unknown as { method: string }).method === 'composerDraft',
  ) as unknown as { params: Record<string, unknown> } | undefined
  assert.notEqual(draft, undefined, `the write never reached the shell: ${JSON.stringify(scope.posted)}`)
  assert.equal(draft?.params['text'], 'written by a card')

  const button = byId('send_but')
  assert.notEqual(button, null)
  ;(button!['click'] as () => void)()

  await Promise.resolve()
  assert.ok(
    scope.posted.some(
      message => message.type === 'call'
        && (message as unknown as { method: string }).method === 'composerSend',
    ),
    'the click never asked the shell to send',
  )
  // And it is visible: an outward action carried by a note rather than by a
  // confirmation, because upstream gives cards this and a prompt would be a
  // behaviour change.
  const notes = scope.posted
    .filter(message => message.type === 'note')
    .map(message => (message as unknown as { message: string }).message)
  assert.equal(notes.filter(line => line.includes('sent a message through the composer')).length, 1)
})

test('the generation flag rides the events, and three spellings agree', () => {
  /*
   * `#send_but.disabled`, `#mes_stop`'s visibility and `parent.is_send_press`
   * are three spellings of one fact, so they answer from one variable. A card
   * may read any of them — 3c found the third and the corpus uses the second —
   * and two that disagreed would leave a panel re-injecting itself throughout a
   * generation.
   *
   * Driven by the **events the shell forwards**, not by a snapshot field: the
   * event stream already carries this, and a second copy on the context is how
   * two sources of one fact come to disagree.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const parent = scope.globals()['parent'] as Record<string, unknown>
  const doc = parent['document'] as Record<string, unknown>
  const byId = doc['getElementById'] as (id: string) => Record<string, unknown> | null
  const button = byId('send_but')!
  const stop = byId('mes_stop')!

  assert.equal(parent['is_send_press'], false)
  assert.equal(button['disabled'], false)
  assert.equal((stop['getClientRects'] as () => unknown[])().length, 0)

  scope.send({ iris: 'tok', type: 'event', event: 'js_generation_started', args: [] })
  assert.equal(parent['is_send_press'], true)
  assert.equal(button['disabled'], true)
  assert.equal((stop['getClientRects'] as () => unknown[])().length, 1)

  // An **abort** clears it too. Watching only the completed names would leave
  // the flag stuck on after a stop, and stuck-on freezes a card's panel for the
  // rest of the chat.
  scope.send({ iris: 'tok', type: 'event', event: 'generation_stopped', args: [] })
  assert.equal(parent['is_send_press'], false)
  assert.equal(button['disabled'], false)
})

test('a SillyTavern id Iris does not provide is named, not silently null', () => {
  /*
   * 不要被神隐's script dies on `Cannot read properties of null (reading
   * 'querySelector')` — a bare `null` one line earlier. Naming which kind of
   * nothing it found is the difference between a reader looking at our gap and
   * a reader looking at the card.
   *
   * Only for ids Iris **knows** are SillyTavern's: a card looking up its own
   * `#my-panel` before creating it is ordinary, and reporting that would bury
   * the case that matters.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const doc = (scope.globals()['parent'] as Record<string, unknown>)['document'] as Record<string, unknown>
  const byId = doc['getElementById'] as (id: string) => unknown

  assert.equal(byId('send_form'), null)
  assert.equal(byId('send_form'), null, 'reported once, not once per lookup')
  assert.equal(byId('a-panel-this-card-has-not-built-yet'), null)

  const notes = scope.posted
    .filter(message => message.type === 'note')
    .map(message => (message as unknown as { message: string }).message)
  assert.equal(notes.filter(line => line.includes('send_form')).length, 1)
  assert.equal(
    notes.filter(line => line.includes('a-panel-this-card-has-not-built-yet')).length,
    0,
    'a card looking up its own not-yet-built node is ordinary and must stay quiet',
  )
})
test('the card\u2019s own frame is a real node in its container', () => {
  /*
   * **How upstream's cards find each other.** 銀麒赎世's system panel does
   * `parent.document.querySelectorAll('iframe')` and checks each one's
   * `contentWindow.phoneAPI`, where the phone UI published its interface. It
   * **never reads `window.phoneAPI` directly** [44], so frame discovery is its
   * only path and its guard is `if (fw && fw.phoneAPI)` — either half missing
   * is silent.
   *
   * A **real** node rather than one synthesised into `parent.document`'s
   * answers, because of a path no synthesis could reach: a card's bare
   * `$('iframe')` searches the *frame's own* document. Upstream's `$` is the
   * page's, so upstream's bare query finds the card's frame; a stand-in visible
   * only through `parent.document` would have left that difference in place.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const frames = scope.appended().filter(
    node => (node as { tagName?: string }).tagName === 'IFRAME',
  )
  assert.equal(frames.length, 1, `expected exactly one: ${JSON.stringify(scope.appended())}`)

  // Hidden: it exists to be *found*, never to render — and zero-sized so the
  // overlay-region walk drops it rather than clipping to it.
  assert.equal((frames[0] as { style: Record<string, string> }).style['display'], 'none')
})

test('its contentWindow is this frame\u2019s real window, so a published API is found', () => {
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  // Published the way a card publishes: onto the frame's own window, which is
  // where a module body's `window.x = …` lands.
  scope.realWindow['phoneAPI'] = { open: () => 'opened' }

  const doc = (scope.globals()['parent'] as Record<string, unknown>)['document'] as
    Record<string, unknown>
  const found = (doc['querySelectorAll'] as (s: string) => unknown[])('iframe')
  assert.equal(found.length, 1, 'the frame was not reachable through parent.document')

  // The card's own guard, written the way the card writes it.
  const fw = (found[0] as { contentWindow: Record<string, unknown> }).contentWindow
  assert.equal(typeof (fw['phoneAPI'] as { open: () => string } | undefined)?.open, 'function')
})

test('a property published after the lookup is still visible through it', () => {
  /*
   * The panel may enumerate frames before the phone UI has run, so what it
   * holds has to stay useful afterwards.
   *
   * **This does not distinguish a getter from a stored reference**, and saying
   * so is the point: a mutation swapping the implementation's getter for
   * `value:` left every assertion green, because `realWindow` is one stable
   * object and a late publish mutates it rather than replacing it. The property
   * below is real and worth pinning; the mechanism behind it is not what this
   * test can speak about, and the implementation was simplified to match.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const node = scope.appended().find(
    n => (n as { tagName?: string }).tagName === 'IFRAME',
  ) as { contentWindow: Record<string, unknown> }
  assert.equal(node.contentWindow['late'], undefined)
  scope.realWindow['late'] = 'here now'
  assert.equal(node.contentWindow['late'], 'here now', 'the window was captured')
})

test('its contentDocument is the virtual document, not null', () => {
  /*
   * `null` is the answer for a frame we cannot reach into — measured: a nested
   * srcdoc frame's `contentDocument` is null from inside an opaque origin, three
   * ways. This is the one frame we are *inside* of, so it answers with the same
   * object the card holds as `parent.document`.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  const parentDoc = (scope.globals()['parent'] as Record<string, unknown>)['document']
  const node = scope.appended().find(
    n => (n as { tagName?: string }).tagName === 'IFRAME',
  ) as { contentDocument: unknown }
  assert.equal(node.contentDocument, parentDoc)
})

test('an interface frame holds an Mvu surface, so the measured wait resolves', async () => {
  /*
   * The failure this closes, measured on 哈人冰恋世界: its status bar opens with
   * `await waitGlobalInitialized('Mvu')` and draws its three panels only after.
   * Upstream that wait ends because the MVU bundle publishes onto the shared
   * host page and the interface iframe reads it through `predefine.js`'s live
   * getter (`window.Mvu`, "只是为了兼容性") and hears `global_Mvu_initialized`
   * on the page's event source. Across an opaque origin neither road exists —
   * the bundle publishes into the *script* frame's bag — so the wait never
   * resolved and the frame rendered its frame and never a single number.
   *
   * Iris cannot hand over the bundle's live object, but the bundle itself is a
   * thin delegation: measured in the published artifact,
   * `getMvuData` is `function(e){return getVariables(e)}` and `replaceMvuData`
   * is `function(e,t){return replaceVariables(e,t)}` — the members this frame
   * already has, with this frame's own floor semantics — and `events` is a
   * constant table. So the surface is provided from those, and the wait
   * resolves against it.
   */
  const scope = realm({ interfaceFrame: true })

  const mvu = scope.publishedValue('Mvu') as Record<string, unknown>
  assert.notEqual(mvu, undefined, 'no Mvu was published to the markup')
  assert.equal(
    (mvu['events'] as Record<string, string>)['VARIABLE_UPDATE_ENDED'],
    'mag_variable_update_ended',
    'the event constants drifted from the names the cards subscribe to',
  )
  assert.equal(typeof mvu['getMvuData'], 'function')
  assert.equal(typeof mvu['replaceMvuData'], 'function')

  // The measured shape of every status bar: wait first, then read.
  const wait = scope.publishedValue('waitGlobalInitialized') as (name: string) => Promise<void>
  await wait('Mvu')
  assert.ok(true, 'the wait resolved — pre-fix this promise never settles')

  // "并使之在当前 iframe 中可用": the wait also makes the name readable, and it
  // reads the same surface the markup sees.
  assert.equal(scope.forwarded('Mvu'), mvu)
})

test('a script frame is left alone: no stand-in where the real bundle runs', () => {
  /*
   * The stand-in exists for frames that can never see the bundle. A *script*
   * frame is where the bundle itself runs and publishes the real `Mvu` via
   * `_.set(window.parent, 'Mvu', …)`; pre-seeding the name there would hand the
   * bundle's siblings a facade where they expect the live provider, and the
   * cohabitation tests above pin that path. So the surface is
   * interface-frames-only.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })
  evaluate(scope, () => undefined, 'first')

  assert.equal(
    scope.publishedNames().includes('Mvu'),
    false,
    'a script frame was given a stand-in for a global its own bundle provides',
  )
})

/*
 * ── Upstream's `predefine.js` check, and the half of it that must not happen ──
 *
 * Upstream gives every script its own iframe and `predefine.js:36-44` asks once,
 * at that iframe's boot, whether the shared parent already holds `Mvu`; a hit
 * installs a live accessor on the frame's own window, a miss installs nothing
 * and is never revisited. Iris runs all of a card's scripts in one frame, so the
 * moment that carries the same meaning is "just before each script's body".
 *
 * The pair below is the whole ruling: a script that starts after a publisher
 * sees the name bare, and a script that starts before one never does — no
 * backfill, because backfilling would hand cards something upstream does not.
 */

test('a script that starts after a publisher reads the bare name', () => {
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })

  // Script one is the provider: this is the write MVU's bundle performs.
  const mvu = { getMvuData: () => 'live' }
  evaluate(scope, globals => {
    (globals['parent'] as Record<string, unknown>)['Mvu'] = mvu
  }, 'publisher')

  assert.equal(scope.predefinedExists('Mvu'), false, 'installed for the publisher, which boots before its own write')

  // Script two starts afterwards, and is the one upstream's check serves.
  evaluate(scope, () => undefined, 'consumer')

  assert.equal(scope.predefinedExists('Mvu'), true, 'the later script got no bare name')
  assert.equal(
    scope.predefined('Mvu'),
    mvu,
    'the accessor does not read through to what the publisher actually published',
  )
  /*
   * Through the predefine door, not the wait door. They differ in their setter,
   * and asserting only "some accessor exists" would pass on either.
   */
  assert.equal(scope.forwarded('Mvu'), undefined, 'installed through the wait door instead')
})

test('a script that starts before the publisher never gets the name, not even later', () => {
  /*
   * The no-backfill half, and the reason it is a test rather than a comment:
   * making the name appear once it is published is a one-line change that looks
   * like a fix, reads like a courtesy, and quietly gives cards a guarantee
   * upstream withholds — a frame that booted early stays without it there too.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot({ characterId: 'char' }) })

  evaluate(scope, () => undefined, 'early')
  assert.equal(scope.predefinedExists('Mvu'), false, 'nothing had published, yet a name was installed')

  // The publisher runs afterwards. The early script's window must not change.
  evaluate(scope, globals => {
    (globals['parent'] as Record<string, unknown>)['Mvu'] = { getMvuData: () => 'live' }
  }, 'publisher')

  assert.equal(
    scope.predefinedExists('Mvu'),
    false,
    'the name was backfilled after the fact, which is more than upstream gives',
  )
})

/*
 * The popup API on the card surface.
 *
 * The measured crash: MagVarUpdate's bundle opens its one-time variable cleanup
 * with `SillyTavern.callGenericPopup(text, SillyTavern.POPUP_TYPE.CONFIRM, …)`
 * on every chat past 25 messages, and this surface carried none of the five
 * names — so `SillyTavern.POPUP_TYPE` read `undefined` and `.CONFIRM` threw
 * inside a `jQuery(async …)` as an unhandled rejection. Reported by a user on a
 * real 26-message chat, 2026-09-08.
 */

test('the five popup names are on the surface, through both entry points', () => {
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  /*
   * **Read inside the body, asserted outside it**, and this shape was bought
   * with a teeth check. Written the obvious way — `assert` inside the
   * `evaluate` body — deleting `POPUP_TYPE` from the surface did **not** turn
   * this test red: the read `types['CONFIRM']` throws a `TypeError` before any
   * assertion runs, and a TypeError raised in a card body is caught by the
   * frame's own try/catch and posted as a card error, which is correct in
   * production and fatal to a test. `evaluate` re-throws `AssertionError` only.
   *
   * So the body collects, with optional chaining so nothing throws, and every
   * judgement is made out here where a failure has nowhere to be swallowed.
   */
  const seen: Record<string, unknown> = {}
  evaluate(scope, globals => {
    const bare = globals['SillyTavern'] as Record<string, unknown>
    const viaContext = (bare['getContext'] as () => Record<string, unknown>)()

    for (const name of ['callGenericPopup', 'callPopup', 'Popup']) {
      seen[`bare:${name}`] = typeof bare[name]
      seen[`ctx:${name}`] = typeof viaContext[name]
    }
    for (const name of ['callGenericPopup', 'callPopup', 'Popup', 'POPUP_TYPE', 'POPUP_RESULT']) {
      seen[`in:${name}`] = name in bare
    }
    /*
     * **The enums, read the way the crash read them.** The failing expression
     * was `SillyTavern.POPUP_TYPE.CONFIRM` — a member read off a member — so
     * recording only that `POPUP_TYPE` is an object would not describe it.
     */
    const types = bare['POPUP_TYPE'] as Record<string, unknown> | undefined
    const results = bare['POPUP_RESULT'] as Record<string, unknown> | undefined
    seen['CONFIRM'] = types?.['CONFIRM']
    seen['AFFIRMATIVE'] = results?.['AFFIRMATIVE']
    seen['NEGATIVE'] = results?.['NEGATIVE']
    seen['CANCELLED'] = results?.['CANCELLED']
    seen['CUSTOM1'] = results?.['CUSTOM1']
  })

  for (const name of ['callGenericPopup', 'callPopup', 'Popup']) {
    assert.equal(seen[`bare:${name}`], 'function', `${name} missing from the facade`)
    assert.equal(seen[`ctx:${name}`], 'function', `${name} missing from getContext()`)
  }
  // `get` and `in` have to agree: a card feature-testing with `in` would
  // otherwise be told no about a member it can call.
  for (const name of ['callGenericPopup', 'callPopup', 'Popup', 'POPUP_TYPE', 'POPUP_RESULT']) {
    assert.equal(seen[`in:${name}`], true, `${name} answers a read but not an \`in\` probe`)
  }
  assert.equal(seen['CONFIRM'], 2, 'the member the reported crash read')
  assert.equal(seen['AFFIRMATIVE'], 1)
  assert.equal(seen['NEGATIVE'], 0)
  assert.equal(seen['CANCELLED'], null, 'a dismissal is null, which MVU compares against')
  assert.equal(seen['CUSTOM1'], 1001)
})

test('callGenericPopup posts a plan and resolves with the reader’s answer', async () => {
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  let answered: unknown = 'not settled'
  evaluate(scope, globals => {
    const st = globals['SillyTavern'] as Record<string, unknown>
    const call = st['callGenericPopup'] as (
      content: unknown, type: unknown, input: unknown, options: unknown,
    ) => Promise<unknown>
    void call('清理旧变量？', 2, '', {
      okButton: '仅清理',
      cancelButton: '不再提醒',
      customButtons: ['备份并清理'],
    }).then(value => {
      answered = value
    })
  })

  const asked = scope.posted.find(message => message.type === 'popup')
  assert.ok(asked?.type === 'popup', 'the frame never asked the shell')
  assert.equal(asked.plan.kind, 2)
  assert.deepEqual(
    asked.plan.buttons.map(button => button.text),
    ['备份并清理', '仅清理', '不再提醒'],
  )

  // The reader pressed the leading custom button, which is MVU's "back up and
  // clean" and carries result 2 — the value its branch tests for.
  scope.send({ iris: 'tok', type: 'popup:answer', id: asked.id, closed: true, result: 2 })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(answered, 2, 'a CONFIRM resolves with the result itself')
})

test('an INPUT popup resolves with the text, and a dismissal with null', async () => {
  // Upstream's value rule ([ST] popup.js:755-758) is the frame's, not the
  // shell's: the shell reports a result and the text, and this side decides
  // which of them the promise carries.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  const settled: unknown[] = []
  evaluate(scope, globals => {
    const st = globals['SillyTavern'] as Record<string, unknown>
    const call = st['callGenericPopup'] as (
      content: unknown, type: unknown, input: unknown, options: unknown,
    ) => Promise<unknown>
    void call('Name it', 3, 'draft', {}).then(value => settled.push(value))
    void call('Name it', 3, 'draft', {}).then(value => settled.push(value))
  })

  const asked = scope.posted.filter(message => message.type === 'popup')
  assert.equal(asked.length, 2, 'two popups, two ids')
  const first = asked[0]
  const second = asked[1]
  assert.ok(first?.type === 'popup' && second?.type === 'popup')
  assert.notEqual(first.id, second.id, 'two popups sharing an id would answer each other')

  scope.send({ iris: 'tok', type: 'popup:answer', id: first.id, closed: true, result: 1, input: 'typed' })
  scope.send({ iris: 'tok', type: 'popup:answer', id: second.id, closed: true, result: null, input: 'typed' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(settled, ['typed', null])
})

test('a non-closing custom button runs its action and leaves the popup open', async () => {
  /*
   * [ST] popup.js:69 — a custom button with no `result` does not close the
   * popup — and :317-319, where its `action` is a plain click listener. The
   * action cannot cross a `postMessage`, so it stays frame-side and the plan
   * carries the button's declaration index to find it again.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  const acted: string[] = []
  let settled = false
  evaluate(scope, globals => {
    const st = globals['SillyTavern'] as Record<string, unknown>
    const call = st['callGenericPopup'] as (
      content: unknown, type: unknown, input: unknown, options: unknown,
    ) => Promise<unknown>
    void call('pick one', 2, '', {
      customButtons: [
        { text: 'Copy', action: () => acted.push('copy') },
        { text: 'Use', result: 5 },
      ],
    }).then(() => {
      settled = true
    })
  })

  const asked = scope.posted.find(message => message.type === 'popup')
  assert.ok(asked?.type === 'popup')
  assert.equal(asked.plan.buttons[0]?.result, undefined, 'the copy button must not close it')

  scope.send({ iris: 'tok', type: 'popup:answer', id: asked.id, closed: false, result: 0, button: 0 })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(acted, ['copy'], 'the card’s own action never ran')
  assert.equal(settled, false, 'a button with no result must not resolve the promise')

  scope.send({ iris: 'tok', type: 'popup:answer', id: asked.id, closed: true, result: 5, button: 1 })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(settled, true)
})

test('callPopup keeps its own deprecated contract rather than borrowing the new one', async () => {
  /*
   * [ST] `public/script.js:9007` and `:11312-11341`: a **string** type, and it
   * resolves `true`/`false` — the input's text for `'input'`. Aliasing it onto
   * `callGenericPopup` would hand a card `1` where it tests `=== true`, which
   * passes a truthiness check and fails an equality one.
   */
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  const settled: unknown[] = []
  evaluate(scope, globals => {
    const st = globals['SillyTavern'] as Record<string, unknown>
    const call = st['callPopup'] as (
      text: unknown, type: unknown, input?: unknown, options?: unknown,
    ) => Promise<unknown>
    void call('sure?', 'confirm').then(value => settled.push(value))
    void call('sure?', 'confirm').then(value => settled.push(value))
    void call('name it', 'input', 'draft').then(value => settled.push(value))
  })

  const asked = scope.posted.flatMap(message => (message.type === 'popup' ? [message] : []))
  assert.equal(asked.length, 3)
  scope.send({ iris: 'tok', type: 'popup:answer', id: asked[0]?.id ?? '', closed: true, result: 1 })
  scope.send({ iris: 'tok', type: 'popup:answer', id: asked[1]?.id ?? '', closed: true, result: null })
  scope.send({ iris: 'tok', type: 'popup:answer', id: asked[2]?.id ?? '', closed: true, result: 1, input: 'typed' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(settled, [true, false, 'typed'], 'booleans, not POPUP_RESULT numbers')
})

test('Popup.show.confirm and .input build upstream’s content and return types', async () => {
  // [ST] popup.js:99-145 with `PopupUtils.BuildTextWithHeader` (:888-898): the
  // header becomes an `<h3>` above the text, and `input` turns every falsy
  // value except the empty string into `null`.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  const settled: unknown[] = []
  evaluate(scope, globals => {
    const st = globals['SillyTavern'] as Record<string, unknown>
    const popup = st['Popup'] as {
      show: {
        confirm: (header: unknown, text?: unknown) => Promise<unknown>
        input: (header: unknown, text?: unknown, value?: unknown) => Promise<unknown>
      }
    }
    void popup.show.confirm('Delete it?', 'This cannot be undone.').then(value => settled.push(value))
    void popup.show.input('Name it', undefined, 'draft').then(value => settled.push(value))
  })

  const asked = scope.posted.flatMap(message => (message.type === 'popup' ? [message] : []))
  assert.equal(asked.length, 2)
  assert.match(asked[0]?.plan.content ?? '', /^<h3>Delete it\?<\/h3>/)
  assert.match(asked[0]?.plan.content ?? '', /This cannot be undone\./)
  assert.equal(asked[0]?.plan.kind, 2)
  assert.equal(asked[1]?.plan.kind, 3)
  assert.equal(asked[1]?.plan.inputValue, 'draft')

  scope.send({ iris: 'tok', type: 'popup:answer', id: asked[0]?.id ?? '', closed: true, result: 0 })
  scope.send({ iris: 'tok', type: 'popup:answer', id: asked[1]?.id ?? '', closed: true, result: 0, input: 'x' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(settled, [0, null], 'confirm yields the result; input turns false into null')
})

test('a card closing its own popup tells the shell, so no modal is orphaned', async () => {
  // `popup.complete()` resolves the card's promise frame-side. Without the
  // withdrawal message the shell would hold a modal nobody is waiting for,
  // which for the reader means a dialog whose every answer goes nowhere.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  let settled: unknown = 'not settled'
  evaluate(scope, globals => {
    const st = globals['SillyTavern'] as Record<string, unknown>
    const Popup = st['Popup'] as new (
      content: unknown, type: unknown, input?: unknown, options?: unknown,
    ) => { show: () => Promise<unknown>, completeNegative: () => Promise<unknown> }
    const popup = new Popup('waiting', 2, '', {})
    void popup.show().then(value => {
      settled = value
    })
    void popup.completeNegative()
  })

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(settled, 0, 'complete() resolves the card’s own promise')
  const done = scope.posted.find(message => message.type === 'popup:done')
  assert.ok(done?.type === 'popup:done', 'the shell was never told to take it down')
})

test('an option this surface ignores is reported by name, once', () => {
  // A dialog that behaves differently from upstream's with nothing on the
  // record is the failure this whole surface keeps choosing against. `onClosing`
  // is a close **veto** that cannot be honoured across the boundary.
  const scope = realm()
  scope.send({ iris: 'tok', type: 'context', context: snapshot() })

  evaluate(scope, globals => {
    const st = globals['SillyTavern'] as Record<string, unknown>
    const call = st['callGenericPopup'] as (
      content: unknown, type: unknown, input: unknown, options: unknown,
    ) => Promise<unknown>
    void call('x', 2, '', { onClosing: () => false })
  })

  const notes = scope.posted.flatMap(message =>
    message.type === 'note' && message.message.includes('does not honour') ? [message.message] : [])
  assert.equal(notes.length, 1, 'the dropped option was not reported exactly once')
  assert.match(notes[0] ?? '', /onClosing/)
})
