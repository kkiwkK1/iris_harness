import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { CharacterCard } from '@iris/character'
import type { SillyTavernChatHeader } from '@iris/persistence'
import { buildEnvironment, createRealm, createState } from '@iris/compat-prompt-template'
import type { Snapshot } from '@iris/compat-prompt-template'
import { applyCommands, extractCommands } from '@iris/mvu'
import { isForbiddenKey } from '@iris/variables'

import { AppError } from '../src/errors.ts'
import { CardStorageStore } from '../src/card-storage.ts'
import { assertStorable } from '../src/context.ts'
import { ChatEntry, createSession } from '../src/entry.ts'
import { seedGreeting } from '../src/chats.ts'
import { applyOps, writePath } from '../src/template.ts'

/**
 * Every face that turns an untrusted string into a variable key.
 *
 * The audit's finding was not that one of these was wrong — it was that the
 * safety of all of them rested on `lodash-es` resolving to 4.18.x. So the
 * subject here is coverage: each face refuses, each names the offending key,
 * and the realm-side copy of the predicate in `@iris/compat-prompt-template`
 * agrees with the exported one. See
 * `notes/packages/iris-variables/DEVIATIONS.md` §1 and
 * `notes/packages/iris-app-service/DEVIATIONS.md` §73.
 */

/** The three, read from the predicate rather than retyped. */
const FORBIDDEN = ['__proto__', 'constructor', 'prototype'].filter(name => isForbiddenKey(name))

/** An open conversation, the shape `applyOps` writes into. */
function entryFor(): ChatEntry {
  const built: CharacterCard = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '络络',
      description: '', personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', creator_notes: '',
      system_prompt: '', post_history_instructions: '', alternate_greetings: [],
      tags: [], creator: '', character_version: '1', extensions: {},
    },
  }
  const header: SillyTavernChatHeader = {
    user_name: '旅人',
    character_name: '络络',
    create_date: '2026-09-01 @10h00m00s',
    chat_metadata: {},
    iris: { chatId: 'c1', characterId: 'luoluo', title: '络络', updatedAt: 0 },
  }
  const entry = new ChatEntry({ chatId: 'c1', header, session: createSession('c1'), card: built })
  seedGreeting(entry, built, { user: '旅人', char: '络络' })
  return entry
}

test('the predicate is the one from @iris/variables, and it names three keys', () => {
  assert.deepEqual(FORBIDDEN, ['__proto__', 'constructor', 'prototype'])
})

test('writePath refuses a reserved segment at the head and in the middle, naming it', () => {
  // Without the guard the loop below would have copied `Object.prototype` into
  // the cursor and written through it.
  assert.throws(() => writePath({}, '__proto__.x', 1), /__proto__/)
  assert.throws(() => writePath({}, 'a.__proto__.b', 1), /__proto__/)
  assert.throws(() => writePath({}, 'a.constructor.prototype.x', 1), /constructor/)
  assert.throws(() => writePath({}, 'prototype', 1), /prototype/)
  // The message names the whole path as well, because a template author needs
  // to find which write it was.
  assert.throws(() => writePath({}, 'a.__proto__.b', 1), /a\.__proto__\.b/)

  // And the ordinary cases the corpus actually writes still work, unchanged.
  assert.deepEqual(writePath({}, 'a.b.c', 1), { a: { b: { c: 1 } } })
  assert.deepEqual(writePath({}, 'a.0', 'x'), { a: ['x'] })
  assert.deepEqual(writePath({}, '角色.络络.好感度', 5), { 角色: { 络络: { 好感度: 5 } } })

  assert.equal(({} as Record<string, unknown>)['x'], undefined, 'Object.prototype was written')
})

test('assertStorable refuses a reserved own key and says where it sits', () => {
  // Built through JSON so `__proto__` is an own data property — the shape a
  // frame's answer actually has.
  for (const key of FORBIDDEN) {
    const tree = JSON.parse(`{"a":{"${key}":{"polluted":1}}}`) as unknown
    assert.throws(
      () => { assertStorable(tree, 'variables') },
      new RegExp(`variables\\.a\\.${key === '__proto__' ? '__proto__' : key}`),
      key,
    )
  }
  // An ordinary tree is untouched, including the shapes `context.test.ts`
  // already pins.
  assertStorable({ ok: [1, 'two', null, { three: true }] })
  assertStorable({ 角色: { 络络: { 好感度: 5 } } })
})

