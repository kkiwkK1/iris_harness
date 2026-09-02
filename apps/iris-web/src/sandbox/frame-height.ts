/**
 * When a card's frame has to scroll itself.
 *
 * Split out of `frame-entry.ts` because that file's own contract says so: it
 * exists to adapt the real frame realm and hand it to `installSandbox`, and
 * *"every decision about what a card may touch lives there, where it is injected
 * and therefore testable; keeping this file free of policy is what stops the
 * untestable part from growing."* Deciding when a frame becomes scrollable is
 * policy, and it went into the entry first — this is that walked back.
 *
 * @module iris-web/sandbox/frame-height
 */

/**
 * How far content may exceed the viewport before the frame scrolls itself.
 *
 * Not zero, because the height travels to the shell as a message and is applied
 * a frame later: in that gap the content is legitimately a pixel or two taller
 * than the viewport it is about to be given, and a zero threshold would flash a
 * scrollbar on every ordinary growth — including the ones that resolve
 * themselves immediately. Sub-pixel layout rounding lands in the same band.
 *
 * Small enough that nothing a reader could see hides underneath it: two pixels
 * cannot conceal a line of text, let alone the cut-off screen that prompted
 * this.
 */
export const OVERFLOW_SLACK_PX = 2

/**
 * Whether the frame must scroll its own content.
 *
 * The frame asks this of itself on every measurement and needs to know nothing
 * about *why* its viewport is short of its content — a lagging height message, a
 * card that pins its own height, a cap the shell might grow one day. Each of
 * those would otherwise need its own fix, and each would arrive as the same
 * user-visible fault: content that is simply not there, with a dead wheel over
 * it.
 *
 * A non-positive viewport is not an overflow. A frame still being laid out
 * reports `clientHeight` of 0, and treating that as "content exceeds viewport"
 * would turn on a scrollbar during every frame's first moments — the same class
 * of mistake as the self-reinforcing zero that `frame-entry.ts` records for
 * height, read the other way round.
 * @param content - the content height, as `body.scrollHeight` measures it.
 * @param viewport - the frame's own viewport, `documentElement.clientHeight`.
 * @returns whether the frame should allow itself to scroll.
 */
export function overflowsViewport(content: number, viewport: number): boolean {
  if (!Number.isFinite(content) || !Number.isFinite(viewport)) return false
  if (viewport <= 0) return false
  return content > viewport + OVERFLOW_SLACK_PX
}
