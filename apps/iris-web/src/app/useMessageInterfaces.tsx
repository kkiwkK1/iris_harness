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
  const callbacks = useRef({ start: input.start, attach: input.attach })
  callbacks.current = { start: input.start, attach: input.attach }

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

    return () => {
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
