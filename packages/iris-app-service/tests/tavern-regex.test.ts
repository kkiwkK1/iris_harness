/**
 * The regex read/write family a card reaches: Tavern Helper's five names.
 *
 * `getTavernRegexes`, `replaceTavernRegexes`, `updateTavernRegexesWith`,
 * `isCharacterTavernRegexesEnabled` and `formatAsTavernRegexedString`
 * (`@types/function/tavern_regex.d.ts:87`, `:103`, `:131`, `:62`, `:23`;
 * implemented at `src/function/tavern_regex.ts:209`, `:260`, `:335`, `:196`,
 * `:27`). This file pins the **host** half — the three wire arms and the
 * vocabulary translation. The frame half is in
 * `apps/iris-web/tests/tavern-regex-facade.test.ts`.
 *
 * What is pinned here, and why each one is worth an assertion:
 *
 * - **The translation, in both directions.** `enabled` is `!disabled`,
 *   `destination` is the two `…Only` flags rather than a partition, and an
 *   absent depth is `null`. Every one of those is silent when it is backwards:
 *   a rule reported enabled that is off, a display rule that rewrites the
 *   request.
 * - **`enabled` is the document author's word, not the user's.** A card that
 *   read the folded value and wrote it back would burn the reader's own
 *   decision into the card file.
 * - **The write's scope.** `'character'` is the chat's own card and nothing
 *   else; `'preset'` is refused rather than silently dropped.
 * - **Fields this vocabulary has no word for survive a write**, matched by id
 *   — where upstream loses `substituteRegex` with a `// TODO: handle this?`.
 * - **The three tiers' run order shows in `formatAsTavernRegexedString`**, as a
 *   chain: each tier's rule makes the input the next tier's rule needs, so no
 *   other ordering produces the answer.
 *
 * @module iris-app-service/tests/tavern-regex
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ChatCompletionPreset } from '@iris/preset'
import type { TavernRegexView } from '@iris/protocol'
import type { RegexScript } from '@iris/regex'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ExtensionSettingsStore } from '../src/context.ts'
import { CharacterLibrary } from '../src/library.ts'
import { PresetStore } from '../src/presets.ts'
import { presetRegexSource, toTavernRegex, tavernRegexId } from '../src/regex.ts'
import { ScriptPolicyStore } from '../src/scripts.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * One stored rule, as a card file carries it.
 *
 * `substituteRegex: 2` and the unknown `authorNote` key are the fixture's whole
 * point on the write path: neither has a word in Tavern Helper's vocabulary, so
 * a card that reads this rule, toggles it and writes it back can only preserve
 * them if the host carries them across.
 */
const CARD_RULE: RegexScript = {
  id: 'card-1',
  scriptName: 'hide the state block',
  findRegex: '/<state>[\\s\\S]*?<\\/state>/g',
  replaceString: '',
  trimStrings: ['噪音'],
  placement: [1, 2],
  disabled: false,
  markdownOnly: true,
  promptOnly: false,
  runOnEdit: true,
  substituteRegex: 2,
  minDepth: -1,
  maxDepth: 4,
  authorNote: 'kept by the author',
}

/** A card file with the tier above. */
function cardFile(rules: readonly RegexScript[] = [CARD_RULE]): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria', description: '', personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1',
      extensions: { regex_scripts: rules.map(rule => ({ ...rule })) },
    },
  })
}

/** A preset carrying one runnable rule and one the reader must refuse. */
function presetBody(rules: readonly Record<string, unknown>[]): ChatCompletionPreset {
  return {
    prompts: [],
    prompt_order: [],
    extensions: { regex_scripts: rules },
  } as unknown as ChatCompletionPreset
}

