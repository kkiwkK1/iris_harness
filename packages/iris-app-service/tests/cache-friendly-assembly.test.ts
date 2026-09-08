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
 * The cache-friendly order on the path that actually sends a request.
 *
 * `@iris/pipeline` proves the placement and `cache-friendly.test.ts` proves the
 * classification; this file proves the **wiring** between them, which is where
 * the two could each be right and the product still wrong: the prompt builder
 * has to notice a `{{roll}}` in a world-info entry *before* the scan expands it
 * away, the verdict has to reach both the request and the itemization, the
 * setting has to be able to turn it off byte for byte, and a preview must not
 * advance the classifier's memory.
 *
 * The request is captured at the seam that sees what is sent — the `stream`
 * function the service is built with — and compared through `serializeRequest`,
 * which is what the adapter puts on the wire.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'A retired cartographer.',
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
    extensions: {},
  },
})

/**
 * A book with the two entries this test needs and one it must not move.
 *
 * The volatile one is at `position: 1` (**after** the character definition, a
 * system section) because that is the shape measured on three real
 * conversations: a `{{roll}}` in a world-info entry near the front of the
 * request, holding the whole conversation's ceiling down. The stable one sits
 * on either side of it in the system prompt so the reorder has to lift one
 * section out of the middle rather than truncate at it.
 */
const BOOK = {
  entries: {
    0: {
      uid: 0, key: [], keysecondary: [], comment: 'constant, before the card',
      content: 'The city is built on a drained lake.', constant: true, disable: false,
      order: 200, position: 0, depth: 4, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 0, depth: 4, role: 0 },
    },
    1: {
      uid: 1, key: [], keysecondary: [], comment: 'constant, a die roll after the card',
      content: 'Fortune this scene: {{roll::1d20}}.', constant: true, disable: false,
      order: 150, position: 1, depth: 4, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 1, depth: 4, role: 0 },
    },
    2: {
      uid: 2, key: [], keysecondary: [], comment: 'constant, at depth zero',
      content: 'Answer in the present tense.', constant: true, disable: false,
      order: 100, position: 4, depth: 0, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 4, depth: 0, role: 0 },
    },
  },
}

