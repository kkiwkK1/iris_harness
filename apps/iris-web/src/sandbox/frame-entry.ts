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

import type { ScriptContext } from '@iris/protocol'
import { installSandbox } from './frame.ts'
import { remoteImports, requestedImports } from './script-source.ts'
import { describeAttempts, type TimedResource } from './import-attempts.ts'
import { describeTransferCost, type TransferTiming } from './transfer-cost.ts'
import { parseToFrame, type FromFrame } from './protocol.ts'
import { createReportingToastr } from './toastr-report.ts'
import { describeBlocked } from './blocked-report.ts'
import { EXPECTED_GLOBALS, PRESET_ERROR, PRESET_MARKER } from './preset-globals.ts'
import { describeLibraryState } from './library-state.ts'
import { describeOverlayAttempt } from './overlay-report.ts'
import { describeFailure } from './failure-attribution.ts'
import {
  describeHeightSources,
  heightSignal,
  overflowsViewport,
} from './frame-height.ts'

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

    /*
     * What this frame paid for its libraries, reported once per frame.
     *
     * Sent from here because `load` is the first moment every subresource has
     * settled, so the timing entries exist. It answers a question no other
     * instrument in this project can reach: whether the HTTP cache is
     * partitioned per frame origin, which decides whether a 2.29 MB message
     * preset is paid once or once per chat.
     *
     * A `note` rather than an `error`: the panel counts errors as failures in
     * its heading, and a frame reporting its own cost is not a card going wrong.
     */
    const cost = describeTransferCost(libraryTimings(), shortenAssetName)
    if (cost !== undefined) post({ iris: run, type: 'note', scriptId: undefined, message: cost })
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
function timedResources(): readonly TimedResource[] | undefined {
  /*
   * Typed as `TimedResource` rather than `{ name: string }` so the timing numbers
   * survive the trip. They were always present at runtime — `PerformanceResourceTiming`
   * carries them — but a narrower declared type meant the one consumer could
   * only see the name, and a later reader would have had every reason to think
   * the numbers simply were not available.
   */
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
 * Observers rather than a poll — card UI changes height when the card decides
 * to, not on a schedule. Upstream observes resizes; **a resize observer alone
 * is not enough here**, and the reason is written where the observers are
 * registered below: it watches a box, and these cards pin that box to the
 * frame, so the growth that matters changes nothing it can see.
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
  /*
   * Counters, because they answer a question the measures cannot.
   *
   * A fix that added a mutation observer did not make the frame grow, and two
   * explanations fitted: the observer never fires, or it fires and the quantity
   * is pinned. Those need different repairs and look identical from outside an
   * opaque origin. A count separates them in one reading.
   */
  let resizes = 0
  let mutations = 0
  /** The last line reported, so a still card reports nothing. */
  let lastReported = ''
  /** Whether this frame has already said it cannot be measured. */
  let sizingReported = false
  /** A cap, so a busy card cannot turn the panel into a log. */
  let reportsLeft = 8
  const send = (): void => {
    scheduled = false

    /*
     * `body`, not `documentElement` — and never a non-positive number.
     *
     * Both halves are upstream's (`iframe/adjust_iframe_height.js:15-21`), and
     * both were missing here. Together they cost an acceptance round, in a way
     * worth writing down because it is a **self-reinforcing zero**:
     *
     * 1. the frame element starts with no height;
     * 2. the sample card's root is `html,body{height:100%}`, so its content is
     *    100% of nothing;
     * 3. `documentElement.scrollHeight` is therefore 0, and this posted it;
     * 4. the shell wrote `height: 0px` **inline**, which beats any CSS floor —
     *    so the frame could never recover, and the card was invisible rather
     *    than merely small.
     *
     * Upstream refuses at step 3, which is why it never reaches step 4. It also
     * measures `body`, which can exceed the frame's own height, where
     * `documentElement` on a card with `html{height:100%}` simply reports the
     * frame back to itself — a measurement that can only ever confirm whatever
     * height the frame already had.
     *
     * The card cannot break the loop from inside: its own `fit()` sizes the frame
     * through `window.frameElement`, which is **null** across origins. So the
     * shell supplies the starting viewport (`reading.css`), and this reports
     * growth beyond it.
     */
    const pixels = document.body.scrollHeight
    if (!Number.isFinite(pixels) || pixels <= 0) return

    /*
     * **A height equal to the viewport is not reported, it is diagnosed.**
     *
     * Measured on a real card: every ruler returned exactly the frame's own
     * viewport while the screen visibly overflowed, because the card clips its
     * overflow inside a descendant. Posting that closes a loop — the shell
     * applies the height the frame already has, the next measurement returns the
     * same number, and the height the frame started with becomes permanent.
     * That is indistinguishable from "measured once at mount", which is what it
     * was first diagnosed as.
     *
     * So the frame says the one thing it has actually learned: that asking it
     * for a content height has no answer. Once — a card cannot un-clip itself,
     * and repeating it would be a log.
     */
    const signal = heightSignal(pixels, document.documentElement.clientHeight, sizingReported)
    if (signal.kind === 'silent') return
    if (signal.kind === 'sizing') {
      sizingReported = true
      post({ iris: run, type: 'sizing', mode: 'viewport' })
      return
    }

    /*
     * Re-armed on every real height, so a card whose next screen clips itself
     * can say so again. The decision lives in `heightSignal`; this only carries
     * the flag it reads.
     */
    sizingReported = false
    post({ iris: run, type: 'height', pixels: signal.pixels })

    /*
     * **Whatever is past the frame's own viewport has to stay reachable.**
     *
     * The reset copies upstream's `overflow:hidden!important` on `html,body`,
     * which is safe *for upstream* because upstream writes
     * `frameElement.style.height` same-origin and synchronously — its frame is
     * always exactly content height, so there is never anything past the
     * viewport to reach. Iris posts the height instead, so there is always at
     * least one frame of lag, and any moment where the applied height is short
     * of the content is a moment where `hidden` means **gone**: not clipped with
     * a scrollbar, simply absent, and the wheel over it does nothing because
     * the document under the pointer has nowhere to scroll.
     *
     * A user found exactly that: an SPA card whose screen grew, top and bottom
     * cut off, wheel dead. The height fix below stops the common case, but it
     * cannot be the only answer — a card that pins its own height, a slow
     * report, or any future cap puts the content out of reach again, and each
     * would need its own fix. So the frame checks the invariant it actually
     * cares about, on every measurement, and needs to know nothing about why.
     *
     * Turned on only when it is needed, so a card that fits still lays out
     * against no scrollbar, which is the reason the `hidden` was copied.
     */
    /*
     * Every height this frame can see, reported when it changes.
     *
     * Diagnostic, and it stays: "the card is taller than its frame and the
     * frame does not know" is a fault this project has now hit twice, from two
     * different causes, and both times the missing thing was **which measure
     * moved**. Capped and change-gated, so a still card is silent and a busy
     * one cannot flood the panel.
     */
    if (reportsLeft > 0) {
      const range = document.createRange()
      range.selectNodeContents(document.body)
      const bodyTop = document.body.getBoundingClientRect().top
      let childBottom = 0
      for (const child of document.body.children) {
        const bottom = child.getBoundingClientRect().bottom - bodyTop
        if (bottom > childBottom) childBottom = bottom
      }
      const line = describeHeightSources({
        resizes,
        mutations,
        bodyScroll: pixels,
        docScroll: document.documentElement.scrollHeight,
        docClient: document.documentElement.clientHeight,
        bodyRect: document.body.getBoundingClientRect().height,
        rangeHeight: range.getBoundingClientRect().height,
        childBottom,
      })
      range.detach()
      if (line !== lastReported) {
        lastReported = line
        reportsLeft -= 1
        post({ iris: run, type: 'note', scriptId: undefined, message: line })
      }
    }

    const wanted = overflowsViewport(pixels, document.documentElement.clientHeight)
      ? 'auto'
      : ''
    for (const element of [document.documentElement, document.body]) {
      // `important`, because the rule it has to beat is `!important` — and it is
      // upstream's line, not ours to soften for everyone.
      if (element.style.getPropertyValue('overflow-y') === wanted) continue
      if (wanted === '') element.style.removeProperty('overflow-y')
      else element.style.setProperty('overflow-y', wanted, 'important')
    }
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(send)
    else setTimeout(send, 500)
  }

  /*
   * **A `ResizeObserver` on the body is blind to the change that matters most.**
   *
   * It observes a *box*, and the cards this frame exists for set
   * `html,body{height:100%}` — the same fact recorded above as the reason
   * `documentElement` cannot be measured. So the body's box is pinned to the
   * frame's height and does not change when the content inside it grows: an SPA
   * card switching from a short screen to a tall one resizes nothing the
   * observer is watching, the callback never fires, and the height stands at
   * whatever the first measurement made it.
   *
   * That is the defect a user reported — top and bottom of a screen cut off
   * after the card navigated — and its shape is worth naming: the height was
   * not "measured once at mount" by design, it was measured continuously by a
   * mechanism that could not see this kind of change. An instrument watching
   * the wrong quantity looks exactly like an instrument that is not running.
   *
   * So a `MutationObserver` sits beside it, watching what an SPA actually does:
   * replace subtrees. Both feed the same rAF-coalesced `schedule`, so a card
   * mutating a hundred nodes still measures once per animation frame — the cost
   * is bounded by the frame rate, not by how busy the card is.
   */
  new ResizeObserver(() => {
    resizes += 1
    schedule()
  }).observe(document.body)
  new MutationObserver(() => {
    mutations += 1
    schedule()
  }).observe(document.body, {
    childList: true,
    subtree: true,
    // Attributes and text too: a card that switches screens by toggling a class
    // or by swapping text changes no node structure at all, and that is a normal
    // way for a Vue card to work.
    attributes: true,
    characterData: true,
  })

  /*
   * Fonts land after first paint and change every line's height with them, and
   * neither observer above sees a repaint that moves no box and mutates no
   * node. One await, not a poll.
   */
  if (typeof document.fonts?.ready?.then === 'function') void document.fonts.ready.then(schedule)

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
/**
 * Whether any card body has begun evaluating in this frame.
 *
 * Read by the uncaught-error reporter so it can state *when* an error arrived
 * instead of asserting it. The two answers send a reader to opposite halves of
 * the frame — the card's own code, or Iris's setup — and getting that wrong is
 * more expensive than saying nothing, because the report arrives with a suspect
 * already attached.
 */
let bodyStarted = false

/**
 * Which expected globals are absent **at this moment**.
 *
 * The library banner already reports what was missing when the frame finished
 * loading, and that turned out to answer a different question than the one a
 * failure asks. A real case: the banner said the preset had run and did not name
 * `z`, while a card's module died on `z.ZodObject` — so `z` was present at load
 * time and absent at evaluation time, and nothing on screen could tell those
 * apart. Two readings of one name at two moments, and only the second one
 * explains the error.
 *
 * Appended to the failure itself rather than reported separately, because a
 * separate line has to be *correlated* with the error by whoever is reading, and
 * the whole difficulty here was that the load-time reading looked like it
 * already covered it.
 *
 * Bounded by construction: at most the handful of names in `EXPECTED_GLOBALS`,
 * and silent when they are all present — an empty clause on every healthy error
 * would be noise for the majority of errors, which have nothing to do with
 * libraries.
 * @returns a clause naming the absent globals, or an empty string.
 */
function absentGlobalsNow(): string {
  const host = window as unknown as Record<string, unknown>
  const absent = EXPECTED_GLOBALS.filter(name => host[name] === undefined)
  if (absent.length === 0) return ''
  return (
    `. Absent globals at the moment of the failure: ${absent.join(', ')}`
    + ' — read now, not at load time, because the two can differ'
  )
}

function reportAsyncFailures(
  run: string,
  post: (message: FromFrame) => void,
  bodyHasRun: () => boolean,
): void {
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
      // No script owns it: the stack belongs to a callback, which is exactly why
      // nothing else could attribute it either.
      scriptId: undefined,
      /*
       * The context is observed, not assumed.
       *
       * This used to say "after the card body finished" unconditionally, which
       * is a claim about *when* — and it was attached to whatever arrived,
       * including errors from before any card had run. It then added "this is
       * card code failing in a callback, not the frame refusing anything",
       * which is a claim about *whose fault*, asserted from no evidence at all.
       *
       * That combination is the expensive kind of wrong: it arrives with a
       * suspect already named, so nobody checks the innocent party. A frame
       * whose own preset threw during load reported it as the card failing in a
       * callback, and sent a reader looking at the card.
       */
      message:
        describeFailure(kind, text, {
          bodyRan: bodyHasRun(),
          // Read now rather than captured: the attribute is set with the markup.
          interfaceFrame: document.body?.hasAttribute('data-iris-interface') === true,
        }) + absentGlobalsNow(),
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
     * `crossorigin="anonymous"` is the documented way to lift the mask and is
     * *not* available here — it makes the load a CORS fetch and the host sends
     * no `Access-Control-Allow-Origin`, which blocked the preset entirely for a
     * round. Iris's own scripts therefore record their throws in the frame's
     * realm instead (`PRESET_ERROR`); when something still arrives masked, this
     * says so rather than repeating a word that carries nothing.
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

/**
 * Resource timing for the libraries this frame loaded.
 *
 * Matched against the tags actually in the document rather than a list built
 * here, so the two cannot disagree: a library added to the frame is measured
 * without anyone remembering to add it twice.
 * @returns the timing entries for this frame's library tags.
 */
function libraryTimings(): TransferTiming[] {
  let entries: readonly { name: string }[]
  try {
    entries = performance.getEntriesByType('resource')
  } catch {
    return []
  }

  const wanted = new Set(
    [...document.querySelectorAll('script[data-iris-lib]')]
      .map(tag => tag.getAttribute('src'))
      .filter((src): src is string => src !== null)
      .map(src => new URL(src, document.baseURI).href),
  )
  return entries.filter(entry => wanted.has(entry.name)) as TransferTiming[]
}

/**
 * The tail of an asset URL, which is the part that identifies it.
 *
 * A hashed name is long and its origin is always ours, so a full URL would push
 * the number — the thing being reported — off the end of a panel line.
 * @param url - the asset URL.
 * @returns something short enough to read.
 */
function shortenAssetName(url: string): string {
  const at = url.lastIndexOf('/')
  return at === -1 ? url : url.slice(at + 1)
}


/**
 * Which storage APIs this frame does not really have.
 *
 * An opaque origin has no storage: `localStorage` throws on access, and
 * `indexedDB` is the dangerous one — depending on the browser it may throw, or it
 * may hand back a request that **fires neither `onsuccess` nor `onerror`**. A card
 * awaiting that promise waits forever.
 *
 * That is not hypothetical. The sample card's boot does
 * `await refreshContinue()` → `await idb.get('auto')`, and its wrapper handles a
 * throw but has no `onblocked` and no timeout. The frame stayed live, reported a
 * height, raised no error and rendered nothing: the first genuinely *silent*
 * failure this project has produced, and it was invisible at every layer that
 * watches for errors, because nothing failed — something simply never answered.
 *
 * Upstream never meets this: its message iframes carry **no `sandbox` attribute**,
 * so they are same-origin with the page and storage works. Isolation is the
 * deliberate difference, and this is its bill.
 *
 * Probed rather than assumed, because "present" and "usable" are different
 * things here and the gap between them is exactly where the hang lives.
 * @param run - the run token.
 * @param post - the channel to the shell.
 */
function reportStorage(run: string, post: (message: FromFrame) => void): void {
  /*
   * `note`, not `error`, and the reason is what a reader does with the panel.
   *
   * These two lines are a property of the **frame**, not of any card: an opaque
   * origin has no storage, every frame reports the same two sentences, and no
   * card asked for anything that was refused at the moment they are posted. On
   * the `error` channel they landed under "failed" directly above "1 of 2
   * loaded, 1 still starting", and read as its cause. They were not: 3c checked
   * the three libraries involved and none of them touches storage — the MVU
   * bundle references it zero times. Two true sentences and one true heading
   * composed into a false story, and the composition was the channel's doing.
   *
   * The hazard the paragraph above describes is real and stays reported. What
   * changes is that it no longer claims to be someone's failure.
   */
  const say = (message: string): void => {
    post({ iris: run, type: 'note', scriptId: undefined, message })
  }

  try {
    void window.sessionStorage.length
  } catch {
    /*
     * `sessionStorage`, and **not** `localStorage` any more.
     *
     * This probe used to open with "localStorage is not available in this
     * frame", which was true when written and became **false** the moment the
     * storage façade landed — the frame does have one now, backed by the
     * profile store. It kept saying so for a build because the probe runs at
     * bootstrap and the façade is installed on `run`, so the probe measured a
     * window that no longer matters. A report whose truth depends on running
     * before the fix is a report that will outlive the fix.
     *
     * `sessionStorage` has no façade and still throws — measured in a real
     * opaque-origin frame, in the same probe that showed the `localStorage`
     * shadow working. So the named absence moves here rather than being
     * deleted: it is the same fact about the same origin, now said about the
     * member it is still true of.
     */
    say(
      'sessionStorage is not available in this frame — an opaque origin has no storage, and'
      + ' unlike localStorage this one has no Iris facade behind it, so a card using it for'
      + ' per-session state will not remember anything',
    )
  }

  /*
   * `indexedDB` is **present**, and that was measured rather than assumed.
   *
   * The two branches that used to stand here — a throw on reading the property,
   * and the property being `undefined`/`null` — could not fire: in a real
   * `sandbox="allow-scripts"` frame `window.indexedDB` hands back a working
   * `IDBFactory`. They were dead code stating a false thing about the property
   * layer, and someone reading them would have concluded the storage APIs fail
   * uniformly at access. They do not: `localStorage` throws on access,
   * `indexedDB` does not.
   */
  const database = window.indexedDB

  /*
   * Present is not the same as working. The probe opens a database and waits a
   * moment for **any** answer; silence is the finding, because silence is what a
   * card's own await would get.
   */
  let answered = false
  const probe = (): void => {
    if (answered) return
    answered = true
    say(
      'indexedDB answered neither success nor error in this frame — a card awaiting it will wait' +
        ' forever, with nothing to report and no error anywhere. An opaque origin has no storage.',
    )
  }

  try {
    const request = database.open('iris-storage-probe')
    request.onsuccess = () => {
      answered = true
      try {
        request.result.close()
        database.deleteDatabase('iris-storage-probe')
      } catch {
        // Cleaning up is courtesy; failing to is not worth a second report.
      }
    }
    request.onerror = () => {
      answered = true
      say('indexedDB refused to open in this frame — an opaque origin has no storage')
    }
    request.onblocked = () => {
      answered = true
      say('indexedDB reported the probe blocked, so a card awaiting it may never be answered')
    }
    setTimeout(probe, 1_500)
  } catch {
    say('indexedDB refused to open in this frame — an opaque origin has no storage')
  }
}

/** How long an interface may be blank before that is a finding. */
const BLANK_AFTER_MS = 6_000

/**
 * Main-thread blocking inside this frame, accumulated from the start.
 *
 * Registered as an observer rather than read on demand, because
 * `getEntriesByType('longtask')` returns **nothing** unless something was already
 * observing — the entries are not retained otherwise. The first version of the
 * summary read it on demand, got an empty list, and printed no timing at all:
 * an instrument reporting silence that meant "nobody was listening" rather than
 * "nothing happened".
 *
 * This is the measurement that separates the two reasons a frame paints late,
 * which need opposite fixes: waiting on the network, or blocking its own thread.
 */
const blocking = { tasks: 0, total: 0 }

/**
 * When this frame first got to render, measured by its own animation frame.
 *
 * Not `first-contentful-paint`. That entry is a **main-frame** metric in Chrome and
 * is simply not recorded for a child document — so reading it here returned
 * nothing, and the summary printed "never painted" for a frame that was
 * rendering perfectly well. **An unavailable measurement reported as a negative
 * finding**, which is the same mistake as reading `background-color` on a gradient
 * and the same mistake as reading a long-task list nobody was observing. Three
 * times in one instrument, each time producing a confident wrong answer rather
 * than a gap.
 *
 * A `requestAnimationFrame` callback fires immediately before the browser paints,
 * and it exists in every frame. It says "this document reached the point of
 * rendering", which is the question actually being asked.
 */
let firstFrameAt: number | undefined
try {
  requestAnimationFrame(() => {
    firstFrameAt = performance.now()
  })
} catch {
  // No rAF is itself unusual enough that the frame has larger problems.
}
try {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      blocking.tasks += 1
      blocking.total += entry.duration
    }
  }).observe({ type: 'longtask', buffered: true })
} catch {
  // Not every browser implements it; absence is not a finding, so nothing is said.
}

