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
 * `ResizeObserver` on the body rather than a poll — the same source upstream
 * observes. Card UI changes height when the card decides to, not on a schedule.
 *
 * **A known divergence from upstream lives here.** Tavern Helper's injected
 * script writes the parent's `frameElement.style.height` directly from inside the
 * child. That requires same-origin, and Iris's frames are deliberately
 * cross-origin, so the height has to travel as a message and be applied by the
 * shell. Semantically equivalent, one frame later. Nothing can remove that frame
 * without giving up the isolation, so it is a cost, not a bug to fix.
 *
 * Coalesced through `requestAnimationFrame`, with upstream's 500ms throttle as
 * the fallback where rAF is unavailable: an observer callback per layout pass,
 * each posting a message across a frame boundary, is a real cost inside every
 * card on the page.
 */
function reportHeight(run: string, post: (message: FromFrame) => void): void {
  let scheduled = false
  const send = (): void => {
    scheduled = false
    post({ iris: run, type: 'height', pixels: document.documentElement.scrollHeight })
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(send)
    else setTimeout(send, 500)
  }

  new ResizeObserver(schedule).observe(document.body)
  send()
}

/**
 * Publish the viewport height as the custom property card CSS reads.
 *
 * `--TH-viewport-height` is upstream's name and is kept verbatim: card stylesheets
 * reference it by that spelling, and a compatibility layer that renames what it
 * is compatible with is not one.
 * @param size - the host viewport as the shell reported it.
 */
function applyViewport(size: { width: number, height: number }): void {
  document.documentElement.style.setProperty('--TH-viewport-height', `${size.height}px`)
}

/**
 * Report what the frame's own policy refused.
 *
 * The browser fires `securitypolicyviolation` in the document whose policy
 * blocked the request, which is this one — so the frame is the only place that
 * can see it, and the shell is the only place that can tell the user. Without
 * this hop the refusal is silent, and a silent refusal is indistinguishable from
 * a bug in whatever the card does next.
 * @param run - the run token.
 * @param post - the channel to the shell.
 */
function reportBlocked(run: string, post: (message: FromFrame) => void): void {
  document.addEventListener('securitypolicyviolation', event => {
    let host = event.blockedURI
    try {
      host = new URL(event.blockedURI).host || event.blockedURI
    } catch {
      // `blockedURI` is not always a URL — `inline`, `eval` and `data` all
      // appear. Reported as they are: the shell says what was refused, and it is
      // better to name something unparseable than to drop it.
    }
    post({ iris: run, type: 'blocked', host, directive: event.effectiveDirective })
  })
}

/*
 * Everything below runs inside a try/catch that can report without a token.
 *
 * The blind spot this closes: a cross-origin frame's uncaught errors do not reach
 * the parent's console. So a bootstrap that threw before its first `post` looked
 * from outside exactly like a bootstrap that had never been asked to run —
 * console clean, no frames, status stuck. An observer hit precisely that and had
 * no way to tell it from a torn hot-reload.
 *
 * A failure before the token is known cannot be stamped with one, so it is sent
 * unstamped and the shell accepts it on the strength of `event.source` alone. That
 * is weaker than the token, and it is only ever believed as a diagnostic — it can
 * neither run code nor change state.
 */
function fail(error: unknown): void {
  try {
    window.parent.postMessage(
      {
        iris: '',
        type: 'bootstrap-error',
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      },
      '*',
    )
  } catch {
    // Nothing left to try. The frame is beyond reporting.
  }
}

let run: string
try {
  run = token()
} catch (error: unknown) {
  fail(error)
  throw error
}
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

try {
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
  applyViewport,
  onMessage: listener => {
    listeners.push(message => {
      if (message !== undefined) listener(message)
    })
  },
  publishGlobals: entries => {
    const published: string[] = []
    const refused: string[] = []
    for (const [name, value] of entries) {
      try {
        // `defineProperty` rather than assignment: `parent` and `top` are
        // accessors on Window, and whether they can be redefined at all is a
        // browser question this project cannot answer from outside a browser. So
        // it is attempted and the result reported, instead of the code assuming.
        Object.defineProperty(window, name, { value, writable: false, configurable: true })
        published.push(name)
      } catch {
        refused.push(name)
      }
    }
    post({ iris: run, type: 'globals', published, refused })
  },

  /**
   * Two execution shapes, chosen by the caller.
   *
   * **Module** is what card scripts get, because it is what upstream gives them:
   * `panel/script/iframe.ts` builds every script iframe with
   * `<script type="module">`, unconditionally. A module cannot be handed shadowed
   * parameters, so its bridge is the published globals above — again matching
   * upstream, whose `predefine` classic script flattens its API onto the child
   * window before the module runs.
   *
   * The body reaches the module system as a `blob:` URL, which needs no new CSP
   * allowance: `blob:` is already in `script-src` for the injected layer.
   *
   * **Classic** stays for Iris's own probe, which exercises the shadowed globals
   * a module cannot receive, and for any body that turns out to need
   * function-scope semantics. `new Function` also keeps the `unsafe-eval`
   * coverage the probe reports on.
   */
  evaluate: (source, mode, names, values) => {
    if (mode === 'classic') {
      const compiled = new Function(...names, source) as (...args: unknown[]) => void
      compiled(...values)
      return undefined
    }

    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    return import(/* @vite-ignore */ url).then(
      () => {
        URL.revokeObjectURL(url)
      },
      (error: unknown) => {
        // Revoked on both paths: a failed module still holds the blob, and a card
        // that throws on every run would otherwise leak one per attempt.
        URL.revokeObjectURL(url)
        throw error
      },
    )
  },
  })

  reportBlocked(run, post)
  reportHeight(run, post)
} catch (error: unknown) {
  // Same reasoning: an install that throws is invisible from the outside, and
  // "nothing happened" is the most expensive answer a sandbox can give.
  fail(error)
  throw error
}
