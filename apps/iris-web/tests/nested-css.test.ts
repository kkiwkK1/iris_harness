/**
 * A nested frame's CSS, re-pointed at the elements standing in for its document.
 *
 * Both halves are load-bearing and they fail in opposite directions: unconfined,
 * a card's `html,body{…}` reaches the script frame's real document and the
 * shell's own nodes; confined by `@scope` alone, the same rules match nothing,
 * because inside a scope a `body` selector looks for a `<body>` in that subtree.
 * The second failure is the quiet one — the panel mounts with no height and
 * reports nothing.
 *
 * @module iris-web/tests/nested-css
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeFrameCssRefusals, repointFrameCss } from '../src/sandbox/nested-css.ts'

const IDS = { html: 'iris-nf1-html', body: 'iris-nf1-body' }

test('the height chain survives, which is the whole point', () => {
  /*
   * The exact rule a full-screen card writes, and the one that decides whether
   * the panel is visible at all. Left as `html,body,#app`, `@scope` makes every
   * term but `#app` unmatchable, `height:100%` resolves against an `auto`
   * parent, and the panel is a zero-height nothing.
   */
  const { css } = repointFrameCss('html,body,#app{height:100%}', IDS, '1')

  /*
   * **The root term must be `:scope`, not the wrapper's id** — measured, and it
   * is the whole difference between this chain working and silently not.
   * Inside `@scope (#x)` every compound gets an implicit `:scope ` *descendant*
   * prefix, so `#x` written there means "a descendant of #x that is also #x"
   * and matches nothing. The same id in the `@scope (…)` prelude is a different
   * position and still means the element.
   *
   * Measured in a laid-out page, host 300px, content 900px:
   * `#x` gave 900/900/900 with no scrollbar; `:scope` gave 300/300/300 and
   * scrolled — identical to a control with no `@scope` at all.
   *
   * **The first version of this test asserted `/#iris-nf1-html/`, which the
   * `@scope (…)` prelude satisfies by itself** — so it passed against output
   * whose height chain could not match. That is why the id is now checked
   * *outside* the prelude, where it must not appear.
   */
  assert.match(css, /@scope \(#iris-nf1-html\)/)
  assert.match(css, /:scope/, 'the root term is not :scope')
  assert.doesNotMatch(
    css.replace(/@scope \([^)]*\)/, ''),
    /#iris-nf1-html/,
    'the html id is used as a rule selector, where it cannot match',
  )
  assert.match(css, /#iris-nf1-body/)
  assert.match(css, /#app/)
  assert.doesNotMatch(css, /(^|[^-\w#.])html\b/, 'a bare html selector survived')
  assert.doesNotMatch(css, /(^|[^-\w#.])body\b/, 'a bare body selector survived')
})

test('the sheet is confined to the stand-in, not to a message', () => {
  // The scope root is the stand-in's own html-level wrapper, so a rule that
  // survives applies to that subtree and to nothing else in the frame.
  const { css } = repointFrameCss('.panel{color:red}', IDS, '1')
  assert.match(css, /@scope \(#iris-nf1-html\)/)
})

test(':root is re-pointed too, since a card uses it for its variables', () => {
  const { css } = repointFrameCss(':root{--bg:#0e1028}', IDS, '1')
  // `:root` sits in the same position as `html` — the scoping root — so it takes
  // `:scope` for the same measured reason.
  assert.match(css, /:scope\s*\{--bg:#0e1028\}/)
  assert.doesNotMatch(css, /:root/)
})

test('a name that merely contains the word is left alone', () => {
  /*
   * The failure mode of doing this with a plain replace. Every one of these is
   * a real thing a card writes, and rewriting any of them changes which
   * elements the card's own rules select — a corruption that looks like the
   * card's bug, not ours.
   */
  const { css } = repointFrameCss(
    '.body{a:1}#body{b:2}.bodybuilder{c:3}x-body{d:4}--body{e:5}.html-wrap{f:6}',
    IDS,
    '1',
  )
  /*
   * Compared with the space before each brace removed. `scopeCardCss` puts one
   * between a prelude and its block, so asserting on a literal `.body{` tests
   * the formatter rather than the rewriter — which is what the first version of
   * this test did, and it failed on correct output.
   */
  const flat = css.replace(/\s+\{/g, '{')
  for (const kept of ['.body{', '#body{', '.bodybuilder{', 'x-body{', '.html-wrap{']) {
    assert.ok(flat.includes(kept), `${kept} was rewritten: ${flat}`)
  }
})

test('an attribute selector naming body is data, not an element', () => {
  const { css } = repointFrameCss('[data-role="body"]{a:1}', IDS, '1')
  assert.match(css, /\[data-role="body"\]/)
})

test('a string in a declaration naming html is data too', () => {
  const { css } = repointFrameCss('.x::before{content:"body html"}', IDS, '1')
  assert.match(css, /content:"body html"/)
})

test('a compound and a descendant selector both keep their shape', () => {
  const { css } = repointFrameCss('html.dark body > .card{a:1}', IDS, '1')
  // `:scope.dark` is a valid compound and keeps the card's intent: the root,
  // when it also carries `.dark`.
  assert.match(css, /:scope\.dark #iris-nf1-body > \.card/)
})

test('an at-rule prelude is copied through, and its inner selectors are not lost', () => {
  /*
   * A media query is where a responsive card puts its real layout, so losing
   * the rules inside one loses the layout on exactly the screens it was written
   * for. The prelude itself must not be touched: `@supports (display:grid)` can
   * contain words that look like selectors, and a rewritten prelude is CSS the
   * browser drops without a word.
   */
  const { css } = repointFrameCss('@media (min-width:40em){body{padding:2rem}}', IDS, '1')
  assert.match(css, /@media \(min-width:40em\)/)
  assert.match(css, /#iris-nf1-body\s*\{padding:2rem\}/)
})

test('what card-css refuses is still refused, and reportable', () => {
  // Routed through `scopeCardCss` rather than reimplemented, so the two places
  // a card's CSS is confined cannot come to disagree about `@font-face`.
  const scoped = repointFrameCss('@font-face{font-family:x;src:url(https://e/f.woff2)}', IDS, '1')
  assert.ok(scoped.refused.includes('@font-face'))
  assert.match(String(describeFrameCssRefusals(scoped)), /@font-face refused/)
  assert.equal(describeFrameCssRefusals({ css: '', refused: [] }), undefined)
})

test('two frames do not share a keyframe name', () => {
  // The card copies the whole sheet into each frame it builds; identical
  // `@keyframes spin` in two stand-ins in one document is one animation
  // silently winning.
  const one = repointFrameCss('@keyframes spin{to{rotate:1turn}}.a{animation:spin 1s}', IDS, '1')
  const two = repointFrameCss(
    '@keyframes spin{to{rotate:1turn}}.a{animation:spin 1s}',
    { html: 'iris-nf2-html', body: 'iris-nf2-body' },
    '2',
  )
  const nameOf = (css: string): string => String(/@keyframes\s+(\S+)/.exec(css)?.[1])
  assert.notEqual(nameOf(one.css), nameOf(two.css))
  // And each rule still refers to its own frame's name, or the animation is
  // renamed into nothing and simply does not run.
  assert.ok(one.css.includes(`animation:${nameOf(one.css)}`))
  assert.ok(two.css.includes(`animation:${nameOf(two.css)}`))
})
