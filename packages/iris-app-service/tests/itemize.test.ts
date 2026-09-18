import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { decodeCardPng } from '@iris/character'
import type { ChatCompletionPreset } from '@iris/preset'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { materialisingChatStore } from './support/materialising-store.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { tempDir } from './support/temp-dir.ts'

/**
 * Where an assembled prompt's tokens went.
 *
 * The feature's own justification is a number, so the last test here measures
 * it rather than describing it: on a real preset and card, two thirds of the
 * prompt turns out to be one world-info entry.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: 'A retired cartographer of some renown.', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '1', extensions: {},
  },
})

/** A stream that answers once and reports what the prompt cost. */
function scripted(inputTokens?: number): StreamFn {
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'A reply.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'A reply.' } }
    if (inputTokens !== undefined) {
      yield { type: 'usage', usage: { inputTokens, outputTokens: 4 } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  settled: () => Promise<void>
}

async function fixture(t: TestContext, inputTokens?: number, preset?: ChatCompletionPreset): Promise<Fixture> {
  const dir = await tempDir(t, 'iris-itemize-')
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  let ends = 0
  let waited = 0

  const handlers = new IrisAppService({
    stream: scripted(inputTokens),
    library,
    chats,
    settings,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
    ...preset === undefined ? {} : { preset },
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

test('a preview needs no record, and says that it is one', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })

  // Nothing has been generated, so nothing could have been recorded — and the
  // answer is still useful, which is the point of preview mode.
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  assert.equal(itemization.preview, true)
  assert.ok(itemization.entries.length > 0)
  assert.equal(itemization.tokens > 0, true)
  assert.equal(itemization.budget.context, 32_768)

  // The character's description is in there, and named.
  const described = itemization.entries.find(entry => entry.id === 'charDescription')
  assert.ok(described !== undefined, `no charDescription among ${itemization.entries.map(e => e.id).join(', ')}`)
  assert.ok(described.tokens > 0)
})

test('the parts sum to the total, and the conversation is one row', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  const history = itemization.entries.filter(entry => entry.kind === 'history')
  assert.equal(history.length, 1, 'the conversation is one aggregate row, as upstream reports it')

  const summed = itemization.entries.reduce((total, entry) => total + entry.tokens, 0)
  // Exact, not approximate: a breakdown whose parts do not add up is worse than
  // no breakdown, because it sends someone hunting for the missing tokens.
  assert.equal(summed, itemization.tokens)
})

test('a generated turn is recorded as it was assembled, with what it really cost', async (t) => {
  const fix = await fixture(t, 4321)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  const { turn } = await fix.handlers['chat.send']({ chatId, text: 'Hello?' })
  await fix.settled()

  const { itemization } = await fix.handlers['prompt.itemize']({ chatId, turn })

  assert.equal(itemization.preview, false, 'this is the request that was sent, not a guess at the next one')
  assert.equal(itemization.turn, turn)
  // The provider's own count, beside our estimate — this is what tells a user
  // whether the estimate is worth trusting.
  assert.equal(itemization.actualTokens, 4321)
  assert.notEqual(itemization.tokens, 0)
})

test('a turn with no record answers with a preview rather than nothing', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })

  // Records live only while the host holds the chat open, so a UI asking about
  // an old turn has to get something useful back.
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId, turn: 99 })

  assert.equal(itemization.preview, true)
  assert.ok(itemization.entries.length > 0)
})

test('a label is always present, even when the id is a UUID', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  for (const entry of itemization.entries) {
    assert.ok(entry.label.length > 0, `${entry.id} has no label`)
  }
})

/**
 * The justification, measured.
 *
 * Skipped without a SillyTavern install. It is here because the argument for
 * building this at all is a number that no fixture can produce: a real preset
 * and a real card put two thirds of the prompt in one place nobody would guess.
 */
const PRESET = `${(process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern')}/data/default-user/OpenAI Settings/梦境思客V1-0425.json`
const REAL_CARD = `${(process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern')}/data/default-user/characters/银麒赎世.png`

