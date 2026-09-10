/**
 * The `Preset` mapping both trust domains read, and the traps in it.
 *
 * Every assertion here is against **upstream's own source**, cited by line, not
 * against a plausible reading of the type declarations — because the type
 * declarations are wrong about the prompt ids in prose (`preset.d.ts:81` says
 * `world_info_before`; three runtime sources say `worldInfoBefore`) and silent
 * about the two rules that matter most: that `prompts` is only what the ordering
 * names, and that a repeated *marker* id throws where a repeated normal id is
 * renamed.
 *
 * @module @iris/compat-tavernhelper-core/tests/preset
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DuplicatePresetPromptError,
  FRAME_OMITTED_EXTENSIONS,
  OMITTED_EXTENSIONS_KEY,
  PLACEHOLDER_PROMPT_DEFAULT_ORDER,
  PLACEHOLDER_PROMPT_IDS,
  SYSTEM_PROMPT_IDS,
  TH_DEFAULT_PRESET,
  TH_ORDER_CHARACTER_ID,
  fromTavernHelperPreset,
  isPresetNormalPrompt,
  isPresetPlaceholderPrompt,
  isPresetSystemPrompt,
  mergePresetDefaults,
  restoreOmittedExtensions,
  toTavernHelperPreset,
  trimPresetForFrame,
  type PresetFile,
  type TavernHelperPreset,
} from '../src/index.ts'

test('the prompt-class ids are upstream’s runtime ones, and none is snake_case', () => {
  /*
   * A literal table, as `preset-read.test.ts` keeps one for the host's
   * identifiers, and for the same reason: deriving these from anything would
   * let both sides drift together, which is what a shared mistake looks like.
   */
  assert.deepEqual([...SYSTEM_PROMPT_IDS], ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'])
  assert.deepEqual([...PLACEHOLDER_PROMPT_IDS], [
    'worldInfoBefore',
    'personaDescription',
    'charDescription',
    'charPersonality',
    'scenario',
    'worldInfoAfter',
    'dialogueExamples',
    'chatHistory',
  ])

  /*
   * The guard against the plausible fix. Someone reading
   * `@types/function/preset.d.ts:81` would rewrite these into snake_case, and
   * every assertion above would still pass if it were rewritten alongside them
   * — this one states the property any such rewrite violates.
   */
  assert.deepEqual(
    [...SYSTEM_PROMPT_IDS, ...PLACEHOLDER_PROMPT_IDS].filter(id => id.includes('_')),
    [],
    'a prompt id was rewritten into the documented — and wrong — form',
  )
})

test('the three guards partition every id, and an unknown id is normal', () => {
  for (const id of SYSTEM_PROMPT_IDS) {
    assert.equal(isPresetSystemPrompt({ id }), true, id)
    assert.equal(isPresetNormalPrompt({ id }), false, id)
    assert.equal(isPresetPlaceholderPrompt({ id }), false, id)
  }
  for (const id of PLACEHOLDER_PROMPT_IDS) {
    assert.equal(isPresetPlaceholderPrompt({ id }), true, id)
    assert.equal(isPresetNormalPrompt({ id }), false, id)
    assert.equal(isPresetSystemPrompt({ id }), false, id)
  }
  // "Neither of the other two", which is upstream's own definition
  // (`preset.ts:107`) and is what makes a card's own `id: 'new_prompt'` behave.
  assert.equal(isPresetNormalPrompt({ id: 'new_prompt' }), true)
  assert.equal(isPresetNormalPrompt({ id: 'worldinfobefore' }), true, 'the ids are case-sensitive upstream')
})

test('the two spellings of the built-in order are one array, and carry user_input', () => {
  /*
   * Nine entries, not eight, and the ninth is the one that catches a
   * well-meaning merge with `PLACEHOLDER_PROMPT_IDS`: `user_input` is not a
   * preset prompt at all, it is a `generateRaw` ordering slot
   * (`generate.d.ts:328`). The two lists are also in different vocabularies —
   * snake_case here, camelCase there — which is upstream's, not a typo.
   */
  assert.deepEqual([...PLACEHOLDER_PROMPT_DEFAULT_ORDER], [
    'world_info_before',
    'persona_description',
    'char_description',
    'char_personality',
    'scenario',
    'world_info_after',
    'dialogue_examples',
    'chat_history',
    'user_input',
  ])
  assert.equal(PLACEHOLDER_PROMPT_DEFAULT_ORDER.length, PLACEHOLDER_PROMPT_IDS.length + 1)
  assert.ok(
    PLACEHOLDER_PROMPT_DEFAULT_ORDER.every(name => name.includes('_') || name === 'scenario'),
    'this list is snake_case; the prompt ids are camelCase, and mixing them gives a card an id no preset has',
  )
})