/** A stream that replies with one fixed text. */
function scriptedStream(reply: string): StreamFn {
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * A host with one `.json` card, a policy store, a global tier and a preset.
 *
 * The card is a `.json` file rather than a PNG because the write arm has to
 * really write it: `CharacterLibrary.setScopedRegex` goes through the same
 * `#mutateCard` a rename uses, and a fixture that could not be rewritten would
 * leave the write path exercised only as far as the call.
 */
async function fixture(t: TestContext, options: {
  card?: readonly RegexScript[]
  global?: readonly RegexScript[]
  preset?: readonly Record<string, unknown>[]
} = {}): Promise<{
  dir: string
  handlers: Handlers
  policy: ScriptPolicyStore
  chats: ChatStore
  cardPath: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-tavern-regex-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  const cardPath = join(dir, 'characters', 'aria.json')
  await writeFile(cardPath, cardFile(options.card ?? [CARD_RULE]), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const extensionSettings = new ExtensionSettingsStore(join(dir, 'extension-settings.json'))
  const policy = new ScriptPolicyStore(join(dir, 'script-policy.json'))
  const presets = new PresetStore(join(dir, 'presets'))
  if (options.preset !== undefined) {
    await presets.save('狐神抚', presetBody(options.preset))
    await settings.setPreset('狐神抚', presetBody(options.preset))
    // The tier arrives refused (§53), so every preset test here has to allow it
    // deliberately — which is itself the default worth having in the fixture.
    await policy.setPresetRegexAllowed('狐神抚', true)
  }
  if (options.global !== undefined) {
    await extensionSettings.setGlobalRegex(options.global.map(rule => ({
      ...rule,
      scriptName: rule.scriptName ?? 'global',
    })) as never)
  }

  const chats = new ChatStore(
    join(dir, 'chats'), library,
    undefined, undefined, undefined,
    () => [], undefined, undefined,
    () => extensionSettings.globalRegex(),
    undefined, undefined,
    characterId => policy.scopedRegex(characterId),
    presetRegexSource(
      () => ({ name: settings.presetName(), body: settings.presetBody() }),
      presetName => policy.presetRegex(presetName),
    ),
  )

  const handlers = new IrisAppService({
    stream: scriptedStream('plain'),
    library, chats, settings, presets,
    scripts: policy,
    extensionSettings,
    broadcast: () => undefined,
    userName: 'Traveller',
  }).handlers()

  return { dir, handlers, policy, chats, cardPath }
}

/** A conversation to ask about. */
async function chatOf(handlers: Handlers): Promise<string> {
  return (await handlers['chat.create']({ characterId: 'aria' })).view.chatId
}

// ── the vocabulary, read ────────────────────────────────────────────────────

test('a card tier is reported in Tavern Helper’s own spelling, field for field', async (t) => {
  const { handlers } = await fixture(t)
  const chatId = await chatOf(handlers)

  const { regexes } = await handlers['regex.tavernList']({ chatId, tier: 'character' })
  assert.equal(regexes.length, 1)
  const [rule] = regexes
  assert.deepEqual(rule, {
    id: 'card-1',
    script_name: 'hide the state block',
    // `!disabled`, and the inversion is the assertion: a rule the card shipped
    // on must not read as off.
    enabled: true,
    find_regex: CARD_RULE.findRegex,
    replace_string: '',
    trim_strings: ['噪音'],
    // From `placement: [1, 2]`, and the three unnamed placements are false
    // rather than absent — a card testing `source.reasoning` must get a
    // boolean.
    source: {
      user_input: true,
      ai_output: true,
      slash_command: false,
      world_info: false,
      reasoning: false,
    },
    // The two `…Only` flags, not a partition: this rule is display-only, so
    // `prompt` is false and both being false would have been legal too.
    destination: { display: true, prompt: false },
    run_on_edit: true,
    min_depth: -1,
    max_depth: 4,
  } satisfies TavernRegexView)
})

test('a rule with no depth window reads as null, never as absent or zero', async (t) => {
  // The keys are **removed**, not set to `undefined`: a document that never
  // carried a depth window is the case, and `exactOptionalPropertyTypes` is
  // right to insist the two are different.
  const { minDepth: _min, maxDepth: _max, ...noWindow } = CARD_RULE
  const { handlers } = await fixture(t, { card: [noWindow] })
  const chatId = await chatOf(handlers)
  const { regexes } = await handlers['regex.tavernList']({ chatId, tier: 'character' })

  // `null` and not `0`: `0` is a real bound upstream honours (`maxDepth >= 0`),
  // so reporting an unset window as zero would say "only the last message".
  assert.equal(regexes[0]?.min_depth, null)
  assert.equal(regexes[0]?.max_depth, null)
  assert.ok('min_depth' in (regexes[0] ?? {}), 'the key must be present, carrying null')
})

test('`enabled` is what the card shipped, even after the user switches a rule off', async (t) => {
  const { handlers, policy } = await fixture(t)
  const chatId = await chatOf(handlers)
  await policy.setScopedRegexEnabled('aria', 'card-1', false)

  const { regexes } = await handlers['regex.tavernList']({ chatId, tier: 'character' })
  /*
   * The whole reason this file exists as a separate reading from
   * `regex.scopedList`. Upstream has **one** switch, `!disabled`, so that is
   * what a card must see; the user's override lives in the policy file and is
   * reported to the *panel* through `ScopedRegexView.enabled`.
   *
   * Folding it in here would be worse than a wrong number: a card reading
   * `enabled: false` and writing the tier back — which is exactly what
   * `updateTavernRegexesWith`'s own documented example does — would write
   * `disabled: true` into the card file and make the reader's temporary
   * decision permanent and exportable.
   */
  assert.equal(regexes[0]?.enabled, true, 'the user’s override must not reach the card’s reading')
  // And the panel's reading still folds it in, which is the pair that makes
  // this assertion mean something rather than just describing the code.
  const panel = await handlers['regex.scopedList']({ characterId: 'aria' })
  assert.equal(panel.scripts[0]?.enabledByCard, true)
  assert.equal(panel.scripts[0]?.enabled, false)
})

test('a refused tier is still listed, as upstream’s ungated reader lists it', async (t) => {
  const { handlers, policy } = await fixture(t)
  const chatId = await chatOf(handlers)
  await policy.setScopedRegexAllowed('aria', false)

  const { regexes } = await handlers['regex.tavernList']({ chatId, tier: 'character' })
  // `get_tavern_regexes_without_clone` takes no `allowedOnly`; only the engine
  // asks for that. An empty list here would read as a card with no rules.
  assert.equal(regexes.length, 1, 'refusing the tier must not hide what the card carries')
})

test('the preset tier drops the rows the engine cannot run, and says nothing else', async (t) => {
  const { handlers } = await fixture(t, {
    preset: [
      { id: 'p-live', scriptName: 'live', findRegex: '/x/g', replaceString: 'y', placement: [2] },
      // A UI separator, as the measured preset really ships: an empty pattern
      // matches at every position, so running it would splice its replacement
      // between every character of every message.
      { id: 'p-separator', scriptName: '——', findRegex: '', replaceString: '', placement: [2] },
    ],
  })
  const chatId = await chatOf(handlers)

  const { regexes } = await handlers['regex.tavernList']({ chatId, tier: 'preset' })
  assert.deepEqual(regexes.map(rule => rule.id), ['p-live'])
})

test('the global tier answers from the profile’s own list', async (t) => {
  const { handlers } = await fixture(t, {
    global: [{ id: 'g-1', scriptName: 'g', findRegex: '/A/g', replaceString: 'B', placement: [2] }],
  })
  const chatId = await chatOf(handlers)

  const { regexes } = await handlers['regex.tavernList']({ chatId, tier: 'global' })
  assert.deepEqual(regexes.map(rule => rule.id), ['g-1'])
})

test('a rule the document never named gets a derived handle, and the same one twice', async (t) => {
  const unnamed: RegexScript = {
    scriptName: 'no id', findRegex: '/A/g', replaceString: 'B', placement: [2],
  }
  const { handlers } = await fixture(t, { card: [unnamed] })
  const chatId = await chatOf(handlers)

  const first = await handlers['regex.tavernList']({ chatId, tier: 'character' })
  const second = await handlers['regex.tavernList']({ chatId, tier: 'character' })
  const id = first.regexes[0]?.id ?? ''
  assert.ok(id.startsWith('iris-derived-'), `a derived id must say so, got ${id}`)
  // Derived from content, so two reads agree and a card can round-trip. A
  // freshly minted id would make every read a different rule.
  assert.equal(second.regexes[0]?.id, id, 'two reads of one document must agree')
  // And it is content, not position: the same rule at another index keeps it.
  assert.equal(tavernRegexId({ ...unnamed }), id)
  assert.notEqual(tavernRegexId({ ...unnamed, findRegex: '/C/g' }), id)
})

// ── the write ───────────────────────────────────────────────────────────────

test('writing the card tier rewrites the card file, and the read-back shows it', async (t) => {
  const { handlers, cardPath } = await fixture(t)
  const chatId = await chatOf(handlers)
  const { regexes } = await handlers['regex.tavernList']({ chatId, tier: 'character' })

  const answer = await handlers['regex.tavernReplace']({
    chatId,
    tier: 'character',
    regexes: regexes.map(rule => ({ ...rule, enabled: false })),
  })
  assert.equal(answer.regexes[0]?.enabled, false, 'the answer must be the stored tier')

  // The file, not the cache: the tier lives in the document, so a write that
  // only changed an in-memory copy would be lost on the next decode.
  const stored = JSON.parse(await readFile(cardPath, 'utf8')) as {
    data: { extensions: { regex_scripts: RegexScript[] } }
  }
  assert.equal(stored.data.extensions.regex_scripts[0]?.disabled, true)
})

test('a write carries across every field Tavern Helper has no word for', async (t) => {
  const { handlers, cardPath } = await fixture(t)
  const chatId = await chatOf(handlers)
  const { regexes } = await handlers['regex.tavernList']({ chatId, tier: 'character' })

  await handlers['regex.tavernReplace']({
    chatId,
    tier: 'character',
    regexes: regexes.map(rule => ({ ...rule, script_name: 'renamed' })),
  })

  const stored = JSON.parse(await readFile(cardPath, 'utf8')) as {
    data: { extensions: { regex_scripts: Record<string, unknown>[] } }
  }
  const rule = stored.data.extensions.regex_scripts[0] ?? {}
  assert.equal(rule['scriptName'], 'renamed', 'the field the card did name must change')
  /*
   * The deliberate departure from upstream, which writes `substituteRegex: 0`
   * with a `// TODO: handle this?` — so on real SillyTavern this rule's escaped
   * macro mode silently becomes "no macros" the first time any card reorders
   * the tier, and no card could have prevented it because
   * `getTavernRegexes` never showed the field.
   */
  assert.equal(rule['substituteRegex'], 2, 'the macro mode must survive a card’s write')
  assert.equal(rule['authorNote'], 'kept by the author', 'an unknown key must survive too')
})

test('a rule sent with a blank name is stored under upstream’s own placeholder', async (t) => {
  const { handlers } = await fixture(t)
  const chatId = await chatOf(handlers)
  const { regexes } = await handlers['regex.tavernList']({ chatId, tier: 'character' })

  const answer = await handlers['regex.tavernReplace']({
    chatId,
    tier: 'character',
    regexes: regexes.map(rule => ({ ...rule, script_name: '' })),
  })
  // `未命名-${id}`, character for character: upstream renames before it stores
  // (`src/function/tavern_regex.ts:261-265`), and a card that reads the tier
  // back is reading that string.
  assert.equal(answer.regexes[0]?.script_name, '未命名-card-1')
})

test('a rule absent from the array is deleted, because the write is wholesale', async (t) => {
  const second: RegexScript = {
    id: 'card-2', scriptName: 'second', findRegex: '/B/g', replaceString: 'C', placement: [2],
  }
  const { handlers } = await fixture(t, { card: [CARD_RULE, second] })
  const chatId = await chatOf(handlers)

  await handlers['regex.tavernReplace']({
    chatId,
    tier: 'character',
    regexes: [toTavernRegex(second)],
  })
  const { regexes } = await handlers['regex.tavernList']({ chatId, tier: 'character' })
  assert.deepEqual(regexes.map(rule => rule.id), ['card-2'])
})

test('writing the preset tier is refused by name, not silently dropped', async (t) => {
  const { handlers } = await fixture(t, {
    preset: [{ id: 'p-1', scriptName: 'p', findRegex: '/x/g', replaceString: 'y', placement: [2] }],
  })
  const chatId = await chatOf(handlers)

  await assert.rejects(
    handlers['regex.tavernReplace']({ chatId, tier: 'preset', regexes: [] }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /read-only/, 'the refusal must say why, not just refuse')
      return true
    },
  )
  // And nothing moved: a refusal that had half-applied would be worse than one
  // that answered.
  const { regexes } = await handlers['regex.tavernList']({ chatId, tier: 'preset' })
  assert.deepEqual(regexes.map(rule => rule.id), ['p-1'])
})

test('a rule a card writes reaches the conversation that is already open', async (t) => {
  const { handlers, chats } = await fixture(t, { card: [] })
  const chatId = await chatOf(handlers)
  // Composed once at open time, so this is the reading that would go stale.
  assert.deepEqual((await chats.open(chatId)).scripts.map(rule => rule.id), [])

  await handlers['regex.tavernReplace']({
    chatId,
    tier: 'character',
    regexes: [toTavernRegex(CARD_RULE)],
  })

  /*
   * `#refreshRegex`, the same net every other regex write uses. Without it the
   * composed list each open entry holds is a fact about the past: the card
   * would be told its rule was stored, and no page would change until the
   * conversation happened to be reopened.
   */
  assert.deepEqual((await chats.open(chatId)).scripts.map(rule => rule.id), ['card-1'])
})

test('a conversation with no card has no card tier, and the refusal says so', async (t) => {
  const { handlers, chats } = await fixture(t)
  const chatId = await chatOf(handlers)
  // A chat whose character is gone is the shape upstream resolves through
  // `RawCharacter.findIndex` returning -1; here there is no name to resolve at
  // all, so the conversation itself is the only handle.
  const entry = await chats.open(chatId)
  delete (entry.header as Record<string, unknown>)['iris']
  ;(entry.header as Record<string, unknown>)['iris'] = { ...entry.meta, characterId: undefined }

  await assert.rejects(
    handlers['regex.tavernList']({ chatId, tier: 'character' }),
    /no character card/,
  )
})

// ── the format arm ──────────────────────────────────────────────────────────

test('the three tiers run in upstream’s order, visibly, as a chain', async (t) => {
  const { handlers } = await fixture(t, {
    /*
     * Each rule makes the input the next tier's rule needs, so the answer 'D'
     * is reachable by exactly one ordering: global, preset, card.
     *
     * All three are `promptOnly`, and that is not decoration — see the test
     * below. This member always sets one of `isMarkdown`/`isPrompt`, so a rule
     * marked neither never runs through it at all, and a chain built out of
     * permanent rules would answer 'A' whatever the order was.
     */
    card: [{
      id: 'c', scriptName: 'c', findRegex: '/C/g', replaceString: 'D',
      placement: [2], promptOnly: true,
    }],
    global: [{
      id: 'g', scriptName: 'g', findRegex: '/A/g', replaceString: 'B',
      placement: [2], promptOnly: true,
    }],
    preset: [{
      id: 'p', scriptName: 'p', findRegex: '/B/g', replaceString: 'C',
      placement: [2], promptOnly: true,
    }],
  })
  const chatId = await chatOf(handlers)

  const { text } = await handlers['regex.tavernFormat']({
    chatId, text: 'A', source: 'ai_output', destination: 'prompt',
  })
  assert.equal(text, 'D', 'the tiers did not compose global → preset → card')
})

test('a rule marked neither display nor prompt never runs through this member', async (t) => {
  const { handlers } = await fixture(t, {
    card: [{ id: 'perm', scriptName: 'permanent', findRegex: '/x/g', replaceString: 'hit', placement: [2] }],
  })
  const chatId = await chatOf(handlers)

  /*
   * Upstream's third branch, and the one that surprises people: a rule with
   * neither `markdownOnly` nor `promptOnly` runs only when the string is being
   * neither rendered nor sent (`engine.js:354`, with the reasoning in the
   * comment there — the stored text was already rewritten when it was saved).
   * `formatAsTavernRegexedString` always sets one of the two, so this member
   * can never reach a permanent rule, on either host.
   *
   * Pinned because it looks like a bug from the outside: a card author calls
   * this with the card's own rule and sees the text come back untouched.
   */
  for (const destination of ['display', 'prompt'] as const) {
    const { text } = await handlers['regex.tavernFormat']({
      chatId, text: 'x', source: 'ai_output', destination,
    })
    assert.equal(text, 'x', `a permanent rule must not run for ${destination}`)
  }
})

test('the destination decides which rules run, and the two sides disagree', async (t) => {
  const { handlers } = await fixture(t, {
    card: [
      {
        id: 'd', scriptName: 'display', findRegex: '/x/g', replaceString: 'shown',
        placement: [2], markdownOnly: true,
      },
      {
        id: 'p', scriptName: 'prompt', findRegex: '/x/g', replaceString: 'sent',
        placement: [2], promptOnly: true,
      },
    ],
  })
  const chatId = await chatOf(handlers)

  const display = await handlers['regex.tavernFormat']({
    chatId, text: 'x', source: 'ai_output', destination: 'display',
  })
  const prompt = await handlers['regex.tavernFormat']({
    chatId, text: 'x', source: 'ai_output', destination: 'prompt',
  })
  assert.equal(display.text, 'shown')
  assert.equal(prompt.text, 'sent')
})

test('the source decides which rules run, across all five placements', async (t) => {
  const { handlers } = await fixture(t, {
    card: [{
      id: 'r', scriptName: 'reasoning only', findRegex: '/x/g', replaceString: 'hit',
      // 6 is `REASONING`; `4` is missing upstream (it was `sendAs`) and `0` is
      // the retired `MD_DISPLAY`, so the five sources really are 1,2,3,5,6.
      placement: [6], promptOnly: true,
    }],
  })
  const chatId = await chatOf(handlers)

  const reasoning = await handlers['regex.tavernFormat']({
    chatId, text: 'x', source: 'reasoning', destination: 'prompt',
  })
  const output = await handlers['regex.tavernFormat']({
    chatId, text: 'x', source: 'ai_output', destination: 'prompt',
  })
  assert.equal(reasoning.text, 'hit')
  assert.equal(output.text, 'x', 'a rule placed on reasoning must not touch AI output')
})

test('an absent depth means the depth window is not considered at all', async (t) => {
  const { handlers } = await fixture(t, {
    card: [{
      id: 'deep', scriptName: 'deep only', findRegex: '/x/g', replaceString: 'hit',
      placement: [2], promptOnly: true, minDepth: 5,
    }],
  })
  const chatId = await chatOf(handlers)

  // Upstream's own wording, and its engine's `typeof depth === 'number'` gate:
  // with no depth the rule applies regardless of its window.
  const unstated = await handlers['regex.tavernFormat']({
    chatId, text: 'x', source: 'ai_output', destination: 'prompt',
  })
  assert.equal(unstated.text, 'hit', 'no depth must mean no depth filtering')

  const shallow = await handlers['regex.tavernFormat']({
    chatId, text: 'x', source: 'ai_output', destination: 'prompt', depth: 0,
  })
  assert.equal(shallow.text, 'x', 'a stated depth outside the window must skip the rule')
})

test('macros expand over the result, including in text no rule touched', async (t) => {
  const { handlers } = await fixture(t, { card: [] })
  const chatId = await chatOf(handlers)

  /*
   * Upstream's second step, `substituteParams(result, …)`
   * (`src/function/tavern_regex.ts:51`). Worth pinning separately from the
   * rules because it is the half a reader does not expect: this member expands
   * macros even on a host with no regex rules at all, so returning the text
   * unchanged would be a plausible-looking wrong answer.
   */
  const { text } = await handlers['regex.tavernFormat']({
    chatId, text: 'hello {{user}}', source: 'ai_output', destination: 'display',
  })
  assert.equal(text, 'hello Traveller')
})

test('character_name overrides {{char}} for this call only', async (t) => {
  const { handlers } = await fixture(t, { card: [] })
  const chatId = await chatOf(handlers)

  const overridden = await handlers['regex.tavernFormat']({
    chatId, text: '{{char}} smiles', source: 'ai_output', destination: 'display',
    characterName: '别人',
  })
  const plain = await handlers['regex.tavernFormat']({
    chatId, text: '{{char}} smiles', source: 'ai_output', destination: 'display',
  })
  // Upstream's `name2Override`. The pair is the assertion: an implementation
  // that ignored the argument would pass the second line and fail the first,
  // and one that leaked the override into the chat would fail the second.
  assert.equal(overridden.text, '别人 smiles')
  assert.equal(plain.text, 'Aria smiles')
})

test('a refused card tier does not rewrite text, and the gate is reported', async (t) => {
  const { handlers } = await fixture(t, {
    card: [{
      id: 'c', scriptName: 'c', findRegex: '/x/g', replaceString: 'hit',
      placement: [2], promptOnly: true,
    }],
  })
  const chatId = await chatOf(handlers)

  const before = await handlers['regex.tavernFormat']({
    chatId, text: 'x', source: 'ai_output', destination: 'prompt',
  })
  assert.equal(before.text, 'hit')
  assert.equal(
    (await handlers['script.context']({ chatId, characterId: 'aria' })).context.characterRegexAllowed,
    true,
    'absent from the store means allowed here — §30, and the snapshot must say so',
  )

  // Through the handler, not the store: the handler is what refreshes the
  // conversations that are already open, and a test writing the store directly
  // would pass while the product left the old chain running.
  await handlers['regex.setScopedAllowed']({ characterId: 'aria', allowed: false })
  const after = await handlers['regex.tavernFormat']({
    chatId, text: 'x', source: 'ai_output', destination: 'prompt',
  })
  // The pair: the same call, the same text, and the only thing that changed is
  // the gate `isCharacterTavernRegexesEnabled()` reports.
  assert.equal(after.text, 'x', 'a refused tier must not rewrite anything')
  assert.equal(
    (await handlers['script.context']({ chatId, characterId: 'aria' })).context.characterRegexAllowed,
    false,
  )
})
