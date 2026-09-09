/**
 * What one conversation holds back for the reply, and the four places it lands.
 *
 * **The defect this pins.** The assembly reserved the host's `reserveTokens`
 * (default 1 024) while the request sent `settings.maxTokens` as `max_tokens`
 * (65 535 on the operator's own install), so a prompt was allowed to fill the
 * window to within 1 024 tokens of the top and then told the provider it might
 * write 65 535 more. Upstream has one figure doing both jobs —
 * `openai.js:1558` calls `setTokenBudget(openai_max_context,
 * openai_max_tokens)`, `openai.js:3887` is `tokenBudget = context - response`,
 * and `openai.js:2750` puts the same `openai_max_tokens` on the wire — and this
 * host now does too (`#reserveFor`).
 *
 * **What makes these tests discriminating.** The fixture configures a
 * `maxTokens` that is a *large fraction of the window*, which is the only shape
 * where the two candidate reserves produce different assemblies: on the default
 * settings the host's 1 024 and a chat's `maxTokens` are close enough that the
 * same floors fit either way, and a check written there passes against the
 * defect. The control is a chat with no `maxTokens` at all, where the fallback
 * has to be the host's own figure — the case that fails if the fix is written
 * as "always send `maxTokens`".
 *
 * @module @iris/app-service/tests/reserve-budget
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import type { ChatStore } from '../src/chats.ts'
import { compactionSpec } from '../src/compaction.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { materialisingChatStore } from './support/materialising-store.ts'

/** A plain card with a long enough greeting to be worth trimming. */
const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'An archivist who answers in full paragraphs.',
    first_mes: 'The shelves are quiet tonight. Everything here is catalogued twice.',
    personality: '', scenario: '', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '', extensions: {},
  },
})

/** The composition's own reserve, so the fallback case has a figure to expect. */
const HOST_RESERVE = 1_024

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  seen: GenerateOptions[]
  settled: () => Promise<void>
}

/**
 * A service whose provider records what it was asked for.
 * @param t - the test context, for cleanup.
 * @returns the fixture.
 */
async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-reserve-'))
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
    const text = 'A reply.'
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
    reserveTokens: HOST_RESERVE,
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

test('the reserve a conversation reports is the max_tokens it will send', async (t) => {
  const f = await fixture(t)
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  const chatId = view.chatId

  // A reserve that is a large share of the window, which is the only shape
  // where the host's own 1 024 and this figure assemble differently.
  await f.handlers['settings.set']({ chatId, settings: { contextWindow: 8_192, maxTokens: 4_096 } })

  const opened = await f.handlers['chat.open']({ chatId })
  assert.equal(opened.view.budget?.context, 8_192)
  assert.equal(
    opened.view.budget?.reserve,
    4_096,
    'the capacity card still divides by the host reserve rather than by what the reply is allowed',
  )

  /*
   * And the wire agrees, which is the whole identity: `max_tokens` out and the
   * reserve held back are one number. A host that sent one and reserved the
   * other lets the prompt fill the window to within 1 024 of the top and then
   * asks for 4 096 more.
   */
  await f.handlers['chat.send']({ chatId, kind: 'send', text: 'Hello?' })
  await f.settled()
  const sent = f.seen.at(-1)
  assert.ok(sent !== undefined)
  assert.equal(sent.maxTokens, 4_096, 'the request did not send the configured reply allowance')
  assert.equal(
    sent.maxTokens,
    opened.view.budget?.reserve,
    'the request’s max_tokens and the reserve the assembly held back are two different numbers',
  )
})

test('a chat with no maxTokens falls back to the host’s own reserve', async (t) => {
  /*
   * The control, and the case that fails if the fix is written as "the reserve
   * is `maxTokens`": nothing to subtract is not the same as subtracting
   * nothing, and a window with no reply allowance held back is the one shape
   * that cannot be sent. This is also the shape every default install is in —
   * `settings.json` carries no `maxTokens` until something writes one.
   */
  const f = await fixture(t)
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  const chatId = view.chatId
  await f.handlers['settings.set']({ chatId, settings: { contextWindow: 8_192 } })

  const opened = await f.handlers['chat.open']({ chatId })
  assert.equal(opened.view.budget?.reserve, HOST_RESERVE, 'the fallback is not the host’s reserve')

  await f.handlers['chat.send']({ chatId, kind: 'send', text: 'Hello?' })
  await f.settled()
  assert.equal(
    f.seen.at(-1)?.maxTokens,
    undefined,
    'a chat that configures no reply allowance should not have one invented on the wire',
  )
  // The itemization is the record of that assembly, so it reports the same
  // fallback rather than a zero or a stale copy. The turn comes from the view's
  // own newest measurement: asking for a turn nothing recorded answers with a
  // fresh preview, which is a different assembly wearing the same shape.
  const turn = (await f.handlers['chat.open']({ chatId })).view.measured?.turn
  assert.ok(turn !== undefined, 'the turn left no recorded itemization to read')
  const { itemization } = await f.handlers['prompt.itemize']({ chatId, turn })
  assert.equal(itemization.preview, false, 'this needs the record, not a fresh preview')
  assert.equal(itemization.budget.reserve, HOST_RESERVE)
})

