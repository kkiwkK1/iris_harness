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
/*
 * **Types only.** The stand-in's code comes off the member table
 * (`members.js`), which is fetched once per frame rather than inlined into
 * every frame's bootstrap — importing it here for real cost 8.2 KiB per frame
 * and pulled `card-css.ts`'s whole scanner in behind it, which is the exact
 * growth the table exists to stop. A type import is erased, so this line is
 * free.
 */
import type { NestedNode, NestedQueryHost } from './nested-frame.ts'
import { remoteImports, requestedImports } from './script-source.ts'
import { describeAttempts, type TimedResource } from './import-attempts.ts'
import { describeTransferCost, type TransferTiming } from './transfer-cost.ts'
import { parseToFrame, type FromFrame } from './protocol.ts'
import { blockedMessageFor } from './blocked-report.ts'
import type { Measured, Visibility } from './overlay-regions.ts'
import { MEMBERS_GLOBAL, MEMBERS_MARKER, type MemberTable } from './members-contract.ts'
import { EXPECTED_GLOBALS, PRESET_ERROR, PRESET_MARKER } from './preset-globals.ts'
import { describeLibraryState } from './library-state.ts'
import { describeOverlayAttempt } from './overlay-report.ts'
import { describeFailure, topFrame } from './failure-attribution.ts'
import {
  containDecision,
  contentExtent,
  describeHeightSources,
  heightSignal,
  overflowDecision,
} from './frame-height.ts'

/**
 * Tell the shell the frame is usable.
 *
 * **The handshake completes when the channel exists, not when the network
 * settles.** Everything `ready` actually vouches for — the captured `post`
 * channel, the member bridge, the message listener, the run token — is in place
 * the moment `installSandbox` returns, so an **interface** frame announces right
 * here. Waiting longer handed the handshake to the card's own decorative
 * resources: the `load` event waits on every stylesheet a card's markup links,
 * and the measured card that broke this had linked Google Fonts from its title
 * screen. On a network where that fetch hangs, the frame rendered, drew its
 * button — and was reported as "never reported ready" because the fonts had not
 * arrived. A handshake held hostage to a font is not a handshake about the
 * channel any more.
 *
 * A **script** frame still waits for `load`. Its body is handed over *on*
 * `ready` (`runner.ts` posts the `run` messages), so the libraries it must
 * evaluate against have to be there first — that wait buys exactly what it
 * costs, and a script frame's head carries only Iris-controlled resources.
 *
 * A library that fails outright is reported here rather than left to surface
 * later as `X is not defined`. That substitution — cause replaced by a symptom
 * three steps downstream — is the specific confusion this frame keeps being
 * rebuilt to avoid. The listener is a **capture-phase** one on the document:
 * the library tags are parsed *after* this script, so the earlier version's
 * `querySelectorAll('script[data-iris-lib]')` ran before its targets existed
 * and attached the reporters to nothing.
 *
 * @param run - the run token.
 * @param post - the channel to the shell.
 * @param interfaceFrame - whether this frame carries a card's markup.
 */
