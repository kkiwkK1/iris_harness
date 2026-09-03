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
