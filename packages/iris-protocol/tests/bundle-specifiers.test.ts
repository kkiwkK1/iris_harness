/**
 * The specifier walker and the bundle route, which both halves share.
 *
 * The cases here are the ones that have actually gone wrong, not a tour of the
 * API: a minified specifier with no space after `from`, a root-relative nested
 * dependency, a quote inside a regex literal, and a URL a card merely mentions
 * in a string it displays.
 *
 * @module @iris/protocol/tests/bundle-specifiers
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BUNDLE_PROXY_PATH,
  fromProxied,
  rewriteSpecifiers,
  specifierSpans,
  toProxied,
} from '../src/bundle-specifiers.ts'

const ORIGIN = 'http://127.0.0.1:8787'

/** Read the specifiers a source contains, which is what the spans are for. */
function specifiersOf(source: string): string[] {
  return specifierSpans(source).map(span => source.slice(span.open + 1, span.close))
}

test('a proxied URL round-trips', () => {
  const upstream = 'https://testingcf.jsdelivr.net/npm/pinia/+esm'
  const proxied = toProxied(upstream, ORIGIN)
  assert.ok(proxied.startsWith(`${ORIGIN}${BUNDLE_PROXY_PATH}?url=`))
  assert.equal(fromProxied(proxied), upstream)
  // `+` has to survive: it is `+esm`'s whole meaning to jsDelivr, and a raw `+`
  // in a query string decodes as a space.
  assert.ok(proxied.includes('%2Besm'), proxied)
})

test('a URL that is not ours is not mistaken for one', () => {
  assert.equal(fromProxied('https://testingcf.jsdelivr.net/npm/pinia/+esm'), undefined)
  assert.equal(fromProxied('/npm/vue@3.5.41/+esm'), undefined)
})

test('a minified specifier is found, with no space after the keyword', () => {
  /*
   * The real card's first line. A pattern anchored on whitespace after `from`
   * misses this entirely, and the miss is silent — the specifier goes direct to
   * the CDN and the failure surfaces somewhere else.
   */
  const source = "import{createPinia as e,defineStore as n}from'https://cdn.example/npm/pinia/+esm';"
  assert.deepEqual(specifiersOf(source), ['https://cdn.example/npm/pinia/+esm'])
})

test('every import form a bundle actually uses is found', () => {
  const source = [
    'import "./side-effect.js";',
    'import x from "./default.js"',
    'import * as ns from "./ns.js"',
    'export { a } from "./re-export.js"',
    'const later = await import("./dynamic.js")',
    'import{a as b}from"./minified.js"',
  ].join('\n')
  assert.deepEqual(specifiersOf(source), [
    './side-effect.js',
    './default.js',
    './ns.js',
    './re-export.js',
    './dynamic.js',
    './minified.js',
  ])
})

test('a word that merely contains a keyword is not one', () => {
  // `important` and `informant` both start with a keyword, and `x.from` is a
  // property. Each would put the walk on a quote pair that is not a specifier.
  const source = 'const important="a";const informant="b";obj.from("c");'
  assert.deepEqual(specifiersOf(source), [])
})

test('a URL a card only mentions is left alone', () => {
  /*
   * The reason replacement is confined to the specifier span. A card that
   * *displays* a CDN URL — in a credit line, an error message — must not have
   * the text it shows rewritten.
   */
  const source = 'const credit = "built from https://cdn.example/npm/pinia/+esm";'
  assert.deepEqual(specifiersOf(source), [])
  assert.equal(rewriteSpecifiers(source, () => 'REPLACED'), source)
})

test('a root-relative nested specifier is visible to the walk', () => {
  /*
   * **The one that cost a card its interface.** A jsDelivr `+esm` bundle's own
   * dependencies look like this, and they resolve against whoever served the
   * module — so a host that serves the body must rewrite them, resolving each
   * against the upstream URL first. The walker's job is only to find them; that
   * it does is what makes the host's fix possible at all.
   */
  const body = 'import{a}from"/npm/vue@3.5.41/+esm";import"/npm/side/+esm";'
  assert.deepEqual(specifiersOf(body), ['/npm/vue@3.5.41/+esm', '/npm/side/+esm'])
})

