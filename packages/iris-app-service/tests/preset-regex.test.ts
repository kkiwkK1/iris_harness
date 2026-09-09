import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CharacterCard } from '@iris/character'
import type { ChatCompletionPreset } from '@iris/preset'
import type { IrisEvent, RegexScriptView } from '@iris/protocol'
import { SCRIPT_TYPE, TIER_ORDER, type RegexScript } from '@iris/regex'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ExtensionSettingsStore } from '../src/context.ts'
import { CharacterLibrary } from '../src/library.ts'
import { PresetStore } from '../src/presets.ts'
import {
  presetRegexSource,
  readPresetRegex,
  scriptsOf,
  type PresetRegexTier,
} from '../src/regex.ts'
import { ScriptPolicyStore } from '../src/scripts.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { textOf } from '../src/views.ts'

/**
 * The active preset's own regex tier — upstream's third one.
 *
 * SillyTavern runs three tiers in declaration order: global, **preset**,
 * character (`extensions/regex/engine.js:11-16`, consumed at `:99`). The preset
 * one reads the active preset file's own `extensions.regex_scripts` (`:126`)
 * and is refused unless the preset's *name* is in
 * `extension_settings.preset_allowed_regex[api]` (`:126-128`;
 * `getRegexedString` is the one caller that asks for `allowedOnly: true`,
 * `:346`). Iris carried two of the three until 2026-09-09 while storing the
 * switched-in preset body whole, `extensions` included — so the tier's input
 * was on disk the whole time and nothing read it (§47, now §53).
 *
 * **Why the switch is off by default here.** The one preset measured for §47
 * ships 40 rules, 18 live: six `promptOnly` ones that strip the model's own
 * draft and option blocks out of what it reads back, and twelve `markdownOnly`
 * prettifiers. Importing a preset must not silently acquire eighteen rewrite
 * rules, and the local ST install's own allow-list does not name either of the
 * operator's presets — so "ST runs these and Iris does not" was never
 * established for that install either.
 *
 * What is pinned here: the tier's *position* in the run order, the gate and the
 * direction of its default, the per-rule switch, the two stages
 * (`promptOnly` vs `markdownOnly`) reaching different sides, a preset switch
 * taking the tier with it, and the unrunnable rows being dropped **and
 * counted** rather than run or silently lost.
 */

/** The `promptOnly` half: strips a block out of what the model reads. */
const PROMPT_RULE: RegexScriptView = {
  id: 'preset-prompt',
  scriptName: 'strip the draft block from the request',
  findRegex: '/<draft>[\\s\\S]*?<\\/draft>/g',
  replaceString: '',
  trimStrings: [],
  placement: [1, 2],
  disabled: false,
  markdownOnly: false,
  promptOnly: true,
  runOnEdit: false,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
}

/** The `markdownOnly` half: changes the page and no byte of any request. */
const DISPLAY_RULE: RegexScriptView = {
  id: 'preset-display',
  scriptName: 'prettify the thinking block',
  findRegex: '/<think>([\\s\\S]*?)<\\/think>/g',
  replaceString: '[thought: $1]',
  trimStrings: [],
  placement: [2],
  disabled: false,
  markdownOnly: true,
  promptOnly: false,
  runOnEdit: false,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
}

/** One the preset's author shipped switched off. */
const OFF_RULE: RegexScriptView = {
  id: 'preset-off',
  scriptName: 'an alternate skin',
  findRegex: '/<draft>/g',
  replaceString: '<div>',
  placement: [2],
  disabled: true,
}

/**
 * The separator every implementation has to survive.
 *
 * `findRegex` empty with `disabled: false` — two of the measured preset's 40
 * rules are exactly this. `new RegExp('')` matches at every position, so
 * running one would splice its `replaceString` between every character of
 * every message: this is not a harmless no-op that can be passed through.
 */
const SEPARATOR: RegexScriptView = {
  id: 'preset-separator',
  scriptName: '——————',
  findRegex: '',
  replaceString: '',
  placement: [2],
  disabled: false,
}

/** A preset body carrying the four rows above, or none at all. */
function presetBody(rules?: readonly RegexScriptView[]): ChatCompletionPreset {
  return {
    prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Be brief.' }],
    ...rules === undefined ? {} : { extensions: { regex_scripts: rules } },
  } as unknown as ChatCompletionPreset
}

