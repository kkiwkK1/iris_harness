/**
 * The eighteen preset members as a card reaches them.
 *
 * Two properties dominate this file, and both are about **shape** rather than
 * values:
 *
 * 1. `getPreset`, `getPresetNames`, `getLoadedPresetName` and `loadPreset`
 *    return values, not promises. Upstream's do
 *    (`@types/function/preset.d.ts:180`, `:150`, `:161`, `:169`), and the
 *    corpus's one real consumer awaits none of them — so an `async` member
 *    would hand it a promise whose `.prompts` is `undefined`, the `if` would go
 *    false, and the card would carry on having silently skipped its whole
 *    preset-assembly branch. Every test that asserts a plain value here is
 *    guarding against exactly that, which is why they assert
 *    `instanceof Promise === false` explicitly rather than just reading the
 *    value.
 * 2. The write members are composed, not routed. `createPreset`,
 *    `replacePreset`, `updatePresetWith` and `setPreset` all reach one wire
 *    method between them — upstream's own composition — so the assertions are
 *    on *which calls went out with which arguments*, which is the only place a
 *    composition can be wrong.
 *
 * @module iris-web/tests/preset-facade
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { EventBus, TH_DEFAULT_PRESET, type TavernHelperPreset } from '@iris/compat-tavernhelper-core'
import type { ScriptContext } from '@iris/protocol'

import { UnsupportedApiError } from '../src/sandbox/errors.ts'
import { createFrameTavernHelper } from '../src/sandbox/tavern-helper.ts'

/** A preset as the host would put it on the snapshot. */
function preset(overrides: Partial<TavernHelperPreset> = {}): TavernHelperPreset {
  return {
    settings: TH_DEFAULT_PRESET.settings,
    prompts: [
      { id: 'main', name: 'M', enabled: true, role: 'system', content: 'sys' },
      { id: 'worldInfoBefore', name: 'W', enabled: false, role: 'system', position: { type: 'relative' } },
    ],
    prompts_unused: [],
    extensions: { iris_omitted: [] },
    ...overrides,
  }
}

/** A snapshot; `preset` is what these tests vary. */
function context(presetField?: ScriptContext['preset']): ScriptContext {
  return {
    chat: [],
    chatMetadata: {},
    name1: 'You',
    name2: 'Her',
    characters: [],
    extensionSettings: {},
    variables: {},
    variableLayers: { global: {}, character: {}, script: {}, chat: {} },
    ...presetField === undefined ? {} : { preset: presetField },
  } as ScriptContext
}

/** A façade over one snapshot, recording every call and the gaps reported. */
function facade(presetField?: ScriptContext['preset'], answers: Record<string, unknown> = {}) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const gaps: string[] = []
  const faults: string[] = []
  let snapshot = context(presetField)
  const api = createFrameTavernHelper({
    context: () => snapshot,
    scriptId: () => undefined,
    reportGap: message => { gaps.push(message) },
    reportFault: message => { faults.push(message) },
    adoptVariables: () => undefined,
    call: async (method, params) => {
      calls.push({ method, params })
      if (!Object.hasOwn(answers, method)) {
        throw new Error(`this test gave no answer for ${method}`)
      }
      return answers[method]
    },
    triggerSlash: async () => '',
    events: new EventBus(),
  })
  return {
    api,
    calls,
    gaps,
    faults,
    /** Replace the snapshot, as a `context` message does. */
    push: (next?: ScriptContext['preset']) => { snapshot = context(next) },
  }
}

/** The snapshot field for a library carrying `names`, running `body`. */
function field(names: string[], body: TavernHelperPreset, loaded?: string): ScriptContext['preset'] {
  return {
    names: ['in_use', ...names],
    ...loaded === undefined ? {} : { loaded },
    inUse: JSON.stringify(body),
  }
}

