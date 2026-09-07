/**
 * The inline-HTML policy, and the audit that does not trust it.
 *
 * The audit is written against a node shape rather than a real DOM so it can be
 * tested here: node has no DOM, so a check that could only run in a browser
 * would be a check nobody runs.
 *
 * @module iris-web/tests/inline-html
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import {
  ALLOWED_URI,
  FORBIDDEN_ATTRS,
  FORBIDDEN_TAGS,
  KNOWN_ELEMENTS,
  UNKNOWN_CONTENT_FORBIDDEN,
  auditSanitized,
  describeTarget,
  isKnownElement,
  unwrapUnknownTags,
  type AuditNode,
} from '../src/app/inline-html.ts'

/** A node, with the noise a real DOM node would carry left out. */
function node(
  tagName: string,
  attributes: [string, string][] = [],
  children: AuditNode[] = [],
): AuditNode {
  return { tagName, attributes: attributes.map(([name, value]) => ({ name, value })), children }
}

test('a surviving script is a violation, named', () => {
  /*
   * Ruling ③: a fragment never gains script capability — scripts live only in
   * frames, which are isolated and can be refused wholesale, while a fragment
   * renders into the host's own DOM.
   */
  const found = auditSanitized(node('div', [], [node('script', [], [])]))

  assert.equal(found.length, 1, JSON.stringify(found))
  assert.match(found[0]?.what ?? '', /<script> element survived/)
  assert.equal(found[0]?.where, 'div>script')
})

test('an event handler is a violation wherever it sits', () => {
  // Script arriving one attribute at a time.
  const found = auditSanitized(node('div', [], [node('span', [['onclick', 'alert(1)']])]))
  assert.equal(found.length, 1, JSON.stringify(found))
  assert.match(found[0]?.what ?? '', /event handler \(onclick\)/)
})

test('the audit is not written in terms of the sanitizer config', () => {
  /*
   * The point of the audit is that it disagrees with a broken configuration. If
   * it read `FORBIDDEN_TAGS`, editing that list would silence both the
   * sanitizer and the check that the sanitizer worked — same-source, which this
   * project has already been bitten by.
   *
   * `button` is forbidden by the config but is **not** a capability tag, so the
   * audit deliberately does not flag it. That asymmetry is the evidence the two
   * lists are independent; if someone unifies them, this test says so.
   */
  assert.ok(FORBIDDEN_TAGS.includes('button'), 'the config forbids button')
  assert.deepEqual(auditSanitized(node('div', [], [node('button')])), [])

  assert.ok(!FORBIDDEN_TAGS.includes('svg'), 'the config permits svg')
  assert.deepEqual(auditSanitized(node('div', [], [node('svg')])), [])
})

test('a javascript: URL is refused by an allow-list, in any spelling', () => {
  /*
   * An allow-list rather than a deny-list, because a deny-list has to
   * anticipate every spelling a parser accepts.
   */
  for (const value of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '  javascript:alert(1)']) {
    const found = auditSanitized(node('a', [['href', value]]))
    assert.equal(found.length, 1, `${value} -> ${JSON.stringify(found)}`)
    assert.match(found[0]?.what ?? '', /javascript: URL/, value)
  }
})

test('a same-document reference is allowed', () => {
  for (const value of ['#top', './local.png', '/rooted.png', 'mailto:a@b.test']) {
    // `/rooted.png` is allowed by the pattern; it is a same-origin path, and the
    // CSS side refuses fetches separately.
    const found = auditSanitized(node('a', [['href', value]]))
    assert.deepEqual(found, [], `${value} should be allowed`)
  }
})

test('an external target is named, not merely refused', () => {
  const found = auditSanitized(node('img', [['src', 'https://cdn.example.test/x.png']]))
  assert.equal(found.length, 1)
  assert.match(found[0]?.what ?? '', /cdn\.example\.test/, found[0]?.what ?? '')
})

