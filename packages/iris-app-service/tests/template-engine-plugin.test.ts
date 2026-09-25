import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { StCompatBridge } from '@iris/compat-st-extension'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { builtinSystemPluginDefinitions, MVU_PLUGIN_ID, TAVERN_HELPER_PLUGIN_ID } from '../src/plugins/builtins.ts'
import {
  retiredTemplatesEnvNotice,
  seedsTemplateEngine,
  TEMPLATE_ENGINE_PLUGIN_ID,
} from '../src/plugins/template-engine.ts'
import type { Handlers, StCompatOptions } from '../src/service.ts'
import { SystemPluginRuntime } from '../src/system-plugins.ts'
import { ChatStore } from '../src/chats.ts'
import { WorldbookStore } from '../src/worldbooks.ts'
import { promptTexts } from '../src/templates.ts'
import { createTestService } from './support/service.ts'
import { removeTempDir, tempDirOwned } from './support/temp-dir.ts'

/**
 * Iris's EJS engine as the builtin catalog row `iris-templates` (ruling 7).
 *
 * The claims are about the switch, not about EJS (`@iris/compat-prompt-template`
 * owns that against upstream): the row's absence is today's `templates: false`
 * byte for byte, its presence evaluates a world-book entry, a toggle takes
 * effect on the next request without a restart, the retired `IRIS_TEMPLATES`
 * seeds only a row nobody has decided, and with the ST plane's extension also
 * enabled exactly one engine touches a request.
 */

/** A card bound to the disk world book `atlas`, and nothing templated of its own. */
const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: 'A cartographer.', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: { world: 'atlas' },
  },
})

/**
 * The disk book, one constant entry carrying the template — the shape two
 * thirds of the corpus's EJS volume has (disk world books, not card fields).
 */
function book(content: string): string {
  return JSON.stringify({
    entries: {
      0: {
        uid: 0, key: [], keysecondary: [], comment: '[EJS] weather',
        content, constant: true, disable: false,
        order: 100, position: 0, depth: 4, role: 0, selective: false,
        addMemo: true, excludeRecursion: false, preventRecursion: false,
        probability: 100, useProbability: true, extensions: { position: 0, depth: 4, role: 0 },
      },
    },
  })
}

const ENTRY = 'The weather is <%= getvar("mood") %> in the west tower.'

interface Fixture {
  handlers: Handlers
  runtime: SystemPluginRuntime
  seen: GenerateOptions[]
  reports: string[]
  /** Send one line and wait for its stream to end; returns what the provider was handed. */
  send: (chatId: string, text: string) => Promise<string>
}

