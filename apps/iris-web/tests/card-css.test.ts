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

test('a comment above an at-rule does not turn it into a selector', () => {
  /*
   * A defect found by reading this function's real output on a real card, not
   * by a failing test — which is why it had survived: everything about it looks
   * right.
   *
   * `topLevelPieces` hands back everything between the previous block and this
   * one as the prelude, so a card that labels its animation puts a comment at
   * the front of it. `atRuleName` read that as "not an at-rule" and the piece
   * went in as a selector — and a `@keyframes` **inside `@scope` defines
   * nothing**, so the animation simply never ran. 爱衣's `[美化]变量更新中`
   * labels its `@keyframes shimmer` exactly this way and its markup carries
   * `animation: shimmer 2s linear infinite`, so this was a dead animation on a
   * corpus card — and the same hole was under the nested-frame path before any
   * message sheet went through here.
   */
  const labelled = [
    '/* 流光动画 Keyframes */',
    '@keyframes shimmer { 100% { transform: translateX(100%) } }',
    '.shimmer-effect { animation: shimmer 2s linear infinite }',
  ].join('\n')

  for (const policy of ['rename', 'keep'] as const) {
    const { css } = scopeCardCss(labelled, '6', 'body', policy)
    const keyframesAt = css.indexOf('@keyframes')
    const scopeAt = css.indexOf('@scope')
    assert.ok(keyframesAt !== -1, `${policy}: the definition is gone`)
    assert.ok(scopeAt !== -1, `${policy}: nothing was scoped`)
    assert.ok(keyframesAt < scopeAt, `${policy}: a keyframe inside @scope defines nothing`)
  }

  // And the rename still finds it, which is the other half of the same read:
  // a definition that never reached the keyframes branch was never collected,
  // so its reference was never rewritten either.
  const { css } = scopeCardCss(labelled, '6')
  assert.match(css, /@keyframes iris-c6-shimmer/)
  assert.match(css, /animation: iris-c6-shimmer 2s linear infinite/)
})

test('a keyframe keeps its name where nothing can collide with it', () => {
  /*
   * `keep` is for a document holding one card's CSS — a message frame — and it
   * exists because of a measurement, not a preference: **5 of the corpus's 13
   * message-level sheets define keyframes that the message's own markup names
   * from a `style=` attribute** (爱衣's `shimmer`, 可攻略女主's `moon-halo` and
   * `stars-twinkle`, 暗渊's `moon-pulse`, `stars-drift`, `moonlight-sweep`).
   * The rewrite only reaches `animation` declarations inside the sheet being
   * renamed, so renaming would leave those attributes naming an animation
   * nobody defines — a decoration that stops with no error attached. Renaming
   * is a collision measure, and inside a frame there is nothing to collide
   * with.
   *
   * The lift is not optional either way: `@keyframes` cannot live inside
   * `@scope`, so it comes out of the block whatever its name is.
   */
  const { css } = scopeCardCss(
    '@keyframes moon-halo { from { opacity: 0 } }\n.dot { animation: moon-halo 3s infinite }',
    '9',
    'body',
    'keep',
  )

  assert.match(css, /@keyframes moon-halo/, 'the markup’s style attribute names this animation')
  assert.ok(!css.includes('iris-c9-moon-halo'), css)
  assert.match(css, /animation: moon-halo 3s infinite/, 'the sheet’s own reference must still match')
  assert.ok(css.indexOf('@keyframes') < css.indexOf('@scope'), 'a keyframe inside @scope defines nothing')
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