test('the target description names a host or a scheme, never a placeholder', () => {
  assert.equal(describeTarget('https://fonts.gstatic.test/x.woff2'), 'fonts.gstatic.test')
  assert.equal(describeTarget('//cdn.jsdelivr.test/p.js'), 'cdn.jsdelivr.test')
  assert.equal(describeTarget('javascript:alert(1)'), 'a javascript: URL')
  assert.equal(describeTarget('data:text/html,<b>'), 'a data: URL')
  // A relative reference is quoted back rather than resolved against an
  // invented base — the mistake `card-css.ts` made and had to be corrected for.
  assert.equal(describeTarget('/local/thing.png'), '/local/thing.png')
})

test('an empty URI attribute is not a violation', () => {
  // `<a href="">` is ordinary markup and refusing it would put noise in the
  // report, which is how a report teaches its reader to stop reading.
  assert.deepEqual(auditSanitized(node('a', [['href', '']])), [])
  assert.deepEqual(auditSanitized(node('a', [['href', '   ']])), [])
})

test('violations are found at any depth, and all of them are reported', () => {
  /*
   * Reported in full rather than first-only: a reader fixing one and finding
   * another behind it learns to distrust the report's completeness, which costs
   * more than the extra lines.
   */
  const tree = node('div', [], [
    node('section', [], [
      node('p', [['onmouseover', 'x()']]),
      node('iframe', [['src', 'https://evil.test']]),
    ]),
    node('script'),
  ])
  const found = auditSanitized(tree)

  assert.equal(found.length, 4, JSON.stringify(found, null, 1))
  assert.deepEqual(
    found.map(v => v.where),
    ['div>section>p', 'div>section>iframe', 'div>section>iframe', 'div>script'],
  )
})

test('the forbidden lists are stated, not inherited', () => {
  /*
   * [checklist item 3] Upstream writes only `ADD_TAGS` and trusts the
   * sanitizer's defaults. We tighten, so the tightening is written down — a
   * default that widens in a later release would otherwise widen us with it,
   * silently, inside a dependency bump.
   */
  for (const tag of ['script', 'iframe', 'object', 'embed', 'form']) {
    assert.ok(FORBIDDEN_TAGS.includes(tag), `${tag} must be forbidden explicitly`)
  }
  assert.ok(FORBIDDEN_ATTRS.includes('formaction'))
  // `style` stays: a card styling its own panel inline is the ordinary case.
  assert.ok(!FORBIDDEN_ATTRS.includes('style'))
  assert.equal(ALLOWED_URI.test('#a'), true)
  assert.equal(ALLOWED_URI.test('https://x.test'), false)
})

/** A backtick, built so no escape has to survive being written. */
const TICK = String.fromCharCode(96)

test('an unrecognised element is unwrapped and its content kept', () => {
  /*
   * Upstream's rule, reached on the string: DOMPurify re-inserts a
   * not-allowed element's children where it stood and force-removes the
   * element (`purify.cjs.js:1894` → `_sanitizeDisallowedNode` at `:1743`).
   *
   * The card this was found on wraps its whole interface in `<Gui>` and closes
   * the message with `<StatusPlaceHolderImpl/>`; both arrived on the reading
   * surface as escaped text, which their author has never seen in SillyTavern.
   */
  assert.equal(unwrapUnknownTags('<Gui>hello</Gui>'), 'hello')
  assert.equal(unwrapUnknownTags('<StatusPlaceHolderImpl/>'), '')
  // A self-closing spelling with no slash, and an attribute, behave the same.
  assert.equal(unwrapUnknownTags('a<Gui id="x">b</Gui>c'), 'abc')
  // Case is not part of the name.
  assert.equal(unwrapUnknownTags('<GUI>x</gui>'), 'x')
})

test('a recognised element keeps its markup, and that is the older gap', () => {
  /*
   * Deliberate, and the reason is that the two cases have different fixes.
   * Upstream renders `<b>` as an element; Iris escapes it, so it shows as
   * source — the inline path of `INLINE-HTML.md` §三 (DEVIATIONS 25). Removing
   * `<b>` here would change what that gap *looks* like without closing it, and
   * would silently lose the emphasis the card asked for.
   */
  assert.equal(unwrapUnknownTags('<b>bold</b>'), '<b>bold</b>')
  assert.equal(unwrapUnknownTags('<span style="color:red">x</span>'), '<span style="color:red">x</span>')
  assert.ok(isKnownElement('DIV') && isKnownElement('svg'), 'known names are matched case-insensitively')
  assert.ok(!isKnownElement('Gui'), 'Gui is not an element name')
})

