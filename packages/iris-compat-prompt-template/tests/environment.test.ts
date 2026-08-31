import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  UnsupportedTemplateApiError,
  buildEnvironment,
  createState,
  findWorldInfoEntry,
} from '../src/index.ts'
import type { Snapshot, WorldInfoEntry } from '../src/index.ts'

/**
 * The environment, transcribed from upstream's `variables.ts`.
 *
 * The behaviour that matters here is not obvious from the outside and is easy to
 * get subtly wrong: reads default to a *merged* view while writes default to the
 * *message* scope, the merge is shallow, and the merge order decides which scope
 * wins. All four are upstream's and all four are load-bearing for the 537
 * `getvar` sites in the corpus.
 */

/** A snapshot with something in every scope, so precedence is observable. */
function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    variables: {
      global: { who: 'global', onlyGlobal: 1, stat_data: { hp: 1, from: 'global' } },
      initial: { who: 'initial', onlyInitial: 2 },
      local: { who: 'local', onlyLocal: 3 },
      message: { who: 'message', onlyMessage: 4 },
    },
    chatMetadata: { yinqi_story_flags: { 宋赵复合: true } },
    worldInfo: [],
    scalars: { charName: '未央', userName: 'user' },
    traceId: 7,
    ...overrides,
  }
}

/** An environment over that snapshot, with `getwi` wired to a recording stub. */
function environment(snap: Snapshot = snapshot(), locals?: Record<string, never>) {
  const state = createState(snap)
  const nested: { text: string, origin: string }[] = []
  const env = buildEnvironment({
    snapshot: snap,
    locals,
    evaluateNested: async (text, origin) => {
      nested.push({ text, origin })
      return `[evaluated ${origin}]`
    },
  }, state)
  return { ...env, state, nested }
}

test('the merged cache follows upstream\'s order, and later scopes win', () => {
  // `Object.assign({}, global, initial, local, message)` in `precacheVariables`.
  // Message last, so a message variable shadows a global of the same name.
  const state = createState(snapshot())
  assert.equal(state.cache['who'], 'message')
  assert.equal(state.cache['onlyGlobal'], 1)
  assert.equal(state.cache['onlyInitial'], 2)
  assert.equal(state.cache['onlyLocal'], 3)
  assert.equal(state.cache['onlyMessage'], 4)
})

test('the merge is shallow, so a shadowed object is replaced whole', () => {
  // `Object.assign`, not a deep merge. A card that keeps `stat_data` in two
  // scopes does not get the union — it gets the later one entire. Copying this
  // matters because a deep merge would silently resurrect stale keys.
  const snap = snapshot()
  snap.variables.message = { stat_data: { from: 'message' } }
  const state = createState(snap)
  assert.deepEqual(state.cache['stat_data'], { from: 'message' })
})

test('the trace id is carried and the modify id starts at zero', () => {
  const state = createState(snapshot())
  assert.equal(state.cache['_trace_id'], 7)
  assert.equal(state.cache['_modify_id'], 0)
})

test('the snapshot is copied, so evaluation cannot reach back into it', () => {
  // The host pushed this object; a template mutating it would be a write that
  // bypassed the change set.
  const snap = snapshot()
  const { locals } = environment(snap)
  ;(locals['setvar'] as (k: string, v: unknown) => void)('onlyGlobal', 99)
  assert.equal((snap.variables.global as Record<string, unknown>)['onlyGlobal'], 1)
})

test('getvar reads the merged cache by default', () => {
  const { locals } = environment()
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown
  assert.equal(getvar('who'), 'message')
})

test('getvar takes a dotted path, as lodash does', () => {
  // 526 of the 537 corpus call sites are exactly this shape, and the paths are
  // lodash paths — `stat_data.App系统状态.以太能量浓度`, bracket forms included.
  const { locals } = environment()
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown
  assert.equal(getvar('stat_data.hp'), 1)
  assert.equal(getvar('stat_data.missing'), undefined)
})

test('getvar with a null key returns the whole store', () => {
  const { locals } = environment()
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown
  assert.equal((getvar(null) as Record<string, unknown>)['who'], 'message')
})

test('getvar honours a scope, including upstream\'s bare-string shorthand', () => {
  // `getvar(k, 'global')` and `getvar(k, { scope: 'global' })` are the same
  // thing upstream, which is why the scopes are pushed unmerged.
  const { locals } = environment()
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown
  assert.equal(getvar('who', 'global'), 'global')
  assert.equal(getvar('who', { scope: 'global' }), 'global')
  assert.equal(getvar('who', 'local'), 'local')
  assert.equal(getvar('who', 'initial'), 'initial')
  assert.equal(getvar('who', 'message'), 'message')
})

