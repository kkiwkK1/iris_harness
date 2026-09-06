/**
 * Binding a message's card interfaces to the message being displayed.
 *
 * This is the lifecycle anchor, and the anchor is React's own: the effect runs
 * when a message mounts and its cleanup runs when the message unmounts, so a
 * message that leaves the conversation takes its frames with it. Nothing counts
 * references or watches scroll position — "displayed" is not tracked, it is the
 * condition the effect already lives under.
 *
 * That mirrors the card-script side exactly, where a chat's frames exist while
 * the chat is in the foreground. A message frame is another frame of the same
 * card, and this is where that sentence becomes a lifetime.
 *
 * **What bounds it.** The reading view mounts a tail of the conversation
 * (`reading-window.ts`), so the anchor now holds something back: an unmounted
 * floor has no frames because nothing built them. Weight is rationed separately
 * by `frame-budget.ts`, which is why this hook takes a per-instance gate as well
 * as a mounted/not-mounted one — a floor can be displayed and still be told
 * there is no room for its interface right now.
 *
 * @module iris-web/app/useMessageInterfaces
 */
import { useEffect, useRef, useState } from 'react'

import { claimMessageSurfaces } from '../sandbox/frontend-blocks.ts'
import {
  runMessageInterfaces,
  type InterfaceState,
  type MessageFramesEnv,
  type RunningInterfaces,
} from '../sandbox/message-frames.ts'
import { beginRetirement, type RetiringInterfaces } from './interface-swap.ts'
import { registerWindowEventSink } from './window-events.ts'

/** What the hook needs to build frames for one message. */
export interface MessageInterfacesInput {
  /** The floor this message is. */
  floor: number
  /** Its text, **after** display regex — see `notes/apps/iris-web/RENDER.md` on ordering. */
  text: string
  /**
   * Whether a frame may exist for this floor at all.
   *
   * Consent and build assets, not room: no grant, or no bootstrap yet, and
   * nothing can be built for any instance. Distinct from `refusedInstances`
   * below, which is about there being no room right now for one of them.
   */
  allowed: boolean
  /**
   * Instances the frame budget refused, which build a placeholder instead.
   *
   * Separate from `allowed`, which is about consent and build assets — whether
   * a frame *may* exist at all. This is about whether there is room for it right
   * now, and it is reversible by the reader.
   */
  refusedInstances?: ReadonlySet<number>
  /**
   * A stable signature of `refusedInstances`, used as the effect's dependency.
   *
   * The set is rebuilt on every plan, so depending on it directly would tear
   * down and rebuild every frame in the view each time any interface anywhere
   * changed state — which is the cost this layer exists to ration. The signature
   * changes only when this floor's own decisions change, and then a rebuild is
   * exactly right: an interface the reader just opened has to be built, and one
   * that lost its budget has to go.
   */
  gate?: string
  /**
   * Build one frame. Supplied by the caller so this file never touches
   * `runCard`, `window` or the srcdoc — the same seam `card-scripts.ts` uses,
   * and the reason there cannot be a second opinion about frame construction.
   */
  start: MessageFramesEnv['start']
  /** Put a frame into the message's own DOM. */
  attach: MessageFramesEnv['attach']
  /**
   * Subscribe to newer chat snapshots; returns an unsubscribe.
   *
   * Passed in for the same reason `start` is: this file must not know about
   * the store, the host, or the event names. It knows only that something out
   * there produces newer snapshots and that a running interface wants them.
   *
   * The second argument is how the caller speaks **events** into the same
   * frames the snapshots go to — one subscription, two delivery paths, so a
   * caller that wants both cannot observe them drifting apart (an event
   * arriving into a snapshot the caller never refreshed is exactly the
   * inconsistency a second subscription would eventually produce).
   */
  watchContext: (
    push: (context: unknown) => void,
    emit: (event: string, args: readonly unknown[]) => void,
  ) => () => void
}

/** How long a replacement may boot before a parked interface gives up its place. */
const RETIRE_CAP_MS = 10_000

/**
 * The frame element, as the swap styles it. `runCard` sets `display:block`
 * inline at creation, so the parked reveal restores exactly that.
 */
interface SwapElement {
  style: { display: string }
  remove(): void
}

/**
 * One parked run: muted, still on screen, waiting for its replacement.
 *
 * `pendingInstances` is re-read at adoption time because the set of instances
 * worth covering is the set with a frame on screen, known only after the run
 * has built them.
 */
