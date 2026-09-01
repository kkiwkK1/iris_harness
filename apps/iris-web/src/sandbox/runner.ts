/**
 * The host side of a card's frame: create, feed, size, dispose.
 *
 * Deliberately the thinnest module in the sandbox. Everything it could decide
 * has been moved somewhere injectable — the frame's markup to `srcdoc.ts`, what
 * a card may touch to `frame.ts` and `virtual-document.ts`, message validation
 * to `protocol.ts` — because this file is the only part that cannot run without a
 * browser, and an untestable file should own as few decisions as possible.
 *
 * What is left here is sequencing, and one part of it is load-bearing: the
 * context snapshot must reach the frame **before** the card body does. Cards call
 * `SillyTavern.getContext()` synchronously and a cross-origin frame can only be
 * spoken to asynchronously, so a card that ran first would see no host at all.
 *
 * @module iris-web/sandbox/runner
 */

import type { ScriptContext } from '@iris/protocol'

import { frameSandbox } from './policy.ts'
import { mintToken, parseFromFrame, type FromFrame, type ToFrame } from './protocol.ts'
import { buildSrcdoc } from './srcdoc.ts'
import { rewriteViewportUnits } from './viewport-units.ts'
import { rewriteBundleImports } from './bundle-proxy.ts'

/** What one running card needs from the shell. */
export interface RunnerHost {
  /** The bootstrap source, already built. */
  bootstrap: string
  /**
   * The card's scripts, in card order — all of them in one frame.
   *
   * One frame per card rather than per script, because that is the only place
   * `waitGlobalInitialized` can work: a provider publishes a live interface and
   * a consumer uses it, and a live object cannot cross an opaque origin. Sharing
   * a realm is what makes the feature expressible at all.
   *
   * Each still evaluates as its own `<script type="module">`, so their top-level
   * bindings stay separate; what they share is `window`, which is exactly the
   * upstream arrangement minus the frame boundary.
   */
  scripts: readonly { id: string | undefined, code: string }[]
  /**
   * How to execute it.
   *
   * Carried from the caller rather than sniffed here: upstream runs every card
   * script as a module unconditionally, and a sniffer would make cards behave
   * differently for reasons their authors could not predict.
   */
  mode: 'classic' | 'module'
  /**
   * Preset libraries to load before the card, in order.
   *
   * Upstream's list for the frame type, not a guess: a card written against
   * Tavern Helper assumes exactly what Tavern Helper provides.
   */
  libraries: readonly string[]
  /** Whether the user granted this card the real page. */
  documentGranted: boolean
  /** Whether the user granted this card the network. */
  networkGranted: boolean
  /**
   * The origin serving the host's bundle proxy.
   *
   * Passed in rather than read from `location` here: this module builds frames
   * and should not also decide where the host lives, and a test that could not
   * vary it could not check that an unallowed URL is left alone.
   */
  bundleOrigin: string
  /** The host snapshot, fetched once and pushed before the card runs. */
  context: ScriptContext
  /** The host page's viewport, read on demand. */
  viewport: () => { width: number, height: number }
  /** Fetch a remote dependency through the host, which enforces the allowlist. */
  fetch: (url: string) => Promise<string>
  /** A card wrote its extension settings; persist them. */
  onSettings: (settings: Record<string, unknown>) => void
  /**
   * The card invoked a slash command, raw and unparsed.
   *
   * Required rather than optional, on the same reasoning as `onBlocked`: a card
   * that asked the application to send a message and was silently ignored is
   * indistinguishable, from the reader's side, from a card that is broken.
   */
  onSlash: (command: string) => Promise<string>
  /**
   * The card invoked one of its facade's actions.
   *
   * The shell decides whether a named action may run. The frame is the untrusted
   * side, so its belief about what is callable is a proposal — this is where the
   * proposal is accepted or refused.
   */
  onCall: (method: string, params: unknown) => Promise<unknown>
  /** The card threw, or was refused a member. */
  onError: (message: string, member: string | undefined, scriptId: string | undefined) => void
  /**
   * The frame's policy refused a host.
   *
   * Required rather than optional: a refusal nobody is told about is delivered to
   * the user as whatever the card says next, and one card's author has already
   * pre-written "your Tavern is broken" for this exact case. A caller that has
   * nowhere to show this should not be running cards.
   */
  onBlocked: (host: string, directive: string) => void
  /**
   * Something the frame observed that is not a failure.
   *
   * Optional because most hosts have nothing to do with it; the shell passes it
   * to the card's durable report list, where a cost measurement belongs — the
   * notice bar holds one entry and clears itself, so anything reported there
   * during startup destroys itself.
   */
  onNote?: (message: string) => void
  /**
   * Markup for the frame's own body — a message frame's card interface.
   *
   * Present only for a message frame. Its absence is what makes this a script
   * frame: no markup means the bodies arrive as `run` messages instead, and
   * `scripts` is where they come from. A message frame passes no scripts at all,
   * because markup only runs by being parsed.
   */
  markup?: string
  /**
   * The card body finished evaluating without throwing.
   *
   * Distinct from "the card is finished": a card that installs listeners and
   * returns has run to completion while its actual work is only beginning. This
   * answers exactly one question — did the body execute — which is the question a
   * first run asks.
   */
  onRan?: (scriptId: string | undefined, lateMs?: number) => void
  /**
   * A script blocked on, or released by, a sibling's global.
   *
   * Reported rather than left to a timeout, because a hang is the failure that
   * does not announce itself — and with a card's scripts sharing a frame, the
   * ones that are fine make the stuck one look fine too.
   */
  onWaiting?: (
    scriptId: string | undefined,
    global: string,
    state: 'waiting' | 'arrived',
    elapsedMs: number,
  ) => void
  /** The frame's bootstrap installed and is waiting for a body. */
  onReady?: () => void
  /**
   * The bootstrap failed before it could stamp a token.
   *
   * Its own callback because it means something different from every other
   * failure: nothing in the frame is running, so no card behaviour is implicated.
   */
  onBootstrapError?: (message: string) => void
  /**
   * Which bridged globals the frame could publish onto its own window.
   *
   * Reported because `parent` and `top` may not be redefinable, and the answer is
   * a browser fact rather than a design decision. A caller that shows this turns
   * an assumption into an observation.
   */
  onGlobals?: (published: readonly string[], refused: readonly string[]) => void
  /**
   * The frame reported its content height, already bounded by the protocol.
   *
   * The runner applies it either way; this is for a caller that needs to know it
   * happened — which so far is the dev harness, whose whole job is observing
   * that the mechanism works.
   */
  onHeight?: (pixels: number) => void
}

