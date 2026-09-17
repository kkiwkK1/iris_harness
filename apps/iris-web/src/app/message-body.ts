/**
 * How one message's body is laid out: interfaces in place, prose as prose,
 * scaffolding folded.
 *
 * A function rather than four lines inside `MessageInterfaces.tsx`, and the
 * reason is the defect it was written for (`notes/apps/iris-web/DEVIATIONS.md`
 * §110). The row used to hand the interface claim the **body tag's prose**
 * instead of the message, so a card that obeyed its preset — panels written
 * outside `<content>`, which is what the preset asks for — claimed nothing and
 * rendered no frame at all, on 12 of the 14 corpus cards measured. Nothing
 * was red: the claim was correct about the string it was given, the splice was
 * correct about the claim, and the one place the two facts met was a component
 * no test can render.
 *
 * So the meeting point is here, where a test can call it with the same
 * arguments the row does. The ruling it implements is one sentence: **the body
 * tag decides how prose is laid out and how scaffolding is folded; it never
 * decides which blocks qualify as interfaces.** Upstream is the reason — its
 * frame criterion is the block's own text (`notes/apps/iris-web/RENDER.md`),
 * and upstream has never heard of the body tag, so a fenced document builds a
 * frame wherever it sits.
 *
 * @module iris-web/app/message-body
 */

import { locateBodyTag } from './body-tag.ts'
import type { MessageStyle } from './html-regions.ts'
import {
  splitAroundInterfaces,
  unwrapUnknownTagsOutsideCode,
  type FrontendBlock,
  type MessageSegment,
} from '../sandbox/frontend-blocks.ts'

/**
 * Place one message's claimed interfaces, prose and scaffolding in order.
 *
 * The body tag reaches the splice as a **range** over `display`, never as a
 * substring of it: a range labels the runs *between* the interfaces without
 * being able to hide any, which is exactly the property §110 turned out to
 * need. The wrapper's own two tags are dropped like a `<style>` span — in the
 * same walk that places the interfaces, because a second pass that deleted
 * them afterwards would move every offset the claims are named by.
 *
 * An untagged message is the identity: no range, no dropped tags, and the
 * segments are byte-for-byte the ones the splice produced before the body-tag
 * mechanism existed.
 *
 * @param display - the message after display regex and the settled stray-fence
 *   repair. The whole of it — this is the string the claims' offsets are in.
 * @param tag - the body tag name in force, from `getBodyTag`.
 * @param blocks - the claimed interfaces, from `claimMessageSurfaces(display)`.
 * @param styles - the message's own `<style>` spans, from the same claim.
 * @returns the segments to render, in source order, with empty prose dropped
 *   and every prose run already through the unknown-markup rule.
 */
export function layOutMessageBody(
  display: string,
  tag: string,
  blocks: readonly FrontendBlock[],
  styles: readonly MessageStyle[],
): MessageSegment[] {
  const span = locateBodyTag(display, tag)
  const tagMarkup = span.tagged
    ? [
        { start: span.openStart, end: span.bodyStart },
        { start: span.bodyEnd, end: span.closeEnd },
      ]
    : []
  const prose = span.tagged ? { start: span.bodyStart, end: span.bodyEnd } : undefined

  /*
   * The unknown-markup rule is applied per prose run rather than to the whole
   * message, because claims are offsets into the message as stored (see
   * `unwrapUnknownTagsOutsideCode`) — rewriting first would move them.
   *
   * Scaffolding is deliberately left alone: it renders verbatim inside its
   * fold, and the honest rendering of markup-adjacent text is its characters.
   */
  return splitAroundInterfaces(display, blocks, [...styles, ...tagMarkup], prose)
    .map(segment =>
      segment.kind === 'text'
        ? { ...segment, text: unwrapUnknownTagsOutsideCode(segment.text) }
        : segment,
    )
    .filter(segment => segment.kind !== 'text' || segment.text.trim() !== '')
}
