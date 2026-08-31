/**
 * The code that runs inside a card's frame.
 *
 * Its whole job is to build the globals a card reaches for and then evaluate the
 * card's body against them. Every dependency arrives through `FrameEnv` rather
 * than being read off the real `window`, for one reason: this is the piece that
 * decides what a card can touch, and a piece that can only be exercised by
 * opening a browser is a piece whose decisions are never checked. With the
 * injection it runs under `node --test` against stubs.
 *
 * Shadowing is the compatibility layer, not the boundary — see `policy.ts`. A
 * card that evades these parameters reaches the real, cross-origin `parent` and
 * is stopped by the browser.
 *
 * @module iris-web/sandbox/frame
 */

import { UnsupportedApiError } from './errors.ts'
import { UNBRIDGED_GLOBALS } from './policy.ts'
import type { FromFrame, ToFrame } from './protocol.ts'
import { createVirtualDocument, type NodeFactory, type ScopedRoot } from './virtual-document.ts'
import { EXPECTED_GLOBALS } from './preset-globals.ts'
import { isCardMethod } from './card-api.ts'
import { createFrameTavernHelper } from './tavern-helper.ts'
import { EventBus } from '@iris/compat-tavernhelper-core'
import type { ScriptContext } from '@iris/protocol'

/** What the frame-side code needs from its realm. */
export interface FrameEnv {
  /** The run token every message carries. */
  token: string
  /** The frame's own body — which is the card's container, and what `parent.document.body` yields. */
  container: ScopedRoot
  /** The frame's own document, for node construction. */
  factory: NodeFactory
  /** The real window of this frame, proxied through for everything not overridden. */
  realWindow: object
  /** Send a message to the shell. */
  post: (message: FromFrame) => void
  /** Receive messages from the shell; already token-checked by the caller. */
  onMessage: (listener: (message: ToFrame) => void) => void
  /**
   * Evaluate a card body with the given globals shadowed.
   *
   * Injected rather than calling `new Function` here so a test can observe the
   * exact names and values a card would see, which is the thing worth asserting.
   */
  evaluate: (
    source: string,
    mode: 'classic' | 'module',
    names: readonly string[],
    values: readonly unknown[],
  ) => void | Promise<void>
  /**
   * Put the bridged globals on the frame's own window.
   *
   * Module code cannot be handed shadowed parameters, so in module mode this is
   * the only bridge there is — which is also how upstream does it: a classic
   * script runs before the module and flattens its API onto the child window.
   *
   * Called in both modes. Publishing is harmless for classic code, which finds
   * the same objects through its parameters, and having one path fewer is worth
   * more than saving two property definitions.
   */
  publishGlobals?: (entries: readonly [string, unknown][]) => void
  /**
   * Say which of a list of globals are not present in this frame.
   *
   * Enumerating beats discovering. Upstream seeds six library globals from its
   * host page; a cross-origin frame cannot borrow any of them, so each one Iris
   * does not provide is a card crash waiting to happen — and the crash says
   * `X is not defined`, which names the symptom and not the list it came from.
   */
  reportMissingGlobals?: (expected: readonly string[]) => void
  /**
   * Publish the viewport into the frame's own realm.
   *
   * Card CSS reads `--TH-viewport-height`, which upstream sets on the child's
   * `<html>` from `window.parent.innerHeight` — a same-origin read Iris cannot
   * make. Carrying the number in the message and setting the variable here is
   * the equivalent, and cleaner: the value is pushed rather than reached for.
   *
   * Optional so a test can install without a DOM.
   */
  applyViewport?: (size: { width: number, height: number }) => void
}

/** A running frame's handle. */
export interface FrameSandbox {
  /** Names shadowed for card code, in order. */
  readonly shadowed: readonly string[]
  /** Last viewport the shell reported. */
  viewport: () => { width: number, height: number }
}

/** Bind a function so calling it off the proxy does not trip an illegal invocation. */
function passthrough(realWindow: object, property: string): unknown {
  const value = (realWindow as Record<string, unknown>)[property]
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(realWindow) : value
}

