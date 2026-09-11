import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildScope, createRealm, evaluate } from '../src/child.ts'
import { buildEnvironment, createState, identityEscape } from '../src/index.ts'
import type { Realm, Snapshot } from '../src/index.ts'

/**
 * The realm boundary, prosecuted.
 *
 * Every test here is an attempt to obtain this realm's `Function` from inside a
 * template. That is the only thing worth attacking: once a template holds it,
 * `Function("return process")()` runs here, and `process`, `globalThis.fetch`
 * and `process.send` — the IPC channel, on which forging an `item` frame is one
 * call — are all in scope. The `vm` context's refusal of dynamic import is
 * irrelevant at that point, because the escape is no longer in the context.
 *
 * **This was open until 2026-09-11.** Measured against the code this file's
 * subject replaces: `escapeFn.constructor('return process.pid')()` answered with
 * the child's real pid, `'return typeof fetch'` answered `function`, and the
 * same reach reproduced through `include`, `rethrow`, `getvar`, `setvar`,
 * `getvar('obj').constructor`, the `SillyTavern` proxy and the `locals`
 * receiver. Eight ways in, all the same way.
 *
 * The probe is uniform on purpose: whatever expression a test names, it asks
 * three questions of the constructor that expression reaches — is it *this*
 * context's `Function`, what does it see of `process`, and what does it see of
 * `fetch` — and the answer is one string. A probe that asserted only "did not
 * throw" would pass against an escape.
 *
 * `probes the harness itself` at the bottom is the control: the same probe run
 * against a function deliberately installed **without** the bridge. It must come
 * back `foreign`, and it is the reason every `context` above can be believed.
 */

/** Variables with an object and an array in them, because both are probes. */
function snapshot(): Snapshot {
  return {
    variables: {
      global: {},
      initial: {},
      local: {},
      message: { obj: { hp: 1 }, arr: [1, 2, 3], name: '未央' },
    },
    chatMetadata: { flags: { seen: true } },
    worldInfo: [{ world: 'book', uid: '1', comment: 'Entry', content: '文本' }],
    lorebooks: { character: 'book' },
    // An object scalar as well as a string one: a data member that is an object
    // has to be re-created in the context like any other value, and a snapshot
    // of nothing but strings could not tell whether it was.
    scalars: { charName: '未央', persona: { name: 'user' } },
    traceId: 1,
  }
}

/**
 * Render one template in a fresh realm.
 * @param text - the template.
 * @param leak - when set, a host function installed on the scope unbridged.
 * @returns the rendered text.
 */
async function render(text: string, leak?: (markup: string) => string): Promise<string> {
  const snap = snapshot()
  const realm: Realm = createRealm()
  const state = createState(snap, realm)
  let scope: object = realm.create()
  const environment = buildEnvironment({
    snapshot: snap,
    realm,
    evaluateNested: (nestedText, origin, extra) =>
      evaluate(realm, nestedText, origin, realm.assign(scope, realm.adopt(extra))),
  }, state)
  scope = buildScope(realm, environment)
  // The control's one line. `realm.define` installs the value as it is, with no
  // trampoline and no re-creation — which is exactly what this package did to
  // `escapeFn` before 2026-09-11.
  if (leak) realm.define(scope, 'leak', leak)
  return await evaluate(realm, text, 'probe', scope)
}

/**
 * Ask three questions of whatever constructor an expression reaches.
 *
 * `context` means the constructor is this context's own `Function`, which a
 * template is welcome to have: it compiles and runs inside the context and sees
 * the context's globals, which are none of the interesting ones. `foreign` means
 * it is somebody else's — and the only somebody else here is the child's main
 * realm.
 * @param expression - JavaScript naming the constructor to test.
 * @param leak - passed through to {@link render}.
 * @returns `realm|typeof process|typeof fetch`, as the template saw them.
 */
async function probeConstructor(expression: string, leak?: (markup: string) => string): Promise<string> {
  const template = [
    `<%_ var ctor = ${expression} _%>`,
    "<%_ var realm = (ctor === (function(){}).constructor) ? 'context' : 'foreign' _%>",
    "<%_ var sees = function (what) { try { return String(ctor('return typeof ' + what)()) } catch (e) { return 'threw:' + e.name } } _%>",
    "<%= realm + '|' + sees('process') + '|' + sees('fetch') %>",
  ].join('')
  return await render(template, leak)
}

/** What a probe must answer: the context's own `Function`, seeing nothing. */
const SEALED = 'context|undefined|undefined'

/**
 * Every name a template can put a dot after, and what it reaches.
 *
 * The list is the audit's, plus the three this package added while reading it:
 * the guarded object's members, the live `variables` getter, and the error a
 * refusal throws — a `catch (e) { e.constructor }` is the same escape wearing a
 * different hat, and it is the one a name-by-name patch would have missed.
 */
