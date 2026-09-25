import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { importChat, type SillyTavernChatHeader, type SillyTavernMessage } from '@iris/persistence'
import type { StreamFn } from '@iris/turn'

import { chatLines, floorFlags, lineFlags } from '../src/entry.ts'
import type { Handlers } from '../src/service.ts'
import { createTestService } from './support/service.ts'

/**
 * The two SillyTavern row attributes that change what the model is sent.
 *
 * - `is_system: true` (ST `/hide`, a card row with `is_hidden: true`) is left
 *   out of the prompt, as upstream's `coreChat` filter leaves it out
 *   (`public/script.js:4437`), and out of the display regex's depth, as
 *   upstream's `usableMessages` leaves it out (`:1804-1806`).
 * - `extra.type === 'narrator'` (`/sys`, every `role: 'system'` card row)
 *   reaches the model as a system message (`openai.js:580-582`), not as the
 *   character speaking.
 *
 * Every chat here is synthetic: the corpus has no hidden row, and its two
 * narrator rows (缄默之秋2.5 MVU, both floor 0) are a character sheet this file
 * mirrors at floor 0.
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

/** A display rule that marks whichever floor sits at depth 0. */
const DEPTH_ZERO_CARD = JSON.stringify({
  ...JSON.parse(CARD) as object,
  data: {
    ...(JSON.parse(CARD) as { data: object }).data,
    extensions: {
      regex_scripts: [{
        id: 'd0', scriptName: 'mark-depth-0',
        findRegex: '/^/', replaceString: '[D0]', trimStrings: [],
        placement: [1, 2], disabled: false, markdownOnly: true, promptOnly: false,
        runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: 0,
      }],
    },
  },
})

const HEADER: SillyTavernChatHeader = {
  user_name: 'Traveller', character_name: 'Aria', create_date: '2026-01-22 @04h13m05s', chat_metadata: {},
}

/**
 * Five floors, one of each shape that matters, with a swipe in the middle so
 * the derived index and the line index have a candidate list to disagree over.
 */
const MESSAGES: SillyTavernMessage[] = [
  // The corpus shape: a narrator character sheet at floor 0, not hidden.
  { name: 'System', is_user: false, is_system: false, mes: 'SHEET', extra: { type: 'narrator' }, swipes: ['SHEET'], swipe_id: 0 },
  { name: 'Traveller', is_user: true, mes: 'hello' },
  { name: 'Aria', is_user: false, mes: 'reply B', swipes: ['reply A', 'reply B'], swipe_id: 1 },
  // What `/hide` leaves behind.
  { name: 'Aria', is_user: false, is_system: true, mes: 'SECRET', swipes: ['SECRET'], swipe_id: 0 },
  // What a card's `createChatMessages([{ role: 'system', is_hidden: false }])` writes.
  { name: 'system', is_user: false, is_system: false, mes: 'INSTRUCTION', extra: { type: 'narrator' } },
] as SillyTavernMessage[]

const jsonl = (messages: readonly SillyTavernMessage[]): string =>
  [HEADER, ...messages].map(line => JSON.stringify(line)).join('\n') + '\n'

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

function textOf(message: Message): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

interface Fixture {
  handlers: Handlers
  captured: GenerateOptions[]
  settled: () => Promise<void>
}