function announceReady(
  run: string,
  post: (message: FromFrame) => void,
  interfaceFrame: boolean,
): void {
  document.addEventListener(
    'error',
    event => {
      const target = event.target
      if (!(target instanceof HTMLScriptElement)) return
      if (!target.hasAttribute('data-iris-lib')) return
      post({
        iris: run,
        type: 'error',
        // No script owns this: it happened outside any body.
        scriptId: undefined,
        message: `a preset library failed to load: ${target.getAttribute('src') ?? 'unknown'}`,
      })
    },
    // Resource `error` events do not bubble; capture is the only way a document
    // listener sees them.
    true,
  )

  /*
   * What this frame paid for its libraries, reported once per frame.
   *
   * Sent from the load settle point because `load` is the first moment every
   * subresource has finished, so the timing entries exist. It answers a question
   * no other instrument in this project can reach: whether the HTTP cache is
   * partitioned per frame origin, which decides whether a 2.29 MB message
   * preset is paid once or once per chat.
   *
   * A `note` rather than an `error`: the panel counts errors as failures in its
   * heading, and a frame reporting its own cost is not a card going wrong.
   */
  const reportCost = (): void => {
    const cost = describeTransferCost(libraryTimings(), shortenAssetName)
    if (cost !== undefined) post({ iris: run, type: 'note', scriptId: undefined, message: cost })
  }

  if (interfaceFrame) {
    // The channel is up; the handshake is done. The cost report still belongs
    // to the settle point — the timings it reads do not exist yet.
    post({ iris: run, type: 'ready' })
    // `complete` means every subresource has settled, load or error. A frame
    // that reached this line mid-parse cannot be there yet, but the branch
    // costs nothing and keeps the two paths honest about the same event.
    if (document.readyState === 'complete') reportCost()
    else window.addEventListener('load', reportCost, { once: true })
    return
  }

  const announce = (): void => {
    post({ iris: run, type: 'ready' })
    reportCost()
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


/**
 * The shell's origin, as the host stamped it into this frame's markup.
 *
 * Not `location.origin`: this frame's origin is opaque, so that reads the string
 * `"null"` — measured in a sandboxed srcdoc frame — and every comparison against
 * it fails. One had been failing since it was written: the refusal reporter used
 * it to decide whether a blocked request was aimed at **us**, so that branch was
 * unreachable and every such refusal reported `blocked 127.0.0.1:8787
 * (connect-src)` with no path and no requester — precisely the string
 * `blocked-report.ts` was written to stop producing. The mechanism was right and
 * the input was `"null"`.
 *
 * Falls back to `location.origin` rather than throwing: the only consumer is a
 * diagnostic, and refusing to start a card because a *report* would be less
 * precise trades a working card for a better error message.
 * @returns the origin Iris serves from.
 */
function shellOrigin(): string {
  const element = document.querySelector('meta[name="iris-origin"]')
  const value = element?.getAttribute('content')
  return value === null || value === undefined || value === '' ? location.origin : value
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
/**
 * Tell the shell which parts of this frame may catch a click.
 *
 * A script frame is the card's overlay surface and covers the viewport, so
 * without this it would swallow every click meant for the shell. Measured in a
 * real opaque-origin frame: `pointer-events:none` lets clicks through but the
 * card's own nodes **cannot** re-enable themselves, so a clip is the only
 * mechanism that gives per-node hit-testing across a frame boundary.
 *
 * Batched into an animation frame and **deduplicated by the generated string**.
 * Both matter for the same reason: a card animating a panel fires mutations and
 * resizes continuously, and this crosses a message boundary. The dedup is what
 * makes a still card cost nothing at all, and `mergeRegions` keeps the string
 * stable across changes that do not alter what is hit-testable.
 * @param run - the run token.
 * @param post - the channel to the shell.
 */
function reportRegions(
  run: string,
  post: (message: FromFrame) => void,
  members: MemberTable,
): void {
  let scheduled = false
  let last = ''
  /*
   * Set by the two events that mean "the last measurement may have been taken
   * against a viewport that no longer exists": a tab coming forward, and a
   * resize. See `forceMeasure`.
   */
  let forced = false

  const measure = (node: Element): { measured: Measured, children: readonly Element[] } => {
    const rect = node.getBoundingClientRect()
    let interactive = true
    let visibility: Visibility | undefined
    try {
      const style = getComputedStyle(node)
      // A card's decorative layer declares this for itself, and taking it would
      // make Iris block clicks upstream lets through.
      interactive = style.pointerEvents !== 'none'
      /*
       * How it looks, **for the report only**. The clip above is decided by
       * geometry alone: a node that is invisible and still meant to catch
       * clicks is a real thing, and folding visibility into the clip would make
       * those silently unclickable.
       */
      visibility = {
        /*
         * Tag, id **and class**, because a card's overlay wrapper usually has
         * no id and the class is the only handle a reader can match against the
         * card's own CSS.
         */
        label: `${node.tagName.toLowerCase()}${node.id === '' ? '' : `#${node.id}`}`
          + (node.className === '' || typeof node.className !== 'string'
            ? ''
            : `.${node.className.trim().split(/\s+/).slice(0, 3).join('.')}`),
        /*
         * The box itself, and the two things that explain a zero one. A live
         * reading had `clip-path: path("M 0 0 Z")` with two elements built and
         * no way to tell whether they were hidden, detached, or sized zero by
         * the card — four repairs behind one sentence.
         */
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        display: style.display,
        connected: node.isConnected,
        /*
         * Trimmed and capped, not reformatted: `!important` has to survive into
         * the report verbatim, because it is what says whether a `display:none`
         * came from the card's own hide path.
         */
        inline: (node.getAttribute('style') ?? '').trim().slice(0, 200),
        standIn: node.hasAttribute('data-iris-nested-frame'),
        opacity: style.opacity,
        visibility: style.visibility,
        text: (node.textContent ?? '').trim() !== '',
        paints:
          (style.backgroundColor !== '' && !style.backgroundColor.startsWith('rgba(0, 0, 0, 0)'))
          || style.backgroundImage !== 'none'
          || (style.borderTopWidth !== '0px' && style.borderTopStyle !== 'none'),
        // The resolved stack's first family: a button whose content is an emoji
        // draws nothing if nothing in the stack carries the glyph, and this is
        // the only place that can say what the stack resolved to.
        // `exactOptionalPropertyTypes`: the key is omitted rather than set to
        // undefined, so "no resolved family" and "we did not look" stay apart.
        ...(() => {
          const first = style.fontFamily.split(',')[0]?.trim()
          return first === undefined || first === '' ? {} : { font: first }
        })(),
      }
    } catch {
      // A detached node has no computed style. Treated as interactive: the
      // rectangle is what decides, and a detached node's is empty anyway.
    }
    return {
      measured: {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        interactive,
        ...(visibility === undefined ? {} : { visibility }),
      },
      children: [...node.children],
    }
  }

  const send = (): void => {
    scheduled = false
    const body = document.body
    if (body === null) return
    /*
     * The card's own top-level nodes, minus the machinery. A `<script>` or
     * `<style>` measures empty anyway, so excluding them is about the walk
     * rather than the result — and `#tavern_helper`, which the frame itself
     * builds for the script list, is ours rather than the card's.
     */
    const roots = [...body.children].filter(
      child => child.tagName !== 'SCRIPT' && child.tagName !== 'STYLE'
        && child.id !== 'tavern_helper',
    )
    const seen: Visibility[] = []
    const clip = members.clipPathFor(members.collectRegions(roots, measure, seen))
    /*
     * **The dedup key is the clip *and* what was measured**, not the clip alone.
     *
     * A card whose elements are all zero-area produces the same empty clip on
     * every pass, so keying on the clip meant the diagnosis was sent once —
     * before the card had finished building — and never again as elements
     * appeared and stayed empty. The one state that most needs re-reporting was
     * the one state that could not.
     *
     * `roots.length` and the zero-count are enough to catch "the DOM changed
     * and the answer did not", without re-sending on every animation frame of a
     * card that is merely animating.
     */
    const zero = seen.filter(
      it => it.rect !== undefined && (it.rect.width <= 0 || it.rect.height <= 0),
    ).length
    /*
     * **The frame's own viewport, because `100vh` is measured against it.**
     *
     * A frame that has never been laid out reports `clientHeight === 0`, and
     * every `vh`/`vw` length inside it resolves to zero — so a card that sizes
     * its overlay `width:100vw; height:100vh !important` builds a full-screen
     * element that measures nothing, with correct CSS and a correct box. That
     * is one reading of the intermittency seen on one card (empty once, full
     * screen once, same card and same chat); the other is that the card hid
     * itself. These two numbers separate them without another round trip:
     * zero here means the frame had no layout, non-zero means it did and the
     * emptiness came from somewhere else.
     */
    const root = document.documentElement
    const viewport = { width: root.clientWidth, height: root.clientHeight }
    const key = members.regionsKey(clip, roots.length, zero, viewport)
    /*
     * A forced pass reports even when the key is unchanged. The dedup exists to
     * keep a still card quiet, but after a resize or a return to the foreground
     * "unchanged" is itself the finding — it says the re-measure happened and
     * the answer really is the same, which is what nobody could tell from a
     * report that was simply never sent.
     */
    const bypass = forced
    forced = false
    if (key === last && !bypass) return
    last = key
    /*
     * The summary rides the same message and the same deduplication: it changes
     * only when the clip does, so a still card sends nothing at all. That does
     * mean a node that turns transparent without moving is not re-reported —
     * accepted, because the alternative is a diagnostic that posts on every
     * animation frame of every card.
     */
    /*
     * The conclusion first, then the evidence. A reader arrives at this line
     * from a blank screen, and "all of them measured zero, so the clip is
     * empty" is the sentence that turns that into something to act on; the
     * per-element boxes are what they read next to find out which one.
     */
    const summary = members.describeEmptySurface(zero, seen.length)
    const lines = seen
      .map(it => members.describeVisibility(it))
      .filter((line): line is string => line !== undefined)
    /*
     * Capped, because this string crosses a message boundary on every mutation
     * and a card is free to build two hundred top-level nodes. The first dozen
     * are what a reader acts on; the count says how much was left out, so the
     * cap can never be mistaken for "that was all of them".
     */
    const shown = lines.slice(0, 12)
    const detail = [
      ...(summary === undefined ? [] : [summary]),
      members.describeFrameViewport(viewport),
      ...shown,
      ...(lines.length > shown.length
        ? [`and ${String(lines.length - shown.length)} more element(s) not listed`]
        : []),
    ].join('; ')
    post({
      iris: run,
      type: 'regions',
      clip,
      ...(detail === '' ? {} : { detail }),
    })
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    /*
     * **`requestAnimationFrame` does not run in a background tab**, and this is
     * the one report where that is a user-facing defect rather than a delay: a
     * reader who opens a chat in a background tab and comes back finds the
     * overlay both invisible and unclickable, because the clip is still the
     * zero-area path the frame was attached with. Nothing in the panel says so
     * either — the frame is waiting to be asked, and nobody asks.
     *
     * So `rAF` while visible (it batches to the frame that will paint, which is
     * the whole reason to use it) and a timer while hidden (it is throttled to
     * about a second in a background tab, which is far more than enough for
     * something nobody is looking at).
     *
     * **And a timer beside the `rAF`, because there is a third state where
     * `rAF` does not run at all: this one.** The shell attaches the frame with
     * the zero-area clip this reporter exists to replace, and Chrome skips
     * rendering a frame whose clip paints nothing — no paint runs, so no `rAF`
     * fires, so no measurement is asked for, so the clip stays zero-area.
     * Measured on a real card whose interface was fully mounted and correctly
     * laid out inside the frame: the shell at 120 fps and the frame's `rAF`
     * count at zero, for as long as the empty clip held. The state is a fixed
     * point of the loop, and the timer is what breaks it — it is cancelled by
     * the `rAF` path it rescues (`send` clears `scheduled`), so a painting
     * frame pays one no-op timeout per schedule and nothing more. The interval
     * is the height reporter's non-`rAF` fallback's, for the same reason: it
     * bounds how long a mounted interface stays invisible, not how fast
     * anything animates.
     */
    if (document.hidden) {
      setTimeout(send, 0)
      return
    }
    requestAnimationFrame(send)
    setTimeout(() => {
      if (scheduled) send()
    }, 500)
  }

  /**
   * Measure again and report **even if nothing changed**.
   *
   * Deliberately a separate zero-argument function rather than a parameter on
   * `schedule`: `schedule` is handed straight to `MutationObserver` and
   * `ResizeObserver`, which call it with `(records, observer)`, so a
   * `force = false` parameter would arrive truthy on every mutation and turn
   * the dedup off for good.
   */
  const forceMeasure = (): void => {
    forced = true
    schedule()
  }

  /*
   * Both observers, for the two ways a card's occupied area changes: it builds
   * or removes nodes (mutation), or a node it already built changes size
   * (resize). The height reporter needed exactly this pair for the same reason,
   * and a single observer misses half the cases silently — a card that grows a
   * panel without touching the DOM would keep the old clip.
   */
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden'],
  })
  try {
    const sizes = new ResizeObserver(schedule)
    sizes.observe(document.documentElement)
    if (document.body !== null) sizes.observe(document.body)
  } catch {
    // No `ResizeObserver` in this realm: the mutation observer still covers the
    // build-and-remove cases, which is every measured card's first need.
  }
  /*
   * Scrolling is the third way, and neither observer sees it.
   *
   * `getBoundingClientRect` is viewport-relative, so a scroll moves every
   * statically-positioned node in the card without changing the DOM and without
   * changing any node's size. The clip on file then describes where things
   * *were*, and a **stale clip is worse than no clip**: it is a hole in the
   * wrong place, so the card's button is not clickable and the shell underneath
   * is clicked instead — through a hole cut for something that has moved away.
   *
   * `capture: true` because scroll does not bubble. A card's inner scroller —
   * a chat log, a settings list — fires on that element, and the capture phase
   * is the only way one listener at the document sees all of them. `passive`
   * because this never calls `preventDefault`, so it must not make the reader's
   * scrolling wait on us.
   *
   * The frame's own viewport is usually `overflow:hidden` (the injected reset),
   * so the case this covers in practice is that inner scroller rather than the
   * document scrolling as a whole.
   */
  document.addEventListener('scroll', schedule, { capture: true, passive: true })

  /*
   * A finished transition or animation is the fourth way, and it was measured
   * rather than reasoned: the very first `regions` from one card read
   * `M -57 -23 H -12 V 23` — a button mid-slide, partly off the top-left corner
   * — and the clip only became right because that card happened to touch the
   * DOM again afterwards.
   *
   * A card whose button arrives with one transform transition and then sits
   * still has no such rescue: `transform` moves the rendered box without
   * changing layout, so no mutation and no resize follows it, and the clip
   * keeps a hole where the button *started*.
   *
   * **The end events only, deliberately.** They put the clip right for the
   * state that persists, which is the state someone clicks. Tracking the
   * in-between would mean measuring every animation frame for as long as any
   * card animates anything — and the recorded limitation of not doing it is
   * that a node still moving is clipped where it last settled, plus a node
   * animating *forever* (a pulsing badge) whose clip stays at its resting box.
   */
  for (const kind of ['transitionend', 'animationend'] as const) {
    document.addEventListener(kind, schedule, { capture: true, passive: true })
  }

  /*
   * And once more when the tab comes forward.
   *
   * Not only because the hidden path is throttled: a hidden tab may have
   * measured everything as zero-sized, and a card that laid itself out against
   * a viewport it never got would report rectangles that were right for the
   * measurement and wrong for the screen. Re-measuring on the transition is one
   * message and removes a whole class of "it only works if I was looking".
   */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    /*
     * **Twice: now, and again shortly after.**
     *
     * The immediate pass is not enough on its own, and this is the whole
     * mechanism of the bug it was written for. A frame built while the tab was
     * hidden has never been laid out, so its `documentElement.clientHeight` is
     * 0 and every `vh` length inside it resolves to 0. When the tab comes
     * forward the browser lays the frame out — but not necessarily before this
     * handler's animation frame runs, so the forced pass can still read the
     * same zeros, and then nothing schedules another: this reporter is
     * event-driven and one-shot per trigger, not a polling loop. A card that
     * builds its overlay once and never touches the DOM again would sit at a
     * zero-area clip for as long as the chat stays open, invisible and
     * unclickable, with the correct answer one measurement away.
     *
     * So a second pass, late enough to be after layout and forced so the
     * unchanged key cannot suppress it. The cost is one extra message per
     * foreground transition; the alternative is a card that only works if you
     * were already looking at it.
     */
    forceMeasure()
    setTimeout(forceMeasure, 500)
  })

  /*
   * And on a resize, forced.
   *
   * The frame gets one of these from the host when the shell hands it a new
   * viewport, and one from the browser when the window changes. Both are
   * moments when a `vh`-sized card's boxes become computable for the first
   * time, and the reading that prompted this had exactly that shape: empty at
   * first open, full-screen after the window height changed. Without the force
   * the recovery is measured and then discarded by the dedup whenever the clip
   * happens to hash the same.
   */
  document.defaultView?.addEventListener('resize', forceMeasure)

  // Once up front, so a card that builds everything before the first frame and
  // never touches the DOM again is still clipped correctly.
  schedule()
}


