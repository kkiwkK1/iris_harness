import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { materialisingChatStore } from './support/materialising-store.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { textOf } from '../src/views.ts'

/**
 * `script.generate`: a real assembly that is not a turn.
 *
 * Upstream has two generate functions and the difference is load-bearing.
 * `TavernHelper.generate` assembles the preset, the world info and the history;
 * `generateRaw` sends only what it is handed. A card asking for the first and
 * served by the second **succeeds** — it just answers without persona, lorebook
 * or conversation, which is the kind of wrongness nothing downstream reports.
 *
 * The second property is subtler and is where a real turn's machinery leaks:
 * assembling advances world-info timed effects and records an itemization. Both
 * belong to turns. A card-initiated generation that stored either would change
 * what the conversation does next — a sticky entry aged out by a script, or the
 * account of the user's own turn overwritten — from a call that never appears in
 * the chat. That is the same shape as a preview that writes, hidden one level
 * deeper.
 */

/** A card with a constant world-info entry, so an assembly has something to time. */
const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'A retired cartographer.',
    personality: 'Precise.',
    scenario: '', first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '1', extensions: {},
    character_book: {
      entries: [{
        keys: [], content: 'The maps are kept in the west tower.',
        enabled: true, constant: true, insertion_order: 0,
        extensions: { position: 4, depth: 0, role: 0, sticky: 3 },
      }],
    },
  },
})

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  seen: GenerateOptions[]
  settled: () => Promise<void>
}

async function fixture(t: TestContext, reply = 'A reply.'): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-side-generate-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const seen: GenerateOptions[] = []
  let ends = 0
  let waited = 0
  const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  return {
    handlers,
    chats,
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

test('it assembles the way a turn does, with the card’s input last', async (t) => {
  const { handlers, seen } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })

  const { text } = await handlers['script.generate']({
    chatId: created.view.chatId,
    userInput: 'Where are the maps?',
  })
  assert.equal(text, 'A reply.')

  const prompt = sent(seen[0])
  // The three things `generateRaw` would not have included. A card served by
  // `generateRaw` instead of this would get an answer with none of them, and
  // would be told it succeeded.
  assert.match(prompt, /retired cartographer/u, 'the persona was not assembled')
  assert.match(prompt, /west tower/u, 'the world info was not assembled')
  assert.match(prompt, /Hello\./u, 'the history was not assembled')
  // And the card's own input is there, after the conversation.
  assert.match(prompt, /Where are the maps\?/u)
  const texts = (seen[0]?.messages ?? []).map(message => textOf(message))
  assert.ok(
    texts.indexOf('Where are the maps?') > texts.indexOf('Hello.'),
    'the card input was placed before the history',
  )
  // **Not** the last message, and that is upstream's behaviour rather than a
  // defect: a world-info entry at depth 0 is injected *after* the newest
  // message, so the final element here is the lorebook entry. Asserting "last"
  // is the intuitive test and it fails against a correct assembly.
  assert.equal(texts.at(-1), 'The maps are kept in the west tower.')
})

test('nothing about the conversation changes', async (t) => {
  const { handlers, chats } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // A real turn first, so there is state worth not disturbing.
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  const entry = await chats.open(chatId)
  while (entry.generating) await new Promise(resolve => setTimeout(resolve, 1))

  const before = {
    timedEffects: JSON.stringify(entry.timedEffects ?? null),
    itemizations: JSON.stringify([...entry.itemizations.entries()]),
    messages: JSON.stringify(entry.toView().messages),
    file: JSON.stringify(entry.toFile()),
  }

  await handlers['script.generate']({ chatId, userInput: 'A side question.' })

  // The log is the obvious one. The other two are the ones that leak: assembling
  // advances the world-info sticky and cooldown windows and records the turn's
  // itemization, and both belong to turns. A script aging out a sticky entry
  // would surface much later as world info that stopped appearing, with nothing
  // connecting it to the call that did it.
  assert.equal(JSON.stringify(entry.timedEffects ?? null), before.timedEffects, 'the timed effects advanced')
  assert.equal(JSON.stringify([...entry.itemizations.entries()]), before.itemizations, 'an itemization was overwritten')
  assert.equal(JSON.stringify(entry.toView().messages), before.messages, 'the conversation changed')
  assert.equal(JSON.stringify(entry.toFile()), before.file, 'the chat file would have changed')
})

test('maxHistory counts from the recent end', async (t) => {
  const { handlers, seen, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['chat.send']({ chatId, text: 'First question.' })
  await settled()
  await handlers['chat.send']({ chatId, text: 'Second question.' })
  await settled()

  seen.length = 0
  await handlers['script.generate']({ chatId, userInput: 'Now.', maxHistory: 1 })
  const prompt = sent(seen[0])

  // A card asking for one wants the *last* one. Slicing from the front would
  // hand it the oldest exchange, which is both wrong and plausible-looking.
  assert.equal(prompt.includes('First question.'), false, 'the oldest history was kept instead of the newest')
  assert.match(prompt, /Now\./u)
})

test('a system prompt from the card replaces the assembled one', async (t) => {
  const { handlers, seen } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })

  await handlers['script.generate']({
    chatId: created.view.chatId,
    userInput: 'Hi.',
    systemPrompt: 'You are a compass.',
  })
  assert.equal(seen[0]?.system, 'You are a compass.')
  // Replaced, not appended: two system slots would be a shape no provider agrees
  // on, and the card asked for one.
  assert.equal(sent(seen[0]).includes('retired cartographer'), false)
})

test('a script rewrites a floor through the same path a user edit takes', async (t) => {
  const { handlers, chats } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  const entry = await chats.open(chatId)
  while (entry.generating) await new Promise(resolve => setTimeout(resolve, 1))

  const before = (await handlers['chat.open']({ chatId })).view.messages[2]?.text ?? ''
  await handlers['script.setChatMessages']({
    chatId,
    messages: [{ messageId: 2, message: `${before}\n\n<StatusPlaceHolderImpl/>` }],
    refresh: 'none',
  })

  // Upstream's generation-time path: `update_variables.ts:1563` appends a status
  // placeholder to the reply that just arrived. A card that cannot do this
  // cannot render a status panel.
  const after = (await handlers['chat.open']({ chatId })).view.messages[2]?.text ?? ''
  assert.match(after, /StatusPlaceHolderImpl/u)

  // And it went through the swipe list, not only `mes`. A floor's text lives in
  // its swipes and `mes` merely points at one; an edit that misses the list is
  // undone by the next swipe back and forth — which looks like a swipe eating an
  // edit rather than like a missing line of code.
  const file = entry.toFile().messages[2] as { mes: string, swipes?: string[], swipe_id?: number }
  assert.equal(file.swipes?.[file.swipe_id ?? 0], after, 'the swipe list still holds the old text')
})

test('a batch that names a missing floor writes nothing at all', async (t) => {
  const { handlers, chats } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Hello?' })
  const entry = await chats.open(chatId)
  while (entry.generating) await new Promise(resolve => setTimeout(resolve, 1))

  const before = JSON.stringify((await handlers['chat.open']({ chatId })).view.messages)
  await assert.rejects(
    () => handlers['script.setChatMessages']({
      chatId,
      messages: [{ messageId: 0, message: 'rewritten' }, { messageId: 99, message: 'nowhere' }],
    }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )

  // All ids are checked before any is written. A batch that rewrote the first
  // floor and then refused the second would leave the conversation half-edited,
  // with nothing recording which half.
  assert.equal(
    JSON.stringify((await handlers['chat.open']({ chatId })).view.messages),
    before,
    'a refused batch left part of its edits behind',
  )
})