async function fixture(
  t: TestContext,
  options: { entry?: string, stCompat?: (answer: () => Handlers) => StCompatOptions & { onRequest?: (event: IrisEvent) => void } } = {},
): Promise<Fixture> {
  // `tempDirOwned`, not `tempDir`: the runtime writes its catalog into this
  // directory until it is disposed, and a `tempDir` removal registered here
  // would run before the `t.after` that disposes it.
  const pluginDir = await tempDirOwned('iris-template-engine-')
  const runtime = new SystemPluginRuntime({
    context: new Context(),
    file: join(pluginDir, 'system-plugins.json'),
    definitions: builtinSystemPluginDefinitions({ templates: { deadlineMs: 5000 } }),
  })
  t.after(async () => {
    await runtime.dispose()
    await removeTempDir(pluginDir)
  })
  await runtime.initialize()

  const seen: GenerateOptions[] = []
  const reports: string[] = []
  let ends = 0
  const stream: StreamFn = async function* (request: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(request)
    const text = 'A reply.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  let handlers: Handlers | undefined
  const plane = options.stCompat?.(() => handlers as Handlers)
  const built = await createTestService(t, async ({ dir, library }) => {
    await mkdir(join(dir, 'characters'), { recursive: true })
    await mkdir(join(dir, 'worlds'), { recursive: true })
    await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
    await writeFile(join(dir, 'worlds', 'atlas.json'), book(options.entry ?? ENTRY), 'utf8')
    const worldbooks = new WorldbookStore(join(dir, 'worlds'))
    return {
      stream,
      plugins: runtime,
      worldbooks,
      chats: new ChatStore(join(dir, 'chats'), library, undefined, undefined, worldbooks),
      ...plane === undefined ? {} : { stCompat: plane },
      broadcast: (event: IrisEvent) => {
        if (event.type === 'stream.end') ends += 1
        plane?.onRequest?.(event)
      },
      onError: (error: Error) => { reports.push(error.message) },
    }
  }, 'iris-template-engine-svc-')
  handlers = built.handlers
  const bound = built.handlers

  return {
    handlers: bound,
    runtime,
    seen,
    reports,
    send: async (chatId, text) => {
      const before = ends
      const count = seen.length
      await bound['chat.send']({ chatId, text })
      while (ends <= before) await new Promise(resolve => setTimeout(resolve, 1))
      const request = seen[count]
      return request === undefined ? '' : promptTexts(request).join('\n')
    },
  }
}

test('the engine row ships installed and off, and off is today\'s templates: false', async (t) => {
  const { handlers, runtime, send } = await fixture(t)
  const row = runtime.snapshot().plugins.find(plugin => plugin.id === TEMPLATE_ENGINE_PLUGIN_ID)
  // A toggle, not an install step, and not on.
  assert.equal(row?.installed, true)
  assert.equal(row?.enabled, false)
  assert.equal(row?.status, 'disabled')
  assert.equal(row?.source, 'builtin')

  const chatId = (await handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await handlers['script.setVariables']({ chatId, scope: 'chat', op: 'replace', variables: { mood: 'bright' } })
  const sent = await send(chatId, 'How is it?')
  // Raw passthrough: not evaluated to empty, untouched.
  assert.match(sent, /The weather is <%= getvar\("mood"\) %> in the west tower\./u)

  // And the named refusal a card's evalTemplate gets, naming where the switch is.
  await assert.rejects(
    handlers['script.evalTemplate']({ chatId, content: '<%= 1 + 1 %>' }),
    /needs the "Iris EJS templates" plugin, which is not enabled in the plugin center/u,
  )
})

test('enabling the row evaluates a world-book entry on the next request, and disabling stops it, with no restart', async (t) => {
  const { handlers, send } = await fixture(t)
  const chatId = (await handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await handlers['script.setVariables']({ chatId, scope: 'chat', op: 'replace', variables: { mood: 'bright' } })

  await handlers['plugin.enable']({ id: TEMPLATE_ENGINE_PLUGIN_ID })
  const on = await send(chatId, 'How is it?')
  assert.match(on, /The weather is bright in the west tower\./u)
  assert.equal(on.includes('<%'), false, 'a template tag reached the provider with the engine enabled')
  assert.deepEqual(await handlers['script.evalTemplate']({ chatId, content: '<%= 1 + 1 %>' }), { text: '2' })

  await handlers['plugin.disable']({ id: TEMPLATE_ENGINE_PLUGIN_ID })
  const off = await send(chatId, 'And now?')
  assert.match(off, /<%= getvar\("mood"\) %>/u)
})

test('a composition names one switch: templates and plugins together are refused', async (t) => {
  const pluginDir = await tempDirOwned('iris-template-engine-pair-')
  const runtime = new SystemPluginRuntime({
    context: new Context(), file: join(pluginDir, 'system-plugins.json'), definitions: builtinSystemPluginDefinitions(),
  })
  t.after(async () => {
    await runtime.dispose()
    await removeTempDir(pluginDir)
  })
  await assert.rejects(
    createTestService(t, { plugins: runtime, templates: {} }),
    /two switches for one engine/u,
  )
})

/**
 * An ST extension plane that is enabled, and — when `armed` — answers its
 * `generate` round the way ST-Prompt-Template does: it expands the entry, and
 * one of its outputs is a literal `<%= … %>` (what EJS renders from an escaped
 * `<%%= … %>`). A second evaluator over that output would execute it.
 */
function stPlane(armed: boolean) {
  return (answer: () => Handlers): StCompatOptions & { onRequest: (event: IrisEvent) => void } => ({
    bridge: new StCompatBridge(),
    extensionId: () => 'st-prompt-template',
    revisionOf: () => 7,
    settingsFor: async () => ({}),
    persistSettings: async () => {},
    installFromDirectory: async () => { throw new Error('not under test') },
    onRequest: (event) => {
      if (event.type !== 'st-compat.request' || !armed) return
      if (event.kind === 'generate') {
        const payload = event.payload as { messages: Array<{ role: string, content: string }> }
        void answer()['stCompat.submit']({
          token: event.token, kind: 'generate', pluginRevision: event.revision,
          result: {
            kind: 'generate',
            messages: payload.messages.map(message => ({
              ...message,
              content: message.content.replace('<%= getvar("mood") %>', 'ST-RENDERED <%= "NATIVE-RAN" %>'),
            })),
            chatVariables: {}, globalVariables: {},
          },
        })
      } else if (event.kind === 'reply') {
        const payload = event.payload as { turn: number, text: string, chatVariables: Record<string, unknown> }
        void answer()['stCompat.submit']({
          token: event.token, kind: 'reply', pluginRevision: event.revision,
          result: {
            kind: 'reply', turn: payload.turn, mes: payload.text,
            chatVariables: payload.chatVariables, globalVariables: {}, floorVariables: {},
          },
        })
      }
    },
  })
}

test('both engines enabled: the ST plane expands, Iris\'s engine stands down, nothing is evaluated twice', async (t) => {
  const { handlers, send, reports } = await fixture(t, { stCompat: stPlane(true) })
  await handlers['stCompat.plane.attach']({ extensionId: 'st-prompt-template', pluginRevision: 7 })
  await handlers['plugin.enable']({ id: TEMPLATE_ENGINE_PLUGIN_ID })
  const chatId = (await handlers['chat.create']({ characterId: 'aria' })).view.chatId

  const sent = await send(chatId, 'How is it?')
  assert.match(sent, /The weather is ST-RENDERED/u, 'the ST plane did not expand the entry')
  // The literal the extension produced goes out as the extension produced it.
  // Evaluated a second time it would read "NATIVE-RAN" with the tags gone.
  assert.match(sent, /ST-RENDERED <%= "NATIVE-RAN" %> in the west tower\./u)
  assert.ok(
    reports.some(message => /stands down while an ST extension is enabled/u.test(message)),
    `the stand-down was not reported; saw ${JSON.stringify(reports)}`,
  )

  // evalTemplate is a call a card makes by name, and it still answers.
  assert.deepEqual(await handlers['script.evalTemplate']({ chatId, content: '<%= 1 + 1 %>' }), { text: '2' })
})

test('both engines enabled but no page armed: the prompt goes out as written, and says why', async (t) => {
  const { handlers, send, reports } = await fixture(t, { stCompat: stPlane(false) })
  await handlers['plugin.enable']({ id: TEMPLATE_ENGINE_PLUGIN_ID })
  const chatId = (await handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await handlers['script.setVariables']({ chatId, scope: 'chat', op: 'replace', variables: { mood: 'bright' } })

  const sent = await send(chatId, 'How is it?')
  // Catalog state decides, not whether the plane answered this time: the same
  // two rows always give the same engine.
  assert.match(sent, /<%= getvar\("mood"\) %>/u)
  assert.ok(reports.some(message => /stands down while an ST extension is enabled/u.test(message)))
})

/**
 * The migration of the retired `IRIS_TEMPLATES`, through the runtime's own
 * reader: the composition passes `defaultEnabled` computed by
 * `seedsTemplateEngine`, and the file on disk is what a later boot reads.
 */
async function bootRuntime(file: string, env: string | undefined): Promise<{ enabled: boolean, seeded: boolean, notice: string | undefined, dispose: () => Promise<void> }> {
  const runtime = new SystemPluginRuntime({
    context: new Context(),
    file,
    definitions: builtinSystemPluginDefinitions(),
    // The composition's own expression (`index.ts`), restated as a call.
    defaultEnabled: [
      TAVERN_HELPER_PLUGIN_ID,
      MVU_PLUGIN_ID,
      ...seedsTemplateEngine({ value: env }) ? [TEMPLATE_ENGINE_PLUGIN_ID] : [],
    ],
  })
  await runtime.initialize()
  const seeded = runtime.seededAtBoot(TEMPLATE_ENGINE_PLUGIN_ID)
  const enabled = runtime.isEnabled(TEMPLATE_ENGINE_PLUGIN_ID)
  return {
    enabled,
    seeded,
    notice: retiredTemplatesEnvNotice({ value: env }, { seeded, enabled }),
    dispose: () => runtime.dispose(),
  }
}

test('IRIS_TEMPLATES=1 seeds the row enabled once, for a profile that already had a catalog, and never overrides a stored row', async (t) => {
  const dir = await tempDirOwned('iris-template-engine-env-')
  t.after(async () => { await removeTempDir(dir) })
  const file = join(dir, 'system-plugins.json')
  // An operator's profile from before this build: TH and MVU rows, no engine row.
  await writeFile(file, JSON.stringify({
    version: 2,
    revision: 4,
    plugins: {
      [TAVERN_HELPER_PLUGIN_ID]: { installed: true, enabled: true, source: 'builtin' },
      [MVU_PLUGIN_ID]: { installed: true, enabled: true, source: 'builtin' },
    },
  }), 'utf8')

  const first = await bootRuntime(file, '1')
  await first.dispose()
  assert.equal(first.seeded, true)
  assert.equal(first.enabled, true, 'an operator who ran with IRIS_TEMPLATES=1 lost the engine on upgrade')
  assert.match(first.notice ?? '', /IRIS_TEMPLATES is retired/u)
  assert.match(first.notice ?? '', /turned on once/u)
  const stored = JSON.parse(await readFile(file, 'utf8')) as { plugins: Record<string, { enabled: boolean }> }
  assert.equal(stored.plugins[TEMPLATE_ENGINE_PLUGIN_ID]?.enabled, true, 'the seed was not persisted as the row')

  // Someone turns it off in the plugin center; the variable is still set.
  stored.plugins[TEMPLATE_ENGINE_PLUGIN_ID] = { ...stored.plugins[TEMPLATE_ENGINE_PLUGIN_ID]!, enabled: false }
  await writeFile(file, JSON.stringify(stored), 'utf8')
  const second = await bootRuntime(file, '1')
  await second.dispose()
  assert.equal(second.seeded, false)
  assert.equal(second.enabled, false, 'the retired variable overrode the plugin center')
  assert.match(second.notice ?? '', /stored state stands \(disabled\).*was ignored/u)

  // Without the variable: no notice, row as stored.
  const third = await bootRuntime(file, undefined)
  await third.dispose()
  assert.equal(third.enabled, false)
  assert.equal(third.notice, undefined)
})

test('without IRIS_TEMPLATES a new profile\'s engine row starts off, and any other value is only reported', async (t) => {
  const dir = await tempDirOwned('iris-template-engine-fresh-')
  t.after(async () => { await removeTempDir(dir) })

  const fresh = await bootRuntime(join(dir, 'a.json'), undefined)
  await fresh.dispose()
  assert.equal(fresh.seeded, true)
  assert.equal(fresh.enabled, false)
  assert.equal(fresh.notice, undefined)

  // The old switch was `=== '1'`; `0` never turned it on and does not now.
  const zero = await bootRuntime(join(dir, 'b.json'), '0')
  await zero.dispose()
  assert.equal(zero.enabled, false)
  assert.match(zero.notice ?? '', /IRIS_TEMPLATES="0"\) was ignored/u)
})