test('an unrecognised content-forbidding element takes its content with it', () => {
  /*
   * `script` is not in DOMPurify's allow-list *and* is in its
   * `FORBID_CONTENTS` (`purify.cjs.js:724`, consulted at `:1756`), so upstream
   * shows nothing at all. Unwrapping it instead would put a card's JavaScript
   * **source** into the reader's prose — a worse outcome than the escaped tag
   * this whole change exists to remove.
   */
  assert.equal(unwrapUnknownTags('<script>alert(1)</script>'), '')
  assert.equal(unwrapUnknownTags('before<script>alert(1)</script>after'), 'beforeafter')
  assert.equal(unwrapUnknownTags('<iframe src="https://evil.test"></iframe>'), '')
  // Unterminated: a browser reads the rest as the element's content, and so
  // does this — the alternative leaves half a script body on screen.
  assert.equal(unwrapUnknownTags('keep<script>alert(1)'), 'keep')
  // A stray closer is markup too, and goes on its own.
  assert.equal(unwrapUnknownTags('x</script>y'), 'xy')
})

test('removing markup cannot grant what the audit refuses', () => {
  /*
   * The transform is not a sanitizer and must never be read as one: its output
   * goes to `MarkdownText`, which renders it as text, so no element can come
   * out of it. The floor is still the audit and the forbidden lists, and this
   * pins that the tightening did not move — a later edit that made
   * `unwrapUnknownTags` "keep useful tags" would still have to face these.
   */
  for (const tag of ['script', 'iframe', 'object', 'embed', 'form']) {
    assert.ok(FORBIDDEN_TAGS.includes(tag), `${tag} must still be forbidden explicitly`)
  }
  assert.equal(auditSanitized(node('div', [], [node('script')])).length, 1)
  assert.equal(auditSanitized(node('div', [], [node('span', [['onclick', 'x()']])])).length, 1)

  // And nothing tag-shaped survives for the capability names, in either
  // direction: the element goes, and so does the handler that rode on it.
  assert.equal(unwrapUnknownTags('<script onerror="x()">bad</script>'), '')
  assert.doesNotMatch(unwrapUnknownTags('<Gui onclick="x()">t</Gui>'), /onclick/)
})

test('an inline code span keeps the markup it documents', () => {
  /*
   * A card that explains its own wrapper wrote those characters on purpose, and
   * upstream keeps them for the same reason one layer down: showdown hashes
   * code before it looks at raw HTML (`showdown.js:2503-2506`), so a tag inside
   * code reaches DOMPurify already escaped.
   */
  assert.equal(unwrapUnknownTags(`${TICK}<Gui>${TICK}`), `${TICK}<Gui>${TICK}`)
  assert.equal(unwrapUnknownTags(`<Gui>a${TICK}<Gui>${TICK}b</Gui>`), `a${TICK}<Gui>${TICK}b`)
  // An unclosed backtick is an ordinary character, so what follows is prose.
  assert.equal(unwrapUnknownTags(`${TICK}<Gui>x`), `${TICK}x`)
})

test('text that merely looks like markup is left alone', () => {
  // The rule is a tag lexer, not a hunt for angle brackets: narration that
  // compares numbers, or uses full-width brackets, is prose.
  assert.equal(unwrapUnknownTags('a < b and c > d'), 'a < b and c > d')
  assert.equal(unwrapUnknownTags('3<5'), '3<5')
  assert.equal(unwrapUnknownTags('<叹息>'), '<叹息>')
})

