import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkBootstrap } from '../src/sandbox/bootstrap-source.ts'

test('the real shape of a built bundle passes', () => {
  assert.equal(checkBootstrap('(function(){"use strict";var a=1})();'), undefined)
  assert.equal(checkBootstrap('!function(){var a=1}();'), undefined)
})

test('the transformation that actually happened is caught by name', () => {
  // `dist-sandbox/bootstrap.js` sat inside the Vite project root, so fetching it
  // returned the file with an ESM import prepended. In a classic script that is a
  // PARSE error — the block never runs, so the frame's own runtime reporter never
  // exists to report it, and the frame says nothing at all.
  const transformed =
    'import { injectQuery as __vite__injectQuery } from "/@vite/client";(function(){"use strict"})();'
  const why = checkBootstrap(transformed)

  assert.ok(why !== undefined)
  assert.match(why, /transformed by the dev server/)
  assert.match(why, /@vite\/client/, 'the message should name what it found')
})

test('module syntax is refused even without a known marker', () => {
  // The marker list is a convenience, not the rule. Anything that would make a
  // classic script fail to parse has to be caught.
  const why = checkBootstrap('export const a = 1\n(function(){})()')
  assert.ok(why !== undefined)
  assert.match(why, /module syntax/)
})

test('an import expression inside the bundle is not module syntax', () => {
  // The module path uses `import(blobUrl)`, which is legal in a classic script.
  // A check that refused it would refuse the correct bundle.
  assert.equal(checkBootstrap('(function(){return import("blob:x")})();'), undefined)
})

test('the word import inside a string does not trip the check', () => {
  assert.equal(checkBootstrap('(function(){var s="import this"})();'), undefined)
})

test('an empty body is reported rather than injected', () => {
  // A 404 handled as text yields an empty or HTML body; injecting either produces
  // a frame that fails for a reason with no connection to the cause.
  assert.match(checkBootstrap('') ?? '', /empty/)
  assert.ok(checkBootstrap('<!doctype html><html>404</html>') !== undefined)
})

test('an HTML fallback is diagnosed as a wrong path, not as a transform', () => {
  // A dev server answers an unknown path with its index page at status 200, so
  // `response.ok` never catches it. The index also mentions `/@vite/client`, so
  // without this ordering the reader is told their bundle was transformed and
  // goes looking for a build problem that does not exist.
  const index = '<!doctype html>\n<html lang="zh">\n<head><script type="module" src="/@vite/client"></script>'
  const why = checkBootstrap(index)

  assert.ok(why !== undefined)
  assert.match(why, /returned an HTML page/)
  assert.doesNotMatch(why, /transformed/, 'the more specific diagnosis must win')
})
