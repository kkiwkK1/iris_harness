import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

import {
  DEFERRED_PATCHES,
  UPSTREAM_COMPILE_OPTIONS,
  UpstreamPatchError,
  applySourcePatches,
  hasTemplate,
  identityEscape,
  installNestedDelimiters,
  stubInclude,
} from '../src/index.ts'

/**
 * The fidelity layer.
 *
 * Every patch tested here has **zero sites in the local corpus**, so the corpus
 * cannot confirm any of them. That is the whole reason they are tested: the
 * assertions are pinned to what the extension's vendored engine emits at
 * v1.17.4.1, read out of its bundle, and they exist so that a drift in the
 * pinned `ejs` shows up as a red test rather than as Iris quietly running stock
 * EJS while claiming upstream's dialect.
 *
 * Hermetic, like the rest of this repository's compatibility tests: nothing here
 * reads the user's SillyTavern install, because a test that did would pass or
 * fail depending on whose machine it ran on.
 */

const require = createRequire(import.meta.url)

interface Ejs {
  compile: (text: string, options: object) => unknown
  VERSION: string
}

/**
 * A private, unpatched copy of the pinned engine.
 *
 * `require` caches one instance per resolved path, and the patch mutates
 * `Template.prototype` — so a test that compared "before" against "after" using
 * the shared instance would be asserting whatever the previously-run test left
 * behind. Dropping the cache entry makes each test independent of the others'
 * order, which matters here because half of them exist to show a difference.
 * @returns a fresh `ejs`.
 */
function freshEjs(): Ejs {
  delete require.cache[require.resolve('ejs')]
  return require('ejs') as Ejs
}

test('the pin is the version the extension vendors', () => {
  // The extension bundles ejs 3.1.9 and patches it. If this pin moves, the
  // source patches below stop matching and `applySourcePatches` throws — which
  // is the intended failure, but the version is the thing to notice first.
  assert.equal(freshEjs().VERSION, '3.1.9')
})

test('text without an opening delimiter is never compiled', () => {
  // Upstream's short-circuit, and the reason a card's prose is never a syntax
  // error: 3360 of the corpus's tags sit in world-info entries that are mostly
  // prose, and the prose is never handed to a compiler.
  assert.equal(hasTemplate('plain prose with no tags'), false)
  assert.equal(hasTemplate('已经开始了，但没有标签'), false)
  assert.equal(hasTemplate("<%= getvar('stat_data.未央.现实侵占进度') %>"), true)
  // A closing delimiter alone is not a template, and neither is a lone `%`.
  assert.equal(hasTemplate('100%> done'), false)
  assert.equal(hasTemplate('50% off'), false)
})

test('the short-circuit follows the configured delimiters', () => {
  assert.equal(hasTemplate('[[= x ]]', '[', '['), true)
  assert.equal(hasTemplate('<%= x %>', '[', '['), false)
})

test('escaping is the identity, so <%= and <%- are the same tag', () => {
  // `function escape(markup) { return markup }` in the extension, commented
  // "don't escape any XML tags". The corpus has 289 `<%=` sites, of which 3
  // render differently once escaping is restored — the count of tags is not the
  // count of dependants, and only the differential script can tell them apart.
  assert.equal(identityEscape('<StatusPlaceHolderImpl/>'), '<StatusPlaceHolderImpl/>')
  assert.equal(identityEscape('a & b "c" \'d\''), 'a & b "c" \'d\'')
})

test('include is a stub that contributes nothing', () => {
  // Copied rather than implemented. Building a working `include` would make
  // Iris render a template that renders as empty in the user's SillyTavern.
  assert.deepEqual(stubInclude('partials/header'), { filename: 'partials/header', template: '' })
})

test('the compiled preamble gets upstream\'s variadic appender', () => {
  // Stock appends only the first argument; the extension appends all of them.
  // `print` is never called in the corpus, so this is fidelity, not a fix.
  const source = String(freshEjs().compile('<%= 1 %>', { ...UPSTREAM_COMPILE_OPTIONS }))
  assert.match(source, /function __append\(s\) \{ if \(s !== undefined && s !== null\) __output \+= s \}/)

  const patched = applySourcePatches(source)
  assert.match(patched, /function __append\(\.\.\.args\) \{ args\.filter\(x => x !== undefined && x !== null\)\.forEach\(s => __output \+= s\) \}/)
  assert.doesNotMatch(patched, /function __append\(s\)/)
})

test('the output function is bound with const, as upstream binds it', () => {
  // A template declaring its own `var print` throws upstream and silently
  // shadows under stock EJS.
  const source = String(freshEjs().compile('<%= 1 %>', { ...UPSTREAM_COMPILE_OPTIONS }))
  assert.match(source, /^ {2}var print = __append;$/m)

  const patched = applySourcePatches(source)
  assert.match(patched, /^ {2}const print = __append;$/m)
  assert.doesNotMatch(patched, /var print = __append;/)
})

