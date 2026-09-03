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
import { DEFAULT_PRUNE, IGNORE_CLEANUP_KEY, looksNeverCleaned, PRUNED_KEYS, planPrune, pruneDue, prunedKeysOf, SNAPSHOT_KEY } from '../src/prune.ts'
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
  // Indices, not turns, and a reply on every even line — the shape the corpus
  // actually has. Building the fixture around turns is how a turn-counted
  // implementation passes a test that means to catch it.
  const layers = Array.from({ length: 30 }, (_unused, turn) => ({
    turn,
    index: turn * 2,
    candidateSeq: turn * 10,
    variables: { stat_data: { count: turn }, schema: {}, event_chain: ['a'] },
  }))

  const plan = planPrune(layers, 59, { snapshotInterval: 10, keepRecent: 5 })
  const prunedIndices = plan.filter(decision => decision.removed !== undefined).map(decision => decision.turn * 2)

  // Three rules, and the fixture is built so each one owns a different stretch.
  // newestIndex 59, keepRecent 5: the edge is 54 and the window opens at
  // max(1, 54 - 2 - 10) = 42. So only replies 42..54 are examined at all.
  //
  // Below the window nothing is touched — **not protected, just never reached**,
  // which is what stops enabling cleanup from sweeping a long history.
  // Inside it, index 50 is on the ten-interval and is kept and marked; the rest go.
  // Above the edge the recent window keeps 56 and 58.
  assert.deepEqual(prunedIndices, [42, 44, 46, 48, 52, 54])

  // A turn-counted rule would keep turns 0, 10, 20 and 50 lands nowhere near its
  // interval, so this list fails in both directions.
  const reason = (index: number): string => plan.find(one => one.turn * 2 === index)?.reason ?? ''
  assert.match(reason(50), /snapshot interval, and marked/u, 'the interval snapshot inside the window was not kept')
  assert.match(reason(0), /below the cleanup window/u, 'the opening floor was reached by the scan')
  assert.match(reason(58), /within the newest 5 messages/u, 'the newest replies are not in the recent window')

  // Five named keys, never the layer. A card's own key survives, because
  // deciding an unrecognised key is disposable decides for its author.
  const one = plan.find(decision => decision.turn * 2 === 44)
  assert.deepEqual(one?.removed, ['stat_data', 'schema'])
  assert.equal(
    (one?.removed ?? []).some(key => key === 'event_chain'),
    false,
    'a key belonging to the card was taken',
  )
})

