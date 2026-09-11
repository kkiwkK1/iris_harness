import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AVATAR_PREFIX,
  BRIDGE_EXACT_PATHS,
  BRIDGE_PATH_PREFIXES,
  bridgeVerdict,
  describeBridgeRefusal,
} from '../src/sandbox/bridge-paths.ts'

/**
 * The allow-list on the same-origin fetch bridge (network audit F11).
 *
 * The decision under test is narrow and the harness is deliberately nothing:
 * the function takes a resolved URL and the card's own id and returns a
 * verdict, so the cases that matter are URLs. The two *callers* — the frame's
 * `rideFor` and the shell's `ride` — are exercised separately, in
 * `sandbox-frame.test.ts` and `runner-fetch.test.ts`, because "the frame
 * already filtered" is not a check and a test that only covered one side would
 * be asserting exactly that.
 */

const ORIGIN = 'http://127.0.0.1:8791'
const CARD = '络络.png'

test('the three allowed shapes ride, query strings and all', () => {
  for (const path of BRIDGE_EXACT_PATHS) {
    assert.equal(bridgeVerdict(`${ORIGIN}${path}`, CARD).allowed, true, path)
  }
  assert.equal(bridgeVerdict(`${ORIGIN}/sandbox/manifest.json`, CARD).allowed, true)
  assert.equal(bridgeVerdict(`${ORIGIN}/sandbox/bootstrap-9f2c.js`, CARD).allowed, true)
  // The proxy carries its real URL in a query string, so the pathname is the
  // whole prefix. A list that matched on the href would refuse every dependency.
  assert.equal(
    bridgeVerdict(`${ORIGIN}/iris/script-bundle?url=https://cdn.jsdelivr.net/npm/vue`, CARD).allowed,
    true,
  )
  // `/version` is the one path the corpus actually exercises: MagVarUpdate's
  // bundle opens with it and 13 of 19 cards import that bundle.
  assert.equal(bridgeVerdict(`${ORIGIN}/version?x=1`, CARD).allowed, true)
})

test('a card may fetch its own avatar and no other', () => {
  assert.equal(bridgeVerdict(`${ORIGIN}${AVATAR_PREFIX}${encodeURIComponent(CARD)}`, CARD).allowed, true)
  // The finding itself: another card's file, PNG payload and embedded card data
  // together, read with the shell's credentials.
  assert.equal(bridgeVerdict(`${ORIGIN}${AVATAR_PREFIX}${encodeURIComponent('爱衣.png')}`, CARD).allowed, false)
  // Unencoded, which is what a card that concatenated the id would send.
  assert.equal(bridgeVerdict(`${ORIGIN}${AVATAR_PREFIX}other.png`, CARD).allowed, false)
  // Case is not folded: the library folds case to decide whether an id is
  // *taken*, but folding here would admit a genuinely different card's file on
  // a case-sensitive host, and a card never types this id by hand.
  assert.equal(bridgeVerdict(`${ORIGIN}${AVATAR_PREFIX}${encodeURIComponent(CARD.toUpperCase())}`, CARD).allowed, false)
})

test('a frame that cannot say whose it is gets no avatar at all', () => {
  // Before the context message arrives there is no own id. Failing open would
  // make the leak a race; failing closed costs a picture.
  assert.equal(bridgeVerdict(`${ORIGIN}${AVATAR_PREFIX}${encodeURIComponent(CARD)}`, undefined).allowed, false)
  // And an empty id must not match an absent one.
  assert.equal(bridgeVerdict(`${ORIGIN}${AVATAR_PREFIX}`, undefined).allowed, false)
  assert.equal(bridgeVerdict(`${ORIGIN}${AVATAR_PREFIX}`, '').allowed, false)
})

test('everything else is refused, the RPC endpoint included', () => {
  for (const path of [
    '/iris/rpc',
    '/iris/rpc/',
    '/iris',
    '/',
    '/api/chats/export',
    '/api/backends/chat-completions/status',
    '/csrf-token',
    '/script.js',
    '/scripts/world-info.js',
    '/characters/other.png',
    // A prefix that merely starts the same must not be admitted by the
    // directory prefix `/sandbox/`.
    '/sandboxed-secrets',
    '/iris/avatarish',
  ]) {
    assert.equal(bridgeVerdict(`${ORIGIN}${path}`, CARD).allowed, false, path)
  }
})

test('the shape a refusal is reported under folds the avatar id and drops the query', () => {
  // One card sweeping the library must leave one report, not one per card, and
  // one dependency proxy must not leave one report per dependency.
  assert.equal(
    bridgeVerdict(`${ORIGIN}${AVATAR_PREFIX}${encodeURIComponent('爱衣.png')}`, CARD).shape,
    '/iris/avatar/<id>',
  )
  assert.equal(
    bridgeVerdict(`${ORIGIN}${AVATAR_PREFIX}${encodeURIComponent('another.png')}`, CARD).shape,
    '/iris/avatar/<id>',
  )
  assert.equal(bridgeVerdict(`${ORIGIN}/api/thing?id=7`, CARD).shape, '/api/thing')
  assert.equal(bridgeVerdict('not a url', CARD).allowed, false)
})

test('a malformed escape in an avatar id is refused rather than relayed', () => {
  // The host answers 400 for this. Refusing here keeps a broken escape from
  // reaching the credentialed fetch at all, and still reports one shape.
  const verdict = bridgeVerdict(`${ORIGIN}${AVATAR_PREFIX}%E0%A4%A`, CARD)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.shape, '/iris/avatar/<id>')
})

test('both sides say which of them refused, over the same list', () => {
  const frame = describeBridgeRefusal('/iris/rpc', 'frame')
  const shell = describeBridgeRefusal('/iris/rpc', 'shell')
  assert.notEqual(frame, shell, 'a refusal that named no layer would be unattributable')
  for (const text of [frame, shell]) {
    assert.match(text, /\/iris\/rpc/)
    // The list is quoted in the refusal so a card author can act on it.
    for (const allowed of [...BRIDGE_EXACT_PATHS, ...BRIDGE_PATH_PREFIXES]) {
      assert.ok(text.includes(allowed), `the refusal does not name ${allowed}`)
    }
  }
  assert.match(frame, /this frame/)
  assert.match(shell, /the page/)
})
