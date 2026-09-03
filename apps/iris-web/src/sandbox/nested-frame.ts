/**
 * A stand-in for a nested iframe, because a real one cannot be reached into.
 *
 * **The browser fact this exists for, measured with a control.** Inside a
 * sandboxed srcdoc frame — which is every card frame — a nested iframe's
 * `contentDocument` is `null` for all four ways of making one (no `src`,
 * `about:blank`, `srcdoc`, a remote URL). A control frame carrying *no* CSP at
 * all answers `null` the same four ways and logs zero violations, so this is
 * **not** something Iris's policy did: each opaque origin is unique, so a
 * nested frame is cross-origin to its own parent and unreachable by
 * construction. Virtualisation is the only way a card that builds an overlay
 * frame can work at all, rather than a workaround for a choice we made.
 *
 * What the policy *does* refuse is exactly one case: a remote `src`
 * (`frame-src 'none'`, and a network grant does not widen it). No `src`,
 * `about:blank` and `srcdoc` are all allowed to exist. So a `src` assignment is
 * answered with a reported refusal rather than with a real nested frame: a real
 * one would reproduce the same refusal, one browsing context later.
 *
 * **What a card actually does with the frame** decides everything here, and it
 * is measured rather than imagined (`TEST-CARDS.md` §7.8, the overlay card's
 * `RA` class):
 *
 * - `document.createElement('iframe')`, then `srcdoc = '…'`, then append.
 * - `contentDocument.head` is kept as `targetHead`, and its **`ownerDocument`**
 *   is what the card calls `createElement` on. A stand-in that answers
 *   `contentDocument` but not `head.ownerDocument.createElement` passes every
 *   test one would think to write and still leaves the panel unstyled.
 * - `targetHead.querySelectorAll('style[data-style-sync]')` before each sync.
 * - `document.styleSheets` — the *frame's own* sheets — are read and copied in,
 *   which is why the card's CSS has to be re-pointed (`nested-css.ts`) rather
 *   than moved into a shadow root: styles a shadow root holds are not in
 *   `document.styleSheets`, so the card's collection would come back **empty**
 *   and the panel would mount with no styles at all. Both of that card's
 *   failure paths are silent — `sync()` is wrapped in `catch {}`.
 * - a reuse scan over `querySelectorAll('iframe')` keyed on
 *   `t.srcdoc.includes('viewport-fit=cover')`, so `srcdoc` must read back as
 *   the string the card assigned.
 *
 * Built over an injected DOM rather than reaching for globals, so the decisions
 * here are testable without a browser — the pattern `virtual-document.ts` uses,
 * and for the same reason: the parts that were wrong before were decisions, not
 * plumbing.
 *
 * @module iris-web/sandbox/nested-frame
 */

import { repointFrameCss, type FrameStandInIds } from './nested-css.ts'

/** The DOM operations a stand-in needs from its host document. */
export interface NestedFrameEnv {
  /** Make a real element, so the card's own DOM work behaves normally. */
  createElement: (tagName: string) => NestedNode
  /**
   * Parse the card's markup into a flat list of top-level nodes.
   *
   * Flat, not split into head and body, because **there is no split to
   * report**: a `<template>`'s parser drops `<html>`, `<head>` and `<body>` and
   * leaves their children as siblings. An env that claimed to return the two
   * groups would be inventing a distinction the parser had already discarded,
   * so the decision is made here, from tag names, where it can be tested.
   */
  parseHtml: (html: string) => NestedNode[]
  /** Report something a reader needs, as a note rather than a fault. */
  note: (message: string) => void
  /** Report a refusal: the host to name, and the detail to follow it. */
  refuse: (host: string, detail: string) => void
  /** Run a callback after the current task, for the synthesised `load`. */
  soon: (run: () => void) => void
}

/**
 * The document whose query paths are patched so stand-ins can be found.
 *
 * Separate from `NestedFrameEnv` because it is the one thing here that is not
 * injectable in spirit: it is the frame's own `document`, and patching it is the
 * point. Named as a narrow interface anyway so a test can pass a fake.
 */
