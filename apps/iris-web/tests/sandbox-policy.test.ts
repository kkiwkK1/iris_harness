import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  frameSandbox,
  grantOffer,
  GRANT_WIDENED_DIRECTIVES,
  isAllowedRemote,
  REMOTE_ALLOWLIST,
  UNBRIDGED_GLOBALS,
} from '../src/sandbox/policy.ts'
import { SANDBOX_PLUGIN_LIMITS } from '@iris/protocol'

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

test('no entry outlives its bridge', () => {
  /*
   * The list is empty, and that is the rule working rather than a gap to fill.
   * `SillyTavern` and `extension_settings` left it first; `eventSource` (8
   * measured sites), `event_types` (6) and `TavernHelper` (1) followed once the
   * card surface was built.
   *
   * An entry that outlives its bridge is the failure this guards: it refuses
   * something that in fact works, and claims to be temporary while doing it —
   * so a card author is told to wait for a feature they already have.
   */
  assert.deepEqual(UNBRIDGED_GLOBALS.map(row => row.name), [])

  // Ordered by measured site count, so the list doubles as the order to bridge
  // in. Vacuous while empty, kept because the next entry has to obey it.
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
    { iris: 'tok', type: 'run', code: 'let a = 1', mode: 'classic', scriptId: undefined },
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
    scriptId: undefined,
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

test('a run carries the script id, and refuses one that is not a string', () => {
  /*
   * Absent is legitimate — a body from disk has no entry in `script.list` — so
   * the id cannot simply be required. What must not pass is a *present* id of
   * the wrong type: `getScriptId()` is what a card keys its own variable scope
   * by, and a number arriving where a string was expected would be stringified
   * somewhere downstream rather than rejected here.
   */
  assert.deepEqual(
    parseToFrame('tok', { iris: 'tok', type: 'run', code: 'x', mode: 'module', scriptId: 's1' }),
    { iris: 'tok', type: 'run', code: 'x', mode: 'module', scriptId: 's1' },
  )
  assert.equal(
    parseToFrame('tok', { iris: 'tok', type: 'run', code: 'x', mode: 'module', scriptId: 7 }),
    undefined,
  )
  assert.equal(
    parseToFrame('tok', { iris: 'tok', type: 'run', code: 'x', mode: 'module', scriptId: null }),
    undefined,
  )
})

test('a forwarded event needs a name and an argument list', () => {
  // `args` is always an array, even when empty: a card's listener is called with
  // spread arguments, and spreading a non-array throws inside the bus rather
  // than at the boundary that could have named the problem.
  assert.deepEqual(
    parseToFrame('tok', { iris: 'tok', type: 'event', event: 'message_received', args: [1] }),
    { iris: 'tok', type: 'event', event: 'message_received', args: [1] },
  )
  assert.equal(parseToFrame('tok', { iris: 'tok', type: 'event', event: '', args: [] }), undefined)
  assert.equal(
    parseToFrame('tok', { iris: 'tok', type: 'event', event: 'x', args: 'not-a-list' }),
    undefined,
  )
  assert.equal(parseToFrame('tok', { iris: 'tok', type: 'event', args: [] }), undefined)
})

test('a window event dispatch carries its name and optional detail', () => {
  // The frame→shell half of the page event target: the dispatch itself cannot
  // reach a sibling frame, so what crosses is the event's own two facts.
  assert.deepEqual(
    parseFromFrame('tok', {
      iris: 'tok',
      type: 'winevent',
      event: 'MvuFloatingBgRequest',
      detail: { action: 'show', src: 'a.png' },
    }),
    {
      iris: 'tok',
      type: 'winevent',
      event: 'MvuFloatingBgRequest',
      detail: { action: 'show', src: 'a.png' },
    },
  )
  // A detail-less dispatch is a real shape — `new CustomEvent('x')` — and stays
  // a real one rather than being answered with `detail: undefined`.
  assert.deepEqual(
    parseFromFrame('tok', { iris: 'tok', type: 'winevent', event: 'x' }),
    { iris: 'tok', type: 'winevent', event: 'x' },
  )
  assert.equal(parseFromFrame('tok', { iris: 'tok', type: 'winevent', event: '' }), undefined)
  assert.equal(parseFromFrame('tok', { iris: 'tok', type: 'winevent' }), undefined)
})

/*
 * The six sandbox-plugin arms.
 *
 * The allow-list **is** the two `default: return undefined` branches, so "this
 * message exists" means an arm in the union *and* a case in the switch. A
 * message added to the union alone type-checks and is refused at run time, which
 * is silent in exactly the direction that costs a debugging round: the shell
 * posts it, the frame ignores it, and nothing anywhere says so.
 */
test('the shell may ask a frame to mount, unmount and show plugins', () => {
  assert.deepEqual(
    parseToFrame('tok', {
      iris: 'tok',
      type: 'plugin:mount',
      pluginId: '1-dark',
      version: 2,
      code: 'return {}',
    }),
    { iris: 'tok', type: 'plugin:mount', pluginId: '1-dark', version: 2, code: 'return {}' },
  )
  assert.deepEqual(
    parseToFrame('tok', { iris: 'tok', type: 'plugin:unmount', pluginId: '1-dark' }),
    { iris: 'tok', type: 'plugin:unmount', pluginId: '1-dark' },
  )
  assert.deepEqual(
    parseToFrame('tok', { iris: 'tok', type: 'plugin:panel', visible: false }),
    { iris: 'tok', type: 'plugin:panel', visible: false },
  )
})

test('a mount over the code ceiling is refused rather than truncated', () => {
  /*
   * Cutting the source at 64 KiB produces a source with a syntax error, and the
   * frame would then report `mount-failed` with a parse message — sending a
   * reader to look at the model's code for a fault the transport introduced.
   */
  const ok = 'x'.repeat(SANDBOX_PLUGIN_LIMITS.codeBytes)
  const over = 'x'.repeat(SANDBOX_PLUGIN_LIMITS.codeBytes + 1)
  assert.notEqual(
    parseToFrame('tok', { iris: 'tok', type: 'plugin:mount', pluginId: 'p', version: 1, code: ok }),
    undefined,
    'the ceiling itself is accepted, so the refusal below is about the extra byte',
  )
  assert.equal(
    parseToFrame('tok', { iris: 'tok', type: 'plugin:mount', pluginId: 'p', version: 1, code: over }),
    undefined,
  )
  // And the shapes that are simply wrong.
  assert.equal(
    parseToFrame('tok', { iris: 'tok', type: 'plugin:mount', pluginId: '', version: 1, code: '' }),
    undefined,
  )
  assert.equal(
    parseToFrame('tok', { iris: 'tok', type: 'plugin:mount', pluginId: 'p', version: 0, code: '' }),
    undefined,
    'versions start at 1; a zero would make "which version did the reader authorise" unanswerable',
  )
  assert.equal(
    parseToFrame('tok', { iris: 'tok', type: 'plugin:panel', visible: 'yes' }),
    undefined,
    'a truthy string is not a boolean: a panel could not be argued out of being shown',
  )
})

test('a frame may report a mount, a named failure and a stylesheet', () => {
  assert.deepEqual(
    parseFromFrame('tok', { iris: 'tok', type: 'plugin:mounted', pluginId: 'p', version: 1, ms: 12.4 }),
    { iris: 'tok', type: 'plugin:mounted', pluginId: 'p', version: 1, ms: 12 },
  )
  assert.deepEqual(
    parseFromFrame('tok', {
      iris: 'tok',
      type: 'plugin:failed',
      pluginId: 'p',
      version: 1,
      state: 'mount-timeout',
      detail: 'apply did not settle',
    }),
    {
      iris: 'tok',
      type: 'plugin:failed',
      pluginId: 'p',
      version: 1,
      state: 'mount-timeout',
      detail: 'apply did not settle',
    },
  )
  assert.deepEqual(
    parseFromFrame('tok', { iris: 'tok', type: 'plugin:style', pluginId: 'p', css: 'body{}' }),
    { iris: 'tok', type: 'plugin:style', pluginId: 'p', css: 'body{}' },
  )
})

test('a frame may say a plugin’s published stylesheets are gone', () => {
  /*
   * The removal counterpart, and it needs an arm of its own because the shell
   * cannot work it out: `iris.styles.clear()` leaves the plugin mounted, so
   * there is no `plugin:unmount` to infer it from, and without this message the
   * message frames would go on painting a sheet the realm that wrote it has
   * dropped.
   */
  assert.deepEqual(
    parseFromFrame('tok', { iris: 'tok', type: 'plugin:style-clear', pluginId: '1-dark' }),
    { iris: 'tok', type: 'plugin:style-clear', pluginId: '1-dark' },
  )
  assert.equal(
    parseFromFrame('tok', { iris: 'tok', type: 'plugin:style-clear', pluginId: '' }),
    undefined,
    'an empty id names no owner, and "forget the sheets of nobody" has no reading',
  )
  assert.equal(
    parseFromFrame('tok', { iris: 'tok', type: 'plugin:style-clear' }),
    undefined,
  )
})

test('a failure state the shell has no grade for is refused at the parser', () => {
  // Validated rather than passed through, the same rule `sizing`'s one mode
  // follows: the frame is untrusted, and a spelling that reached the shell would
  // file as a row nobody declared they were watching.
  assert.equal(
    parseFromFrame('tok', {
      iris: 'tok',
      type: 'plugin:failed',
      pluginId: 'p',
      version: 1,
      state: 'exploded',
      detail: '',
    }),
    undefined,
  )
  assert.equal(
    parseFromFrame('tok', {
      iris: 'tok',
      type: 'plugin:style',
      pluginId: 'p',
      css: 'x'.repeat(SANDBOX_PLUGIN_LIMITS.cssChars + 1),
    }),
    undefined,
  )
})

test('an unknown plugin arm is still refused in both directions', () => {
  /*
   * The negative control the five tests above need. Without it they only say
   * that six spellings are accepted, which a `default: return message` would
   * also satisfy — and that is the change this whole allow-list exists to make
   * impossible.
   */
  assert.equal(
    parseToFrame('tok', { iris: 'tok', type: 'plugin:evaluate', pluginId: 'p', code: '' }),
    undefined,
  )
  assert.equal(
    parseFromFrame('tok', { iris: 'tok', type: 'plugin:asked', pluginId: 'p' }),
    undefined,
  )
})

// ── the offer to grant, decided where the grant is decided ─────────────────

test('the offer is made only for a directive the grant actually widens', () => {
  /*
   * The rule that keeps the button honest, and `font-src` is why it exists:
   * `srcdoc.ts` builds `faceSources` before it reads `networkGranted`, so a
   * font refusal is one the switch cannot reach. A button beside it would do
   * nothing, and a reader who pressed it would conclude the grant is broken
   * rather than that fonts are a different case.
   */
  assert.equal(grantOffer('img-src', false), 'offer', 'images are the case that motivated this')
  assert.equal(grantOffer('connect-src', false), 'offer')
  assert.equal(grantOffer('style-src', false), 'offer')

  assert.equal(grantOffer('font-src', false), 'no', 'the grant has no font-src branch')
  assert.equal(grantOffer('script-src', false), 'no', 'the grant never widens code origins')
  assert.equal(grantOffer('frame-src', false), 'no')
  assert.equal(grantOffer('form-action', false), 'no')
})

test('a browser’s element-specific directive name still gets its offer', () => {
  /*
   * Measured, not assumed: a blocked `<link>` reports `style-src-elem`, not
   * `style-src` — CSP3 splits the element-specific directives. The first version
   * of this function compared whole names, so every refused stylesheet lost its
   * offer while images kept theirs, and the asymmetry would have read as a card
   * behaving inconsistently rather than as a missing suffix strip.
   */
  assert.equal(grantOffer('style-src-elem', false), 'offer')
  assert.equal(grantOffer('script-src-elem', false), 'no', 'code origins are still never offered')
  // Only the `-elem` suffix is stripped, so an unrelated directive ending in it
  // cannot smuggle itself in.
  assert.equal(grantOffer('font-src-elem', false), 'no', 'font-src does not gain a branch by spelling')
})

test('a grant that is already on says so instead of offering itself', () => {
  /*
   * Two different problems, two different sentences. A refusal arriving while
   * the grant is on is one the button would not fix — so it must not be a
   * button, and it must not be silence either: silence reads as "nothing to do
   * here" when the reader's actual question is "why is this still refused?".
   */
  assert.equal(grantOffer('img-src', true), 'already-on')
  assert.equal(grantOffer('font-src', true), 'no', 'the three answers stay distinct under a grant too')
})

test('every directive the grant widens is on the list, checked against the policy', async () => {
  /*
   * The list in `policy.ts` and the branches in `srcdoc.ts` are two halves of one
   * fact, and this is the assertion that keeps them one. It reads the real
   * generated policy rather than restating the branches: build both, and every
   * directive whose value changed is a directive the grant widens — so a
   * directive gaining a branch without joining the list fails here instead of
   * quietly losing its offer.
   */
  const { framePolicy } = await import('../src/sandbox/srcdoc.ts')
  const off = framePolicy(false, 'http://127.0.0.1:8787')
  const on = framePolicy(true, 'http://127.0.0.1:8787')

  const directiveOf = (policy: string): Map<string, string> => {
    const map = new Map<string, string>()
    for (const part of policy.split(';')) {
      const trimmed = part.trim()
      const at = trimmed.indexOf(' ')
      if (at > 0) map.set(trimmed.slice(0, at), trimmed.slice(at + 1))
    }
    return map
  }

  const before = directiveOf(off)
  const after = directiveOf(on)
  const widened = [...after.keys()].filter(name => before.get(name) !== after.get(name)).sort()

  assert.deepEqual(
    widened,
    [...GRANT_WIDENED_DIRECTIVES].sort(),
    'a directive changed under the grant without being on GRANT_WIDENED_DIRECTIVES — its refusals'
      + ' would lose the offer, or gain one that does nothing',
  )
})
