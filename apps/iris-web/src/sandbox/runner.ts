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
import type { PopupAnswer, PopupPlan } from './popup.ts'
import { mintToken, parseFromFrame, type FromFrame, type ToFrame } from './protocol.ts'
import { sameOriginTarget } from './same-origin.ts'
import { bridgeVerdict, describeBridgeRefusal } from './bridge-paths.ts'
import { buildSrcdoc } from './srcdoc.ts'
import { rewriteViewportUnits } from './viewport-units.ts'
import { rewriteBundleImports } from './bundle-proxy.ts'
import {
  DEFAULT_SANDBOX_PLUGIN_RUNTIME,
  fenceFrameParams,
  type SandboxPluginRuntime,
} from '@iris/plugin-web-api'

/**
 * One popup a card raised, and the one way back to it.
 *
 * `answer` may be called **more than once** for a single request: upstream's
 * custom button declared without a `result` fires its action and leaves the
 * dialog open ([ST] `popup.js:69`), which is an answer with `closed: false`.
 * Every call after a `closed: true` one is ignored by the frame, which has
 * already resolved the card's promise and forgotten the id.
 */
export interface PopupRequest {
  /** The frame's own handle for this popup. */
  id: string
  /** What to draw, already reduced to upstream's semantics by `sandbox/popup.ts`. */
  plan: PopupPlan
  /** Report what the reader did. */
  answer: (answer: PopupAnswer) => void
}

