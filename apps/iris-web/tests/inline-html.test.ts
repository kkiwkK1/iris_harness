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

import {
  ALLOWED_URI,
  FORBIDDEN_ATTRS,
  FORBIDDEN_TAGS,
  auditSanitized,
  describeTarget,
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
