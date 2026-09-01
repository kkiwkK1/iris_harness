import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CharacterCard } from '@iris/character'
import type { Op } from '@iris/compat-prompt-template'
import type { SillyTavernChatHeader } from '@iris/persistence'

import { seedGreeting } from '../src/chats.ts'
import { ChatEntry, createSession } from '../src/entry.ts'
import { CHAT_LAYER_ALARM_BYTES, variableLayersOf } from '../src/context.ts'
import { applyOps, buildSnapshot, scalarsOf, worldInfoOf, writePath } from '../src/template.ts'

/**
 * The host half of the EJS evaluator's seam.
 *
 * Every property tested here fails *silently* when it is wrong — a template
 * that reads the wrong book, a merge that changes which `stat_data` a card
 * sees, a write that lands in the wrong scope. None of them throws, and none of
 * them is visible in one generation, which is why they are pinned rather than
 * trusted.
 */

/** A card with a book, for the world-info half. */
function card(overrides: Partial<CharacterCard['data']> = {}): CharacterCard {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '络络',
      description: '', personality: '', scenario: '',
      first_mes: 'Hello, {{user}}.', mes_example: '', creator_notes: '',
      system_prompt: '', post_history_instructions: '', alternate_greetings: [],
      tags: [], creator: '', character_version: '1', extensions: {},
      ...overrides,
    },
  }
}

/** An open conversation on a card. */
function entryFor(built: CharacterCard = card()): ChatEntry {
  const header: SillyTavernChatHeader = {
    user_name: '旅人',
    character_name: built.data.name,
    create_date: '2026-09-01 @10h00m00s',
    chat_metadata: {},
    iris: { chatId: 'c1', characterId: 'luoluo', title: built.data.name, updatedAt: 0 },
  }
  const entry = new ChatEntry({ chatId: 'c1', header, session: createSession('c1'), card: built })
  seedGreeting(entry, built, { user: '旅人', char: built.data.name })
  return entry
}

const BOOK = {
  extensions: {},
  entries: [
    { keys: ['a'], content: '{{char}} keeps the ledger.', enabled: true, insertion_order: 100, extensions: {}, comment: '账本' },
    { keys: ['b'], content: 'Switched off by the author.', enabled: false, insertion_order: 100, extensions: {}, comment: '弃用' },
  ],
}

test('world info goes over whole, enabled only, with macros already run', () => {
  const entries = worldInfoOf(card({ character_book: BOOK }), text => text.replaceAll('{{char}}', '络络'))

  // Not pre-filtered to what looks reachable: four corpus call sites build the
  // name at runtime, one of them as a regex, so filtering loses them silently.
  assert.equal(entries.length, 1, 'the disabled entry is not pushed')
  assert.equal(entries[0]?.comment, '账本', 'comment is the title, which is what getwi matches on')
  // Macros are the host's job and must already be done: a card writing
  // `<%_ if ({{roll 1d100}} …) _%>` hands the evaluator JavaScript it generated.
  assert.equal(entries[0]?.content, '络络 keeps the ledger.')
  assert.equal(entries[0]?.world, '络络')
  assert.equal(entries[0]?.uid, '0')
})

test('the four scopes go over unmerged', () => {
  const entry = entryFor()
  entry.variables.replaceVariables({ stat_data: { from: 'chat' } }, { type: 'chat' })
  entry.variables.replaceVariables({ stat_data: { from: 'message' } }, { type: 'message', message_id: 0 })

  const snapshot = buildSnapshot(entry, 0, 7)

  // The evaluator recomputes upstream's merge itself, because
  // `getvar(key, 'global')` has to see past it. Merging here — especially
  // deeply — would change what a card reads with nothing to show for it.
  assert.deepEqual(snapshot.variables.local, { stat_data: { from: 'chat' } })
  assert.deepEqual(snapshot.variables.message, { stat_data: { from: 'message' } })
  assert.deepEqual(snapshot.variables.global, {})
  assert.equal(snapshot.traceId, 7)
})

test('a scope with nothing to read is empty rather than an error', () => {
  const entry = entryFor()
  // Turn 5 has no candidate to hang message variables on. The template should
  // find nothing there, not fail to get a snapshot at all.
  const snapshot = buildSnapshot(entry, 5, 1)
  assert.deepEqual(snapshot.variables.message, {})
})

