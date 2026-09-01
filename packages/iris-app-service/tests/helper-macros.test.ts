import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { residualMacros } from '../src/prompt.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { textOf } from '../src/views.ts'

/**
 * Tavern Helper's variable macros, on the path that actually sends them.
 *
 * The defect these exist for had no symptom. `{{format_message_variable::
 * stat_data}}` went to the model as its own braces, so a card asking the model
 * to patch each variable "according to its `check`" showed it no values at all,
 * and the reply came back with no update block — which reads exactly like a
 * model refusing the format. Three generations were spent on the model before
 * the corpus showed the same card succeeding on its first reply under
 * SillyTavern.
 *
 * So the assertion here is not that a function expands a string. It is that the
 * expansion reaches **the request the provider is handed**, which is the only
 * place the original failure was visible.
 */

/** A card whose world book shows the model its state, the way MVU's does. */
function cardWithStatusEntry(): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria', description: 'A cartographer.', personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1',
      extensions: {},
      character_book: {
        entries: [
          {
            // Constant, at depth 0, exactly like the card's `[mvu_update]`
            // entries: always in the prompt, right after the last message.
            keys: [], content: 'Current state:\n{{format_message_variable::stat_data}}',
            enabled: true, constant: true, insertion_order: 0,
            extensions: { position: 4, depth: 0, role: 0 },
          },
          {
            keys: [], content: 'Compact: {{get_message_variable::stat_data.世界.当前时间}}',
            enabled: true, constant: true, insertion_order: 1,
            extensions: { position: 4, depth: 0, role: 0 },
          },
        ],
      },
    },
  })
}

interface Fixture {
  handlers: Handlers
  seen: GenerateOptions[]
  errors: Error[]
  settled: () => Promise<void>
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-helper-macros-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), cardWithStatusEntry(), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const seen: GenerateOptions[] = []
  const errors: Error[] = []
  let ends = 0
  let waited = 0

  const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    const text = 'Understood.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const handlers = new IrisAppService({
    stream, library, chats, settings,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
    onError: (error: Error) => { errors.push(error) },
  }).handlers()

  return {
    handlers,
    seen,
    errors,
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

test('a card’s state macros are resolved before the provider sees them', async (t) => {
  const { handlers, seen, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // The state a turn would have folded, written through the same entry point a
  // card uses — so this is a tree the macros have to find the ordinary way.
  await handlers['script.setVariables']({
    chatId,
    scope: 'message',
    op: 'replace',
    variables: { stat_data: { 世界: { 当前时间: '15:00' }, 爱衣: { 欲望值: 5 } }, $meta: { hidden: true } },
  })

  await handlers['chat.send']({ chatId, text: 'What time is it?' })
  await settled()

  const prompt = sent(seen[0])
  // The block form: a YAML tree the model can read.
  assert.match(prompt, /当前时间: '15:00'|当前时间: 15:00/u, 'the YAML block never reached the prompt')
  assert.match(prompt, /欲望值: 5/u)
  // The one-line form.
  assert.match(prompt, /Compact: 15:00/u)
  // And nothing macro-shaped survived.
  assert.equal(prompt.includes('{{format_message_variable'), false, 'a macro reached the provider verbatim')
  assert.equal(prompt.includes('{{get_message_variable'), false)
})

test('framework bookkeeping is not shown to the model', async (t) => {
  const { handlers, seen, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  await handlers['script.setVariables']({
    chatId: created.view.chatId,
    scope: 'message',
    op: 'replace',
    // `$`-prefixed keys are the framework's own, at any depth, and upstream
    // drops them from both macros.
    variables: { stat_data: { 世界: { 当前时间: '15:00', $trace: 'internal' }, $meta: {} } },
  })
  await handlers['chat.send']({ chatId: created.view.chatId, text: 'Hi.' })
  await settled()

  const prompt = sent(seen[0])
  assert.match(prompt, /当前时间/u)
  assert.equal(prompt.includes('$trace'), false, 'a $-prefixed key was shown to the model')
  assert.equal(prompt.includes('internal'), false)
})

test('a macro that nothing expanded is reported rather than sent in silence', async (t) => {
  const { handlers, errors, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  // No variables written at all, so the state macros resolve to `null` — which
  // is upstream's answer and not a residue. What must be reported is a macro
  // family nobody here implements, which is what the original defect was.
  await handlers['chat.send']({ chatId: created.view.chatId, text: 'Ping {{no_such_macro}}.' })
  await settled()

  assert.ok(
    errors.some(error => /reached the provider unexpanded/u.test(error.message) && /no_such_macro/u.test(error.message)),
    `the unexpanded macro was not reported; saw ${JSON.stringify(errors.map(error => error.message))}`,
  )
})

test('residual detection names heads only, and does not fire on ordinary text', () => {
  assert.deepEqual(residualMacros('{{user}} said {{format_message_variable::stat_data.a.b}}'), [
    'user',
    'format_message_variable',
  ])
  // Measured over the corpus: card prose and embedded JSON produce no matches,
  // which is why this needs no whitelist.
  assert.deepEqual(residualMacros('a JSON blob {"a":{"b":1}} and a brace { { in prose'), [])
  // Only the head, never the body — this feeds a log line, and a card's text
  // does not belong in one.
  assert.deepEqual(residualMacros('{{get_message_variable::secret.path}}'), ['get_message_variable'])
})