/** What one running card needs from the shell. */
export interface RunnerHost {
  /** Plugin capabilities and revision captured when this frame incarnation starts. */
  systemPlugins?: SandboxPluginRuntime
  /**
   * This build's bootstrap artifact, as a URL the frame will load.
   *
   * A URL rather than the source: since 2026-09-10 the frame fetches it with a
   * blocking classic `<script src>` instead of carrying 53 KB of inlined text
   * (§91). The name says `Url` because the field's *type* did not change and its
   * meaning did — a caller still passing source would build a frame whose
   * bootstrap tag points at a program, and the frame would report the absence by
   * name rather than behave strangely, but the rename is what stops the mistake
   * being made in the first place.
   */
  bootstrapUrl: string
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
  /**
   * The card-facing member table's URL.
   *
   * Both frame kinds need it: a script frame runs card bodies against it, and an
   * interface frame's markup reaches the same members. Optional only so a caller
   * mid-migration still builds a frame — one without it comes up and refuses to
   * run anything, by name.
   */
  members?: string
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
  /**
   * The floor this frame renders, when it is a message frame.
   *
   * This is what `getCurrentMessageId()` answers — upstream's "index in the
   * chat", which a status console uses to name the floor whose MVU layer it
   * writes. Absent for a script frame, where upstream throws and the member
   * keeps throwing.
   */
  currentMessageId?: number
  /** The host page's viewport, read on demand. */
  viewport: () => { width: number, height: number }
  /** Fetch a remote dependency through the host, which enforces the allowlist. */
  fetch: (url: string, pluginRevision: number) => Promise<string>
  /** A card wrote its extension settings; persist them. */
  onSettings: (settings: Record<string, unknown>, pluginRevision: number) => void
  /**
   * The card invoked a slash command, raw and unparsed.
   *
   * Required rather than optional, on the same reasoning as `onBlocked`: a card
   * that asked the application to send a message and was silently ignored is
   * indistinguishable, from the reader's side, from a card that is broken.
   */
  onSlash: (command: string, pluginRevision: number) => Promise<string>
  /**
   * The card showed one of the blocking dialogs (`alert`/`confirm`/`prompt`).
   *
   * The frame's sandbox never carries `allow-modals`, so the browser itself
   * would answer all three with silence — and a card that reports its own
   * failure through `alert` would report nothing, leaving the reader with a
   * control that "does nothing". The shell puts the text where failures are
   * read: the notice bar and the card's durable report list.
   */
  onDialog: (kind: 'alert' | 'confirm' | 'prompt', text: string) => void
  /**
   * The card raised one of SillyTavern's own popups and is waiting for an answer.
   *
   * **Required, and for a stronger reason than `onDialog`'s.** A card awaiting
   * `callGenericPopup` is stopped: MagVarUpdate's cleanup does not merely lose a
   * message, it never reaches its sweep. A host with nowhere to draw the dialog
   * would leave the promise pending forever, which is the one failure this
   * bridge cannot report on the card's behalf — so the host has to say what it
   * does about it, even if what it does is answer `CANCELLED` at once.
   *
   * The dialog is the **shell's** to draw. A card frame is clipped to its
   * message's height, so a modal drawn inside one is invisible.
   */
  onPopup: (request: PopupRequest) => void
  /**
   * The card closed its own popup — `popup.complete()` and friends.
   *
   * Required rather than optional, because the failure of omitting it is a modal
   * left on screen that nothing is waiting for: the reader is stuck behind a
   * dialog whose every answer goes nowhere.
   */
  onPopupWithdrawn: (id: string) => void
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
  onBlocked: (host: string, directive: string, detail?: string, covered?: string) => void
  /**
   * The clip describing which parts of this frame may catch a click.
   *
   * Only the card-scripts host implements it: its frame is the overlay surface
   * and covers the viewport, so without a clip it would swallow every click
   * meant for the shell. A message frame is laid out inside the reading column
   * and catches clicks over its own box, which is correct already.
   */
  onRegions?: (clip: string, detail?: string) => void
  /**
   * A card dispatched an event onto the page window it sees.
   *
   * Required for a frame whose card may dispatch; optional because the shell
   * hosts frames whose cards never do. The implementation fans the event out to
   * every frame of the card — this one included — so a listener registered
   * through `parent.addEventListener` in one frame hears a dispatch made in
   * another, which is the whole of what a page-wide event target means.
   */
  onWindowEvent?: (event: string, detail: unknown) => void
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
   * Applied to the element unless `sizedByHost` says the box is not the
   * runner's; reported here either way, for a caller that needs to know it
   * happened — the dev harness, whose whole job is observing the mechanism, and
   * an overlay host, for which this is the only remaining trace of it.
   */
  onHeight?: (pixels: number) => void
  /**
   * The host owns this frame's box, so height reports are diagnostics only.
   *
   * A message frame sits in document flow and its height is genuinely a
   * *measurement* of its content, so the runner applies what the frame reports.
   * An overlay frame is the opposite: the shell gives it the whole viewport and
   * decides what it catches with a clip, so its box is a decision that was
   * already made outside.
   *
   * **This flag exists because of a measured failure, not a tidiness argument.**
   * Without it, an overlay frame's `sizing` message removed the inline
   * `height:100%` the shell had set — and nothing re-supplied it, because the
   * stylesheet rule that `sizing` hands off to selects message-frame slots. The
   * element fell to an iframe's intrinsic **150px**. Everything after that was
   * downstream of one number: the card laid out against the 150px viewport it
   * now had, while the clip on file had been computed against the full 1353px
   * one, so the single button on screen sat ~570px from the only hole it could
   * be clicked through, and reading either number alone looked self-consistent.
   *
   * The two frame kinds are told apart by an explicit flag rather than by
   * "`onRegions` is present": which callbacks a host supplies is a fact about
   * what it wants to observe, and making geometry depend on it would mean a
   * host that stopped listening silently changed how its frame is sized.
   */
  sizedByHost?: boolean
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
  /**
   * Re-read the host viewport and push it, exactly as a window resize would.
   *
   * The frame's viewport is the box the shell put the frame in, and a window
   * `resize` is not the only thing that changes that box: the overlay surface
   * is laid out inside the reading column, so a layout change above it — a
   * notice appearing, a panel opening — reshapes the frame with no window event
   * at all. The shell watches the surface element and calls this when the
   * element's box moves; the dedup on the far side (`applyViewport`'s
   * changed-check) makes a no-op push cost one message and nothing more.
   *
   * A no-op once disposed, like every other door into the frame.
   */
  resize: () => void
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
  const systemPlugins = host.systemPlugins ?? DEFAULT_SANDBOX_PLUGIN_RUNTIME
  const token = mintToken()
  /*
   * The window comes from the injected document, not from the global.
   *
   * The document is a parameter so this function is not implicitly global — and
   * four uses of the ambient `window` were quietly undoing that, which is why
   * the height and clip handlers below had never been under test: there was no
   * way to deliver a message to them without a browser. They are now.
   */
  const view = document.defaultView
  if (view === null) {
    throw new Error('runCard needs a document that belongs to a window')
  }
  const frame = document.createElement('iframe')

