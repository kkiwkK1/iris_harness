import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getActiveResourcesInfo } from 'node:process'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { appendCandidate, listCandidates, selectCandidate } from '@iris/chat'
import { exportChatFile, parseChatFile } from '@iris/persistence'
import { assemble, type HistoryEntry } from '@iris/pipeline'
import { resolvePreset, type ChatCompletionPreset } from '@iris/preset'

import { startMockProvider, type MockProvider } from './mock-provider.ts'

/**
 * The whole product spine in one test: a preset and a character become a
 * prompt, the prompt becomes a streamed reply, the reply becomes a swipeable
 * turn, and the turn exports as a SillyTavern chat file.
 */

let mock: MockProvider
let ctx: Context
let dataDir: string

before(async () => {
  mock = await startMockProvider()
  process.env.IRIS_BASE_URL = mock.baseURL
  process.env.IRIS_MODEL = 'mock-model'
  // An ephemeral port, because this boots the real composition and that file
  // defaults to 8787: without it the suite dies with EADDRINUSE for anyone who
  // happens to have `pnpm start` running in another terminal.
  process.env.IRIS_PORT = '0'
  // And a temporary data directory, for the same reason one step further in:
  // the composition defaults to `apps/iris/data`, which belongs to whatever
  // host the person running the suite has open. The app service now takes
  // `<dataDir>/host.lock` at startup and refuses a second host on one
  // directory, so an unset `IRIS_DATA_DIR` would make this suite either refuse
  // to boot beside a running `pnpm start` or write into its profile — which is
  // the incident the lock exists to close, performed by the test suite.
  dataDir = await mkdtemp(join(tmpdir(), 'iris-e2e-'))
  process.env.IRIS_DATA_DIR = dataDir
  // Headless: no interface, which keeps the static row out of the tree.
  delete process.env.IRIS_WEB_DIST
  ctx = await boot('iris-e2e', fileURLToPath(new URL('../cordis.yml', import.meta.url)))
})