test('getPreset answers a value, not a promise, and it is the whole Preset', () => {
  const body = preset()
  const { api } = facade(field(['Other'], body, 'Mine'))
  const answer = (api['getPreset'] as (name: string) => unknown)('in_use')

  /*
   * The assertion the whole family turns on. A promise here is not a
   * near-miss: the corpus's one consumer writes
   * `if (preset && preset.prompts)`, a promise is truthy, `.prompts` is
   * undefined, and its entire preset-assembly branch is skipped inside a
   * `try`/`catch` that never fires.
   */
  assert.equal(answer instanceof Promise, false, 'getPreset must return a value; upstream’s does')
  const value = answer as TavernHelperPreset
  assert.deepEqual(value.prompts.map(prompt => [prompt.id, prompt.enabled]), [['main', true], ['worldInfoBefore', false]])
  // `content` is what the one real call site pushes into its message list — a
  // metadata-only reply would make `else if (prompt.content)` false for every
  // normal prompt and the card would assemble its prompt without any of them.
  assert.equal(value.prompts[0]?.content, 'sys')
  assert.equal(value.prompts[0]?.role, 'system')
  // And the halves a write member needs.
  assert.equal(typeof value.settings.temperature, 'number')
  assert.deepEqual(value.prompts_unused, [])
})

test('getPreset hands back a fresh object per call, as upstream’s klona does', () => {
  const { api } = facade(field([], preset()))
  const read = api['getPreset'] as (name: string) => TavernHelperPreset
  const first = read('in_use')
  first.prompts[0]!.content = 'scribbled'
  assert.equal(read('in_use').prompts[0]?.content, 'sys', 'a card’s edit must not reach the next reader')
})

test('getPreset refuses a named preset with a sentence, and refuses by throwing', () => {
  const { api } = facade(field(['Other'], preset()))
  const read = api['getPreset'] as (name: string) => TavernHelperPreset

  /*
   * A throw, not `undefined`: upstream throws for a name it cannot resolve
   * (`preset.ts:588-594`), so a card's `catch` already handles this shape,
   * while `undefined` would have it read `.prompts` off nothing one line later
   * — a `TypeError` three steps from the cause.
   */
  assert.throws(() => read('Other'), /only the preset in use can be read synchronously/u)
  // The sentence has to say what to do instead, because the card author cannot
  // see this file.
  assert.throws(() => read('Other'), /loadPreset|updatePresetWith/u)
})

test('getPreset on a host with no preset library throws rather than answering an empty preset', () => {
  const { api } = facade(undefined)
  /*
   * An empty `Preset` would be the tempting answer and it is the wrong one: a
   * card reading `prompts: []` concludes the preset has no prompts, which is a
   * statement about the host's assembly that is false. The absence of the field
   * is missing scope, not an empty library.
   */
  assert.throws(() => (api['getPreset'] as (name: string) => unknown)('in_use'), /no preset library/u)
})

test('getPreset relays the host’s refusal when the body was too big to send', () => {
  const { api } = facade({ names: ['in_use'], refusal: 'the preset in use is 6000 KiB as a card sees it' })
  assert.throws(
    () => (api['getPreset'] as (name: string) => unknown)('in_use'),
    /6000 KiB/u,
    'the size has to reach the card author; a bare failure is not actionable',
  )
})

test('a new snapshot replaces the parsed preset rather than being cached past it', () => {
  const harness = facade(field([], preset()))
  const read = harness.api['getPreset'] as (name: string) => TavernHelperPreset
  assert.equal(read('in_use').prompts[0]?.content, 'sys')

  /*
   * The one risk the parse cache carries. A preset switch reaches a live frame
   * as a fresh `context` message, so the cache must key on the text it parsed —
   * not on "have I parsed yet". Pinned because the failure is invisible: the
   * card keeps reading the preset it opened with and assembles against prompts
   * the host is no longer sending.
   */
  harness.push(field([], preset({
    prompts: [{ id: 'main', name: 'M', enabled: true, role: 'system', content: 'switched' }],
  })))
  assert.equal(read('in_use').prompts[0]?.content, 'switched')
})