test('on real data, one world-info entry is most of the prompt', {
  skip: (!existsSync(PRESET) || !existsSync(REAL_CARD))
    && `needs the real preset ${PRESET} and card ${REAL_CARD}; point IRIS_CORPUS at the install that has them`,
}, async (t) => {
  const dir = await tempDir(t, 'iris-itemize-real-')
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'yinqi.png'), await readFile(REAL_CARD))

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const preset = JSON.parse(await readFile(PRESET, 'utf8')) as ChatCompletionPreset

  const handlers = new IrisAppService({
    stream: scripted(),
    library,
    chats,
    settings,
    preset,
    broadcast: () => {},
    userName: '旅人',
  }).handlers()

  // The card decodes; if it ever stops, this test is measuring nothing.
  assert.ok(decodeCardPng(await readFile(REAL_CARD)).data.name.length > 0)

  const created = await handlers['chat.create']({ characterId: 'yinqi' })
  const { itemization } = await handlers['prompt.itemize']({ chatId: created.view.chatId })

  const ranked = [...itemization.entries].sort((left, right) => right.tokens - left.tokens)
  const biggest = ranked[0]
  assert.ok(biggest !== undefined)

  const share = biggest.tokens / itemization.tokens
  assert.ok(
    share > 0.4,
    `the largest part is ${String(biggest.tokens)}/${String(itemization.tokens)} — the shape this feature exists to reveal`,
  )
  // `worldInfoBefore` here rather than `worldInfo.depth.*` because a fresh chat
  // has no history for a depth injection to sit inside; both are world info,
  // which is the claim. Which bucket it lands in is the pipeline's business.
  assert.match(
    biggest.id,
    /^worldInfo/u,
    `expected world info to dominate, got ${biggest.id} at ${String(Math.round(share * 100))}%`,
  )
})

test('a marker slot that had nothing to put in it appears as a zero, not as an absence', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })

  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  // This chat has no world book at all, so `worldInfoBefore` fired nothing.
  // `itemize` promises that a part which contributed nothing "still appears
  // with a zero — a user looking for why a section is missing is better served
  // by a zero than by an absence", and the missing row was the exact question
  // the panel gets opened to answer.
  const ids = itemization.entries.map(entry => entry.id)
  for (const slot of ['worldInfoBefore', 'worldInfoAfter', 'personaDescription', 'charPersonality', 'scenario']) {
    const row = itemization.entries.find(entry => entry.id === slot)
    assert.ok(row !== undefined, `no ${slot} row among ${ids.join(', ')}`)
    assert.equal(row.tokens, 0, `${slot} is not empty on this chat`)
    assert.equal(row.kind, 'system')
  }

  // A zero row is a row and nothing else: it contributes no text, so the
  // arithmetic the panel shows is unchanged.
  const summed = itemization.entries.reduce((total, entry) => total + entry.tokens, 0)
  assert.equal(summed, itemization.tokens)

  // One row per slot, not one per read: the walk must not append a second copy.
  assert.equal(ids.filter(id => id === 'worldInfoBefore').length, 1)
})

test('a custom marker this host cannot fill is attributed to the preset, not the card', async (t) => {
  // The measured shape: a real preset carries a `搜索内容注入` / `搜索结束` pair —
  // markers a search extension fills. This host has no filler, so the rows are
  // zero, and the question "whose row is this" has a right answer: the preset
  // declared the slot, no card field was ever read. Falling through to a card
  // default sent a reader to look at a field the preset never touched.
  const preset: ChatCompletionPreset = {
    prompts: [
      { identifier: 'main', name: 'Main', role: 'system', content: 'Speak.', enabled: true },
      { identifier: 'searchInjection', name: '搜索内容注入', role: 'system', marker: true, enabled: true },
      { identifier: 'searchEnd', name: '搜索结束', role: 'system', content: '{{setvar::search::done}}', enabled: true },
    ],
    prompt_order: [{
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'searchInjection', enabled: true },
        { identifier: 'searchEnd', enabled: true },
      ],
    }],
  }
  const fix = await fixture(t, undefined, preset)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  const injection = itemization.entries.find(entry => entry.id === 'searchInjection')
  assert.ok(injection !== undefined, 'a preset marker with no host filler must still get a row')
  assert.equal(injection.tokens, 0)
  assert.equal(injection.explanation?.zeroReason, 'marker-unfilled')
  // **The fix.** Not `card` — the preset declared this marker and no card field
  // backs it — and the label is the preset's own name for the slot, so a reader
  // recognises the row.
  assert.equal(injection.explanation?.source.kind, 'preset')
  assert.equal(injection.explanation?.source.label, '搜索内容注入')
})