test('a layer already marked as a snapshot is never pruned again', () => {
  const layers = [
    // Inside the scan window for newestIndex 100 / keepRecent 5, which opens at
    // max(1, 95 - 2 - 10) = 83. Below it the scan never looks, and a layer kept
    // for that reason would say nothing about the mark.
    { turn: 42, index: 84, candidateSeq: 1, variables: { stat_data: {}, [SNAPSHOT_KEY]: true } },
    { turn: 43, index: 86, candidateSeq: 2, variables: { stat_data: {} } },
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

  // Thirteen lines, keepRecent 2: the edge is 10 and the window opens at
  // max(1, 10 - 2 - 4) = 4. Floor 6 is inside it. Floor 2 is not — and asking
  // about a floor the scan never reaches would test the bound, not the read.
  const { context } = await handlers['script.context']({ chatId, characterId: 'aria', messageId: 6 })
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
      // **As the chat grows, not once at the end.** The scan is a bounded window
      // near the recent edge, so a single pass over a finished chat cleans one
      // stretch and leaves the rest — the growth curve is what the window
      // sliding forward produces, and running it any other way measures a shape
      // the host never has.
      if (!prune) continue
      const live = await chats.open(chatId)
      if (pruneDue(chatLines(live.session).length)) live.prune({ snapshotInterval: 5, keepRecent: 2 })
    }
    const entry = await chats.open(chatId)
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

/** The corpus's longest chat, by shape: a reply on every even index, 677 lines. */
function longChat(): SillyTavernMessage[] {
  return Array.from({ length: 677 }, (_unused, index) => index % 2 === 1
    ? { name: 'Traveller', is_user: true, mes: 'u' }
    : {
        name: 'Aria',
        is_user: false,
        mes: 'a',
        swipes: ['a'],
        swipe_id: 0,
        // No `snapshot` mark: a marked layer is kept whatever the rule counts,
        // so seeding one would make these tests agree with the implementations
        // they exist to discriminate against.
        variables: [{ stat_data: { n: index }, schema: {}, event_chain: ['x'] }],
      })
}

const LONG_HEADER: SillyTavernChatHeader = {
  user_name: 'Traveller',
  character_name: 'Aria',
  create_date: '2026-01-22 @04h13m05s',
  chat_metadata: {},
}

test('the window, slid over a whole chat, lands where SillyTavern left its snapshots', () => {
  // **Not one global pass.** Upstream cleans a bounded window near the recent
  // edge and runs on `chat.length % 5`, so the disk state of a long chat is the
  // accumulated result of that window sliding forward as the conversation grew.
  // Simulating the growth is the only way to compare against a real file: a
  // single pass over a restored chat is a shape upstream never produces.
  const layers = []
  for (let index = 0; index < 677; index += 2) {
    layers.push({
      turn: index / 2,
      index,
      candidateSeq: index,
      variables: { stat_data: { n: index }, schema: {}, event_chain: ['x'] } as Record<string, unknown>,
    })
  }
  const pruned = new Set<number>()

  for (let length = 1; length <= 677; length += 1) {
    if (!pruneDue(length)) continue
    const newestIndex = length - 1
    const live = layers.filter(layer => layer.index <= newestIndex && !pruned.has(layer.candidateSeq))
    for (const decision of planPrune(live, newestIndex, DEFAULT_PRUNE)) {
      if (decision.removed !== undefined) { pruned.add(decision.candidateSeq); continue }
      // A kept-and-marked layer carries its mark forward, as upstream’s does —
      // without this the simulation re-decides each pass and the marks mean nothing.
      if (decision.reason.includes('and marked')) {
        const layer = layers.find(one => one.candidateSeq === decision.candidateSeq)
        if (layer !== undefined) layer.variables[SNAPSHOT_KEY] = true
      }
    }
  }

  const survivors = layers.filter(layer => !pruned.has(layer.candidateSeq)).map(layer => layer.index)
  assert.deepEqual(
    survivors.filter(index => index % 50 === 0),
    Array.from({ length: 14 }, (_unused, k) => k * 50),
    'the interval survivors are not the set SillyTavern left on the same chat',
  )
  const tail = survivors.filter(index => index % 50 !== 0)
  assert.equal(tail[tail.length - 1], 676, 'the recent window does not reach the newest reply')
  assert.ok(tail.every((index, k) => k === 0 || index - (tail[k - 1] ?? 0) === 2), 'the recent window has a hole')
})

test('switching cleanup on does not catch up on a chat that was never cleaned', () => {
  // The reason the window is bounded, stated as a test. Upstream never sweeps a
  // long history in one pass, so enabling this must not either: the first run
  // touches the window and nothing below it.
  const messages = longChat()
  const session = importChat({ header: LONG_HEADER, messages }, 'never-cleaned')
  const entry = new ChatEntry({ chatId: 'never-cleaned', header: LONG_HEADER, session, card: undefined })
  const dropped: string[] = []
  entry.hydrateVariables(messages, message => dropped.push(message))
  assert.deepEqual(dropped, [], 'the fixture lost tables before the rule ever ran')

  const removed = entry.prune(DEFAULT_PRUNE)

  // newestIndex 676, keepRecent 20: the edge is 656 and the window opens at
  // max(1, 656 - 2 - 40) = 614. Twenty-two replies sit in [614, 656]; 650 is on
  // the interval and is kept, so twenty-one go.
  assert.equal(removed, 21, 'the first run did not touch exactly the window')
  const intact = (index: number): boolean =>
    'stat_data' in (entry.readFloorVariables(index).variables ?? {})
  assert.ok(intact(0), 'the opening floor was swept')
  assert.ok(intact(300), 'a floor far below the window was swept')
  assert.ok(intact(612), 'a floor just below the window was swept')
  assert.equal(intact(614), false, 'the window opened later than upstream would')
  assert.ok(intact(650), 'the interval snapshot inside the window was not kept')
  assert.ok(intact(676), 'the newest reply was swept')
})

test('a chat upstream would offer to clean says so, once, and honours a refusal', () => {
  // Detection only. Upstream sweeps `[1, len - 1 - keep]` here — far more than the
  // periodic window — but only after asking, with a backup offered first. Doing
  // that sweep without the question is the one version that must not exist, so
  // what is pinned here is that we notice and say so rather than act.
  const messages = longChat()
  const session = importChat({ header: LONG_HEADER, messages }, 'legacy')
  const entry = new ChatEntry({ chatId: 'legacy', header: LONG_HEADER, session, card: undefined })
  entry.hydrateVariables(messages)

  const first = entry.legacyCleanupNote(DEFAULT_PRUNE)
  assert.match(first ?? '', /never been cleaned/u)
  assert.match(first ?? '', /nothing is swept/u)

  // Once per loaded chat: the condition stays true while we decline to act, so a
  // line every turn would be a notice that never changes.
  assert.equal(entry.legacyCleanupNote(DEFAULT_PRUNE), undefined, 'the notice repeated itself')
})

test('the gates upstream uses, each one load-bearing', () => {
  const table = (): Record<string, unknown> => ({ stat_data: { n: 1 }, schema: {} })

  assert.equal(looksNeverCleaned(table(), 677, DEFAULT_PRUNE), true)

  // Too short: upstream requires more than `keepRecent + 5` lines before it asks.
  assert.equal(looksNeverCleaned(table(), DEFAULT_PRUNE.keepRecent + 5, DEFAULT_PRUNE), false)

  // Already swept: no `stat_data` on the first floor is what a cleaned chat looks
  // like, and it is the gate that stops the offer being made twice.
  assert.equal(looksNeverCleaned({ event_chain: [] }, 677, DEFAULT_PRUNE), false)

  // Refused before. **Upstream's key name, not one of ours** — a chat carried
  // between the two hosts has to keep the answer its owner already gave.
  assert.equal(
    looksNeverCleaned({ ...table(), [IGNORE_CLEANUP_KEY]: true }, 677, DEFAULT_PRUNE),
    false,
    'a recorded refusal was ignored',
  )
  assert.equal(IGNORE_CLEANUP_KEY, 'ignore_cleanup')
})
