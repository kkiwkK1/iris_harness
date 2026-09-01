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
 * **What it does not yet protect against.** Iris's reading view is not windowed
 * — `ChatPane.tsx` maps every message — so on a long conversation every floor is
 * mounted and the anchor holds nothing back. `render-window.ts` is the interim
 * limit until the view is windowed, which is a separate project on purpose: a
 * rewrite of the reading view does not belong inside the first cut of this
 * pipeline.
 *
 * @module iris-web/app/useMessageInterfaces
 */
import { useEffect, useRef, useState } from 'react'

import { claimFrontendBlocks } from '../sandbox/frontend-blocks.ts'
import {
  runMessageInterfaces,
  type InterfaceState,
  type MessageFramesEnv,
} from '../sandbox/message-frames.ts'

/** What the hook needs to build frames for one message. */
export interface MessageInterfacesInput {
  /** The floor this message is. */
  floor: number
  /** Its text, **after** display regex — see `RENDER.md` on ordering. */
  text: string
  /** Whether this floor is inside the render window. */
  allowed: boolean
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
   */
  watchContext: (push: (context: unknown) => void) => () => void
}

/**
 * Run the interfaces belonging to one displayed message.
 *
 * @param input - the message and how to build frames for it.
 * @returns the interfaces' states, for the row to render.
 */
export function useMessageInterfaces(input: MessageInterfacesInput): readonly InterfaceState[] {
  const [states, setStates] = useState<readonly InterfaceState[]>([])

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

  useEffect(() => {
    if (!input.allowed) {
      setStates([])
      return undefined
    }

    const blocks = claimFrontendBlocks(input.text)
    if (blocks.length === 0) {
      setStates([])
      return undefined
    }

    const running = runMessageInterfaces(blocks, input.floor, {
      start: (...args) => callbacks.current.start(...args),
      attach: (...args) => {
        callbacks.current.attach(...args)
      },
      onState: next => setStates(next),
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
    const unwatch = callbacks.current.watchContext(context => {
      running.refresh(context)
    })

    return () => {
      unwatch()
      running.dispose()
      /*
       * Cleared here as well as in the controller, because this is the half a
       * reader sees. A row left showing `live` for a frame that has been torn
       * down is the stale-evidence problem the report list's generations exist
       * to prevent, one surface over.
       */
      setStates([])
    }
    /*
     * `input.text` is a dependency on purpose: an edited or swiped message is a
     * different interface, so its frame is rebuilt rather than updated. Upstream
     * destroys and rebuilds on the same events, and carrying a frame across a
     * swipe would show one swipe's panel over another's content.
     */
  }, [input.floor, input.text, input.allowed])

  return states
}
