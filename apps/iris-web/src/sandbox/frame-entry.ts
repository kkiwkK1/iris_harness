/**
 * The bootstrap, as it exists inside a card's frame.
 *
 * This file is the second build entry (`vite.sandbox.config.ts`) and is emitted
 * as a **classic IIFE**, not a module. Two reasons, both about the frame being
 * cross-origin: a module script from an opaque origin is CORS-checked and a
 * classic one is not, and the host inlines this text into `srcdoc` anyway, where
 * there is no module graph to load from.
 *
 * It does nothing but adapt the real frame realm to `FrameEnv` and hand it to
 * `installSandbox`. Every decision about what a card may touch lives there,
 * where it is injected and therefore testable; keeping this file free of policy
 * is what stops the untestable part from growing.
 *
 * @module iris-web/sandbox/frame-entry
 */

import { installSandbox } from './frame.ts'
import { parseToFrame, type FromFrame } from './protocol.ts'

/** The token the host stamped into this frame's markup. */
function token(): string {
  const element = document.querySelector('meta[name="iris-token"]')
  const value = element?.getAttribute('content')
  if (value === null || value === undefined || value === '') {
    throw new Error('iris sandbox: the frame was built without a run token')
  }
  return value
}

/**
 * Report the content height to the shell, so it can size the frame.
 *
 * `ResizeObserver` on the body rather than a poll: card UI changes height when
 * the card decides to, not on a schedule, and a poll would either lag or burn a
 * frame budget inside every card on the page.
 */
function reportHeight(run: string, post: (message: FromFrame) => void): void {
  const send = (): void => {
    post({ iris: run, type: 'height', pixels: document.documentElement.scrollHeight })
  }
  new ResizeObserver(send).observe(document.body)
  send()
}

const run = token()
const post = (message: FromFrame): void => {
  // The shell's origin cannot be named: this frame has an opaque origin, so the
  // only usable target is `'*'`. That is safe in this direction because nothing
  // secret travels it — everything here either came from the shell already or is
  // the card's own output. The token is what lets the shell tell frames apart.
  window.parent.postMessage(message, '*')
}

const listeners: ((message: ReturnType<typeof parseToFrame>) => void)[] = []
window.addEventListener('message', event => {
  const message = parseToFrame(run, event.data)
  if (message === undefined) return
  for (const listener of listeners) listener(message)
})

installSandbox({
  token: run,
  container: document.body,
  factory: {
    createElement: tagName => document.createElement(tagName),
    createTextNode: data => document.createTextNode(data),
    createDocumentFragment: () => document.createDocumentFragment(),
  },
  realWindow: window,
  post,
  onMessage: listener => {
    listeners.push(message => {
      if (message !== undefined) listener(message)
    })
  },
  /**
   * Card bodies are scripts, not modules, so a function wrapper is the right
   * shape: it gives the shadowed names their scope and leaves `eval()` inside
   * webpack output working, which CSP could not have allowed away anyway.
   */
  evaluate: (source, names, values) => {
    // eslint-disable-next-line no-new-func
    const compiled = new Function(...names, source) as (...args: unknown[]) => void
    compiled(...values)
  },
})

reportHeight(run, post)