test('a slot this generation never offered is not zeroed', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })

  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  // `dialogueExamples` is a marker the default preset orders and this card
  // leaves empty, so it is zeroed like the rest — but `nsfw` and
  // `enhanceDefinitions` are not in this preset's list at all, and a row for
  // them would claim a slot the generation never had.
  assert.ok(itemization.entries.some(entry => entry.id === 'dialogueExamples'))
  assert.equal(itemization.entries.some(entry => entry.id === 'nsfw'), false)
  assert.equal(itemization.entries.some(entry => entry.id === 'enhanceDefinitions'), false)
})

/**
 * A variable-driven preset: one prompt sets a variable and writes no prose, a
 * later one reads it back.
 *
 * The measured shape this reproduces is the user's own `[主预设] V19.5 狐神抚 ·
 * 毓忻`, where 初始化 is 61 `{{setvar}}` calls and nothing else — the whole
 * mechanism behind the 23 zero rows in the assembly panel. Written here rather
 * than read from disk so the rule does not depend on a preset being installed.
 */
const SETVAR_PRESET: ChatCompletionPreset = {
  prompts: [
    { identifier: 'init', name: '初始化', role: 'system', content: '{{setvar::style::gothic}}', enabled: true },
    { identifier: 'read', name: '开始', role: 'system', content: 'Style is [{{getvar::style}}].', enabled: true },
  ],
  prompt_order: [{
    character_id: 100001,
    order: [{ identifier: 'init', enabled: true }, { identifier: 'read', enabled: true }],
  }],
}

test('a preset prompt that is all macros is told apart from a slot nothing filled', async (t) => {
  const fix = await fixture(t, undefined, SETVAR_PRESET)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  // `初始化` is non-empty as authored and empty once expanded — the two facts
  // the panel could not tell apart. Left unexplained, both render as a bare
  // "empty" and the reader has no way to know this one is *working as
  // designed* while the other means their card field is blank.
  const init = itemization.entries.find(entry => entry.id === 'init')
  assert.ok(init !== undefined, `no init row among ${itemization.entries.map(e => e.id).join(', ')}`)
  assert.equal(init.tokens, 0, 'the setvar prompt is supposed to render to nothing')
  assert.equal(init.explanation?.zeroReason, 'macros-only')
  assert.deepEqual(init.explanation?.source, { kind: 'preset', id: 'init' })

  // The reading prompt proves the macro engine ran: the text is there, so the
  // zero above is an expansion result and not a dropped contribution.
  const read = itemization.entries.find(entry => entry.id === 'read')
  assert.ok(read !== undefined && read.tokens > 0)
  assert.equal(read.explanation?.zeroReason, undefined, 'a part with text carries no zero reason')
})

test('an unfilled marker is told apart from a macros-only row', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  // `scenario` is a marker this card leaves blank: the slot was offered and the
  // host had nothing to fill it with. Its reason is `marker-unfilled`, and its
  // source names the card — the two together are what send a reader to the
  // right field instead of to the preset.
  const scenario = itemization.entries.find(entry => entry.id === 'scenario')
  assert.ok(scenario !== undefined, 'scenario should be zeroed rather than absent')
  assert.equal(scenario.tokens, 0)
  assert.equal(scenario.explanation?.zeroReason, 'marker-unfilled')
  assert.deepEqual(scenario.explanation?.source, { kind: 'card', id: 'scenario' })

  // And the two reasons really are distinct — the assertion the panel's copy
  // leans on. A world-info slot is unfilled by a book, a setvar prompt by the
  // preset; telling them apart is the feature.
  const worldInfo = itemization.entries.find(entry => entry.id === 'worldInfoBefore')
  assert.equal(worldInfo?.explanation?.source.kind, 'worldbook')
})

