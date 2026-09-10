/**
 * The regex family as a card reaches it, on the frame side.
 *
 * The host half is pinned in `packages/iris-app-service/tests/tavern-regex.test.ts`;
 * this file is about the **call shapes**, which is where upstream's own history
 * lives: `getTavernRegexes` and `replaceTavernRegexes` each answer two
 * signatures, the new `{type, name}` one and the deprecated `{scope,
 * enable_state}` one, and the deprecated one is the only place the tier order
 * shows up in a single answer.
 *
 * What is pinned:
 *
 * - both signatures of both members, including upstream's two refusal strings
 *   **character for character** — a card that catches one and reads its text is
 *   reading that text;
 * - the deprecated read's `scope` tag and its order (global rows first);
 * - the deprecated write's partition rule, where a row with **no** `scope`
 *   belongs to the card (upstream's `_.partition` falsy half);
 * - a `name` that names another card or another preset being **refused rather
 *   than ignored**, which is this family's narrowed scope;
 * - `updateTavernRegexesWith` composed from the two round trips rather than
 *   reaching them through the published object;
 * - `isCharacterTavernRegexesEnabled` reading the snapshot, with absent meaning
 *   allowed.
 *
 * @module iris-web/tests/tavern-regex-facade
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { EventBus } from '@iris/compat-tavernhelper-core'
import type { ScriptContext, TavernRegexView } from '@iris/protocol'

import { UnsupportedApiError } from '../src/sandbox/errors.ts'
import { createFrameTavernHelper } from '../src/sandbox/tavern-helper.ts'
import { CARD_METHODS, OFF_ST_SURFACE, isCardMethod } from '../src/sandbox/card-api.ts'
import { MEMBER_KINDS } from '../src/sandbox/identity.ts'
import { UPSTREAM_CONTEXT_MEMBERS } from '../src/sandbox/upstream-surface.ts'

/** The five names this family adds. */
const MEMBERS = [
  'getTavernRegexes',
  'replaceTavernRegexes',
  'updateTavernRegexesWith',
  'isCharacterTavernRegexesEnabled',
  'formatAsTavernRegexedString',
] as const

/** One rule, in the vocabulary the wire carries. */
function rule(id: string, enabled = true): TavernRegexView {
  return {
    id,
    script_name: id,
    enabled,
    find_regex: '/x/g',
    replace_string: 'y',
    trim_strings: [],
    source: {
      user_input: false,
      ai_output: true,
      slash_command: false,
      world_info: false,
      reasoning: false,
    },
    destination: { display: true, prompt: false },
    run_on_edit: false,
    min_depth: null,
    max_depth: null,
  }
}

/** A snapshot; only the regex gate is varied. */
function context(allowed?: boolean): ScriptContext {
  return {
    chat: [],
    chatMetadata: {},
    name1: 'You',
    name2: 'Her',
    characters: [],
    extensionSettings: {},
    variables: {},
    variableLayers: { global: {}, character: {}, script: {}, chat: {} },
    ...allowed === undefined ? {} : { characterRegexAllowed: allowed },
  } as ScriptContext
}

/**
 * The façade, the calls it made, and a host that answers per method.
 * @param answers - keyed by the card-facing action name the frame calls.
 * @param allowed - the snapshot's regex gate.
 */
function surface(
  answers: Record<string, unknown> = {},
  allowed?: boolean,
) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const gaps: string[] = []
  const api = createFrameTavernHelper({
    context: () => context(allowed),
    scriptId: () => undefined,
    reportGap: message => gaps.push(message),
    reportFault: message => gaps.push(message),
    adoptVariables: () => undefined,
    call: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> })
      return answers[method]
    },
    triggerSlash: async () => '',
    events: new EventBus(),
  })
  return { api, calls, gaps }
}

type Read = (option?: Record<string, unknown>) => Promise<(TavernRegexView & { scope?: string })[]>
type Write = (
  regexes: readonly Record<string, unknown>[],
  option?: Record<string, unknown>,
) => Promise<void>

