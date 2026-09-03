import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fromProxied } from '@iris/protocol'

import { rewriteNestedSpecifiers } from '../src/bundle-rewrite.ts'

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

test('a template placeholder is not called a bare specifier', () => {
  // Measured on the real `pinia@2.1.7` bundle. The scanner takes the quote pair
  // in `d(`Global state imported from "${s.name}".`)` — prose inside a template
  // literal, where `imported from "` is indistinguishable from a real import.
  // Reporting it as bare would tell a card author their bundle needs an import
  // map, about an English sentence.
  const source = 'd(`Global state imported from "${s.name}".`);\nimport a from"vue";'
  const done = rewriteNestedSpecifiers(source, UPSTREAM)

  assert.deepEqual(done.dynamic, ['${s.name}'])
  assert.deepEqual(done.bare, ['vue'], 'the placeholder was counted as a bare specifier')
  assert.equal(done.source, source, 'a placeholder span was rewritten')
})
