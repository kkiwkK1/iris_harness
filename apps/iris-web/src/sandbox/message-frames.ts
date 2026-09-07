/**
 * One sandboxed frame per card interface found in a message.
 *
 * Step two of the pipeline. The predicate (`frontend-blocks.ts`) decides *which*
 * blocks are claimed; this puts each claimed block into a frame and reports what
 * happened to it.
 *
 * ## Reusing the script-frame machinery rather than paralleling it
 *
 * The frame itself is `runCard` — the same builder, the same CSP, the same
 * channel, the same virtual `parent`, the same per-card grants. A message frame
 * is **another frame of the same card**, not a new trust domain, so anything
 * that looked like a second implementation would be a second place for the wall
 * to be wrong.
 *
 * Three things do differ, and each is a fact about *when card code runs* rather
 * than a preference:
 *
 * 1. **The body is markup, not script.** A script body can be handed over a
 *    channel because it is code; markup only runs by being parsed, so it goes
 *    into the document. `scripts` is therefore empty and no `run` message is
 *    ever sent — the interface's own `<script>` tags execute themselves.
 * 2. **The snapshot is inlined.** Because the markup runs during parsing and
 *    reads its variables immediately, the pushed `context` cannot arrive in
 *    time; see `srcdoc.ts`. The pushed channel still carries updates.
 * 3. **Libraries are the message preset.** Upstream injects eight into a message
 *    frame against two into a script frame, so this is a different bundle.
 * 4. **The message's own `<style>` comes with it.** A floor is one DOM upstream
 *    and one frame per region here, so the sheet is copied into each of them
 *    (`runMessageInterfaces`); a script frame has no message to belong to and
 *    gets none.
 *
 * ## What is instrumented, and why these three
 *
 * Every discriminator here was paid for by a silent failure in the script-frame
 * work, and each catches something the others cannot see:
 *
 * - `attach` is part of the contract, because `runCard` builds an iframe and
 *   does not insert it. An un-inserted iframe never loads, so the bootstrap
 *   never parses and the frame never says anything — the quietest failure this
 *   project has produced.
 * - `isConnected` is checked *after* attaching, because requiring an `attach`
 *   makes a caller supply one and does not make theirs work. A no-op satisfies
 *   the compiler and reproduces the original failure exactly.
 * - A frame that never reports `ready` is reported, because "still starting" is
 *   not a state anything may rest in forever.
 *
 * @module iris-web/sandbox/message-frames
 */
import type { FrontendBlock } from './frontend-blocks.ts'
import { withMessageCss } from './srcdoc.ts'
import type { Language } from '../app/i18n/strings.ts'
import { translate } from '../app/i18n/strings.ts'


/** Where one interface has got to. */
export type InterfacePhase =
  /** Claimed, no frame yet. */
  | 'claimed'
  /** The frame answered `ready`; the channel to it is up. */
  | 'live'
  /** The frame never became ready. */
  | 'never-started'
  /** Torn down because its message stopped being displayed. */
  | 'closed'
  /**
   * Claimed and deliberately not built: the reading view's frame budget is
   * spent.
   *
   * A distinct phase rather than a `never-started` with a reason, because the
   * two are opposite kinds of answer. `never-started` is a failure — something
   * was meant to happen and did not. This is a **decision**, it is reversible
   * on the spot, and the reader can undo it. Folding a policy into a failure
   * bucket is how "we chose not to" comes to read as "it broke".
   */
  | 'over-budget'

/** Encoder reused across calls; one per block is measurable on a long chat. */
const encoder = new TextEncoder()

/**
 * How many bytes a piece of markup is, as the browser will inline it.
 *
 * One definition on purpose, shared with the frame budget: the number a reader
 * sees under an interface and the number the budget spends have to be the same
 * quantity, or the panel explains a decision it does not describe.
 *
 * `String.length` is the wrong measure here and wrong in the direction that
 * matters: it counts UTF-16 code units, and this corpus is Chinese, so it
 * reports roughly a third of the bytes actually paid.
 * @param markup - the block body.
 * @returns the encoded length in bytes.
 */
