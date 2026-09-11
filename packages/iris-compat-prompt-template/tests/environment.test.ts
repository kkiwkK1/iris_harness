import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  UnsupportedTemplateApiError,
  buildEnvironment,
  createRealm,
  createState,
  findWorldInfoEntry,
  resolveLorebook,
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
 *
 * This file exercises the **host-side closures**, one step before the realm
 * bridge — which is what lets it assert `instanceof UnsupportedTemplateApiError`
 * and read a refusal's class. Across the bridge that class is deliberately
 * unreachable, and `realm.test.ts` is where that is prosecuted. The state,
 * though, is the real thing: it lives inside a `vm` realm here exactly as it
 * does in the child, so a value read back out of it is a realm object and is
 * compared through {@link plain}.
 */

/** One realm for the file. State is per-test; the realm it lives in is not. */
const realm = createRealm()

/**
 * A host-realm copy, for `deepEqual`.
 *
 * `assert.deepEqual` from `node:assert/strict` compares prototypes, and a value
 * that came out of the realm has the realm's. That is the change being made, not
 * an accident, so the comparison says so instead of being loosened.
 * @param value - something read out of the realm.
 * @returns the same data with this realm's prototypes.
 */
function plain<T>(value: T): T {
  return realm.release(value)
}

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
    lorebooks: {},
    scalars: { charName: '未央', userName: 'user' },
    traceId: 7,
    ...overrides,
  }
}

/** An environment over that snapshot, with `getwi` wired to a recording stub. */
function environment(snap: Snapshot = snapshot(), locals?: Record<string, never>) {
  const state = createState(snap, realm)
  const nested: { text: string, origin: string }[] = []
  const { members, ops } = buildEnvironment({
    snapshot: snap,
    realm,
    locals,
    evaluateNested: async (text, origin) => {
      nested.push({ text, origin })
      return `[evaluated ${origin}]`
    },
  }, state)
  // The description flattened the way `child.ts` flattens it, minus the bridge.
  const flat: Record<string, unknown> = { ...members.data, ...members.calls }
  for (const [key, read] of Object.entries(members.reads)) {
    Object.defineProperty(flat, key, { get: read, enumerable: true })
  }
  return { locals: flat, members, ops, state, nested }
}

test('the merged cache follows upstream\'s order, and later scopes win', () => {
  // `Object.assign({}, global, initial, local, message)` in `precacheVariables`.
  // Message last, so a message variable shadows a global of the same name.
  const state = createState(snapshot(), realm)
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
  const state = createState(snap, realm)
  assert.deepEqual(plain(state.cache['stat_data']), { from: 'message' })
})