// ── the surface ─────────────────────────────────────────────────────────────

test('all five names are on the surface, bare and under TavernHelper', () => {
  const { api } = surface()
  for (const name of MEMBERS) {
    assert.equal(typeof api[name], 'function', `${name} is missing from the bare surface`)
    const nested = api['TavernHelper'] as Record<string, unknown>
    assert.equal(typeof nested[name], 'function', `${name} is missing from TavernHelper`)
  }
})

test('the three that need the host are routable, and the two that do not are still card methods', () => {
  // The split is the family's design: two members are answered in the frame —
  // one because it takes a function, one because it really is synchronous — and
  // a table listing all five would give each of them a wire method that does
  // not exist.
  assert.deepEqual(
    Object.keys(CARD_METHODS).filter(name => (MEMBERS as readonly string[]).includes(name)).sort(),
    ['formatAsTavernRegexedString', 'getTavernRegexes', 'replaceTavernRegexes'],
  )
  assert.equal(isCardMethod('updateTavernRegexesWith'), false)
  assert.equal(isCardMethod('isCharacterTavernRegexesEnabled'), false)
})

test('none of the five is served on the SillyTavern object, and none belongs there', () => {
  // The deny list defaults to *exposed*, so a name missing from it would be
  // published — this is the assertion that notices.
  for (const name of MEMBERS) {
    assert.ok(OFF_ST_SURFACE.includes(name), `${name} would be published on SillyTavern`)
  }
  /*
   * And the reason, asserted rather than asserted-about: none of the five is
   * among `st-context.js`'s 145 keys, so `SillyTavern.getTavernRegexes` would
   * be Iris inventing a member on the surface it mirrors. Checked against the
   * written-down list (§82) rather than by eye, so upstream adding one of these
   * names to its context would turn this red instead of leaving a comment
   * quietly wrong.
   */
  const onContext = MEMBERS.filter(name => UPSTREAM_CONTEXT_MEMBERS.includes(name))
  assert.deepEqual(onContext, [], 'upstream now puts these on getContext(); the deny list needs re-reading')
  // The control: the list really does carry names, so an empty or misspelled
  // import could not make the assertion above pass for free.
  assert.ok(UPSTREAM_CONTEXT_MEMBERS.includes('saveChat'), 'the 145-key list did not load')
})

test('every one of the five is classified, and all as shared', () => {
  for (const name of MEMBERS) {
    assert.equal(MEMBER_KINDS[name], 'shared', `${name} is not classified as shared`)
  }
})

// ── getTavernRegexes: the new signature ─────────────────────────────────────

test('a tier read asks the host for exactly that tier', async () => {
  const { api, calls } = surface({ getTavernRegexes: { regexes: [rule('g')] } })
  const rows = await (api['getTavernRegexes'] as Read)({ type: 'global' })

  assert.deepEqual(calls, [{ method: 'getTavernRegexes', params: { tier: 'global' } }])
  assert.deepEqual(rows.map(row => row.id), ['g'])
  // No `scope` on the new path: upstream marks the field `@deprecated` and says
  // it is returned only by the old one, so inventing it here would hand a card
  // a field real SillyTavern does not send.
  assert.equal('scope' in (rows[0] ?? {}), false)
})

test('the self-referential names pass through, and any other is refused by name', async () => {
  const { api, calls } = surface({ getTavernRegexes: { regexes: [] } })
  const read = api['getTavernRegexes'] as Read

  await read({ type: 'character', name: 'current' })
  await read({ type: 'preset', name: 'in_use' })
  assert.deepEqual(calls.map(call => call.params['tier']), ['character', 'preset'])

  /*
   * The narrowed scope, and refused rather than ignored — the whole point.
   * Upstream resolves a name through `RawCharacter.findIndex`, so a card there
   * really can read another installed card's tier. Answering this call with
   * *this* card's rules would be a wrong answer that looks right, and a card
   * that then wrote the list back would overwrite the wrong document.
   */
  await assert.rejects(
    read({ type: 'character', name: '另一张卡' }),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedApiError)
      assert.match(error.message, /另一张卡/, 'the refusal must quote what was asked for')
      return true
    },
  )
  await assert.rejects(read({ type: 'preset', name: '别的预设' }), UnsupportedApiError)
  await assert.rejects(read({ type: 'nonsense' }), UnsupportedApiError)
})

