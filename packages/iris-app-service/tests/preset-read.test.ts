import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

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

  const { prompts } = await handlers['script.getPreset']({ name: 'in_use' })
  assert.deepEqual(prompts.map(prompt => prompt.id), ['main', 'worldInfoBefore', 'chatHistory'])

  // Disabled entries are **returned**, not filtered out. The assembler drops
  // them; a card reads `enabled` and needs to see which ones are off. Filtering
  // here would make every prompt look enabled — a plausible reuse of
  // `resolveOrder`, which does filter.
  assert.deepEqual(prompts.map(prompt => prompt.enabled), [true, false, true])
  assert.equal(prompts[0]?.content, 'You are Aria.')
  assert.equal(prompts[0]?.role, 'system')
})

test('a prompt missing from the ordering is off, not absent', async (t) => {
  const handlers = await fixture(t, {
    prompts: [
      { identifier: 'main', content: 'kept' },
      { identifier: 'nsfw', content: 'never ordered' },
    ],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
  })

  // Leaving a prompt out of the ordering is how a preset turns it off, so it has
  // to come back present-and-disabled. Dropping it would tell a card the prompt
  // does not exist, which is a different thing it might act on.
  const { prompts } = await handlers['script.getPreset']({ name: 'in_use' })
  assert.deepEqual(prompts.map(prompt => [prompt.id, prompt.enabled]), [['main', true], ['nsfw', false]])
})

test('a preset with no ordering at all runs everything, in file order', async (t) => {
  const handlers = await fixture(t, {
    prompts: [{ identifier: 'main', content: 'a' }, { identifier: 'jailbreak', content: 'b' }],
  })

  // The same fallback the assembler takes when `prompt_order` is absent. If this
  // said `false`, a card would see a preset in which nothing is on, while the
  // host was assembling all of it.
  const { prompts } = await handlers['script.getPreset']({ name: 'in_use' })
  assert.deepEqual(prompts.map(prompt => prompt.enabled), [true, true])
})

test('a preset this host does not have is refused by name', async (t) => {
  const handlers = await fixture(t)

  // Not answered with the one in use. A card that asked for a named preset and
  // received a different one cannot tell, and would go on to reason about
  // prompts that are not in the preset it named.
  await assert.rejects(
    () => handlers['script.getPreset']({ name: 'Some Other Preset' }),
    /Some Other Preset/u,
  )
})