export interface NestedQueryHost {
  createElement: (tagName: string, options?: unknown) => unknown
  querySelector: (selector: string) => unknown
  querySelectorAll: (selector: string) => ArrayLike<unknown>
  getElementsByTagName: (name: string) => ArrayLike<unknown>
}

/**
 * Tags that belong in a head rather than in the visible body.
 *
 * Named explicitly rather than by exclusion: a card's `<div>` belongs in the
 * body, and guessing the other way round would put a whole interface inside a
 * hidden head — a panel that mounts and cannot be seen, which is this module's
 * signature failure.
 */
const HEAD_TAGS: readonly string[] = ['STYLE', 'LINK', 'META', 'TITLE', 'BASE', 'SCRIPT']

/** The parts of an element this module touches. */
export interface NestedNode {
  tagName?: string
  id?: string
  textContent?: string | null
  style?: Record<string, string>
  appendChild?: (child: NestedNode) => unknown
  append?: (...children: NestedNode[]) => unknown
  remove?: () => unknown
  setAttribute?: (name: string, value: string) => unknown
  querySelector?: (selector: string) => NestedNode | null
  querySelectorAll?: (selector: string) => NestedNode[]
  addEventListener?: (type: string, handler: (event: unknown) => void) => unknown
  ownerDocument?: unknown
  [key: string]: unknown
}

/** How many stand-ins have been made, for ids and keyframe names. */
let made = 0

/**
 * A document stand-in over two real elements.
 *
 * `head` and `body` are real nodes in the host document, so a card appending a
 * `<style>` or a `<div>` to either is doing ordinary DOM work that ordinary
 * layout and ordinary `querySelector` can see. Only the *document-level* API is
 * synthesised, and only the members a card was measured to use — an object with
 * fifty plausible members would be fifty claims, most of them untested.
 *
 * @param env - the host DOM.
 * @param html - the element standing in for `html`.
 * @param head - the element standing in for `head`.
 * @param body - the element standing in for `body`.
 * @param ids - the stand-in ids, for re-pointing CSS.
 * @param seq - this frame's identity, for keyframe renaming.
 * @returns the document stand-in.
 */