test('getvar returns the supplied default for a missing path', () => {
  const { locals } = environment()
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown
  assert.equal(getvar('nope', { defaults: '温柔' }), '温柔')
})

test('getvar can clone, so a template cannot mutate the cache through a read', () => {
  const { locals, state } = environment()
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown
  const cloned = getvar('stat_data', { clone: true }) as Record<string, unknown>
  cloned['hp'] = 999
  assert.equal((state.cache['stat_data'] as Record<string, unknown>)['hp'], 1)
})

test('setvar defaults to the message scope, not the read default', () => {
  // Upstream's asymmetry: reads default to `cache`, writes default to
  // `message`. Getting this wrong sends every unqualified write to the wrong
  // store, and nothing in a single generation would reveal it.
  const { locals, ops } = environment()
  const setvar = locals['setvar'] as (k: string, v: unknown, o?: unknown) => unknown
  setvar('stat_data.银麒系统.账户.银麒点', 42)

  assert.deepEqual(ops, [{ op: 'setvar', scope: 'message', key: 'stat_data.银麒系统.账户.银麒点', value: 42 }])
})

test('setvar writes the cache too, so a later read in the same batch sees it', () => {
  // Item 3's write must be visible to item 4, because upstream is writing to
  // the live application.
  const { locals } = environment()
  const setvar = locals['setvar'] as (k: string, v: unknown, o?: unknown) => unknown
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown
  setvar('who', 'written')
  assert.equal(getvar('who'), 'written')
})

test('setvar honours an explicit scope and reports it in the op', () => {
  // The one three-argument `setvar` in the corpus is
  // `setvar('stat_data.升级标志', null, { scope: 'local' })`.
  const { locals, ops } = environment()
  const setvar = locals['setvar'] as (k: string, v: unknown, o?: unknown) => unknown
  setvar('stat_data.升级标志', null, { scope: 'local' })
  assert.deepEqual(ops, [{ op: 'setvar', scope: 'local', key: 'stat_data.升级标志', value: null }])
})

test('setting undefined deletes, and reports a delvar', () => {
  const { locals, ops } = environment()
  const setvar = locals['setvar'] as (k: string, v: unknown, o?: unknown) => unknown
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown
  setvar('who', undefined)
  assert.equal(getvar('who'), undefined)
  assert.deepEqual(ops, [{ op: 'delvar', scope: 'message', key: 'who' }])
})

test('the modify id counts writes', () => {
  const { locals, state } = environment()
  const setvar = locals['setvar'] as (k: string, v: unknown, o?: unknown) => unknown
  setvar('a', 1)
  setvar('b', 2)
  assert.equal(state.cache['_modify_id'], 2)
})

test('setvar merge concatenates arrays and deep-merges objects', () => {
  const { locals } = environment()
  const setvar = locals['setvar'] as (k: string, v: unknown, o?: unknown) => unknown
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown

  setvar('list', [1, 2])
  setvar('list', [3], { merge: true })
  assert.deepEqual(getvar('list'), [1, 2, 3])

  setvar('obj', { a: 1, nested: { x: 1 } })
  setvar('obj', { b: 2, nested: { y: 2 } }, { merge: true })
  assert.deepEqual(getvar('obj'), { a: 1, b: 2, nested: { x: 1, y: 2 } })
})

test('setvar flags guard on presence in the cache', () => {
  const { locals, ops } = environment()
  const setvar = locals['setvar'] as (k: string, v: unknown, o?: unknown) => unknown
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown

  setvar('who', 'blocked', 'nx')  // exists, so nx refuses
  assert.equal(getvar('who'), 'message')
  setvar('fresh', 'allowed', 'nx')  // absent, so nx writes
  assert.equal(getvar('fresh'), 'allowed')
  setvar('absent', 'blocked', 'xx')  // absent, so xx refuses
  assert.equal(getvar('absent'), undefined)

  assert.deepEqual(ops.map(op => (op.op === 'saveMetadata' ? op.op : op.key)), ['fresh'])
})

test('setvar results selects what comes back', () => {
  const { locals } = environment()
  const setvar = locals['setvar'] as (k: string, v: unknown, o?: unknown) => unknown
  assert.equal(setvar('who', 'next'), 'next')
  assert.equal(setvar('who', 'third', 'old'), 'next')
})

test('a dry run writes nothing', () => {
  const { locals, ops } = environment()
  const setvar = locals['setvar'] as (k: string, v: unknown, o?: unknown) => unknown
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown
  setvar('who', 'nope', true)
  assert.equal(getvar('who'), 'message')
  assert.deepEqual(ops, [])
})

