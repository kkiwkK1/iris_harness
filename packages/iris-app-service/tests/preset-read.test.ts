import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { TavernHelperPreset } from '@iris/compat-tavernhelper'
import { BUILTIN_IDENTIFIERS, type ChatCompletionPreset } from '@iris/preset'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Reading the preset a card is being played with.
 *
 * **The prompt ids are camelCase, and upstream's own documentation says
 * otherwise.** `@types/function/preset.d.ts:81` lists them in prose as
 * `world_info_before`, `persona_description`, `enhance_definitions`; the type
 * union directly beneath it at `:83`, the type-guard array at
 * `preset.ts:115`, and the default preset's literals at `preset.ts:161` and
 * `:190` all say `worldInfoBefore`, `personaDescription`, `enhanceDefinitions`.
 * Three runtime sources against one comment, and the comment is the one a
 * person reads first.
 *
 * Getting it from the comment is not a loud failure. A card testing
 * `prompt.id === 'worldInfoBefore'` simply never matches, so its world info
 * quietly does not appear and the reply still reads as complete — the shape this
 * project keeps meeting, where the wrong answer is well-formed.
 *
 * Hence the first test: the identifiers are asserted as a **literal table**
 * rather than derived from anything, so that "correcting" them to match the
 * documentation is a red line. The second half of that test is the guard against
 * the guard — it checks that none of them is snake_case, which is what a
 * well-meaning fix would produce.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

async function fixture(t: TestContext, preset?: ChatCompletionPreset): Promise<Handlers> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-preset-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const stream: StreamFn = async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }
  return new IrisAppService({
    stream, library,
    chats: new ChatStore(join(dir, 'chats'), library),
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => {},
    userName: 'U',
    ...preset === undefined ? {} : { preset },
  }).handlers()
}

test('the built-in prompt ids are upstream’s, not upstream’s documentation’s', () => {
  // A literal table. Deriving it from anything would let both sides drift
  // together, which is exactly what a shared mistake looks like.
  assert.deepEqual([...BUILTIN_IDENTIFIERS], [
    'main',
    'nsfw',
    'worldInfoBefore',
    'personaDescription',
    'charDescription',
    'charPersonality',
    'scenario',
    'enhanceDefinitions',
    'worldInfoAfter',
    'dialogueExamples',
    'chatHistory',
    'jailbreak',
  ])

  // The guard against the plausible fix. Someone reading
  // `@types/function/preset.d.ts:81` would rewrite these into snake_case, and
  // every assertion above would still pass if it were changed alongside them —
  // this one states the property that any such rewrite violates.
  const snakeCased = BUILTIN_IDENTIFIERS.filter(id => id.includes('_'))
  assert.deepEqual(snakeCased, [], 'a prompt id was rewritten into the documented — and wrong — form')
})

test('the preset in use comes back as its prompt list', async (t) => {
  const handlers = await fixture(t, {
    prompts: [
      { identifier: 'main', role: 'system', content: 'You are Aria.' },
      { identifier: 'worldInfoBefore', marker: true },
      { identifier: 'chatHistory', marker: true },
    ],
    prompt_order: [{
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'worldInfoBefore', enabled: false },
        { identifier: 'chatHistory', enabled: true },
      ],
    }],
  })

  const { prompts } = await read(handlers)
  assert.deepEqual(prompts.map(prompt => prompt.id), ['main', 'worldInfoBefore', 'chatHistory'])

  // Disabled entries are **returned**, not filtered out. The assembler drops
  // them; a card reads `enabled` and needs to see which ones are off. Filtering
  // here would make every prompt look enabled — a plausible reuse of
  // `resolveOrder`, which does filter.
  assert.deepEqual(prompts.map(prompt => prompt.enabled), [true, false, true])
  assert.equal(prompts[0]?.content, 'You are Aria.')
  assert.equal(prompts[0]?.role, 'system')
})

test('a prompt the ordering does not name is unused, not disabled', async (t) => {
  const handlers = await fixture(t, {
    prompts: [
      { identifier: 'main', content: 'kept' },
      { identifier: 'nsfw', content: 'never ordered' },
    ],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
  })

  /*
   * **This assertion used to say the opposite, and it was wrong about upstream.**
   *
   * It said the unordered prompt comes back in `prompts` carrying
   * `enabled: false`, reasoning that absence from the ordering is how a preset
   * turns a prompt off. That is right about the *assembler* and wrong about
   * `getPreset`: upstream partitions on exactly this (`preset.ts:404-410`) and
   * puts what the ordering does not name into `prompts_unused`, where it keeps
   * its own `enabled` flag — `true` by default.
   *
   * The difference is not cosmetic. A card that walks `preset.prompts` and
   * filters on `enabled` sees two entries under the old shape and one under
   * upstream's, and the extra one is a prompt that is not in the prompt list at
   * all. Nothing noticed for as long as it did because nothing on the card face
   * was reading this arm.
   */
  const { prompts, prompts_unused } = await read(handlers)
  assert.deepEqual(prompts.map(prompt => [prompt.id, prompt.enabled]), [['main', true]])
  assert.deepEqual(prompts_unused.map(prompt => [prompt.id, prompt.enabled]), [['nsfw', true]])
})