function documentStandIn(
  env: NestedFrameEnv,
  html: NestedNode,
  head: NestedNode,
  body: NestedNode,
  ids: FrameStandInIds,
  seq: string,
): Record<string, unknown> {
  const listeners = new Map<string, ((event: unknown) => void)[]>()

  /**
   * Install a `<style>`, with its CSS re-pointed and confined first.
   *
   * The interception is here rather than at the element, because this is where
   * the card's text arrives: it builds the node with `createElement('style')`,
   * fills `textContent`, and appends. Rewriting on append is the last moment
   * the text is still ours to change.
   * @param node - the style element the card built.
   */
  const installStyle = (node: NestedNode): void => {
    const text = typeof node.textContent === 'string' ? node.textContent : ''
    if (text === '') return
    const scoped = repointFrameCss(text, ids, seq)
    node.textContent = scoped.css
    if (scoped.refused.length > 0) {
      env.note(`overlay frame CSS: ${scoped.refused.join(', ')} refused`)
    }
  }

  const standIn: Record<string, unknown> = {
    /*
     * `documentElement`, `head` and `body` are the three a card reaches for
     * without checking, and all three are real elements.
     */
    documentElement: html,
    head,
    body,
    /*
     * The card creates its nodes through the document it was given — and for
     * the overlay card, through `targetHead.ownerDocument`, which is this. A
     * stand-in whose `createElement` was missing would leave `sync()` throwing
     * into its own `catch {}`: styles never installed, nothing reported.
     */
    createElement: (tagName: string): NestedNode => {
      const node = env.createElement(tagName)
      /*
       * A style built through this document is re-pointed when it lands, not
       * now: its text does not exist yet. The mark is what `appendChild` below
       * looks for, so a `<style>` the card moves between heads is rewritten
       * once rather than on every move.
       */
      if (String(tagName).toLowerCase() === 'style') node['irisPendingStyle'] = true
      return node
    },
    createTextNode: (data: string): NestedNode => {
      const node = env.createElement('span')
      node.textContent = data
      return node
    },
    querySelector: (selector: string): NestedNode | null =>
      html.querySelector?.(selector) ?? null,
    querySelectorAll: (selector: string): NestedNode[] =>
      html.querySelectorAll?.(selector) ?? [],
    getElementById: (id: string): NestedNode | null =>
      html.querySelector?.(`#${id}`) ?? null,
    /*
     * Events are collected but the document stand-in is not a real event
     * target, so `DOMContentLoaded` and `load` are **synthesised** by the
     * element that owns this document — see `dispatch` below. A card that waits
     * for one of those before drawing is common enough that not answering it
     * would look exactly like a card that had crashed.
     */
    addEventListener: (type: string, handler: (event: unknown) => void): void => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler])
    },
    removeEventListener: (type: string, handler: (event: unknown) => void): void => {
      listeners.set(type, (listeners.get(type) ?? []).filter(it => it !== handler))
    },
    /** Deliver a synthesised document event. Not part of the DOM surface. */
    irisDispatch: (type: string): void => {
      for (const handler of listeners.get(type) ?? []) {
        try {
          handler({ type, target: standIn })
        } catch {
          // A card's own listener threw. Its problem, and reported through the
          // frame's ordinary error channel rather than swallowed here.
        }
      }
    },
    /** Re-point and confine a style element the card is installing. */
    irisInstallStyle: installStyle,
    /*
     * `null`, because the card's own document is where this ends. Answering
     * with the real frame document would hand a card a route from its
     * virtualised overlay back into the frame's real `html`, which is the one
     * place the confinement above cannot follow it.
     */
    defaultView: null,
  }

  /*
   * **The head intercepts what is appended to it, and this is the main path.**
   *
   * The measured card does `targetHead.ownerDocument.createElement('style')`,
   * fills `textContent`, and calls `targetHead.appendChild(style)`. The head is
   * a real element, so without this the append is an ordinary one and the
   * card's CSS lands **unconfined** — `html,body{…}` reaching the frame's real
   * document and `*{…}` reaching the shell's nodes. Rewriting at
   * `createElement` time cannot work: the text does not exist yet.
   *
   * `append` as well as `appendChild`, because they are interchangeable at the
   * call site and a card using the other one would be silently unconfined —
   * the difference between the two is not something a card author thinks about.
   */
  for (const method of ['appendChild', 'append'] as const) {
    const original = head[method]
    if (typeof original !== 'function') continue
    const bound = (original as (...nodes: NestedNode[]) => unknown).bind(head)
    try {
      Object.defineProperty(head, method, {
        configurable: true,
        value: (...nodes: NestedNode[]): unknown => {
          for (const node of nodes) {
            if (String(node?.tagName).toLowerCase() === 'style') installStyle(node)
          }
          return bound(...nodes)
        },
      })
    } catch {
      // A host that will not take the shadow: the append still works, and the
      // CSS is confined only on the paths that route through this module.
    }
  }

  // A card reads `ownerDocument` off a node it is holding and creates through
  // it. All three point back here, which is what makes that path work.
  for (const node of [html, head, body]) {
    try {
      Object.defineProperty(node, 'ownerDocument', { value: standIn, configurable: true })
    } catch {
      // A host where the property cannot be shadowed. The document stand-in is
      // still reachable as `contentDocument`, so only the indirect path is lost.
    }
  }

  return standIn
}

/** A nested frame stand-in and the pieces its owner needs. */
export interface NestedFrame {
  /** The element the card was handed, which is what it styles and appends. */
  element: NestedNode
  /** The document it will find on `contentDocument`. */
  document: Record<string, unknown>
  /** The ids the CSS was re-pointed onto. */
  ids: FrameStandInIds
}

/**
 * Build one nested-frame stand-in.
 *
 * @param env - the host DOM.
 * @returns the element, its document, and the ids used to confine its CSS.
 */
