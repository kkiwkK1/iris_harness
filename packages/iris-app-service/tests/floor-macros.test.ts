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
 * The floor-addressing, outlet and budget macros, on the path that sends them.
 *
 * `@iris/macro`'s own tests prove each resolver against a hand-built context;
 * these prove the wiring — that a live generation's expander actually carries
 * the floors (`@iris/chat`'s candidate view), the scan's outlet buckets, and the
 * budget the assembler runs under, and that `{{firstIncludedMessageId}}` learns
 * its answer from the previous real turn, as upstream's chat metadata does.
 */

/** The system prompt asks every family at once, delimited for exact matching. */
const SYSTEM_PROMPT =
  'Outlet[{{outlet::achievements}}] Last[{{lastMessage}}] ' +
  'Swipe[{{lastSwipeId}}/{{currentSwipeId}}] ' +
  'Window[{{maxContext}}/{{maxResponse}}] Kept[{{firstIncludedMessageId}}]'

function cardWithOutletEntry(): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria', description: 'A cartographer.', personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', creator_notes: '',
      // Everything the B4 macros read, in one line the provider is handed.
      system_prompt: SYSTEM_PROMPT,
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1',
      extensions: {},
      character_book: {
        entries: [
          {
            // An `outlet`-positioned entry: parked under its name by the scan
            // and only rendered where `{{outlet::achievements}}` asks.
            keys: [], content: 'She has three achievements.',
            enabled: true, constant: true, insertion_order: 0,
            extensions: { position: 7, outlet_name: 'achievements' },
          },
        ],
      },
    },
  })
}

interface Fixture {
  handlers: Handlers
  seen: GenerateOptions[]
  settled: () => Promise<void>
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-floor-macros-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), cardWithOutletEntry(), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const seen: GenerateOptions[] = []
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
    onError: () => {},
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

/**
 * The whole text of one seen request — the system prompt, then every message.
 *
 * **The request, not the system slot.** That is this file's stated subject
 * ("the B4 macros reach the request") and it is now the only reading that can
 * be right: every macro in `SYSTEM_PROMPT` is on `cache-friendly.ts`'s
 * entropic list, so the cache-friendly order — on by default — carries that
 * section after the conversation instead of at the top. The macros still reach
 * the model, expanded; they arrive later in the request. *Where* they arrive is
 * `cache-friendly.test.ts`'s subject, and pinning it here as well would make
 * one change go red in two files for two different reasons.
 * @param options - the captured request.
 * @returns the system prompt and every message's text, concatenated.
 */
function requestText(options: GenerateOptions | undefined): string {
  if (options === undefined) return ''
  const messages = options.messages.map(message => message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(''))
  return [options.system ?? '', ...messages].join('\n')
}

test('the B4 macros reach the request with live floors, outlets and budget', async (t) => {
  const { handlers, seen, settled } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await handlers['chat.send']({ chatId, text: 'What has she earned?' })
  await settled()

  const first = requestText(seen[0])
  // The outlet bucket the scan parked under the name, joined onto the prompt.
  assert.match(first, /Outlet\[She has three achievements.\]/u, `outlet missing from: ${first}`)
  // The floor view: the newest floor is the user's message.
  assert.match(first, /Last\[What has she earned\?\]/u)
  // The swipe pair on a newest floor without candidates: empty, not zero.
  assert.match(first, /Swipe\[\/\]/u)
  // The assembler's own budget: the composition defaults.
  assert.match(first, /Window\[32768\/1024\]/u)
  // No generation has run before this one, so the boundary is unset.
  assert.match(first, /Kept\[\]/u)

  await handlers['chat.send']({ chatId, text: 'And now?' })
  await settled()

  const second = requestText(seen[1])
  assert.match(second, /Last\[And now\?\]/u)
  // The previous turn's assembly kept every floor, so the boundary is floor 0 —
  // one generation stale by design, exactly as upstream's metadata is.
  assert.match(second, /Kept\[0\]/u)
})