async function fixture(t: TestContext, card = CARD): Promise<Fixture> {
  const captured: GenerateOptions[] = []
  const stream: StreamFn = async function* (request) {
    captured.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  let ends = 0
  let waited = 0
  const { handlers } = await createTestService(t, async ({ dir }) => {
    await mkdir(join(dir, 'characters'), { recursive: true })
    await writeFile(join(dir, 'characters', 'aria.json'), card, 'utf8')
    return {
      stream,
      userName: 'Traveller',
      broadcast: event => { if (event.type === 'stream.end' || event.type === 'stream.error') ends += 1 },
    }
  }, 'iris-hidden-rows-')
  return {
    handlers,
    captured,
    settled: async () => {
      waited += 1
      for (let tick = 0; tick < 8_000 && ends < waited; tick += 1) await new Promise(done => { setTimeout(done, 1) })
      assert.equal(ends >= waited, true, 'a generation never settled')
    },
  }
}

/** One request's conversation as `role parts text` rows, in the assembly's roles. */
function conversation(request: GenerateOptions): string[] {
  const layout = request.layout
  assert.ok(layout !== undefined, 'the request carries its layout')
  return layout.messages.map((slot, index) =>
    `${slot.role} ${slot.parts.map(part => part.id).join('+')} ${textOf(request.messages[index] as Message)}`)
}

test('the derived-message index and the chat-line index name the same floors', () => {
  // `historyFromSession` asks `roleOf`/`omit` by derived index; the flags are
  // recorded per chat line. A flag applied one floor off hides the wrong floor
  // from the model, so the two indices are compared here on a chat with a
  // swipe (whose selected candidate is not the line's first event) and one of
  // each flag.
  const session = importChat({ header: HEADER, messages: MESSAGES }, 'align')
  assert.equal(session.deriveMessages().length, chatLines(session).length, 'one derived message per line')
  assert.deepEqual(floorFlags(session), lineFlags(session), 'the same flags at the same index')
  assert.deepEqual(
    floorFlags(session).map(flags => `${String(flags.hidden)}/${String(flags.narrator)}`),
    ['false/true', 'false/false', 'false/false', 'true/false', 'false/true'],
  )
})

test('an imported hidden row is not sent, and narrator rows are sent as system', async (t) => {
  const fix = await fixture(t)
  const { chat } = await fix.handlers['chat.import']({ filename: 'mixed.jsonl', content: b64(jsonl(MESSAGES)), characterId: 'aria' })
  await fix.handlers['chat.send']({ chatId: chat.chatId, text: 'next' })
  await fix.settled()

  const request = fix.captured.at(-1)
  assert.ok(request !== undefined)
  const rows = conversation(request)
  assert.deepEqual(rows.filter(row => row.includes(' history.')), [
    // Floor ids stay the log's floor numbers: floor 3 is missing, not renumbered.
    'system history.0 SHEET',
    'user history.1 hello',
    'assistant history.2 reply B',
    'system history.4 INSTRUCTION',
    'user history.5 next',
  ])
  assert.equal(request.messages.some(message => textOf(message).includes('SECRET')), false, 'the hidden row reaches no message')
})

test('a card row created as role system and not hidden still reaches the model; a hidden one does not', async (t) => {
  // The pairing #173 made possible: the frame now writes `role: 'system'` rows
  // as upstream's `convert` does (`is_system: is_hidden ?? false`,
  // `extra.type: 'narrator'`). The corpus card 魔法禁书目录 creates the first
  // shape and then triggers a reply — its instruction must reach the model.
  const fix = await fixture(t)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await fix.handlers['script.createChatMessages']({
    chatId,
    messages: [
      { name: 'system', is_user: false, mes: 'VISIBLE', is_system: false, extra: { type: 'narrator' } },
      { name: 'system', is_user: false, mes: 'HIDDEN', is_system: true, extra: { type: 'narrator' } },
    ],
  })
  await fix.handlers['chat.send']({ chatId, text: 'go' })
  await fix.settled()

  const request = fix.captured.at(-1)
  assert.ok(request !== undefined)
  assert.deepEqual(conversation(request).filter(row => row.includes(' history.')), [
    'assistant history.0 Hello.',
    'system history.1 VISIBLE',
    'user history.3 go',
  ])
  assert.equal(request.messages.some(message => textOf(message).includes('HIDDEN')), false)
})

test('the display regex counts depth over the rows that are not hidden, and leaves a hidden row alone', async (t) => {
  const fix = await fixture(t, DEPTH_ZERO_CARD)
  // A hidden row last: upstream's depth 0 is the row before it.
  const messages = [...MESSAGES.slice(0, 3), MESSAGES[3] as SillyTavernMessage]
  const { chat } = await fix.handlers['chat.import']({ filename: 'tail.jsonl', content: b64(jsonl(messages)), characterId: 'aria' })
  const { view } = await fix.handlers['chat.open']({ chatId: chat.chatId })

  assert.deepEqual(view.messages.map(message => message.text), ['SHEET', 'hello', '[D0]reply B', 'SECRET'])
})