/**
 * Hand cards a stand-in whenever they build a nested iframe.
 *
 * A thin adapter on purpose. Everything that *decides* anything lives in
 * `nested-frame.ts` and arrives on the member table — fetched once per frame
 * rather than inlined into every frame's bootstrap. Importing it for real cost
 * **8.2 KiB per frame** and pulled `card-css.ts`'s whole scanner in behind it,
 * which is precisely the growth the table was split out to stop. What is left
 * here is the two things only this file has: the real `document`, and the
 * channel to the shell.
 * @param run - the frame's token, for reports.
 * @param post - the channel to the shell.
 * @param members - the fetched member table, which carries the stand-in.
 */
function virtualiseNestedFrames(
  run: string,
  post: (message: FromFrame) => void,
  members: MemberTable,
): void {
  members.virtualiseNestedFrames(document as unknown as NestedQueryHost, {
    createElement: tagName => document.createElement(tagName) as unknown as NestedNode,
    parseHtml: html => {
      /*
       * A `<template>` parses without running scripts and without adopting the
       * nodes into the live document. Its parser drops `<html>`, `<head>` and
       * `<body>` and keeps their children as siblings, so the split between
       * head and body is decided by tag name in `nested-frame.ts` rather than
       * by where a node came from — there is no longer any "where".
       */
      const template = document.createElement('template')
      template.innerHTML = html
      return [...template.content.children] as unknown as NestedNode[]
    },
    note: message => {
      post({ iris: run, type: 'note', scriptId: undefined, message })
    },
    refuse: (host, detail) => {
      // On the channel a real refusal takes, so a reader sees one kind of line
      // for one kind of event.
      post({ iris: run, type: 'blocked', host, directive: 'frame-src', detail })
    },
    soon: fn => {
      setTimeout(fn, 0)
    },
  })
}