export function encodedBytes(markup: string): number {
  return encoder.encode(markup).length
}

/** One interface's state, as a reader sees it. */
export interface InterfaceState {
  /** Which floor the interface belongs to. */
  floor: number
  /**
   * Which interface of that floor, as an opaque identity.
   *
   * Deliberately not "the Nth interface". Upstream's own id carries a number
   * whose meaning differs between its two render paths — element index in one,
   * chunk index in the other — and upstream never parses it either, taking only
   * the floor. Anything deriving meaning from this would be reading a number
   * that changes for reasons unrelated to the interface.
   */
  instance: number
  phase: InterfacePhase
  /** Why, for `never-started`. */
  detail?: string
  /** How big the markup was, which is the frame's construction cost. */
  bytes: number
}

/** One running frame, as this controller needs to see it. */
export interface StartedInterface {
  element: { isConnected?: unknown }
  /**
   * Hand this frame a newer snapshot.
   *
   * Typed as `unknown` rather than as `ScriptContext` for the same reason the
   * element is structural: this controller is tested without a DOM and without
   * the protocol, and it never looks inside a snapshot — it only forwards one.
   */
  refreshContext: (context: unknown) => void
  /**
   * Deliver one host event into the frame's bus.
   *
   * An interface is a status panel that redraws when the variables it draws
   * change, and the corpus's panels redraw on `eventOn(Mvu.events.
   * VARIABLE_UPDATE_ENDED, …)` — a name the shell must speak into this frame,
   * because the MVU bundle that would emit it upstream sits in the *script*
   * frame and its bus is this frame's neither. Typed loosely for the same
   * reason `refreshContext` is: this controller forwards, it does not interpret.
   */
  emit: (event: string, args: readonly unknown[]) => void
  dispose: () => void
}

/** What this controller needs from the world. */
export interface MessageFramesEnv {
  /**
   * Build and start one frame for a block's markup.
   *
   * Injected rather than called directly, following `card-scripts.ts`. The
   * reason is not only testability: it keeps every reference to `runCard`,
   * `window` and the srcdoc in **one** place — the caller — so this file cannot
   * grow a second, quieter opinion about how a frame is constructed. A message
   * frame is another frame of the same card, and the way to keep that true is to
   * not have a second constructor.
   */
  start: (input: {
    markup: string
    floor: number
    instance: number
    onReady: () => void
    /**
     * The frame's bootstrap died before it could speak.
     *
     * A bootstrap that throws reports `bootstrap-error` and then has nothing
     * left to be ready **with** — so without this, the only answer the
     * controller could give was the timeout's generic guess, eight seconds of
     * silence after the real reason had already arrived and been dropped. The
     * message is the frame's own words for what killed it; it becomes the
     * `never-started` detail verbatim.
     */
    onBootstrapError: (message: string) => void
    /**
     * The frame laid out real content for the first time. Once per frame; see
     * `MessageFramesEnv.onPainted` for why this and not `ready`.
     */
    onPainted: () => void
  }) => StartedInterface
  /**
   * Put the frame into the document.
   *
   * In the contract rather than left to a convention, because the convention was
   * the bug: `runCard` returns an iframe and every existing caller happened to
   * append it, so nothing failed until one did not.
   */
  attach: (frame: { element: { isConnected?: unknown }, floor: number, instance: number }) => void
  onState: (states: readonly InterfaceState[]) => void
  /**
   * One frame has laid out real content for the first time.
   *
   * The frame's own height report is the signal: it posts only once
   * `body.scrollHeight` is a positive number, which is the first moment there
   * is something on screen to look at. `ready` cannot play this role — an
   * interface frame announces ready when its bootstrap is done, and its markup
   * parses **after** that (the libraries sit between them) — so a caller that
   * reveals frames at ready reveals a white rectangle. Optional, because the
   * only present consumer is the reading view's swap, and a caller that does
   * not care should not have to wire a no-op.
   * @param instance - the instance whose frame laid out.
   */
  onPainted?: (instance: number) => void
  /** How long a frame may take to become ready before silence is a finding. */
  readyTimeoutMs?: number
  /**
   * Whether this instance may build a frame at all.
   *
   * Supplied by the reading view's frame budget. Absent means every claimed
   * block builds — which is what the tests and any caller without a budget
   * want, and it keeps the budget out of this file: the controller asks, it does
   * not decide.
   * @param instance - the block's index within its message.
   * @returns whether to build.
   */
  allow?: (instance: number) => boolean
}