test('the host’s rewrite resolves against the upstream URL, not against itself', () => {
  /*
   * The shape the host needs, written here because this is the module both
   * sides share and the agreement is the point. Resolving `/npm/vue@3.5.41/+esm`
   * against the *upstream* URL keeps it on the CDN it came from; resolving it
   * against our own origin is the 404 that started this.
   */
  const upstream = 'https://testingcf.jsdelivr.net/npm/pinia/+esm'
  const body = 'import{a}from"/npm/vue@3.5.41/+esm";'
  const out = rewriteSpecifiers(body, specifier => {
    const absolute = new URL(specifier, upstream).href
    return toProxied(absolute, ORIGIN)
  })
  assert.equal(
    fromProxied(out.slice(out.indexOf('"') + 1, out.lastIndexOf('"'))),
    'https://testingcf.jsdelivr.net/npm/vue@3.5.41/+esm',
  )
})

test('returning the specifier unchanged, or undefined, leaves the source byte-identical', () => {
  // Both spellings of "leave this one alone", because a caller deciding
  // per-specifier will use whichever reads better and must get the same result.
  const source = 'import "a";import "b";'
  assert.equal(rewriteSpecifiers(source, s => s), source)
  assert.equal(rewriteSpecifiers(source, () => undefined), source)
})

test('several specifiers are replaced without shifting each other', () => {
  /*
   * Back to front, which is why this works: a proxied URL is much longer than
   * the specifier it replaces, so rewriting front to back would leave every
   * later span pointing into the middle of an already-rewritten string.
   */
  const source = 'import "https://a.example/x";import "https://b.example/y";'
  const out = rewriteSpecifiers(source, s => toProxied(s, ORIGIN))
  const found = specifiersOf(out).map(s => fromProxied(s))
  assert.deepEqual(found, ['https://a.example/x', 'https://b.example/y'])
})

test('a quote inside a regex literal costs a rewrite, not the source', () => {
  /*
   * The measured failure mode of the version this replaced, kept as a pin on
   * the *direction* of the damage. Token anchoring means a stray quote can make
   * a later specifier invisible — a missed rewrite, which degrades to "the
   * import goes direct" — and cannot make the walk emit a span that straddles
   * real code, which would corrupt what the card runs.
   */
  const source = 'const re = /["]/;import "https://a.example/x";'
  for (const specifier of specifiersOf(source)) {
    assert.ok(
      source.includes(`"${specifier}"`) || source.includes(`'${specifier}'`),
      `a span was emitted that is not a quoted specifier: ${JSON.stringify(specifier)}`,
    )
  }
})

test('an unterminated specifier does not swallow the next line', () => {
  /*
   * A truncated bundle, **with a later quote available to be swallowed** —
   * which is where all the discriminating power of this case lives. Without the
   * newline guard the walk runs past the line end, finds the next quote in
   * ordinary code, and emits a span straddling real source; a caller replacing
   * that span corrupts what the card runs.
   *
   * The first version of this test ended the source right after the truncated
   * specifier, so there was no later quote at all: the guarded and the unguarded
   * walk both skipped it, and removing the guard left the test green. The
   * assertion was true and proved nothing.
   */
  const source = 'import "https://a.example/x\nconst after = "hello";'
  assert.deepEqual(specifiersOf(source), [])

  // And the source survives a caller that rewrites whatever it is handed.
  assert.equal(rewriteSpecifiers(source, () => 'REPLACED'), source)
})
test('prose inside a template literal is not a specifier', () => {
  /*
   * **Verbatim from the real pinia bundle**, which is where this was found — by
   * 49, running the walker over the body the host actually serves:
   *
   *   d(`Global state imported from "${t.name}".`)
   *
   * `from` sits on a word boundary, so the walk accepted it, paired the quote
   * before `${` with the one after `}`, and emitted `${t.name}` as a specifier.
   *
   * Harmless in the browser — not an allowed remote, so nothing rewrites it —
   * and **damaging in the host**, which resolves every specifier against the
   * upstream URL and re-wraps it, turning a span over real code into corrupted
   * source. That asymmetry is why this is fixed in the walker rather than
   * filtered by either caller: the same span is safe on one side of the wire
   * and destructive on the other.
   */
  const real = 'async function ze(e){try{ge(e,JSON.parse(await navigator.clipboard.readText())),'
    + 'd(`Global state imported from "${t.name}".`)}catch(n){}}'
  assert.deepEqual(specifiersOf(real), [])
  assert.equal(rewriteSpecifiers(real, () => 'REPLACED'), real)
})

