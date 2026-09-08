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
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { readSideUsage, SIDE_USAGE_FIELD } from '../src/side-usage.ts'
import { textOf } from '../src/views.ts'

/**
 * `script.generate`: a real assembly that is not a turn.
 *
 * Upstream has two generate functions and the difference is load-bearing.
 * `TavernHelper.generate` assembles the preset, the world info and the history;
 * `generateRaw` sends only what it is handed. A card asking for the first and
 * served by the second **succeeds** — it just answers without persona, lorebook
 * or conversation, which is the kind of wrongness nothing downstream reports.
 *
 * The second property is subtler and is where a real turn's machinery leaks:
 * assembling advances world-info timed effects and records an itemization. Both
 * belong to turns. A card-initiated generation that stored either would change
 * what the conversation does next — a sticky entry aged out by a script, or the
 * account of the user's own turn overwritten — from a call that never appears in
 * the chat. That is the same shape as a preview that writes, hidden one level
 * deeper.
 */

/** A card with a constant world-info entry, so an assembly has something to time. */
const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'A retired cartographer.',
    personality: 'Precise.',
    scenario: '', first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '1', extensions: {},
    character_book: {
      entries: [{
        keys: [], content: 'The maps are kept in the west tower.',
        enabled: true, constant: true, insertion_order: 0,
        extensions: { position: 4, depth: 0, role: 0, sticky: 3 },
      }],
    },
  },
})

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  seen: GenerateOptions[]
  settled: () => Promise<void>
}

async function fixture(t: TestContext, reply = 'A reply.'): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-side-generate-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const seen: GenerateOptions[] = []
  let ends = 0
  let waited = 0
  const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    // Every request reports what it cost, because every real one does — and
    // because a fixture whose provider says nothing cannot tell "the card's
    // spend is recorded" apart from "nothing was reported to record". The three
    // buckets differ from each other so a swapped read shows up as a wrong
    // number rather than as a coincidence.
    yield { type: 'usage', usage: { inputTokens: 320, outputTokens: 48, cacheReadTokens: 90 } }
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
    seen,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/** Everything the provider was handed, as one string. */
function sent(options: GenerateOptions | undefined): string {
  if (options === undefined) return ''
  return [
    ...options.system === undefined ? [] : [options.system],
    ...options.messages.map(message => textOf(message)),
  ].join('\n')
}

test('it assembles the way a turn does, with the card’s input last', async (t) => {
  const { handlers, seen } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })

  const { text } = await handlers['script.generate']({
    chatId: created.view.chatId,
    userInput: 'Where are the maps?',
  })
  assert.equal(text, 'A reply.')

  const prompt = sent(seen[0])
  // The three things `generateRaw` would not have included. A card served by
  // `generateRaw` instead of this would get an answer with none of them, and
  // would be told it succeeded.
  assert.match(prompt, /retired cartographer/u, 'the persona was not assembled')
  assert.match(prompt, /west tower/u, 'the world info was not assembled')
  assert.match(prompt, /Hello\./u, 'the history was not assembled')
  // And the card's own input is there, after the conversation.
  assert.match(prompt, /Where are the maps\?/u)
  const texts = (seen[0]?.messages ?? []).map(message => textOf(message))
  assert.ok(
    texts.indexOf('Where are the maps?') > texts.indexOf('Hello.'),
    'the card input was placed before the history',
  )
  // **Not** the last message, and that is upstream's behaviour rather than a
  // defect: a world-info entry at depth 0 is injected *after* the newest
  // message, so the final element here is the lorebook entry. Asserting "last"
  // is the intuitive test and it fails against a correct assembly.
  assert.equal(texts.at(-1), 'The maps are kept in the west tower.')
})