interface Fixture {
  handlers: Handlers
  chatId: string
  /** Assemble the newest turn and hand back the request that would be sent. */
  assemble: () => Promise<GenerateOptions>
  /**
   * The **very first** request this chat ever assembled — the one the fixture's
   * own `chat.send` produced.
   *
   * It is the only assembly whose classifier memory is empty, and therefore the
   * only one that exercises the *prediction* rather than the content hash. Every
   * later assembly has a stored hash for the die-roll entry and marks it because
   * the two rolls differ, which is a different mechanism reaching the same
   * verdict — a test reading a later request cannot tell the two apart and will
   * stay green with the prediction removed entirely (measured: it did).
   */
  firstEver: GenerateOptions
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-cache-friendly-'))
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
    // Refused rather than answered once the fixture is set up: an appended
    // candidate would change the log, and the next assembly would be of a
    // different state.
    if (!answer) throw new Error('cache-friendly probe: captured, not sent')
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
    broadcast: (event) => {
      if (event.type === 'stream.end' || event.type === 'stream.error') ended += 1
    },
    userName: 'Traveller',
  }).handlers()

  // Selected BEFORE the chat is created: the store reads the selection through
  // a closure when a chat opens, so a book chosen afterwards would reach this
  // conversation only on the next open — and the fixture would assemble no
  // world info at all while every assertion below still passed.
  await handlers['worldbook.setGlobalSelect']({ names: ['atlas'] })
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  const settle = async (target: number): Promise<void> => {
    for (let tick = 0; tick < 4_000 && ended < target; tick += 1) {
      await new Promise(done => { setTimeout(done, 1) })
    }
    assert.equal(ended >= target, true, 'a generation never settled')
  }

  await handlers['chat.send']({ chatId, kind: 'send', text: 'Tell me about the lake.' })
  await settle(1)
  answer = false

  assert.equal(captured.length, 1, 'the fixture should have assembled exactly one request so far')

  return {
    handlers,
    chatId,
    firstEver: captured[0] as GenerateOptions,
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

/** The system prompt and every message's text, in request order. */
function parts(options: GenerateOptions): { role: string, text: string }[] {
  const rows = options.system === undefined || options.system === ''
    ? []
    : [{ role: 'system', text: options.system }]
  for (const message of options.messages) {
    rows.push({
      role: message.role,
      text: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    })
  }
  return rows
}

const body = (options: GenerateOptions): string => JSON.stringify(serializeRequest(options))

test('the first assembly of a chat predicts the die roll before it is expanded', async (t) => {
  const fix = await fixture(t)

  // The chat's very first request, with an empty classifier memory: nothing has
  // been measured, so the only thing that can have moved this section is the
  // **prediction** — and the prediction has to read the world-info entry's text
  // before the scan expands `{{roll::1d20}}` into a number. `PreparedEntry.source`
  // is the only place that text still exists at assembly time; a prediction
  // reading the expanded `content` sees "Fortune this scene: 14." and finds no
  // macro at all.
  assert.equal(/Fortune this scene: \d+\./u.test(fix.firstEver.system ?? ''), false,
    'the die roll reached the first request\'s system prompt, so nothing predicted it')
  const rows = parts(fix.firstEver)
  const rolled = rows.findIndex(row => /Fortune this scene: \d+\./u.test(row.text))
  const floor = rows.findIndex(row => row.text.includes('Tell me about the lake'))
  assert.ok(rolled > floor && floor >= 0, 'the moved segment must be behind the conversation')
})

test('a die roll in a world-info entry is moved out of the system prompt', async (t) => {
  const fix = await fixture(t)

  // Warmed first: the *promote* direction relayouts once, on the assembly where
  // the constant depth entry has finally been observed holding still, and this
  // test is about the *defer* direction. Comparing across that one relayout
  // would make this test fail for a reason it is not asking about.
  await fix.assemble()
  await fix.assemble()
  const first = await fix.assemble()
  const second = await fix.assemble()

  const system = second.system ?? ''
  assert.ok(system.includes('drained lake'),
    'the stable world-info entry must stay in the system prompt')
  assert.equal(/Fortune this scene: \d+\./u.test(system), false,
    'the die-roll entry is still in the system prompt, so it was never classified')

  // It is in the request, after the conversation: moved, not dropped.
  const rows = parts(second)
  const rolled = rows.findIndex(row => /Fortune this scene: \d+\./u.test(row.text))
  const floor = rows.findIndex(row => row.text.includes('Tell me about the lake'))
  assert.ok(rolled > 0, 'the die-roll entry vanished from the request entirely')
  assert.ok(rolled > floor, 'the die-roll entry must sit after the conversation, not before it')

  // Both assemblies agree on the layout. This is the assertion that catches a
  // mark whose lifetime is one generation: with that bug the first assembly
  // moved the section and the second did not, and two assemblies of one
  // unchanged state shared 0.3% of their bytes.
  const layout = (options: GenerateOptions): string[] =>
    parts(options).map(row => `${row.role}:${String(row.text.length > 0)}`)
  assert.deepEqual(layout(first), layout(second))
})

test('a depth-0 entry that holds still is pulled into the prefix', async (t) => {
  const fix = await fixture(t)

  // The constant depth-0 entry is byte-identical every turn, so once it has
  // been *observed* holding still it is worth pulling forward. This is the
  // bigger of the two directions and it is not about volatility at all: a depth
  // injection is anchored to the end of the conversation, so it slides forward
  // one exchange every turn and is re-sent in full even when nothing about it
  // changed. The corpus census measures that rent as 100% depth-anchored; the
  // figures and their source are in the app-service ledger, §38.
  const before = parts(await fix.assemble())
  const early = before.findIndex(row => row.text.includes('present tense'))
  const earlyFloor = before.findIndex(row => row.text.includes('Tell me about the lake'))
  assert.ok(early > earlyFloor,
    'the entry must still be at depth 0 before it has been observed holding still')

  // One more assembly and it has held still for long enough.
  await fix.assemble()
  const rows = parts(await fix.assemble())
  const promoted = rows.findIndex(row => row.text.includes('present tense'))
  const floor = rows.findIndex(row => row.text.includes('Tell me about the lake'))
  assert.ok(promoted >= 0, 'the promoted entry vanished from the request')
  assert.ok(promoted < floor, 'a settled depth entry belongs before the conversation, not after it')
  // In front of the whole conversation but behind the system prompt, which is
  // where the coordinator's ruling puts it: after the preset sections, before
  // the first floor.
  assert.equal(rows[0]?.role, 'system')
  assert.ok((rows[0]?.text ?? '').includes('drained lake'),
    'the system prompt must still lead the request')

  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: fix.chatId })
  // **Both**, and the second one is the loudest cost this feature has.
  // `jailbreak` is the card's `post_history_instructions`, which `resolvePreset`
  // places as a depth-0 contribution — it is *named* for sitting after the
  // conversation, and a constant one is promoted like any other settled depth
  // content. That is what the corpus census's counterfactual measured (it moved
  // every depth-anchored segment, n=9 on one conversation, for 98.0%), so the
  // mechanism matches the measurement rather than carving out an exception the
  // numbers never had. Asserted by name so the day someone decides post-history
  // must stay put, this test says where to put the exception.
  assert.deepEqual(
    itemization.entries.filter(entry => entry.promoted === true).map(entry => entry.id),
    ['jailbreak', 'worldInfo.depth.0.0'])
})