test('a keyword inside an ordinary string or a comment is prose too', () => {
  // The same family, reached by the other three routes into non-code.
  const cases = [
    `const note = "copied from './elsewhere.js' by hand";`,
    '// import "./commented-out.js"',
    '/* import "./blocked-out.js" */',
  ]
  for (const source of cases) {
    assert.deepEqual(specifiersOf(source), [], source)
  }
})

test('the real bundle body yields its three imports and nothing else', () => {
  /*
   * The whole shape at once, as an excerpt of the served body: three nested
   * dependencies — the reason the host must rewrite bodies at all — plus the
   * prose that used to make a fourth. Asserting the **count** as well as the
   * contents is the point: the failure this pins is an extra span, and a test
   * that only checked "the three are found" would have passed throughout.
   */
  const body = [
    'import{hasInjectionContext as ne,inject as oe}from"/npm/vue@3.5.41/+esm";',
    'import"/npm/nostics@1.2.0/+esm";',
    'import{setupDevtoolsPlugin as ae}from"/npm/@vue/devtools-api@8.2.1/+esm";',
    'var k=typeof global<"u"?global:{};',
    'async function ze(e){d(`Global state imported from "${t.name}".`)}',
  ].join('')
  assert.deepEqual(specifiersOf(body), [
    '/npm/vue@3.5.41/+esm',
    '/npm/nostics@1.2.0/+esm',
    '/npm/@vue/devtools-api@8.2.1/+esm',
  ])
})

test('an already-proxied specifier is recognised, so nothing is wrapped twice', () => {
  // What the host's own output looks like on the next pass: a body it has
  // already rewritten must not be rewritten again, or the upstream URL is only
  // recoverable by unwrapping twice.
  const served = 'import{a}from"/iris/script-bundle?url=https%3A%2F%2Fcdn.example%2Fx";'
  const found = specifiersOf(served)
  assert.equal(found.length, 1)
  assert.equal(fromProxied(String(found[0])), 'https://cdn.example/x')
})
test('three real bundles the host served produce no false spans', () => {
  /*
   * **Verbatim excerpts from the bodies `8787` actually served**, each one the
   * shape that produced a false span. Together they were 23 of them across the
   * four bundles measured (typed-function 3, mathjs 11, the card's own script
   * 9, pinia 0); with the string/template/comment skip in place the count is 0.
   *
   * Excerpts rather than whole bodies, and the reason is a rule rather than
   * convenience: mathjs is 667 KB and the card's script 928 KB, and a fixture
   * nobody can read is a fixture nobody checks. What is kept is the exact text
   * around each false span, so the *shape* is real even though the file is not.
   *
   * Why each is dangerous rather than merely wrong: in the browser a bare
   * specifier is not an allowed remote, so nothing rewrites it. In the **host**
   * every specifier is resolved against the upstream URL and re-wrapped, so a
   * span over live code becomes corrupted source — and the mathjs one looks
   * exactly like a real import, because it *is* one, quoted inside a doc
   * example.
   */
  const excerpts: readonly (readonly [string, string])[] = [
    [
      'typed-function: a message about conversions, in a single-quoted string',
      `.to===e.from)throw new SyntaxError('Illegal to define conversion from "'+e.from+'" to itself');`,
    ],
    [
      'mathjs: a real import, quoted inside a template-literal doc example',
      'const doc = `Create the default configuration.\nExample:\n\n  import { create, all } from '
        + `'mathjs';\n  const x = 1\`;`,
    ],
    [
      'the card: Vue template markup with a class ending in -from',
      'const tpl = `<span class="dm-from corrupted-from">{{ agentName }}</span>`',
    ],
  ]

  for (const [label, source] of excerpts) {
    assert.deepEqual(specifiersOf(source), [], `${label}: ${JSON.stringify(source.slice(0, 60))}`)
  }
})