test('an option this layer does not implement is refused by name', () => {
  // `SANDBOX.md`'s rule: a refusal throws. `undefined` from a lookup is
  // indistinguishable from "not found", so a card would take a policy decision
  // for a missing value and fail later with no trace of why.
  const { locals } = environment()
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown
  const setvar = locals['setvar'] as (k: string, v: unknown, o?: unknown) => unknown

  assert.throws(
    () => getvar('who', { withMsg: 1 }),
    (error: unknown) => error instanceof UnsupportedTemplateApiError && /withMsg/.test(error.message) && /not pushed to the evaluator/.test(error.message),
  )
  assert.throws(() => getvar('who', { nonsense: 1 } as never), /nonsense/)
  assert.throws(() => getvar('who', 'not-a-mode'), /not a scope, flag or result mode/)
  assert.throws(() => setvar('who', 1, { index: 0 }), /index/)
})

test('SillyTavern exposes chatMetadata and saveMetadata, and refuses the rest', () => {
  // The corpus reaches for exactly these two, 16 times each. `getContext()` is
  // the one that must not silently be undefined: it is how a card would reach
  // the whole application upstream.
  const { locals, ops, state } = environment()
  const sillyTavern = locals['SillyTavern'] as Record<string, unknown>

  assert.deepEqual(sillyTavern['chatMetadata'], { yinqi_story_flags: { 宋赵复合: true } })

  ;(state.chatMetadata['yinqi_story_flags'] as Record<string, unknown>)['宋赵复合'] = false
  ;(sillyTavern['saveMetadata'] as () => void)()
  assert.deepEqual(ops, [{ op: 'saveMetadata', value: { yinqi_story_flags: { 宋赵复合: false } } }])

  assert.throws(
    () => sillyTavern['getContext'],
    (error: unknown) => error instanceof UnsupportedTemplateApiError && /SillyTavern\.getContext/.test(error.message),
  )
})

test('scalars and per-item locals reach the template', () => {
  const { locals } = environment(snapshot(), { world_info: { world: 'book' } } as never)
  assert.equal(locals['charName'], '未央')
  assert.deepEqual(locals['world_info'], { world: 'book' })
})

// --- getwi ------------------------------------------------------------------

const ENTRIES: WorldInfoEntry[] = [
  { world: 'book', uid: '1', comment: 'TakamatsuTomori_Wary', content: 'wary text' },
  { world: 'book', uid: '2', comment: 'TakamatsuTomori_Familiar', content: 'familiar text' },
  { world: 'other', uid: '1', comment: 'TakamatsuTomori_Wary', content: 'other book' },
]

test('an entry is found by title, by regex, by uid, and confined to its book', () => {
  // 58 of the 62 corpus call sites pass a literal title; the other four compute
  // it, and one of those builds a RegExp — `getwi(null, `^${charName}$`)` — which
  // is why regex targets are supported rather than assumed away.
  assert.equal(findWorldInfoEntry(ENTRIES, null, 'TakamatsuTomori_Wary')?.content, 'wary text')
  assert.equal(findWorldInfoEntry(ENTRIES, 'other', 'TakamatsuTomori_Wary')?.content, 'other book')
  assert.equal(findWorldInfoEntry(ENTRIES, null, /^TakamatsuTomori_Fam/)?.content, 'familiar text')
  assert.equal(findWorldInfoEntry(ENTRIES, 'book', 2)?.content, 'familiar text')
  assert.equal(findWorldInfoEntry(ENTRIES, null, 'absent'), undefined)
})

test('getwi(null, name) searches the entry\'s own book', () => {
  // The corpus's dominant shape. `null` means "the book this entry came from",
  // which upstream reads off `this.world_info.world`.
  const snap = snapshot({ worldInfo: ENTRIES })
  const { locals, nested } = environment(snap, { world_info: { world: 'other' } } as never)
  const getwi = locals['getwi'] as (w: string | null, e?: unknown) => Promise<string>

  return getwi(null, 'TakamatsuTomori_Wary').then((text) => {
    assert.equal(text, '[evaluated worldinfo/other/1-TakamatsuTomori_Wary]')
    assert.deepEqual(nested.map(call => call.text), ['other book'])
  })
})

test('getwi returns empty string for an entry that is not there', () => {
  // Upstream warns and returns `''`. Copied: a missing entry is a card bug the
  // card author can see in their own SillyTavern, and throwing here would lose
  // the rest of a working entry.
  const snap = snapshot({ worldInfo: ENTRIES })
  const { locals } = environment(snap)
  const getwi = locals['getwi'] as (w: string | null, e?: unknown) => Promise<string>
  return getwi(null, 'absent').then(text => assert.equal(text, ''))
})
