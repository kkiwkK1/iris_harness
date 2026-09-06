/**
 * Which parts of a full-viewport card frame are allowed to catch a click.
 *
 * A card that builds its interface on the host's body — a floating button, a
 * phone UI, a full-screen forum overlay — needs a surface that **is** the
 * viewport, because its CSS says `100dvh` and `position:fixed` and
 * `env(safe-area-inset-*)`, all of which resolve against the frame's own
 * viewport rather than against any variable we could rewrite. So the frame is
 * full-viewport.
 *
 * That creates a problem upstream does not have. Upstream's card nodes live in
 * the host document, so only the nodes themselves catch events. Ours live in a
 * frame, and **the browser hit-tests the frame element before anything inside
 * it** — measured in a real opaque-origin frame:
 *
 * ```
 * frame pointer-events:auto   → the frame catches every click, everywhere
 * frame pointer-events:none   → clicks pass through, and the card's own nodes
 *                               CANNOT re-enable themselves
 * frame auto + clip-path      → inside the clip the frame catches; outside it
 *                               passes through
 * ```
 *
 * So the frame reports the rectangles its card actually occupies and the shell
 * clips to them. Disjoint rectangles need `path()` with several subpaths —
 * `polygon()` is one polygon — and hit-testing follows it, which was measured
 * too.
 *
 * **The cost is the same family as the projection this project rejected for the
 * reading view**, and saying so is the point: a second source of truth, and one
 * frame of lag when a rectangle moves. The difference is scale — a card's own
 * one to three `position:fixed` rectangles, which do not move when the page
 * scrolls, against sixteen scroll-tracking slots per frame.
 *
 * @module iris-web/sandbox/overlay-regions
 */

/** One hit-testable area, in the frame's viewport coordinates. */
export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The clip a set of regions describes.
 *
 * **An empty set is a zero-area path, not `none`.** `none` means "no clip",
 * which is a frame that catches every click over the whole viewport — so a card
 * that has built nothing yet would swallow the shell. Making empty mean
 * *nothing catches* keeps a single code path: the frame is always
 * `pointer-events:auto` and always clipped, and there is no second state to be
 * in the wrong one of.
 * @param regions - the areas the card occupies.
 * @returns a `clip-path` value.
 */
export function clipPathFor(regions: readonly Region[]): string {
  const usable = mergeRegions(regions)
  if (usable.length === 0) return 'path("M0 0Z")'
  const subpaths = usable.map(
    region =>
      `M${round(region.x)} ${round(region.y)}`
      + `H${round(region.x + region.width)}`
      + `V${round(region.y + region.height)}`
      + `H${round(region.x)}Z`,
  )
  return `path("${subpaths.join(' ')}")`
}

/**
 * Tidy a raw list of rectangles into the ones worth clipping to.
 *
 * Three things, and each is a case that would otherwise reach the browser:
 *
 * - **Empty rectangles go.** A card's hidden container measures 0×0 and would
 *   contribute a subpath that catches nothing while making the path longer.
 * - **Contained rectangles go.** A card's panel and every node inside it all
 *   report rectangles; keeping the children makes the path grow with the card's
 *   DOM for no change in what is hit-testable.
 * - **Sub-pixel values round.** `getBoundingClientRect` returns fractions, and a
 *   path string regenerated every animation frame with 13 decimal places is a
 *   lot of bytes across a message boundary for no visible difference.
 *
 * Rounded **outward**, so a rounded rectangle never ends up smaller than the
 * node it describes — a one-pixel-short clip is an edge a card's own button
 * stops responding on, and "the corner doesn't work" is a bug report nobody can
 * reproduce.
 * @param regions - raw rectangles.
 * @returns the ones to clip to.
 */
export function mergeRegions(regions: readonly Region[]): Region[] {
  const solid = regions
    .filter(region => region.width > 0 && region.height > 0)
    .map(region => ({
      x: Math.floor(region.x),
      y: Math.floor(region.y),
      width: Math.ceil(region.x + region.width) - Math.floor(region.x),
      height: Math.ceil(region.y + region.height) - Math.floor(region.y),
    }))

  /*
   * Containment is tested largest-first, so a container is considered before the
   * children it swallows — but the **output keeps the input's order**, which is
   * the card's DOM order.
   *
   * Not cosmetic: the shell compares the generated `clip-path` string against
   * the one already set and skips the write when they match. Emitting in area
   * order would make the string change whenever two rectangles swapped sizes —
   * a card animating a panel's width would rewrite the clip on every frame for
   * no change in what is hit-testable.
   */
  const byArea = [...solid]
    .sort((left, right) => right.width * right.height - left.width * left.height)

  const dropped = new Set<Region>()
  for (const region of byArea) {
    if (dropped.has(region)) continue
    for (const other of byArea) {
      if (other === region || dropped.has(other)) continue
      if (contains(region, other)) dropped.add(other)
    }
  }
  return solid.filter(region => !dropped.has(region))
}

