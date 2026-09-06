import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sameOriginTarget } from '../src/sandbox/same-origin.ts'

/**
 * The two bases the bridge is actually used with, kept distinct because the
 * decision must not depend on them agreeing: the frame resolves against the
 * srcdoc's inherited base (the shell page's URL), the runner against the shell
 * page's own URL.
 */
const SHELL_PAGE = 'http://127.0.0.1:8791/chats/current'
const SHELL_ORIGIN = 'http://127.0.0.1:8791'

test('a root-relative path resolves to the shell origin', () => {
  // The measured case: MagVarUpdate's bundle opens with fetch('/version').
  assert.equal(
    sameOriginTarget('/version', SHELL_PAGE, SHELL_ORIGIN),
    'http://127.0.0.1:8791/version',
  )
})

test('a page-relative path resolves against the base, not the origin root', () => {
  assert.equal(
    sameOriginTarget('status.json', SHELL_PAGE, SHELL_ORIGIN),
    'http://127.0.0.1:8791/chats/status.json',
  )
})

test('an absolute same-origin URL is named', () => {
  assert.equal(
    sameOriginTarget('http://127.0.0.1:8791/api/thing', SHELL_PAGE, SHELL_ORIGIN),
    'http://127.0.0.1:8791/api/thing',
  )
})

test('another host is not ours, even on a neighbouring port', () => {
  // The port is part of the origin: the main checkout on 8790 must not answer
  // for this one on 8791.
  assert.equal(sameOriginTarget('http://127.0.0.1:8790/version', SHELL_PAGE, SHELL_ORIGIN), undefined)
  assert.equal(sameOriginTarget('https://cdn.jsdelivr.net/npm/vue', SHELL_PAGE, SHELL_ORIGIN), undefined)
})

test('a protocol-relative URL is a foreign origin', () => {
  // It resolves against the base's scheme but keeps the foreign host.
  assert.equal(sameOriginTarget('//cdn.jsdelivr.net/npm/vue', SHELL_PAGE, SHELL_ORIGIN), undefined)
})

test('a different scheme on our own host is a different origin', () => {
  assert.equal(sameOriginTarget('https://127.0.0.1:8791/version', SHELL_PAGE, SHELL_ORIGIN), undefined)
})

test('a data URL is not ours', () => {
  assert.equal(sameOriginTarget('data:text/plain,x', SHELL_PAGE, SHELL_ORIGIN), undefined)
})

test('an unparseable specifier is undefined, not a throw', () => {
  // The caller keeps its existing behaviour for this — native, where the old
  // failure happens — so the bridge must not turn a typo into a new error.
  assert.equal(sameOriginTarget('http://', SHELL_PAGE, SHELL_ORIGIN), undefined)
})