test('the trace id is carried and the modify id starts at zero', () => {
  const state = createState(snapshot(), realm)
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
  assert.deepEqual(plain(getvar('list')), [1, 2, 3])

  setvar('obj', { a: 1, nested: { x: 1 } })
  setvar('obj', { b: 2, nested: { y: 2 } }, { merge: true })
  assert.deepEqual(plain(getvar('obj')), { a: 1, b: 2, nested: { x: 1, y: 2 } })
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
  // `docs/SANDBOX.md`'s rule: a refusal throws. `undefined` from a lookup is
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
  const { members, ops, state } = environment()
  const sillyTavern = members.objects['SillyTavern']
  assert.ok(sillyTavern, 'SillyTavern must be described as a guarded object')

  assert.deepEqual(plain(sillyTavern.reads['chatMetadata']?.()), { yinqi_story_flags: { 宋赵复合: true } })

  ;(state.chatMetadata['yinqi_story_flags'] as Record<string, unknown>)['宋赵复合'] = false
  sillyTavern.calls['saveMetadata']?.()
  assert.deepEqual(plain(ops), [{ op: 'saveMetadata', value: { yinqi_story_flags: { 宋赵复合: false } } }])

  // The refusal is described here and thrown by the realm's proxy. What this
  // layer owns is the class and the member name in the message.
  const refusal = sillyTavern.refuse('getContext')
  assert.ok(refusal instanceof UnsupportedTemplateApiError)
  assert.match(refusal.message, /SillyTavern\.getContext/)
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

test('an entry is found by title, by regex, and by uid, within one book', () => {
  // 58 of the 62 corpus call sites pass a literal title; the other four compute
  // it, and one of those builds a RegExp — ``getwi(null, `^${charName}$`)`` — which
  // is why regex targets are supported rather than assumed away.
  assert.equal(findWorldInfoEntry(ENTRIES, 'book', 'TakamatsuTomori_Wary')?.content, 'wary text')
  assert.equal(findWorldInfoEntry(ENTRIES, 'other', 'TakamatsuTomori_Wary')?.content, 'other book')
  assert.equal(findWorldInfoEntry(ENTRIES, 'book', /^TakamatsuTomori_Fam/)?.content, 'familiar text')
  assert.equal(findWorldInfoEntry(ENTRIES, 'book', 2)?.content, 'familiar text')
  assert.equal(findWorldInfoEntry(ENTRIES, 'book', 'absent'), undefined)
})

test('a string target is also tried as a regex, as String.match does', () => {
  // Upstream's third predicate is `comment.match(title)`, so a plain string is
  // coerced to a RegExp. Faithful, warts included: a title carrying regex
  // metacharacters throws here exactly as it does upstream.
  assert.equal(findWorldInfoEntry(ENTRIES, 'book', 'Tomori_Fam')?.content, 'familiar text')
  assert.throws(() => findWorldInfoEntry(ENTRIES, 'book', 'Tomori_('), SyntaxError)
})

test('a lookup with no resolved book finds nothing, rather than searching all books', () => {
  // The correction that matters. Upstream loads exactly one book; when the chain
  // runs out it loads nothing and the lookup fails. Searching the union instead
  // would answer with a same-titled entry from a book the card never referenced —
  // the right shape of answer from the wrong place, and nothing raised anywhere.
  assert.equal(findWorldInfoEntry(ENTRIES, undefined, 'TakamatsuTomori_Wary'), undefined)
})

test('the lorebook fallback chain is upstream\'s, in upstream\'s order', () => {
  // `name || card.data.extensions.world || persona || chat || ''`, with the
  // entry's own book reached first through `boundedReadWorldinfo`.
  const books = { character: 'card', persona: 'persona', chat: 'chat' }
  assert.equal(resolveLorebook('explicit', 'entry', books), 'explicit')
  assert.equal(resolveLorebook(null, 'entry', books), 'entry')
  assert.equal(resolveLorebook(null, undefined, books), 'card')
  assert.equal(resolveLorebook(null, undefined, { persona: 'persona', chat: 'chat' }), 'persona')
  assert.equal(resolveLorebook(null, undefined, { chat: 'chat' }), 'chat')
  assert.equal(resolveLorebook(null, undefined, {}), undefined)
  // Upstream chains with `||`, so an empty string falls through rather than
  // selecting a book named "".
  assert.equal(resolveLorebook('', '', { character: 'card' }), 'card')
})

test('getwi(null, name) searches the entry\'s own book when it has one', () => {
  // An entry evaluated in its own right — a nested `getwi`, or one of the
  // individually-evaluated decorator entries — carries `world_info`, and that is
  // the first link in the chain.
  const snap = snapshot({ worldInfo: ENTRIES, lorebooks: { character: 'book' } })
  const { locals, nested } = environment(snap, { world_info: { world: 'other' } } as never)
  const getwi = locals['getwi'] as (w: string | null, e?: unknown) => Promise<string>

  return getwi(null, 'TakamatsuTomori_Wary').then((text) => {
    assert.equal(text, '[evaluated worldinfo/other/1-TakamatsuTomori_Wary]')
    assert.deepEqual(nested.map(call => call.text), ['other book'])
  })
})

test('getwi(null, name) falls back to the card\'s bound book', () => {
  // The corpus's actual shape: all 58 literal call sites pass `null`, and every
  // target lives in the calling card's bound book. Text folded into an assembled
  // message has no `world_info`, so this is the link that resolves them.
  const snap = snapshot({ worldInfo: ENTRIES, lorebooks: { character: 'book' } })
  const { locals } = environment(snap)
  const getwi = locals['getwi'] as (w: string | null, e?: unknown) => Promise<string>

  return getwi(null, 'TakamatsuTomori_Wary').then((text) => {
    assert.equal(text, '[evaluated worldinfo/book/1-TakamatsuTomori_Wary]')
  })
})

test('getwi returns empty string for an entry that is not there', () => {
  // Upstream warns and returns `''`. Copied: a missing entry is a card bug the
  // card author can see in their own SillyTavern, and throwing here would lose
  // the rest of a working entry.
  const snap = snapshot({ worldInfo: ENTRIES, lorebooks: { character: 'book' } })
  const { locals } = environment(snap)
  const getwi = locals['getwi'] as (w: string | null, e?: unknown) => Promise<string>
  return getwi(null, 'absent').then(text => assert.equal(text, ''))
})

test('writing the initial scope is refused by name', () => {
  // Upstream allows it, writing an in-memory store that evaporates with the
  // page. Iris has no such store — `initial` is a projection of the card file —
  // so the write would either vanish silently or edit the card. Refused instead.
  const { locals } = environment()
  const setvar = locals['setvar'] as (k: string, v: unknown, o?: unknown) => unknown
  assert.throws(
    () => setvar('who', 1, { scope: 'initial' }),
    (error: unknown) => error instanceof UnsupportedTemplateApiError && /not writable at runtime/.test(error.message),
  )
})

test('reading the initial scope still works', () => {
  const { locals } = environment()
  const getvar = locals['getvar'] as (key: string | null, options?: unknown) => unknown
  assert.equal(getvar('who', 'initial'), 'initial')
})
