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
import { remoteImports } from './script-source.ts'
import { parseToFrame, type FromFrame } from './protocol.ts'

/**
 * Tell the shell the frame is usable — but not before its libraries are.
 *
 * The shell answers `ready` by immediately posting the card body, so announcing
 * too early is a race the card loses: it would evaluate against a window where
 * `Vue` does not exist yet, and fail with a message naming the symptom rather
 * than the timing.
 *
 * A library that fails outright is reported here rather than left to surface
 * later as `X is not defined`. That substitution — cause replaced by a symptom
 * three steps downstream — is the specific confusion this frame keeps being
 * rebuilt to avoid.
 * @param run - the run token.
 * @param post - the channel to the shell.
 */
function announceReady(run: string, post: (message: FromFrame) => void): void {
  for (const element of document.querySelectorAll('script[data-iris-lib]')) {
    element.addEventListener('error', () => {
      post({
        iris: run,
        type: 'error',
      // No script owns this: it happened outside any body.
      scriptId: undefined,
        message: `a preset library failed to load: ${element.getAttribute('src') ?? 'unknown'}`,
      })
    })
  }

  const announce = (): void => {
    post({ iris: run, type: 'ready' })
  }

  // `complete` means every subresource has settled, load or error. A frame with
  // no libraries reaches it almost immediately; one whose CDN is unreachable
  // never does, and the shell's silence timeout is what speaks then.
  if (document.readyState === 'complete') announce()
  else window.addEventListener('load', announce, { once: true })
}

/** How long a module gets to load before the frame says so. */
const IMPORT_TIMEOUT_MS = 15_000

/**
 * Whether the browser ever put the request on the wire.
 *
 * "The fetch never returned" has two causes that look identical from inside a
 * frame and need opposite fixes: the browser declined to dispatch it — a policy
 * or resolution problem — or it dispatched and nothing came back, which is the
 * network. Resource timing knows which, and it is available in the frame
 * without `connect-src`, because reading the entry is not a fetch.
 *
 * Cross-origin entries are opaque about *durations* without
 * `Timing-Allow-Origin`, but the entry's existence and name are visible
 * regardless — and existence is the entire question here.
 *
 * Two limits, stated so a reading of this is not over-trusted: the buffer holds
 * a few hundred entries and drops the rest, and a request that was redirected is
 * recorded under the URL first asked for. Neither bites a frame that has loaded
 * four scripts and a handful of libraries, but "no entry" is evidence rather
 * than proof.
 * @param targets - the URLs the module was waiting on.
 * @returns a phrase naming what the browser attempted.
 */
function describeAttempts(targets: readonly string[]): string {
  let entries: readonly { name: string }[]
  try {
    entries = performance.getEntriesByType('resource')
  } catch {
    // A frame that cannot answer says so, rather than letting a missing API read
    // as a missing request.
    return 'resource timing is unavailable here, so whether the request was sent is unknown'
  }

  const attempted = targets.filter(target => entries.some(entry => entry.name === target))
  if (attempted.length === targets.length && targets.length > 0) {
    return 'the browser did send the request, so this is the network or the server, not the frame'
  }
  if (attempted.length === 0) {
    return 'the browser never sent the request, so it was refused or unresolvable before the wire'
  }
  return `only some were sent (${attempted.join(', ')})`
}

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
    sendToShell(
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
/**
 * The real channel to the shell, captured before anything can shadow it.
 *
 * This is not defensive style, it is a fix for a bug that severed the frame
 * silently. `post` used to read `window.parent.postMessage` at call time. Then
 * `publishGlobals` began redefining `window.parent` to the **virtual parent**, a
 * proxy that throws on every member it does not bridge — and `postMessage` is not
 * one of the members it bridges.
 *
 * So the moment the bridge was published, the frame's own way of speaking became
 * a thrown `UnsupportedApiError`. The `globals` frame, posted immediately after
 * the redefinition, was the first casualty; the exception then escaped the run
 * handler, so the card body never ran and no further frame was ever sent. From
 * outside: `ready`, then absolute silence.
 *
 * A capability the sandbox is about to take away from card code has to be taken
 * hold of before it is taken away.
 */
const realParent = window.parent
const sendToShell = realParent.postMessage.bind(realParent)

const post = (message: FromFrame): void => {
  // The shell's origin cannot be named: this frame has an opaque origin, so the
  // only usable target is `'*'`. That is safe in this direction because nothing
  // secret travels it — everything here either came from the shell already or is
  // the card's own output. The token is what lets the shell tell frames apart.
  sendToShell(message, '*')
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
   * A forwarding global, the way upstream makes a waited-for name usable.
   *
   * `get` rather than `value`: the provider owns the object and may withdraw it,
   * and a consumer holding a copy would never notice. Configurable so a later
   * wait on the same name can redefine it.
   */
  defineForwarding: (name, read) => {
    try {
      Object.defineProperty(window, name, { get: read, configurable: true })
    } catch {
      // Reported rather than silent: a card that waited successfully and still
      // cannot see the name would otherwise fail on the next line with nothing
      // connecting the two.
      post({
        iris: run,
        type: 'error',
        scriptId: undefined,
        message: `could not make "${name}" available in this frame after waiting for it`,
      })
    }
  },

  reportMissingGlobals: expected => {
    const host = window as unknown as Record<string, unknown>
    const missing = expected.filter(name => host[name] === undefined)
    if (missing.length === 0) return
    post({
      iris: run,
      type: 'error',
      // No script owns this: it happened outside any body.
      scriptId: undefined,
      message:
        `libraries a card may expect are not present in this frame: ${missing.join(', ')}` +
        ' — upstream seeds these from its host page, which a cross-origin frame cannot do',
    })
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

    /*
     * A deadline, because a stalled module is the only failure here that cannot
     * report itself.
     *
     * A module whose remote import never settles does not throw — there is
     * nothing to catch and nothing to time out on its own. The frame simply
     * stops, and from the shell it is indistinguishable from a frame that never
     * received the body at all. Naming the hosts it was waiting on is what turns
     * "it stopped" into something someone can act on.
     *
     * The import is not cancelled, because it cannot be; the promise is abandoned
     * and the report is sent. If the module does eventually arrive it will run,
     * which is untidy and still better than silence.
     */
    const targets = remoteImports(source)
    const deadline = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `import timed out after ${IMPORT_TIMEOUT_MS / 1000}s — the module never finished loading` +
              (targets.length === 0 ? '' : ` (waiting on ${targets.join(', ')})`) +
              ` — ${describeAttempts(targets)}`,
          ),
        )
      }, IMPORT_TIMEOUT_MS)
    })

    return Promise.race([import(/* @vite-ignore */ url), deadline]).then(
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
  announceReady(run, post)
} catch (error: unknown) {
  // Same reasoning: an install that throws is invisible from the outside, and
  // "nothing happened" is the most expensive answer a sandbox can give.
  fail(error)
  throw error
}