test('the itemization records the reserve its own assembly held back', async (t) => {
  /*
   * Both readings of the same assembly. The record is written during the turn
   * and the preview is computed on demand, and they used to read the reserve
   * from `#options` — one host-wide constant — so a chat with its own
   * `maxTokens` had a capacity card dividing by 1 024 while its request had
   * given up 4 096. The two figures on the page were about different
   * assemblies, which is the same defect the `window` parameter was made
   * required to fix.
   */
  const f = await fixture(t)
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  const chatId = view.chatId
  await f.handlers['settings.set']({ chatId, settings: { contextWindow: 8_192, maxTokens: 4_096 } })
  await f.handlers['chat.send']({ chatId, kind: 'send', text: 'Hello?' })
  await f.settled()

  const turn = (await f.handlers['chat.open']({ chatId })).view.measured?.turn
  assert.ok(turn !== undefined, 'the turn left no recorded itemization to read')
  const record = await f.handlers['prompt.itemize']({ chatId, turn })
  assert.equal(record.itemization.preview, false, 'this needs the record, not a fresh preview')
  assert.equal(record.itemization.budget.reserve, 4_096, 'the recorded itemization reports the wrong reserve')

  const preview = await f.handlers['prompt.itemize']({ chatId })
  assert.equal(preview.itemization.preview, true)
  assert.equal(
    preview.itemization.budget.reserve,
    record.itemization.budget.reserve,
    'the preview and the record disagree about what the reply is allowed',
  )
})

test('a bigger reserve moves the assembly, and moves it in the trimmer’s direction', async (t) => {
  /*
   * The consequence, measured rather than argued. `assemble` spends
   * `context - reserve - fixed` on history, so raising the reserve shrinks what
   * history may spend — the trimmer starts dropping floors earlier. That is
   * upstream's behaviour (its budget is `openai_max_context -
   * openai_max_tokens`) and it is the point: a prompt plus a reply that
   * overflow the window is a provider error, where a dropped floor is a trim.
   *
   * **The two runs are the same conversation with the same window**, so the
   * only variable is the reserve. The reserve is taken to nearly the whole
   * window in the second run, which is where a difference is unambiguous
   * rather than a rounding.
   */
  const f = await fixture(t)
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  const chatId = view.chatId
  await f.handlers['settings.set']({ chatId, settings: { contextWindow: 8_192 } })
  for (let at = 0; at < 4; at += 1) {
    await f.handlers['chat.send']({
      chatId,
      kind: 'send',
      text: `Line ${String(at)}: ${'the reader says something at length. '.repeat(20)}`,
    })
    await f.settled()
  }

  const roomy = (await f.handlers['prompt.itemize']({ chatId })).itemization
  assert.equal(roomy.budget.reserve, HOST_RESERVE)
  assert.equal(roomy.droppedHistory, 0, 'the conversation is already trimming, so a change cannot be read here')

  // A reserve leaving the prompt almost nothing: the trim has to bite.
  await f.handlers['settings.set']({ chatId, settings: { maxTokens: 8_000 } })
  const tight = (await f.handlers['prompt.itemize']({ chatId })).itemization
  assert.equal(tight.budget.reserve, 8_000, 'the preview did not pick up the new reply allowance')
  assert.ok(
    tight.droppedHistory > roomy.droppedHistory,
    `the reserve went from ${String(roomy.budget.reserve)} to 8 000 and the trim dropped`
    + ` ${String(tight.droppedHistory)} floors either way; the assembly is not reading the reserve`,
  )
  assert.ok(
    tight.tokens < roomy.tokens,
    'the tighter budget assembled a request no smaller than the roomy one',
  )

  /*
   * And the auto-compaction threshold moves with it, because both divide by
   * `context - reserve` (`compactionSpec`'s own doc says why it is the same
   * denominator as the capacity meter's). Computed here from the reported
   * budgets rather than from a literal, so the assertion follows the policy
   * instead of pinning a number the ratios would make a lie.
   */
  const roomySpec = compactionSpec(roomy.budget.context - roomy.budget.reserve)
  const tightSpec = compactionSpec(tight.budget.context - tight.budget.reserve)
  assert.ok(roomySpec !== null, 'the roomy budget is too small for the compaction policy')
  assert.ok(tightSpec !== null, 'the tight budget is too small for the compaction policy')
  assert.ok(
    tightSpec.thresholdTokens < roomySpec.thresholdTokens,
    'the compaction threshold did not fall with the available budget, so it can now sit above the trim',
  )
})

test('the reply-budget macro reports the same figure the assembly held back', async (t) => {
  /*
   * `{{maxResponse}}`. This was the one site that already resolved the pair
   * correctly (`settings.maxTokens ?? reserveTokens`), which is why it is worth
   * a test rather than a comment: it is the reading a *card* gets, and a macro
   * reporting one figure while the assembly beside it subtracted another is a
   * disagreement a card author cannot see.
   */
  const f = await fixture(t)
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  const chatId = view.chatId
  await f.handlers['settings.set']({ chatId, settings: { contextWindow: 8_192, maxTokens: 4_096 } })
  // The macros read `entry.tokenBudget`, which is assigned while a request is
  // being built — so a conversation that has not generated has nothing to
  // report and this would be checking the expander's fallback instead.
  await f.handlers['chat.send']({ chatId, kind: 'send', text: 'Hello?' })
  await f.settled()

  const entry = await f.chats.open(chatId)
  const expanded = entry.substitute('budget: {{maxResponse}} of {{maxPrompt}}')
  assert.equal(
    expanded,
    'budget: 4096 of 4096',
    `the budget macros expanded to something else: ${expanded}`,
  )
  /*
   * `{{maxPrompt}}` is `context - maxResponse`, so a reserve read from the
   * host's constant would put 7 168 there — the same window, a different
   * account of what the prompt may spend. The two figures agreeing at 4 096 is
   * the identity being pinned.
   */
  const opened = await f.handlers['chat.open']({ chatId })
  assert.equal(
    opened.view.budget?.reserve,
    4_096,
    'the macro and the capacity card report different reply allowances',
  )
  assert.equal(
    (opened.view.budget?.context ?? 0) - (opened.view.budget?.reserve ?? 0),
    4_096,
    'the capacity card and {{maxPrompt}} disagree about what the prompt may spend',
  )
})