// ── getTavernRegexes: the deprecated signature ──────────────────────────────

test('the deprecated read concatenates global then card, each row tagged', async () => {
  // A host that answers differently per tier, which is what an ordering
  // assertion needs: with one shared answer, every order looks the same.
  const api = createFrameTavernHelper({
    context: () => context(),
    scriptId: () => undefined,
    reportGap: () => undefined,
    reportFault: () => undefined,
    adoptVariables: () => undefined,
    call: async (_method, params) => {
      const tier = (params as { tier?: string }).tier
      return { regexes: [rule(tier === 'global' ? 'g' : 'c')] }
    },
    triggerSlash: async () => '',
    events: new EventBus(),
  })
  const merged = await (api['getTavernRegexes'] as Read)()

  /*
   * Global first, then the card's — upstream's own concatenation order
   * (`src/function/tavern_regex.ts:222-233`), and the one place the tier order
   * is visible in a single answer. Note what it omits: the **preset** tier,
   * which runs between these two, is not in this list on either host.
   */
  assert.deepEqual(merged.map(row => [row.id, row.scope]), [['g', 'global'], ['c', 'character']])
})

test('the deprecated read honours scope and enable_state', async () => {
  const answering = createFrameTavernHelper({
    context: () => context(),
    scriptId: () => undefined,
    reportGap: () => undefined,
    reportFault: () => undefined,
    adoptVariables: () => undefined,
    call: async (_method, params) => {
      const tier = (params as { tier?: string }).tier
      return tier === 'global'
        ? { regexes: [rule('g-on', true), rule('g-off', false)] }
        : { regexes: [rule('c-on', true)] }
    },
    triggerSlash: async () => '',
    events: new EventBus(),
  })
  const read = answering['getTavernRegexes'] as Read

  assert.deepEqual((await read({ scope: 'global' })).map(row => row.id), ['g-on', 'g-off'])
  assert.deepEqual((await read({ scope: 'character' })).map(row => row.id), ['c-on'])
  assert.deepEqual(
    (await read({ enable_state: 'disabled' })).map(row => row.id),
    ['g-off'],
    'the filter reads the document’s own switch, which is what `enabled` carries',
  )
  assert.deepEqual((await read({ enable_state: 'enabled' })).map(row => row.id), ['g-on', 'c-on'])
})

test('the deprecated read refuses a bad argument in upstream’s own words', async () => {
  const { api } = surface({ getTavernRegexes: { regexes: [] } })
  const read = api['getTavernRegexes'] as Read

  /*
   * Character for character, and **checked in upstream's order** —
   * `enable_state` first (`src/function/tavern_regex.ts:214-219`), so a call
   * that is wrong twice is refused with the message upstream would give it.
   * A card catching one of these and matching on its text is matching on this.
   */
  await assert.rejects(read({ enable_state: 'maybe', scope: 'nowhere' }), {
    message: "提供的 enable_state 无效, 请提供 'all', 'enabled' 或 'disabled', 你提供的是: maybe",
  })
  await assert.rejects(read({ scope: 'nowhere' }), {
    message: "提供的 scope 无效, 请提供 'all', 'global' 或 'character', 你提供的是: nowhere",
  })
})

// ── replaceTavernRegexes ────────────────────────────────────────────────────