test('nothing about the conversation changes except what it cost', async (t) => {
  const { handlers, chats } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // A real turn first, so there is state worth not disturbing.
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  const entry = await chats.open(chatId)
  while (entry.generating) await new Promise(resolve => setTimeout(resolve, 1))

  const before = {
    timedEffects: JSON.stringify(entry.timedEffects ?? null),
    itemizations: JSON.stringify([...entry.itemizations.entries()]),
    messages: JSON.stringify(entry.toView().messages),
    lines: JSON.stringify(entry.toFile().messages),
  }
  const beforeHeader = { ...entry.toFile().header }
  delete beforeHeader[SIDE_USAGE_FIELD]

  await handlers['script.generate']({ chatId, userInput: 'A side question.' })

  // The log is the obvious one. The other two are the ones that leak: assembling
  // advances the world-info sticky and cooldown windows and records the turn's
  // itemization, and both belong to turns. A script aging out a sticky entry
  // would surface much later as world info that stopped appearing, with nothing
  // connecting it to the call that did it.
  assert.equal(JSON.stringify(entry.timedEffects ?? null), before.timedEffects, 'the timed effects advanced')
  assert.equal(JSON.stringify([...entry.itemizations.entries()]), before.itemizations, 'an itemization was overwritten')
  assert.equal(JSON.stringify(entry.toView().messages), before.messages, 'the conversation changed')

  /*
   * **The one change, named.** This assertion used to be `toFile()` whole
   * against `toFile()` whole, which is now false: the card's request was billed
   * and the bill is stored. Split rather than relaxed, because "the file did
   * not change" and "the file changed only here" are different claims and only
   * the second one is true — a blanket comparison against the whole file would
   * have to be deleted, and deleting it would stop watching the message lines,
   * which is where a record must never land (`side-usage.ts` says why: the
   * per-message array is parallel to `swipes`, so an entry with no swipe behind
   * it shifts every real record after it).
   */
  const after = entry.toFile()
  assert.equal(JSON.stringify(after.messages), before.lines, 'a card generation wrote onto a message line')
  const afterHeader = { ...after.header }
  const stored = afterHeader[SIDE_USAGE_FIELD]
  delete afterHeader[SIDE_USAGE_FIELD]
  assert.deepEqual(afterHeader, beforeHeader, 'a card generation changed the header beyond its own record')
  assert.ok(Array.isArray(stored) && stored.length === 1, 'the card generation left no record on the header')
})

test('maxHistory counts from the recent end', async (t) => {
  const { handlers, seen, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['chat.send']({ chatId, text: 'First question.' })
  await settled()
  await handlers['chat.send']({ chatId, text: 'Second question.' })
  await settled()

  seen.length = 0
  await handlers['script.generate']({ chatId, userInput: 'Now.', maxHistory: 1 })
  const prompt = sent(seen[0])

  // A card asking for one wants the *last* one. Slicing from the front would
  // hand it the oldest exchange, which is both wrong and plausible-looking.
  assert.equal(prompt.includes('First question.'), false, 'the oldest history was kept instead of the newest')
  assert.match(prompt, /Now\./u)
})

test('a system prompt from the card replaces the assembled one', async (t) => {
  const { handlers, seen } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })

  await handlers['script.generate']({
    chatId: created.view.chatId,
    userInput: 'Hi.',
    systemPrompt: 'You are a compass.',
  })
  assert.equal(seen[0]?.system, 'You are a compass.')
  // Replaced, not appended: two system slots would be a shape no provider agrees
  // on, and the card asked for one.
  assert.equal(sent(seen[0]).includes('retired cartographer'), false)
})

test('a script rewrites a floor through the same path a user edit takes', async (t) => {
  const { handlers, chats } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  const entry = await chats.open(chatId)
  while (entry.generating) await new Promise(resolve => setTimeout(resolve, 1))

  const before = (await handlers['chat.open']({ chatId })).view.messages[2]?.text ?? ''
  await handlers['script.setChatMessages']({
    chatId,
    messages: [{ messageId: 2, message: `${before}\n\n<StatusPlaceHolderImpl/>` }],
    refresh: 'none',
  })

  // Upstream's generation-time path: `update_variables.ts:1563` appends a status
  // placeholder to the reply that just arrived. A card that cannot do this
  // cannot render a status panel.
  const after = (await handlers['chat.open']({ chatId })).view.messages[2]?.text ?? ''
  assert.match(after, /StatusPlaceHolderImpl/u)

  // And it went through the swipe list, not only `mes`. A floor's text lives in
  // its swipes and `mes` merely points at one; an edit that misses the list is
  // undone by the next swipe back and forth — which looks like a swipe eating an
  // edit rather than like a missing line of code.
  const file = entry.toFile().messages[2] as { mes: string, swipes?: string[], swipe_id?: number }
  assert.equal(file.swipes?.[file.swipe_id ?? 0], after, 'the swipe list still holds the old text')
})