after(async () => {
  await ctx.fiber.dispose()
  await mock.close()
  // `dispose` resolves before the handles it asked to close are closed: the
  // webserver's listen socket and the profile's last fs request drain over the
  // next few event-loop turns. Under `--test-force-exit` the runner calls
  // `process.exit()` the instant the tests finish, and exiting mid-close trips
  // libuv's closing-handle assert on Windows (0xC0000409, fail-fast) — the
  // process dies after reporting success and the file reads as failed. Let the
  // loop run down to stdio alone first; a forced exit then finds nothing
  // mid-close, the way every sibling file's exit already is.
  await quiesce()
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

/**
 * Wait until the process's live libuv handles are down to its own stdio, or a
 * short budget runs out — whichever comes first.
 *
 * `dispose` resolves before the handles it asked to close have closed: the
 * webserver's listen socket and the adapter's keep-alive connections take a
 * few event-loop turns to finish, and nothing reports them afterwards —
 * `getActiveResourcesInfo` drops a resource while its close is still in
 * flight, which reads as clean while it is not. The lower-level handle list is
 * the honest one. Waiting here matters because under `--test-force-exit` the
 * runner calls `process.exit()` the instant the tests finish, and exiting
 * mid-close trips libuv's closing-handle assert on Windows (0xC0000409,
 * fail-fast) — the process dies after reporting success and the file reads as
 * failed.
 *
 * The budget keeps a genuinely stuck teardown from turning this hook into the
 * hang `--test-force-exit` exists to prevent.
 */
async function quiesce(): Promise<void> {
  const handles = process as unknown as { _getActiveHandles?: () => unknown[] }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const remaining = (handles._getActiveHandles?.() ?? [])
      .map(handle => handle?.constructor?.name ?? 'unknown')
      .filter(name => name !== 'Pipe' && name !== 'Socket' || true)
    const busy = remaining.filter(name => /Server|TCP|FSReq|Immediate|Timeout|MessagePort|Worker/i.test(name))
    if (busy.length === 0) {
      // Keep-alive connections outlive their usefulness the moment the tests
      // end, and `--test-force-exit` exits while their close is still being
      // processed — the race that trips the libuv assert. Destroy them the
      // way the pool would when the process asked it to.
      for (const handle of handles._getActiveHandles?.() ?? []) {
        const socket = handle as { destroy?: () => void, constructor?: { name?: string } }
        if (socket.constructor?.name === 'Socket' && typeof socket.destroy === 'function') {
          socket.destroy()
        }
      }
      await new Promise(resolve => setTimeout(resolve, 25))
      return
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** A minimal Chat Completion preset with a post-history instruction. */
const PRESET: ChatCompletionPreset = {
  prompts: [
    { identifier: 'main', role: 'system', content: "Write Aria's next reply." },
    { identifier: 'charDescription', marker: true },
    { identifier: 'chatHistory', marker: true },
    { identifier: 'jailbreak', role: 'system', content: 'Stay in character.' },
  ],
  prompt_order: [{
    // 100001, not 100000: `openai.js` overrides `PromptManager`'s class default
    // for the Chat Completion path, so this is the sentinel a real preset is
    // ordered under. The old value still resolves through the legacy fallback,
    // which is exactly why it had to be changed — it would have gone on passing
    // while testing the wrong path.
    character_id: 100001,
    order: [
      { identifier: 'main', enabled: true },
      { identifier: 'charDescription', enabled: true },
      { identifier: 'chatHistory', enabled: true },
      { identifier: 'jailbreak', enabled: true },
    ],
  }],
}

/** Text of an assembled message list, for assertions. */
function texts(messages: readonly { text: string }[]): string[] {
  return messages.map(message => message.text)
}

/** Stream one reply through the registered adapter. */
async function generate(system: string, messages: readonly { role: string, text: string }[]) {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({
    provider: 'default',
    model: 'mock-model',
    system,
    messages: messages.map(message => createUserMessage({
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'user' },
    })),
    sampling: { topP: 0.92, minP: 0.05 },
  })) {
    assembler.push(chunk)
  }
  // Built from the assembled blocks rather than `assembler.message()`, which is
  // typed as a bare Message: a candidate is specifically model-produced. Same
  // correction as the turn driver's.
  return createAssistantMessage({
    content: assembler.blocks(),
    source: { provider: 'default', model: 'mock-model' },
  })
}

test('a preset and a character assemble into a prompt with post-history instructions last', () => {
  const contributions = resolvePreset(PRESET, {
    markers: { charDescription: 'Aria is a retired cartographer.' },
  })
  const history: HistoryEntry[] = [{ role: 'user', text: 'Hello?', pinned: true }]

  const request = assemble({
    contributions,
    history,
    budget: { context: 4096, reserve: 512, count: text => Math.ceil(text.length / 4) },
  })

  assert.match(request.system, /Write Aria's next reply\./)
  assert.match(request.system, /retired cartographer/)
  assert.deepEqual(texts(request.messages), ['Hello?', 'Stay in character.'])
})

test('the composition streams a reply through the Iris adapter', async () => {
  const message = await generate('You are Aria.', [{ role: 'user', text: 'Hello?' }])
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')

  assert.match(text, /Hello, traveller\./)
  assert.equal(message.content.some(block => block.type === 'reasoning'), true, 'reasoning stays its own block')
  assert.equal((mock.capture.body ?? {}).top_p, 0.92, 'Iris sampling reaches the wire')
})

test('a streamed reply becomes a swipeable turn that exports as a SillyTavern chat', async () => {
  const session = Session.create(SessionId('iris-e2e'))
  session.append('turn/start', { turn: 0 })
  session.append('step/start', { turn: 0, step: 0 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'Hello?' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )

  // Two generations: the second is a regenerate, which becomes a second swipe.
  const first = await generate('You are Aria.', [{ role: 'user', text: 'Hello?' }])
  appendCandidate(session, { turn: 0, step: 0, message: first })
  appendCandidate(session, {
    turn: 0,
    step: 0,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'A second take.' }],
      source: { provider: 'default', model: 'mock-model' },
    }),
  })

  assert.equal(listCandidates(session, 0).length, 2)

  // The user swipes back to the first.
  selectCandidate(session, 0, 0)

  const header = {
    user_name: 'Traveller',
    character_name: 'Aria',
    create_date: '2026-08-31 @00h00m00s',
    chat_metadata: {},
  }
  const file = parseChatFile(exportChatFile(session, header))

  assert.equal(file.messages.length, 2)
  assert.equal(file.messages[1]?.swipes?.length, 2, 'both generations survive as swipes')
  assert.equal(file.messages[1]?.swipe_id, 0, 'the swipe the user chose is the selected one')
  assert.match(String(file.messages[1]?.mes), /Hello, traveller\./)
})