const PROBES: Record<string, string> = {
  'escapeFn.constructor': 'escapeFn.constructor',
  'include.constructor': 'include.constructor',
  'rethrow.constructor': 'rethrow.constructor',
  'getvar.constructor': 'getvar.constructor',
  'setvar.constructor': 'setvar.constructor',
  'getwi.constructor': 'getwi.constructor',
  'getMessageVar.constructor': 'getMessageVar.constructor',
  'an object value': "getvar('obj').constructor.constructor",
  'an array value': "Object.getPrototypeOf(getvar('arr')).constructor.constructor",
  'the whole variable cache': 'getvar(null).constructor.constructor',
  'the live variables getter': 'variables.constructor.constructor',
  'the locals receiver': 'this.constructor.constructor',
  'an object scalar': 'persona.constructor.constructor',
  'lodash itself': '_.constructor',
  'a lodash member': '_.map.constructor',
  'a lodash result': '_.map([1,2], function (n) { return n }).constructor.constructor',
  'the include stub result': "include('x').constructor.constructor",
  'a guarded member': 'SillyTavern.chatMetadata.constructor.constructor',
  'a guarded method': 'SillyTavern.saveMetadata.constructor',
  'the refusal a guarded object throws': '(function(){ try { SillyTavern.getContext } catch (e) { return e.constructor.constructor } })()',
  'the refusal an option raises': "(function(){ try { getvar('x', { nonsense: 1 }) } catch (e) { return e.constructor.constructor } })()",
  'a template error': '(function(){ try { null.x } catch (e) { return e.constructor.constructor } })()',
  'a plain function (control: the context is allowed its own)': '(function(){}).constructor',
  'an async function': '(async function(){}).constructor.constructor',
}

for (const [what, expression] of Object.entries(PROBES)) {
  test(`${what} reaches nothing but the context`, async () => {
    assert.equal(await probeConstructor(expression), SEALED, expression)
  })
}

test('probes the harness itself: an unbridged function is seen, and seen as foreign', async () => {
  // The control. Without it every `context` above is a claim about a probe that
  // might simply be blind — and this exact test, written against the code of
  // 2026-09-10, is how the finding was reproduced in the first place.
  //
  // `identityEscape` is not a stand-in: it is the function this package used to
  // hand every template as EJS's `escapeFn`.
  const leaked = await probeConstructor('leak.constructor', identityEscape)
  const [realm, seesProcess, seesFetch] = leaked.split('|')
  assert.equal(realm, 'foreign', 'an unbridged function must be visible to the probe as foreign')
  assert.equal(seesProcess, 'object', 'and it must actually reach this realm — otherwise the probe proves nothing')
  assert.equal(seesFetch, 'function')
  assert.notEqual(leaked, SEALED)
})

test('the bridged twin of that same function is sealed', async () => {
  // Same function, same probe, one difference: how it crossed. `escapeFn` *is*
  // `identityEscape`, bridged.
  assert.equal(await probeConstructor('escapeFn.constructor', identityEscape), SEALED)
})

test('a getwi target the template built itself still matches', async () => {
  // The corpus's one computed `getwi` target is a `RegExp`, and a template's
  // `RegExp` is the template realm's. Coverage rather than discrimination: the
  // `instanceof` shortcut this replaced and upstream's `String.match` agree on
  // every input the corpus has, which is why the branch could sit there unfired
  // for as long as it did.
  const template = "<%- await getwi(null, new RegExp('^Ent')) %>"
  assert.equal(await render(template), '文本')
})

test('a promise a host closure returned is a promise of the context', async () => {
  // `getwi` is `async`, so before the bridge it handed a template this realm's
  // `Promise`, whose `.constructor.constructor` is this realm's `Function` —
  // the same escape, reached through an `await` instead of a call.
  const template = [
    "<%_ var p = getwi(null, 'Entry') _%>",
    "<%= (p.constructor === Promise ? 'context' : 'foreign') + '|' + (await p) %>",
  ].join('')
  assert.equal(await render(template), 'context|文本')
})

test('a rejected host closure rejects with an error of the context', async () => {
  // `getwi` with a target that is not a valid regular expression throws inside
  // the host closure, from inside a promise. Both the rejection and the value
  // have to land in the context.
  const template = [
    '<%= await (async function () {',
    "  try { await getwi(null, 'Tomori_('); return 'RESOLVED' }",
    "  catch (e) { return (e instanceof Error ? 'context' : 'foreign') + '|' + e.constructor.constructor('return typeof process')() }",
    '})() %>',
  ].join('')
  assert.equal(await render(template), 'context|undefined')
})

