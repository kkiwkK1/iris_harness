import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildExtensionSrcdoc } from '../src/st-extensions/srcdoc.ts'

const BASE = {
  token: 'tok-1',
  origin: 'http://127.0.0.1:8787',
  artifactBase: '/iris-st-ext/st-prompt-template/a1b2c3d4e5f6',
  dirName: 'ST-Prompt-Template',
}

test('the srcdoc carries the identity metas, the vendor globals and the upstream module tag', () => {
  const html = buildExtensionSrcdoc(BASE)
  assert.match(html, /<meta name="iris-st-ext-token" content="tok-1">/)
  assert.match(html, /<meta name="iris-st-ext-base" content="\/iris-st-ext\/st-prompt-template\/a1b2c3d4e5f6">/)
  assert.match(html, /<meta name="iris-st-ext-dir" content="ST-Prompt-Template">/)
  // Vendor globals before the module tag: the upstream self-start needs them.
  const jqueryAt = html.indexOf('/st-ext/vendor/jquery.min.js')
  const lodashAt = html.indexOf('/st-ext/vendor/lodash.min.js')
  const moduleAt = html.indexOf('<script type="module"')
  assert.ok(jqueryAt > -1 && lodashAt > jqueryAt && moduleAt > lodashAt, 'vendor scripts precede the module tag')
  // The upstream bundle, unmodified, at the mirrored URL its relative imports resolve against.
  assert.match(
    html,
    /<script type="module" src="http:\/\/127\.0\.0\.1:8787\/iris-st-ext\/st-prompt-template\/a1b2c3d4e5f6\/scripts\/extensions\/third-party\/ST-Prompt-Template\/dist\/index\.js" crossorigin="anonymous"><\/script>/,
  )
})

test('the srcdoc carries the card-frame CSP (EJS compiles with eval; workers may come from blobs)', () => {
  const html = buildExtensionSrcdoc(BASE)
  assert.match(html, /Content-Security-Policy"/)
  assert.match(html, /unsafe-eval/)
  assert.match(html, /worker-src [^"]*blob:/)
})

test('required inputs are validated', () => {
  assert.throws(() => buildExtensionSrcdoc({ ...BASE, token: '' }), /token/)
  assert.throws(() => buildExtensionSrcdoc({ ...BASE, artifactBase: '/plugins/x' }), /iris-st-ext/)
  assert.throws(() => buildExtensionSrcdoc({ ...BASE, dirName: '<script>' }), /markup or path/)
})