/** A running set of interfaces for one message. */
export interface RunningInterfaces {
  /**
   * Push a newer snapshot into every frame of this message.
   *
   * Interfaces need this for a different reason than card scripts do. A script
   * frame goes stale because MVU reads the floor that just arrived; an
   * interface goes stale because it **is** a status panel — it draws the
   * variables, and a variable written by a later floor leaves the panel
   * displaying numbers that were true a turn ago. Both look like a working
   * card showing wrong data, which is worse than a card that visibly fails.
   *
   * Not a rebuild. The frame keeps running and is handed new data, because
   * rebuilding is what this pipeline already does on an edit or a swipe and it
   * costs a full reparse of the block — 360 KiB on the sample card, and the
   * panel’s own drawn state with it.
   */
  refresh: (context: unknown) => void
  /**
   * Deliver one host event into every frame of this message.
   *
   * The counterpart of `refresh`: the snapshot keeps the panel's *data* current,
   * and the event tells the panel that now is the time to re-read it. Upstream's
   * message frames hear card-ecosystem events through the page's shared event
   * source; here each frame has its own bus, so the shell is the speaker.
   */
  emit: (event: string, args: readonly unknown[]) => void
  dispose: () => void
}

/**
 * Put every claimed block of one message into its own frame.
 *
 * **The message's own sheet goes into every region frame.** One frame per
 * region means the frames cannot see each other, so a rule in one of them
 * cannot reach a `<details>` in the next — which is exactly how 爱衣's variable
 * panel came out as an empty 812px frame beside a collapsed one. Upstream needs
 * no copying because a floor is one DOM; here the copy *is* the message-wide
 * scope. Only the bare-HTML regions get it: a fenced block is upstream's own
 * iframe, and its message sheet does not reach inside one either.
 *
 * @param blocks - the claimed blocks, from `claimFrontendBlocks`.
 * @param floor - which message these belong to.
 * @param env - the world.
 * @param messageCss - the message's confined sheet, from
 *   `claimMessageSurfaces`. Absent or empty for a message that wrote no
 *   `<style>` of its own, which is the common case and costs nothing.
 * @returns a handle that tears the whole set down.
 */
