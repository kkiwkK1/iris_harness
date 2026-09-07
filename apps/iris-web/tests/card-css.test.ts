/**
 * Confining a card's stylesheet, and the inputs a regex would get wrong.
 *
 * @module iris-web/tests/card-css
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { scopeCardCss } from '../src/app/card-css.ts'

test('ordinary rules are confined to the one message', () => {
  const { css, refused } = scopeCardCss('.panel { color: red }', '7')

  assert.match(css, /@scope \(#iris-msg-7\)/)
  assert.match(css, /\.panel \{ color: red \}/)
  assert.deepEqual(refused, [])
})

test('the scope root is the candidate, not the floor', () => {
  /*
   * [notes/apps/iris-web/INLINE-HTML.md §4.4] Upstream deletes a floor with `chat.splice(index, 1)`,
   * which shifts every later floor. Styles hung off a floor number would land on
   * a different message after one deletion — a card's CSS reaching someone
   * else's text is exactly what the scoping is for.
   */
  const a = scopeCardCss('.p{color:red}', 'abc')
  const b = scopeCardCss('.p{color:red}', 'xyz')
  assert.match(a.css, /#iris-msg-abc/)
  assert.match(b.css, /#iris-msg-xyz/)
})

test('keyframes are lifted out, renamed, and their references follow', () => {
  /*
   * `@keyframes` cannot sit inside `@scope`, and its names are **global** — two
   * cards defining `pulse` overwrite each other, which [§4.4] records as a
   * collision upstream has today. Lifting without renaming would keep the
   * collision; renaming without rewriting the references would break the
   * animation. Both halves come off one list, so they cannot drift.
   */
  const { css } = scopeCardCss(
    '@keyframes pulse { from { opacity: 0 } to { opacity: 1 } }\n.dot { animation: pulse 2s infinite }',
    '3',
  )

  assert.match(css, /@keyframes iris-c3-pulse/, 'the definition is renamed')
  assert.ok(!/@scope[^]*@keyframes/.test(css.replace(/\n/g, '')) || css.indexOf('@keyframes') < css.indexOf('@scope'),
    'the definition sits outside the scope block')
  assert.match(css, /animation: iris-c3-pulse 2s infinite/, 'the reference is rewritten')
})

test('a keyframe name is not rewritten inside a longer name', () => {
  const { css } = scopeCardCss(
    '@keyframes fade { from { opacity: 0 } }\n'
      + '@keyframes fade-in { from { opacity: 0 } }\n'
      + '.a { animation-name: fade-in }',
    '1',
  )
  // `fade` must not eat the `fade` inside `fade-in`.
  assert.match(css, /animation-name: iris-c1-fade-in/)
  assert.ok(!css.includes('iris-c1-fade-in-in'), css)
})

test('a keyframe name that appears in a string is left alone', () => {
  /*
   * The rewrite is confined to `animation` declarations for this reason: a
   * keyframe called `spin` must not rewrite the word in `content: "spin"`, which
   * is text a reader sees.
   */
  const { css } = scopeCardCss(
    '@keyframes spin { from { rotate: 0deg } }\n.label::after { content: "spin" }',
    '2',
  )
  assert.match(css, /content: "spin"/, 'the string is untouched')
  assert.match(css, /@keyframes iris-c2-spin/)
})

test('a keyframe name is not rewritten outside an animation declaration', () => {
  /*
   * Two guards cover the string case above — the rewrite is confined to
   * `animation` declarations, **and** the name must sit on a whitespace or comma
   * boundary, which a quote already fails. So that test could not tell whether
   * the confinement existed: a mutation removing it stayed green.
   *
   * This input separates them. `spin` here sits on a comma boundary in a
   * declaration that is not an animation, so only the confinement can save it.
   * Which is the honest resolution of a two-guard case: find the input that
   * distinguishes them, or accept that one guard is redundant and remove it.
   */
  const { css } = scopeCardCss(
    '@keyframes spin { from { rotate: 0deg } }\n.x { font-family: spin, sans-serif }',
    '2',
  )

  assert.match(css, /font-family: spin, sans-serif/, 'a font alias is not an animation name')
  assert.match(css, /@keyframes iris-c2-spin/, 'while the definition is still renamed')
})

test('fetching at-rules are refused by name', () => {
  const { css, refused } = scopeCardCss(
    '@import url("https://cdn.example/x.css");\n@font-face { font-family: X; src: url(https://cdn.example/x.woff2) }\n.p{color:red}',
    '4',
  )
  assert.ok(refused.includes('@import'), refused.join(','))
  assert.ok(refused.includes('@font-face'), refused.join(','))
  assert.ok(!css.includes('cdn.example'), css)
  // A space between prelude and block is normal CSS; the first version of this
  // expectation was literal enough to fail on formatting rather than on meaning.
  assert.match(css, /\.p\s*\{color:red\}/, 'the rest of the sheet survives')
})

