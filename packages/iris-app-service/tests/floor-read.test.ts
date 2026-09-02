import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { materialisingChatStore } from './support/materialising-store.ts'
import type { ChatEntry } from '../src/entry.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Reading a floor whose table was pruned, and knowing which kind of answer you got.
 *
 * `floorVariables` answers with a table. For a pruned floor that table is `{}`,
 * which is correct and **indistinguishable from a floor that never held
 * variables** — the reader cannot tell "deleted" from "never there".
 * `readFloorVariables` carries that distinction in an `origin` field.
 *
 * **Why replay is opt-in, and why the label is not decoration.** Replaying one
 * floor forward from the previous floor's stored table reproduces `stat_data` in
 * 93 of 121 adjacent full-floor corpus pairs — 77%. The other 23% return a value
 * that differs from what was stored, and nothing about the returned table says
 * so. Folding is deterministic (checked three ways: same-process, 971 corpus
 * folding floors, and two independent processes byte-comparing per-chat
 * hashes) — which does not rescue it, because it deterministically returns the
 * same wrong value. Add ~108 ms of synchronous CPU per snapshot interval and the
 * default is settled.
 *
 * The fixture's replies carry `_.set('count', N)` where N is the turn, so a
 * correct replay of floor N must say `count: N`. That is chosen so the nearest
 * wrong implementations all disagree: returning the newest state gives the last
 * turn's count, returning the seed gives the snapshot's, and returning nothing
 * gives no count at all.
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

/** A chat driven far enough to have prunable floors, already pruned. */
async function pruned(t: TestContext, turns: number): Promise<{ entry: ChatEntry, newest: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-floorread-'))
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

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  for (let index = 0; index < turns; index += 1) {
    await handlers['chat.send']({ chatId, text: `Message ${String(index)}.` })
    waited += 1
    while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
  }

  const entry = await chats.open(chatId)
  const removed = entry.prune({ snapshotInterval: 50, keepRecent: 2 })
  assert.ok(removed > 0, 'the fixture pruned nothing, so nothing below is being tested')
  return { entry, newest: entry.lastTurn }
}

/** The first assistant line, old enough to have been pruned. */
const PRUNED_LINE = 2

test('an intact floor reads as stored, and says so', async (t) => {
  const { entry, newest } = await pruned(t, 6)

  // The newest line is inside the keepRecent window, so nothing was taken.
  const newestLine = entry.toFile().messages.length - 1
  const read = entry.readFloorVariables(newestLine)

  assert.equal(read.origin, 'stored')
  assert.equal(read.note, 'as stored')
  assert.equal(read.replayedFrom, undefined, 'an untouched floor claimed to be a replay')
  assert.ok(newest > 0)
})

test('a pruned floor is refused by name, not answered with an empty table', async (t) => {
  const { entry } = await pruned(t, 6)

  const read = entry.readFloorVariables(PRUNED_LINE)

  // The distinction the whole surface exists for. `variables` is still empty —
  // that part matches upstream and is deliberate — but the reader can now tell
  // this apart from a floor that never held anything.
  assert.equal(read.origin, 'pruned')
  assert.equal('stat_data' in read.variables, false, 'a pruned floor reported its state')
  assert.match(read.note, /was pruned/u)
  assert.match(read.note, /stat_data/u, 'the refusal does not say which keys went')
  assert.match(read.note, /nearest intact turn/u, 'the refusal does not say where to start from')
})

test('replay is off by default — the same floor answers differently only when asked', async (t) => {
  const { entry } = await pruned(t, 6)

  const silent = entry.readFloorVariables(PRUNED_LINE)
  const asked = entry.readFloorVariables(PRUNED_LINE, { replay: true })

  // Two calls, one floor, two origins. If the default ever flips, this is what
  // says so — a caller that never asked for a recomputed value must not be
  // handed one.
  assert.equal(silent.origin, 'pruned')
  assert.equal(asked.origin, 'replayed')
})

test('a replayed floor carries its own turn’s value, not the newest and not the seed', async (t) => {
  const { entry } = await pruned(t, 6)

  const asked = entry.readFloorVariables(PRUNED_LINE, { replay: true })
  const stat = (asked.variables as { stat_data?: Record<string, unknown> }).stat_data ?? {}

  // Floor 2 is turn 1's reply, which set count to 1. The three nearest wrong
  // implementations each give a different answer here: the newest state says 6,
  // the seed says 0, and no replay at all says nothing.
  assert.equal(stat['count'], 1, `replay returned ${JSON.stringify(stat['count'])} instead of turn 1's value`)
  assert.equal(asked.replayedFrom, 0, 'the replay did not start from the surviving floor')
  assert.equal(asked.replayedFloors, 1)
})

test('a replayed answer never claims to be the stored one', async (t) => {
  const { entry } = await pruned(t, 6)

  const asked = entry.readFloorVariables(PRUNED_LINE, { replay: true })

  // The label is load-bearing: a recomputed table and a recorded one are the
  // same shape, and on the corpus they disagree about a quarter of the time.
  // A reader that cannot distinguish them will treat 77% as 100%.
  assert.equal(asked.origin, 'replayed')
  assert.match(asked.note, /recomputed/u)
  assert.match(asked.note, /may differ from the one stored/u)
  assert.notEqual(asked.origin, 'stored')
})

test('asking for a line that is not a floor is not a replay', async (t) => {
  const { entry } = await pruned(t, 6)

  // The empty case, which is the one that hides: an out-of-range index must not
  // fall through into "replay from wherever" and answer with a state that
  // belongs to some other floor.
  const read = entry.readFloorVariables(9999, { replay: true })
  assert.deepEqual(read.variables, {})
  assert.equal(read.origin, 'stored')
  assert.match(read.note, /no floor at line 9999/u)
})
