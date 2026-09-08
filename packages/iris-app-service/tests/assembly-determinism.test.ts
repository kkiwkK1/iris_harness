import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { StreamFn } from '@iris/turn'
import { serializeRequest } from '@iris/llm-openai-compat'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { WorldbookStore } from '../src/worldbooks.ts'

/**
 * One unchanged conversation assembles to the same bytes twice.
 *
 * DeepSeek serves a cached prompt only up to the **first changed byte** of the
 * request prefix (64-token blocks; `prompt_cache_hit_tokens` /
 * `prompt_cache_miss_tokens`). Two rounds of a real chat can never match in
 * full — the newest exchange is new text — so the only place the question
 * "same input, same bytes?" has a clean answer is here: one state, assembled
 * twice, nothing else moving.
 *
 * That makes this the control for every claim about *why* a cache missed. If
 * the host's own assembly jitters, no amount of prompt-order work will show up
 * as a hit, and the measurement that blamed the card would have been measuring
 * us. Measured against the operator's own profile
 * (`scripts/cache-prefix-probe.mjs`, 2026-09-07): 11 of 15 conversations
 * byte-identical, the other 4 explained entirely by card-authored `{{random}}`
 * and `{{roll}}` macros inside world-info entries.
 *
 * The request is taken at the seam that sees what is sent — the `stream`
 * function the service is built with — and compared through
 * `serializeRequest`, which is what the adapter `JSON.stringify`s onto the
 * wire. Comparing the assembled objects instead would pass on a difference the
 * serializer would have shown, and vice versa.
 *
 * **The comparison starts after a warm-up, and that is a real qualification.**
 * The cache-friendly order (DEVIATIONS §38, on by default) classifies each
 * contribution by watching it, so a part that has held still long enough to be
 * worth pulling into the prefix changes place **once**, on the assembly where
 * it settles. That is a deliberate one-off cost — every layout change is one
 * miss, and the alternative was never moving anything — but it means this
 * control is a claim about the *steady state*: after the classifier has seen
 * each part twice, the same state assembles to the same bytes forever. The
 * warm-up is two assemblies, and the test asserts the layout really did settle
 * inside it rather than assuming so, or three pre-settle assemblies would agree
 * with each other and prove nothing about the state the product runs in.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'A retired cartographer of {{user}}\'s acquaintance.',
    personality: 'Dry.',
    scenario: 'A map room.',
    first_mes: 'Hello.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: 'Stay in character.',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '1',
    // A character's note at depth 2 and a world book at depth 0: the two
    // placements that anchor to the END of the conversation, which is where a
    // prefix cache is most easily broken.
    extensions: { depth_prompt: { prompt: 'Aria remembers the map room.', depth: 2, role: 'system' } },
  },
})

/** A book whose entries land in three different places in one request. */
const BOOK = {
  entries: {
    0: {
      uid: 0, key: [], keysecondary: [], comment: 'always, before the card',
      content: 'The city is built on a drained lake.', constant: true, disable: false,
      order: 100, position: 0, depth: 4, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 0, depth: 4, role: 0 },
    },
    1: {
      uid: 1, key: [], keysecondary: [], comment: 'always, at depth zero',
      content: 'Answer in the present tense.', constant: true, disable: false,
      order: 100, position: 4, depth: 0, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 4, depth: 0, role: 0 },
    },
    2: {
      uid: 2, key: ['lake'], keysecondary: [], comment: 'keyword, at depth two',
      content: 'The lake was drained in the year of the long winter.', constant: false, disable: false,
      order: 100, position: 4, depth: 2, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 4, depth: 2, role: 0 },
    },
  },
}