test('a rule that fetches is refused, one that references the document is kept', () => {
  /*
   * [§4.3] refuses every external load, measured at zero cost on the corpus —
   * while noting what that zero means: the tightening hits nothing that exists,
   * not that it never will. `url(#…)` is a same-document reference (an SVG
   * filter) and is not a fetch.
   */
  const fetches = scopeCardCss('.a { background: url(https://cdn.example.test/y.png) }', '5')
  assert.ok(fetches.refused.some(r => r.includes('external')), fetches.refused.join(','))
  assert.ok(!fetches.css.includes('cdn.example.test'))

  /*
   * **The host is named, and that is a requirement rather than a nicety.**
   * [notes/TEST-CARDS.md / `docs/OBSERVABILITY.md` gap 8] the corpus has cards that print
   * their own message when a resource fails to load — one blames the user's
   * tavern. An unnamed refusal loses to that: the reader believes the card and
   * goes to check their installation. Ours has to be the more specific of the
   * two reports.
   */
  assert.ok(
    fetches.refused.some(r => r.includes('cdn.example.test')),
    `the refusal must name what it refused: ${fetches.refused.join(',')}`,
  )

  const local = scopeCardCss('.b { filter: url(#blur) }', '5')
  assert.deepEqual(local.refused, [])
  assert.match(local.css, /url\(#blur\)/)
})

test('a card may not redefine a reserved theme variable', () => {
  const { css, refused } = scopeCardCss(
    '.p { --iris-ink: red; --card-own: blue; color: green }',
    '6',
  )
  assert.ok(refused.some(r => r.includes('--iris-')), refused.join(','))
  assert.ok(!css.includes('--iris-ink'), css)
  assert.match(css, /--card-own: blue/, "the card's own variables are its business")
  assert.match(css, /color: green/)
})

test('a brace inside a string does not end the rule early', () => {
  /*
   * The property a regex gets wrong, and the reason this is a scanner:
   * `content: "}"` is ordinary CSS. A counter that took that brace seriously
   * would close the rule there and leave the rest of the sheet outside the
   * scope — unconfined, which is the one outcome this module exists to prevent.
   */
  const { css } = scopeCardCss('.a { content: "}" } .b { color: red }', '8')
  assert.match(css, /\.b \{ color: red \}/, 'the rule after the string survives')
  assert.equal(css.split('@scope').length - 1, 1, 'and it is inside the single scope block')
})

test('a comment containing a brace does not end the rule early', () => {
  /*
   * The first version of this test only asserted that the *following* rule
   * survived, and a mutation that removed comment handling entirely went
   * unnoticed: the rule after the comment survives either way, because the
   * scanner recovers at the next brace. What breaks is the rule the comment is
   * **inside** — its declarations end up outside it — so that is what has to be
   * asserted.
   */
  const { css } = scopeCardCss('.a { /* } */ color: red } .b { color: blue }', '9')

  assert.match(css, /\.b \{ color: blue \}/, 'the following rule survives')

  /*
   * The rule's block has to come through **whole**, and that is asserted
   * literally rather than structurally. Two earlier attempts failed for
   * instructive reasons:
   *
   * - a "no braces between `.a` and `color: red`" span cannot work, because the
   *   surviving comment legitimately contains a brace;
   * - stripping comments first and then checking structure **passes on the
   *   broken output too**, because removing the comment repairs the very damage
   *   under test — the mutation splits the rule at the brace inside the comment,
   *   and deleting the comment glues the halves back together.
   *
   * So the assertion is the intact block. When the scanner reads a brace out of
   * a comment, the block is truncated to `{ /* }` and the remainder becomes a
   * selector, so this substring simply is not there.
   */
  assert.ok(
    css.includes('.a { /* } */ color: red }'),
    `the rule was split at the brace inside its comment: ${css}`,
  )
})

test('an empty sheet produces nothing rather than an empty scope block', () => {
  assert.deepEqual(scopeCardCss('', '1'), { css: '', refused: [] })
  assert.deepEqual(scopeCardCss('   \n  ', '1'), { css: '', refused: [] })
})

test('a media query keeps its own block and is still confined', () => {
  const { css, refused } = scopeCardCss('@media (min-width: 40em) { .a { color: red } }', '1')
  assert.deepEqual(refused, [])
  assert.match(css, /@scope \(#iris-msg-1\)/)
  assert.match(css, /@media \(min-width: 40em\)/)
})

test('every refusal names something the reader can act on', () => {
  /*
   * Found by printing what this function actually says, not by asserting that
   * it says something. An earlier version resolved every reference against
   * `https://placeholder.invalid`, so a relative `url(/local/thing.png)` was
   * reported as loading from **placeholder.invalid** — a hostname invented by
   * our own parser, handed to a card author as if it were theirs.
   *
   * A report that invents a name is worse than one that stays vague, because it
   * is actionable in the wrong direction.
   */
  const cases: [string, string][] = [
    ['.a { background: url(https://fonts.gstatic.test/x.woff2) }', 'fonts.gstatic.test'],
    [".b { background: url('//cdn.jsdelivr.test/p.png') }", 'cdn.jsdelivr.test'],
    ['.c { background: url(data:image/png;base64,AAA) }', 'a data: URL'],
    ['.d { background: url(/local/thing.png) }', '/local/thing.png'],
    ['.e { background: image-set("a.png" 1x) }', 'an image-set() candidate'],
  ]

  for (const [css, expected] of cases) {
    const { refused } = scopeCardCss(css, '1')
    assert.equal(refused.length, 1, `${css} -> ${refused.join(',')}`)
    assert.ok(refused[0]?.includes(expected), `expected ${expected} in: ${refused[0] ?? '(none)'}`)
    assert.ok(
      !refused[0]?.includes('placeholder'),
      `the parser's own base leaked into the report: ${refused[0] ?? ''}`,
    )
  }
})
