/**
 * Card-authored HTML, made safe enough to render in the shell's own document.
 *
 * **This is the first place the shell renders a card's markup into its own
 * DOM**, and that is worth saying plainly rather than letting it arrive as an
 * implementation detail. Everything else a card draws goes into a sandboxed
 * frame: an interface block, an overlay, a script's panel. A frame can be
 * refused wholesale, and nothing inside one is same-origin with Iris.
 *
 * A popup cannot take that route. It is modal — it has to cover the reading
 * column, and a frame clipped to a message's height cannot — so its content is
 * rendered here, in the shell, where the policy in `app/inline-html.ts` becomes
 * load-bearing rather than declarative. That module has carried the
 * configuration and the audit since `INLINE-HTML.md` ruling ③ ("a fragment never
 * gains script capability, scripts live only in frames") and had no consumer;
 * this is its consumer.
 *
 * Two layers, and the second is not decoration:
 *
 * 1. **DOMPurify**, configured from `inline-html.ts` — no scripts, no event
 *    handlers, no framing, no submission, and an allow-list for every
 *    URI-bearing attribute so nothing loads from off-page.
 * 2. **The audit**, which reads the tree that actually came back rather than the
 *    configuration that was supposed to produce it. A guard that is same-source
 *    as the thing it guards agrees with a broken configuration as readily as
 *    with a working one.
 *
 * **It fails closed.** Where DOMPurify cannot run at all — a server render, a
 * realm with no `window` — the markup is escaped to text instead of passed
 * through. A sanitizer that becomes the identity function when it is unhappy is
 * worse than none, because everything downstream still says "sanitized".
 *
 * @module iris-web/app/sanitize-html
 */

import DOMPurify from 'dompurify'

import {
  ALLOWED_URI,
  FORBIDDEN_ATTRS,
  FORBIDDEN_TAGS,
  auditSanitized,
  type AuditNode,
  type Violation,
} from './inline-html.ts'

/** What came back, and what the audit thought of it. */
export interface Sanitized {
  /** Safe to hand to `dangerouslySetInnerHTML`. */
  html: string
  /**
   * Anything the audit found that the policy forbids. Non-empty means the
   * configuration and the outcome disagree, which is a fault in Iris rather
   * than in the card, and it is reported as one.
   */
  violations: readonly Violation[]
  /**
   * Whether the markup was escaped to text because no sanitizer was available.
   * The caller says so rather than showing markup as prose without comment.
   */
  escaped: boolean
}

/** The four characters that turn text into markup. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * A DOM tree as the audit wants to read it.
 *
 * Converted explicitly rather than passing the `Element` through, even though a
 * live element is structurally close enough today: `attributes` is a
 * `NamedNodeMap` and `children` an `HTMLCollection`, and both are iterable only
 * because WebIDL gives an indexed getter an `@@iterator`. Depending on that
 * would make the audit's coverage a property of the DOM spec.
 * @param element - the sanitized element.
 * @returns the same tree in the audit's own shape.
 */
function auditShape(element: Element): AuditNode {
  const attributes: { name: string, value: string }[] = []
  for (let at = 0; at < element.attributes.length; at += 1) {
    const attribute = element.attributes.item(at)
    if (attribute !== null) attributes.push({ name: attribute.name, value: attribute.value })
  }
  const children: AuditNode[] = []
  for (let at = 0; at < element.children.length; at += 1) {
    const child = element.children.item(at)
    if (child !== null) children.push(auditShape(child))
  }
  return { tagName: element.tagName, attributes, children }
}

/**
 * Sanitize one card-authored HTML string.
 * @param html - the markup, exactly as the card wrote it.
 * @returns the safe markup, the audit's findings, and whether it fell back to text.
 */
export function sanitizeCardHtml(html: string): Sanitized {
  /*
   * `isSupported` is false wherever there is no DOM to parse into — Node, a
   * server render, a worker. DOMPurify's own behaviour there is to **return the
   * input unchanged**, which is the one outcome this module must not produce, so
   * the markup is escaped instead and the caller is told.
   */
  if (!DOMPurify.isSupported) {
    return { html: escapeHtml(html), violations: [], escaped: true }
  }

  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: [...FORBIDDEN_TAGS],
    FORBID_ATTR: [...FORBIDDEN_ATTRS],
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    // A string back, because that is what `dangerouslySetInnerHTML` takes; the
    // audit re-parses it, which is deliberate — it reads what a browser will
    // actually build from this string, not what DOMPurify believed it built.
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
  })

  const holder = document.createElement('div')
  holder.innerHTML = clean
  const violations = auditSanitized(auditShape(holder))

  /*
   * A violation means the sanitizer let through something the policy forbids —
   * so the string is not rendered. Falling back to escaped text keeps the
   * dialog's words readable while refusing its markup, and the caller reports
   * the finding.
   */
  if (violations.length > 0) {
    return { html: escapeHtml(html), violations, escaped: true }
  }

  return { html: clean, violations: [], escaped: false }
}
