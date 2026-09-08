import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fromProxied } from '@iris/protocol'

import { rewriteNestedSpecifiers, rewriteStylesheetUrls } from '../src/bundle-rewrite.ts'

/**
 * A proxied bundle's own imports have to travel with it.
 *
 * The regression this pins: jsDelivr writes a bundle's dependencies as
 * **root-relative** specifiers, which resolve against whatever origin serves
 * the module. Served from us, `"/npm/vue@3.5.41/+esm"` became a request to
 * `127.0.0.1:8787/npm/...`, three 404s, and a top-level module Chrome reported
 * as simply having failed to load.
 */

const UPSTREAM = 'https://cdn.jsdelivr.net/npm/pinia@2.1.7/+esm'

/** One bundle carrying every specifier form that matters, and one decoy. */
const BUNDLE = [
  'import{ref as e}from"/npm/vue@3.5.41/+esm";',
  'import n from"./chunk-abc.js";',
  'import p from"//cdn.jsdelivr.net/npm/left-pad@1.3.0/+esm";',
  'import q from"https://cdn.jsdelivr.net/npm/nanoid@5.0.7/+esm";',
  'import r from"https://evil.example.com/npm/thing/+esm";',
  'import s from"vue";',
  'const mentioned="https://cdn.jsdelivr.net/npm/never-imported@1.0.0/+esm";',
].join('\n')

test('every resolvable form is proxied, and nothing else is touched', () => {
  const done = rewriteNestedSpecifiers(BUNDLE, UPSTREAM)

  // Root-relative, dot-relative, protocol-relative and absolute-allowed: the
  // four forms that resolve against the upstream URL. Bare and merely-mentioned
  // are the two that must not.
  assert.equal(done.rewritten, 4, `rewrote ${String(done.rewritten)}, expected 4`)

  const proxied = [...done.source.matchAll(/"([^"]*)"/gu)]
    .map(match => match[1] ?? '')
    .map(value => fromProxied(value))
    .filter((value): value is string => value !== undefined)
  assert.deepEqual(proxied, [
    'https://cdn.jsdelivr.net/npm/vue@3.5.41/+esm',
    'https://cdn.jsdelivr.net/npm/pinia@2.1.7/chunk-abc.js',
    'https://cdn.jsdelivr.net/npm/left-pad@1.3.0/+esm',
    'https://cdn.jsdelivr.net/npm/nanoid@5.0.7/+esm',
  ])

  // **Resolved against upstream, not against us.** The dot-relative one is the
  // discriminating case: resolved against our own origin it would have become
  // `/npm/chunk-abc.js` on the host, which is the very 404 this fixes.
  assert.ok(
    done.source.includes(encodeURIComponent('https://cdn.jsdelivr.net/npm/pinia@2.1.7/chunk-abc.js')),
    'the relative specifier was resolved against the wrong base',
  )
})

test('a specifier the allowlist does not cover is refused, not wrapped', () => {
  const done = rewriteNestedSpecifiers(BUNDLE, UPSTREAM)

  // Wrapping it would launder a URL through this route that the same route
  // refuses when a card asks for it directly.
  assert.deepEqual(done.refused, ['https://evil.example.com/npm/thing/+esm'])
  assert.ok(
    done.source.includes('"https://evil.example.com/npm/thing/+esm"'),
    'the refused specifier was altered instead of left to fail',
  )
  assert.equal(
    done.source.includes(encodeURIComponent('https://evil.example.com')),
    false,
    'the refused URL was wrapped in our route',
  )
})

test('a bare specifier is left alone and named', () => {
  const done = rewriteNestedSpecifiers(BUNDLE, UPSTREAM)

  // `new URL('vue', upstream)` does not throw — it yields
  // `https://cdn.jsdelivr.net/npm/vue`, an address nobody asked for. Resolving
  // first and catching failures would have proxied that fabrication.
  assert.deepEqual(done.bare, ['vue'])
  assert.ok(done.source.includes('import s from"vue";'), 'a bare specifier was rewritten')
})

test('a URL the bundle only mentions is not an import', () => {
  const done = rewriteNestedSpecifiers(BUNDLE, UPSTREAM)

  // The specifier scan is anchored to `import`/`from`, so a string that merely
  // contains an allowlisted URL is data, not a dependency. Rewriting it would
  // change what the module computes.
  assert.ok(
    done.source.includes('const mentioned="https://cdn.jsdelivr.net/npm/never-imported@1.0.0/+esm"'),
    'a mentioned URL was rewritten as though it were an import',
  )
})