/**
 * Say something when a frame is alive and has drawn nothing.
 *
 * The coordinator's question was whether this deserves a判据 at all, and the
 * answer is yes for one reason: **every other instrument here watches for
 * something going wrong, and this failure is nothing going wrong.** The frame
 * loaded, reported a height, raised no error, refused nothing, and rendered a
 * blank rectangle — a card stopped on an `await` that will never resolve. Every
 * error-shaped detector is silent, correctly.
 *
 * Deliberately a *symptom* detector, kept alongside the cause-level probe rather
 * than instead of it. `reportStorage` names the specific thing an opaque origin
 * cannot provide; this one catches the class — any hang, for any reason, in code
 * this project did not write and cannot inspect.
 *
 * The threshold is generous and one-shot. A card that legitimately takes a
 * while to draw should not be accused, and a card that never draws should be
 * named exactly once.
 * @param run - the run token.
 * @param post - the channel to the shell.
 */
function reportBodySummary(run: string, post: (message: FromFrame) => void): void {
  /*
   * A script frame gets a **different** report, not no report.
   *
   * The summary below is for a frame that was given markup; a script frame's
   * body is script tags and nothing else, so running it there would put a
   * permanent line under every card saying that the frame which was never going
   * to draw has not drawn.
   *
   * But [OVERLAY-CARDS.md] found a third class of card that draws *into* the
   * script frame: it never touches `parent.*`, and upstream's `parent_jquery.js`
   * makes its `$` the page's, so `.appendTo('body')` lands on the host page.
   * Here `$` is the frame's own, so the card's whole interface is built in a
   * frame nobody can see — and the early return meant we said nothing at all
   * about the one case where silence is wrong.
   */
  if (document.body?.hasAttribute('data-iris-interface') !== true) {
    setTimeout(() => {
      const body = document.body
      if (body === null) return
      const built = [...body.children].filter(
        child => child.tagName !== 'SCRIPT' && child.tagName !== 'STYLE',
      )
      const line = describeOverlayAttempt({
        built: built.length,
        tags: built.map(child => child.tagName.toLowerCase()),
        /*
         * Text, so a mount point can be told from an interface. MVU appends one
         * empty `div` here — as it does upstream, in a frame nobody sees — and
         * without this the report fired on every card bundling it.
         */
        textLength: built.map(child => child.textContent ?? '').join('').trim().length,
        // The frame's own viewport, which is 0×0 for a script frame — the
        // reason every measurement the card takes comes back zero.
        viewportWidth: document.documentElement.clientWidth,
        viewportHeight: document.documentElement.clientHeight,
      })
      if (line !== undefined) post({ iris: run, type: 'note', scriptId: undefined, message: line })
    }, BLANK_AFTER_MS)
    return
  }

  setTimeout(() => {
    const body = document.body
    if (body === null) return

    const children = [...body.children]
    const visible = children.filter(child => {
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') return false
      const box = child.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    })

    /*
     * Reported **whether or not anything is visible**, and that change is the
     * whole point of this revision.
     *
     * The first version spoke only when the body was blank, so "not blank" was
     * silence — and the case that actually arrived was a frame with visible
     * boxes rendering a white rectangle. An instrument whose quiet covers the
     * live question is the unfalsifiable silence this project keeps removing;
     * it just had it too.
     *
     * A summary is cheap for an interface frame (there is one per claimed block,
     * not one per row) and it is the difference between "white" and a reading.
     */
    /*
     * `background-image` as well as `background-color`, because reporting only the
     * colour is a **wrong reading**, not a partial one.
     *
     * The `background` shorthand resets `background-color` to transparent unless a
     * colour is named, so a card painting `background: radial-gradient(...)` —
     * which the sample card does — computes to `rgba(0, 0, 0, 0)`. The first
     * version of this summary reported exactly that and it was read, reasonably,
     * as "the stylesheet is present and paints nothing". The stylesheet may have
     * been working the whole time.
     *
     * `opacity` and `visibility` are here for the same reason: an element with a
     * box can still be invisible, and none of the other fields would say so.
     */
    const paint = (style: CSSStyleDeclaration): string => {
      const image = style.backgroundImage
      const parts = [`bg=${style.backgroundColor}`]
      if (image !== 'none' && image !== '') parts.push(`bg-image=${image.slice(0, 40)}`)
      if (style.opacity !== '1') parts.push(`opacity=${style.opacity}`)
      if (style.visibility !== 'visible') parts.push(`visibility=${style.visibility}`)
      return parts.join(' ')
    }

    const describe = (element: Element): string => {
      const box = element.getBoundingClientRect()
      return (
        `${element.tagName.toLowerCase()}` +
        `${element.id === '' ? '' : `#${element.id}`} ` +
        `${Math.round(box.width)}x${Math.round(box.height)} ${paint(getComputedStyle(element))}`
      )
    }

    /*
     * The card's own stylesheet, counted. If the markup arrived but its `<style>`
     * did not, every colour in the frame is the browser's default — which is
     * exactly what "visible boxes on a white page" looks like, and nothing else
     * reported here would distinguish it.
     */
    const styles = body.querySelectorAll('style').length

    /*
     * Descendants, not just direct children.
     *
     * The first summary counted the body's own children and reported "1 with a
     * visible box" for a card whose entire interface lives inside that one box.
     * That number said nothing about whether the interface had drawn — the
     * question it was asked. Counting the whole tree separates "one empty
     * container" from "a container full of hidden screens".
     */
    const descendants = [...body.querySelectorAll('*')].filter(
      element => element.tagName !== 'SCRIPT' && element.tagName !== 'STYLE',
    )
    const visibleDescendants = descendants.filter(element => {
      const box = element.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    })

    /*
     * **When** it drew, not only whether.
     *
     * The sample card renders correctly and takes tens of seconds to do it, with
     * the renderer unresponsive in between — a failure none of the other
     * instruments can express, because each asks a yes/no question and the
     * answer to all of them is eventually yes. "Works" and "works after thirty
     * seconds" are the same reading to a boolean.
     *
     * `first-contentful-paint` is the browser's own answer, measured inside the
     * frame where the work happens. Long tasks separate the two causes, which
     * need opposite fixes: a frame that paints late because it waited on a fetch
     * is not a frame that paints late because it blocked its own main thread.
     */
    const timing: string[] = [
      firstFrameAt === undefined
        ? 'has not reached a render yet'
        : `first render at ${String(Math.round(firstFrameAt))}ms`,
    ]
    if (blocking.tasks > 0) {
      timing.push(
        `${String(blocking.tasks)} long tasks blocking ${String(Math.round(blocking.total))}ms`,
      )
    }

    const parts = [
      `${String(children.length)} children, ${String(descendants.length)} descendants`,
      `${String(visibleDescendants.length)} of them with a visible box`,
      `${String(styles)} style elements in the body`,
      `body ${paint(getComputedStyle(body))}`,
      ...timing,
    ]
    if (visible.length > 0) {
      parts.push(`largest: ${visible.slice(0, 3).map(describe).join('; ')}`)
    }

    post({
      iris: run,
      type: 'note',
      scriptId: undefined,
      message:
        visible.length === 0
          ? `this interface has drawn nothing after ${BLANK_AFTER_MS / 1000}s — ` +
            (children.length === 0
              ? 'its body is empty, so the markup never arrived'
              : `${parts.join(', ')}; code that stops without failing reports nothing anywhere`)
          : `interface after ${BLANK_AFTER_MS / 1000}s: ${parts.join(', ')}`,
    })
  }, BLANK_AFTER_MS)
}