test('a regex literal is the one hole the string skip cannot reach', () => {
  /*
   * And the one place the clause rule earns its keep. Telling `/` as division
   * from `/` as a regex opener needs the preceding token's grammar, which this
   * walker deliberately does not have — so the skip cannot see inside a regex,
   * and `from"` in one would otherwise open a span that runs across live code.
   *
   * Measured: without the clause rule this source yields the span
   * `/;const after = `. That is the damaging kind — a rewrite over real code —
   * rather than the harmless kind, which is a missed rewrite.
   */
  const source = 'const re = /from"/;const after = "tail";'
  assert.deepEqual(specifiersOf(source), [])
})

test('every real import and export form still resolves', () => {
  /*
   * The guard on the guards. Two rules were added to reject prose, and the way
   * that goes wrong is rejecting the real thing — silently, since a missed
   * rewrite just means the import goes direct and is refused by CSP somewhere
   * else. So each form a bundler actually emits is pinned, including the two
   * minified spellings where nothing separates the clause from the keyword.
   */
  const forms: readonly (readonly [string, string])[] = [
    ['named', 'import{a}from"./real.js";'],
    ['named, spaced', 'import { a } from "./real.js";'],
    ['default', 'import a from "./real.js";'],
    ['namespace', 'import * as ns from "./real.js";'],
    ['side effect', 'import "./real.js";'],
    ['export from', 'export{a}from"./real.js";'],
    ['export star from', 'export*from"./real.js";'],
    ['dynamic', 'await import("./real.js")'],
  ]
  for (const [label, source] of forms) {
    assert.deepEqual(specifiersOf(source), ['./real.js'], label)
  }
})
test('a regex literal does not swallow the specifier after it', () => {
  /*
   * **A regression the string skip introduced, caught by an existing test in
   * the other package.** Before strings were skipped, a token-anchored walk
   * stepped over `/["]/g` without noticing — it was hunting for `import` and
   * `from`, and a quote inside a regex was just a character. Skipping strings
   * made the walk *stop* at that quote, take it for a string opener, and run to
   * the next `"` in the file: the opening quote of the following specifier.
   *
   * So the fix for one class of false positive created a false **negative** in
   * a case that had been right, which is why the regex heuristic is not
   * optional: skipping strings without recognising regexes is worse than doing
   * neither.
   */
  const source = 'import a from "https://cdn.example/a";'
    + 'const re=/["]/g;'
    + 'const b=await import("https://cdn.example/b");'
  assert.deepEqual(specifiersOf(source), ['https://cdn.example/a', 'https://cdn.example/b'])
})

test('a slash that divides is not read as a regex', () => {
  /*
   * The other direction of the same heuristic. `a / b` after a value is
   * division; treating it as a regex would skip to the next `/` and hide
   * whatever is between — including an import.
   */
  const source = 'const ratio = total / count;import "./after.js";'
  assert.deepEqual(specifiersOf(source), ['./after.js'])

  // And a keyword before the slash *is* a regex position.
  const kw = 'function f(){return /import "x"/.test(s)}import "./real.js";'
  assert.deepEqual(specifiersOf(kw), ['./real.js'])
})

test('a slash inside a character class does not end the regex', () => {
  /*
   * `/[/"]/` is a valid literal — inside a character class a `/` needs no
   * escape — and the class **must** contain a quote for this test to
   * discriminate. Ending the regex at the inner slash leaves `"]/…` behind, the
   * `"` is then taken for a string opener, and the string runs to the next
   * quote in the file, swallowing the `import` keyword along with it.
   *
   * The first version of this used `/[/]/` with no quote in the class: ending
   * early left only `]/;`, the walk resumed and found the import anyway, and
   * removing the class tracking left the test green. Same lesson as the newline
   * guard — the fixture has to contain the thing the code is protecting.
   */
  const source = 'const sep=/[/"]/;import "./after.js";'
  assert.deepEqual(specifiersOf(source), ['./after.js'])
})