test('getPresetNames answers a value with in_use first, and one reader’s sort cannot reach the next', () => {
  const { api, gaps } = facade(field(['B', 'A'], preset()))
  const names = api['getPresetNames'] as () => string[]
  const answer = names()
  assert.equal(answer instanceof Promise, false)
  assert.deepEqual(answer, ['in_use', 'B', 'A'])
  // `'in_use'` is included because upstream includes it (`preset.ts:571`): a
  // card checking membership before `loadPreset` must get the same answer.
  assert.equal(answer[0], 'in_use')

  /*
   * **This property is guaranteed twice, and that is worth recording rather
   * than hiding.** The member spreads the snapshot's array, and every member's
   * return also goes through the surface-wide `detachReturns` clone (upstream's
   * `klona`, applied once at the exit). Measured by mutation: removing the
   * spread alone leaves this assertion green, because the clone still covers
   * it. So the assertion is on the *property* a card depends on — sorting what
   * you were handed must not change what the next script reads — not on which
   * of the two mechanisms provides it, and only removing both is red.
   */
  answer.sort()
  assert.deepEqual(names(), ['in_use', 'B', 'A'])
  assert.deepEqual(gaps, [])
})

test('getPresetNames on a storeless host answers empty and says the list is not a statement', () => {
  const { api, gaps } = facade(undefined)
  assert.deepEqual((api['getPresetNames'] as () => string[])(), [])
  /*
   * The distinction a bare `[]` erases: "the library is empty" and "there is no
   * library" are different facts and a card may act on either. The report is
   * the only place the second one exists.
   */
  assert.equal(gaps.length, 1)
  assert.match(gaps[0] ?? '', /not a statement that the library is empty/u)
})

test('getLoadedPresetName answers the library name, and empty when there is none', () => {
  const named = facade(field(['Mine'], preset(), 'Mine'))
  const answer = (named.api['getLoadedPresetName'] as () => string)()
  // Cast through `unknown` because the annotation already claims `string`: the
  // assertion is about what the *implementation* returns, and a member that had
  // been made `async` would fail the annotation's own type check first.
  assert.equal((answer as unknown) instanceof Promise, false)
  assert.equal(answer, 'Mine')
  assert.deepEqual(named.gaps, [])

  /*
   * A state upstream cannot reach: `preset.delete` of the active preset leaves
   * the body live and nameless on purpose. `''` rather than a fabricated name,
   * because a fabricated one is a name `getPreset` then throws on — and
   * reported, because `''` alone is indistinguishable from a preset called `''`.
   */
  const nameless = facade(field([], preset()))
  assert.equal((nameless.api['getLoadedPresetName'] as () => string)(), '')
  assert.equal(nameless.gaps.length, 1)
  assert.match(nameless.gaps[0] ?? '', /no library name/u)
})

test('loadPreset answers a boolean immediately and fires the switch without awaiting it', async () => {
  const harness = facade(field(['Other'], preset(), 'Mine'), { loadPreset: { loaded: true } })
  const load = harness.api['loadPreset'] as (name: string) => boolean

  const answer = load('Other')
  /*
   * Upstream's shape: `preset_manager.selectPreset` starts the switch and the
   * member answers whether the *name existed*. A promise here would break the
   * `if (loadPreset(x)) { … }` a card writes.
   */
  assert.equal((answer as unknown) instanceof Promise, false)
  assert.equal(answer, true)
  assert.deepEqual(harness.calls.map(call => call.method), ['loadPreset'])
  assert.deepEqual(harness.calls[0]?.params, { name: 'Other' })

  // A name the library does not carry: `false`, and **no call** — upstream
  // decides from its own name list too, and a round trip would be a write
  // attempt for a preset the card was told does not exist.
  assert.equal(load('Nope'), false)
  assert.equal(load('in_use'), false, 'upstream’s findPreset does not find in_use either')
  assert.equal(harness.calls.length, 1)
  await Promise.resolve()
  assert.deepEqual(harness.faults, [])
})

