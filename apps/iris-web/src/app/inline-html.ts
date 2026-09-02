/**
 * What a card's inline HTML is allowed to be, and how we check afterwards.
 *
 * The design is `INLINE-HTML.md` (3c). This module holds the parts that can be
 * decided without a DOM: the sanitizer's configuration, and an audit of what
 * came back out of it.
 *
 * **Why there is an audit at all.** The sanitizer is configured to forbid
 * scripts, event handlers and external loads, and configuration is exactly the
 * kind of thing that is right until someone edits it. This project's own rule
 * is that a guard must not be same-source as the thing it guards, so the check
 * that no script survived does not read the same config that was supposed to
 * remove it — it looks at the tree that actually arrived.
 *
 * **The audit does not replace the sanitizer.** It cannot: by the time it runs,
 * the string has already been parsed. It is a tripwire that says the policy and
 * the outcome disagree, which is a thing worth knowing loudly and immediately.
 *
 * @module iris-web/app/inline-html
 */

/**
 * Tags that never survive, stated rather than inherited.
 *
 * [INLINE-HTML.md §4.1 / checklist item 3] Upstream writes only `ADD_TAGS`
 * because it trusts the sanitizer's default allow-list. **We are tightening, so
 * the tightening has to be on paper** — a default that widens in a later
 * release would otherwise widen us with it, silently, in a dependency bump.
 *
 * `script` is the whole of ruling ③: **a fragment never gains script
 * capability, scripts live only in frames.** That is the same decision the
 * sandbox grants make, one surface over — a frame is isolated and can be
 * refused wholesale, while a fragment renders into the host's own DOM.
 */
export const FORBIDDEN_TAGS: readonly string[] = [
  'script',
  'iframe',
  'object',
  'embed',
  'base',
  'link',
  'meta',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'template',
  'noscript',
]

/**
 * Attributes that never survive.
 *
 * Event handlers are the script surface again, arriving one attribute at a
 * time. `style` is **kept** deliberately: a card styling its own panel inline is
 * the ordinary case, and the scoping in `card-css.ts` handles the stylesheet
 * form. What is refused is anything that fetches or navigates.
 */
export const FORBIDDEN_ATTRS: readonly string[] = [
  'srcset',
  'formaction',
  'action',
  'ping',
  'background',
  'dynsrc',
  'lowsrc',
]

/**
 * The only URI shapes an attribute may carry.
 *
 * Fragment references and same-page anchors only. [§4.3] refuses every external
 * load at a measured cost of zero on the corpus — with the caveat that matters
 * more than the zero: it says the tightening hits nothing that *exists*, not
 * that it never will.
 *
 * `javascript:` is refused by this being an allow-list rather than a
 * deny-list — a deny-list has to anticipate `JaVaScRiPt:`, `java\0script:` and
 * whatever the next parser bug spells it as.
 */
export const ALLOWED_URI = /^(?:#|\.?\/|mailto:)/i

/** One thing the audit found that the policy says should not be there. */
export interface Violation {
  /** What was found, in words that name the thing. */
  what: string
  /** Where, as a tag path, so a card author can find it. */
  where: string
}

/** The shape the audit needs, so it can run without a DOM in tests. */
export interface AuditNode {
  /** Upper- or lower-case tag name; comparison is case-insensitive. */
  tagName?: string | undefined
  /** Attribute names and values. */
  attributes?: readonly { name: string, value: string }[] | undefined
  children?: readonly AuditNode[] | undefined
}

/**
 * Check what the sanitizer actually returned against what the policy allows.
 *
 * Deliberately **not** written in terms of {@link FORBIDDEN_TAGS}: reading the
 * same list that configured the sanitizer would make this agree with a broken
 * configuration as readily as with a working one. The tags named here are the
 * ones whose presence is a capability rather than a style — script execution,
 * navigation, framing, submission — restated independently on purpose.
 *
 * @param root - the sanitized tree.
 * @returns everything found that should not have survived.
 */
export function auditSanitized(root: AuditNode): Violation[] {
  const found: Violation[] = []

  const walk = (node: AuditNode, path: string): void => {
    const tag = (node.tagName ?? '').toLowerCase()
    // No leading separator at the root: the path is printed for a card author
    // to follow, and `>div>script` reads as though something sat above the div.
    const here = tag === '' ? path : path === '' ? tag : `${path}>${tag}`

    if (['script', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'].includes(tag)) {
      found.push({ what: `a <${tag}> element survived sanitizing`, where: here })
    }

    for (const attribute of node.attributes ?? []) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value

      // An event handler is script arriving one attribute at a time.
      if (name.startsWith('on')) {
        found.push({ what: `an event handler (${name}) survived sanitizing`, where: here })
        continue
      }

      /*
       * `src`/`href`-shaped attributes are checked by value, and the check is an
       * allow-list. A deny-list would have to anticipate every spelling of
       * `javascript:` that a parser accepts.
       */
      if (['src', 'href', 'xlink:href', 'poster', 'data', 'srcset'].includes(name)) {
        if (value.trim() !== '' && !ALLOWED_URI.test(value.trim())) {
          found.push({
            what: `${name} pointing outside the document (${describeTarget(value)})`,
            where: here,
          })
        }
      }
    }

    for (const child of node.children ?? []) walk(child, here)
  }

  walk(root, '')
  return found
}

/**
 * Name a refused target so the report is more specific than the card's own.
 *
 * [TEST-CARDS.md / `OBSERVABILITY.md` gap 8] Cards print their own message when
 * a resource does not arrive — one blames the reader's installation. A report
 * that says only "something was refused" loses to that, because the card's
 * explanation is the more specific of the two and specific is what gets
 * believed.
 * @param value - the attribute value.
 * @returns a short description naming the host or scheme.
 */
export function describeTarget(value: string): string {
  const trimmed = value.trim()
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase()
  if (scheme === 'javascript') return 'a javascript: URL'
  if (scheme === 'data') return 'a data: URL'
  if (trimmed.startsWith('//') || (scheme !== undefined && trimmed.includes('//'))) {
    try {
      return new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed).host || trimmed.slice(0, 60)
    } catch {
      return trimmed.slice(0, 60)
    }
  }
  return trimmed.slice(0, 60)
}