export function createNestedFrame(env: NestedFrameEnv): NestedFrame {
  made += 1
  const seq = `nf${made}`
  const ids: FrameStandInIds = { html: `iris-${seq}-html`, body: `iris-${seq}-body` }

  /*
   * **Two levels, standing for `html` and `body`.** A card's height chain is
   * `html,body,#app{height:100%}`, and a percentage height needs a definite
   * height on every ancestor between it and the frame — collapse the two into
   * one wrapper and `#app` measures against `auto`, which is a panel that
   * mounts and cannot be seen. The names are not decoration: `nested-css.ts`
   * rewrites the card's `html` and `body` selectors onto exactly these ids.
   */
  const html = env.createElement('div')
  const body = env.createElement('div')
  const head = env.createElement('div')
  html.id = ids.html
  body.id = ids.body
  head.setAttribute?.('data-iris-frame-head', '')
  /*
   * The head is present but never rendered. A card puts `<style>` and `<link>`
   * in it and expects neither to occupy space, and a `<div>` full of styles
   * would otherwise be a blank box above the content.
   */
  if (head.style !== undefined) head.style['display'] = 'none'
  if (html.style !== undefined) {
    html.style['display'] = 'block'
    html.style['height'] = '100%'
  }
  if (body.style !== undefined) {
    body.style['display'] = 'block'
    body.style['height'] = '100%'
    body.style['margin'] = '0'
  }
  html.appendChild?.(head)
  html.appendChild?.(body)

  const document = documentStandIn(env, html, head, body, ids, seq)

  /*
   * The element the card holds. A real `<div>`, because the card styles it,
   * appends it, and reads its `style` — all of which a real element does
   * correctly and a synthesised object does not.
   *
   * **Two known gaps, both geometric, both unverified.** They are written here
   * rather than fixed because neither can be checked yet: in-frame geometry is
   * unreadable while the tab is hidden (`METHODS.md` §二十三), and a fix built
   * against a reading of `0` is a fix built against nothing.
   *
   * 1. **No intrinsic size.** An `<iframe>` is a replaced element and is
   *    300×150 with no styling at all; a `<div>` is `auto`, which collapses to
   *    zero height. So a card that appends its frame and styles it only from a
   *    stylesheet — or not at all — gets a box upstream would have given a
   *    default size. Not fixed with an inline `width`/`height`, because inline
   *    beats the card's own stylesheet and would break the cards that *do*
   *    size it; the honest fix is a rule in the frame's reset that card CSS can
   *    override, which needs the geometry to verify.
   * 2. **A card's own `iframe { … }` rule does not match this.** Page-level CSS
   *    in the script frame — `iframe{width:100%;height:100%;border:0}` is a
   *    common idiom — selects by element type and a stand-in is a `div`.
   *    `nested-css.ts` re-points selectors in the CSS a card installs *into*
   *    the stand-in, which is a different sheet; catching the card's own
   *    document styles would need intercepting them too, a much larger
   *    mechanism than this one.
   */
  const element = env.createElement('div')
  element.setAttribute?.('data-iris-nested-frame', seq)
  element.appendChild?.(html)

  let srcdoc = ''
  const loadListeners: ((event: unknown) => void)[] = []

  /** Deliver the synthesised `load`, to the element and to its document. */
  const fireLoad = (): void => {
    ;(document['irisDispatch'] as (type: string) => void)('DOMContentLoaded')
    ;(document['irisDispatch'] as (type: string) => void)('load')
    for (const handler of [...loadListeners]) {
      try {
        handler({ type: 'load', target: element })
      } catch {
        // The card's listener threw; not this module's to report.
      }
    }
    const onload = element['onload']
    if (typeof onload === 'function') {
      try {
        ;(onload as (event: unknown) => void)({ type: 'load', target: element })
      } catch { /* as above */ }
    }
  }

  const define = (name: string, descriptor: PropertyDescriptor): void => {
    try {
      Object.defineProperty(element, name, { configurable: true, ...descriptor })
    } catch {
      // A host that will not take the shadow. Reported by the absent behaviour
      // rather than by a throw: a card whose frame did not virtualise fails the
      // way it would have failed anyway.
    }
  }

  /*
   * `tagName` reads `IFRAME` so a card's own `tagName === 'IFRAME'` check
   * passes. It does **not** make `querySelectorAll('iframe')` match — that
   * goes by element type, not by this property — so the frame's document query
   * paths append stand-ins separately. Both are needed and neither substitutes
   * for the other.
   */
  define('tagName', { get: () => 'IFRAME' })
  define('contentDocument', { get: () => document })
  /*
   * `contentWindow` is a small stand-in rather than the frame's real window.
   * The measured consumer is a card broadcasting `postMessage` to every iframe
   * it can find; handing back the real window would deliver a card's message to
   * the frame's own bus, where the sandbox is listening.
   */
  define('contentWindow', {
    get: () => ({
      document,
      postMessage: (data: unknown): void => {
        ;(document['irisDispatch'] as (type: string) => void)('message')
        env.note(`overlay frame received a message: ${typeof data}`)
      },
    }),
  })
  define('srcdoc', {
    get: () => srcdoc,
    set: (value: unknown) => {
      /*
       * Stored **as written**, because a card reads it back to recognise its
       * own frames: the overlay card's reuse scan is
       * `t.srcdoc.includes('viewport-fit=cover')`. A stand-in that rendered the
       * HTML but did not keep the string would fail that scan, and the card's
       * re-entry guard would then make the second mount do nothing at all —
       * which reads as "the overlay stopped working" rather than as a miss.
       */
      srcdoc = String(value)
      for (const node of env.parseHtml(srcdoc)) {
        if (HEAD_TAGS.includes(String(node.tagName).toUpperCase())) {
          // Through the head's own append, so a `<style>` arriving this way is
          // re-pointed by the same code that handles one appended later. Two
          // paths installing CSS, one of them confined, is how a card ends up
          // styled in one frame and not in the next.
          head.appendChild?.(node)
        } else {
          body.appendChild?.(node)
        }
      }
      /*
       * `load` is synthesised on a later task, never synchronously. A real
       * frame's `load` cannot arrive before the assignment returns, so a card
       * that sets `srcdoc` and *then* attaches its handler — the ordinary
       * order — would miss a synchronous one and wait forever.
       */
      env.soon(fireLoad)
    },
  })
  define('src', {
    get: () => '',
    set: (value: unknown) => {
      /*
       * Refused, and said out loud. `frame-src 'none'` refuses every remote
       * frame and a network grant does not widen it, so a real nested frame
       * here would reproduce this same refusal one browsing context later —
       * the coordinator's ruling, and the reason there is no real-iframe branch.
       * Reporting it is the whole value: a card whose frame silently never
       * loaded looks like a card with a bug.
       */
      env.refuse(String(value), 'a nested frame may not load a URL (frame-src)')
    },
  })

  const originalAdd = element.addEventListener?.bind(element)
  define('addEventListener', {
    value: (type: string, handler: (event: unknown) => void): void => {
      if (type === 'load') {
        loadListeners.push(handler)
        return
      }
      originalAdd?.(type, handler)
    },
  })

  return { element, document, ids }
}