/** The preset with all four rows, and the one that carries no tier at all. */
const WITH_REGEX = presetBody([PROMPT_RULE, DISPLAY_RULE, OFF_RULE, SEPARATOR])
const WITHOUT_REGEX = presetBody()

/** A V2 card file with no regex tier of its own, so the preset's is the only one. */
function cardFile(): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria', description: '', personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1', extensions: {},
    },
  })
}

/** A stream that replies with one fixed text and records what it was asked. */
function scriptedStream(reply: string, seen: GenerateOptions[]): StreamFn {
  return async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
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

/**
 * A host with a two-preset library, one card, and the preset tier wired.
 *
 * The wiring goes through `presetRegexSource` — the same factory the plugin
 * composition uses — rather than a hand-rolled closure, because that closure
 * *is* the feature's wiring: which reading of "the active preset" the runner
 * takes, and what becomes of the rows it refused. A copy here would leave the
 * real one unpinned.
 */
async function fixture(t: TestContext, reply = 'plain'): Promise<{
  dir: string
  handlers: Handlers
  policy: ScriptPolicyStore
  chats: ChatStore
  seen: GenerateOptions[]
  malformed: PresetRegexTier[]
  events: IrisEvent[]
  settled: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-preset-regex-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), cardFile(), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const extensionSettings = new ExtensionSettingsStore(join(dir, 'extension-settings.json'))
  const policy = new ScriptPolicyStore(join(dir, 'script-policy.json'))
  const presets = new PresetStore(join(dir, 'presets'))
  await presets.save('狐神抚', WITH_REGEX)
  await presets.save('咩咩', WITHOUT_REGEX)

  const malformed: PresetRegexTier[] = []
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
      tier => { malformed.push(tier) },
    ),
  )

  const seen: GenerateOptions[] = []
  const events: IrisEvent[] = []
  let ends = 0
  let waited = 0
  const handlers = new IrisAppService({
    stream: scriptedStream(reply, seen),
    library, chats, settings, presets,
    scripts: policy,
    extensionSettings,
    broadcast: event => {
      events.push(event)
      if (event.type === 'stream.end') ends += 1
    },
    userName: 'Traveller',
  }).handlers()

  return {
    dir, handlers, policy, chats, seen, malformed, events,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/** The card, as `scriptsOf` takes it. */
function decoded(): CharacterCard {
  return JSON.parse(cardFile()) as CharacterCard
}

/** An allowed tier over the two live rules, as the composer would receive it. */
function allowedTier(scripts: readonly RegexScript[] = [
  PROMPT_RULE as RegexScript, DISPLAY_RULE as RegexScript,
]): PresetRegexTier {
  return {
    presetName: '狐神抚',
    scripts,
    policy: { allowed: true, enabled: {} },
    malformed: 0,
  }
}

// ── the run order ───────────────────────────────────────────────────────────

test('the preset tier runs between the global tier and the card’s own', () => {
  const global: RegexScript = { scriptName: 'g', findRegex: '/A/g', replaceString: 'B', placement: [2] }
  const card = JSON.parse(JSON.stringify({
    ...JSON.parse(cardFile()) as Record<string, unknown>,
  })) as CharacterCard
  ;(card.data.extensions as Record<string, unknown>)['regex_scripts'] = [
    { scriptName: 'c', findRegex: '/C/g', replaceString: 'D', placement: [2] },
  ]
  const preset: RegexScript = { scriptName: 'p', findRegex: '/B/g', replaceString: 'C', placement: [2] }

  const composed = scriptsOf(card, [global], { allowed: true, enabled: {} }, allowedTier([preset]))
  // The middle position is the assertion, and it is observable as a *chain*:
  // the global rule makes the B the preset rule needs, and the preset rule
  // makes the C the card's rule needs. Any other ordering breaks the chain.
  assert.deepEqual(
    composed.map(script => script.replaceString),
    ['B', 'C', 'D'],
    'the tiers did not compose global → preset → card',
  )
  // And upstream's numbering still disagrees with its iteration order, which is
  // the property that made this bug invisible before there was a tier to
  // observe it with (§35). If a renumbering ever makes the two agree, the case
  // above stops discriminating and this line says so.
  assert.ok(
    SCRIPT_TYPE.PRESET > SCRIPT_TYPE.SCOPED && TIER_ORDER[SCRIPT_TYPE.PRESET] < TIER_ORDER[SCRIPT_TYPE.SCOPED],
    'the tier number and the run order agree now, so the ordering test no longer discriminates',
  )
})

// ── the gate ────────────────────────────────────────────────────────────────

test('the preset tier does not run until the preset is allow-listed', () => {
  // Absent, refused, and allowed — three calls, because the default is the
  // whole ruling: **upstream's own**, unlike the card tier one file over, and a
  // later round that flips it has to change this line and say why (§53).
  assert.equal(scriptsOf(decoded(), []).length, 0, 'a tier nobody passed ran anyway')
  assert.equal(
    scriptsOf(decoded(), [], undefined, {
      ...allowedTier(), policy: { allowed: false, enabled: {} },
    }).length,
    0,
    'a preset that is not allow-listed ran its rules — the gate does nothing',
  )
  assert.equal(
    scriptsOf(decoded(), [], undefined, allowedTier()).length,
    2,
    'an allow-listed preset’s rules did not run',
  )
})

test('the user’s per-rule switch overrides the preset author’s, in both directions', () => {
  const tier = allowedTier([PROMPT_RULE as RegexScript, OFF_RULE as RegexScript])
  const off = scriptsOf(decoded(), [], undefined, {
    ...tier, policy: { allowed: true, enabled: { 'preset-prompt': false } },
  })
  assert.equal(off.length, 2, 'a switched-off rule should still be handed to the engine, marked')
  assert.equal(
    off.find(rule => rule.id === 'preset-prompt')?.disabled,
    true,
    'the user switched a rule off and it is still enabled',
  )
  const on = scriptsOf(decoded(), [], undefined, {
    ...tier, policy: { allowed: true, enabled: { 'preset-off': true } },
  })
  assert.equal(
    on.find(rule => rule.id === 'preset-off')?.disabled,
    false,
    'the user switched a preset-disabled rule on and it stayed off',
  )
  // And the preset's own object is never rewritten to record the decision —
  // §31's ruling, applied to a file that travels even more freely than a card.
  assert.equal(OFF_RULE.disabled, true, 'the override was written into the preset’s own rule')
})

// ── the reader ──────────────────────────────────────────────────────────────

test('a row with an empty pattern is dropped and counted, not run', () => {
  const read = readPresetRegex(WITH_REGEX)
  assert.equal(read.malformed, 1, 'the separator row was not counted as unrunnable')
  assert.deepEqual(
    read.scripts.map(script => script.id),
    ['preset-prompt', 'preset-display', 'preset-off'],
    'the reader kept the separator, whose empty pattern matches at every position',
  )
  // The engine's own reading of an empty pattern, stated so the drop is
  // justified by behaviour rather than by taste: this is what would happen if
  // the row were passed through.
  assert.equal('abc'.replace(new RegExp('', 'g'), '!'), '!a!b!c!')
})

test('a preset body with no tier, and a body that is not a preset, read as empty', () => {
  assert.deepEqual(readPresetRegex(WITHOUT_REGEX), { scripts: [], malformed: 0 })
  assert.deepEqual(readPresetRegex(undefined), { scripts: [], malformed: 0 })
  assert.deepEqual(readPresetRegex({ extensions: { regex_scripts: 'nonsense' } }), { scripts: [], malformed: 0 })
})

// ── the wire surface ────────────────────────────────────────────────────────

test('the tier is listed, refused, before anyone has allowed it', async (t) => {
  const { handlers } = await fixture(t)
  await handlers['preset.select']({ name: '狐神抚' })
  const listed = await handlers['regex.presetList']({})
  assert.equal(listed.presetName, '狐神抚')
  assert.equal(listed.allowed, false, 'a preset nobody has allowed reads as allowed')
  // Listed anyway — the assertion this test exists for. A refused tier
  // answering with an empty list would leave a reader no way to find out that
  // the preset they imported carries rules at all, which for this tier is the
  // *normal* state rather than an edge case.
  assert.equal(listed.scripts.length, 3, 'a refused tier answered with an empty list')
  assert.equal(listed.malformed, 1, 'the unrunnable row is not reported to the panel')
})

test('the two switches are reported separately, and the write answers with the list', async (t) => {
  const { handlers } = await fixture(t)
  await handlers['preset.select']({ name: '狐神抚' })
  const allowed = await handlers['regex.setPresetAllowed']({ allowed: true })
  assert.equal(allowed.allowed, true)

  const off = allowed.scripts.find(row => row.script.id === 'preset-off')
  assert.deepEqual(
    { byFile: off?.enabledByCard, effective: off?.enabled },
    { byFile: false, effective: false },
    'a rule the preset shipped switched off is not reported as the preset’s decision',
  )

  const flipped = await handlers['regex.setPresetEnabled']({ scriptId: 'preset-off', enabled: true })
  const row = flipped.scripts.find(entry => entry.script.id === 'preset-off')
  assert.deepEqual(
    { byFile: row?.enabledByCard, effective: row?.enabled },
    { byFile: false, effective: true },
    'the preset’s own flag moved when the user overrode it',
  )
})

test('a rule comes back verbatim, so its export is a file an install accepts', async (t) => {
  const { handlers } = await fixture(t)
  await handlers['preset.select']({ name: '狐神抚' })
  const listed = await handlers['regex.presetList']({})
  assert.deepEqual(
    listed.scripts.find(row => row.script.id === 'preset-prompt')?.script,
    PROMPT_RULE,
    'the projection dropped or reshaped a field, so an export of it would be lossy',
  )
})

test('a decision about a rule the preset does not carry is refused, not stored', async (t) => {
  const { handlers, dir } = await fixture(t)
  await handlers['preset.select']({ name: '狐神抚' })
  await assert.rejects(
    handlers['regex.setPresetEnabled']({ scriptId: 'invented', enabled: false }),
    /invented/,
  )
  // Including the separator the reader dropped: a switch over a rule that
  // cannot run is a decision with no effect to record.
  await assert.rejects(
    handlers['regex.setPresetEnabled']({ scriptId: 'preset-separator', enabled: true }),
    /preset-separator/,
  )
  const written = await readFile(join(dir, 'script-policy.json'), 'utf8').catch(() => '{}')
  assert.doesNotMatch(written, /invented|preset-separator/, 'the refused id was stored anyway')
})

test('a preset with no library name cannot be allow-listed, and says so', async (t) => {
  // Nothing has been switched, so the host is still on the composition's own
  // preset — a state upstream cannot represent. The allow-list is keyed by
  // name, so this tier could never be permitted; the list says which empty
  // state this is by leaving `presetName` absent.
  const { handlers } = await fixture(t)
  const listed = await handlers['regex.presetList']({})
  assert.deepEqual(listed, { scripts: [], allowed: false, malformed: 0 })
  assert.equal('presetName' in listed, false, 'an unnamed preset was given a name to be listed under')
  await assert.rejects(
    handlers['regex.setPresetAllowed']({ allowed: true }),
    /library name/,
    'the tier was allow-listed under a name that does not exist',
  )
})

test('the allow-list is stored beside the presets, not inside the preset file', async (t) => {
  const { handlers, dir } = await fixture(t)
  await handlers['preset.select']({ name: '狐神抚' })
  await handlers['regex.setPresetAllowed']({ allowed: true })

  const policyFile = await readFile(join(dir, 'script-policy.json'), 'utf8')
  assert.match(policyFile, /狐神抚/, 'the decision is not in the user’s policy file')
  // And the preset file is byte-identical to what was saved: a permission
  // written into a preset would travel to whoever the file was passed to next,
  // as a permission *they* appeared to have granted.
  const presetFile = JSON.parse(await readFile(join(dir, 'presets', '狐神抚.json'), 'utf8')) as unknown
  assert.deepEqual(presetFile, JSON.parse(JSON.stringify(WITH_REGEX)) as unknown)
})

// ── the two stages ──────────────────────────────────────────────────────────

test('a promptOnly rule changes the request only, and a markdownOnly rule the page only', async (t) => {
  const { handlers, seen, settled } = await fixture(t, 'said <draft>scratch</draft> and <think>why</think> done')
  await handlers['preset.select']({ name: '狐神抚' })
  await handlers['regex.setPresetAllowed']({ allowed: true })
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['chat.send']({ chatId, text: 'go' })
  await settled()
  // The reply is on the log now. A second turn is what puts it *into* a
  // request, which is the only place a `promptOnly` rule can be observed.
  await handlers['chat.send']({ chatId, text: 'again' })
  await settled()

  const page = String(
    (await handlers['chat.open']({ chatId })).view.messages
      .filter(message => message.role === 'assistant')
      .at(-1)?.text ?? '',
  )
  assert.match(page, /\[thought: why\]/, 'the markdownOnly rule did not rewrite the page')
  assert.match(page, /<draft>scratch<\/draft>/, 'the promptOnly rule rewrote the page as well')

  const request = sent(seen[1])
  assert.doesNotMatch(request, /<draft>/, 'the promptOnly rule did not rewrite the request')
  assert.match(request, /<think>why<\/think>/, 'the markdownOnly rule rewrote the request as well')
})

// ── the pipeline ────────────────────────────────────────────────────────────

test('switching presets swaps the tier under a conversation that is already open', async (t) => {
  const { handlers, chats, settled } = await fixture(t, 'kept <draft>scratch</draft>')
  await handlers['preset.select']({ name: '狐神抚' })
  await handlers['regex.setPresetAllowed']({ allowed: true })
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'go' })
  await settled()

  const entry = await chats.open(chatId)
  assert.deepEqual(
    entry.scripts.map(script => script.id),
    ['preset-prompt', 'preset-display', 'preset-off'],
    'the open conversation is not running the allowed preset’s tier',
  )

  // The other preset carries no tier at all. Nothing else changes.
  await handlers['preset.select']({ name: '咩咩' })
  assert.deepEqual(
    (await chats.open(chatId)).scripts.map(script => script.id),
    [],
    'the previous preset’s rules are still rewriting this conversation after a switch',
  )

  // And back, which is the direction a per-name allow-list has to get right:
  // the permission belongs to 狐神抚 and comes back with it, without being
  // asked for again.
  await handlers['preset.select']({ name: '狐神抚' })
  assert.deepEqual(
    (await chats.open(chatId)).scripts.map(script => script.id),
    ['preset-prompt', 'preset-display', 'preset-off'],
    'the allow-list did not follow the preset name back',
  )
})

