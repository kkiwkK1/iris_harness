import assert from 'node:assert/strict'
import { test } from 'node:test'

import { frameSandbox, isAllowedRemote, REMOTE_ALLOWLIST, UNBRIDGED_GLOBALS } from '../src/sandbox/policy.ts'
import { parseFromFrame, parseToFrame } from '../src/sandbox/protocol.ts'

test('an ungranted card gets an opaque origin', () => {
  // The whole boundary. Without `allow-same-origin` the browser refuses the
  // card's reach into the host page before any Iris code is consulted, so
  // shadowing `parent` is only a compatibility layer and evading it fails closed.
  assert.equal(frameSandbox(false), 'allow-scripts')
})

test('a grant is spelled out as the one dangerous combination it is', () => {
  // `allow-scripts allow-same-origin` together is not a sandbox. That is what a
  // grant means, and it lives in one function so it appears once in the product.
  assert.equal(frameSandbox(true), 'allow-scripts allow-same-origin')
})

test('the remote allowlist admits the measured hosts and nothing adjacent', () => {
  assert.equal(isAllowedRemote('https://testingcf.jsdelivr.net/npm/vue@3/dist/vue.js'), true)
  assert.equal(isAllowedRemote('https://cdn.jsdelivr.net/npm/lodash/lodash.min.js'), true)
  assert.equal(isAllowedRemote('https://raw.githubusercontent.com/user/repo/main/x.js'), true)

  assert.equal(isAllowedRemote('https://unpkg.com/vue'), false)
  assert.equal(isAllowedRemote('https://evil.example/jsdelivr.net/x.js'), false)
  // A lookalike registered as a suffix of the pattern without the dot boundary.
  assert.equal(isAllowedRemote('https://notjsdelivr.net/x.js'), false)
  assert.equal(isAllowedRemote('not a url at all'), false)
})

test('the allowlist is a suffix match on subdomains, not on the apex', () => {
  // Every measured import is a subdomain; admitting the apex too would widen the
  // list for a case that does not exist in the corpus.
  assert.equal(isAllowedRemote('https://jsdelivr.net/x.js'), false)
  assert.ok(REMOTE_ALLOWLIST.includes('*.jsdelivr.net'))
})

test('the unbridged globals are named so a refusal can say "not yet" rather than "no"', () => {
  const names = UNBRIDGED_GLOBALS.map(row => row.name)
  // `SillyTavern` and `extension_settings` have left this list because they are
  // bridged now. An entry that outlives its bridge would refuse something that
  // works, and claim to be temporary while doing it.
  assert.deepEqual(names, ['eventSource', 'event_types', 'TavernHelper'])
  // Ordered by measured site count, so the list doubles as the order to bridge in.
  const sites = UNBRIDGED_GLOBALS.map(row => row.sites)
  assert.deepEqual([...sites].sort((left, right) => right - left), sites)
})

test('a message without the run token is not ours', () => {
  // A `srcdoc` frame posts with origin "null", and so does every other opaque
  // frame on the page, so origin alone cannot tell the shell from a card.
  assert.equal(parseToFrame('tok', { iris: 'other', type: 'run', code: 'x' }), undefined)
  assert.equal(parseFromFrame('tok', { iris: 'other', type: 'ready' }), undefined)
  assert.equal(parseToFrame('tok', null), undefined)
  assert.equal(parseToFrame('tok', 'run'), undefined)
})

test('a well-formed message survives the round trip', () => {
  assert.deepEqual(
    parseToFrame('tok', { iris: 'tok', type: 'run', code: 'let a = 1', mode: 'classic' }),
    { iris: 'tok', type: 'run', code: 'let a = 1', mode: 'classic' },
  )
  assert.deepEqual(parseFromFrame('tok', { iris: 'tok', type: 'ready' }), { iris: 'tok', type: 'ready' })
})

test('a run without an execution mode is refused', () => {
  // `mode` is required rather than defaulted. Defaulting would mean a frame
  // silently picking classic or module semantics for a card whose author had no
  // say in it, and the failure — `Cannot use import statement outside a module` —
  // points at the card rather than at the choice.
  assert.equal(parseToFrame('tok', { iris: 'tok', type: 'run', code: 'x' }), undefined)
  assert.equal(parseToFrame('tok', { iris: 'tok', type: 'run', code: 'x', mode: 'esm' }), undefined)
  assert.deepEqual(parseToFrame('tok', { iris: 'tok', type: 'run', code: 'x', mode: 'module' }), {
    iris: 'tok',
    type: 'run',
    code: 'x',
    mode: 'module',
  })
})