/**
 * Write one scroll-decision property onto `html` or `body`, inline and
 * `!important`.
 *
 * Inline because the rule it has to beat is `!important` — the reset's
 * `overflow:hidden` is upstream's line, not ours to soften for everyone.
 * Change-gated, so a still card writes nothing: this runs on every
 * measurement, and an unconditional write would touch the style object (and
 * dirty the mutation observer's own picture of the document) each pass.
 * @param element - `documentElement` or `body`, the two chained scrollers.
 * @param property - the inline property this decision owns.
 * @param value - what the decision said; `''` removes the inline override and
 *   hands the axis back to the reset.
 */
function applyScrollStyles(
  element: HTMLElement,
  property: 'overflow-y' | 'overscroll-behavior',
  value: 'auto' | 'contain' | '',
): void {
  if (element.style.getPropertyValue(property) === value) return
  if (value === '') element.style.removeProperty(property)
  else element.style.setProperty(property, value, 'important')
}

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
  /**
   * The height we most recently asked the shell to apply.
   *
   * The loop-closer. Once the shell applies our reported height, the *next*
   * measurement legitimately reads it back — content that was 900px tall is
   * 900px tall in the 900px viewport we asked for — and a measurement equal to
   * the viewport used to fall through to the `sizing` announcement. The shell
   * answered `sizing` by removing the applied height, the content overflowed
   * again, the report re-armed, and the whole cycle ran every animation frame:
   * the right and bottom edges of four real cards flickered without end. What
   * breaks the loop is telling the decision apart: a measurement that matches
   * the viewport **and** matches what we asked for is our own echo, and echoes
   * are silence. `heightSignal` holds the rule; this frame only has to
   * remember the number and hand it over.
   *
   * `undefined` while nothing of ours is applied — before the first report, and
   * after a `sizing` announcement, whose shell-side answer removes the inline
   * height. Only our own reports go here: the shell's CSS starting height is
   * not ours, and mistaking it for an echo would strand a card that genuinely
   * cannot be measured before it ever said so.
   */
  let appliedHeight: number | undefined
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
     * The rulers, read **every** measurement — not only when a height report
     * is due. The scroll decision below runs on its own schedule from the
     * height signal's, and it needs the honest extent, which `bodyScroll`
     * alone does not tell: a card that pins its own `body` reports a
     * `scrollHeight` at or below its viewport while the range over its
     * contents runs 969px further (measured: `bodyScroll 100` against a
     * 1069px range). One `Range` over the body is the ruler that cannot be
     * pinned that way, and the diagnostics line already paid for it.
     */
    const viewport = document.documentElement.clientHeight
    const range = document.createRange()
    range.selectNodeContents(document.body)
    const bodyTop = document.body.getBoundingClientRect().top
    let childBottom = 0
    for (const child of document.body.children) {
      const bottom = child.getBoundingClientRect().bottom - bodyTop
      if (bottom > childBottom) childBottom = bottom
    }
    const rulers = {
      bodyScroll: pixels,
      docScroll: document.documentElement.scrollHeight,
      rangeHeight: range.getBoundingClientRect().height,
      childBottom,
    }
    range.detach()

    /*
     * **Whatever is past the frame's own viewport has to stay reachable — and
     * the frame's boundary has to stop the wheel.**
     *
     * The reset copies upstream's `overflow:hidden!important` on `html,body`,
     * which is safe *for upstream* because upstream writes
     * `frameElement.style.height` same-origin and synchronously — its frame is
     * always exactly content height, so there is never anything past the
     * viewport to reach. Iris posts the height instead, so there is always at
     * least one frame of lag — and, since the shell clamps the frame to the
     * visible band (`reading.css`), a clamped interface lives its whole life
     * with content past the viewport. `hidden` there means **gone**: not
     * clipped with a scrollbar, simply absent, and the wheel over it does
     * nothing because the document under the pointer has nowhere to scroll.
     *
     * This used to run only where the height signal said `height`, off
     * `bodyScroll` alone — which is exactly the measurement a card that pins
     * or clips itself lies about, so those frames kept the `hidden` and their
     * content stayed unreachable (measured: content 1069px in a 461px frame
     * with `overflow:hidden` still in force). The scroll answers a different
     * question than the height — *is the content reachable*, not *how tall
     * should the shell make us* — so it now runs on every measurement, off the
     * largest ruler (`overflowDecision`).
     *
     * And when scrolling exists, `containDecision` seals the boundary:
     * measured on a real card, a frame scrolled to its end handed every
     * further wheel notch to the reading column (68px → 146px of page scroll
     * over six notches). The containment is decided from the **range that
     * actually exists after the overflow applies** — read back here, one
     * layout flush later — because a zero-range scroller with `contain` would
     * swallow the wheel over a card that pinned itself to its viewport, and
     * *that* card's reader has to chain to the page to keep reading.
     */
    applyScrollStyles(document.documentElement, 'overflow-y', overflowDecision(contentExtent(rulers), viewport))
    applyScrollStyles(document.body, 'overflow-y', overflowDecision(contentExtent(rulers), viewport))
    const scrollRange = Math.max(
      document.documentElement.scrollHeight - document.documentElement.clientHeight,
      (document.body.scrollHeight - document.body.clientHeight) || 0,
    )
    const containment = containDecision(scrollRange)
    applyScrollStyles(document.documentElement, 'overscroll-behavior', containment)
    applyScrollStyles(document.body, 'overscroll-behavior', containment)

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
    const signal = heightSignal(pixels, viewport, sizingReported, appliedHeight)
    if (signal.kind === 'silent') return
    if (signal.kind === 'sizing') {
      sizingReported = true
      // The shell answers by removing the inline height, so nothing of ours is
      // applied any more — recorded, or the post-removal measurement would be
      // mistaken for an echo and a genuinely unmeasurable card would never
      // reach the announcement at all.
      appliedHeight = undefined
      post({ iris: run, type: 'sizing', mode: 'viewport' })
      return
    }

    /*
     * Re-armed on every real height, so a card whose next screen clips itself
     * can say so again. The decision lives in `heightSignal`; this only carries
     * the flag it reads — and the number, which is what turns the *next*
     * measurement's agreement with the viewport into a recognised echo rather
     * than a second announcement.
     */
    sizingReported = false
    appliedHeight = signal.pixels
    post({ iris: run, type: 'height', pixels: signal.pixels })

    /*
     * Every height this frame can see, reported when it changes.
     *
     * Diagnostic, and it stays: "the card is taller than its frame and the
     * frame does not know" is a fault this project has now hit twice, from two
     * different causes, and both times the missing thing was **which measure
     * moved**. Capped and change-gated, so a still card is silent and a busy
     * one cannot flood the panel. The rulers were read above for the scroll
     * decision; this only formats them.
     */
    if (reportsLeft > 0) {
      const line = describeHeightSources({
        resizes,
        mutations,
        bodyScroll: rulers.bodyScroll,
        docScroll: rulers.docScroll,
        docClient: viewport,
        bodyRect: document.body.getBoundingClientRect().height,
        rangeHeight: rulers.rangeHeight,
        childBottom: rulers.childBottom,
      })
      if (line !== lastReported) {
        lastReported = line
        reportsLeft -= 1
        post({ iris: run, type: 'note', scriptId: undefined, message: line })
      }
    }

    /*
     * There is deliberately no second scroll decision here. One used to follow
     * the report, asking the same question of `body.scrollHeight` alone - the
     * ruler a self-pinning card lies to - and where the honest extent above had
     * said `auto` it took the scroll back off in the same pass, leaving the
     * reset's `overflow:hidden` in force on exactly the cards the extent path
     * was written for. The decision lives once, above, before `heightSignal`'s
     * early returns; `frame-scroll.test.ts` pins that there is one.
     */
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    /*
     * **And a timer beside the `rAF`, because there is a state where `rAF`
     * does not run at all — measured, in this project's own headless
     * harness: every sandboxed frame of a chat sat `document.hidden === false`
     * with a queued `requestAnimationFrame` that never fired, so a card whose
     * interface builds its DOM *after* the bootstrap's one synchronous `send`
     * never got a second measurement, and lived at the starting height with
     * the reset's `overflow:hidden` still in force.** `reportRegions` already
     * carries this exact rescue for the same class of fixed point (a frame
     * that never paints produces no animation frame to schedule from); the
     * height reporter needed it too. The timer is cancelled by the `rAF` path
     * it rescues (`send` clears `scheduled`), so a painting frame pays one
     * no-op timeout per schedule and nothing more. The interval is
     * `reportRegions`'s, for the same reason: it bounds how long a laid-out
     * interface stays unsized, not how fast anything animates.
     */
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(send)
      setTimeout(() => {
        if (scheduled) send()
      }, 500)
    } else setTimeout(send, 500)
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