test('default_preset is upstream’s, eight relative markers and nothing else', () => {
  assert.deepEqual(TH_DEFAULT_PRESET.prompts.map(prompt => prompt.id), [...PLACEHOLDER_PROMPT_IDS])
  assert.ok(TH_DEFAULT_PRESET.prompts.every(prompt => prompt.enabled))
  assert.ok(TH_DEFAULT_PRESET.prompts.every(prompt => prompt.position?.type === 'relative'))
  // No `content` on any of them: they are markers, and `toPresetPrompt` omits
  // content for a placeholder (`preset.ts:365`).
  assert.ok(TH_DEFAULT_PRESET.prompts.every(prompt => prompt.content === undefined))
  assert.deepEqual(TH_DEFAULT_PRESET.prompts_unused, [])
  // Two values worth pinning because they are surprising and a card branches on
  // them: a two-million-token window and a 300-token reply cap
  // (`preset.ts:128-129`).
  assert.equal(TH_DEFAULT_PRESET.settings.max_context, 2000000)
  assert.equal(TH_DEFAULT_PRESET.settings.max_completion_tokens, 300)
  assert.equal(TH_DEFAULT_PRESET.settings.seed, -1)
  // Frozen, so a card that writes into what `default_preset` handed it cannot
  // change what the next `createPreset` writes.
  assert.throws(() => {
    ;(TH_DEFAULT_PRESET.settings as { temperature: number }).temperature = 9
  })
})

test('prompts is what the ordering names, in the ordering’s order; the rest is unused', () => {
  /*
   * Upstream's `toPreset` (`preset.ts:404-410`), and the three properties in
   * one fixture: the file lists `b, a, c` and the ordering names `c, a`, so
   * `prompts` is `c, a` — the **ordering's** order, not the file's — and `b`
   * is unused. A mapping that returned the file list would pass an
   * `id`-membership assertion and fail this one.
   */
  const file: PresetFile = {
    prompts: [
      { identifier: 'b', name: 'B', content: 'b', system_prompt: false },
      { identifier: 'a', name: 'A', content: 'a', system_prompt: false },
      { identifier: 'c', name: 'C', content: 'c', system_prompt: false },
    ],
    prompt_order: [{
      character_id: TH_ORDER_CHARACTER_ID,
      order: [{ identifier: 'c', enabled: true }, { identifier: 'a', enabled: false }],
    }],
  }
  const preset = toTavernHelperPreset(file)
  assert.deepEqual(preset.prompts.map(prompt => [prompt.id, prompt.enabled]), [['c', true], ['a', false]])
  assert.deepEqual(preset.prompts_unused.map(prompt => prompt.id), ['b'])
  // The unused one keeps its **own** flag, defaulting to true — it is not
  // "disabled", it is not in the list (`preset.ts:352`).
  assert.equal(preset.prompts_unused[0]?.enabled, true)
})

test('an ordering entry no prompt answers to is dropped, not left as a hole', () => {
  /*
   * Upstream's `.find(...)!` would put `undefined` into the array here, and the
   * first `prompt.enabled` read inside a card throws on it. Dropping is the
   * only answer that keeps the array walkable.
   */
  const preset = toTavernHelperPreset({
    prompts: [{ identifier: 'a', system_prompt: false, content: '' }],
    prompt_order: [{
      character_id: TH_ORDER_CHARACTER_ID,
      order: [{ identifier: 'ghost', enabled: true }, { identifier: 'a', enabled: true }],
    }],
  })
  assert.deepEqual(preset.prompts.map(prompt => prompt.id), ['a'])
  assert.ok(preset.prompts.every(prompt => prompt !== undefined))
})