test('loadPreset reports when the host disagrees with the answer already given', async () => {
  /*
   * The one place this member can be honestly wrong: the snapshot's name list
   * is as fresh as the last snapshot, so a preset deleted since is a `true`
   * this frame has already handed back. Upstream, where both readings come from
   * one synchronous list, has nothing to report — so the report is Iris-only
   * and exists because the alternative is a switch that silently did not happen.
   */
  const harness = facade(field(['Gone'], preset(), 'Mine'), { loadPreset: { loaded: false } })
  assert.equal((harness.api['loadPreset'] as (name: string) => boolean)('Gone'), true)
  await new Promise(resolve => { setTimeout(resolve, 0) })
  assert.equal(harness.faults.length, 1)
  assert.match(harness.faults[0] ?? '', /no longer has a preset of that name/u)
})

test('the three prompt-class guards are on the surface and answer upstream’s classes', () => {
  const { api } = facade(field([], preset()))
  const normal = api['isPresetNormalPrompt'] as (prompt: { id: string }) => boolean
  const system = api['isPresetSystemPrompt'] as (prompt: { id: string }) => boolean
  const placeholder = api['isPresetPlaceholderPrompt'] as (prompt: { id: string }) => boolean

  assert.equal(system({ id: 'jailbreak' }), true)
  assert.equal(placeholder({ id: 'worldInfoBefore' }), true)
  assert.equal(normal({ id: 'my_own_prompt' }), true)
  // The documented-but-wrong spelling must not classify, because a card that
  // matched on it would be reading the type declarations rather than upstream.
  assert.equal(placeholder({ id: 'world_info_before' }), false)
})

test('default_preset is the object itself, frozen, not a per-call copy', () => {
  const { api } = facade(field([], preset()))
  const value = api['default_preset'] as TavernHelperPreset
  assert.equal(value instanceof Promise, false)
  assert.deepEqual(value.prompts.map(prompt => prompt.id), TH_DEFAULT_PRESET.prompts.map(prompt => prompt.id))
  /*
   * A property, so the surface's one clone-on-return does not apply to it — and
   * frozen, so a card writing into what it was handed gets a `TypeError`
   * instead of quietly changing what the next `createPreset` writes. Upstream's
   * `as const` is only a type-level claim about that.
   */
  assert.equal(Object.isFrozen(value), true)
})

test('both spellings of the built-in order are the same array, and one of them is an addition', () => {
  const { api } = facade(field([], preset()))
  const deprecated = api['builtin_prompt_default_order']
  const preferred = api['placeholder_prompt_default_order']

  /*
   * Identity, not equality. Two arrays with the same contents would drift the
   * first time one of them was edited, and the whole reason both names exist
   * here is that upstream declares the second and exports only the first:
   * measured 2026-09-10, `placeholder_prompt_default_order` occurs 0 times in
   * the shipped `dist/index.js` against 1 for `builtin_prompt_default_order`,
   * and it is not a key of the `TavernHelper` object `predefine.js` merges into
   * a card's globals. Publishing it is a deliberate addition (web §89), and
   * this assertion is what keeps it from becoming a second list.
   */
  assert.equal(deprecated, preferred)
  assert.deepEqual(deprecated, [
    'world_info_before',
    'persona_description',
    'char_description',
    'char_personality',
    'scenario',
    'world_info_after',
    'dialogue_examples',
    'chat_history',
    'user_input',
  ])
})

test('getProxyPresetNames answers an empty list, which is the true answer here', () => {
  /*
   * The library is deliberately **not** empty in this fixture. With no saved
   * presets, an implementation that answered with the preset names would answer
   * `[]` too, and this assertion would pass for both — measured by mutation.
   * The names are what makes the tempting wrong mapping visible: a proxy preset
   * is a named endpoint override, a preset is a prompt list, and neither is the
   * other.
   */
  const { api, gaps } = facade(field(['Mine', 'Other'], preset()))
  const answer = (api['getProxyPresetNames'] as () => string[])()
  assert.deepEqual(answer, [])
  /*
   * **No gap report**, deliberately, and that is the assertion. An ST proxy
   * preset is a named endpoint override in `oai_settings.proxies`; upstream
   * answers `[]` on any install where nobody added one, which is the majority
   * state, and Iris has no such concept so `[]` stays true. Reporting a gap for
   * an answer that is correct would train the reader to ignore the channel.
   */
  assert.deepEqual(gaps, [])
})