test('the scalars upstream exposes are all present', () => {
  const entry = entryFor()
  const scalars = scalarsOf(entry)

  // An absent name is not `undefined` in a template — it is an unresolved
  // identifier, so the item throws. Filling them is cheap insurance.
  for (const name of [
    'charName', 'assistantName', 'userName', 'chatId', 'characterId',
    'lastUserMessage', 'lastCharMessage', 'lastMessageId', 'model',
  ]) {
    assert.ok(name in scalars, `${name} is missing`)
  }
  assert.equal(scalars['charName'], '络络')
  // Upstream's own equality: both are `name2`.
  assert.equal(scalars['assistantName'], scalars['charName'])
  assert.equal(scalars['userName'], '旅人')
  assert.equal(scalars['lastCharMessage'], 'Hello, 旅人.')
})

test('a described write is applied through the host’s own guard', () => {
  const entry = entryFor()
  const ops: Op[] = [
    { op: 'setvar', scope: 'local', key: 'stat_data.银麒系统.账户.银麒点', value: 12 },
    { op: 'setvar', scope: 'local', key: 'flags.seen', value: true },
  ]

  assert.equal(applyOps(entry, ops, 0), 2)

  const stored = entry.variables.getVariables({ type: 'chat' })
  assert.deepEqual(stored['stat_data'], { 银麒系统: { 账户: { 银麒点: 12 } } })
  assert.deepEqual(stored['flags'], { seen: true })
})

test('a write the store could not hold is refused, not stored', () => {
  const entry = entryFor()
  // The guard is the reason writes are described rather than applied: a
  // template must not be able to put something in a store the host would have
  // refused at its own door.
  assert.throws(
    () => applyOps(entry, [{ op: 'setvar', scope: 'local', key: 'x', value: Number.POSITIVE_INFINITY as never }], 0),
    /cannot be stored/,
  )
})

test('the default write scope is message, and initial is not writable', () => {
  const entry = entryFor()

  // Upstream's asymmetry: the read default is not the write default. A batch
  // that names `message` writes to the turn being generated.
  assert.equal(applyOps(entry, [{ op: 'setvar', scope: 'message', key: 'mood', value: 'calm' }], 0), 1)
  assert.equal((entry.variables.getVariables({ type: 'message', message_id: 0 }))['mood'], 'calm')

  // `initial` is the card's shipped baseline — what a reset resets to. Writing
  // into it would edit the thing being reset to.
  assert.equal(applyOps(entry, [{ op: 'setvar', scope: 'initial', key: 'x', value: 1 }], 0), 0)
})

test('insvar appends or inserts, and saveMetadata replaces the object', () => {
  const entry = entryFor()
  applyOps(entry, [
    { op: 'insvar', scope: 'local', key: 'log', value: 'first' },
    { op: 'insvar', scope: 'local', key: 'log', value: 'second' },
    { op: 'insvar', scope: 'local', key: 'log', value: 'zeroth', index: 0 },
  ], 0)

  assert.deepEqual(entry.variables.getVariables({ type: 'chat' })['log'], ['zeroth', 'first', 'second'])

  applyOps(entry, [{ op: 'saveMetadata', value: { yinqi_phone: { unread: 1 } } }], 0)
  assert.deepEqual(entry.header.chat_metadata, { yinqi_phone: { unread: 1 } })
})

test('delvar removes a path without disturbing its neighbours', () => {
  const entry = entryFor()
  applyOps(entry, [
    { op: 'setvar', scope: 'local', key: 'a.b', value: 1 },
    { op: 'setvar', scope: 'local', key: 'a.c', value: 2 },
    { op: 'delvar', scope: 'local', key: 'a.b' },
  ], 0)

  assert.deepEqual(entry.variables.getVariables({ type: 'chat' })['a'], { c: 2 })
})