test('applyOps refuses every op that carries a reserved path, delvar included', () => {
  const entry = entryFor()
  for (const key of FORBIDDEN) {
    assert.throws(() => applyOps(entry, [{ op: 'setvar', scope: 'message', key: `a.${key}.b`, value: 1 }], 0),
      new RegExp(key), `setvar ${key}`)
    // `delvar` never reaches `writePath`, which is why it is checked one level
    // up rather than relying on that function's own guard. The *code* is
    // asserted, not only the message: `deletePath` in `@iris/variables` also
    // refuses this path, so a missing check here would still throw — as a
    // `ForbiddenKeyError` escaping onto the wire instead of this face's
    // `invalid-request`. Matching the message alone cannot tell them apart.
    assert.throws(
      () => applyOps(entry, [{ op: 'delvar', scope: 'message', key: `a.${key}` }], 0),
      (error: unknown) => error instanceof AppError
        && error.code === 'invalid-request'
        && new RegExp(key).test(error.message),
      `delvar ${key}`,
    )
    assert.throws(() => applyOps(entry, [{ op: 'insvar', scope: 'message', key: `${key}.x`, value: 1 }], 0),
      new RegExp(key), `insvar ${key}`)
  }
  // A saveMetadata carrying one is refused by `assertStorable` on the value.
  assert.throws(
    () => applyOps(entry, [{ op: 'saveMetadata', value: JSON.parse('{"__proto__":{"p":1}}') as never }], 0),
    /__proto__/)

  // An ordinary write still lands.
  assert.equal(applyOps(entry, [{ op: 'setvar', scope: 'message', key: 'mood', value: 'calm' }], 0), 1)
  assert.equal(entry.variables.getVariables({ type: 'message', message_id: 0 })['mood'], 'calm')
})

test('the template environment refuses inside the realm, and the host refuses what crosses back', () => {
  const realm = createRealm()
  const snap: Snapshot = {
    variables: { global: {}, initial: {}, local: {}, message: {} },
    chatMetadata: {},
    worldInfo: [],
    lorebooks: {},
    scalars: { charName: '络络', userName: '旅人' },
    traceId: 1,
  }
  const state = createState(snap, realm)
  const { members, ops } = buildEnvironment({
    snapshot: snap,
    realm,
    evaluateNested: async () => '',
  }, state)
  const setvar = members.calls['setvar'] as (key: string, value: unknown, options?: unknown) => unknown

  // The realm-side refusal. This is the cross-package pin: the copy of the
  // three names in `@iris/compat-prompt-template/environment` is exercised
  // against the list `@iris/variables` exports, so the two cannot drift apart
  // without this going red.
  for (const key of FORBIDDEN) {
    assert.throws(() => setvar(`a.${key}.b`, 1), new RegExp(key), `realm ${key}`)
    // `dryRun` too: the refusal is about the path, not about whether the call
    // would have written.
    assert.throws(() => setvar(`${key}.x`, 1, { dryRun: true }), new RegExp(key), `realm dryRun ${key}`)
  }
  assert.equal(ops.length, 0, 'a refused setvar must push no op')

  // And an ordinary write goes through and produces an op, so the guard has
  // not simply broken `setvar`.
  setvar('mood', 'calm')
  assert.equal(ops.length, 1)

  // The host leg: an op that somehow carried a reserved key is refused again
  // when it crosses back, because a template that throws has still had its
  // earlier writes applied.
  assert.throws(
    () => applyOps(entryFor(), [{ op: 'setvar', scope: 'message', key: '__proto__.x', value: 1 }], 0),
    /__proto__/)

  assert.equal(({} as Record<string, unknown>)['polluted'], undefined)
})

