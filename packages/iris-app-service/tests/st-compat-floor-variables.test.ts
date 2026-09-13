import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import { StCompatBridge } from '@iris/compat-st-extension'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ExtensionSettingsStore } from '../src/context.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * The bridge context's floor variables.
 *
 * The reply bridge writes each reply's setvar results onto the floor's
 * message-scope layer (`chat[turn].variables` upstream), and the template's
 * variable cache reads message-over-chat. The context must therefore hydrate
 * every floor with its persisted layer: without it, a rebuilt frame (page
 * reload, chat switch, disable/enable) restarts the accumulator chain from the
 * chat scope and the value visibly regresses — one round the extension reads
 * 20, the next it reads 0 again, with nothing on the host having changed.
 *
 * The fixture answers the bridge rounds neutrally and writes the layer the way
 * the production host persists it (host-side, per turn), because this fixture
 * has no system-plugin runtime: `recordVariables` then falls back to the
 * built-in compat MVU engine, whose whole-table reply write is a different
 * writer than the one under test here (in production MVU disabled means the
 * bridge's floor merge is the only writer on that layer).
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '1', extensions: {},
  },
})

/** A stream that answers with one scripted reply and records what it was asked. */
function scripted(replies: readonly string[]): StreamFn {
  let call = 0
  return async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = replies[Math.min(call, replies.length - 1)] ?? ''
    call += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Fixture {
  handlers: Handlers
  /** Every `st-compat.request` broadcast, oldest first (answered in place). */
  rounds: Array<{ kind: string, payload: Record<string, unknown> }>
  settled: () => Promise<void>
}

async function fixture(t: TestContext, replies: readonly string[]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-st-floors-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const extensionSettings = new ExtensionSettingsStore(join(dir, 'extension-settings.json'))
  const bridge = new StCompatBridge()
  const rounds: Fixture['rounds'] = []
  let ends = 0
  let waited = 0
  let handlers: Handlers

  handlers = new IrisAppService({
    stream: scripted(replies),
    library,
    chats,
    settings,
    extensionSettings,
    stCompat: {
      bridge,
      extensionId: () => 'st-ext',
      revisionOf: () => 7,
      settingsFor: async () => ({}),
      persistSettings: async () => {},
      installFromDirectory: async () => { throw new Error('not under test') },
    },
    broadcast: (event: IrisEvent) => {
      if (event.type === 'stream.end') { ends += 1; return }
      if (event.type === 'st-compat.request') {
        rounds.push({ kind: event.kind, payload: event.payload as Record<string, unknown> })
        // Answer in place so the waiting pipeline proceeds: the generate round
        // passes its messages through untouched, the reply round passes the
        // text through with no variable writes of its own.
        if (event.kind === 'generate') {
          const payload = event.payload as { messages: Array<{ role: string, content: string }> }
          handlers['stCompat.submit']({
            token: event.token, kind: 'generate', pluginRevision: event.revision,
            result: { kind: 'generate', messages: payload.messages, chatVariables: {}, globalVariables: {} },
          })
        } else {
          const payload = event.payload as { turn: number, text: string }
          handlers['stCompat.submit']({
            token: event.token, kind: 'reply', pluginRevision: event.revision,
            result: {
              kind: 'reply', turn: payload.turn, mes: payload.text,
              chatVariables: {}, globalVariables: {}, floorVariables: {},
            },
          })
        }
      }
    },
    userName: 'Traveller',
  }).handlers()

  await handlers['stCompat.plane.attach']({ extensionId: 'st-ext', pluginRevision: 7 })

  return {
    handlers,
    rounds,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

test('the bridge context hydrates each floor with its persisted message layer', async (t) => {
  const { handlers, rounds, settled } = await fixture(t, ['One.', 'Two.'])
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  // Turn 1 runs neutral; then a host-side write persists the layer the way the
  // reply bridge's own floor merge does in production.
  await handlers['chat.send']({ chatId, text: 'one' })
  await settled()
  await handlers['script.setVariables']({
    chatId, scope: 'message', messageId: 1, op: 'insertOrAssign', variables: { 好感度: 10 },
  })

  // Turn 2: the reply bridge's context must carry that layer on the floor it
  // addresses — the accumulated value a rebuilt frame would otherwise lose.
  rounds.length = 0
  await handlers['chat.send']({ chatId, text: 'two' })
  await settled()
  const replyRound = rounds.filter(one => one.kind === 'reply').at(-1)
  assert.ok(replyRound !== undefined, 'a reply round was broadcast')
  const turn = (replyRound.payload as { turn: number }).turn
  const floors = (replyRound.payload as { chat: Array<{ variables?: Record<string, unknown> }> }).chat
  assert.ok(turn >= 1, 'the reply addresses a real turn')
  assert.equal((floors[turn - 1]?.variables as Record<string, unknown> | undefined)?.['好感度'], 10,
    'the floor below the reply carries the layer the previous turn persisted')
})

test('a floor with no persisted variables hydrates an empty table, not undefined', async (t) => {
  const { handlers, rounds, settled } = await fixture(t, ['Only.'])
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  rounds.length = 0
  await handlers['chat.send']({ chatId, text: 'hi' })
  await settled()
  const replyRound = rounds.filter(one => one.kind === 'reply').at(-1)
  assert.ok(replyRound !== undefined)
  const floors = (replyRound.payload as { chat: Array<{ variables?: Record<string, unknown> }> }).chat
  for (const floor of floors) {
    assert.deepEqual(floor.variables ?? {}, {}, 'an untouched floor reads as an empty table')
  }
})