test('createPreset lets the host decide whether the name is free', async () => {
  const harness = facade(field(['Taken'], preset()), {
    createOrReplacePreset: { created: false, restored: [] },
  })
  const create = harness.api['createPreset'] as (name: string, body?: TavernHelperPreset) => Promise<boolean>

  assert.equal(await create('Taken'), false)
  /*
   * `ifAbsent`, and the decision is the host's. Upstream reads its own
   * synchronous name list; the list here is as fresh as the last snapshot, so
   * deciding in the frame would leave a window in which `createPreset`
   * silently *replaced* a preset created since. Losing this flag is the
   * mutation that turns a create into an overwrite, and nothing else in this
   * file would notice.
   */
  assert.equal(harness.calls[0]?.params['ifAbsent'], true)
  // And the default body is upstream's `default_preset`, because upstream's
  // second parameter defaults to it (`preset.ts:598`).
  assert.deepEqual(
    (harness.calls[0]?.params['preset'] as TavernHelperPreset).prompts.map(prompt => prompt.id),
    TH_DEFAULT_PRESET.prompts.map(prompt => prompt.id),
  )
})

test('createOrReplacePreset reports created versus replaced and never sets ifAbsent', async () => {
  const harness = facade(field([], preset()), {
    createOrReplacePreset: { created: true, restored: [] },
  })
  const write = harness.api['createOrReplacePreset'] as (name: string, body?: TavernHelperPreset) => Promise<boolean>
  assert.equal(await write('New'), true)
  assert.equal(harness.calls[0]?.params['ifAbsent'], undefined, 'this member replaces on purpose')
})

test('deletePreset and renamePreset answer the host’s boolean', async () => {
  const harness = facade(field(['A'], preset()), {
    deletePreset: { deleted: true },
    renamePreset: { renamed: false, reason: 'name-taken' },
  })
  assert.equal(await (harness.api['deletePreset'] as (n: string) => Promise<boolean>)('A'), true)
  /*
   * `false` where upstream returns `true` having deleted the source: its
   * `renamePreset` calls `createPreset` (which writes nothing when the name is
   * taken) and then deletes the old preset unconditionally
   * (`preset.ts:696-703`). The divergence is refusing a data loss, and it is
   * recorded in web §89 / host §65.
   */
  assert.equal(
    await (harness.api['renamePreset'] as (n: string, m: string) => Promise<boolean>)('A', 'B'),
    false,
  )
  assert.deepEqual(harness.calls[1]?.params, { name: 'A', newName: 'B' })
})

test('replacePreset sends the body through and lets the host refuse an absent name', async () => {
  const harness = facade(field(['A'], preset()), {
    createOrReplacePreset: { created: false, restored: [] },
  })
  const body = preset({ prompts: [] })
  await (harness.api['replacePreset'] as (n: string, p: TavernHelperPreset) => Promise<void>)('A', body)
  assert.deepEqual(harness.calls.map(call => call.method), ['createOrReplacePreset'])
  assert.equal(harness.calls[0]?.params['name'], 'A')
  /*
   * No existence check here first, deliberately: a check against the
   * snapshot-stale name list would refuse a preset that exists and pass one
   * that does not, and the host has to decide anyway. What upstream throws for
   * a missing name, the host arm's own `not-found` throws for.
   */
  assert.equal(harness.calls.length, 1)
})

test('updatePresetWith reads over the wire, runs the card’s function, and writes it back', async () => {
  const stored = preset()
  const harness = facade(field(['A'], stored), {
    getPreset: { preset: stored },
    createOrReplacePreset: { created: false, restored: [] },
  })
  const update = harness.api['updatePresetWith'] as (
    name: string,
    updater: (p: TavernHelperPreset) => TavernHelperPreset,
  ) => Promise<TavernHelperPreset>

  const result = await update('A', body => ({
    ...body,
    prompts: body.prompts.map(prompt => ({ ...prompt, enabled: false })),
  }))

  /*
   * The read is the **asynchronous** arm, not the snapshot, and that is what
   * lets this name a library preset the synchronous `getPreset` refuses. Two
   * calls in this order is the whole of the composition; one call would mean
   * the write went out against a preset nobody read.
   */
  assert.deepEqual(harness.calls.map(call => call.method), ['getPreset', 'createOrReplacePreset'])
  assert.equal(harness.calls[0]?.params['name'], 'A')
  assert.ok(result.prompts.every(prompt => !prompt.enabled))
  assert.deepEqual(
    (harness.calls[1]?.params['preset'] as TavernHelperPreset).prompts.map(prompt => prompt.enabled),
    [false, false],
    'what the updater returned is what goes out',
  )
})