test('position, content and the ordering group follow the prompt’s class', () => {
  const preset = toTavernHelperPreset({
    prompts: [
      { identifier: 'main', name: 'M', role: 'system', content: 'sys', system_prompt: true },
      { identifier: 'chatHistory', name: 'H', role: 'system', system_prompt: true, marker: true },
      {
        identifier: 'deep', name: 'D', role: 'user', content: 'deep', system_prompt: false,
        injection_position: 1, injection_depth: 3, injection_order: 7,
      },
    ],
    prompt_order: [{
      character_id: TH_ORDER_CHARACTER_ID,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'deep', enabled: true },
      ],
    }],
  })
  const [main, history, deep] = preset.prompts

  // A **system** prompt has content and no position (`preset.ts:356-365`).
  assert.equal(main?.content, 'sys')
  assert.equal(main?.position, undefined)
  // A **placeholder** has a position and no content — the reverse.
  assert.equal(history?.content, undefined)
  assert.deepEqual(history?.position, { type: 'relative' })
  // A **normal** prompt has both, and `injection_position: 1` becomes
  // `in_chat` carrying the depth and the order.
  assert.equal(deep?.content, 'deep')
  assert.deepEqual(deep?.position, { type: 'in_chat', depth: 3, order: 7 })
})

test('Iris’s own word for injection_position classifies the same as SillyTavern’s number', () => {
  /*
   * The same file field spelled two ways: Iris's prompt manager writes
   * `'absolute'` and a preset off SillyTavern's disk carries `1`. A mapping that
   * read only the number would report an Iris-edited depth injection as
   * relative — which a card then places at the wrong end of the prompt.
   */
  const asWord = toTavernHelperPreset({
    prompts: [{ identifier: 'x', system_prompt: false, content: '', injection_position: 'absolute', injection_depth: 2, injection_order: 5 }],
    prompt_order: [{ character_id: TH_ORDER_CHARACTER_ID, order: [{ identifier: 'x', enabled: true }] }],
  })
  assert.deepEqual(asWord.prompts[0]?.position, { type: 'in_chat', depth: 2, order: 5 })
})

test('the in_use reading takes the running sampler values, the stored one takes the file’s', () => {
  /*
   * Upstream's split (`preset.ts:441-448`): `'in_use'` reads `temp_openai`, a
   * named preset reads `temperature`. Both fields are in this file with
   * different values, so a mapping that read the wrong one is red rather than
   * merely unpinned.
   */
  const file: PresetFile = {
    prompts: [],
    temperature: 0.2,
    temp_openai: 0.9,
    openai_max_context: 8192,
  }
  assert.equal(toTavernHelperPreset(file).settings.temperature, 0.2, 'a named preset reads the stored value')
  assert.equal(
    toTavernHelperPreset(file, { live: {} }).settings.temperature,
    0.9,
    'the preset in use reads the running value',
  )
  // The live patch wins over both, which is what makes `getPreset('in_use')`
  // report the temperature this host will actually generate at.
  assert.equal(toTavernHelperPreset(file, { live: { temp_openai: 0.35 } }).settings.temperature, 0.35)
})

test('two file fields collapse into allow_sending_images, as upstream collapses them', () => {
  // Inlining off reports `'disabled'` and the stored quality becomes
  // unreachable from the card side — upstream's own behaviour
  // (`preset.ts:454-457`), not a simplification.
  assert.equal(
    toTavernHelperPreset({ prompts: [], image_inlining: false, inline_image_quality: 'high' }).settings.allow_sending_images,
    'disabled',
  )
  assert.equal(
    toTavernHelperPreset({ prompts: [], image_inlining: true, inline_image_quality: 'high' }).settings.allow_sending_images,
    'high',
  )
})

test('tavern_helper is seeded when the file has none, because the type says it is there', () => {
  /*
   * Upstream declares `extensions.tavern_helper` non-optional
   * (`preset.ts:46`) while five of the eight real presets measured here do not
   * carry it. A card reading `preset.extensions.tavern_helper.scripts.length`
   * would throw on those five.
   */
  const preset = toTavernHelperPreset({ prompts: [] })
  assert.deepEqual(preset.extensions['tavern_helper'], { scripts: [], variables: {} })
  // And an existing one is left exactly as it is.
  const carried = toTavernHelperPreset({ prompts: [], extensions: { tavern_helper: { scripts: [{ id: 's' }], variables: { a: 1 } } } })
  assert.deepEqual(carried.extensions['tavern_helper'], { scripts: [{ id: 's' }], variables: { a: 1 } })
})