test('a batch that names a missing floor writes nothing at all', async (t) => {
  const { handlers, chats } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  const entry = await chats.open(chatId)
  while (entry.generating) await new Promise(resolve => setTimeout(resolve, 1))

  const before = JSON.stringify((await handlers['chat.open']({ chatId })).view.messages)
  await assert.rejects(
    () => handlers['script.setChatMessages']({
      chatId,
      messages: [{ messageId: 0, message: 'rewritten' }, { messageId: 99, message: 'nowhere' }],
    }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )

  // All ids are checked before any is written. A batch that rewrote the first
  // floor and then refused the second would leave the conversation half-edited,
  // with nothing recording which half.
  assert.equal(
    JSON.stringify((await handlers['chat.open']({ chatId })).view.messages),
    before,
    'a refused batch left part of its edits behind',
  )
})

/*
 * ------------------------------------------------ what a card's generation cost
 *
 * The gap this section closes: both card generations reach `#stream` with no
 * `entry`, and `noteUsage` / `notePromptFingerprint` / `noteRoute` all hang off
 * `entry.pending.turn` — so a request the provider billed was recorded nowhere
 * at all. On MVU that is one request per turn, which made a conversation's
 * running total and the whole usage page claims about a population narrower
 * than the user's own bill (`CACHE-TARGET.md` §4.5).
 */

test('a card generation records what it cost, on the conversation', async (t) => {
  const { handlers, chats } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  const before = Date.now()
  await handlers['script.generate']({ chatId, userInput: 'A side question.' })
  const after = Date.now()

  const entry = await chats.open(chatId)
  const records = readSideUsage(entry.header)
  assert.equal(records.length, 1, 'the card generation left no record')
  const record = records[0]
  assert.ok(record !== undefined)

  // The buckets, exactly as the provider reported them.
  assert.equal(record.usage.inputTokens, 320)
  assert.equal(record.usage.outputTokens, 48)
  assert.equal(record.usage.cacheReadTokens, 90)
  // The route, taken from the request the fingerprint was taken from.
  assert.equal(record.usage.model, 'test-model')
  assert.equal(record.usage.provider, 'test')
  /*
   * The moment, and it is the **request's**. Bounded by the call rather than
   * compared against a constant, so neither a slow machine nor a timezone can
   * make this pass or fail for a reason that has nothing to do with the record.
   */
  assert.ok(
    (record.usage.at ?? 0) >= before && (record.usage.at ?? 0) <= after,
    `the record is stamped ${String(record.usage.at)}, outside the call's own window`,
  )
  // The source, which is what a summary splits on.
  assert.equal(record.usage.source, 'script')
  /*
   * The caller: the RPC method name, because the contract carries no script id
   * to record — `script.generate` sends `chatId`, `userInput`, `systemPrompt`
   * and `maxHistory`, and upstream's `TavernHelper.generate` sends no script
   * identity either, so a card could not supply one if it wanted to.
   */
  assert.equal(record.caller, 'script.generate')
  // And the fingerprint, so "did this request read the cache, and was it the
  // same prefix as last time" is answerable from the stored record rather than
  // only from a trace that rotates after eight.
  assert.equal(typeof record.fingerprint?.promptHash, 'string')
  assert.equal(typeof record.fingerprint?.prefixHash, 'string')
})

test('generateRaw is recorded under its own caller', async (t) => {
  const { handlers, chats } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['script.generateRaw']({ chatId, prompt: 'Classify this.' })

  const entry = await chats.open(chatId)
  const records = readSideUsage(entry.header)
  assert.equal(records.length, 1)
  /*
   * The two callers are stored apart because they are different requests: this
   * one sends only what the card handed it, while `script.generate` re-sends
   * the conversation's whole prefix. A reader asking why a card is expensive is
   * asking exactly which of the two it fires, and one merged label answers with
   * the sum.
   */
  assert.equal(records[0]?.caller, 'script.generateRaw')
})

test('the records accumulate, and reach disk', async (t) => {
  const { handlers, chats } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['script.generate']({ chatId, userInput: 'First.' })
  await handlers['script.generateRaw']({ chatId, prompt: 'Second.' })
  await handlers['script.generate']({ chatId, userInput: 'Third.' })

  /*
   * Read back through the **file** rather than off the live entry.
   * `usageSummary` re-reads every chat file from disk, so this is what proves
   * the point of putting the array on the header instead of in `chat_metadata`
   * or on a message: it survives being written out and read in. Asserting on
   * the live object would prove none of that.
   */
  const summary = await chats.usageSummary()
  const row = summary.chats.find(one => one.chatId === chatId)
  assert.ok(row !== undefined, 'the conversation is absent from the summary that scanned its file')
  assert.equal(row.turns, 3, 'the summary did not count all three card generations')
  assert.equal(row.script?.turns, 3, 'the card share does not cover all three')
  // Every generation here is a card's, so the share is the whole row — which is
  // the state a conversation used to render as "cost nothing at all".
  assert.equal(row.script?.cacheMiss, row.cacheMiss)
  assert.equal(row.script?.output, row.output)
  assert.equal(row.cacheMiss, 3 * 320)
  assert.equal(row.output, 3 * 48)
  assert.equal(row.cacheRead, 3 * 90)
})

test('the conversation’s own total carries the card’s share, and names it', async (t) => {
  const { handlers, chats } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // One real turn, then one card generation, so both populations are non-empty
  // and of different sizes.
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  const entry = await chats.open(chatId)
  while (entry.generating) await new Promise(resolve => setTimeout(resolve, 1))
  await handlers['script.generate']({ chatId, userInput: 'A side question.' })

  const view = (await handlers['chat.open']({ chatId })).view
  assert.ok(view.usage !== undefined, 'the conversation reports no total')
  /*
   * **Inside the total, not beside it.** Both generations cost 320 input, so
   * the conversation's figure is 640 — and this is the assertion that
   * discriminates the plausible wrong implementation: a total that kept "what
   * I generated" clean by leaving the card out reports 320 and looks entirely
   * reasonable.
   */
  assert.equal(view.usage.inputTokens, 640)
  assert.equal(view.usage.outputTokens, 96)
  assert.equal(view.usage.cacheReadTokens, 180)
  // And the share is reported on its own, so a surface can say how much of the
  // figure above was not the user's doing.
  assert.equal(view.scriptUsage?.turns, 1)
  assert.equal(view.scriptUsage?.usage.inputTokens, 320)
})

test('a provider that reports nothing leaves no record', async (t) => {
  /*
   * The same rule `recordUsage` states for a turn: no field may be invented,
   * and a zero-filled record is a claim about a generation nobody measured — it
   * would enter the summary's `turns` and drag a hit rate down with a cost of
   * `0`. This stream is the fixture's minus its `usage` chunk.
   */
  const dir = await mkdtemp(join(tmpdir(), 'iris-side-silent-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const stream: StreamFn = async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Quiet.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Quiet.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => { /* nothing listens here */ },
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  const { text } = await handlers['script.generate']({ chatId, userInput: 'A side question.' })
  // The premise: the call succeeded, so this is "the provider reported nothing"
  // and not "the call failed before it could".
  assert.equal(text, 'Quiet.')

  const entry = await chats.open(chatId)
  assert.equal(readSideUsage(entry.header).length, 0, 'a generation with no reported usage left a record')
  assert.equal(entry.header[SIDE_USAGE_FIELD], undefined, 'the field was created for a record that does not exist')
  assert.equal((await handlers['chat.open']({ chatId })).view.scriptUsage, undefined)
})