test('the itemization names the moved row and reports a stable prefix', async (t) => {
  const fix = await fixture(t)
  await fix.assemble()

  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: fix.chatId })
  const moved = itemization.entries.filter(entry => entry.deferred === true)
  assert.deepEqual(moved.map(entry => entry.id), ['worldInfoAfter'],
    'the panel has no other way to say a section is not being sent from where it sits')

  // The reading the context card shows. Asserted as a share rather than a token
  // count, because the count is an estimator's output and would go red on a
  // calibration change while the invariant — most of this request is reusable —
  // is what the card is claiming.
  assert.ok(itemization.stablePrefixTokens !== undefined, 'the host must compute a reading, not omit it')
  assert.ok(itemization.stablePrefixTokens > 0)
  assert.ok(itemization.stablePrefixTokens < itemization.tokens,
    'a request holding a volatile depth-0 injection cannot be reusable to its last byte')
})

test('turning the setting off restores SillyTavern order byte for byte', async (t) => {
  const fix = await fixture(t)
  // Warm the classifier so the comparison is not accidentally between two
  // unclassified assemblies, which would agree for the wrong reason.
  await fix.assemble()
  await fix.assemble()

  await fix.handlers['settings.set']({ chatId: fix.chatId, settings: { cacheFriendly: false } })
  const off = await fix.assemble()
  const offAgain = await fix.assemble()

  assert.ok((off.system ?? '').includes('Fortune this scene:'),
    'with the setting off the die roll belongs in the system prompt again')
  // Two assemblies with it off differ only in the roll itself, so the *layout*
  // must be identical and the shared prefix must reach the roll.
  assert.equal(parts(off).length, parts(offAgain).length)

  await fix.handlers['settings.set']({ chatId: fix.chatId, settings: { cacheFriendly: true } })
  const on = await fix.assemble()
  assert.notEqual(body(off), body(on))
  assert.equal(/Fortune this scene: \d+\./u.test(on.system ?? ''), false)
})