function reportBlocked(run: string, post: (message: FromFrame) => void): void {
  document.addEventListener('securitypolicyviolation', event => {
    // The decision lives in `blocked-report.ts`, which needs neither a document
    // nor a policy to fire — and the decision is the part that was wrong.
    const { host, detail } = describeBlocked(event, location.origin)
    post({
      iris: run,
      type: 'blocked',
      host,
      directive: event.effectiveDirective,
      ...(detail === undefined ? {} : { detail }),
    })
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
    /*
     * Read from the document here, because `frame.ts` is injected with
     * everything it needs and knows nothing about the document it lands in. The
     * attribute is set by `srcdoc.ts` on the body of a frame that carries card
     * markup.
     */
    interfaceFrame: document.body?.hasAttribute('data-iris-interface') === true,
    /*
     * An own property of `window`, which is what the measurement said to do.
     *
     * In a real `sandbox="allow-scripts"` frame, `localStorage` is an own,
     * configurable property of `window` with nothing on `Window.prototype` — so
     * one `defineProperty` shadows the getter that throws, and afterwards
     * `typeof localStorage` is `'object'` and bare-identifier access works.
     * `sessionStorage`, left alone in the same probe, still throws, which is
     * what makes that a reading about the shadow rather than about a frame that
     * happened to have storage.
     *
     * Reported rather than thrown if it fails: a frame without storage is worse
     * than one with, and a frame that died installing it is worse than both.
     */
    provideStorage: storage => {
      try {
        Object.defineProperty(window, 'localStorage', {
          value: storage,
          configurable: true,
          writable: true,
        })
      } catch (error: unknown) {
        post({
          iris: run,
          type: 'error',
          scriptId: undefined,
          message:
            'Iris could not install card storage in this frame, so localStorage will throw on'
            + ' access as an opaque origin’s does: '
            + (error instanceof Error ? error.message : String(error)),
        })
      }
    },

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

  seededContext: () => {
    /*
     * Read once, then removed from the global.
     *
     * Removed because leaving it there would give a card a second, stale copy of
     * its own variables under a name it can discover — and a stale copy that
     * looks authoritative is worse than none. Pushed updates go to the frame's
     * own slot, not back to this global, so anything still reading it after the
     * first update would be reading history.
     */
    const host = window as unknown as Record<string, unknown>
    const seeded = host['__iris_context__']
    delete host['__iris_context__']
    return seeded === undefined ? undefined : (seeded as ScriptContext)
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

    /*
     * The tag is read back from the document rather than reconstructed, so the
     * URL in the report is the one the browser was actually given. A rebuilt
     * guess would stay plausible while pointing at the wrong place, which on a
     * "go and check this request" instruction is worse than no URL at all.
     */
    const tag = document.querySelector('script[data-iris-lib]')
    const url = tag?.getAttribute('src') ?? 'the preset script'

    // The bundle's own record of its throw, when it got far enough to leave one.
    const recorded = host[PRESET_ERROR]
    const message = describeLibraryState(
      host[PRESET_MARKER] === true,
      missing,
      url,
      typeof recorded === 'string' ? recorded : undefined,
    )
    if (message === undefined) return

    /*
     * **The channel has to agree with the sentence.**
     *
     * This was always posted as an `error`, and the panel renders an error under
     * the card-script heading as *failed*. So a frame whose preset loaded fine
     * and merely lacks `showdown` announced "card scripts: failed" — while the
     * message itself said "the preset ran, so these are libraries Iris does not
     * carry **rather than a failed load**". The text and the channel contradicted
     * each other, and the channel is what a reader sees first.
     *
     * A recorded preset throw is a real failure and stays an error. Absent
     * libraries with a preset that ran are a **note**: a fact worth having when
     * something else goes wrong, and not itself something going wrong. That is
     * the same split `describeTransferCost` already uses one screen up.
     */
    const presetThrew = typeof recorded === 'string' && recorded !== ''
    post({
      iris: run,
      type: presetThrew ? 'error' : 'note',
      // No script owns this: it happened outside any body.
      scriptId: undefined,
      message,
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
  evaluate: (source, mode, names, values, scriptId) => {
    /*
     * Set before evaluation, not after, and that is the point: an error thrown
     * *by* a body is still an error after a body ran. Recording it on completion
     * would report the card's own synchronous throw as belonging to the frame's
     * setup.
     */
    bodyStarted = true
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
    /*
     * Two lists, because the reader and the check want different URLs.
     *
     * `targets` is what the card wrote, and it is what gets shown: someone
     * reading a stalled import wants the bundle's own address, not Iris's
     * routing. `requested` is what the browser was actually asked for, which
     * after rewriting is the proxy URL, and it is the only thing resource timing
     * will ever have an entry under.
     *
     * Using the display list for the check made the verdict unfalsifiable: it
     * looked for an entry named after a URL the browser was never going to
     * request, so "the browser never sent the request" came out true regardless,
     * and a cache-warm proxy fetch was reported as a refusal before the wire.
     */
    const targets = remoteImports(source)
    const requested = requestedImports(source)
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
                ` (waiting on ${targets.join(', ')}) — ${describeAttempts(requested, timedResources())}`,
          ),
        )
      }, IMPORT_TIMEOUT_MS)
    })

    /*
     * The deadline abandons the import; it cannot cancel it.
     *
     * That was always in the comment above as an untidiness worth accepting.
     * A real card turned it into a wrong answer: the provider's bundle arrived
     * a few seconds past fifteen, ran, published, and woke all three of its
     * consumers — while the panel went on calling it failed. **A verdict that
     * has been refuted by later evidence is worse than no verdict**, because it
     * tells someone a working card is broken.
     *
     * So the import is still watched after the race is lost, and the record is
     * corrected under the same script id. The correction keeps the duration
     * rather than quietly repainting the row: fifteen seconds of dead air before
     * a card starts is a real defect even when it resolves, and erasing it would
     * remove the only evidence that the fetch is slow.
     */
    const started = Date.now()
    let timedOut = false
    deadline.catch(() => {
      timedOut = true
    })

    const loading = import(/* @vite-ignore */ url)

    loading.then(
      () => {
        if (!timedOut) return
        post({ iris: run, type: 'ran', scriptId, lateMs: Date.now() - started })
      },
      (error: unknown) => {
        // A late *failure* is not left to the timeout's guess. The row already
        // says failed, but "timed out waiting for the network" and the module's
        // actual error send a reader to different places, and only one of them
        // is true.
        if (!timedOut) return
        post({
          iris: run,
          type: 'error',
          scriptId,
          message:
            `the module finished after the ${IMPORT_TIMEOUT_MS / 1000}s deadline and failed: ` +
            String(error instanceof Error ? `${error.name}: ${error.message}` : error),
        })
      },
    )

    return Promise.race([loading, deadline]).then(
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

  reportAsyncFailures(run, post, () => bodyStarted)
  reportBlocked(run, post)
  reportStorage(run, post)
  reportBodySummary(run, post)
  reportHeight(run, post)
  announceReady(run, post)
} catch (error: unknown) {
  // Same reasoning: an install that throws is invisible from the outside, and
  // "nothing happened" is the most expensive answer a sandbox can give.
  fail(error)
  throw error
}