test('the write direction records the class in system_prompt and marker', () => {
  const file = fromTavernHelperPreset({
    settings: TH_DEFAULT_PRESET.settings,
    prompts: [
      { id: 'main', name: 'M', enabled: true, role: 'system', content: 'sys' },
      { id: 'chatHistory', name: 'H', enabled: true, role: 'system', position: { type: 'relative' } },
      { id: 'mine', name: 'X', enabled: false, role: 'user', content: 'x', position: { type: 'in_chat', depth: 2, order: 9 } },
    ],
    prompts_unused: [],
    extensions: {},
  })
  const byId = new Map(file.prompts.map(prompt => [prompt.identifier, prompt]))
  assert.deepEqual(
    [byId.get('main')?.system_prompt, byId.get('main')?.marker],
    [true, false],
    'a system prompt is system_prompt without marker',
  )
  assert.deepEqual(
    [byId.get('chatHistory')?.system_prompt, byId.get('chatHistory')?.marker],
    [true, true],
    'a placeholder is both',
  )
  assert.deepEqual(
    [byId.get('mine')?.system_prompt, byId.get('mine')?.marker],
    [false, false],
    'a card’s own prompt is neither',
  )
  // `dialogueExamples` and `chatHistory` carry no injection fields at all —
  // upstream excludes exactly those two (`preset.ts:381`), and writing one onto
  // them makes SillyTavern's manager render them as depth injections.
  assert.equal(byId.get('chatHistory')?.injection_position, undefined)
  assert.equal(byId.get('mine')?.injection_position, 1)
  assert.equal(byId.get('mine')?.injection_depth, 2)
  // The ordering is rebuilt from the used list, in its order, under 100001.
  assert.deepEqual(file.prompt_order, [{
    character_id: TH_ORDER_CHARACTER_ID,
    order: [
      { identifier: 'main', enabled: true },
      { identifier: 'chatHistory', enabled: true },
      { identifier: 'mine', enabled: false },
    ],
  }])
})

test('a repeated normal id is renamed and a repeated marker id throws', () => {
  /*
   * Upstream's asymmetry (`preset.ts:474-484`), and it is deliberate on its
   * side: renaming a marker would produce a preset whose `chatHistory` slot is
   * called something the assembler has never heard of, and the conversation
   * would silently stop having a position.
   */
  const renamed = fromTavernHelperPreset({
    settings: TH_DEFAULT_PRESET.settings,
    prompts: [
      { id: 'dup', name: 'one', enabled: true, role: 'user', content: 'a' },
      { id: 'dup', name: 'two', enabled: true, role: 'user', content: 'b' },
    ],
    prompts_unused: [],
    extensions: {},
  })
  const ids = renamed.prompts.map(prompt => prompt.identifier)
  assert.equal(new Set(ids).size, 2, 'the second copy got a fresh id')
  assert.equal(ids[0], 'dup', 'the first keeps the name the card gave it')

  assert.throws(
    () => fromTavernHelperPreset({
      settings: TH_DEFAULT_PRESET.settings,
      prompts: [
        { id: 'chatHistory', name: 'one', enabled: true, role: 'system', position: { type: 'relative' } },
        { id: 'chatHistory', name: 'two', enabled: true, role: 'system', position: { type: 'relative' } },
      ],
      prompts_unused: [],
      extensions: {},
    }),
    (error: unknown) => error instanceof DuplicatePresetPromptError && /chatHistory/u.test(error.message),
  )
})

test('a preset survives the round trip through both directions', () => {
  /*
   * The property the write direction exists for: read a file, hand it to a
   * card, take it back, write it — and the prompt list, its order, its flags
   * and the sampler values are the same.
   *
   * Every prompt in this fixture already has the content its class calls for,
   * which is what makes the comparison byte-for-byte: a **placeholder** carries
   * none in either direction (`toPresetPrompt` omits it, `fromPresetPrompt`
   * does not write it), and the one case that does change — a normal prompt
   * built with no `content` at all, which comes back as `''` — is pinned by the
   * test below rather than smuggled into this expectation as a `?? ''`.
   */
  const file: PresetFile = {
    prompts: [
      { identifier: 'main', name: 'M', role: 'system', content: 'sys', system_prompt: true, marker: false },
      { identifier: 'worldInfoBefore', name: 'W', role: 'system', system_prompt: true, marker: true, injection_position: 0, injection_depth: 4, injection_order: 100 },
      { identifier: 'mine', name: 'X', role: 'user', content: 'x', system_prompt: false, marker: false, injection_position: 0, injection_depth: 4, injection_order: 100 },
    ],
    prompt_order: [{
      character_id: TH_ORDER_CHARACTER_ID,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'worldInfoBefore', enabled: false },
        { identifier: 'mine', enabled: true },
      ],
    }],
    temperature: 0.7,
    openai_max_context: 32000,
    openai_max_tokens: 900,
  }
  const back = fromTavernHelperPreset(toTavernHelperPreset(file))
  assert.deepEqual(back.prompt_order, file.prompt_order)
  assert.deepEqual(
    back.prompts.map(prompt => [prompt.identifier, prompt.system_prompt, prompt.marker, prompt.role, prompt.content]),
    file.prompts.map(prompt => [prompt.identifier, prompt.system_prompt, prompt.marker, prompt.role, prompt.content]),
  )
  assert.equal(back['temperature'], 0.7)
  assert.equal(back['openai_max_context'], 32000)
  assert.equal(back['openai_max_tokens'], 900)
  // Both spellings of every in-use sampler are written, because a preset file
  // carries both and which one is read depends on whether it is in use.
  assert.equal(back['temp_openai'], 0.7)
})

