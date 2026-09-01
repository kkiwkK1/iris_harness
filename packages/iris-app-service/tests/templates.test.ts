import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { promptHasTemplate, promptTexts } from '../src/templates.ts'

/**
 * EJS prompt templates, wired into the generation path.
 *
 * The claim under test is not "EJS works" — `@iris/compat-prompt-template` owns
 * that, against upstream, in its own differential. The claim here is about the
 * *seam*: that the evaluated text is what the provider is actually handed, that
 * a chat without templates never pays for one, that a broken template costs its
 * own text and nothing else, and that a write a template performed lands in the
 * host's store through the host's own guard.
 *
 * Each of those fails silently if it is wrong. A prompt that reached the model
 * with a literal `<%= getvar(…) %>` in it looks like a card authoring mistake;
 * a chat that forks a child process per turn for nothing looks like the model
 * being slow.
 */

/** A card whose fields carry whatever templates the test needs. */
function card(fields: { description?: string, first_mes?: string }): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria',
      description: fields.description ?? '',
      personality: '', scenario: '',
      first_mes: fields.first_mes ?? 'Hello.',
      mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [],
      tags: [], creator: '', character_version: '1', extensions: {},
    },
  })
}

/** A stream that records the request it was handed and answers with one line. */
function scripted(seen: GenerateOptions[]): StreamFn {
  return async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    const text = 'A reply.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Fixture {
  handlers: Handlers
  seen: GenerateOptions[]
  errors: Error[]
  settled: () => Promise<void>
}

/**
 * @param t - the test, for cleanup.
 * @param options - the card's fields, and whether templates are on.
 * @returns a service over a throwaway data folder.
 */
async function fixture(
  t: TestContext,
  options: { description?: string, templates?: boolean } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-templates-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(
    join(dir, 'characters', 'aria.json'),
    card({ ...options.description === undefined ? {} : { description: options.description } }),
    'utf8',
  )

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const seen: GenerateOptions[] = []
  const errors: Error[] = []
  let ends = 0
  let waited = 0

  const handlers = new IrisAppService({
    stream: scripted(seen),
    library,
    chats,
    settings,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
    onError: (error: Error) => { errors.push(error) },
    // Presence is the switch. A test that wants templates off simply omits it,
    // which is the same thing a deployment does.
    ...options.templates === true ? { templates: {} } : {},
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

/** The text of everything the provider was handed, joined. */
function sentText(options: GenerateOptions | undefined): string {
  return options === undefined ? '' : promptTexts(options).join('\n')
}

test('a template in a card field is evaluated before the provider sees it', async (t) => {
  const { handlers, seen, settled } = await fixture(t, {
    description: 'Aria feels <%= getvar("mood") %> today.',
    templates: true,
  })
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['script.setVariables']({
    chatId, scope: 'chat', op: 'replace', variables: { mood: 'bright' },
  })
  await handlers['chat.send']({ chatId, text: 'How are you?' })
  await settled()

  const sent = sentText(seen[0])
  assert.match(sent, /Aria feels bright today\./u)
  // The failure this guards is the one that looks like an authoring mistake:
  // the tag reaching the model verbatim.
  assert.equal(sent.includes('<%'), false, 'a template tag reached the provider')
})

test('templates are off unless the host asked for them', async (t) => {
  const { handlers, seen, settled } = await fixture(t, {
    description: 'Aria feels <%= getvar("mood") %> today.',
  })
  const created = await handlers['chat.create']({ characterId: 'aria' })
  await handlers['chat.send']({ chatId: created.view.chatId, text: 'How are you?' })
  await settled()

  // Not "evaluates to empty" — untouched. This is SillyTavern without the
  // extension installed, which is the honest default for running a card
  // author's JavaScript.
  assert.match(sentText(seen[0]), /<%= getvar\("mood"\) %>/u)
})

test('a write a template performed lands in the host store', async (t) => {
  const { handlers, seen, settled } = await fixture(t, {
    description: '<% setvar("greeted", true, { scope: "local" }) %>Aria waits.',
    templates: true,
  })
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hi.' })
  await settled()

  // The evaluator describes the write; the host replays it through the same
  // entry point any other write uses. Reading it back through the wire is what
  // shows the replay happened rather than the child mutating something.
  const after = await handlers['script.setVariables']({
    chatId, scope: 'chat', op: 'insert', variables: {},
  })
  assert.equal(after.variables['greeted'], true)
  assert.equal(sentText(seen[0]).includes('setvar'), false)
})

test('a broken template costs its own text and nothing else', async (t) => {
  const { handlers, seen, errors, settled } = await fixture(t, {
    description: 'Before. <%= nope.missing.deeper %> After.',
    templates: true,
  })
  const created = await handlers['chat.create']({ characterId: 'aria' })
  await handlers['chat.send']({ chatId: created.view.chatId, text: 'Hi.' })
  await settled()

  // Upstream catches, reports, and leaves the original text in place — a card
  // with one broken template is still playable. The generation completed, which
  // `settled()` already proved.
  const sent = sentText(seen[0])
  assert.match(sent, /Before\./u)
  assert.match(sent, /After\./u)
  // Reported, so it is not also invisible.
  assert.ok(
    errors.some(error => /template generate\/.*failed/u.test(error.message)),
    `no failure was reported; saw ${JSON.stringify(errors.map(error => error.message))}`,
  )
})

test('the short-circuit is checked before anything is forked', () => {
  const plain: GenerateOptions = {
    provider: 'test',
    model: 'test-model',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'no tags here' }], source: { kind: 'user' } })],
  }
  assert.equal(promptHasTemplate(plain), false)
  assert.equal(promptHasTemplate({ ...plain, system: 'still none' }), false)
  // Upstream's rule is the opening delimiter, not a well-formed tag: half a tag
  // is a syntax error the author should see, not text to skip.
  assert.equal(promptHasTemplate({ ...plain, system: 'half a <% tag' }), true)
  assert.equal(
    promptHasTemplate({ ...plain, messages: [
      createUserMessage({ content: [{ type: 'text', text: '<%= 1 %>' }], source: { kind: 'user' } }),
    ] }),
    true,
  )
})

test('the system slot is index 0, as upstream numbers its array', () => {
  const options: GenerateOptions = {
    provider: 'test',
    model: 'test-model',
    system: 'the system slot',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'the first message' }], source: { kind: 'user' } })],
  }
  // `origin` exists only to be recognised by someone reading an error against
  // their own SillyTavern, so the numbering has to be upstream's.
  assert.deepEqual(promptTexts(options), ['the system slot', 'the first message'])
})