test('a preset prompt whose content is empty still produces no row', async (t) => {
  // A preset author's blank line is not the same fact as a marker nobody
  // filled, and this host deliberately does not row it: a real preset has
  // dozens of them and each would say nothing about the turn. This pins the
  // decision so the next person to "complete" the explanation feature cannot
  // add the rows without seeing this turn red.
  const preset: ChatCompletionPreset = {
    prompts: [
      { identifier: 'main', name: 'Main', role: 'system', content: 'Speak.', enabled: true },
      { identifier: 'blank', name: 'Left blank', role: 'system', content: '', enabled: true },
    ],
    prompt_order: [{
      character_id: 100001,
      order: [{ identifier: 'main', enabled: true }, { identifier: 'blank', enabled: true }],
    }],
  }
  const fix = await fixture(t, undefined, preset)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  assert.equal(
    itemization.entries.some(entry => entry.id === 'blank'),
    false,
    'a blank preset item grew a row; the no-`blank`-rows decision was reversed without a test change',
  )
})

test('the explanation is deterministic: the same state itemizes to the same report', async (t) => {
  // The assembly is pure and a preview re-runs it from scratch, so two asks
  // about the same unchanged conversation must agree in full — explanations,
  // sources and reasons included. This is the itemization-side twin of
  // `assembly-determinism.test.ts`'s byte comparison: a report that jittered
  // between reads (a Set iterated differently, a label picked off a Map) would
  // make the panel's expander flicker and would make any future "changed since
  // last turn" comparison meaningless.
  const fix = await fixture(t, undefined, SETVAR_PRESET)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  const first = await fix.handlers['prompt.itemize']({ chatId })
  const second = await fix.handlers['prompt.itemize']({ chatId })

  assert.deepEqual(second.itemization, first.itemization)
  // And the report is not trivially empty of explanations, or the equality
  // above would hold for a shape that carries nothing.
  assert.ok(first.itemization.entries.some(entry => entry.explanation !== undefined))
})

/**
 * Every part can be found from the request, and every part's placement can be
 * found from the request's other direction.
 *
 * Two maps are built in one assembly pass: each part says which message it went
 * to (`explanation.placement.messageIndex`), and each message says which parts
 * it holds (`messages[].partIds`). They are two views of the same fact, so the
 * test is a **round trip**: for every placed part, its message names it; for
 * every message part, the part knows its message. A single direction would pass
 * with a broken reverse index and say nothing about the panel's message view.
 *
 * Counts are lower bounds, not pins — one real preset's rows are not this test's
 * subject. The floor is that both directions actually saw something, so a
 * mutation that empties either side cannot pass by having nothing to check.
 */
test('every placed part resolves both ways between the rows and the messages', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })

  const messages = itemization.messages
  assert.ok(messages !== undefined, 'the host must send the reverse index')
  assert.ok(messages.length >= 2, `expected a system prompt and a conversation, got ${String(messages.length)}`)

  /** part id → the message indices that name it. */
  const namedBy = new Map<string, number[]>()
  for (const message of messages) {
    for (const id of message.partIds) {
      const list = namedBy.get(id) ?? []
      list.push(message.index)
      namedBy.set(id, list)
    }
  }

  // Forward: a part that says it went to message N is named by message N.
  let placed = 0
  for (const entry of itemization.entries) {
    const at = entry.explanation?.placement
    if (at === undefined) continue
    placed += 1
    assert.ok(
      namedBy.get(entry.id)?.includes(at.messageIndex) === true,
      `${entry.id} claims message ${String(at.messageIndex)} but no message names it`,
    )
  }
  // Reverse: a message part that is an assembly item knows its own placement.
  const byId = new Map(itemization.entries.map(entry => [entry.id, entry]))
  let attributed = 0
  for (const message of messages) {
    for (const id of message.partIds) {
      const entry = byId.get(id)
      if (entry === undefined) continue // a floor
      attributed += 1
      assert.equal(
        entry.explanation?.placement?.messageIndex,
        message.index,
        `${id} is named by message ${String(message.index)} but claims another`,
      )
    }
  }

  // The floors are in the other direction only — the conversation is one
  // aggregate row, so no entry names a floor — and that is the asymmetry this
  // test exists to make explicit rather than to paper over.
  const floors = messages.flatMap(message => message.partIds).filter(id => id.startsWith('history.'))
  assert.ok(floors.length > 0, 'the fixture should have a conversation floor for the reverse index to name')

  // Both directions saw real work, so neither could have passed empty.
  assert.ok(placed >= 2, `only ${String(placed)} placed parts; the forward check is not exercising anything`)
  assert.ok(attributed >= 2, `only ${String(attributed)} attributed message parts; the reverse check is vacuous`)

  // And the counts agree where they must: every placed part is named somewhere,
  // so the two directions see the same population apart from the floors.
  assert.equal(
    messages.flatMap(message => message.partIds).filter(id => byId.has(id)).length,
    placed,
    'the two directions disagree about how many parts were placed',
  )
})