interface ParkedRun {
  running: RunningInterfaces
  retirement: RetiringInterfaces
  elements: Map<number, SwapElement>
  pendingInstances(): Set<number>
  disposeNow(): void
}

/**
 * Run the interfaces belonging to one displayed message.
 *
 * @param input - the message and how to build frames for it.
 * @returns the interfaces' states, and whether a parked set is still on
 *   screen while its replacement boots.
 */
export function useMessageInterfaces(input: MessageInterfacesInput): {
  states: readonly InterfaceState[]
  swapping: boolean
} {
  const [states, setStates] = useState<readonly InterfaceState[]>([])
  const [swapping, setSwapping] = useState(false)

  /*
   * The callbacks are held in a ref so that changing them does not restart the
   * frames. Rebuilding an interface is expensive — the sample card's block is
   * 360 KiB of markup — and a parent re-render that produced a new closure
   * would otherwise tear down a working panel and rebuild it, losing whatever
   * state the card had drawn.
   */
  const callbacks = useRef({
    start: input.start,
    attach: input.attach,
    watchContext: input.watchContext,
  })
  callbacks.current = {
    start: input.start,
    attach: input.attach,
    watchContext: input.watchContext,
  }

  /*
   * The parked predecessor of the running set, and the component-alive token.
   *
   * A rebuild used to dispose the old frames the moment the text changed, which
   * made the whole boot of the replacement — members, preset, bootstrap, ready;
   * about a second on a fast machine — a blank rectangle. Now the old set is
   * **parked**: muted, still on screen, and swapped out only when the
   * replacement can take its place (or the cap runs out — a broken boot must
   * not hold a stale interface on screen forever).
   *
   * `alive` is what tells a parked set's cleanup apart from the final unmount:
   * it is flipped only by the mount effect's own cleanup, which React runs
   * exactly once, when the component leaves the tree. Whichever of the two
   * cleanups runs first disposes the parked set, so the order they run in does
   * not matter.
   */
  const alive = useRef(true)
  const parked = useRef<ParkedRun | undefined>(undefined)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      parked.current?.disposeNow()
      parked.current = undefined
    }
  }, [])

  useEffect(() => {
    // Whatever the last run parked is this run's to cover — or, when this run
    // builds nothing, to release: there is no replacement coming, and a stale
    // interface held on screen by a cap would be the bug this mechanism is, in
    // every other path, the cure for.
    const adopted = parked.current
    parked.current = undefined

    if (!input.allowed) {
      adopted?.disposeNow()
      setSwapping(false)
      setStates([])
      return undefined
    }

    /*
     * The same claim the row renders, fences and bare HTML regions both: the
     * controller and the row must not derive two different block lists from one
     * text, or the instance a slot is named by stops being the instance a frame
     * was built for.
     */
    const { blocks } = claimMessageSurfaces(input.text)
    if (blocks.length === 0) {
      adopted?.disposeNow()
      setSwapping(false)
      setStates([])
      return undefined
    }

    /*
     * Muted when this run is parked by a later one: a parked controller still
     * holds a ready-timeout that can fire and publish, and a publish from a
     * parked run would overwrite the replacement's states in the very same
     * piece of React state.
     */
    const mute = { muted: false }
    /** This run's frame elements, by instance, for the pending-swap styling. */
    const elements = new Map<number, SwapElement>()
    const adoptedPending = adopted?.pendingInstances() ?? new Set<number>()

    /** One parked instance is covered: make way and reveal its replacement. */
    const resolve = (instance: number): void => {
      if (!adoptedPending.has(instance)) return
      adoptedPending.delete(instance)
      adopted?.retirement.replaced(instance)
      adopted?.elements.get(instance)?.remove()
      adopted?.elements.delete(instance)
      const shown = elements.get(instance)
      // A refused instance has no frame of its own; its placeholder is the
      // answer, and removing the old frame is the whole swap.
      if (shown !== undefined) shown.style.display = 'block'
    }

    const drive = (next: readonly InterfaceState[]): void => {
      if (adopted === undefined) return
      for (const state of next) {
        if (!adoptedPending.has(state.instance)) continue
        if (state.phase === 'claimed') continue
        resolve(state.instance)
      }
      // Instances the replacement no longer claims: nothing will ever answer
      // for them, so they make way now rather than at the cap.
      for (const instance of [...adoptedPending]) {
        if (next.some(state => state.instance === instance)) continue
        resolve(instance)
      }
    }

    const refused = input.refusedInstances
    const running = runMessageInterfaces(blocks, input.floor, {
      ...(refused === undefined ? {} : { allow: (instance: number) => !refused.has(instance) }),
      start: (...args) => callbacks.current.start(...args),
      attach: (...args) => {
        const [frame] = args
        const element = frame.element as unknown as SwapElement
        if (adopted !== undefined && adoptedPending.has(frame.instance)) {
          /*
           * Hidden until its boot resolves: the reader is looking at the
           * parked interface, and two stacked frames would read as a glitch.
           * Revealed by `resolve`, on the first laid-out content — or dropped
           * with the parked set at the cap, where the row's own failure line
           * is what the reader gets.
           */
          element.style.display = 'none'
        }
        elements.set(frame.instance, element)
        callbacks.current.attach(frame)
      },
      onPainted: instance => {
        // The frame laid out real content — the honest reveal moment, which
        // can land before or after `ready`'s state change; whichever comes
        // first resolves the parked instance.
        resolve(instance)
      },
      onState: next => {
        if (!mute.muted) setStates(next)
        drive(next)
      },
    })

    /*
     * The chat keeps moving under a mounted interface, and an interface is a
     * status panel — it draws the variables. Without this it goes on drawing
     * the ones that were true when the message mounted: a healthy-looking
     * panel showing a turn-old number, which a reader cannot tell from a
     * current one.
     *
     * Pushed into the running frame rather than triggering a rebuild. A
     * rebuild is what an edit or a swipe does, and it costs a full reparse of
     * the block — 360 KiB on the sample card — plus whatever the panel had
     * already drawn.
     */
    const unwatch = callbacks.current.watchContext(
      context => {
        running.refresh(context)
      },
      (event, args) => {
        running.emit(event, args)
      },
    )

    /*
     * The message frames are the other half of the page window's audience. A
     * window event dispatched in the card's script frame arrives here the same
     * way a host event does, so a status bar listening through
     * `parent.addEventListener` hears what the rest of the card dispatches.
     */
    const unregisterWindowEvents = registerWindowEventSink((event, args) => {
      running.emit(event, args)
    })

    return () => {
      unwatch()
      unregisterWindowEvents()
      if (alive.current) {
        /*
         * A rebuild: park rather than dispose. The old frames stay on screen,
         * muted, until the replacement's states resolve every one of them —
         * or the cap runs out, because a broken boot must not hold a stale
         * interface on screen forever.
         */
        mute.muted = true
        const tracked = [...elements.keys()]
        const retirement = beginRetirement(
          tracked,
          () => {
            parked.current?.disposeNow()
            if (parked.current?.running === running) {
              parked.current = undefined
            }
            setSwapping(false)
          },
          RETIRE_CAP_MS,
        )
        parked.current = {
          running,
          elements,
          disposeNow: () => {
            // Idempotent: the controller guards its own disposal, and a cap
            // that fires after this has nothing left to settle.
            running.dispose()
          },
          pendingInstances: () => new Set(tracked),
          retirement,
        }
        setSwapping(true)
      } else {
        running.dispose()
      }
      /*
       * Cleared here as well as in the controller, because this is the half a
       * reader sees. A row left showing `live` for a frame that has been torn
       * down is the stale-evidence problem the report list's generations exist
       * to prevent, one surface over. The replacement's first publish is what
       * fills it back in.
       */
      setStates([])
    }
    /*
     * `input.text` is a dependency on purpose: an edited or swiped message is a
     * different interface, so its frame is rebuilt rather than updated. Upstream
     * destroys and rebuilds on the same events, and carrying a frame across a
     * swipe would show one swipe's panel over another's content. What has
     * changed is *when* the old frames leave: at the replacement's ready, not
     * at the text change — the swap, not the boot, is what the reader sees.
     */
    /*
     * `input.gate` and not `input.refusedInstances`: the set's identity changes
     * on every plan, and the signature changes only when this floor's own
     * decisions do. See the field's own note — the difference is a rebuild of
     * every frame in the view versus a rebuild of the ones that changed.
     */
  }, [input.floor, input.text, input.allowed, input.gate])

  return { states, swapping }
}