/** A running card. */
export interface RunningCard {
  /** The frame element, for the shell to place. */
  readonly element: HTMLIFrameElement
  /**
   * Deliver a host event to the card's bus.
   *
   * A no-op once disposed, so a shell subscription that outlives the frame by a
   * tick cannot post into a torn-down realm.
   */
  emit: (event: string, args: unknown[]) => void
  /**
   * Replace the frame’s snapshot with a newer one.
   *
   * The façade reads `host.context()` on **every** call, so a card's
   * `getChatMessages` answers from whatever snapshot the frame currently holds
   * — which means keeping that snapshot current is the whole of keeping the
   * card current. Upstream needs no equivalent because its `chat` array is the
   * live one; ours crosses an origin, so the liveness has to be pushed.
   *
   * Safe before the frame is ready: the newest snapshot is what gets sent at
   * `ready`, rather than the one captured at construction. That matters here
   * and is not defensive — these frames take seconds to boot, so an update
   * arriving during boot is ordinary, and dropping it would start the card on
   * text that was already stale.
   */
  refreshContext: (context: ScriptContext) => void
  /** Remove the frame and every listener it needed. Idempotent. */
  dispose: () => void
}

/**
 * Start a card in its own frame.
 *
 * @param host - the surrounding shell's side of the contract.
 * @param document - the host document, injected so this is not implicitly global.
 * @returns the frame and its disposer.
 */