/**
 * The stable flag agrees with the boundary the number reports.
 *
 * A row is `stable` when it is inside the leading volatile-free run, and
 * `stablePrefixTokens` is the size of that run. The two are computed by one walk
 * so they cannot disagree, and this pins the agreement on a case where the run
 * really does stop in the middle — a volatile depth injection — rather than on
 * one where everything is stable and any rule would pass.
 */
test('a row is stable exactly when it sits before the first volatile part', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  await fix.handlers['chat.send']({ chatId: created.view.chatId, text: 'Hi.' })
  await fix.settled()

  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })
  const messages = itemization.messages ?? []
  // Every message's own verdict is present, and a stable one never follows an
  // unstable one — the run is a prefix, which is what makes a single token
  // count for it meaningful.
  let seenUnstable = false
  for (const message of messages) {
    if (!message.stable) seenUnstable = true
    else assert.equal(seenUnstable, false, `message ${String(message.index)} is stable but follows an unstable one`)
  }

  // A part's own `stable` matches the message it is in, for every part that
  // reports both.
  for (const entry of itemization.entries) {
    const at = entry.explanation?.placement
    if (at === undefined || entry.explanation?.stable === undefined) continue
    const message = messages.find(slot => slot.index === at.messageIndex)
    assert.equal(entry.explanation.stable, message?.stable, `${entry.id} disagrees with its message about the prefix`)
  }
})

test('the explanation carries no prompt text and no secret', async (t) => {
  // The rule the whole feature is allowed to exist under: a report carries
  // hashes, sources and reasons, never the bytes. The host's own `LayoutPart`
  // text stays in the session, and `debug.reports` is drawn from this shape — so
  // a `text` field leaking into an explanation would put a conversation into a
  // diagnostics bundle. Serialised and searched as one string, because the leak
  // could be nested anywhere in the explanation object.
  const fix = await fixture(t, undefined, SETVAR_PRESET)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  await fix.handlers['chat.send']({ chatId: created.view.chatId, text: 'A SECRET FLOOR' })
  await fix.settled()

  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: created.view.chatId })
  const explanations = JSON.stringify(
    itemization.entries.map(entry => ({ row: entry.explanation, members: entry.members?.map(m => m.explanation) })),
  )

  // The setvar preset's own prose (`Style is [gothic].`) and the user's floor
  // are both in the request; neither may appear in an explanation. The macro
  // stage makes this a live risk rather than a theoretical one: a setvar's
  // **value** is what a naive trace would record, and the value here is
  // `gothic`.
  for (const secret of ['gothic', 'A SECRET FLOOR', 'Style is']) {
    assert.equal(
      explanations.includes(secret),
      false,
      `"${secret}" reached the explanation report; the report must carry hashes, sources and reasons only`,
    )
  }
  // And the macro report is present, carrying the head and not the value — so
  // the assertions above are not passing because nothing was traced.
  const withMacros = itemization.entries.find(entry => entry.explanation?.macros !== undefined)
  assert.ok(withMacros !== undefined, 'this preset is macro-driven, so a row must report its heads')
  const heads = Object.keys(withMacros.explanation?.macros?.heads ?? {})
  assert.ok(heads.includes('setvar'), `expected a setvar head, got ${heads.join(', ')}`)
  assert.equal(heads.includes('gothic'), false, 'a macro head is a name, never its value')
  // And there are explanations to have leaked, so the scan is not vacuous.
  assert.ok(itemization.entries.some(entry => entry.explanation !== undefined))
})