test('an MVU command naming a reserved segment is rejected and the rest of the batch applies', () => {
  // The path has to be one `_.has` answers **true** for, or MVU's own
  // "path does not exist" rule refuses it first and the guard is never
  // reached — which is exactly how the first draft of this test passed
  // without the guard. `_.has({a:{}}, 'a.__proto__')` is true, because
  // `Object.prototype` is there, and `_.set` at that path then writes it.
  const block = [
    '_.set(\'a.__proto__\', {"polluted": 1});',
    '_.set(\'好感度\', 5);',
  ].join('\n')
  const commands = extractCommands(block)
  const result = applyCommands(commands, { stat_data: { 好感度: 0, a: {} }, initialized_lorebooks: {} })

  assert.equal(result.failures.length, 1, 'exactly the bad command is rejected')
  // And rejected *for the right reason* — "walks through", not "does not exist".
  assert.match(result.failures[0]?.reason ?? '', /walks through "__proto__"/)
  assert.equal(result.data.stat_data['好感度'], 5, 'the rest of the batch still applies')
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'Object.prototype was written')
})

test('every store partitioned by a string from outside this process uses wireKeyedTable', async () => {
  // A source pin, because each of these is a property of a moment no test can
  // stand inside: the table is only wrong when the key is one of three names,
  // and a store that silently went back to `{}` would pass every behavioural
  // test in this package. The list is the one in DEVIATIONS §73; a store added
  // to that table and not to this array is the failure this catches.
  const here = dirname(fileURLToPath(import.meta.url))
  const partitioned = [
    'card-storage.ts', 'context.ts', 'script-variables.ts',
    'script-buttons.ts', 'materialise.ts', 'scripts.ts',
  ]
  for (const name of partitioned) {
    const source = await readFile(join(here, '..', 'src', name), 'utf8')
    // Two sites at least, and the count is what gives this teeth: every one of
    // these stores has both an **initializer** and a **restore**, and either
    // one left as a plain object reopens the finding on its own — a restore
    // most of all, since `JSON.parse` is where a `__proto__` key comes from.
    const uses = source.match(/wireKeyedTable\(/gu)?.length ?? 0
    assert.ok(uses >= 2, `${name} builds only ${String(uses)} of its tables through wireKeyedTable`)
  }
  assert.equal(partitioned.length, 6, 'the count is asserted so a shortened list cannot pass quietly')

  // And the one face whose refusal is about vocabulary rather than about the
  // write: `deletePath` already throws for this path, so removing the guard in
  // `service.ts` would still refuse — as a `ForbiddenKeyError` escaping onto
  // the wire instead of an `invalid-request`. Nothing observable distinguishes
  // them from inside this package, so the guard is pinned in source.
  const service = await readFile(join(here, '..', 'src', 'service.ts'), 'utf8')
  assert.match(
    service,
    /'script\.setVariables'[\s\S]{0,900}forbiddenSegmentIn\(path\)/,
    'the delete leg of script.setVariables must refuse a reserved path in its own vocabulary',
  )
})

test('card storage keyed by a card\'s own string stores a key instead of moving a prototype', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-keys-'))
  try {
    const store = new CardStorageStore(join(dir, 'card-storage.json'))
    // A card calling `localStorage.setItem('__proto__', …)`.
    await store.set('__proto__', 'polluted', { characterId: 'luoluo' })
    await store.set('ordinary', 'value', { characterId: 'luoluo' })

    const snapshot = await store.snapshot()
    assert.equal(snapshot['__proto__'], 'polluted', 'the key is stored as a key')
    assert.equal(snapshot['ordinary'], 'value')
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined)

    // And a key nobody wrote is absent rather than inherited: before the table
    // was null-prototyped this answered a `LastWriter`-shaped object built out
    // of `Object.prototype.constructor`.
    assert.equal(await store.lastWriter('constructor'), undefined)
    assert.equal(await store.lastWriter('toString'), undefined)
    assert.equal((await store.lastWriter('ordinary'))?.characterId, 'luoluo')

    // And the same thing coming back off disk, which is the half a live store
    // cannot show: `JSON.parse` creates `"__proto__"` as a real own key, so a
    // store that adopted the parsed object would take the value as its
    // prototype the moment the file was read.
    const file = join(dir, 'restored.json')
    await writeFile(file, '{"__proto__":{"value":"polluted"},"ordinary":{"value":"v","at":1}}', 'utf8')
    const restored = new CardStorageStore(file)
    const back = await restored.snapshot()
    assert.equal(back['ordinary'], 'v')
    assert.equal(await restored.lastWriter('constructor'), undefined, 'a restored table must inherit nothing')
    assert.equal(({} as Record<string, unknown>)['value'], undefined)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})