  // Set before `srcdoc`: the sandbox attribute has to be in place when the
  // document is created, or the frame is briefly not sandboxed at all.
  frame.setAttribute('sandbox', frameSandbox(host.documentGranted))
  frame.setAttribute('title', 'Card interface')
  /*
   * **`scrolling="no"` is deliberately not set here, and it used to be.**
   *
   * It is the legacy attribute for the frame's *scrolling mode*, and a browser
   * honours it by forcing the frame's viewport to `overflow:hidden` at a level
   * the inner document's own CSS cannot override. That made a fix built inside
   * the frame — turning `overflow-y:auto` on when content exceeds the viewport —
   * incapable of ever working: the frame had been told from outside that it may
   * not scroll, so the reader's wheel had nowhere to go no matter what the
   * document said.
   *
   * Removing it does not put scrollbars on frames that fit. The injected reset
   * already sets `overflow:hidden` on `html,body` (`srcdoc.ts`, copied from
   * upstream), so a frame stays scrollbar-free by *the document's* choice —
   * which is a choice something can reverse when the content needs it. The
   * attribute made it a fact nothing could reverse.
   *
   * The two look identical on every card that fits, which is why this line
   * survived unremarked while the one case it broke was the one being debugged.
   */
  frame.style.width = '100%'
  frame.style.border = '0'
  frame.style.display = 'block'
  frame.srcdoc = buildSrcdoc(token, host.bootstrapUrl, {
    networkGranted: host.networkGranted,
    libraries: host.libraries,
    ...(host.members === undefined ? {} : { members: host.members }),
    selfOrigin: view.location.origin,
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
    systemPlugins,
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
    if (disposed) return
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

  /**
   * Answer a frame's `fetch` request.
   *
   * Two routes, split by who is being asked. A request aimed at Iris's own
   * origin — which any relative path resolves to, since a srcdoc frame inherits
   * the shell page's base — is fetched by this page with its own credentials:
   * the same-origin bridge (`docs/SANDBOX.md`), which lets an upstream-frequent
   * `fetch('/version')` answer without widening `connect-src` by a character.
   * The origin check runs **here**, not only in the frame, because the frame is
   * the untrusted side and the shell is what actually holds the credentials;
   * `host.fetch` stays the enforcement for everything else, allowlisted remote
   * dependencies included.
   *
   * And the **path** check runs here for the same reason — `bridge-paths.ts`
   * holds the list and both sides consult it. A frame that skipped its own copy
   * (or ran an older build of it) reaches a shell that has not: the audit's F11
   * is a credentialed GET, and a credentialed GET is refused by whoever holds
   * the credentials or it is not refused at all.
   * @param message - the frame's request, carrying the URL it resolved.
   * @returns the body and the response facts worth carrying back.
   */
  /**
   * Bridge path shapes this frame has already been refused.
   *
   * Per frame, not per module: two conversations open on the same card are two
   * frames, and a reader looking at one of them has not seen the other's report.
   */
  const refusedShapes = new Set<string>()

  const ride = (
    message: Extract<FromFrame, { type: 'fetch' }>,
  ): Promise<{ content: string, status?: number, contentType?: string }> => {
    const target = sameOriginTarget(message.url, view.location.href, view.location.origin)
    if (target === undefined) {
      return host.fetch(message.url, systemPlugins.revision).then(content => ({ content }))
    }
    const verdict = bridgeVerdict(target, host.context.characterId)
    if (!verdict.allowed) {
      /*
       * Rejected, which the caller already turns into the `fetch:error` the
       * frame has always understood — not a new message type and not a new
       * error kind. The card's `fetch` rejects the way a refused request
       * rejects, and the sentence names this layer rather than the frame's.
       *
       * Reported once per shape through the note channel a frame's own reports
       * use, so a card sweeping a list leaves one line rather than a screenful.
       */
      const note = describeBridgeRefusal(verdict.shape, 'shell')
      if (!refusedShapes.has(verdict.shape)) {
        refusedShapes.add(verdict.shape)
        host.onNote?.(note)
      }
      return Promise.reject(new Error(note))
    }
    return view.fetch(target).then(async response => {
      const contentType = response.headers.get('content-type')
      return {
        content: await response.text(),
        status: response.status,
        ...(contentType === null || contentType === '' ? {} : { contentType }),
      }
    })
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
        // The floor rides with the snapshot: both are "which message is this"
        // facts, and a message frame needs its own before any card code runs.
        post({
          iris: token,
          type: 'context',
          context: current,
          ...host.currentMessageId === undefined ? {} : { floor: host.currentMessageId },
        })
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
        if (Number.isFinite(message.pixels) && message.pixels > 0 && host.sizedByHost !== true) {
          frame.style.height = `${message.pixels}px`
          /*
           * The frame is being sized by a measurement again, so the mark that
           * says it cannot be measured has to go.
           *
           * It changes no behaviour — an inline height beats the stylesheet rule
           * the mark selects — and that is exactly why it is worth removing. A
           * mark left on the element is a **claim about the element**, and this
           * one had become false: `data-iris-sizing="viewport"` beside a frame
           * whose height came from `body.scrollHeight` reads as evidence for a
           * model that is no longer true. It cost a debugging round to a reader
           * who trusted it — the reader was me.
           */
          delete frame.dataset['irisSizing']
        }
        host.onHeight?.(message.pixels)
        return
      case 'sizing':
        /*
         * The card sizes itself to whatever viewport it is given, so there is no
         * content height to follow. Handed to CSS rather than answered with a
         * number here: how tall a full-screen card should be is a design
         * decision, and it belongs where the other spatial decisions are.
         *
         * **The inline height is removed**, not overwritten. It is whatever the
         * frame reported before it noticed it could not be measured — the
         * height the loop would have frozen at — and leaving it would beat the
         * stylesheet rule that is now meant to decide.
         */
        /*
         * Not for a frame whose box the host owns. Removing the height there
         * hands sizing to a stylesheet rule that does not select this element,
         * so the frame collapses to its intrinsic 150px — see `sizedByHost`.
         */
        if (host.sizedByHost !== true) {
          frame.dataset['irisSizing'] = message.mode
          frame.style.removeProperty('height')
        }
        return
      case 'settings':
        host.onSettings(message.settings, systemPlugins.revision)
        return
      case 'call':
        void host
          .onCall(message.method, fenceFrameParams(message.params, systemPlugins.revision))
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
          .onSlash(message.command, systemPlugins.revision)
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
      case 'dialog':
        /*
         * Required, not optional: the whole reason the bridge exists is that a
         * card's `alert` used to land in a browser no-op bucket, and a host
         * without a panel would rebuild exactly that silence one message type
         * later.
         */
        host.onDialog(message.kind, message.text)
        return
      case 'popup': {
        /*
         * The id is the frame's; the answer is posted straight back on it. No
         * bookkeeping here on purpose — this file is the untestable one, so the
         * only state it may own is what a `postMessage` needs, and "which popup
         * is on screen" is the shell's question.
         */
        const id = message.id
        host.onPopup({
          id,
          plan: message.plan,
          answer: answer => {
            post({
              iris: token,
              type: 'popup:answer',
              id,
              closed: answer.closed,
              result: answer.result,
              ...(answer.button === undefined ? {} : { button: answer.button }),
              ...(answer.input === undefined ? {} : { input: answer.input }),
            })
          },
        })
        return
      }
      case 'popup:done':
        host.onPopupWithdrawn(message.id)
        return
      case 'error':
        host.onError(message.message, message.member, message.scriptId)
        return
      case 'regions':
        /*
         * Optional, because a message frame has no overlay surface to clip and
         * a host that does not implement this should not have to say so. The
         * frame posts it either way — it does not know which kind of host it is
         * attached to, and a frame that decided would be a frame with a second
         * copy of that fact.
         */
        host.onRegions?.(message.clip, message.detail)
        return
      case 'winevent':
        host.onWindowEvent?.(message.event, message.detail)
        return
      case 'blocked':
        host.onBlocked(message.host, message.directive, message.detail, message.covered)
        return
      case 'note':
        host.onNote?.(message.message)
        return
      case 'fetch':
        void ride(message)
          .then(result => {
            post({
              iris: token,
              type: 'fetch:ok',
              id: message.id,
              content: result.content,
              ...(result.status === undefined ? {} : { status: result.status }),
              ...(result.contentType === undefined ? {} : { contentType: result.contentType }),
            })
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

  /*
   * A tab returning to the foreground is re-told its viewport.
   *
   * **Why a `resize` listener is not enough.** A backgrounded tab is throttled:
   * the window can be resized — or the OS can change the display — while no
   * frame is being produced, and what the frame is holding then is a viewport
   * that stopped being true at a moment nothing observed. It is also the moment
   * a reader is looking: they came back to this tab.
   *
   * Only on the way *in*. Going hidden changes nothing about the geometry, and
   * pushing then would spend a message to tell a throttled frame something it
   * cannot act on.
   */
  const onVisible = (): void => {
    if (disposed || document.hidden) return
    onResize()
  }

  view.addEventListener('message', onMessage)
  view.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisible)

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
      post({
        iris: token,
        type: 'context',
        context: current,
        ...host.currentMessageId === undefined ? {} : { floor: host.currentMessageId },
      })
    },
    resize: () => {
      if (disposed) return
      onResize()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      view.removeEventListener('message', onMessage)
      view.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisible)
      // The frame goes last: removing it tears down the card's realm, and doing
      // that while still listening would leave a window for a final message from
      // a card that is already gone.
      frame.remove()
    },
  }
}