/**
 * The regex stage's trace reaches the row it belongs to.
 *
 * The prompt-direction scripts rewrite the **conversation floors**, never the
 * preset's own text, so the only row that can honestly report them is the
 * `chatHistory` aggregate — and the caller is the only thing that knows, since
 * by the time `assemble` sees the history the text is already rewritten. A card
 * with a prompt-only rule over its own reply is the measured shape (MVU's
 * `去除变量更新`, which strips its command block from what the model reads).
 */
const REGEX_CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello there.\n<UpdateVariable>\n_.set("hp", 10)\n</UpdateVariable>', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '1',
    extensions: {
      regex_scripts: [{
        id: 'r1',
        scriptName: 'strip-commands',
        findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gm',
        replaceString: '',
        trimStrings: [],
        // AI_OUTPUT placement, prompt direction only.
        placement: [2],
        disabled: false,
        markdownOnly: false,
        promptOnly: true,
        runOnEdit: false,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
      }],
    },
  },
})

test('a prompt-direction regex on a floor is reported on the conversation row', async (t) => {
  const dir = await tempDir(t, 'iris-itemize-regex-')
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), REGEX_CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const handlers = new IrisAppService({
    stream: scripted(),
    library,
    chats,
    settings,
    broadcast: () => {},
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const { itemization } = await handlers['prompt.itemize']({ chatId: created.view.chatId })

  // The greeting carries a command block, so the prompt-direction rule fired on
  // the floor it rewrote — and the row says which rule, by the `scriptName` a
  // card author would recognise.
  const history = itemization.entries.find(entry => entry.id === 'chatHistory')
  assert.ok(history !== undefined)
  assert.deepEqual(history.explanation?.regex, { applied: ['strip-commands'] })

  // The rule really rewrote the prompt direction: the block is not in the
  // assembled history. (It is still in the *stored* greeting — the script is
  // prompt-only, which is exactly why the record is the only place a reader can
  // see that it ran.)
  const opened = await handlers['chat.open']({ chatId: created.view.chatId })
  const stored = opened.view.messages.map(message => message.text).join('\n')
  assert.ok(stored.includes('<UpdateVariable>'), 'a prompt-only rule must leave the stored message alone')
})

/**
 * The budget's own record: which floors the trim took and what they cost.
 *
 * The figures come off the one trim call that made the cut — the pipeline
 * reports them beside the count it always reported — so this checks the wire
 * carries them, not that a second sum agrees. A window narrow enough to force
 * a trim is the precondition; without it every number here is zero and the
 * assertions pass against a host that never reports anything.
 */
test('a trimmed assembly reports the dropped floors and their weight', async (t) => {
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // Several floors, so there is something to drop, and a window small enough
  // that they cannot all fit. The card's greeting is the first floor.
  await fix.handlers['chat.send']({ chatId, text: 'First.' })
  await fix.settled()
  await fix.handlers['chat.send']({ chatId, text: 'Second.' })
  await fix.settled()
  await fix.handlers['settings.set']({ chatId, settings: { contextWindow: 64 } })

  const { itemization } = await fix.handlers['prompt.itemize']({ chatId })

  assert.ok(itemization.droppedHistory > 0, 'the fixture no longer trims, so this test measures nothing')
  assert.ok(itemization.overflow !== undefined, 'the host must report what the trim cut')
  // The count, the ids and the weight all describe the same cut.
  assert.equal(itemization.overflow.droppedFloors, itemization.droppedHistory)
  assert.ok(itemization.overflow.droppedTokens > 0, 'the dropped floors held text, so their weight is nonzero')
  assert.equal(
    itemization.overflow.droppedIds?.length,
    itemization.droppedHistory,
    'every dropped floor was identified, since the host mints floor ids',
  )
  // The ids are floors, named the way the divergence report names them.
  for (const id of itemization.overflow.droppedIds ?? []) {
    assert.match(id, /^history\.\d+$/u, `${id} is not a floor id`)
  }

  // A request that fits says so with zeros rather than by staying silent.
  const roomy = await fixture(t)
  const other = await roomy.handlers['chat.create']({ characterId: 'aria' })
  const roomyItemization = (await roomy.handlers['prompt.itemize']({ chatId: other.view.chatId })).itemization
  assert.equal(roomyItemization.droppedHistory, 0)
  assert.deepEqual(roomyItemization.overflow, { droppedFloors: 0, droppedTokens: 0 })
})