interface Fixture {
  handlers: Handlers
  chatId: string
  /** Assemble the newest turn and hand back the request that would be sent. */
  assemble: () => Promise<GenerateOptions>
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-determinism-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await mkdir(join(dir, 'worlds'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  await writeFile(join(dir, 'worlds', 'atlas.json'), JSON.stringify(BOOK), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const worldbooks = new WorldbookStore(join(dir, 'worlds'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  await settings.load()
  const chats = new ChatStore(
    join(dir, 'chats'), library, undefined, undefined, worldbooks, () => settings.globalSelect())

  const captured: GenerateOptions[] = []
  let answer = true
  const stream: StreamFn = async function* (options) {
    captured.push(options)
    if (!answer) {
      // Refused rather than answered: an appended candidate would change the
      // log, and the second assembly would no longer be of the same state.
      throw new Error('determinism probe: captured, not sent')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'A reply about the lake.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'A reply about the lake.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  let ended = 0
  const handlers = new IrisAppService({
    stream,
    library,
    chats,
    settings,
    worldbooks,
    broadcast: event => {
      if (event.type === 'stream.end' || event.type === 'stream.error') ended += 1
    },
    userName: 'Traveller',
  }).handlers()

  // Selected BEFORE the chat is created: the store reads the selection through
  // a closure when a chat opens, so a book chosen afterwards reaches this
  // conversation only on the next open — and the fixture would then be testing
  // an assembly with no world info in it at all.
  await handlers['worldbook.setGlobalSelect']({ names: ['atlas'] })
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  const settle = async (target: number): Promise<void> => {
    for (let tick = 0; tick < 4_000 && ended < target; tick += 1) {
      await new Promise(done => { setTimeout(done, 1) })
    }
    assert.equal(ended >= target, true, 'a generation never settled')
  }

  // One real exchange, so the assembly under test has history to trim, a
  // keyword to activate on, and depth injections to place relative to.
  await handlers['chat.send']({ chatId, kind: 'send', text: 'Tell me about the lake.' })
  await settle(1)
  answer = false

  return {
    handlers,
    chatId,
    assemble: async () => {
      const before = captured.length
      await handlers['chat.regenerate']({ chatId })
      await settle(ended + 1)
      assert.equal(captured.length, before + 1,
        `expected exactly one captured request, got ${String(captured.length - before)}`)
      return captured[captured.length - 1] as GenerateOptions
    },
  }
}

test('the same chat state assembles to the same request bytes', async (t) => {
  const fix = await fixture(t)

  // The warm-up, and the check that it was enough: with the cache-friendly
  // order on, the depth-anchored parts move into the prefix on the assembly
  // where they settle, so the comparison below has to start after that.
  await fix.assemble()
  await fix.assemble()
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: fix.chatId })
  assert.ok(itemization.entries.some(entry => entry.promoted === true),
    'the warm-up did not reach the steady state, so the comparison below would '
    + 'be between three assemblies that have not settled yet')

  const first = await fix.assemble()
  const second = await fix.assemble()
  const third = await fix.assemble()

  const body = (options: GenerateOptions): string => JSON.stringify(serializeRequest(options))

  // The assertion the whole cache story rests on. If this fails, the request
  // carries something that changes on its own — a clock, a counter, a set that
  // iterated differently — and every hit rate measured afterwards is measuring
  // that instead of the prompt.
  assert.equal(body(first), body(second))
  assert.equal(body(second), body(third))

  // And the fixture is actually exercising the parts that could move. An empty
  // system prompt, or a conversation with no depth injection and no activated
  // world info, would pass the comparison above while proving nothing — the
  // parts most able to jitter would simply not be in the request. So each one
  // is named: a book entry that is always on, one that had to be *activated* by
  // a keyword in the conversation, the card's own note, and the
  // post-history instruction. Written out because the first version of this
  // fixture selected the book after the chat opened and assembled none of them.
  const text = [first.system ?? '', ...first.messages.map(message => message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(''))].join('\n')
  for (const expected of [
    'drained lake', // constant entry, position 0 — the system prompt
    'present tense', // constant entry, depth 0 — after the last message
    'long winter', // keyword entry, depth 2 — activated by "lake" in the chat
    'map room', // the card's own note, depth 2
    'Stay in character', // post_history_instructions, depth 0
  ]) {
    assert.ok(text.includes(expected),
      `"${expected}" never reached the assembled request, so this fixture is not `
      + 'exercising the placement it was written for')
  }
})

test('the request the second assembly captured is the one that would be sent', async (t) => {
  const fix = await fixture(t)
  const options = await fix.assemble()

  // Guards the seam this test measures at: `#stream` runs macros, templates and
  // the residual-macro check before handing the request to `stream`, so a
  // captured request still holding `{{user}}` would mean the capture happens
  // too early and the comparison above is not about the wire.
  const text = [options.system ?? '', ...options.messages.map(message => message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(''))].join('\n')
  assert.equal(/\{\{user\}\}/.test(text), false,
    'the captured request still carries an unexpanded {{user}}, so this is not the wire form')
  assert.ok(text.includes('Traveller'), 'the persona name never reached the captured request')
})