test('a permission is per preset name, so allowing one preset does not allow another', async (t) => {
  const { handlers, policy } = await fixture(t)
  await handlers['preset.select']({ name: '狐神抚' })
  await handlers['regex.setPresetAllowed']({ allowed: true })
  assert.equal((await policy.presetRegex('狐神抚')).allowed, true)
  assert.equal(
    (await policy.presetRegex('咩咩')).allowed,
    false,
    'a permission given to one preset was read as given to another',
  )
})

test('allowing the tier reaches a conversation that is already open, and re-announces it', async (t) => {
  const { handlers, events, chats, settled } = await fixture(t, 'kept <think>why</think>')
  await handlers['preset.select']({ name: '狐神抚' })
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'go' })
  await settled()

  const before = (await handlers['chat.open']({ chatId })).view.messages.at(-1)?.text
  assert.match(String(before), /<think>why<\/think>/, 'the tier ran before it was allowed')

  const announced = events.filter(event => event.type === 'chat.updated').length
  await handlers['regex.setPresetAllowed']({ allowed: true })
  const after = (await handlers['chat.open']({ chatId })).view.messages.at(-1)?.text
  assert.match(
    String(after),
    /\[thought: why\]/,
    'allowing the tier did not reach the open conversation: it is still running the old rules',
  )
  assert.ok(
    events.filter(event => event.type === 'chat.updated').length > announced,
    'no page was told to re-render, so an open reader keeps seeing text the old rules produced',
  )
  // The refusal has to travel the same path back, or the switch is one-way.
  await handlers['regex.setPresetAllowed']({ allowed: false })
  assert.deepEqual((await chats.open(chatId)).scripts.map(script => script.id), [])
})

test('the unrunnable rows are reported through the wiring the host actually uses', async (t) => {
  const { handlers, chats, malformed } = await fixture(t)
  await handlers['preset.select']({ name: '狐神抚' })
  // Composed once, which is what an open costs. The report is not conditional
  // on the tier being allowed: a preset carrying rows nobody can run is a fact
  // about the file, and hearing it only after switching the tier on would be
  // hearing it at the worst moment.
  const created = await handlers['chat.create']({ characterId: 'aria' })
  await chats.open(created.view.chatId)
  assert.ok(malformed.length > 0, 'nothing was reported: the drop is silent')
  assert.deepEqual(
    { name: malformed[0]?.presetName, count: malformed[0]?.malformed },
    { name: '狐神抚', count: 1 },
    'the report does not name the preset and the number of rows',
  )
  // The preset with no tier reports nothing, so the channel means something.
  const seenBefore = malformed.length
  await handlers['preset.select']({ name: '咩咩' })
  await chats.open(created.view.chatId)
  assert.equal(malformed.length, seenBefore, 'a preset with no unrunnable rows was reported anyway')
})
