/**
 * Rewriting `vh` in card content, the way Tavern Helper does.
 *
 * A card sized in `vh` measures the *frame*, and a frame that is only as tall as
 * its own content makes `100vh` collapse to almost nothing. Upstream's answer is
 * to rewrite the unit against a custom property the host keeps pointed at the
 * real viewport, and to do it before the content is injected.
 *
 * Two limits are copied deliberately rather than improved on:
 *
 * **Only `min-height`.** `height: 100vh` is left alone. That looks like an
 * oversight in upstream and is not ours to correct — a compatibility layer that
 * fixes its source stops being compatible with it, and any card that works today
 * works against this exact scope.
 *
 * **A probe first.** Content with no `vh` at all is returned untouched, byte for
 * byte, rather than run through three replacements that would each find nothing.
 * Card bodies run to megabytes, so "usually does nothing, cheaply" is the shape
 * that matters.
 *
 * @module iris-web/sandbox/viewport-units
 */

/** The property whose value the rewrite points at. Upstream's spelling, kept verbatim. */
export const VIEWPORT_PROPERTY = '--TH-viewport-height'

/** `100vh` maps to the property itself; anything else scales it. */
function replacement(amount: string): string {
  const value = Number(amount)
  if (!Number.isFinite(value)) return `${amount}vh`
  if (value === 100) return `var(${VIEWPORT_PROPERTY})`
  // A ratio rather than a percentage of a percentage: `calc(var(x) * 0.8)` is
  // what upstream emits and what a browser can resolve without a second unit.
  return `calc(var(${VIEWPORT_PROPERTY}) * ${value / 100})`
}

/**
 * Whether content mentions `min-height` in `vh` at all.
 *
 * Cheap and deliberately loose: it only has to be right about "there is nothing
 * here", because a false positive costs three replacements that find nothing and
 * a false negative would silently skip a card that needed rewriting.
 * @param content - the card content.
 * @returns whether the rewrite is worth attempting.
 */
export function mentionsViewportHeight(content: string): boolean {
  return /vh\b/i.test(content) && /min-?height/i.test(content)
}

/**
 * Rewrite `min-height` values given in `vh`.
 *
 * Three forms, which are the three ways the measured cards express it: a CSS
 * declaration, an inline `style` attribute, and a JavaScript assignment (either
 * `style.minHeight = …` or `setProperty('min-height', …)`).
 * @param content - the card content.
 * @returns the content with viewport heights rewritten, or the original when it has none.
 */
export function rewriteViewportUnits(content: string): string {
  if (!mentionsViewportHeight(content)) return content

  return (
    content
      // 1. A declaration, in a stylesheet or a style attribute alike:
      //    `min-height: 80vh` / `min-height:80vh`
      .replace(/min-height\s*:\s*(\d+(?:\.\d+)?)vh/gi, (_match, amount: string) =>
        `min-height: ${replacement(amount)}`,
      )
      // 2. The camel-cased property, as a JS assignment:
      //    `.style.minHeight = "80vh"`
      .replace(
        /(minHeight\s*=\s*['"`])(\d+(?:\.\d+)?)vh(['"`])/gi,
        (_match, head: string, amount: string, tail: string) => `${head}${replacement(amount)}${tail}`,
      )
      // 3. `setProperty('min-height', '80vh')`, whose value sits in its own
      //    argument and so is not reached by either pattern above.
      .replace(
        /(setProperty\(\s*['"`]min-height['"`]\s*,\s*['"`])(\d+(?:\.\d+)?)vh(['"`])/gi,
        (_match, head: string, amount: string, tail: string) => `${head}${replacement(amount)}${tail}`,
      )
  )
}