test('the frame that called the template is not reachable from inside it', async () => {
  // `arguments.callee.caller` is the legacy walk up the stack. The template
  // function is sloppy — it has to be, `with` is illegal in strict mode — but
  // everything above it is strict module code, and V8 answers `null` rather
  // than handing a sloppy function a strict caller. The trampolines are strict
  // too, so `getvar.caller` is a poisoned accessor.
  // `arguments` at the top level of a template is the *template function's*
  // arguments object, so `arguments.callee.caller` is the frame that invoked it
  // — this package's `evaluate`. Wrapping it in an IIFE instead would only walk
  // back to the template function, which proves nothing.
  const template = [
    "<%_ var top; try { top = String(arguments.callee.caller) } catch (e) { top = 'threw:' + e.name } _%>",
    "<%_ var tramp; try { tramp = String(getvar.caller) } catch (e) { tramp = 'threw:' + e.name } _%>",
    "<%= top + '|' + tramp %>",
  ].join('')
  const [top, tramp] = (await render(template)).split('|')
  assert.doesNotMatch(String(top), /native|\[object process\]/)
  // Measured on Node 24.13: `threw:TypeError` — EJS compiles with `async: true`
  // and V8 poisons `callee` on an async function's arguments object, so the walk
  // does not even start. `null` and `undefined` are accepted too, because either
  // would be an equally closed door and pinning the exact V8 spelling would fail
  // a correct engine upgrade.
  assert.ok(
    top === 'threw:TypeError' || top === 'null' || top === 'undefined',
    `arguments.callee.caller must reach nothing, was ${String(top)}`,
  )
  assert.equal(tramp, 'threw:TypeError', 'a strict function must poison .caller')
})

test('a bridged callable is frozen, so a template cannot dress one up', async () => {
  // Freezing is what stops `getvar.constructor = somethingElse` and, more to the
  // point, stops a template hanging state off a function the next item also sees.
  const template = [
    "<%_ var before = getvar('name') _%>",
    "<%_ try { getvar.stash = 1 } catch (e) {} _%>",
    "<%= String(Object.isFrozen(getvar)) + '|' + String(getvar.stash) + '|' + before %>",
  ].join('')
  assert.equal(await render(template), 'true|undefined|未央')
})

test('dynamic import stays refused through every constructor a template can reach', async () => {
  // The network door. `import()` is syntax rather than a global, so it survives
  // every deletion; a context with no `importModuleDynamically` refuses it. What
  // this adds to the existing coverage is the *route*: through the constructor
  // of a bridged function rather than through a bare `import()`.
  const template = [
    '<%= await (async function () {',
    '  var ctor = escapeFn.constructor',
    "  try { await ctor('return import(\"node:https\")')(); return 'REACHED' }",
    '  catch (e) { return e.constructor.name }',
    '})() %>',
  ].join('\n')
  assert.equal(await render(template), 'TypeError')
})

test('the guarded object refuses `constructor` by name, like any other member', async () => {
  // `SillyTavern` is the one object whose member list is closed, so the probe
  // that works everywhere else lands on the refusal instead — which is the right
  // answer and a stricter one. The refusal itself is probed above.
  const template = [
    '<%= (function () {',
    "  try { return 'REACHED:' + typeof SillyTavern.constructor }",
    "  catch (e) { return e.name + '|' + e.message }",
    '})() %>',
  ].join('\n')
  const answer = await render(template)
  assert.match(answer, /^UnsupportedTemplateApiError\|SillyTavern\.constructor is not available/)
})

test('a write a template performs still crosses back as data', async () => {
  // The boundary is one-way, not closed: the point of all of this is that
  // `setvar` keeps working. Its value is a realm object and leaves the child
  // through `process.send`'s structured clone, which is what makes the host side
  // realm-agnostic — so this asserts the value, not its prototype.
  const snap = snapshot()
  const realm = createRealm()
  const state = createState(snap, realm)
  const environment = buildEnvironment({
    snapshot: snap,
    realm,
    evaluateNested: async () => '',
  }, state)
  const scope = buildScope(realm, environment)
  await evaluate(realm, "<%_ setvar('obj', { hp: 2 }) _%>", 'probe', scope)
  assert.deepEqual(realm.release(environment.ops), [
    { op: 'setvar', scope: 'message', key: 'obj', value: { hp: 2 } },
  ])
})

test('every member of the scope belongs to the context, including ones added later', async () => {
  // The sweep, as opposed to the list. `PROBES` names what the audit found; this
  // walks what is actually there, so a member added next year is covered by
  // construction rather than by somebody remembering to add a row.
  const snap = snapshot()
  const realm = createRealm()
  const state = createState(snap, realm)
  const environment = buildEnvironment({
    snapshot: snap,
    realm,
    evaluateNested: async () => '',
  }, state)
  const scope = buildScope(realm, environment)

  const foreign: string[] = []
  let checked = 0
  const seen = new Set<unknown>()
  const walk = (value: unknown, path: string, depth: number): void => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
    if (seen.has(value) || depth > 4) return
    seen.add(value)
    checked += 1
    if (!realm.owns(value)) { foreign.push(path); return }
    // Own enumerable data properties only: a getter is invoked through the
    // descriptor below, and the prototype chain is what `owns` already answered.
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (descriptor.get) {
        walk(descriptor.get, `${path}.[[get ${key}]]`, depth + 1)
        walk((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1)
        continue
      }
      walk(descriptor.value, `${path}.${key}`, depth + 1)
    }
  }
  walk(scope, 'locals', 0)

  assert.deepEqual(foreign, [], 'every object a template can reach must belong to the context')
  // A floor, because a walk that visited nothing would also report no foreign
  // objects — the failure this repository has been bitten by before.
  assert.ok(checked > 25, `the sweep must actually visit the scope; it visited ${String(checked)}`)
})