/**
 * Install the sandbox and start listening for the card body.
 *
 * @param env - the frame's realm, injected.
 * @returns the handle, mostly for tests and diagnostics.
 */
export function installSandbox(env: FrameEnv): FrameSandbox {
  // Until the shell reports, fall back to the frame's own size. A card measuring
  // the viewport before the first message gets a real number rather than zero.
  let viewport = { width: 0, height: 0 }
  const readViewport = (): { width: number, height: number } => viewport

  const virtualDocument = createVirtualDocument({
    container: env.container,
    viewport: readViewport,
    factory: env.factory,
  })

  const unbridged = new Map(UNBRIDGED_GLOBALS.map(row => [row.name, row]))

  /** The host snapshot, absent until the shell pushes it. */
  let context: ScriptContext | undefined

  /**
   * `extension_settings`, watched for top-level assignment.
   *
   * The corpus contains `if (!SillyTavern.extensionSettings.x) { … }` followed by
   * `SillyTavern.extensionSettings.x = computed`. Without reporting that write
   * the card recomputes the same value every run and stores it into a snapshot
   * that is thrown away — silently, which is the expensive kind of wrong.
   *
   * Shallow: a top-level assignment is the shape that was measured. A mutation
   * deeper inside an existing object is NOT caught here, and that is a known
   * limit rather than an oversight — see the README.
   */
  const settingsProxy = (own: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(own, {
      set(target, property, value): boolean {
        const applied = Reflect.set(target, property, value)
        if (applied) env.post({ iris: env.token, type: 'settings', settings: { ...target } })
        return applied
      },
      deleteProperty(target, property): boolean {
        const applied = Reflect.deleteProperty(target, property)
        if (applied) env.post({ iris: env.token, type: 'settings', settings: { ...target } })
        return applied
      },
    })

  let extensionSettings: Record<string, unknown> | undefined

  /**
   * `SillyTavern`, as a card sees it.
   *
   * Both shapes the corpus uses: `getContext()` and direct member reads off the
   * global. Truthy the moment a snapshot exists, because 12 of its 15 measured
   * sites are `if (window.parent.SillyTavern)` probes deciding which window to
   * talk to — a falsy answer sends the card down its own-window branch, where it
   * does nothing and says nothing.
   */
  const sillyTavern = new Proxy(Object.create(null) as object, {
    get(_target, property): unknown {
      if (typeof property === 'symbol') return undefined
      if (context === undefined) {
        throw new UnsupportedApiError(
          `SillyTavern.${property}`,
          'The host context has not reached this frame yet.',
        )
      }
      if (property === 'getContext') return () => sillyTavern
      if (property === 'extensionSettings') return extensionSettings

      /*
       * Actions, reachable here AND through `getContext()` — because `getContext`
       * returns this same object. One surface, two entry points, which is what
       * upstream has: `SillyTavern.saveMetadata` and `context.saveChat` are both
       * measured in real cards, and MVU calls `SillyTavern.saveChat` directly.
       *
       * The earlier facade offered the data members both ways and the actions
       * neither, which is the gap a real card found.
       */
      if (isCardMethod(property)) {
        if (property === 'saveMetadata') {
          // No argument upstream: a card mutates `chatMetadata` in place and then
          // asks for it to be saved. So the current snapshot is what travels,
          // rather than whatever the card happened to pass.
          return () => callAction('saveMetadata', { metadata: context?.chatMetadata ?? {} })
        }
        if (property === 'saveChat') return () => callAction('saveChat', {})
        return (...args: unknown[]) => {
          // `generateRaw`'s upstream signature varies by caller, and guessing
          // wrong here would send a malformed request that fails as a host error
          // rather than as a shape problem. A string is the contract's shape; an
          // object with a prompt-ish field is the other common one; anything else
          // is refused by name so the next real card tells us what it actually
          // passes instead of us inferring it.
          const first = args[0]
          if (typeof first === 'string') return callAction('generateRaw', { prompt: first })
          if (typeof first === 'object' && first !== null) {
            const bag = first as Record<string, unknown>
            const prompt = bag['prompt'] ?? bag['user_input']
            if (typeof prompt === 'string') return callAction('generateRaw', { prompt })
          }
          throw new UnsupportedApiError(
            `SillyTavern.${property}`,
            `Iris does not recognise this call's arguments (${typeof first}); the shape a card passes has not been measured yet.`,
          )
        }
      }
      const fields = context as unknown as Record<string, unknown>
      if (Object.hasOwn(fields, property)) return fields[property]
      throw new UnsupportedApiError(
        `SillyTavern.${property}`,
        'Iris bridges the members cards were measured to use; this is not one of them.',
      )
    },
    set(_target, property): boolean {
      throw new UnsupportedApiError(
        `SillyTavern.${String(property)}`,
        'Assign into extensionSettings, or call the save methods.',
      )
    },
    has(_target, property): boolean {
      if (context === undefined) return false
      const fields = context as unknown as Record<string, unknown>
      return (
        property === 'getContext' ||
        property === 'extensionSettings' ||
        (typeof property === 'string' && isCardMethod(property)) ||
        Object.hasOwn(fields, property)
      )
    },
  })

  /** `parent` and `top`, as a card sees them. */
  const virtualParent = new Proxy(Object.create(null) as object, {
    get(_target, property): unknown {
      if (typeof property === 'symbol') return undefined
      if (property === 'document') return virtualDocument
      if (property === 'innerWidth') return viewport.width
      if (property === 'innerHeight') return viewport.height
      // A window size is not a secret, and the frame can already read one off
      // its own `window.screen`; refusing it would break ten measured sites to
      // protect nothing.
      if (property === 'SillyTavern') return context === undefined ? undefined : sillyTavern
      if (property === 'extension_settings') return extensionSettings

      const planned = unbridged.get(property)
      if (planned !== undefined) {
        // A different fact from "forbidden", and the card author debugging
        // deserves the right one.
        throw new UnsupportedApiError(
          `parent.${property}`,
          `Iris has not bridged it yet; it is planned as ${planned.plan}.`,
        )
      }
      throw new UnsupportedApiError(`parent.${property}`)
    },
    set(_target, property): boolean {
      throw new UnsupportedApiError(`parent.${String(property)}`, 'The sandbox is not writable.')
    },
    has(_target, property): boolean {
      return (
        property === 'document' ||
        property === 'innerWidth' ||
        property === 'innerHeight' ||
        ((property === 'SillyTavern' || property === 'extension_settings') && context !== undefined)
      )
    },
  })

  /**
   * `window`, `self` and `globalThis`, as a card sees them.
   *
   * Proxied through to the real frame window rather than replaced: a card
   * legitimately uses `window.addEventListener`, `window.setTimeout` and its own
   * `document`, and all of that is the card's own realm. Only the three names
   * that reach outward are overridden.
   */
  const windowShadow = new Proxy(env.realWindow, {
    get(target, property): unknown {
      if (property === 'parent' || property === 'top') return virtualParent
      if (property === 'self' || property === 'window' || property === 'globalThis') {
        return windowShadow
      }
      if (typeof property === 'symbol') return Reflect.get(target, property)
      return passthrough(target, property)
    },
    set(target, property, value): boolean {
      // Writes land on the real frame window: a card assigning `window.foo` is
      // using its own realm as a namespace, which is its business.
      if (property === 'parent' || property === 'top') {
        throw new UnsupportedApiError(`window.${String(property)}`, 'The sandbox is not writable.')
      }
      return Reflect.set(target, property, value)
    },
  })

  /*
   * The bare globals are shadowed too, not only `parent.*`.
   *
   * Upstream flattens its whole API onto the child window as plain globals, so
   * cards are written against both shapes — the corpus has the compatibility
   * form that tries the bare global first and falls back to
   * `window.parent.extension_settings`. Bridging only the `parent` path would
   * miss every card that takes the first branch.
   *
   * `eventSource`, `event_types` and `TavernHelper` are deliberately NOT here:
   * they are unbridged, and a bare name left undefined at least makes a direct
   * use throw. (A `typeof x !== 'undefined'` probe still fails quietly, which is
   * a blind spot no shadowing can close — noted in the README.)
   */
  /**
   * `triggerSlash`, as a card sees it.
   *
   * Defined even though nothing executes the command yet, and that is the point:
   * the measured call site is
   * `if (typeof triggerSlash === 'function') triggerSlash(...)`, so an undefined
   * global makes the card skip the branch **silently**. A definition that hands
   * the string onward is a card that visibly does something; an absence is a card
   * that quietly does nothing, which is the failure mode this sandbox keeps
   * choosing against.
   *
   * The raw string travels unparsed — upstream's pipe escaping lives host-side
   * and a second copy here would be two ideas of one convention.
   *
   * The promise resolves when the **host has run the command**, which is where
   * upstream's resolves too: upstream waits for the command, not for generation,
   * and `/send|/trigger` finishing means the turn is open. Resolving on dispatch
   * would have been a deviation worth documenting; waiting for the answer is
   * simply the same contract.
   */
  let nextSlash = 0
  const pendingSlash = new Map<string, { resolve: (result: string) => void, reject: (why: Error) => void }>()

  let nextCall = 0
  const pendingCall = new Map<string, { resolve: (result: unknown) => void, reject: (why: Error) => void }>()

  /**
   * One action on the card's facade.
   *
   * The shell is what decides whether the action may run; this only carries the
   * request. A refusal comes back as a rejection so a card's `catch` sees it,
   * which is what upstream's would do.
   */
  const callAction = (method: string, params: unknown): Promise<unknown> => {
    const id = `c${(nextCall += 1)}`
    return new Promise<unknown>((resolve, reject) => {
      pendingCall.set(id, { resolve, reject })
      env.post({ iris: env.token, type: 'call', id, method, params })
    })
  }

  const triggerSlash = (command: unknown): Promise<string> => {
    const id = `s${(nextSlash += 1)}`
    return new Promise<string>((resolve, reject) => {
      pendingSlash.set(id, { resolve, reject })
      env.post({ iris: env.token, type: 'slash', id, command: String(command) })
    })
  }

  /**
   * Which entry of `script.list` is running, carried in on the `run` message.
   *
   * The frame cannot derive this: the body it is handed is just source, and two
   * enabled scripts on one card are indistinguishable by their text. The runner
   * is the only party that knows which one it dispatched.
   */
  let scriptId: string | undefined

  /**
   * Upstream's `getScriptId`, the one member a card uses to name its own
   * variable scope. Returns `undefined` for a body with no entry in the host's
   * list, matching what the host answers for an unidentified caller.
   * @returns the running script's id, or `undefined` when it has none.
   */
  const getScriptId = (): string | undefined => scriptId

  /**
   * The bus is the frame's, not the host's.
   *
   * Cards both listen and emit, and MVU emits far more than it listens for — 53
   * `eventEmit` sites against 17 `eventOn`. Most of that traffic is a card
   * talking to itself, so it stays here; the shell forwards in only the host
   * events something is actually waiting on.
   */
  const events = new EventBus()

  const tavernHelper = createFrameTavernHelper({
    context: () => context,
    scriptId: () => scriptId,
    call: callAction,
    triggerSlash,
    events,
  })

  const core = [
    'window',
    'self',
    'globalThis',
    'parent',
    'top',
    'SillyTavern',
    'extension_settings',
    'triggerSlash',
    'getScriptId',
  ] as const

  /**
   * The Tavern Helper names, minus the two the core list already binds.
   *
   * A name may only be bound once — it becomes a function parameter in classic
   * mode — and `triggerSlash` and `getScriptId` appear on both lists because
   * upstream exposes them through both surfaces. The core binding wins; both
   * carry the same behaviour, so which one wins does not change what a card sees.
   */
  const helperNames = Object.keys(tavernHelper).filter(
    name => !(core as readonly string[]).includes(name),
  )

  const shadowed = [...core, ...helperNames]

  /**
   * Values are resolved per evaluation, not at install.
   *
   * `extension_settings` does not exist until the context arrives, and the
   * context arrives after install. Capturing at install would hand every card a
   * permanent `undefined`.
   */
  const resolveValues = (): unknown[] => [
    windowShadow,
    windowShadow,
    windowShadow,
    virtualParent,
    virtualParent,
    context === undefined ? undefined : sillyTavern,
    extensionSettings,
    triggerSlash,
    getScriptId,
    ...helperNames.map(name => tavernHelper[name]),
  ]

  env.onMessage(message => {
    if (message.type === 'viewport') {
      viewport = { width: message.width, height: message.height }
      env.applyViewport?.(viewport)
      return
    }
    if (message.type === 'call:ok' || message.type === 'call:error') {
      const waiting = pendingCall.get(message.id)
      if (waiting === undefined) return
      pendingCall.delete(message.id)
      if (message.type === 'call:ok') waiting.resolve(message.result)
      else waiting.reject(new Error(message.message))
      return
    }
    if (message.type === 'slash:ok' || message.type === 'slash:error') {
      const waiting = pendingSlash.get(message.id)
      if (waiting === undefined) return
      pendingSlash.delete(message.id)
      if (message.type === 'slash:ok') waiting.resolve(message.result)
      // Rejected with a real Error so a card's `.catch` sees what upstream's would.
      else waiting.reject(new Error(message.message))
      return
    }
    if (message.type === 'event') {
      // Not awaited and not reported: a listener that throws is the card's
      // problem with its own handler, and upstream does not tell the host either.
      void events.eventEmit(message.event, ...message.args)
      return
    }
    if (message.type === 'context') {
      context = message.context
      extensionSettings = settingsProxy({ ...message.context.extensionSettings })
      return
    }
    if (message.type !== 'run') return

    // Before `resolveValues`, which closes over it.
    scriptId = message.scriptId

    const values = resolveValues()

    const failed = (error: unknown): void => {
      // A refusal and a bug in the card both land here, and the shell shows them
      // differently: `member` is what tells them apart.
      const member = error instanceof UnsupportedApiError ? error.member : undefined
      env.post({
        iris: env.token,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        ...(member === undefined ? {} : { member }),
      })
    }

    try {
      // Inside the reporting try/catch, and that placement is the point: it used
      // to sit above it, so when publishing the bridge threw, the exception
      // escaped the handler and the frame went silent for the rest of its life —
      // no body, no error, nothing. Anything between receiving `run` and finishing
      // the body has to be able to say that it failed.
      //
      // Published before evaluation in both modes, because a module has no other
      // way to see these and a classic body loses nothing by having both routes.
      env.publishGlobals?.([
        ...shadowed.map((name, at) => [name, values[at]] as [string, unknown]).filter(
          // The window aliases are not ours to redefine and would be circular
          // anyway; `parent`/`top` are attempted because whether they can be
          // redefined is a browser question the frame answers empirically.
          ([name]) => name !== 'window' && name !== 'self' && name !== 'globalThis',
        ),
      ])

      // Which of upstream's seeded globals this frame does NOT have. Reported
      // rather than waited for: without it, each missing library costs a full
      // round trip to discover, one crash at a time, and the crash names the
      // symptom rather than the gap.
      env.reportMissingGlobals?.(EXPECTED_GLOBALS)

      const running = env.evaluate(message.code, message.mode, shadowed, values)
      if (running instanceof Promise) {
        // A module loads asynchronously, so `ran` cannot be posted on the next
        // line. The distinction matters for what `ran` means: the body finished
        // evaluating, not the card finished working.
        void running.then(
          () => env.post({ iris: env.token, type: 'ran' }),
          (error: unknown) => failed(error),
        )
      } else {
        env.post({ iris: env.token, type: 'ran' })
      }
    } catch (error: unknown) {
      failed(error)
    }
  })

  // Readiness is announced by the entry, not here: it depends on the frame's
  // subresources having settled, and this module deliberately knows nothing about
  // the document it is installed into.

  return { shadowed, viewport: readViewport }
}
