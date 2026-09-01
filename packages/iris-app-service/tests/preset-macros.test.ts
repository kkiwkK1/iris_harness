import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ChatCompletionPreset } from '@iris/preset'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { textOf } from '../src/views.ts'

/**
 * SillyTavern's own variable macros across one prompt assembly.
 *
 * This is how a **preset** carries a menu: several mutually exclusive prompts
 * each `{{setvar}}` one choice, and a later prompt reads them all back with
 * `{{getvar}}`. The render pipeline's acceptance preset works exactly this way,
 * and empty reads would send the model three blank sections and produce no boot
 * token — the first link of that chain.
 *
 * The property pinned here is **shared state across contributions within one
 * assembly**, which is easy to lose without breaking any macro: expanding each
 * contribution with its own macro context leaves every macro working and every
 * read empty.
 */

const SAMPLE = '测试用卡/圣座之音VoxImperialis.json'
const SAMPLE_CARD = '测试用卡/2234924f1640f3e0.png'

/** A preset written here, so the rule does not depend on the sample to state it. */
const MENU_PRESET: ChatCompletionPreset = {
  prompts: [
    { identifier: 'pick', name: 'pick', role: 'system', content: '{{setvar::vox_style::gothic}}', enabled: true },
    { identifier: 'read', name: 'read', role: 'system', content: 'Style is [{{getvar::vox_style}}].', enabled: true },
  ],
  prompt_order: [{
    character_id: 100001,
    order: [{ identifier: 'pick', enabled: true }, { identifier: 'read', enabled: true }],
  }],
}

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '', first_mes: 'Hello.',
    mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
    alternate_greetings: [], tags: [], creator: '', character_version: '1', extensions: {},
  },
})

interface Fixture {
  handlers: Handlers
  seen: GenerateOptions[]
  settled: () => Promise<void>
}

async function fixture(t: TestContext, preset: ChatCompletionPreset, card?: string): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-preset-macros-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  if (card === undefined) await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  else await copyFile(card, join(dir, 'characters', 'vox.png'))

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const seen: GenerateOptions[] = []
  let ends = 0
  let waited = 0
  const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream,
    library,
    chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
    preset,
  }).handlers()

  return {
    handlers,
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

test('a preset setvar is visible to a later prompt getvar', async (t) => {
  const { handlers, seen, settled } = await fixture(t, MENU_PRESET)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  await handlers['chat.send']({ chatId: created.view.chatId, text: 'Hi.' })
  await settled()

  const prompt = sent(seen[0])
  assert.match(prompt, /Style is \[gothic\]\./u, 'the reading prompt did not see the setter value')
  // The failure this guards is not an absent macro. It is one macro context per
  // contribution, which leaves every macro working and every read empty.
  assert.equal(prompt.includes('{{getvar'), false)
  assert.equal(prompt.includes('{{setvar'), false)
})

test('the acceptance preset three menu choices reach the model', {
  skip: !existsSync(SAMPLE) || !existsSync(SAMPLE_CARD),
}, async (t) => {
  // The real file: 43 prompts, 19 enabled, three `{{setvar::vox_*}}` selections
  // read back by one bridge-mode prompt. Blank sections here mean no boot token,
  // and no token means no regex trigger and no frame — so this is the first link
  // of the render acceptance chain, checked against the preset itself rather
  // than against a description of it.
  const preset = JSON.parse(await readFile(SAMPLE, 'utf8')) as ChatCompletionPreset
  const { handlers, seen, settled } = await fixture(t, preset, SAMPLE_CARD)
  const list = await handlers['character.list']({})
  const characterId = list.characters[0]?.characterId
  assert.ok(characterId !== undefined)

  const created = await handlers['chat.create']({ characterId })
  await handlers['chat.send']({ chatId: created.view.chatId, text: '报告战况' })
  await settled()

  const prompt = sent(seen[0])
  assert.equal(prompt.includes('{{getvar'), false, 'a getvar reached the model unexpanded')
  assert.equal(prompt.includes('{{setvar'), false)
  for (const chosen of ['哥特史诗体', '现实铁律', '1200-1800']) {
    assert.ok(prompt.includes(chosen), `the menu choice ${chosen} never reached the prompt`)
  }
})

test('previewing a prompt does not write to the chat variables', async (t) => {
  const { handlers } = await fixture(t, MENU_PRESET)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['prompt.itemize']({ chatId })

  // `prompt.itemize` re-runs the assembly, macros included. Binding the macro
  // tier to the chat's persistent scopes was tried and reverted for exactly this
  // reason: it turned a read into a write, storing the preset's menu selections
  // into `chat_metadata.variables` when someone merely previewed a prompt. This
  // pins the reversion, so the same change cannot return unnoticed.
  const { variables } = await handlers['script.getVariables']({ chatId, scope: 'chat' })
  assert.deepEqual(variables, {}, 'previewing a prompt mutated the stored chat variables')
})