test('the variadic appender really appends every argument', () => {
  // The patch is a string substitution, so it is worth running the result once
  // rather than only matching it. Stock keeps `a`; upstream keeps `abc`.
  const ejs = freshEjs()
  const template = '<% print("a", "b", "c") %>'
  const stockRender = new Function(`return ${String(ejs.compile(template, { ...UPSTREAM_COMPILE_OPTIONS }))}`)()
  const patchedRender = new Function(`return ${applySourcePatches(String(ejs.compile(template, { ...UPSTREAM_COMPILE_OPTIONS })))}`)()

  return Promise.all([
    stockRender.call({}, {}, identityEscape, stubInclude, undefined),
    patchedRender.call({}, {}, identityEscape, stubInclude, undefined),
  ]).then(([stock, patched]) => {
    assert.equal(stock, 'a')
    assert.equal(patched, 'abc')
  })
})

test('a patch that cannot be applied throws instead of no-opping', () => {
  // The failure mode this guards against is the quiet one: a silently skipped
  // patch leaves the package claiming a dialect it is not running.
  assert.throws(
    () => applySourcePatches('async function anonymous(locals) { return "" }'),
    (error: unknown) => error instanceof UpstreamPatchError && /Re-diff against the extension/.test(error.message),
  )
})

/**
 * What stock EJS already accepts, so it cannot discriminate the scanner patch.
 *
 * The first version of the test below asserted these and passed, which proved
 * nothing: they are sequential tags, not one tag containing a delimiter. Kept as
 * a negative control so the next reader does not repeat the mistake.
 */
const NOT_DISCRIMINATING = {
  'sequential tags': '<% if (true) { %>A<% } %>',
  'the @@private wrapper': '<% (() => { %>x<% })(); %>',
}

/** Where stock EJS and the extension's engine actually diverge. */
const DISCRIMINATING = {
  'a delimiter inside a string literal': '<% var s = "<% x %>"; print(s); %>',
  // Not hypothetical: a corpus card ships a script built on this exact regex to
  // strip EJS out of message text, so authors do write this.
  'a regex that matches EJS tags': '<% var re = /<%.*?%>/g; print(String(re)); %>',
}

test('stock EJS already handles sequential tags, so they prove nothing', () => {
  const ejs = freshEjs()
  for (const [label, source] of Object.entries(NOT_DISCRIMINATING)) {
    assert.equal(
      typeof ejs.compile(source, { ...UPSTREAM_COMPILE_OPTIONS }),
      'function',
      `${label} should compile before the patch`,
    )
  }
})

test('a delimiter inside a tag breaks stock EJS and survives the patch', () => {
  // The real effect of the scanner patch, and the reason it is carried: without
  // it an entry written this way loses its whole content to the unevaluated
  // original — silently, because upstream's failure path keeps the original.
  const stock = freshEjs()
  for (const [label, source] of Object.entries(DISCRIMINATING)) {
    assert.throws(
      () => stock.compile(source, { ...UPSTREAM_COMPILE_OPTIONS }),
      /Could not find matching close tag/,
      `${label} should fail before the patch`,
    )
  }

  const patched = freshEjs()
  installNestedDelimiters(patched)
  for (const [label, source] of Object.entries(DISCRIMINATING)) {
    assert.equal(
      typeof patched.compile(source, { ...UPSTREAM_COMPILE_OPTIONS }),
      'function',
      `${label} should compile after the patch`,
    )
  }
})

test('an unterminated tag still fails after the patch', () => {
  // The nesting-aware matcher keeps upstream's error for a genuinely unbalanced
  // tag, message included.
  const ejs = freshEjs()
  installNestedDelimiters(ejs)
  assert.throws(
    () => ejs.compile('<% if (true) {', { ...UPSTREAM_COMPILE_OPTIONS }),
    /Could not find matching close tag/,
  )
})

test('the patch leaves ordinary templates alone', () => {
  // Parity on the shapes the corpus actually uses: whatever the scanner patch
  // changes, it must not change these.
  const stock = freshEjs()
  const patched = freshEjs()
  installNestedDelimiters(patched)

  for (const source of [
    "<%= getvar('stat_data.未央.现实侵占进度') %>",
    'A<%_ if (n > 0) { _%>B<%_ } _%>C',
    '<%# 根据幸运值输出对应阶段内容 %>X',
    "<%- await getwi(null, 'TakamatsuTomori_Wary') %>",
  ]) {
    assert.equal(
      String(patched.compile(source, { ...UPSTREAM_COMPILE_OPTIONS })),
      String(stock.compile(source, { ...UPSTREAM_COMPILE_OPTIONS })),
      `the patch changed the compilation of ${JSON.stringify(source)}`,
    )
  }
})

test('installing the patch twice is a no-op', () => {
  // The child installs at import time and a test may install again; a patch
  // that wrapped itself would double-scan.
  const ejs = freshEjs()
  installNestedDelimiters(ejs)
  installNestedDelimiters(ejs)
  assert.equal(typeof ejs.compile('<% var s = "<% x %>"; print(s); %>', { ...UPSTREAM_COMPILE_OPTIONS }), 'function')
})

test('installing onto something without a Template throws', () => {
  assert.throws(() => installNestedDelimiters({}), UpstreamPatchError)
})

test('the deferred patches are recorded rather than dropped', () => {
  // Both are only reachable through `with_context_disabled`, which this package
  // does not implement. Whoever implements it must bring them along, which is
  // why they are named in code and not only in a document.
  assert.deepEqual([...DEFERRED_PATCHES], ['_JS_IDENTIFIER', 'destructuredLocals scoping'])
})