test('the host-wide environment switch overrides the setting', async (t) => {
  const fix = await fixture(t)
  await fix.assemble()

  const previous = process.env['IRIS_CACHE_FRIENDLY']
  t.after(() => {
    if (previous === undefined) delete process.env['IRIS_CACHE_FRIENDLY']
    else process.env['IRIS_CACHE_FRIENDLY'] = previous
  })

  // The chat's setting says on (it is the default and nothing has changed it);
  // the environment says no. One line in a service file has to be able to
  // restore upstream order across a whole installation without editing any
  // chat's settings — that is what an operator reaches for when the question is
  // "is the reorder causing this?".
  process.env['IRIS_CACHE_FRIENDLY'] = '0'
  const off = await fix.assemble()
  assert.ok((off.system ?? '').includes('Fortune this scene:'))

  process.env['IRIS_CACHE_FRIENDLY'] = '1'
  const on = await fix.assemble()
  assert.equal(/Fortune this scene: \d+\./u.test(on.system ?? ''), false)
})

test('a preview shows the same layout without advancing the classifier', async (t) => {
  const fix = await fixture(t)

  /** Which rows the preview says are moved, in each direction. */
  const shape = async (): Promise<{ deferred: string[], promoted: string[] }> => {
    const { itemization } = await fix.handlers['prompt.itemize']({ chatId: fix.chatId })
    return {
      deferred: itemization.entries.filter(entry => entry.deferred === true).map(entry => entry.id),
      promoted: itemization.entries.filter(entry => entry.promoted === true).map(entry => entry.id),
    }
  }

  // **Read through the promote direction, not the defer direction**, and read it
  // while the constant depth-0 entry is still one observation short of settling.
  // A read that advanced the classifier's clock would settle it on the *second*
  // preview, so two consecutive previews would disagree — and the next real turn
  // would silently reshuffle the request because someone opened a panel.
  //
  // The defer direction cannot detect this at all: the die-roll section is
  // re-marked on every classification (its content differs every time), so its
  // mark never lapses however far the clock is wound. Checked by making the
  // preview write: the earlier version of this test, which watched `deferred`
  // over twenty-five previews, stayed green.
  const first = await shape()
  const second = await shape()
  const third = await shape()
  assert.deepEqual(first, second)
  assert.deepEqual(second, third)
  assert.deepEqual(first.promoted, [],
    'this fixture must be read before the depth entry settles, or it proves nothing')
  assert.deepEqual(first.deferred, ['worldInfoAfter'])

  // A real turn does advance it, which is the other half of the contract.
  await fix.assemble()
  assert.deepEqual((await shape()).promoted, ['jailbreak', 'worldInfo.depth.0.0'])
})

test('the moved segment survives the squash as its own message', async (t) => {
  const fix = await fixture(t)

  // **No warm-up, deliberately.** The adjacency this test needs is a volatile
  // system message sitting next to a *stable* one, and it only exists before
  // the constant depth-0 entry has settled: once it is promoted it leaves the
  // tail, the moved segment's only neighbour is a conversation floor, and the
  // squash never gets the chance to cross the boundary. Checked by breaking the
  // barrier: with a warm-up this test stayed green.
  await fix.handlers['settings.set']({ chatId: fix.chatId, settings: { squashSystemMessages: true } })
  const squashed = await fix.assemble()
  const rows = parts(squashed)

  // Upstream's squash merges adjacent system messages. If it merged the moved
  // segment into the message in front of it, that message's text would change
  // every turn — reintroducing, one layer down, exactly the miss the reorder
  // was performed to avoid. So the moved text must still be in a message of its
  // own, with nothing of the conversation in it.
  const rolled = rows.filter(row => /Fortune this scene: \d+\./u.test(row.text))
  assert.equal(rolled.length, 1, 'the moved segment was merged away or duplicated')
  assert.equal(rolled[0]?.text.includes('Tell me about the lake'), false,
    'the moved segment absorbed a conversation floor, so the squash crossed the boundary')
  assert.equal(rolled[0]?.text.includes('present tense'), false,
    'the moved segment absorbed the depth-0 injection across the volatile boundary')
})