/** DOMPurify's own defaults, read out of the copy this app depends on. */
function purifyDefaults(): { allowed: Set<string>, forbidContents: Set<string> } {
  /*
   * Resolved rather than assumed: `dompurify` is a declared dependency of this
   * app, so failing to resolve it means the tree is stale — which this should
   * say loudly rather than skip past. A skipped drift check is not a check.
   */
  const require = createRequire(import.meta.url)
  /*
   * The package's `require` entry, which is the unminified CommonJS build with
   * the name lists still spelled as source arrays. Asked for by package name,
   * not by path: `dompurify` does not export its `./dist/*` subpaths, and a
   * hard-coded path would also have to guess where the installer put it.
   */
  const entry = require.resolve('dompurify')
  assert.match(entry, /purify\.c(?:js|ov\.cjs)\.js$/, `dompurify resolved to ${entry}`)
  const source = readFileSync(entry, 'utf8')

  /*
   * The quoted names in one array literal.
   *
   * Line comments are stripped first, and not defensively: this build of
   * DOMPurify writes four paragraphs of `//` commentary *inside* the
   * `FORBID_CONTENTS` literal, and their prose contains apostrophes — so
   * splitting on commas harvested `"which the engine refills"` as an element
   * name. Extracting quoted runs from comment-free text is the only reading
   * that survives a maintainer explaining themselves.
   */
  const names = (block: string): string[] =>
    [...block.replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map(hit => (hit[1] ?? '').toLowerCase())

  const list = (name: string): string[] => {
    const escaped = name.replace(/\$/g, '\\$')
    const found = new RegExp(`const ${escaped} = freeze\\(\\[([\\s\\S]*?)\\]\\);`).exec(source)
    assert.ok(found !== null, `dompurify no longer spells its ${name} list this way`)
    return names(found[1] ?? '')
  }

  const forbid = /const DEFAULT_FORBID_CONTENTS = addToSet\(\{\}, \[([\s\S]*?)\]\);/.exec(source)
  assert.ok(forbid !== null, 'dompurify no longer spells DEFAULT_FORBID_CONTENTS this way')

  return {
    allowed: new Set([...list('html$1'), ...list('svg$1'), ...list('svgFilters'), ...list('mathMl$1')]),
    forbidContents: new Set(names(forbid[1] ?? '')),
  }
}

test('the known-element table is DOMPurify’s default allow-list, not a guess', () => {
  /*
   * A constant that encodes a measurement drifts silently, so the comparison
   * lives in the build. Upstream passes no `ALLOWED_TAGS` and no `USE_PROFILES`
   * (`public/script.js:1898-1908`), so what a card gets is exactly
   * `DEFAULT_ALLOWED_TAGS` — `html + svg + svgFilters + mathMl + text`
   * (`purify.cjs.js:605`) — plus its one `ADD_TAGS` entry.
   *
   * `#text` is excluded here because this table is asked about tag names.
   */
  const { allowed } = purifyDefaults()
  const expected = new Set([...allowed, 'custom-style'])

  const extra = [...KNOWN_ELEMENTS].filter(name => !expected.has(name)).sort()
  const missing = [...expected].filter(name => !KNOWN_ELEMENTS.has(name)).sort()

  assert.deepEqual(extra, [], `names we treat as known that upstream removes: ${extra.join(' ')}`)
  assert.deepEqual(missing, [], `names upstream keeps that we would strip: ${missing.join(' ')}`)
  assert.ok(KNOWN_ELEMENTS.size > 200, `the table collapsed to ${String(KNOWN_ELEMENTS.size)} names`)

  // The omissions that read as mistakes, stated so a reader stops re-checking:
  // DOMPurify forbids these by leaving them out of the allow-list.
  for (const name of ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'noscript']) {
    assert.ok(!KNOWN_ELEMENTS.has(name), `${name} must not count as a known element`)
  }
})

test('the content-forbidden set is exactly the unrecognised half of upstream’s', () => {
  /*
   * Two of DOMPurify's lists combine into one behaviour, and only their
   * intersection matters: a name in `FORBID_CONTENTS` that is *allowed*
   * (`audio`, `head`, `style`, `title`, …) never reaches the removal branch at
   * all, so listing it here would claim a rule that cannot fire.
   */
  const { allowed, forbidContents } = purifyDefaults()
  const expected = [...forbidContents].filter(name => !allowed.has(name)).sort()

  assert.deepEqual([...UNKNOWN_CONTENT_FORBIDDEN].sort(), expected, expected.join(' '))
  assert.ok(UNKNOWN_CONTENT_FORBIDDEN.has('script'), 'script is the one that matters')
  assert.ok(!UNKNOWN_CONTENT_FORBIDDEN.has('audio'), 'audio is allowed, so the rule cannot fire on it')
})
