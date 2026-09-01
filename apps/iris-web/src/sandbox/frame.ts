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
import { createEventSource, createFrameTavernHelper } from './tavern-helper.ts'
import { identityMembers } from './identity.ts'
import { scopedEvents } from './scoped-events.ts'
import { SCRIPT_REGISTRY, withPreamble } from './preamble.ts'
import { EventBus, TAVERN_EVENTS } from '@iris/compat-tavernhelper-core'
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
   * Define a name on the frame's own window that reads through to a live source.
   *
   * Separate from `publishGlobals` because the difference is a getter. Publishing
   * copies a value; this forwards, so a provider retracting its interface is seen
   * by every consumer instead of leaving them holding a withdrawn object. It is
   * what upstream does for a global a script waited on.
   */
  defineForwarding?: (name: string, read: () => unknown) => void
  /**
   * Record a running script in the frame's own script list.
   *
   * Upstream keeps one `div[data-script-id]` per running script inside
   * `#tavern_helper` on the host page, and cards read that list to decide which
   * instance of themselves should be the active one. With a card's scripts
   * sharing one frame, the frame *is* that page for them.
   */
  listScript?: (scriptId: string | undefined) => void
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
  /**
   * Names this card's scripts have published to each other.
   *
   * One bag per frame, and after cohabitation a frame is one card — so this is
   * the card-scoped shared namespace that upstream gets for free by having all
   * its script frames share a same-origin parent. `window.parent` is where a
   * provider publishes: MVU writes `_.set(window.parent, 'Mvu', mvu)` and
   * removes it again with `_.unset` on teardown.
   *
   * Reads and writes are deliberately asymmetric. A name that has been written
   * reads back; a name nobody wrote still refuses by name, exactly as before.
   * Turning every unknown parent member into `undefined` would trade the
   * refusal discipline — the thing eleven sandbox runs bought — for the
   * convenience of a shared slot, and a card reaching for a host API we do not
   * have would fail somewhere else entirely.
   */
  const published = new Map<string, unknown>()

  /** Members the frame bridges itself, which a card may never overwrite. */
  const isBridged = (property: string): boolean =>
    property === 'document' ||
    property === 'innerWidth' ||
    property === 'innerHeight' ||
    property === 'SillyTavern' ||
    property === 'extension_settings' ||
    property === 'TavernHelper' ||
    property === 'eventSource' ||
    property === 'event_types'

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
      /*
       * The three that used to be `UNBRIDGED_GLOBALS`, measured at 15 sites
       * between them. All reach the same objects a card gets as bare globals:
       * upstream's `eventOn` is a wrapper around `eventSource`, so a card that
       * subscribes through one name and emits through the other must still be
       * talking to itself.
       */
      if (property === 'TavernHelper') return tavernHelper['TavernHelper']
      if (property === 'eventSource') return eventSource
      if (property === 'event_types') return TAVERN_EVENTS

      // Published by one of this card's scripts. Checked after the bridged
      // members so a card cannot shadow `document` by writing to it.
      if (published.has(property)) return published.get(property)

      /*
       * An unpublished name yields `undefined` and is reported once.
       *
       * It used to throw. That was right about the danger and wrong about the
       * mechanism, and it cost a verification round: upstream's cross-script
       * coordination begins with `_.get(window.parent, 'th_unique_check.…',
       * new Set())` — read with a default, then write — so throwing on the first
       * read of a slot nobody has published yet threw *inside* an init that
       * swallows exceptions. MVU never reached its `_.set(window.parent, 'Mvu',
       * …)`, and every consumer waited forever on a publish that had already
       * been abandoned.
       *
       * Returning `undefined` is also what upstream does — an absent property on
       * a real parent window is not an error. What upstream does *not* do is say
       * anything, and silence is what turns a missing host capability into a
       * failure three steps away. So the frame yields like upstream and speaks
       * unlike it: the policy asked for a named refusal *or an audible warning*,
       * and only the warning leaves a working namespace behind.
       *
       * Deduplicated, because a card polling a slot in a loop would otherwise
       * turn one gap into a stream.
       */
      const planned = unbridged.get(property)
      reportGap(
        planned === undefined
          ? `a card read parent.${property}, which nothing has published in this frame` +
            ' — it returned undefined, which is not a statement that the host has no such member'
          : `a card read parent.${property}, which Iris has measured but not built yet` +
            ` (planned as ${planned.plan}); it returned undefined`,
      )
      return undefined
    },

    set(_target, property, value): boolean {
      if (typeof property === 'symbol') {
        throw new UnsupportedApiError('parent[symbol]', 'The sandbox is not writable.')
      }
      // The bridged members stay read-only. A card overwriting `document` or
      // `SillyTavern` would be redefining the frame's own view of the host.
      if (isBridged(property)) {
        throw new UnsupportedApiError(`parent.${property}`, 'The sandbox is not writable.')
      }
      published.set(property, value)
      return true
    },
    /**
     * Removing a published name.
     *
     * MVU does this on teardown (`_.unset(window.parent, 'Mvu')`), and a
     * provider that cannot retract its interface would leave consumers waiting
     * on something already gone.
     */
    deleteProperty(_target, property): boolean {
      if (typeof property === 'symbol' || isBridged(property)) {
        throw new UnsupportedApiError(`parent.${String(property)}`, 'The sandbox is not writable.')
      }
      published.delete(property)
      return true
    },
    has(_target, property): boolean {
      if (typeof property === 'symbol') return false
      return (
        published.has(property) ||
        property === 'document' ||
        property === 'innerWidth' ||
        property === 'innerHeight' ||
        property === 'TavernHelper' ||
        property === 'eventSource' ||
        property === 'event_types' ||
        ((property === 'SillyTavern' || property === 'extension_settings') && context !== undefined)
      )
    },
    /**
     * The trap `_.has` actually reaches.
     *
     * `hasOwnProperty` does **not** go through `has` — it goes through here — and
     * lodash's `_.has` is built on `hasOwnProperty`. Since
     * `waitGlobalInitialized` polls with `_.has(window, 'Mvu')`, omitting this
     * trap would leave the poll answering false forever while `in` said true:
     * the feature would fail with both halves apparently correct.
     */
    getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
      if (typeof property !== 'string') return undefined
      if (!published.has(property)) return undefined
      return { value: published.get(property), writable: true, enumerable: true, configurable: true }
    },
    /** So `Object.keys(parent)` sees what this card published, and nothing else. */
    ownKeys(): ArrayLike<string | symbol> {
      return [...published.keys()]
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
  /**
   * The identity the *shared* global answers with, fixed at the first run.
   *
   * Card bodies get their true identity from the per-script preamble. Code they
   * **import** does not: a bundle is its own module and reads the global, so it
   * used to see whichever script ran last — a value that changes underneath it
   * between two of its own calls.
   *
   * That is fatal to the coordination upstream cards rely on. MVU registers with
   * `registerAsUniqueScript` under `getScriptId()` and later enables itself only
   * when `preferred === getScriptId()`; the two reads must agree, and a mutable
   * shared value can make them disagree for no reason the card can see.
   *
   * Fixed rather than cleared, and fixed to the *first* script because that id
   * has an element in the frame's script list — the election matches against
   * those, so an id with no element elects nobody.
   */
  let scriptId: string | undefined
  let scriptIdFixed = false

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
  const eventSource = createEventSource(events)

  /**
   * How long a wait may run before it is worth *saying* it is still waiting.
   *
   * A report threshold, not a deadline. Upstream's `waitGlobalInitialized` has
   * **no timeout at all** — it resolves when `global_X_initialized` fires and
   * otherwise waits forever. The five seconds this project used to apply here
   * were borrowed from the wrong place: `async-wait-until`'s default belongs to
   * the Mvu-specific `stat_data` poll, which runs *after* the global is already
   * present and whose timeout upstream catches and ignores.
   *
   * Mis-siting it turned a patient wait into a race. Every chat opens a fresh
   * opaque origin, so a card's bundle is always a cold fetch; upstream's frames
   * are same-origin and share the page cache, so its providers are effectively
   * always warm. A cap that upstream never pays cost us the window.
   */
  const WAIT_NOTICE_MS = 5_000

  /**
   * A global's name must be a non-empty string.
   * @param member - the caller, for the refusal.
   * @param name - whatever was passed.
   * @returns the name.
   */
  const requireGlobalName = (member: string, name: unknown): string => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new UnsupportedApiError(`${member}(${String(name)})`, 'A global needs a name.')
    }
    return name
  }

  /**
   * Announce a capability this frame lacks, once it has actually been reached
   * for.
   *
   * Not an error — the card carries on, as it would upstream. It exists because
   * the alternative is a gap wearing the shape of an ordinary answer: text
   * returned unexpanded is indistinguishable from text that had nothing to
   * expand.
   *
   * Deduplicated, because a card calling such a member in a loop would turn one
   * gap into a stream, and a stream teaches a reader to skip the whole class of
   * line rather than read it.
   */
  /**
   * Take on the variable table the host confirmed after a write.
   *
   * One implementation, used by both the shared surface and every per-script
   * view. It existed twice — once with this reasoning attached and once without
   * — and two copies of a rule where only one carries its reason is a copy
   * waiting to be changed alone.
   *
   * The snapshot is replaced wholesale by the next `context` message, so this
   * only has to hold until then. Guarded because a write can land before the
   * first context arrives, and a card's write must not conjure a snapshot that
   * later reads would treat as the host's.
   * @param variables - the table the host stored.
   */
  const adoptVariables = (variables: Record<string, unknown>): void => {
    if (context !== undefined) context = { ...context, variables }
  }

  /**
   * Scripts parked on a named global, and what they are parked on.
   *
   * Two rules here contradicted each other. The wait is unbounded on purpose —
   * upstream never abandons one — while the module deadline calls any module
   * that has not finished in fifteen seconds stalled. A module *knowingly*
   * waiting has not stalled, and letting the deadline speak over it did two
   * kinds of damage: it reported a healthy park as a failure, and it erased the
   * one state that says what the module is waiting for.
   */
  const activeWaits = new Map<string | undefined, { global: string, since: number }>()

  const reportedGaps = new Set<string>()
  const reportGap = (message: string): void => {
    if (reportedGaps.has(message)) return
    reportedGaps.add(message)
    env.post({ iris: env.token, type: 'error', scriptId: undefined, message })
  }

  const tavernHelper = createFrameTavernHelper({
    context: () => context,
    scriptId: () => scriptId,
    reportGap,
    call: callAction,
    triggerSlash,
    events,
    adoptVariables,
  })

  /**
   * One script's bound view of the identity-bearing members.
   *
   * Built per script rather than shared, because when a card's scripts occupy
   * one frame a single copy would answer for whichever ran last: the wrong
   * variable partition (which reads as empty) and a teardown reaching a
   * sibling's listeners (which reads as an event that never fired).
   *
   * The shared members are not rebuilt — they have the same answer whoever asks,
   * and `identity.ts` is where that judgment is recorded and guarded.
   * @param forScript - the script this view belongs to.
   * @returns the members that must not be shared.
   */
  /**
   * Upstream's cross-script coordination pair, over the card's shared namespace.
   *
   * `initializeGlobal` publishes and announces; `waitGlobalInitialized` resolves
   * once the name is there. Both are per-script only in that they report which
   * script is waiting — the namespace itself is the card's.
   *
   * The publisher that matters does **not** call `initializeGlobal`: MVU writes
   * `_.set(window.parent, 'Mvu', mvu)` and emits the event itself. So this pair
   * is provided for cards that use it, while the write path stays the thing that
   * actually has to work.
   *
   * The deadline is upstream's: `async-wait-until` gives up after five seconds
   * and the caller swallows it, so a consumer whose provider never arrives
   * carries on rather than hanging forever. What upstream does not do is *say*
   * that it waited, and that silence is the whole reason the frame reports it.
   * @param forScript - who is waiting, for the report.
   * @returns the two members.
   */
  const coordination = (forScript: string | undefined): Record<string, unknown> => ({
    initializeGlobal: (name: unknown, value: unknown): void => {
      const global = requireGlobalName('initializeGlobal', name)
      published.set(global, value)
      void events.eventEmit(`global_${global}_initialized`)
    },
    waitGlobalInitialized: async (name: unknown): Promise<void> => {
      const global = requireGlobalName('waitGlobalInitialized', name)
      /*
       * Waiting is only half of it. Upstream's own description is "等待其他
       * iframe 中共享出来的全局接口初始化完毕, **并使之在当前 iframe 中可用**" —
       * it resolves *and* puts the name in the caller's realm, with
       * `Object.defineProperty(this, global, { get: () => _.get(window, global) })`.
       *
       * A getter rather than a copied value, deliberately: a provider can retract
       * its interface (`_.unset(window.parent, 'Mvu')` on teardown), and a
       * snapshot would leave consumers holding an object the provider has
       * withdrawn.
       *
       * Without this the wait resolves and the very next line still throws
       * `Mvu is not defined`, which is exactly what a real card did: the await
       * succeeded and the bare reference after it did not.
       */
      const makeUsable = (): void => {
        env.defineForwarding?.(global, () => published.get(global))
      }

      if (published.has(global)) {
        makeUsable()
        return
      }
      env.post({ iris: env.token, type: 'waiting', scriptId: forScript, global, elapsedMs: 0 })
      activeWaits.set(forScript, { global, since: Date.now() })
      const started = Date.now()
      await new Promise<void>(resolve => {
        const done = (): void => {
          clearTimeout(notice)
          events.eventRemoveListener(`global_${global}_initialized`, announced)
          resolve()
        }
        const announced = (): void => done()
        /*
         * Says so, and keeps waiting. Upstream is silent about a wait and never
         * abandons one; this frame is unwilling to be silent — a hang is the
         * failure with no voice — but abandoning it was never upstream's
         * behaviour and is not something to invent on upstream's behalf.
         */
        const notice = setTimeout(() => {
          env.post({
            iris: env.token,
            type: 'waiting',
            scriptId: forScript,
            global,
            elapsedMs: Date.now() - started,
          })
        }, WAIT_NOTICE_MS)
        events.eventOn(`global_${global}_initialized`, announced)
        // Re-checked after subscribing: a provider that published between the
        // first check and the subscription would otherwise never be noticed.
        if (published.has(global)) done()
      })
      activeWaits.delete(forScript)
      makeUsable()
      env.post({ iris: env.token, type: 'waited', scriptId: forScript, global, arrived: true })
    },
  })

  /**
   * Scripts whose module body has begun executing.
   *
   * Recorded because it is the one fact that splits a stalled import in two, and
   * it costs nothing to collect: ES module imports are **hoisted**, so every
   * static import of a module has been fetched and evaluated before its first
   * statement runs. The preamble's registry call *is* that first statement.
   *
   * So a body that has begun proves the remote fetch succeeded, and a timeout
   * after that point is a stall inside the imported code rather than in getting
   * hold of it. Without this the two are indistinguishable from outside, and the
   * frame reports the same sentence for both.
   */
  const begun = new Set<string | undefined>()

  const viewFor = (forScript: string | undefined): Record<string, unknown> => {
    begun.add(forScript)
    const bound = createFrameTavernHelper({
      context: () => context,
      scriptId: () => forScript,
      reportGap,
      call: callAction,
      triggerSlash,
      events,
      adoptVariables,
    })
    // Events come from the scoped wrapper rather than the bound surface: the
    // surface talks to the shared bus directly, which is right for emission and
    // wrong for teardown.
    const scoped = scopedEvents(events, (member, event) => {
      if (typeof event !== 'string' || event.length === 0) {
        throw new UnsupportedApiError(
          `${member}(${String(event)})`,
          'An event name must be a non-empty string. A missing table entry reads as undefined here.',
        )
      }
      return event
    }) as unknown as Record<string, unknown>

    const view: Record<string, unknown> = { ...coordination(forScript) }
    for (const name of identityMembers()) {
      // Only from a surface that actually has it. The coordination pair is
      // identity-bearing *and* built here rather than by the helper, so copying
      // blindly would overwrite both with `undefined` — which is how they first
      // shipped: classified correctly, then clobbered by the loop that acts on
      // the classification.
      if (Object.hasOwn(scoped, name)) view[name] = scoped[name]
      else if (Object.hasOwn(bound, name)) view[name] = bound[name]
    }
    return view
  }

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

    // Before `resolveValues`, which closes over it. Set once: see `scriptId`.
    if (!scriptIdFixed) {
      scriptIdFixed = true
      scriptId = message.scriptId
    }
    env.listScript?.(message.scriptId)

    const values = resolveValues()

    const failingScript = message.scriptId
    const failed = (error: unknown): void => {
      // A refusal and a bug in the card both land here, and the shell shows them
      // differently: `member` is what tells them apart.
      const member = error instanceof UnsupportedApiError ? error.member : undefined
      const text = error instanceof Error ? error.message : String(error)
      /*
       * A stalled import has two very different causes and one sentence, so the
       * sentence is split here by the only evidence that separates them.
       *
       * Imports are hoisted: if the body ran at all, every static import had
       * already been fetched and evaluated. So a timeout with the body begun is
       * the imported module hanging on its own — a top-level await that never
       * settles, say — while a timeout with no body means the fetch itself never
       * came back.
       */
      /*
       * A module that is knowingly waiting is not reported as stalled.
       *
       * The deadline cannot know this: it lives in the entry and sees only that
       * evaluation has not finished. This does. Re-announcing the wait rather
       * than falling silent keeps the panel showing *what* it waits on — the
       * deadline's sentence used to overwrite exactly that, which is why two
       * verification rounds could not tell a woken waiter from one that never ran.
       */
      const parked = activeWaits.get(failingScript)
      const overdue = text.includes('still evaluating after') || text.includes('import timed out')
      if (parked !== undefined && overdue) {
        env.post({
          iris: env.token,
          type: 'waiting',
          scriptId: failingScript,
          global: parked.global,
          elapsedMs: Date.now() - parked.since,
        })
        return
      }

      const stalled = text.includes('import timed out')
      const detail = !stalled
        ? text
        : begun.has(failingScript)
          ? `${text} — the body had begun, so the imported module is stalling on its own, not the fetch`
          : `${text} — the body never began, so this is the fetch itself`
      env.post({
        iris: env.token,
        type: 'error',
        message: detail,
        ...(member === undefined ? {} : { member }),
        // Whose failure this was. One frame runs a card's whole set, so an
        // unattributed outcome would land on whichever script the shell was
        // tracking rather than the one that failed.
        scriptId: failingScript,
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
        /*
         * The registry each co-located script reads its own bindings from.
         *
         * Published here rather than at install for the reason the comment above
         * records: everything between receiving `run` and finishing the body has
         * to be able to report that it failed, and a publish that threw outside
         * this block once silenced a frame for its whole life.
         *
         * Not concealed. Within one card the scripts share a realm and can
         * already reach each other, so hiding it would buy no isolation the realm
         * has not already given away.
         */
        [SCRIPT_REGISTRY, (id: unknown) => viewFor(typeof id === 'string' ? id : undefined)],
      ])

      // Which of upstream's seeded globals this frame does NOT have. Reported
      // rather than waited for: without it, each missing library costs a full
      // round trip to discover, one crash at a time, and the crash names the
      // symptom rather than the gap.
      env.reportMissingGlobals?.(EXPECTED_GLOBALS)

      /*
       * The preamble goes on in module mode only.
       *
       * A classic body is handed its bindings as function parameters, which
       * already gives it a per-run scope; a module has no parameters, so its
       * per-script bindings have to arrive as source. One line, so a card
       * author's reported line numbers are off by a constant they can be told.
       */
      const source =
        message.mode === 'module' ? withPreamble(message.scriptId, message.code) : message.code
      const running = env.evaluate(source, message.mode, shadowed, values)
      if (running instanceof Promise) {
        // A module loads asynchronously, so `ran` cannot be posted on the next
        // line. The distinction matters for what `ran` means: the body finished
        // evaluating, not the card finished working.
        void running.then(
          () => env.post({ iris: env.token, type: 'ran', scriptId: failingScript }),
          (error: unknown) => failed(error),
        )
      } else {
        env.post({ iris: env.token, type: 'ran', scriptId: failingScript })
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