test('a path write creates what is missing, the way lodash does', () => {
  // `_.set` invents the path; MVU's refusal to do so is MVU's own rule, not this
  // engine's, and a template author writing lodash paths expects lodash.
  assert.deepEqual(writePath({}, 'a.b.c', 1), { a: { b: { c: 1 } } })
  // A numeric segment makes an array, so `a.0` is an index and not a key.
  assert.deepEqual(writePath({}, 'a.0', 'x'), { a: ['x'] })
  // The input is not mutated: the store hands out detached tables and writing
  // through one would reach back into something we do not own.
  const before = { a: { b: 1 } }
  const after = writePath(before, 'a.c', 2)
  assert.deepEqual(before, { a: { b: 1 } })
  assert.deepEqual(after, { a: { b: 1, c: 2 } })
})

test('the lorebook fallback chain carries the card’s own book', () => {
  const bound = card({ extensions: { world: '命定之诗世界书' } })
  const entry = entryFor(bound)
  entry.header.chat_metadata['world_info'] = '本聊天的书'

  const snapshot = buildSnapshot(entry, 0, 1)

  // Upstream takes ONE book from `name || character || persona || chat`, never a
  // union — and a chain that runs out means "search nothing", so every `getwi`
  // would quietly return an empty string.
  assert.equal(snapshot.lorebooks.character, '命定之诗世界书')
  assert.equal(snapshot.lorebooks.chat, '本聊天的书')
  // No persona store exists yet, so the link is absent rather than invented.
  assert.equal(snapshot.lorebooks.persona, undefined)
})

test('a card with no bound book leaves the link out rather than empty', () => {
  const snapshot = buildSnapshot(entryFor(), 0, 1)
  assert.equal(snapshot.lorebooks.character, undefined)
  assert.deepEqual(snapshot.lorebooks, {})
})

test('a write into a scope with no store is reported, not dropped in silence', () => {
  // `optionFor`'s note explains why `initial` should never arrive — the
  // evaluator refuses it by name — and that note is correct. It also covered
  // only the case it was written about: if one ever does arrive, the `continue`
  // beneath it left no trace, and a template write that vanishes is exactly the
  // failure this module exists to prevent.
  //
  // A correct comment guarding an incomplete branch is harder to find than a
  // wrong one, because a reader agrees with it and moves on.
  const entry = entryFor()
  const dropped: string[] = []
  const applied = applyOps(entry, [{ op: 'setvar', scope: 'initial', key: 'a', value: 2 }], 0, reason => {
    dropped.push(reason)
  })

  assert.equal(applied, 0, 'the write was applied to a scope that does not exist')
  assert.equal(dropped.length, 1, 'the write vanished without a word')
  assert.match(dropped[0] ?? '', /"initial" scope, which Iris has no store for/u)

  // And a scope that does exist is still applied, with nothing reported.
  const quiet: string[] = []
  assert.equal(
    applyOps(entry, [{ op: 'setvar', scope: 'global', key: 'a', value: 2 }], 0, reason => { quiet.push(reason) }),
    1,
  )
  assert.deepEqual(quiet, [])
})

test('an oversized chat layer is reported, and nothing is withheld', () => {
  // A growth alarm, not a limit. The layer is pushed whole because upstream's
  // frame reads it whole; a host quietly sending less would answer a card's
  // question wrongly, which is worse than a large payload.
  //
  // The line exists because the ruling that made this path safe assumed all four
  // layers were small and bounded, and one is neither: `chat_metadata.variables`
  // reaches 1.25 MiB in the corpus — more than every "latest floor" table in
  // every chat combined — and grows with play rather than with the conversation.
  const entry = entryFor()
  const reported: string[] = []

  const small = variableLayersOf(entry, (message: string) => { reported.push(message) })
  assert.equal(reported.length, 0, 'an ordinary chat layer raised the alarm')
  assert.equal(typeof small.chat, 'object')

  entry.variables.replaceVariables({ padding: 'x'.repeat(CHAT_LAYER_ALARM_BYTES) }, { type: 'chat' })
  const large = variableLayersOf(entry, (message: string) => { reported.push(message) })

  assert.equal(reported.length, 1, 'the growth line did not report')
  assert.match(reported[0] ?? '', /chat variable layer is \d+ bytes/u)
  assert.match(reported[0] ?? '', /growth alarm, not a limit/u)
  // The payload is intact: the alarm reports, it does not trim.
  assert.equal((large.chat as { padding?: string }).padding?.length, CHAT_LAYER_ALARM_BYTES)
})