test('a normal prompt a card built with no content is written as empty, not as absent', () => {
  /*
   * Upstream writes `prompt.content` straight through (`preset.ts:389`), so a
   * card's `prompts.push({ id: 'new', name: 'N', enabled: true, role: 'user' })`
   * stores `content: undefined` — which `JSON.stringify` then drops from the
   * file. The prompt reads back as a normal entry with no text field at all,
   * which is a shape neither the assembler nor `isPresetNormalPrompt`'s own
   * contract expects. `''` is what `toPresetPrompt` would have handed the card
   * for that prompt in the first place, so the round trip closes.
   */
  const file = fromTavernHelperPreset({
    settings: TH_DEFAULT_PRESET.settings,
    prompts: [{ id: 'new_prompt', name: 'N', enabled: true, role: 'user' }],
    prompts_unused: [],
    extensions: {},
  })
  assert.equal(file.prompts[0]?.content, '')
  assert.ok(
    'content' in JSON.parse(JSON.stringify(file)).prompts[0],
    'undefined would have been dropped by the serialiser and the field would be missing on disk',
  )
})

test('the frame’s copy names what it left out, and a write puts it back', () => {
  const preset: TavernHelperPreset = {
    settings: TH_DEFAULT_PRESET.settings,
    prompts: [],
    prompts_unused: [],
    extensions: {
      tavern_helper: { scripts: [{ id: 'heavy' }], variables: {} },
      regex_scripts: [{ scriptName: 'r' }],
      SPreset: { keep: true },
    },
  }
  const trimmed = trimPresetForFrame(preset)
  assert.deepEqual(trimmed.extensions[OMITTED_EXTENSIONS_KEY], [...FRAME_OMITTED_EXTENSIONS])
  assert.equal(trimmed.extensions['tavern_helper'], undefined)
  assert.equal(trimmed.extensions['regex_scripts'], undefined)
  // Everything else rides through: `SPreset` is 202 KiB of a third-party
  // extension's state in one real preset and a card may well read it.
  assert.deepEqual(trimmed.extensions['SPreset'], { keep: true })

  /*
   * The round trip upstream documents — `const p = getPreset('in_use'); …;
   * await replacePreset('in_use', p)` — must not delete the preset's script
   * library as a side effect of turning streaming on.
   */
  const { preset: restored, restored: keys } = restoreOmittedExtensions(trimmed, preset)
  assert.deepEqual(keys, [...FRAME_OMITTED_EXTENSIONS])
  assert.deepEqual(restored.extensions['tavern_helper'], preset.extensions['tavern_helper'])
  assert.equal(restored.extensions[OMITTED_EXTENSIONS_KEY], undefined, 'the marker does not reach the file')

  /*
   * And the mirror image: a card that supplied the key **deliberately** is
   * replacing it, and restoring over that would make the write silently not
   * happen.
   */
  const deliberate = { ...trimmed, extensions: { ...trimmed.extensions, tavern_helper: { scripts: [], variables: {} } } }
  const { preset: kept, restored: keys2 } = restoreOmittedExtensions(deliberate, preset)
  assert.deepEqual(keys2, ['regex_scripts'])
  assert.deepEqual(kept.extensions['tavern_helper'], { scripts: [], variables: {} })
})