test('setPreset merges the partial over the stored preset before writing', async () => {
  const stored = preset({ settings: { ...TH_DEFAULT_PRESET.settings, temperature: 0.5, top_k: 40 } })
  const harness = facade(field(['A'], stored), {
    getPreset: { preset: stored },
    createOrReplacePreset: { created: false, restored: [] },
  })
  const set = harness.api['setPreset'] as (
    name: string,
    partial: { settings?: Record<string, unknown> },
  ) => Promise<TavernHelperPreset>

  const result = await set('in_use', { settings: { temperature: 0.9 } })

  assert.deepEqual(harness.calls.map(call => call.method), ['getPreset', 'createOrReplacePreset'])
  const written = harness.calls[1]?.params['preset'] as TavernHelperPreset
  assert.equal(written.settings.temperature, 0.9, 'the partial wins')
  assert.equal(written.settings.top_k, 40, 'and everything it did not name is filled in')
  /*
   * The prompt lists are kept whole rather than merged — upstream's `??`, not a
   * deep merge. A partial that names no prompts must not empty the list, which
   * is what a naive spread of the partial over the stored preset would do.
   */
  assert.deepEqual(written.prompts.map(prompt => prompt.id), stored.prompts.map(prompt => prompt.id))
  assert.equal(result.settings.temperature, 0.9)
})

test('every preset member refuses before the snapshot arrives, by name', () => {
  /*
   * The frame's own rule: a member that needs the snapshot and has none refuses
   * with the member's name in the message, rather than reading fields off
   * `undefined` somewhere downstream. Asserted for the four synchronous
   * members, because they are the ones with nothing to await.
   */
  const api = createFrameTavernHelper({
    context: () => undefined,
    scriptId: () => undefined,
    reportGap: () => undefined,
    reportFault: () => undefined,
    adoptVariables: () => undefined,
    call: async () => undefined,
    triggerSlash: async () => '',
    events: new EventBus(),
  })
  for (const name of ['getPreset', 'getPresetNames', 'getLoadedPresetName', 'loadPreset']) {
    assert.throws(
      () => (api[name] as (argument?: string) => unknown)('in_use'),
      (error: unknown) => error instanceof UnsupportedApiError && error.member === name,
      name,
    )
  }
})

test('the whole family is on both spellings a card writes', () => {
  /*
   * Upstream exposes every member twice — bare, and under `TavernHelper` — and
   * `predefine.js` produces the bare set by merging that object's own keys. A
   * member present on one spelling and not the other is a card that works in
   * one file and not the next, with a `ReferenceError` as the only clue.
   */
  const { api } = facade(field([], preset()))
  const nested = api['TavernHelper'] as Record<string, unknown>
  const members = [
    'getPreset', 'getPresetNames', 'getLoadedPresetName', 'loadPreset',
    'isPresetNormalPrompt', 'isPresetSystemPrompt', 'isPresetPlaceholderPrompt',
    'default_preset', 'builtin_prompt_default_order', 'placeholder_prompt_default_order',
    'getProxyPresetNames', 'createPreset', 'createOrReplacePreset', 'deletePreset',
    'renamePreset', 'replacePreset', 'updatePresetWith', 'setPreset',
  ]
  assert.equal(members.length, 18, 'the family is eighteen names; a member added here needs a test above')
  for (const name of members) {
    assert.notEqual(api[name], undefined, `bare ${name}`)
    assert.notEqual(nested[name], undefined, `TavernHelper.${name}`)
  }
})