test('a malformed field is rejected rather than coerced', () => {
  assert.equal(parseToFrame('tok', { iris: 'tok', type: 'run' }), undefined)
  assert.equal(parseToFrame('tok', { iris: 'tok', type: 'viewport', width: '800', height: 600 }), undefined)
  assert.equal(parseFromFrame('tok', { iris: 'tok', type: 'error', message: { text: 'x' } }), undefined)
  assert.equal(parseFromFrame('tok', { iris: 'tok', type: 'unknown-thing' }), undefined)
})

/** Parse a height frame, narrowed so a test can read the number. */
function height(pixels: unknown): number | undefined {
  const parsed = parseFromFrame('tok', { iris: 'tok', type: 'height', pixels })
  return parsed?.type === 'height' ? parsed.pixels : undefined
}

test('a reported height is bounded, because a card controls the number', () => {
  // Not hostility — a bug is enough. An unbounded height makes a frame the page
  // cannot scroll past, which is a card denying the interface.
  assert.equal(height(400), 400)
  assert.equal(height(1e9), 20_000)
  assert.equal(height(-5), undefined)
  assert.equal(height(Number.NaN), undefined)
})

test('card-controlled strings are truncated before they reach the UI', () => {
  const long = 'x'.repeat(9000)
  const parsed = parseFromFrame('tok', { iris: 'tok', type: 'error', message: long, member: long })

  assert.ok(parsed?.type === 'error')
  assert.equal(parsed.message.length, 2000)
  assert.equal(parsed.member?.length, 200)
})

test('a refused host is reported with its host and directive', () => {
  // The frame is the only place that can see the violation and the shell is the
  // only place that can tell the user. A refusal nobody is told about is
  // delivered as whatever the card says next — and one card's author has already
  // pre-written "is Tavern Helper installed? open your console!" for this case.
  const parsed = parseFromFrame('tok', {
    iris: 'tok',
    type: 'blocked',
    host: 'files.yuzuki-rii.xyz',
    directive: 'img-src',
  })

  assert.ok(parsed?.type === 'blocked')
  assert.equal(parsed.host, 'files.yuzuki-rii.xyz')
  assert.equal(parsed.directive, 'img-src')
})

test('a card-influenced refusal report is bounded before it reaches the UI', () => {
  const parsed = parseFromFrame('tok', {
    iris: 'tok',
    type: 'blocked',
    host: 'h'.repeat(4000),
    directive: 'd'.repeat(4000),
  })

  assert.ok(parsed?.type === 'blocked')
  assert.equal(parsed.host.length, 253)
  assert.equal(parsed.directive.length, 40)
})

test('a malformed refusal report is dropped rather than half-rendered', () => {
  assert.equal(parseFromFrame('tok', { iris: 'tok', type: 'blocked', host: 'x' }), undefined)
  assert.equal(parseFromFrame('tok', { iris: 'tok', type: 'blocked', directive: 'img-src' }), undefined)
})

test('a bootstrap failure is accepted without a matching token', () => {
  // The one frame that must bypass the token check, because what it reports may
  // be "the token never arrived". A cross-origin frame's uncaught errors do not
  // reach the parent console, so without this a crashed bootstrap is
  // indistinguishable from one that was never asked to run.
  const parsed = parseFromFrame('tok', {
    iris: '',
    type: 'bootstrap-error',
    message: 'Error: iris sandbox: the frame was built without a run token',
  })

  assert.ok(parsed?.type === 'bootstrap-error')
  assert.match(parsed.message, /without a run token/)
})

test('a bootstrap failure is still bounded, and still needs its field', () => {
  // Weaker authentication, not none: it is believed as a diagnostic only, so it
  // gets the same field checking and truncation as everything else.
  assert.equal(parseFromFrame('tok', { iris: '', type: 'bootstrap-error' }), undefined)
  const long = parseFromFrame('tok', { iris: '', type: 'bootstrap-error', message: 'x'.repeat(9000) })
  assert.ok(long?.type === 'bootstrap-error')
  assert.equal(long.message.length, 2000)
})

test('every other frame still requires the token', () => {
  // The bypass is one message wide. A `run` or a `ready` without the token stays
  // refused, because those can move state and the diagnostic cannot.
  assert.equal(parseFromFrame('tok', { iris: '', type: 'ready' }), undefined)
  assert.equal(parseFromFrame('tok', { iris: '', type: 'ran' }), undefined)
  assert.equal(parseFromFrame('tok', { iris: '', type: 'height', pixels: 10 }), undefined)
})
