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

/** What one running card needs from the shell. */
export interface RunnerHost {
  /** The bootstrap source, already built. */
  bootstrap: string
  /** The card's script body. */
  code: string
  /** Whether the user granted this card the real page. */
  documentGranted: boolean
  /** The host snapshot, fetched once and pushed before the card runs. */
  context: ScriptContext
  /** The host page's viewport, read on demand. */
  viewport: () => { width: number, height: number }
  /** Fetch a remote dependency through the host, which enforces the allowlist. */
  fetch: (url: string) => Promise<string>
  /** A card wrote its extension settings; persist them. */
  onSettings: (settings: Record<string, unknown>) => void
  /** The card threw, or was refused a member. */
  onError: (message: string, member?: string) => void
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
  frame.srcdoc = buildSrcdoc(token, host.bootstrap)

  let disposed = false

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
    if (message === undefined) return
    handle(message)
  }

  const handle = (message: FromFrame): void => {
    switch (message.type) {
      case 'ready': {
        // The order that matters. Context, then viewport, then the card.
        post({ iris: token, type: 'context', context: host.context })
        const size = host.viewport()
        post({ iris: token, type: 'viewport', width: size.width, height: size.height })
        // Rewritten on the way in, which is where upstream does it too: a card
        // sized in `vh` is measuring its own frame, and a frame sized to its
        // content would collapse `100vh` to nothing.
        post({ iris: token, type: 'run', code: rewriteViewportUnits(host.code) })
        return
      }
      case 'height':
        frame.style.height = `${message.pixels}px`
        host.onHeight?.(message.pixels)
        return
      case 'settings':
        host.onSettings(message.settings)
        return
      case 'error':
        host.onError(message.message, message.member)
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