/**
 * Hand a frame's cards a stand-in whenever they build a nested iframe.
 *
 * **Called after `installSandbox`, and the order is load-bearing.** The sandbox
 * builds one real `<iframe>` of its own — the element standing for *this* frame,
 * which a card's frame enumeration has to find — and patching `createElement`
 * before that would hand the sandbox a stand-in of itself. The order is the
 * whole difference between the two mechanisms coexisting and one eating the
 * other.
 *
 * Two patches, and **neither substitutes for the other**:
 *
 * - `createElement('iframe')` returns the stand-in, so the card styles it,
 *   appends it, writes `srcdoc` and reads `contentDocument` — the paths that
 *   would otherwise hand it `null`.
 * - the query paths append stand-ins when a selector asks for iframes, because
 *   a stand-in is a `<div>`: `querySelectorAll('iframe')` matches by element
 *   type, not by the `tagName` the stand-in reports. Twelve measured sites
 *   depend on that query, including the overlay card's own reuse scan.
 *
 * @param host - the frame's own document, whose paths are patched.
 * @param env - the host DOM and the report channels.
 */
export function virtualiseNestedFrames(host: NestedQueryHost, env: NestedFrameEnv): void {
  const standIns: NestedNode[] = []

  const realCreate = host.createElement.bind(host)
  try {
    Object.defineProperty(host, 'createElement', {
      configurable: true,
      value: (tagName: string, options?: unknown): unknown => {
        if (String(tagName).toLowerCase() !== 'iframe') return realCreate(tagName, options)
        const frame = createNestedFrame(env)
        standIns.push(frame.element)
        return frame.element
      },
    })
  } catch {
    /*
     * A realm that will not take the shadow. Returned rather than pressed on
     * with: without the element patch there are no stand-ins to find, so
     * patching the queries would add a search for nothing. Cards then get a
     * real nested frame and see `null` — the state this virtualises, reported
     * by the card's own failure rather than hidden behind a half-install.
     */
    env.note('nested frames are not virtualised: this realm would not replace createElement')
    return
  }

  /**
   * Whether a selector's last step asks for an iframe.
   *
   * Only the last step, and only per comma-separated selector: `div iframe` and
   * `.a, iframe` both ask for one, while `iframe > div` asks for a `div`.
   * @param selector - the selector as written.
   * @returns true when a stand-in would belong in the answer.
   */
  const asksForFrames = (selector: string): boolean =>
    selector.split(',').some(part => {
      const last = part.trim().split(/[\s>+~]+/).pop()
      return last === 'iframe'
    })

  /**
   * The stand-ins currently in the document.
   *
   * A card that built a frame and removed it must not keep finding it — the
   * overlay card's reuse scan would then recognise a frame that is gone and
   * take its reuse branch instead of building a new one, which its re-entry
   * guard turns into "the overlay silently stopped appearing".
   * @returns the attached stand-ins, in the order they were created.
   */
  const attached = (): NestedNode[] =>
    standIns.filter(node => {
      try {
        return (node as unknown as { isConnected?: boolean }).isConnected !== false
      } catch {
        // No `isConnected` in this realm. Counted as present: a stand-in the
        // card built and has not removed is one it expects to find.
        return true
      }
    })

  const realAll = host.querySelectorAll.bind(host)
  const realTags = host.getElementsByTagName.bind(host)
  const realOne = host.querySelector.bind(host)
  try {
    Object.defineProperty(host, 'querySelector', {
      configurable: true,
      value: (selector: string): unknown => {
        /*
         * The document's own answer wins. Only when it has none does a stand-in
         * take the slot — a single-result query cannot be appended to, so the
         * choice is between the real frame the sandbox put there and the card's
         * own, and the real one is what every other query path returns first.
         */
        const found = realOne(selector)
        if (found !== null && found !== undefined) return found
        return asksForFrames(selector) ? attached()[0] ?? null : found
      },
    })
    Object.defineProperty(host, 'querySelectorAll', {
      configurable: true,
      value: (selector: string): unknown => {
        /*
         * Appended to what the document found, never replacing it. The
         * sandbox's own frame element is a *real* iframe and has to keep being
         * found, and a card indexing `[0]` should still reach a node the
         * document actually holds.
         */
        const found = [...Array.from(realAll(selector))] as NestedNode[]
        return asksForFrames(selector) ? [...found, ...attached()] : found
      },
    })
    Object.defineProperty(host, 'getElementsByTagName', {
      configurable: true,
      value: (name: string): unknown => {
        const found = [...Array.from(realTags(name))] as NestedNode[]
        return String(name).toLowerCase() === 'iframe' ? [...found, ...attached()] : found
      },
    })
  } catch {
    // The elements are still working stand-ins; only *discovery* is lost, so a
    // card that enumerates frames finds the sandbox's own and not its.
    env.note('nested frames are virtualised, but this realm would not let frame queries be patched')
  }
}

/** Reset the stand-in counter. For tests, so ids are predictable. */
export function resetNestedFrameCounter(): void {
  made = 0
}