/** The last viewport applied, so a re-push that changes nothing stays silent. */
let appliedViewport: { width: number, height: number } | undefined

/**
 * Publish the viewport height as the custom property card CSS reads.
 *
 * `--TH-viewport-height` is upstream's name and is kept verbatim: card stylesheets
 * reference it by that spelling, and a compatibility layer that renames what it
 * is compatible with is not one.
 *
 * **A changed viewport also dispatches `resize` in here.** Upstream's cards run
 * in the page, so a window resize reaches them as an event on their own
 * `window`; here the size arrives as a message, and a card listening for
 * `resize` — which is how a card that positions things itself finds out — would
 * never hear one. The custom property alone only reaches cards whose layout is
 * CSS.
 *
 * **Recorded limitation:** this moves the cards that *listen*. A card that read
 * the viewport once, computed pixel positions from it and stored them stays
 * where it was; nothing short of re-running it would move those, and re-running
 * a card because the window changed shape is not a trade this makes.
 *
 * Silent unless the size actually changed, which also skips the first push: it
 * arrives before any card body has evaluated, so there is nothing listening yet
 * and a `resize` before load would only be noise in a card's own log.
 * @param size - the host viewport as the shell reported it.
 */
function applyViewport(size: { width: number, height: number }): void {
  document.documentElement.style.setProperty('--TH-viewport-height', `${size.height}px`)
  const changed =
    appliedViewport !== undefined
    && (appliedViewport.width !== size.width || appliedViewport.height !== size.height)
  appliedViewport = { width: size.width, height: size.height }
  if (!changed) return
  try {
    window.dispatchEvent(new Event('resize'))
  } catch {
    // A realm without `Event`. The property above is already set, so a
    // CSS-driven card is unaffected — this only costs the listeners.
  }
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
  /**
   * The frame a thrown value came from, for the paths that are handed the value.
   *
   * The `threw` path already appends this; the window-error and
   * unhandled-rejection paths did not, and they are the ones with **no script
   * attribution at all** — a callback's stack, no card body, nothing but the
   * message. So they are where a location is worth the most, and they were the
   * two that lacked it.
   * @param value - whatever arrived.
   * @returns ` at <frame>`, or the empty string.
   */
  const stackOf = (value: unknown): string => topFrame(value)

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
        describeFailure(kind, stackOf(detail) === '' ? text : `${text}${stackOf(detail)}`, {
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
/**
 * The card-facing member table, fetched once per page.
 *
 * It arrives as a **synchronous blocking** `<script src>` placed before this
 * inlined block, so by the time any line below runs it is either present or
 * definitively absent — that ordering is `srcdoc.ts`'s guarantee, and it is why
 * nothing here waits.
 *
 * Read at module scope because the reporters below are module-level functions
 * and need it too.
 */
const memberTable = (globalThis as unknown as Record<string, unknown>)[MEMBERS_GLOBAL] as
  MemberTable | undefined

/** Whether the table finished evaluating, from the marker it sets last. */
const membersReady =
  (globalThis as unknown as Record<string, unknown>)[MEMBERS_MARKER] === true
  && memberTable !== undefined

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
   * But [notes/apps/iris-web/OVERLAY-CARDS.md] found a third class of card that draws *into* the
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
    /*
     * Everything about this message is decided in `blocked-report.ts`, which
     * needs neither a document nor a policy to fire — and which is therefore the
     * only part of it that can be tested. This line used to copy fields across
     * by hand and dropped one silently; now the only two things it contributes
     * are the ones it alone knows: the event, and where we are.
     */
    post(blockedMessageFor(run, event, shellOrigin()))
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
  /*
   * The member table, fetched once per page and read here.
   *
   * It arrives as a **synchronous blocking** `<script src>` placed before this
   * inlined block, so by the time anything below runs it is either present or
   * definitively absent. That ordering is `srcdoc.ts`'s to guarantee and it is
   * the reason no waiting is needed here.
   */
  /*
   * Without the table there is a frame and no surface, and the response is to
   * **refuse to run card bodies** rather than run them against an empty one.
   *
   * Running would produce a `ReferenceError` for every member a card touches,
   * each attributed to the card. This project has already shipped a frame that
   * reported nine missing library names when the truth was one blocked script,
   * and that cost a verification round; one named refusal is shorter and
   * actionable ("check the members asset and the manifest").
   *
   * For an **interface** frame the card's markup has already parsed and cannot
   * be held back, so this cannot prevent anything there — what it does is put
   * the attribution ahead of the errors it is about to cause.
   */
  if (!membersReady || memberTable === undefined) {
    /*
     * **Thrown, not posted-and-returned**, and the channel is the point.
     *
     * This runs inside the entry's own `try`, whose `catch` reports a
     * **bootstrap error** — and that is exactly what this is. The frame has not
     * failed to do something a card asked for; it has failed to come up. The
     * panel's phase for that reads "never started: …", which is the sentence a
     * reader can act on, and it lands the message on the one path that already
     * knows how to report before a run token means anything.
     *
     * Posting a card error and returning would put it under a heading about
     * scripts that did not start, which is the misattribution this project has
     * paid for twice.
     */
    throw new Error(
      'the member table did not arrive, so nothing a card calls exists in this frame'
      + ' \u2014 the script that carries it was blocked, failed to parse, or threw partway.'
      + ' Card scripts were not run; anything a card\u2019s inline markup has already'
      + ' reported comes from that markup, not from the card being wrong.',
    )
  }
  const members: MemberTable = memberTable

  installSandbox({
    members,
    /*
     * Read from the document here, because `frame.ts` is injected with
     * everything it needs and knows nothing about the document it lands in. The
     * attribute is set by `srcdoc.ts` on the body of a frame that carries card
     * markup.
     */
    interfaceFrame: document.body?.hasAttribute('data-iris-interface') === true,
    /*
     * The frame's own document, not the shell's — `document.URL` here is
     * `about:srcdoc`, and answering with the shell's URL would hand a card a
     * fact about the page it is isolated from. Visibility is the exception in
     * kind rather than in source: a srcdoc frame inherits the page's visibility,
     * so "is the reader looking?" is answered correctly by reading it here.
     */
    pageState: () => ({
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      url: document.URL,
    }),
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
  // The frame's own head, handed over for the same reason the body is: it is
  // this card's own document, and `parent.document.head` is where a script
  // that finished mounting injects its stylesheet.
  ...(document.head === null ? {} : { head: document.head }),
  // The same document as an event target: a script that walks `window.parent`
  // outwards lands its `hostDocument` here and delegates page-level `click` and
  // `change` through it. The frame's document is the only page those events
  // happen in, so it is the only honest bus for them.
  eventTarget: document,
  // What relative fetches resolve against. For a srcdoc frame `baseURI` is the
  // shell page's URL, so the bridge resolves a card's `fetch('/x')` the same
  // way the browser would have.
  baseUrl: document.baseURI,
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
  /**
   * The same accessor upstream's `predefine.js` installs, empty setter included.
   *
   * Separate from `defineForwarding` because the setter is the difference and it
   * is not a detail. `predefine.js:36-44` writes `set () {}`, so a card
   * assigning the name is silently ignored; `waitGlobalInitialized` writes a
   * getter alone, so the same assignment throws in a module's strict mode. Both
   * are upstream, at different sites, and folding them into one door with a flag
   * would file that difference where nobody reads it.
   */
  definePredefined: (name, read) => {
    try {
      Object.defineProperty(window, name, { get: read, set: () => {}, configurable: true })
    } catch {
      post({
        iris: run,
        type: 'error',
        scriptId: undefined,
        message: `could not predefine "${name}" in this frame from the card's shared namespace`,
      })
    }
  },

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
    host['toastr'] = members.createReportingToastr(report)
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

  /*
   * Without the table there is a frame and no surface, and the response is to
   * **refuse to run card bodies** rather than run them against an empty one.
   *
   * Running would produce a `ReferenceError` per member a card touches, every
   * one of them attributed to the card — this project has already shipped a
   * frame that reported nine missing library names when the truth was one
   * blocked script, and that cost a verification round. One named refusal is
   * both shorter and actionable ("check the members asset and the manifest").
   *
   * For an **interface** frame the card's markup has already parsed and cannot
   * be held back, so the refusal cannot prevent anything — what it does there is
   * put the attribution first, ahead of the errors it is about to cause.
   */
  reportAsyncFailures(run, post, () => bodyStarted)
  /*
   * Only where there is a surface to clip. An interface frame is laid out inside
   * the reading column and catches clicks over its own box, which is already
   * right; a script frame covers the viewport and would swallow the shell.
   */
  if (document.body?.hasAttribute('data-iris-interface') !== true) {
    reportRegions(run, post, members)
  }
  /*
   * After `installSandbox` and before any card body: the sandbox's own frame
   * element is already built by now, so it stays a real `<iframe>`, and every
   * iframe a *card* builds from here on is a stand-in.
   */
  virtualiseNestedFrames(run, post, members)
  reportBlocked(run, post)
  reportStorage(run, post)
  reportBodySummary(run, post)
  reportHeight(run, post)
  // Read here rather than captured earlier: the attribute is on the body the
  // document was built with, and this is the one decision the handshake timing
  // turns on — see `announceReady` for which side waits for what.
  announceReady(run, post, document.body?.hasAttribute('data-iris-interface') === true)
} catch (error: unknown) {
  // Same reasoning: an install that throws is invisible from the outside, and
  // "nothing happened" is the most expensive answer a sandbox can give.
  fail(error)
  throw error
}