test('a preset with no ordering at all runs everything, in file order', async (t) => {
  const handlers = await fixture(t, {
    prompts: [{ identifier: 'main', content: 'a' }, { identifier: 'jailbreak', content: 'b' }],
  })

  /*
   * A deliberate divergence, and the one place this reading leaves upstream.
   *
   * Upstream reads `prompt_order[100001]` and would answer `prompts: []` with
   * both entries in `prompts_unused` — unreachable on SillyTavern, whose prompt
   * manager writes an ordering the moment a preset is selected, and ordinary
   * here, because this host reads preset files straight off a disk and two of
   * the eight in the local corpora are hand-written. `prompts: []` would tell a
   * card nothing is in the prompt list while the assembler runs every entry of
   * it, so `withTavernHelperOrder` seeds the ordering the assembly already
   * implies. Recorded in DEVIATIONS host §65.
   */
  const { prompts, prompts_unused } = await read(handlers)
  assert.deepEqual(prompts.map(prompt => [prompt.id, prompt.enabled]), [['main', true], ['jailbreak', true]])
  assert.deepEqual(prompts_unused, [])
})

test('a preset this host does not have is refused by name', async (t) => {
  const handlers = await fixture(t)

  /*
   * The refusal that survives, and the one that did not.
   *
   * This arm used to refuse **every** name but `'in_use'` with "this host only
   * carries the one in use" — true of a host with no preset library, and no
   * longer true now that one exists: `store.read` answers a name and
   * `preset.select` switches to it. What is refused now is a name the library
   * does not have, with the name in the message, which is the shape upstream's
   * own `throw Error("预设 '…' 不存在")` gives a card's `catch`. This fixture
   * composes no library at all, so the refusal names that instead — and that is
   * the distinction being pinned: a host without a library and a library
   * without the name must not answer the same sentence.
   */
  await assert.rejects(
    () => handlers['script.getPreset']({ name: 'Some Other Preset' }),
    /preset library/u,
  )
})

test('the settings half reads the running values, not only the body’s', async (t) => {
  /*
   * The half of a `Preset` that is **not** in the body on this host.
   *
   * A switch copies a preset's scalar fields out into the global settings layer
   * (`presetScalarPatch`), and from that moment the layer is what generates —
   * so `getPreset('in_use').settings.temperature` has to read the layer back,
   * exactly as upstream reads `oai_settings.temp_openai` rather than the file's
   * `temperature` for `'in_use'` (`preset.ts:441`). Reading the body alone
   * would report the temperature the preset shipped while the host generates at
   * the one in force, and the answer would look complete.
   */
  const handlers = await fixture(t, {
    prompts: [{ identifier: 'main', content: 'a' }],
    temp_openai: 0.11,
    openai_max_context: 4096,
  })
  const { settings } = await read(handlers)

  // This fixture's settings layer carries no temperature or window, so the
  // body's own values stand — the honest answer when nothing has overridden.
  assert.equal(settings.temperature, 0.11)
  assert.equal(settings.max_context, 4096)
  // A field no Iris setting maps to comes off the body too, and one the body
  // does not carry either falls back to upstream's `default_preset`: `top_a` is
  // 0 there and `reply_count` is 1. Both are in the answer rather than absent,
  // because upstream's `settings` is a total record and a card reads it by name.
  assert.equal(settings.top_a, 0)
  assert.equal(settings.reply_count, 1)
})

/**
 * The arm's answer, cast once.
 *
 * `script.getPreset` answers `Record<string, unknown>` on the wire because the
 * named shape lives in `@iris/compat-tavernhelper-core`, which `@iris/protocol`
 * may not import (the browser's allowlist admits that package only because it
 * imports nothing at all). The cast belongs in one place rather than at four
 * call sites.
 * @param handlers - the fixture's handlers.
 * @returns the preset as a card sees it.
 */
async function read(handlers: Handlers): Promise<TavernHelperPreset> {
  const { preset } = await handlers['script.getPreset']({ name: 'in_use' })
  return preset as unknown as TavernHelperPreset
}