test('a bundle with nothing to rewrite comes back identical', () => {
  const plain = 'export const answer=42;\n'
  const done = rewriteNestedSpecifiers(plain, UPSTREAM)

  assert.equal(done.source, plain)
  assert.equal(done.rewritten, 0)
  assert.deepEqual(done.refused, [])
  assert.deepEqual(done.bare, [])
})

test('a concatenated specifier is a fragment, and is left whole', () => {
  // The span walker correctly reports `./locale/` here — that is where a
  // specifier begins. But it is one operand of a concatenation, so rewriting it
  // would put a proxy URL in front of the rest of the expression and build an
  // address nobody meant. **This corrupts rather than misses**, which is the one
  // failure direction this whole module has to avoid.
  const source = 'const m = await import("./locale/" + lang + ".js");'
  const done = rewriteNestedSpecifiers(source, UPSTREAM)

  assert.equal(done.source, source, 'a concatenated fragment was rewritten')
  assert.equal(done.rewritten, 0)
  assert.deepEqual(done.dynamic, ['./locale/'])
})

/*
 * ─── Stylesheets ──────────────────────────────────────────────────────────
 *
 * The proxied stylesheet's references resolve against the route that served
 * them, so its faces have to move the way a bundle's imports do. The input
 * below is shaped like 人贩子物语's Tabler sheet: two `@font-face` blocks
 * (woff2 first, fallback after), an `@import`, and the decoys a real sheet
 * carries — a `data:` face, a fragment reference, an icon-position image.
 */

const SHEET_URL = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css'

const SHEET = [
  '@font-face{',
  'font-family:"tabler-icons";',
  'src:url("fonts/tabler-icons.woff2?v0.0.1") format("woff2"),',
  'url(fonts/tabler-icons.ttf?v0.0.1) format("truetype");',
  '}',
  '@import "helpers/tabler-helpers.css";',
  '@font-face{',
  'font-family:"tabler-icons-fallback";',
  'src:url(data:font/woff2;base64,d09GMg) format("woff2");',
  '}',
  '.ti-book::before{content:"\eb15";}',
  '.sprite{clip-path:url(#icon-sprite);}',
].join('\n')

test('a proxied stylesheet carries its faces and imports with it', () => {
  const done = rewriteStylesheetUrls(SHEET, SHEET_URL)

  // Root-relative, like the module rewrites: the cached body must not bake in
  // the address it was reached at.
  assert.ok(done.source.includes('url(/iris/script-bundle?url='), 'faces load through the same route')
  assert.equal(done.rewritten, 3, 'two faces and one import')
  for (const target of [
    'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/fonts/tabler-icons.woff2?v0.0.1',
    'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/fonts/tabler-icons.ttf?v0.0.1',
    'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/helpers/tabler-helpers.css',
  ]) {
    assert.ok(
      done.source.includes(encodeURIComponent(target)),
      `the face resolves against the upstream sheet: ${target}`,
    )
  }
})

test('self-contained targets and non-fetch references stay as written', () => {
  const done = rewriteStylesheetUrls(SHEET, SHEET_URL)

  assert.ok(done.source.includes('url(data:font/woff2;base64,d09GMg)'), 'a data: face needs no route')
  assert.ok(done.source.includes('url(#icon-sprite)'), 'a fragment reference is not a fetch')
  assert.ok(done.source.includes('.ti-book::before'), 'the glyph rules themselves are untouched')
})

test('a stylesheet url outside a font-face is left to name its host honestly', () => {
  // An image or background is img-src's business. Rewriting it would launder a
  // fetch through this route and make the eventual refusal name *us*; leaving
  // it keeps the report pointing at the host the card chose.
  const source = '.panel{background:url(../img/panel.png) no-repeat;}'
  const done = rewriteStylesheetUrls(source, SHEET_URL)

  assert.equal(done.source, source)
  assert.equal(done.rewritten, 0)
  assert.deepEqual(done.refused, [])
})

test('a face on a host the allowlist refuses is reported and left as written', () => {
  const source = '@font-face{font-family:"x";src:url(https://fontsapi.zeoseven.com/292/result.woff2);}'
  const done = rewriteStylesheetUrls(source, SHEET_URL)

  assert.equal(done.source, source, 'wrapping it would serve a URL the route itself refuses')
  assert.deepEqual(done.refused, ['https://fontsapi.zeoseven.com/292/result.woff2'])
})
