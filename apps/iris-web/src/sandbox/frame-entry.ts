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
import { describeAttempts } from './import-attempts.ts'
import { parseToFrame, type FromFrame } from './protocol.ts'
import { createReportingToastr } from './toastr-report.ts'

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
 * Resource timing entries, or undefined when this frame cannot produce them.
 *
 * The reading itself lives in `import-attempts.ts` so it can be tested; this is
 * only the part that must touch the real realm.
 * @returns the entries, or undefined.
 */
function timedResources(): readonly { name: string }[] | undefined {
  try {
    return performance.getEntriesByType('resource')
  } catch {
    return undefined
  }
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
 * Report failures that happen after a body has finished evaluating.
 *
 * The gap this closes is the widest one left, and a real card fell into it. A
 * card's work does not happen during module evaluation — it happens in the
 * callbacks that evaluation registered. MVU's entire startup is inside
 * `$(async () => { … })`, so anything it throws is an **unhandled rejection**:
 * the module already reported `ran`, nothing rejects the import, and every
 * reporter this frame has stays quiet. From outside, a card that died on its
 * first line of real work is indistinguishable from one patiently waiting.
 *
 * Both events are needed. `error` catches a synchronous throw in a listener or
 * timer; `unhandledrejection` catches the async half, which is where card code
 * overwhelmingly lives.
 * @param run - the run token.
 * @param post - how to reach the shell.
 */
function reportAsyncFailures(run: string, post: (message: FromFrame) => void): void {
  const said = new Set<string>()
  const announce = (kind: string, detail: unknown): void => {
    const text =
      detail instanceof Error
        ? `${detail.name}: ${detail.message}`
        : String(detail as { toString: () => string })
    // Deduplicated: a failing timer can fire forever, and a stream of one fact
    // teaches a reader to skip the whole class.
    if (said.has(text)) return
    said.add(text)
    post({
      iris: run,
      type: 'error',
      // No script owns it: by now evaluation is over and the stack belongs to a
      // callback, which is exactly why nothing else could attribute it either.
      scriptId: undefined,
      message:
        `${kind} after the card body finished: ${text}` +
        ' — this is card code failing in a callback, not the frame refusing anything',
    })
  }

  window.addEventListener('unhandledrejection', event => {
    announce('an unhandled rejection', event.reason)
  })
  window.addEventListener('error', event => {
    /*
     * `event.error` first, and the masked case named as masked.
     *
     * For a script the browser considers cross-origin without CORS credentials,
     * `onerror` is redacted to the literal `Script error.` with no error object,
     * file or line. Passing that on as if it were the card's own message wastes
     * a verification round: it looks like a diagnosis and carries nothing.
     * `crossorigin="anonymous"` on the library tags is what lifts the mask; when
     * something still arrives masked, this says so rather than repeating it.
     */
    if (event.error === null || event.error === undefined) {
      const masked = typeof event.message === 'string' && event.message.includes('Script error')
      announce(
        'an uncaught error',
        masked
          ? 'the browser redacted it (cross-origin script without CORS) — the throw is real,' +
            ' the detail was withheld, and an unhandledrejection from the same code would carry it'
          : event.message,
      )
      return
    }
    announce('an uncaught error', event.error)
  })
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
      } catch (error: unknown) {
        refused.push(name)
        /*
         * The comment above explains one reason a define can fail; this catch
         * accepts every reason. For `parent` and `top` a refusal is the browser
         * answering a question we asked it — expected, and the report is the
         * whole point. For any other name it is a fault of ours, and letting it
         * land in the same list would dress a bug as a browser fact and stop
         * anyone looking further.
         */
        if (name !== 'parent' && name !== 'top') {
          post({
            iris: run,
            type: 'error',
            scriptId: undefined,
            message:
              `could not define "${name}" in this frame: ` +
              (error instanceof Error ? error.message : String(error)) +
              ' — this is not the browser refusing, it is Iris failing to publish',
          })
        }
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

  /**
   * The frame's own script list, in upstream's shape.
   *
   * Copied from `JS-Slash-Runner/src/index.ts:46` and
   * `panel/script/ScriptItem.vue`, not from intuition: the container is
   * `<div id="tavern_helper">` and each running script is a
   * `<div data-type="script" data-script-id="…">` inside it. Cards read this
   * structure to elect one instance of themselves — MVU filters it to the ids it
   * registered and takes the last — so an attribute name guessed rather than
   * copied is the next silent seam: the query returns nothing, the election
   * elects nobody, and the card simply never enables itself.
   *
   * Upstream's list lives on the host page and its cards can already see and
   * change it, because their `$` is the parent's. This one lives in the frame's
   * own document, so the visible surface is upstream-faithful rather than newly
   * exposed, and the real page is untouched.
   */
  listScript: scriptId => {
    if (scriptId === undefined) return
    let list = document.getElementById('tavern_helper')
    if (list === null) {
      list = document.createElement('div')
      list.id = 'tavern_helper'
      document.body.append(list)
    }
    // In card order, and once each: a second element for the same script would
    // make an election that takes the last one depend on how often it was run.
    if (list.querySelector(`div[data-script-id="${CSS.escape(scriptId)}"]`) !== null) return
    const entry = document.createElement('div')
    entry.dataset['type'] = 'script'
    entry.dataset['scriptId'] = scriptId
    list.append(entry)
  },

  provideToastr: report => {
    const host = window as unknown as Record<string, unknown>
    // Not overwritten if something already provided one. Upstream lets a card
    // replace a seeded global, and a card that brought its own real toastr
    // should keep it rather than have its UI silently redirected to our panel.
    if (host['toastr'] !== undefined) return
    host['toastr'] = createReportingToastr(report)
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
        /*
         * A module with no imports cannot be stalled on one.
         *
         * The first version said "import timed out" whatever the cause and then
         * added "the browser never sent the request" — both false for a script
         * whose only remote dependency is a *sibling*: it is parked on a
         * top-level `await waitGlobalInitialized(...)`, there was never a request
         * to send, and the sentence sent a reader looking at the network.
         *
         * Two sentences, because they are two situations.
         */
        reject(
          new Error(
            targets.length === 0
              ? `still evaluating after ${IMPORT_TIMEOUT_MS / 1000}s — this module has no remote imports,` +
                ' so it is parked on something inside itself, most likely a top-level await'
              : `import timed out after ${IMPORT_TIMEOUT_MS / 1000}s — the module never finished loading` +
                ` (waiting on ${targets.join(', ')}) — ${describeAttempts(targets, timedResources())}`,
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

  reportAsyncFailures(run, post)
  reportBlocked(run, post)
  reportHeight(run, post)
  announceReady(run, post)
} catch (error: unknown) {
  // Same reasoning: an install that throws is invisible from the outside, and
  // "nothing happened" is the most expensive answer a sandbox can give.
  fail(error)
  throw error
}