export function runCard(host: RunnerHost, document: Document): RunningCard {
  const token = mintToken()
  const frame = document.createElement('iframe')

  // Set before `srcdoc`: the sandbox attribute has to be in place when the
  // document is created, or the frame is briefly not sandboxed at all.
  frame.setAttribute('sandbox', frameSandbox(host.documentGranted))
  frame.setAttribute('title', 'Card interface')
  frame.setAttribute('scrolling', 'no')
  frame.style.width = '100%'
  frame.style.border = '0'
  frame.style.display = 'block'
  frame.srcdoc = buildSrcdoc(token, host.bootstrap, {
    networkGranted: host.networkGranted,
    libraries: host.libraries,
    selfOrigin: window.location.origin,
    ...(host.markup === undefined ? {} : { body: host.markup }),
    /*
     * A message frame gets its snapshot **inlined**, a script frame does not.
     *
     * The difference is when the card's code runs. A script body is handed over
     * the channel, so it cannot run before the channel has been used; a message
     * frame's markup runs while the document is still parsing, and reads its
     * variables immediately — drawing a panel from them is the point of it
     * existing. The pushed `context` cannot arrive that early, so inlining is
     * what makes the ordering correct by construction rather than dependent on a
     * library fetch's parse pause outlasting a message round trip.
     */
    ...(host.markup === undefined ? {} : { context: host.context }),
  })

  let disposed = false
  /**
   * The snapshot this frame should hold.
   *
   * Mutable because the chat keeps moving after the frame is built, and the
   * façade answers every `getChatMessages` from whatever this is. Seeded from
   * the host and then replaced by `refreshContext`.
   */
  let current: ScriptContext = host.context
  /**
   * Whether the frame has said `ready`.
   *
   * Tracked so a refresh arriving before then updates `current` without
   * posting into a frame that has no listener yet — the post would be dropped
   * silently, which is the failure mode this whole file is written against.
   */
  let ready = false
  /** So one protocol fault is one report, not one per message. */
  let reportedUnreadable = false

  const post = (message: ToFrame): void => {
    // `'*'` because the frame's origin is opaque and cannot be named. Safe in
    // this direction: everything sent is either the card's own or already the
    // card's to see, and the token is what stops a different frame from acting on
    // a message meant for this one.
    frame.contentWindow?.postMessage(message, '*')
  }

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return
    // Source check first: only this frame may speak for this token, and checking
    // the window object is stronger than checking an origin that reads "null" for
    // every sandboxed frame on the page.
    if (event.source !== frame.contentWindow) return
    const message = parseFromFrame(token, event.data)
    if (message === undefined) {
      /*
       * The source check above has already established this came from our own
       * frame, so an unreadable payload is not noise — it is this frame saying
       * something the shell cannot parse: a protocol drift, or a serialisation
       * fault on one side of it.
       *
       * Dropping it silently produces the symptom this project has spent the
       * most time on: a frame that appears to have gone quiet while it is in
       * fact talking. Noise from elsewhere never reaches here; only we do.
       *
       * Reported once. A card that found a way to post rubbish deliberately
       * would otherwise turn one fault into a flood, and a flood is how a reader
       * learns to ignore the whole class.
       *
       * **Not covered by a unit test.** The intake listens on the real `window`,
       * so reaching this branch needs a global stub rather than the injected
       * document the rest of this module takes. The half that *is* tested is the
       * parse: `sandbox-policy.test.ts` pins that a malformed payload yields
       * `undefined`. Whoever gives this module an injectable listener should
       * cover this at the same time — it is the branch that decides whether a
       * frame going quiet is visible.
       */
      if (!reportedUnreadable) {
        reportedUnreadable = true
        host.onError(
          'this frame sent a message the shell could not read — the shell and the frame' +
            ' disagree about the protocol, so anything it says next may also be lost',
          undefined,
          undefined,
        )
      }
      return
    }
    handle(message)
  }

  const handle = (message: FromFrame): void => {
    switch (message.type) {
      case 'bootstrap-error':
        host.onBootstrapError?.(message.message)
        return
      case 'ready': {
        ready = true
        host.onReady?.()
        // The order that matters. Context, then viewport, then the card.
        post({ iris: token, type: 'context', context: current })
        const size = host.viewport()
        post({ iris: token, type: 'viewport', width: size.width, height: size.height })
        // Rewritten on the way in, which is where upstream does it too: a card
        // sized in `vh` is measuring its own frame, and a frame sized to its
        // content would collapse `100vh` to nothing.
        /*
         * One `run` per script, in card order, into the same frame.
         *
         * Sent together rather than awaited one at a time: a module's evaluation
         * is asynchronous and a consumer is expected to wait for its provider
         * through `waitGlobalInitialized`, so serialising them here would make
         * the shell enforce an order the cards already negotiate — and would
         * deadlock any card whose provider is not listed first.
         */
        for (const script of host.scripts) {
          post({
            iris: token,
            type: 'run',
            /*
             * Two source transformations, both on the way in, both for reasons
             * the card cannot know about.
             *
             * `vh` is rewritten because a card sized to its own frame would
             * collapse `100vh` to nothing. Remote imports are routed through the
             * host because every chat is a fresh opaque origin and HTTP caching
             * is partitioned by origin, so a card's bundle would be a cold fetch
             * every time — 307 KB at 9–12s, measured, four timeouts in six
             * openings. Only URLs already allowed are routed; anything else is
             * left as written so the frame's CSP refuses it exactly as before.
             */
            code: rewriteBundleImports(rewriteViewportUnits(script.code), host.bundleOrigin),
            mode: host.mode,
            scriptId: script.id,
          })
        }
        return
      }
      case 'waiting':
        host.onWaiting?.(message.scriptId, message.global, 'waiting', message.elapsedMs)
        return
      case 'waited':
        host.onWaiting?.(message.scriptId, message.global, 'arrived', 0)
        return
      case 'height':
        /*
         * Refused at the applying end as well as at the reporting end.
         *
         * A frame is untrusted, so "the frame will not send zero" is a property
         * of our bootstrap rather than of every document that could be in there.
         * And applying it is unrecoverable: an inline `height: 0px` beats any CSS
         * floor, so the frame cannot be seen again — which is how one card went
         * from visible-but-clipped to invisible.
         */
        if (Number.isFinite(message.pixels) && message.pixels > 0) {
          frame.style.height = `${message.pixels}px`
        }
        host.onHeight?.(message.pixels)
        return
      case 'settings':
        host.onSettings(message.settings)
        return
      case 'call':
        void host
          .onCall(message.method, message.params)
          .then(result => {
            post({ iris: token, type: 'call:ok', id: message.id, result })
          })
          .catch((error: unknown) => {
            post({
              iris: token,
              type: 'call:error',
              id: message.id,
              message: error instanceof Error ? error.message : String(error),
            })
          })
        return
      case 'slash':
        void host
          .onSlash(message.command)
          .then(result => {
            post({ iris: token, type: 'slash:ok', id: message.id, result })
          })
          .catch((error: unknown) => {
            post({
              iris: token,
              type: 'slash:error',
              id: message.id,
              message: error instanceof Error ? error.message : String(error),
            })
          })
        return
      case 'error':
        host.onError(message.message, message.member, message.scriptId)
        return
      case 'blocked':
        host.onBlocked(message.host, message.directive)
        return
      case 'note':
        host.onNote?.(message.message)
        return
      case 'fetch':
        void host
          .fetch(message.url)
          .then(content => {
            post({ iris: token, type: 'fetch:ok', id: message.id, content })
          })
          .catch((error: unknown) => {
            post({
              iris: token,
              type: 'fetch:error',
              id: message.id,
              message: error instanceof Error ? error.message : String(error),
            })
          })
        return
      case 'ran':
        host.onRan?.(message.scriptId, message.lateMs)
        return
      case 'globals':
        host.onGlobals?.(message.published, message.refused)
        return
      default:
        return
    }
  }

  const onResize = (): void => {
    const size = host.viewport()
    post({ iris: token, type: 'viewport', width: size.width, height: size.height })
  }

  window.addEventListener('message', onMessage)
  window.addEventListener('resize', onResize)

  return {
    element: frame,
    emit: (event, args) => {
      if (disposed) return
      post({ iris: token, type: 'event', event, args })
    },
    refreshContext: next => {
      if (disposed) return
      /*
       * Recorded even when the frame cannot be told yet. `ready` sends
       * `current`, so an update that lands mid-boot is not lost — it simply
       * becomes the snapshot the card starts from.
       */
      current = next
      if (!ready) return
      post({ iris: token, type: 'context', context: current })
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      window.removeEventListener('message', onMessage)
      window.removeEventListener('resize', onResize)
      // The frame goes last: removing it tears down the card's realm, and doing
      // that while still listening would leave a window for a final message from
      // a card that is already gone.
      frame.remove()
    },
  }
}
