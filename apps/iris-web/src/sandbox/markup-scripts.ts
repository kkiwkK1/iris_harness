/**
 * How much code a card runs that its **script list** never mentions.
 *
 * The system audit's F9. `interfacesMayBuild` lets a card whose `scripts` array
 * is empty build its message frames without ever putting the question — that is
 * deliberate and stays (`consent.ts` records the 30 KB greeting it was measured
 * on, and the deadlock the gate would otherwise create) — and the frame puts the
 * card's markup straight into the srcdoc body (`srcdoc.ts`), where an inline
 * `<script>` runs while the document parses. So a card can carry no scripts, be
 * shown as "never asked", and still be running code.
 *
 * Nothing here changes that. This module makes the fact **countable**, so the
 * panel can say it and the question can carry a sentence about it.
 *
 * ## Measured through the frames' own claim, not over the card file
 *
 * The count walks {@link claimMessageSurfaces} — the same function
 * `MessageInterfaces` calls to decide what becomes a frame — and counts only
 * inside the bodies it claims. A regex over the whole message would count a
 * `<script` a card merely *writes about* in prose, or one inside an unclaimed
 * fence that no frame will ever parse. The rule the repo keeps learning is that
 * a count of the wrong object passes every self-check it is given.
 *
 * ## What counts as a script, pinned
 *
 * A `<script` whose next character can end an HTML tag name — `>`, `/`, or
 * whitespace. Case-insensitive, so `<SCRIPT>` counts. `<script type="module">`
 * counts: a module script in a srcdoc body is deferred rather than skipped, and
 * it runs.
 *
 * **A `<script` inside an HTML comment counts too**, and that is a decision
 * rather than an oversight. Stripping comments correctly needs a parser, and the
 * failures of a hand-rolled one are all in the quiet direction — a `<!--` inside
 * an attribute value swallows the real script that follows it, and the number
 * silently drops to zero on the one card where it mattered. Over-counting shows
 * a reader a warning about markup that does not run; under-counting shows them
 * nothing about markup that does. `frontend-blocks.ts` makes the same trade for
 * the same reason one layer up: its claim is substring containment, not parsing,
 * so a message that merely mentions `<body` is claimed.
 *
 * @module iris-web/sandbox/markup-scripts
 */

import { claimMessageSurfaces } from './frontend-blocks.ts'

/** The opening of a script element, lower-cased for a folded search. */
const OPENING = '<script'

/**
 * Characters that may follow a tag name.
 *
 * Built from their codes rather than written as escapes: this package has had
 * single backslashes collapse in transit more than once, and a collapsed `\t`
 * is a literal `t` — which would quietly count `<scriptt` and stop counting
 * a real tab-separated tag.
 */
const TAG_NAME_ENDS: readonly string[] = [
  '>',
  '/',
  ' ',
  String.fromCharCode(9),
  String.fromCharCode(10),
  String.fromCharCode(12),
  String.fromCharCode(13),
]

/**
 * How many script elements a run of markup opens.
 *
 * @param markup - the markup a frame would parse.
 * @returns the number of `<script` openings in it.
 */
export function countScriptTags(markup: string): number {
  const folded = markup.toLowerCase()
  let count = 0
  let at = folded.indexOf(OPENING)
  while (at !== -1) {
    const next = folded.charAt(at + OPENING.length)
    // End of string is not a tag: `…<script` with nothing after it never
    // becomes an element. An empty `charAt` result is exactly that case, and it
    // is not in the terminator list, so it falls through uncounted.
    if (TAG_NAME_ENDS.includes(next)) count += 1
    at = folded.indexOf(OPENING, at + OPENING.length)
  }
  return count
}

/**
 * How many scripts are embedded in the interface markup of one message.
 *
 * @param source - the message text, as the row hands it to the claim pipeline.
 * @returns the count across every block this message would put in a frame.
 */
export function countMarkupScripts(source: string): number {
  let count = 0
  for (const block of claimMessageSurfaces(source).blocks) count += countScriptTags(block.body)
  return count
}

/**
 * How many scripts are embedded in the interface markup of a conversation.
 *
 * Summed over messages rather than reported per message, because the panel asks
 * one question — "is this card running markup scripts on me" — and a per-row
 * breakdown answers a question nobody opened the panel with.
 * @param sources - every message's text, in any order.
 * @returns the total.
 */
export function countMarkupScriptsIn(sources: readonly string[]): number {
  let count = 0
  for (const source of sources) count += countMarkupScripts(source)
  return count
}