export function runMessageInterfaces(
  blocks: readonly FrontendBlock[],
  floor: number,
  env: MessageFramesEnv,
  messageCss = '',
): RunningInterfaces {
  const states = new Map<number, InterfaceState>()
  const running: StartedInterface[] = []
  const timers: ReturnType<typeof setTimeout>[] = []
  let disposed = false

  const publish = (): void => {
    if (disposed) return
    env.onState([...states.values()])
  }

  const move = (instance: number, next: Partial<InterfaceState>): void => {
    if (disposed) return
    const current = states.get(instance)
    if (current === undefined) return
    states.set(instance, { ...current, ...next })
    publish()
  }

  blocks.forEach((block, instance) => {
    states.set(instance, {
      floor,
      instance,
      phase: 'claimed',
      bytes: encodedBytes(block.body),
    })
  })
  publish()

  blocks.forEach((block, instance) => {
    if (disposed) return

    /*
     * Refused before construction, and the instance number is kept.
     *
     * Not by filtering the list: `instance` is this block's index, and it is
     * also what `splitAroundInterfaces` uses to decide which slot an interface
     * belongs in. A filtered list renumbers, and every interface after a refused
     * one would render into its neighbour's slot — a fault with no error
     * attached to it, just interfaces one place out of position.
     */
    if (env.allow !== undefined && !env.allow(instance)) {
      move(instance, { phase: 'over-budget' })
      return
    }

    const painted = new Set<number>()
    /*
     * The sheet rides with the markup and is lifted into the frame's head by
     * `buildSrcdoc` — see `MESSAGE_CSS_MARK` for why that is the transport. The
     * bytes are counted **without** it (`states` above), because the number
     * under an interface answers "how big is this card's block" and the budget
     * spends the same quantity; a couple of kilobytes of the message's own CSS
     * charged to every region of it would be this shell's weight, reported as
     * the card's.
     */
    const started = env.start({
      markup: block.kind === 'bare-html' ? withMessageCss(block.body, messageCss) : block.body,
      floor,
      instance,
      onReady: () => move(instance, { phase: 'live' }),
      onBootstrapError: message => move(instance, { phase: 'never-started', detail: message }),
      onPainted: () => {
        // Once per frame: a card that relayouts keeps posting heights, and the
        // swap cares only about the first.
        if (painted.has(instance) || env.onPainted === undefined) return
        painted.add(instance)
        env.onPainted(instance)
      },
    })
    running.push(started)

    env.attach({ element: started.element, floor, instance })

    /*
     * The DOM answering whether the attach happened, which is a source
     * independent of the code that claimed to do it.
     */
    if (started.element.isConnected === false) {
      move(instance, {
        phase: 'never-started',
        detail: 'the frame was never put into the document, so it will never load',
      })
      return
    }

    const timer = setTimeout(() => {
      const current = states.get(instance)
      if (current === undefined || current.phase !== 'claimed') return
      move(instance, {
        phase: 'never-started',
        detail: 'the frame never reported ready — its bootstrap did not run, or it was torn down',
      })
    }, env.readyTimeoutMs ?? 8_000)
    timers.push(timer)
  })

  return {
    refresh: context => {
      if (disposed) return
      for (const card of running) card.refreshContext(context)
    },

    emit: (event, args) => {
      if (disposed) return
      for (const card of running) card.emit(event, args)
    },

    dispose: () => {
      disposed = true
      for (const timer of timers) clearTimeout(timer)
      for (const card of running) card.dispose()
      /*
       * States are dropped rather than marked `closed` and kept. A message that
       * scrolled out of view has no interfaces, and leaving their last state
       * behind would let a reader take a stale row for a live one — the same
       * mistake the report list's generations exist to prevent.
       */
      states.clear()
    },
  }
}

/**
 * One line for a reader, per interface.
 *
 * English by default so `node --test` reads the source language; the slot
 * passes the interface language through. The `never-started` detail is quoted
 * evidence from the frame and is not rewritten.
 * @param state - the interface's state.
 * @param lang - the language for the sentence.
 * @returns the sentence to show.
 */
export function describeInterface(state: InterfaceState, lang: Language = 'en'): string {
  switch (state.phase) {
    case 'claimed':
      return translate(lang, 'ifaceStarting')
    case 'live':
      // Deliberately not "rendered". The frame's markup parsed; whether the card
      // drew anything is its own business and not observable from here.
      return translate(lang, 'ifaceLive', { kb: Math.round(state.bytes / 1024) })
    case 'never-started':
      return state.detail === undefined
        ? translate(lang, 'ifaceNeverStartedNoReason')
        : translate(lang, 'ifaceNeverStarted', { detail: state.detail })
    case 'closed':
      return translate(lang, 'ifaceClosed')
    case 'over-budget':
      /*
       * Three things, because a placeholder that says fewer is worse than none.
       * [notes/apps/iris-web/WINDOWING.md §五之二] on this corpus a placeholder is what a reader
       * scrolling back sees **most** of the time — more often than a live panel
       * — so this string is a main surface of the feature, not an error caption.
       *
       * 1. there **is** an interface here (not: nothing was written);
       * 2. **why** it did not render (a budget, not a fault);
       * 3. **what to do** — and the button beside this line is the answer, which
       *    is why this text does not end in an apology.
       */
      return translate(lang, 'ifaceOverBudget', { kb: Math.round(state.bytes / 1024) })
  }
}