test('a tier write sends that tier, with the deprecated tag stripped', async () => {
  const { api, calls } = surface({ replaceTavernRegexes: { regexes: [] } })
  await (api['replaceTavernRegexes'] as Write)(
    [{ ...rule('a'), scope: 'global' }],
    { type: 'character' },
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.params['tier'], 'character')
  const sent = (calls[0]?.params['regexes'] as Record<string, unknown>[])[0] ?? {}
  /*
   * `scope` is the deprecated read's tag, not a stored field, and the host's
   * schema is strict. A card that read the legacy shape and wrote it back
   * would otherwise be refused for echoing exactly what it was handed —
   * which is the commonest thing a card does with a list.
   */
  assert.equal('scope' in sent, false, 'the tag must not reach a strict schema')
  assert.equal(sent['id'], 'a')
})

test('the deprecated write partitions by each row’s own scope, card taking the untagged', async () => {
  const { api, calls } = surface({ replaceTavernRegexes: { regexes: [] } })
  await (api['replaceTavernRegexes'] as Write)([
    { ...rule('g'), scope: 'global' },
    { ...rule('c'), scope: 'character' },
    // No `scope` at all. Upstream's `_.partition(regexes, r => r.scope ===
    // 'global')` puts everything falsy in the second bucket, so this belongs
    // to the card — not to neither, and not to both.
    { ...rule('u') },
  ])

  assert.deepEqual(
    calls.map(call => [call.params['tier'], (call.params['regexes'] as { id: string }[]).map(row => row.id)]),
    [['global', ['g']], ['character', ['c', 'u']]],
  )
})

test('the deprecated write refuses a bad scope in upstream’s own words', async () => {
  const { api } = surface({ replaceTavernRegexes: { regexes: [] } })
  await assert.rejects(
    (api['replaceTavernRegexes'] as Write)([], { scope: 'nowhere' }),
    { message: "提供的 scope 无效, 请提供 'all', 'global' 或 'character', 你提供的是: nowhere" },
  )
})

// ── updateTavernRegexesWith ─────────────────────────────────────────────────

test('the updater sees the tier, its result is written, and the stored tier comes back', async () => {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  let stored = [rule('a')]
  const api = createFrameTavernHelper({
    context: () => context(),
    scriptId: () => undefined,
    reportGap: () => undefined,
    reportFault: () => undefined,
    adoptVariables: () => undefined,
    call: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> })
      if (method === 'replaceTavernRegexes') {
        // The host renames a blank name on the way in, which is what makes
        // "return the stored tier" different from "return the updater's array".
        stored = ((params as { regexes: TavernRegexView[] }).regexes)
          .map(row => ({ ...row, script_name: row.script_name === '' ? `未命名-${row.id}` : row.script_name }))
        return { regexes: stored }
      }
      return { regexes: stored }
    },
    triggerSlash: async () => '',
    events: new EventBus(),
  })

  const answer = await (api['updateTavernRegexesWith'] as (
    updater: (rows: TavernRegexView[]) => TavernRegexView[],
    option?: Record<string, unknown>,
  ) => Promise<TavernRegexView[]>)(
    rows => rows.map(row => ({ ...row, script_name: '' })),
    { type: 'character' },
  )

  // Get, replace, get — upstream's own composition is get, replace, and return
  // the updater's array; this reads back instead, because the host's answer is
  // where a filled-in name or a carried-across field becomes visible.
  assert.deepEqual(
    calls.map(call => call.method),
    ['getTavernRegexes', 'replaceTavernRegexes', 'getTavernRegexes'],
  )
  assert.deepEqual(answer.map(row => row.script_name), ['未命名-a'])
})

test('an async updater is awaited, as upstream’s union of both allows', async () => {
  const api = createFrameTavernHelper({
    context: () => context(),
    scriptId: () => undefined,
    reportGap: () => undefined,
    reportFault: () => undefined,
    adoptVariables: () => undefined,
    call: async (_method, _params) => ({ regexes: [rule('a')] }),
    triggerSlash: async () => '',
    events: new EventBus(),
  })
  const rows = await (api['updateTavernRegexesWith'] as (
    updater: (rows: TavernRegexView[]) => Promise<TavernRegexView[]>,
    option?: Record<string, unknown>,
  ) => Promise<TavernRegexView[]>)(async rows => Promise.resolve(rows), { type: 'global' })
  // One tier, one row. `{type: 'global'}` rather than no option, because no
  // option takes the deprecated path and reads *two* tiers — which is itself
  // the behaviour the tests above pin, and would make this assertion about the
  // wrong thing.
  assert.equal(rows.length, 1)
})

