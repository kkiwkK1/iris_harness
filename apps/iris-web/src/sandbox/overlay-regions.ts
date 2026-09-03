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
}

/**
 * Summarise one region for the panel.
 * @param it - what the element looks like.
 * @returns one line, or undefined when there is nothing worth saying.
 */
export function describeVisibility(it: Visibility): string | undefined {
  const notes: string[] = []
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
  const queue = [...roots]
  let guard = 0

  while (queue.length > 0) {
    /*
     * A ceiling, because this runs inside a card's frame on a DOM the card
     * controls. A pathological tree would otherwise turn a mutation observer
     * callback into a hang, and a hung frame reports nothing at all.
     */
    guard += 1
    if (guard > 2_000) break

    const node = queue.shift()
    if (node === undefined) continue
    const { measured, children } = measure(node)
    if (measured.interactive && measured.rect.width > 0 && measured.rect.height > 0) {
      found.push(measured.rect)
      if (measured.visibility !== undefined) seen.push(measured.visibility)
      continue
    }
    queue.push(...children)
  }

  return mergeRegions(found)
}