test('the marker is always present, so “does not trim” and “nothing to trim” differ', () => {
  /*
   * A marker that appeared only when it fired would make a build that does not
   * trim and a preset with nothing to trim the same reading — and the write arm
   * would then have to guess which it was looking at.
   */
  const trimmed = trimPresetForFrame({
    settings: TH_DEFAULT_PRESET.settings,
    prompts: [],
    prompts_unused: [],
    extensions: {},
  })
  assert.deepEqual(trimmed.extensions[OMITTED_EXTENSIONS_KEY], [])
  // A body with no marker at all is passed through untouched — that is the
  // shape a card built from scratch has.
  const { restored } = restoreOmittedExtensions(
    { settings: TH_DEFAULT_PRESET.settings, prompts: [], prompts_unused: [], extensions: { mine: 1 } },
    undefined,
  )
  assert.deepEqual(restored, [])
})

test('setPreset fills settings and extensions in, and replaces the prompt lists whole', () => {
  const old: TavernHelperPreset = {
    settings: { ...TH_DEFAULT_PRESET.settings, temperature: 0.5, top_k: 40 },
    prompts: [{ id: 'a', name: 'A', enabled: true, role: 'user', content: 'a' }],
    prompts_unused: [{ id: 'z', name: 'Z', enabled: true, role: 'user', content: 'z' }],
    extensions: { keep: { deep: 1, also: 2 }, regex_scripts: [{ n: 1 }, { n: 2 }] },
  }

  const merged = mergePresetDefaults({ settings: { temperature: 0.9 } }, old)
  assert.equal(merged.settings.temperature, 0.9, 'what the partial names wins')
  assert.equal(merged.settings.top_k, 40, 'what it does not name is filled in')
  assert.deepEqual(merged.prompts, old.prompts, 'a partial with no prompts keeps the old list')
  assert.deepEqual(merged.prompts_unused, old.prompts_unused)

  /*
   * `prompts` is `??`, not a merge: naming it replaces the whole array, which
   * is how a card says "this preset's list is now this one prompt".
   *
   * **The stored list has to be longer than the partial's**, and that is the
   * whole discriminating power of this case. `defaultsDeep` fills arrays by
   * index, so a one-prompt partial over a one-prompt stored list produces the
   * partial either way — the two implementations agree, and an assertion on
   * that fixture passes for both. Over a *two*-prompt stored list the merge
   * leaves the stored second prompt behind at index 1, which is a preset the
   * card did not ask for and did not delete.
   */
  const longer: TavernHelperPreset = {
    ...old,
    prompts: [
      { id: 'a', name: 'A', enabled: true, role: 'user', content: 'a' },
      { id: 'a2', name: 'A2', enabled: true, role: 'user', content: 'a2' },
    ],
  }
  const replaced = mergePresetDefaults({ prompts: [{ id: 'b', name: 'B', enabled: true, role: 'user', content: 'b' }] }, longer)
  assert.deepEqual(replaced.prompts.map(prompt => prompt.id), ['b'])

  // Deep fill into `extensions`, and the array trap named in the source: lodash
  // `defaultsDeep` fills arrays **by index**, so one rule over a stored two
  // leaves the stored second in place. Reproduced, not corrected — a card
  // written against upstream gets this.
  const ext = mergePresetDefaults({ extensions: { keep: { deep: 9 }, regex_scripts: [{ n: 7 }] } }, old)
  assert.deepEqual(ext.extensions['keep'], { deep: 9, also: 2 })
  assert.deepEqual(ext.extensions['regex_scripts'], [{ n: 7 }, { n: 2 }])

  // Neither argument is mutated: the caller's partial and the stored preset are
  // both still readable afterwards, which matters because the stored one is the
  // round-trip read the write is about to be compared against.
  assert.equal(old.settings.temperature, 0.5)
})

test('the ordering sentinel is 100001, not the class default', () => {
  /*
   * `PromptManager` declares `promptOrder.dummyId: 100000` as a class default
   * and `openai.js:689` overrides it to 100001 for the Chat Completion path, so
   * 100000 is unreachable there. Reading the wrong one does not fail loudly —
   * it quietly builds a prompt out of a much shorter list.
   */
  assert.equal(TH_ORDER_CHARACTER_ID, 100001)
  const preset = toTavernHelperPreset({
    prompts: [{ identifier: 'a', system_prompt: false, content: '' }],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'a', enabled: true }] }],
  })
  assert.deepEqual(preset.prompts, [], 'the legacy group is not the one this reading uses')
  assert.deepEqual(preset.prompts_unused.map(prompt => prompt.id), ['a'])
})