// ── isCharacterTavernRegexesEnabled ─────────────────────────────────────────

test('the gate is answered from the snapshot, and absent means allowed', () => {
  const refused = surface({}, false)
  assert.equal((refused.api['isCharacterTavernRegexesEnabled'] as () => boolean)(), false)

  const allowed = surface({}, true)
  assert.equal((allowed.api['isCharacterTavernRegexesEnabled'] as () => boolean)(), true)

  /*
   * Absent is `true`, which is this host's own default for the card tier and a
   * deliberate divergence from upstream's (§30): there a character must be
   * added to `character_allowed_regex` by hand, here the tier runs until the
   * user refuses it. A card asking this on a fresh install therefore gets
   * `true` here and `false` on real SillyTavern.
   */
  const silent = surface({})
  assert.equal((silent.api['isCharacterTavernRegexesEnabled'] as () => boolean)(), true)
})

test('the gate is synchronous, because upstream’s caller does not await', () => {
  const { api, calls } = surface({}, true)
  const answer = (api['isCharacterTavernRegexesEnabled'] as () => unknown)()
  assert.equal(typeof answer, 'boolean', 'a promise here would fail every `if` a card writes')
  assert.deepEqual(calls, [], 'it must not reach the host at all')
})

// ── formatAsTavernRegexedString ─────────────────────────────────────────────

test('the format call carries the source, the destination and both options', async () => {
  const { api, calls } = surface({ formatAsTavernRegexedString: { text: 'done' } })
  const text = await (api['formatAsTavernRegexedString'] as (
    text: string, source: string, destination: string, option?: Record<string, unknown>,
  ) => Promise<string>)('raw', 'ai_output', 'display', { depth: 0, character_name: '别人' })

  assert.equal(text, 'done')
  assert.deepEqual(calls, [{
    method: 'formatAsTavernRegexedString',
    params: {
      text: 'raw',
      source: 'ai_output',
      destination: 'display',
      // `depth: 0` must survive: it is the last message, the commonest value a
      // card passes, and the one a truthiness check would drop.
      depth: 0,
      // Renamed at the boundary, upstream's `character_name` to the wire's
      // `characterName`, rather than in either half's own vocabulary.
      characterName: '别人',
    },
  }])
})

test('an omitted option sends no key, so the host’s "unstated" branch is reachable', async () => {
  const { api, calls } = surface({ formatAsTavernRegexedString: { text: 'done' } })
  await (api['formatAsTavernRegexedString'] as (
    text: string, source: string, destination: string,
  ) => Promise<string>)('raw', 'reasoning', 'prompt')

  // An absent depth means "do not consider the depth window at all" — upstream's
  // own wording. Sending `depth: undefined` would be a present key on a strict
  // schema, and sending `depth: 0` would silently mean "the last message".
  assert.deepEqual(calls[0]?.params, { text: 'raw', source: 'reasoning', destination: 'prompt' })
})

test('a source or destination upstream does not define is refused by name', async () => {
  const { api, calls } = surface({ formatAsTavernRegexedString: { text: 'done' } })
  const format = api['formatAsTavernRegexedString'] as (
    text: string, source: string, destination: string,
  ) => Promise<string>

  await assert.rejects(format('raw', 'md_display', 'display'), (error: unknown) => {
    assert.ok(error instanceof UnsupportedApiError)
    assert.match(error.message, /user_input/, 'the refusal must list the five spellings')
    return true
  })
  await assert.rejects(format('raw', 'ai_output', 'markdown'), UnsupportedApiError)
  // Refused in the frame, so nothing was spent on a round trip that could only
  // have come back as a schema failure naming the transport.
  assert.deepEqual(calls, [])
})