/**
 * Whether one rectangle fully contains another.
 * @param outer - the candidate container.
 * @param inner - the candidate child.
 * @returns true when `inner` adds no hit-testable area.
 */
function contains(outer: Region, inner: Region): boolean {
  return (
    inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height
  )
}

/** One decimal is well under a device pixel and keeps the string short. */
function round(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Why a region might be occupying space and drawing nothing.
 *
 * **"Box present, screen empty" is its own failure class**, and it cost a round:
 * 银麒赎世's trigger button reported a 61x61 rectangle, the clip was right, hit
 * testing was right — `elementFromPoint` returned the frame — and the screen
 * showed nothing there. Every remaining candidate (an opacity, a colour, a
 * missing glyph, a transform) is a computed-style question **inside** the frame,
 * which is the one place the shell cannot look.
 *
 * So the frame answers it. Reported beside the clip and **never** folded into
 * it: the clip is decided by geometry alone, because a node that is invisible
 * and still meant to catch clicks is a real thing (a transparent hit area), and
 * mixing visibility into the clip would silently make those unclickable.
 */
export interface Visibility {
  /** The element, as a card author would recognise it. */
  label: string
  /** `opacity`, when it is not 1 — the commonest way a box draws nothing. */
  opacity?: string
  /** `visibility`, when it is not `visible`. */
  visibility?: string
  /** Whether the node has any non-whitespace text of its own. */
  text: boolean
  /** Whether it paints a background or a border. */
  paints: boolean
  /**
   * The first family in the resolved `font-family`.
   *
   * Here because of the specific failure above: a button whose content is the
   * emoji `📱` draws nothing if no font in the stack has that glyph, and the
   * resolved stack is the only thing that says so from inside.
   */
  font?: string
  /**
   * The measured box, verbatim.
   *
   * **Added because a live reading needed it and could not get it.** The clip
   * came back `path("M 0 0 Z")` — zero area, so a blank screen — and the report
   * beside it said only that the card had built two elements. Nobody could tell
   * whether the elements were `display:none`, detached, sized zero by the
   * card's own CSS, or measured before layout: four different repairs behind
   * one sentence. The rect is the fact that separates them.
   */
  rect?: { x: number, y: number, width: number, height: number }
  /** `display`, always — `none` is the commonest reason a box measures zero. */
  display?: string
  /**
   * Whether the element is in the document at all.
   *
   * A node built and never appended measures zero exactly like one that is
   * appended and hidden, and the two are not the same bug.
   */
  connected?: boolean
  /**
   * The element's own `style` attribute, verbatim.
   *
   * **This is the field that decides V1.5.4.** That card appends its overlay
   * frame and then sets seven properties on it with `!important`
   * (`display:block`, `width:100vw`, `height:100vh`, ...), so it is full-screen
   * by default; later it may hide itself with `display:none !important`. When
   * the box measures zero, two very different repairs are in play, and the
   * inline text tells them apart in one reading:
   *
   * - it holds `display: none !important` -> **the card hid its own frame**, and
   *   the bug, if any, is in whatever made the card decide that. Not ours.
   * - it is missing the card's `!important` block -> the properties never
   *   landed, which is **ours**: the stand-in did not take the writes.
   *
   * Reported only for a zero box, because that is the only place it earns its
   * length, and it is the raw attribute rather than a computed value so
   * `!important` survives into the report at all.
   */
  inline?: string
  /**
   * Whether this element is one of our nested-frame stand-ins
   * (`data-iris-nested-frame`) rather than something the card built directly.
   *
   * Without it a reader cannot tell a card's own `<div>` from the `<div>` we
   * substitute for its `<iframe>`, and those two have different owners.
   */
  standIn?: boolean
}

/**
 * Summarise one region for the panel.
 * @param it - what the element looks like.
 * @returns one line, or undefined when there is nothing worth saying.
 */
export function describeVisibility(it: Visibility): string | undefined {
  const notes: string[] = []
  /*
   * The box first, and **unconditionally when it is empty**.
   *
   * Everything else here is reported only when it deviates, which is right for
   * a list of oddities and wrong for the one number a reader of a blank screen
   * needs. A zero box is the finding, not a deviation from one.
   */
  if (it.rect !== undefined) {
    const { width, height, x, y } = it.rect
    const box = `${String(round(width))}x${String(round(height))}`
      + ` at ${String(round(x))},${String(round(y))}`
    if (width <= 0 || height <= 0) notes.push(`ZERO BOX ${box}`)
    else notes.push(box)
  }
  if (it.display !== undefined && it.display !== 'block') notes.push(`display ${it.display}`)
  if (it.connected === false) notes.push('NOT IN THE DOCUMENT')
  if (it.standIn === true) notes.push('our nested-frame stand-in')
  // Only for an empty box: see `inline`. Long, and decisive exactly there.
  if (it.inline !== undefined && it.inline !== '' && isEmpty(it)) {
    notes.push(`style="${it.inline}"`)
  }
  if (it.opacity !== undefined && it.opacity !== '1') notes.push(`opacity ${it.opacity}`)
  if (it.visibility !== undefined && it.visibility !== 'visible') {
    notes.push(`visibility ${it.visibility}`)
  }
  /*
   * A box with no text, no background and no border is the shape that looks
   * present and draws nothing. Said explicitly rather than left to be inferred
   * from three absent fields, because the reader of this line is looking at an
   * empty screen and needs the sentence, not the evidence.
   */
  if (!it.text && !it.paints) notes.push('no text, no background, no border')
  if (it.font !== undefined) notes.push(`font ${it.font}`)
  return notes.length === 0 ? undefined : `${it.label}: ${notes.join(', ')}`
}

/**
 * Say that every element measured zero, which is why the clip is empty.
 *
 * A separate sentence rather than something a reader infers from a list of
 * boxes: the clip being empty and the elements being empty are two facts, and
 * the causal link between them is the thing that turns "my screen is blank"
 * into "my elements have no size". It leads the report, because the channel and
 * the conclusion belong in the first sentence.
 * @param zero - how many measured elements had no area.
 * @param total - how many were measured.
 * @returns the sentence, or undefined when at least one element has area.
 */
/**
 * Whether this element's measured box has no area.
 * @param it - one measured element.
 * @returns true when a rect was measured and it is empty.
 */
function isEmpty(it: Visibility): boolean {
  return it.rect !== undefined && (it.rect.width <= 0 || it.rect.height <= 0)
}

/** The frame's own viewport, which every `vw`/`vh` length resolves against. */
export interface FrameViewport {
  width: number
  height: number
}

/**
 * Say how big the frame's viewport is.
 *
 * Lives here, next to the element descriptions, because it is the same kind of
 * sentence and because `reportRegions` — where it is used — runs only inside a
 * real frame and cannot be reached by `node --test`. Keeping the decision in a
 * tested module is the difference between this behaviour having teeth and
 * merely having a comment.
 *
 * **A reading, not a diagnosis, and it used to be both.** A zero viewport had a
 * second clause on it — `THE FRAME HAS NO LAYOUT, so every vw/vh length inside
 * it is 0` — which named a cause this number cannot establish. It was written
 * from a blank screen whose report showed two built elements and no boxes, read
 * as "the elements measured zero because the frame had no layout". The measured
 * answer on that same card was the other one: the frame was laid out and its
 * content correct (stand-in 1384x905, `#app` 1384x905, 52 descendants), and no
 * measurement was ever *asked for*, because Chrome skips rendering a frame
 * whose clip paints nothing and the reporter's `rAF` therefore never fired.
 * The zero viewport is real — one foreground reading caught a 0x0 — but it is a
 * transient state, not the reason the screen was blank.
 *
 * So this reports the number and stops. The shout cost a round of debugging
 * aimed at layout, which is [notes/METHODS.md §二十]'s rule about a report signing
 * its own name: this instrument knows the box it measured, and it does not know
 * why the box is that size.
 * @param viewport - the frame's `documentElement` client box.
 * @returns one clause for the regions detail.
 */
export function describeFrameViewport(viewport: FrameViewport): string {
  return `the frame's own viewport is ${String(viewport.width)}x${String(viewport.height)}`
}

/**
 * The deduplication key for a `regions` report.
 *
 * **What is in the key is a policy, not a detail.** Keyed on the clip alone, a
 * card whose elements all measure zero produces one identical empty clip
 * forever: the diagnosis is sent once, before the card has finished building,
 * and the state that most needs re-reporting is the one state that cannot be.
 * The element count and the zero count catch "the DOM changed and the answer
 * did not"; the viewport catches "the frame was finally laid out", which is the
 * transition one card recovered on — empty at first open, full screen after the
 * window height changed.
 *
 * It deliberately does **not** include the per-element boxes, so a card that is
 * merely animating does not post on every frame.
 * @param clip - the computed clip path.
 * @param roots - how many top-level elements were measured.
 * @param zero - how many measured elements had no area.
 * @param viewport - the frame's viewport at measurement time.
 * @returns a string that differs exactly when the report should be re-sent.
 */
export function regionsKey(
  clip: string,
  roots: number,
  zero: number,
  viewport: FrameViewport,
): string {
  return `${clip}|${String(roots)}|${String(zero)}`
    + `|${String(viewport.width)}x${String(viewport.height)}`
}

export function describeEmptySurface(zero: number, total: number): string | undefined {
  if (total === 0 || zero < total) return undefined
  return `all ${String(total)} element(s) on this card's overlay surface measured zero area, so`
    + ' the clip is empty and nothing on it can be seen or clicked'
}

/** What the collector needs to know about one element. */
export interface Measured {
  rect: Region
  /**
   * Whether this element is hit-testable at all.
   *
   * A card's decorative layer declares `pointer-events:none` for itself, and
   * including it would make Iris block clicks upstream lets through — the one
   * direction where a mistake here is worse than the bug it fixes.
   */
  interactive: boolean
  /**
   * How it looks, for the panel only.
   *
   * Optional so the pure collector stays testable without a style engine, and
   * so nothing about the clip can come to depend on it.
   */
  visibility?: Visibility
}

/**
 * The regions a card's own subtree occupies.
 *
 * Takes a measurer rather than reading the DOM, so the decisions above can be
 * exercised without one. The walk is **shallow-first with pruning**: once an
 * element is taken, its children add nothing (they are contained), so the walk
 * does not descend — which is what keeps this proportional to the card's
 * interface rather than to its DOM.
 *
 * A non-interactive element **is** descended into, because a
 * `pointer-events:none` wrapper around interactive content is a real pattern —
 * that is how a card makes a full-screen backdrop that lets clicks through
 * except on its buttons.
 * @param roots - the card's top-level nodes.
 * @param measure - how to measure one node and list its children.
 * @returns the regions to clip to.
 */
export function collectRegions<T>(
  roots: readonly T[],
  measure: (node: T) => { measured: Measured, children: readonly T[] },
  seen: Visibility[] = [],
): Region[] {
  const found: Region[] = []
  /*
   * **Root-ness travels with the node, and it decides what gets described.**
   *
   * The visibility record used to be taken only on the branch below that
   * accepts a region — non-zero and interactive — which made the instrument
   * silent in the one case it was built for: a card whose elements all measure
   * zero produced an empty clip, no records at all, and therefore no zero
   * count and no "every element measured zero" sentence. The report said the
   * card had built two elements and nothing about either of them. Caught in
   * the foreground, on a blank screen, after the formatter had been tested
   * directly with a zero rect and passed.
   *
   * So: **every root is described, whatever it measures**, because the roots
   * are the things "this card built N element(s)" counts and the things a
   * reader needs boxes for. Descendants are still described only when they
   * become clip regions — a wrapper's whole subtree would otherwise arrive as
   * hundreds of lines through a message channel.
   */
  const queue = roots.map(node => ({ node, root: true }))
  let guard = 0

  while (queue.length > 0) {
    /*
     * A ceiling, because this runs inside a card's frame on a DOM the card
     * controls. A pathological tree would otherwise turn a mutation observer
     * callback into a hang, and a hung frame reports nothing at all.
     */
    guard += 1
    if (guard > 2_000) break

    const entry = queue.shift()
    if (entry === undefined) continue
    const { measured, children } = measure(entry.node)
    const usable = measured.interactive && measured.rect.width > 0 && measured.rect.height > 0
    // A root is described either way; a descendant only when it is a region.
    if (measured.visibility !== undefined && (usable || entry.root)) {
      seen.push(measured.visibility)
    }
    if (usable) {
      found.push(measured.rect)
      continue
    }
    queue.push(...children.map(child => ({ node: child, root: false })))
  }

  return mergeRegions(found)
}
