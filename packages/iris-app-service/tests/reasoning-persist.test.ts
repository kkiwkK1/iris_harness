import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { translate } from '@iris/llm-openai-compat/src/translate.ts'
import { parseChatFile } from '@iris/persistence'
import type { ChatView, IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { createTestService } from './support/service.ts'

/**
 * A reply that is all reasoning survives the chat file.
 *
 * The owner's 黑兽 floor #33 (2026-09-25): DeepSeek streamed only
 * `reasoning_content`, no `content`, and billed every completion token as
 * reasoning (4086 of 4086). Iris kept the trace on the in-memory candidate
 * alone, so the file said `mes: ""` and the reply was gone after a restart —
 * or sooner, after any log rebuild (an edit, a card's `setChatMessages`, a
 * sentence trim). The stream here is that wire shape, through the adapter's
 * real `translate`, with redacted text.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: '黑兽', description: '', personality: '', scenario: '',
    first_mes: '……', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

/** Redacted stand-in with the real trace's shape: the card's planning block, then the prose meant as the body. */
const PIECES = [
  'Master，小此已经切换到日本語进行思考啦！\n',
  '<konatan_planning~>\n- 当前什么情况?\n</konatan_planning~>\n\n',
  '横杆搁在槽里，门没栓。',
]
const TRACE = PIECES.join('')

/** The SSE payloads DeepSeek sent for that floor: reasoning deltas, an empty content, stop, usage, [DONE]. */
function payloads(): string[] {
  return [
    JSON.stringify({ choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] }),
    ...PIECES.map(piece => JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: piece } }] })),
    JSON.stringify({ choices: [{ delta: { content: '', reasoning_content: null }, finish_reason: 'stop' }] }),
    JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 28272, completion_tokens: 4086, total_tokens: 32358,
        prompt_cache_hit_tokens: 6656, completion_tokens_details: { reasoning_tokens: 4086 },
      },
    }),
    '[DONE]',
  ]
}

const allReasoning: StreamFn = async function* () {
  async function* wire(): AsyncIterable<string> { yield* payloads() }
  yield* translate(wire())
}

/** The last message of a view. */
function last(view: ChatView): ChatView['messages'][number] {
  const message = view.messages[view.messages.length - 1]
  assert.ok(message !== undefined, 'the view has no messages')
  return message
}

test('a reply that is all reasoning is still there after a rebuild and after a restart', async (t) => {
  let ended: (view: ChatView) => void = () => {}
  const first = await createTestService(t, async ({ dir }) => {
    await mkdir(join(dir, 'characters'), { recursive: true })
    await writeFile(join(dir, 'characters', 'heishou.json'), CARD, 'utf8')
    return {
      stream: allReasoning,
      broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ended(event.view) },
    }
  }, 'iris-reasoning-persist-')
  const { chatId } = (await first.handlers['chat.create']({ characterId: 'heishou' })).view
  const settled = new Promise<ChatView>((resolve) => { ended = resolve })
  await first.handlers['chat.send']({ chatId, text: '继续' })
  const live = last(await settled)
  assert.equal(live.text, '', 'the model sent no body, and none is invented')
  assert.equal(live.reasoning, TRACE, 'the stream did not arrive as reasoning — this proves nothing')

  // The file itself, in the field SillyTavern reads.
  const file = parseChatFile(await readFile(join(first.dir, 'chats', `${chatId}.jsonl`), 'utf8'))
  const line = file.messages[file.messages.length - 1]
  assert.equal(line?.mes, '')
  assert.equal(line?.extra?.['reasoning'], TRACE, 'the trace never reached the file')

  // A rebuild: editing the user's line reimports the whole log from its export.
  const { view: edited } = await first.handlers['chat.editMessage']({ chatId, id: 1, text: '继续吧' })
  assert.equal(last(edited).reasoning, TRACE, 'an edit elsewhere erased the reply')

  // A restart: a second service over the same folder, sharing nothing but the files.
  const library = new CharacterLibrary(join(first.dir, 'characters'), '/iris/avatar')
  const second = await createTestService(t, { library, chats: new ChatStore(join(first.dir, 'chats'), library) })
  const { view: reopened } = await second.handlers['chat.open']({ chatId })
  assert.equal(last(reopened).text, '')
  assert.equal(last(reopened).reasoning, TRACE, 'the reply was gone after a restart')
})
