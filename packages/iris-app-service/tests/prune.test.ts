import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import type { SillyTavernChatHeader, SillyTavernMessage } from '@iris/persistence'
import { importChat } from '@iris/persistence'
import { ChatEntry, chatLines } from '../src/entry.ts'
import { ChatStore } from '../src/chats.ts'
import { materialisingChatStore } from './support/materialising-store.ts'
import { CharacterLibrary } from '../src/library.ts'
import { DEFAULT_PRUNE, PRUNED_KEYS, planPrune, prunedKeysOf, SNAPSHOT_KEY } from '../src/prune.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Trimming old floors' variable tables.
 *
 * **The acceptance property is a growth curve, not a file size.** Measured on
 * the corpus: the 8.29 MiB of the longest chat is what SillyTavern's cleanup
 * *leaves* — 641 of its 683 layers are already stripped, and its bulk is 42
 * retained snapshots at ~201 KiB each. Pruning is why that number is 8.29 MiB
 * rather than the ~133 MiB 677 unpruned floors would cost. So the tests below
 * assert **O(N/interval) instead of O(N)**, and never that anything shrank.
 *
 * The second thing they pin is that this is a deletion feature with an
 * append-only log underneath it: a prune is a new event, the log still says what
 * happened, and a reader can find out later why a floor is empty.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
    character_book: {
      entries: [{
        keys: [], content: 'count: 0', comment: '[InitVar]', name: '[InitVar]',
        enabled: false, constant: false, insertion_order: 0, extensions: {},
      }],
    },
  },
})

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  settled: () => Promise<void>
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-prune-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  let turn = 0
  let ends = 0
  let waited = 0
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    turn += 1
    const text = `Reply ${String(turn)}. _.set('count', ${String(turn)});`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  return {
    handlers,
    chats,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/** Bytes of variables the exported chat file would carry. */
function variableBytes(file: { messages: { variables?: unknown }[] }): number {
  let bytes = 0
  for (const message of file.messages) {
    if (message.variables !== undefined) bytes += Buffer.byteLength(JSON.stringify(message.variables), 'utf8')
  }
  return bytes
}

test('the plan keeps snapshots, keeps the recent window, and prunes between', () => {
  // Indices, not turns: a reply sits on every other line, so turn N is at
  // index 2N + 1. Building the fixture the other way is how a turn-counted
  // implementation passes a test that means to catch it.
  const layers = Array.from({ length: 30 }, (_unused, turn) => ({
    turn,
    index: turn * 2 + 1,
    candidateSeq: turn * 10,
    variables: { stat_data: { count: turn }, schema: {}, event_chain: ['a'] },
  }))

  const plan = planPrune(layers, 59, { snapshotInterval: 10, keepRecent: 5 })
  const prunedTurns = plan.filter(decision => decision.removed !== undefined).map(decision => decision.turn)

  // Every reply sits at an odd index, and no odd number is a multiple of ten,
  // so on this fixture the interval keeps nothing at all. What keeps a layer
  // here is the recent window: index > 59 - 5, which is indices 55, 57 and 59,
  // i.e. turns 27, 28 and 29.
  //
  // That is what makes the fixture discriminating. A turn-counted rule keeps
  // turns 0, 10 and 20 — and an index-counted one prunes them. Asserting that
  // turn 0 survives would have passed against both.
  assert.equal(prunedTurns.includes(29), false, 'turn 29 (index 59) is inside the recent window')
  assert.equal(prunedTurns.includes(28), false, 'turn 28 (index 57) is inside the recent window')
  assert.ok(prunedTurns.includes(0), 'turn 0 sits at index 1, which is not on the interval')
  assert.ok(prunedTurns.includes(7) && prunedTurns.includes(13))

  // Five named keys, never the layer. A card's own key survives, because
  // deciding an unrecognised key is disposable decides for its author.
  const one = plan.find(decision => decision.turn === 7)
  assert.deepEqual(one?.removed, ['stat_data', 'schema'])
  assert.equal(
    (one?.removed ?? []).some(key => key === 'event_chain'),
    false,
    'a key belonging to the card was taken',
  )
})

test('a layer already marked as a snapshot is never pruned again', () => {
  const layers = [
    { turn: 3, index: 7, candidateSeq: 1, variables: { stat_data: {}, [SNAPSHOT_KEY]: true } },
    { turn: 4, index: 9, candidateSeq: 2, variables: { stat_data: {} } },
  ]
  const plan = planPrune(layers, 100, { snapshotInterval: 50, keepRecent: 5 })

  // Upstream marks interval floors as it keeps them, and its comment says why:
  // raising the interval from 50 to 70 later would make the effective spacing
  // their least common multiple, retroactively orphaning snapshots taken under
  // the old setting. The mark pins the decision that was current at the time.
  assert.equal(plan[0]?.removed, undefined, 'a marked snapshot was pruned')
  assert.match(plan[0]?.reason ?? '', /already marked/u)
  assert.notEqual(plan[1]?.removed, undefined)
})

test('a prune is appended, and the log can still explain the reading', async (t) => {
  const { handlers, chats, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  for (let index = 0; index < 6; index += 1) {
    await handlers['chat.send']({ chatId, text: `Message ${String(index)}.` })
    await settled()
  }

  const entry = await chats.open(chatId)
  const writtenBefore = entry.session.events.filter(event => event.type === 'iris/variables').length
  const reported: string[] = []
  const pruned = entry.prune({ snapshotInterval: 50, keepRecent: 2 }, message => { reported.push(message) })
  assert.ok(pruned > 0, 'nothing was pruned in a chat long enough to prune')

  // Appended, not rewritten. Every `iris/variables` event that existed still
  // does — the log's promise is that it never lies about what happened, and
  // per-candidate variables, swipe consistency and branching all rest on it.
  assert.equal(
    entry.session.events.filter(event => event.type === 'iris/variables').length >= writtenBefore,
    true,
    'a variables event was rewritten or removed',
  )
  const records = entry.session.events.filter(event => event.type === 'iris/variables-pruned')
  assert.equal(records.length, pruned)

  // And the record explains a reading afterwards: which turn, which keys, why.
  const first = records[0] as { data: { turn: number, removed: string[], reason: string } }
  assert.equal(typeof first.data.turn, 'number')
  assert.ok(first.data.removed.length > 0)
  assert.match(first.data.reason, /older than the newest 2/u)

  // The report says the thing a user has to know before it is too late.
  assert.ok(reported.length > 0)
  assert.match(reported[0] ?? '', /not reversible/u)
})

test('a pruned floor reads as empty rather than as an error', async (t) => {
  const { handlers, chats, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  for (let index = 0; index < 6; index += 1) {
    await handlers['chat.send']({ chatId, text: `Message ${String(index)}.` })
    await settled()
  }

  const entry = await chats.open(chatId)
  entry.prune({ snapshotInterval: 50, keepRecent: 2 })

  // Floor 2 is the first assistant reply, old enough to have been pruned.
  const { context } = await handlers['script.context']({ chatId, characterId: 'aria', messageId: 2 })
  const floor = context.floor?.variables ?? {}
  // Empty of the pruned keys, and not an error: a pruned floor and one that
  // never wrote anything are the same thing to a reader, which is the precedent
  // the floor anchor already set and what upstream's `?? {}` does.
  assert.equal('stat_data' in floor, false, 'a pruned floor still reports its state')

  // And the newest turn is untouched, so the conversation keeps working.
  const view = await handlers['chat.open']({ chatId })
  const newest = view.view.messages.length - 1
  const recent = await handlers['script.context']({ chatId, characterId: 'aria', messageId: newest })
  assert.equal('stat_data' in (recent.context.floor?.variables ?? {}), true, 'the recent window was pruned')
})

test('pruning turns linear growth into interval growth', async (t) => {
  const { handlers, chats, settled } = await fixture(t)

  /** Variable bytes after `turns` exchanges, pruned or not. */
  const measure = async (turns: number, prune: boolean): Promise<number> => {
    const created = await handlers['chat.create']({ characterId: 'aria' })
    const chatId = created.view.chatId
    for (let index = 0; index < turns; index += 1) {
      await handlers['chat.send']({ chatId, text: `Message ${String(index)}.` })
      await settled()
    }
    const entry = await chats.open(chatId)
    if (prune) entry.prune({ snapshotInterval: 5, keepRecent: 2 })
    return variableBytes(entry.toFile() as { messages: { variables?: unknown }[] })
  }

  const shortUnpruned = await measure(6, false)
  const shortPruned = await measure(6, true)
  const longUnpruned = await measure(18, false)
  const longPruned = await measure(18, true)

  // The claim is **not** that anything shrinks — on a chat pruned all along
  // nothing ever shrinks, it merely stops growing. The claim is that the pruned
  // curve rises more slowly than the unpruned one, and that the gap widens with
  // length. An acceptance test written as "the file got smaller" would fail
  // against a correct implementation, which is how the 8.29 MiB in the corpus
  // was nearly misread as a target rather than as the result.
  assert.ok(longUnpruned > shortUnpruned, 'the unpruned baseline did not grow; the fixture is not exercising it')
  assert.ok(longPruned < longUnpruned, `pruning saved nothing at 18 turns (${String(longPruned)} of ${String(longUnpruned)})`)

  const shortRatio = shortPruned / shortUnpruned
  const longRatio = longPruned / longUnpruned
  assert.ok(
    longRatio < shortRatio,
    `the saving did not widen with length: ${shortRatio.toFixed(2)} at 6 turns, ${longRatio.toFixed(2)} at 18`,
  )
})

test('pruning twice does not record the same removal twice', async (t) => {
  const { handlers, chats, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  for (let index = 0; index < 6; index += 1) {
    await handlers['chat.send']({ chatId, text: `Message ${String(index)}.` })
    await settled()
  }

  const entry = await chats.open(chatId)
  const first = entry.prune({ snapshotInterval: 50, keepRecent: 2 })
  const second = entry.prune({ snapshotInterval: 50, keepRecent: 2 })

  // The second pass has nothing to do, and says so by returning zero rather than
  // appending records for work that did not happen — a count that reported
  // phantom prunes would make the log's own explanation untrue.
  assert.ok(first > 0)
  assert.equal(second, 0, 'a second prune re-recorded layers it had already taken')
  assert.equal(prunedKeysOf(entry.session).size, first)
})

test('the defaults are upstream’s, and the measured install’s', () => {
  // 50 and 20 are `快照保留间隔` and `要保留变量的最近楼层数` — the schema
  // defaults in MagVarUpdate and the live values in the measured installation.
  // Written down so a later change is a decision rather than a drift.
  assert.deepEqual(DEFAULT_PRUNE, { snapshotInterval: 50, keepRecent: 20 })
})

test('a turn does not prune unless the host was told to', async (t) => {
  // The switch is presence, and off is the default for a stronger reason than
  // the template evaluator's: this removes state and nothing brings it back. A
  // feature that deletes a conversation's history is opted into by a decision,
  // never by a silence.
  const { handlers, chats, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  for (let index = 0; index < 6; index += 1) {
    await handlers['chat.send']({ chatId, text: `Message ${String(index)}.` })
    await settled()
  }

  const entry = await chats.open(chatId)
  assert.equal(
    entry.session.events.filter(event => event.type === 'iris/variables-pruned').length,
    0,
    'a host that was never configured to prune pruned anyway',
  )
})

test('a 677-message chat keeps exactly the snapshots SillyTavern kept', () => {
  // The shape of the corpus's longest chat: a reply on every even index, a user
  // row on every odd one, 677 lines. Synthetic rather than the file itself,
  // because the file has already been cleaned and cannot answer this — but the
  // set it must reproduce is the one measured on that file.
  const messages: SillyTavernMessage[] = Array.from({ length: 677 }, (_unused, index) => index % 2 === 1
    ? { name: 'Traveller', is_user: true, mes: 'u' }
    : {
        name: 'Aria',
        is_user: false,
        mes: 'a',
        swipes: ['a'],
        swipe_id: 0,
        // No `snapshot` mark: a marked layer is kept whatever the unit counts,
        // so seeding one would make this test agree with the implementation it
        // is supposed to discriminate against.
        variables: [{ stat_data: { n: index }, schema: {}, event_chain: ['x'] }],
      })
  const header: SillyTavernChatHeader = {
    user_name: 'Traveller',
    character_name: 'Aria',
    create_date: '2026-01-22 @04h13m05s',
    chat_metadata: {},
  }

  const session = importChat({ header, messages }, 'long')
  const entry = new ChatEntry({ chatId: 'long', header, session, card: undefined })
  const dropped: string[] = []
  entry.hydrateVariables(messages, message => dropped.push(message))
  assert.deepEqual(dropped, [], 'the fixture lost tables before the rule ever ran')

  entry.prune(DEFAULT_PRUNE)

  const survivors: number[] = []
  for (const [index, line] of chatLines(session).entries()) {
    if (line.isUser) continue
    if ('stat_data' in (entry.readFloorVariables(index).variables ?? {})) survivors.push(index)
  }

  // **The two-way discriminator.** Counting turns instead of messages puts a
  // snapshot every 100 messages, so this equality fails in both directions: a
  // turn-counted rule keeps too few here, and a rule with the window in the
  // wrong unit keeps too many at the end.
  assert.deepEqual(
    survivors.filter(index => index % 50 === 0),
    Array.from({ length: 14 }, (_unused, k) => k * 50),
    'the interval survivors are not the set SillyTavern left on the same chat',
  )

  // The tail is not compared by length: upstream's own trigger (`chat.length % 5`)
  // means the file's recent window is whatever it was when cleanup last ran, so
  // only the shape is pinned.
  const tail = survivors.filter(index => index % 50 !== 0)
  assert.ok(tail.length > 0, 'the recent window kept nothing')
  assert.equal(tail[tail.length - 1], 676, 'the recent window does not reach the newest reply')
  assert.ok(tail.every((index, k) => k === 0 || index - (tail[k - 1] ?? 0) === 2), 'the recent window has a hole')
})
