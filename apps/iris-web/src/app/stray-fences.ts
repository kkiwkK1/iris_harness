/**
 * The code fence that never closes, and why it must not be a fence.
 *
 * CommonMark runs an unclosed fence to the end of the document, and the
 * renderer follows CommonMark — so one stray ` ``` ` turns every line below it
 * into a single code block, and the reader scrolls `## headings` and `**bold**`
 * as source. The floor that taught this (政经博弈卡 新·架空政治经济模拟器,
 * 320 lines): the card thinks inside `<think_fox~>`, the model pads the thinking
 * with a lone fence that nothing ever closes, and the初始化报告 below rendered
 * as one wall of `<pre>`. Measured on that exact text, the parse yields two
 * blocks — a paragraph and one `code` node of 310 lines.
 *
 * Upstream never shows this. showdown only builds a code block when the closing
 * fence arrives, so a stray opener stays literal text and the reply below it
 * renders as markdown — which is what the card author designed against. This
 * repair copies that outcome for **settled** text: an opening fence with no
 * closer is not a fence. Its characters are backslash-escaped, so the line
 * renders as the literal text it reads as, and the markdown below renders as
 * markdown. Bare HTML keeps the renderer's own policy (escaped visible text),
 * so nothing new executes and nothing old did.
 *
 * **Never applied while a reply streams.** A half-arrived code block *is* an
 * unclosed fence, and code-to-end-of-stream is its honest render — the same
 * reason the claim is deferred while streaming. The gate lives with the callers,
 * which already hold `streaming`; the repair is pure text in, text out.
 *
 * The fence grammar is the claim pipeline's own (`openingFence`/`closesFence`),
 * imported rather than restated: the repair and the claim must not be two
 * implementations of what a fence is, or a repaired text and its claim would
 * drift apart one grammar tweak at a time.
 *
 * @module iris-web/app/stray-fences
 */

import { closesFence, openingFence, type Fence } from '../sandbox/frontend-blocks.ts'

/** A newline, built rather than escaped — see `frontend-blocks.ts` for why. */
const NEWLINE = String.fromCharCode(10)

/**
 * Rewrite one fence line as the literal text it is about to render as.
 *
 * Every fence character is escaped, not just the first: `\`` next to an
 * unescaped ```` ` ```` would leave a code-span delimiter behind, and a line
 * like ```` ```js ```` would open one. An escaped backtick (or tilde) opens
 * nothing, so the whole run renders as the characters the model wrote.
 * @param line - the fence line, as written.
 * @param fence - the fence it opened, from `openingFence`.
 * @returns the same line with each fence character backslash-escaped.
 */
function asLiteral(line: string, fence: Fence): string {
  const indent = line.length - line.trimStart().length
  const escaped = ('\\' + fence.char).repeat(fence.width)
  return line.slice(0, indent) + escaped + line.slice(indent + fence.width)
}

/**
 * Neutralize every never-closing fence in a message.
 *
 * The walk consumes real fenced blocks wholesale (an opener with a closer
 * anywhere below is a code block, whatever its body contains), so a stray-looking
 * fence **inside** a real block is never touched. Lines of indented code need no
 * branch: their four-space indent is exactly what `openingFence` refuses.
 * @param source - the message text, after display regex.
 * @returns the text with stray openers escaped; byte-identical when every fence
 * closes, which is almost every message.
 */
export function repairStrayFences(source: string): string {
  // A fence needs a backtick or a tilde somewhere; messages without either,
  // which is most, keep their bytes and skip the walk entirely.
  if (!source.includes('`') && !source.includes('~')) return source

  const lines = source.split(NEWLINE)

  /** Copy-on-write: untouched messages return the input string itself. */
  let repaired: string[] | undefined

  let at = 0
  while (at < lines.length) {
    const line = lines[at] ?? ''
    const fence = openingFence(line)
    if (fence === undefined) {
      at += 1
      continue
    }

    let to = at + 1
    while (to < lines.length && !closesFence(lines[to] ?? '', fence)) to += 1

    if (to < lines.length) {
      // A real block: its interior is code, whatever it looks like.
      at = to + 1
      continue
    }

    // No closer anywhere below: not a fence, and it must not swallow the rest
    // of the message into one.
    ;(repaired ??= [...lines])[at] = asLiteral(line, fence)
    at += 1
  }

  return repaired === undefined ? source : repaired.join(NEWLINE)
}
