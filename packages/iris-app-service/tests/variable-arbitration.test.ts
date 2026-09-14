import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { SystemPluginDefinition } from '@iris/plugin-api'
import { StCompatBridge } from '@iris/compat-st-extension'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { CharacterLibrary } from '../src/library.ts'
import { MVU_CAPABILITY, TAVERN_HELPER_CAPABILITY } from '../src/plugins/capabilities.ts'
import type { MvuCapability } from '../src/plugins/mvu.ts'
import { createTavernHelperCapability } from '../src/plugins/tavern-helper.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { SystemPluginRuntime } from '../src/system-plugins.ts'
import { arbitrateMessageVariables } from '../src/variable-arbitration.ts'

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '', first_mes: 'Hello.',
    mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
    alternate_greetings: [], tags: [], creator: '', character_version: '1', extensions: {},
  },
})

interface Counts { st: number, mvu: number }

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  plugins: SystemPluginRuntime
  counts: Counts
  reports: string[]
  settle(): Promise<void>
}

async function fixture(
  t: TestContext,
  stFloor: Record<string, unknown> | undefined,
  mvuAfter: Record<string, unknown> | undefined,
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-variable-arbitration-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  const counts: Counts = { st: 0, mvu: 0 }
  const definitions: SystemPluginDefinition[] = [
    {
      id: 'tavern-helper', name: 'TH', description: '', version: '1', apiVersion: 1,
      activate: scope => scope.provide(TAVERN_HELPER_CAPABILITY, createTavernHelperCapability(scope.revision)),
    },
    {
      id: 'mvu', name: 'MVU', description: '', version: '1', apiVersion: 1,
      dependencies: ['tavern-helper'],
      activate(scope) {
        const capability: MvuCapability = {
          revision: scope.revision,
          initialState: () => ({ initialized_lorebooks: {}, stat_data: { shared: 0, mvuOnly: 0 } }),
          replay: (_texts, baseline) => baseline,
          update: (_text, baseline) => {
            counts.mvu += 1
            return {
              data: mvuAfter === undefined
                ? baseline
                : { ...baseline, ...structuredClone(mvuAfter) },
              reports: [],
            }
          },
        }
        return scope.provide(MVU_CAPABILITY, capability)
      },
    },
  ]
  const plugins = new SystemPluginRuntime({
    context: new Context(), file: join(dir, 'plugins.json'), definitions,
  })
  await plugins.initialize()
  t.after(async () => { await plugins.dispose() })

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(
    join(dir, 'chats'), library,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, plugins,
  )
  const bridge = new StCompatBridge()
  const reports: string[] = []
  let ends = 0
  let awaited = 0
  let handlers: Handlers
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = '<UpdateVariable>probe</UpdateVariable>'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  handlers = new IrisAppService({
    stream, library, chats, plugins,
    diagnostics: new DiagnosticBuffer(),
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'model' }),
    stCompat: {
      bridge, extensionId: () => 'prompt-template', revisionOf: () => 1,
      settingsFor: async () => ({}), persistSettings: async () => {},
      installFromDirectory: async () => { throw new Error('not under test') },
    },
    broadcast(event: IrisEvent) {
      if (event.type === 'stream.end' || event.type === 'stream.error') {
        if (event.type === 'stream.error') reports.push(JSON.stringify(event))
        ends += 1
        return
      }
      if (event.type !== 'st-compat.request') return
      if (event.kind === 'generate') {
        const payload = event.payload as { messages: Array<{ role: string, content: string }> }
        handlers['stCompat.submit']({
          token: event.token, kind: 'generate', pluginRevision: event.revision,
          result: { kind: 'generate', messages: payload.messages, chatVariables: {}, globalVariables: {} },
        })
        return
      }
      counts.st += 1
      const payload = event.payload as { turn: number, text: string }
      handlers['stCompat.submit']({
        token: event.token, kind: 'reply', pluginRevision: event.revision,
        result: {
          kind: 'reply', turn: payload.turn, mes: payload.text,
          chatVariables: {}, globalVariables: {},
          ...stFloor === undefined ? {} : { floorVariables: structuredClone(stFloor) },
        },
      })
    },
    onError: error => { reports.push(error.message) },
  }).handlers()
  await handlers['stCompat.plane.attach']({ extensionId: 'prompt-template', pluginRevision: 1 })
  return {
    handlers, chats, plugins, counts, reports,
    settle: async () => {
      awaited += 1
      while (ends < awaited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

async function oneTurn(f: Fixture): Promise<{ variables: Record<string, unknown>, commits: number, reports: string[] }> {
  const created = await f.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  const entry = await f.chats.open(chatId)
  const before = entry.session.events.filter(event => event.type === 'iris/variables').length
  await f.handlers['chat.send']({ chatId, text: 'go' })
  await f.settle()
  const after = entry.session.events.filter(event => event.type === 'iris/variables').length
  const variables = await f.handlers['script.getVariables']({ chatId, scope: 'message', messageId: 'latest' })
  const debug = await f.handlers['debug.reports']({})
  return {
    variables: variables.variables,
    commits: after - before,
    reports: debug.reports.map(report => report.message),
  }
}

test('disjoint ST and MVU proposals survive one host commit', async (t) => {
  const f = await fixture(t,
    { initialized_lorebooks: {}, stat_data: { shared: 0, mvuOnly: 0 }, stOnly: 1 },
    { stat_data: { shared: 0, mvuOnly: 2 } },
  )
  const result = await oneTurn(f)
  assert.deepEqual(f.counts, { st: 1, mvu: 1 }, JSON.stringify({ result, errors: f.reports }))
  assert.equal(result.commits, 1)
  assert.equal(result.variables['stOnly'], 1)
  assert.deepEqual(result.variables['stat_data'], { shared: 0, mvuOnly: 2 })
})

test('same-key conflict follows ST handler order and names the MVU winner', async (t) => {
  const f = await fixture(t,
    { initialized_lorebooks: {}, stat_data: { shared: 1, mvuOnly: 0 } },
    { stat_data: { shared: 2, mvuOnly: 0 } },
  )
  const result = await oneTurn(f)
  assert.deepEqual(f.counts, { st: 1, mvu: 1 })
  assert.equal(result.commits, 1)
  assert.equal((result.variables['stat_data'] as Record<string, unknown>)['shared'], 2)
  assert.ok(result.reports.some(message =>
    message.includes('stat_data.shared')
    && message.includes('prompt-template')
    && message.includes('mvu')
    && message.includes('mvu won')))
})

test('disabling either processor leaves the other as the sole one-commit writer', async (t) => {
  const stOnly = await fixture(t,
    { initialized_lorebooks: {}, stat_data: { shared: 1, mvuOnly: 0 }, stOnly: 3 },
    { stat_data: { shared: 2, mvuOnly: 4 } },
  )
  await stOnly.plugins.disable('mvu')
  const first = await oneTurn(stOnly)
  assert.deepEqual(stOnly.counts, { st: 1, mvu: 0 })
  assert.equal(first.commits, 1)
  assert.equal(first.variables['stOnly'], 3)

  const mvuOnly = await fixture(t, undefined, { stat_data: { shared: 5, mvuOnly: 6 } })
  await mvuOnly.handlers['stCompat.plane.detach']({ extensionId: 'prompt-template', pluginRevision: 1 })
  const second = await oneTurn(mvuOnly)
  assert.deepEqual(mvuOnly.counts, { st: 0, mvu: 1 })
  assert.equal(second.commits, 1)
  assert.deepEqual(second.variables['stat_data'], { shared: 5, mvuOnly: 6 })
})

test('the pure arbitrator keeps unrelated nested keys and applies later conflicts only', () => {
  const result = arbitrateMessageVariables(
    { nested: { same: 0, kept: 0 } },
    [
      { pluginId: 'prompt-template', before: { nested: { same: 0, kept: 0 } }, after: { nested: { same: 1, kept: 0 }, st: true } },
      { pluginId: 'mvu', before: { nested: { same: 0, kept: 0 } }, after: { nested: { same: 2, kept: 3 } } },
    ],
  )
  assert.deepEqual(result.variables, { nested: { same: 2, kept: 3 }, st: true })
  assert.deepEqual(result.conflicts, [{
    key: 'nested.same', earlierPluginId: 'prompt-template', laterPluginId: 'mvu', winnerPluginId: 'mvu',
  }])
})
