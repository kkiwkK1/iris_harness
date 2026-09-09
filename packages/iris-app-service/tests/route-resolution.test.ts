import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { DebugReport, IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ConnectionStore } from '../src/connections.ts'
import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type ConnectionEndpoint, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Which route a generation actually goes out on.
 *
 * `settings.json` stores `provider` as a **reference** to a runtime adapter
 * route (`routeOf`), and the registry holding those routes lives as long as the
 * process and is filled only by an activation or the boot restore. Two things
 * follow, and both were measured on the operator's own profile on 2026-09-09:
 *
 * - Deleting a connection left the reference behind — `chats[<id>].provider`
 *   still read `"deepseek"` after the profile was gone.
 * - A second host started from the same data directory had never installed that
 *   route, so the chat's first generation died with `no adapter registered for
 *   provider "deepseek"` — a message about a registry, from a conversation
 *   whose settings nobody had touched.
 *
 * Upstream is not exposed to either: its connection profile is a snapshot of
 * *values* (api, model, preset written into settings when applied), so deleting
 * a profile leaves values behind and generation is unaffected. These tests hold
 * the two nets that make the reference safe: the delete that cleans the layers,
 * and the generation that resolves the route it was handed.
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

/** An endpoint that is never contacted: every route here is served by a mock stream. */
const ENDPOINT = 'https://api.deepseek.example/v1'

interface Host {
  handlers: Handlers
  service: IrisAppService
  settings: SettingsStore
  connections: ConnectionStore
  /** Every `installConnection` call this host made, in order. */
  installs: { route: string, endpoint: ConnectionEndpoint }[]
  /** The `provider` of every request that reached the stream, in order. */
  seen: string[]
  /** The retained reports, newest last. */
  reports: () => Promise<DebugReport[]>
  /** The report frames this host pushed to the browser, in order. */
  pushed: Extract<IrisEvent, { type: 'report' }>[]
  /** Resolve once the next generation has finished, however it finished. */
  settled: () => Promise<void>
}

/**
 * One host process over a data directory.
 *
 * A function rather than a fixture body so a test can start a **second** host
 * over the same directory — which is the shape of the original failure, and
 * the only way to test the boot restore without pretending the in-memory
 * stores of the first process survived a restart.
 * @param dir - the data directory this host is started on.
 * @returns the host's handlers and what it recorded.
 */
async function host(dir: string): Promise<Host> {
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'default', model: 'local-model' })
  const connections = new ConnectionStore(join(dir, 'connections.json'))
  // What the composition does before it constructs the service. **Load-bearing
  // for the restart test and for nothing else**: a second host that skipped it
  // would answer from its constructed defaults, so a persisted global route —
  // the very thing a restart has to honour — would never be read, and the test
  // would pass for the wrong reason.
  await settings.load()
  const installs: { route: string, endpoint: ConnectionEndpoint }[] = []
  const seen: string[] = []
  const pushed: Extract<IrisEvent, { type: 'report' }>[] = []
  const diagnostics = new DiagnosticBuffer()
  let ends = 0
  let waited = 0

  const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options.provider)
    const text = 'Understood.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const service = new IrisAppService({
    stream, library, chats, settings, connections, diagnostics,
    // Defaulted to empty rather than omitted: omitted is `process.env`, and the
    // host row would then depend on whoever ran the suite having `IRIS_BASE_URL`.
    env: {},
    userName: 'Traveller',
    installConnection: (route, endpoint) => { installs.push({ route, endpoint }) },
    broadcast: (event: IrisEvent) => {
      if (event.type === 'stream.end' || event.type === 'stream.error') ends += 1
      if (event.type === 'report') pushed.push(event)
    },
  })
  const handlers = service.handlers()

  return {
    handlers, service, settings, connections, installs, seen, pushed,
    reports: async () => (await handlers['debug.reports']({})).reports,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/** A data directory with one card in it, and the first host over it. */
async function fixture(t: TestContext): Promise<Host & { dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-route-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  return { dir, ...await host(dir) }
}

/**
 * Every report about a request that had to leave the route its settings named.
 *
 * Matched on the fall back rather than on the reason for it, because there are
 * two reasons and a test that filtered on one of them would count zero when the
 * other fired — which reads as "the request went out on the route it asked
 * for", the opposite of what happened.
 * @param reports - what the buffer retained.
 * @returns the fall-back reports, in the order they were made.
 */
function fallbacks(reports: readonly DebugReport[]): DebugReport[] {
  return reports.filter(report => report.message.includes('generates through the host\'s own route'))
}

test('deleting a connection returns the global layer to the host’s own route', async (t) => {
  const fixed = await fixture(t)
  const saved = await fixed.handlers['connection.save']({
    provider: 'deepseek', model: 'deepseek-chat', baseURL: ENDPOINT, apiKey: 'sk-x',
    sampling: { temperature: 0.7 },
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  await fixed.handlers['connection.activate']({ id })
  assert.equal(fixed.settings.get().provider, 'deepseek', 'the activation did not write the route')

  const deleted = await fixed.handlers['connection.delete']({ id })

  assert.deepEqual(deleted.cleared, { global: true, chats: [] })
  // Back to what the composition configured, which is the one route that
  // cannot dangle — not to some other profile's.
  assert.equal(fixed.settings.get().provider, 'default')
  // **The model and the sampling stay.** `patchOf` wrote all three, but only
  // `provider` was a reference to something that no longer exists; a model id
  // and a temperature are values, and upstream leaves exactly these behind.
  assert.equal(fixed.settings.get().model, 'deepseek-chat')
  assert.equal(fixed.settings.get().temperature, 0.7)

  const note = (await fixed.reports()).find(report => report.message.includes('cleared the settings layers'))
  assert.ok(note !== undefined, 'the deletion cleared a layer and said nothing')
  assert.match(note.message, /route "deepseek"/u)
})

test('deleting a connection drops the chat’s own route override and leaves other chats alone', async (t) => {
  const fixed = await fixture(t)
  const one = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  const other = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  const saved = await fixed.handlers['connection.save']({
    provider: 'deepseek', model: 'deepseek-chat', baseURL: ENDPOINT, apiKey: 'sk-x',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  await fixed.handlers['connection.activate']({ id, chatId: one })
  // The other conversation's own decision, made without any connection: it must
  // survive a deletion it has nothing to do with.
  await fixed.handlers['settings.set']({ chatId: other, settings: { temperature: 0.2 } })

  const deleted = await fixed.handlers['connection.delete']({ id })

  assert.deepEqual(deleted.cleared, { global: false, chats: [one] })
  assert.equal(fixed.settings.overrides(one).provider, undefined, 'the dangling override survived')
  assert.equal(fixed.settings.overrides(one).model, 'deepseek-chat', 'the model went with the route')
  assert.equal(fixed.settings.get(one).provider, 'default', 'the chat did not fall back to the host route')
  // Untouched, and the global layer with it — a chat-scoped activation never
  // wrote there, so a deletion must not write there either.
  assert.deepEqual(fixed.settings.overrides(other), { temperature: 0.2 })
  assert.equal(fixed.settings.get().provider, 'default')
})

test('deleting one of two profiles on a shared route clears nothing', async (t) => {
  const fixed = await fixture(t)
  // Two profiles of one provider take turns on one route (host §27), so the
  // route outlives either of them.
  const first = await fixed.handlers['connection.save']({
    provider: 'deepseek', model: 'deepseek-chat', baseURL: ENDPOINT, apiKey: 'sk-one',
  })
  const firstId = first.profiles[0]?.id
  assert.ok(firstId !== undefined)
  await fixed.handlers['connection.save']({
    provider: 'deepseek', model: 'deepseek-reasoner', baseURL: ENDPOINT, apiKey: 'sk-two',
  })
  await fixed.handlers['connection.activate']({ id: firstId })

  const deleted = await fixed.handlers['connection.delete']({ id: firstId })

  assert.deepEqual(deleted.cleared, { global: false, chats: [] })
  assert.equal(fixed.settings.get().provider, 'deepseek', 'the surviving sibling still serves this route')
})

test('deleting a profile that rode the host’s own route clears nothing', async (t) => {
  const fixed = await fixture(t)
  // No endpoint of its own and the composition's provider name: `routeOf`
  // leaves it on `default`, which the `llm-openai-compat` row owns.
  const saved = await fixed.handlers['connection.save']({ provider: 'default', model: 'local-model' })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  const chat = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await fixed.handlers['connection.activate']({ id, chatId: chat })
  await fixed.handlers['settings.set']({ chatId: chat, settings: { model: 'chosen-by-hand' } })

  const deleted = await fixed.handlers['connection.delete']({ id })

  assert.deepEqual(deleted.cleared, { global: false, chats: [] })
  assert.equal(fixed.settings.overrides(chat).provider, 'default', 'the host’s own route is not a dangling reference')
  assert.equal(fixed.settings.overrides(chat).model, 'chosen-by-hand')
})

test('a generation installs the route its settings name when this process never activated it', async (t) => {
  const fixed = await fixture(t)
  const chat = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  const saved = await fixed.handlers['connection.save']({
    provider: 'deepseek', model: 'deepseek-chat', baseURL: ENDPOINT, apiKey: 'sk-x',
  })
  assert.ok(saved.profiles[0]?.id !== undefined)
  // **Host A's write, replayed.** The route reaches the chat layer without this
  // process ever activating anything — which is what a second host started on
  // the same data directory finds on disk, and what used to reach the adapter
  // registry as `no adapter registered for provider "deepseek"`.
  await fixed.settings.set(chat, { provider: 'deepseek', model: 'deepseek-chat' })
  assert.deepEqual(fixed.installs, [], 'nothing has been installed yet')

  await fixed.handlers['chat.send']({ chatId: chat, text: 'Go on.' })
  await fixed.settled()

  assert.deepEqual(fixed.installs, [{
    route: 'deepseek',
    endpoint: { baseURL: ENDPOINT, apiKey: 'sk-x' },
  }], 'the profile on disk was not installed for the route its settings named')
  assert.deepEqual(fixed.seen, ['deepseek'], 'the request did not go out on the route it asked for')
  assert.deepEqual(fallbacks(await fixed.reports()), [], 'a route that exists was reported as dangling')
  // Nothing of the user's was changed, so nothing interrupts them: the install
  // is retained (the route and its origin) and not pushed.
  assert.deepEqual(fixed.pushed, [])

  // And the second turn does not re-install: the set records what this process
  // has served, so the resolution is a lookup rather than a repeated install.
  await fixed.handlers['chat.send']({ chatId: chat, text: 'Again.' })
  await fixed.settled()
  assert.equal(fixed.installs.length, 1, 'the route was installed twice')
  assert.deepEqual(fixed.seen, ['deepseek', 'deepseek'])
})

test('a generation on a deleted connection’s route falls back to the host, says so, and clears the layer', async (t) => {
  const fixed = await fixture(t)
  const chat = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  const sibling = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  // The state the operator's profile was actually in: a chat-layer `provider`
  // naming a connection that no longer exists anywhere on disk. Two chats,
  // because host A activated the connection on each of them and the route is
  // dead for both — the clear takes all of them, and the sentence has to count
  // rather than say "this conversation".
  await fixed.settings.set(chat, { provider: 'deepseek', model: 'deepseek-chat' })
  await fixed.settings.set(sibling, { provider: 'deepseek', model: 'deepseek-chat' })

  await fixed.handlers['chat.send']({ chatId: chat, text: 'Go on.' })
  await fixed.settled()

  // The turn generated rather than failing, and it generated somewhere real.
  assert.deepEqual(fixed.seen, ['default'])
  assert.deepEqual(fixed.installs, [], 'there was nothing to install')

  const said = fallbacks(await fixed.reports())
  assert.equal(said.length, 1, `expected one fallback report, got ${String(said.length)}`)
  const only = said[0]
  assert.ok(only !== undefined)
  assert.equal(only.grade, 'fault')
  assert.equal(only.chatId, chat)
  assert.match(only.message, /"deepseek"/u, 'the report does not name the connection that is gone')
  assert.match(only.message, /"default"/u, 'the report does not name the route it used instead')
  assert.match(only.message, /cleared/u, 'the report does not say the setting was repaired')
  assert.match(only.message, /this conversation's own setting/u)
  assert.match(only.message, /1 other conversation/u, 'the report undercounts what it changed')

  // Repaired, not merely reported — and only the reference.
  assert.equal(fixed.settings.overrides(chat).provider, undefined)
  assert.equal(fixed.settings.overrides(chat).model, 'deepseek-chat')
  assert.equal(fixed.settings.overrides(sibling).provider, undefined, 'the same dead route survived elsewhere')
  assert.equal(fixed.settings.overrides(sibling).model, 'deepseek-chat')

  // **And pushed, not only retained.** The panel reads settings when it is
  // opened, so a setting repaired in the middle of a turn is invisible until
  // something refetches — a report that has to be asked for is a report about a
  // value that is already gone by the time anyone asks.
  assert.equal(fixed.pushed.length, 1, `expected one pushed frame, got ${String(fixed.pushed.length)}`)
  assert.equal(fixed.pushed[0]?.report.message, only.message)
  assert.equal(fixed.pushed[0]?.report.grade, 'fault')

  // So the next turn is an ordinary one: same route, and no second report of a
  // fault that has been fixed.
  await fixed.handlers['chat.send']({ chatId: chat, text: 'Again.' })
  await fixed.settled()
  assert.deepEqual(fixed.seen, ['default', 'default'])
  assert.equal(fallbacks(await fixed.reports()).length, 1, 'the repair did not hold')
})

test('a dangling route in the global layer is caught, though the host row is read from that layer', async (t) => {
  const fixed = await fixture(t)
  const chat = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  // A global activation whose profile has since been deleted — the same state
  // `connection.delete` now prevents, reached here the way a second host
  // reaches it: by reading the file the first host wrote.
  await fixed.settings.set(undefined, { provider: 'deepseek' })

  await fixed.handlers['chat.send']({ chatId: chat, text: 'Go on.' })
  await fixed.settled()

  // **The case that separates the two readings of "the host's own provider".**
  // `#hostConnection()` answers from the global settings layer when the
  // composition hands no connection in, so a guard written against it would
  // compare the dangling name with itself, pass, and send the request to a
  // route with no adapter. The configured default is the only reading that
  // cannot dangle.
  assert.deepEqual(fixed.seen, ['default'])
  assert.equal(fixed.settings.get().provider, 'default', 'the global layer kept a route nothing serves')
  const said = fallbacks(await fixed.reports())
  assert.equal(said.length, 1)
  assert.match(said[0]?.message ?? '', /the global setting/u)
  assert.equal(fixed.pushed.length, 1, 'a repair of the global route was not pushed')
})

test('a card’s own generation resolves the route the same way a turn does', async (t) => {
  const fixed = await fixture(t)
  const chat = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await fixed.settings.set(chat, { provider: 'deepseek', model: 'deepseek-chat' })

  // `script.generateRaw` composes its own request from its own settings read,
  // so it is a separate caller with the same defect — and the resolution is in
  // `#stream`, which is the one place all four callers pass through.
  const answer = await fixed.handlers['script.generateRaw']({ chatId: chat, prompt: 'Classify this.' })

  assert.equal(answer.text, 'Understood.')
  assert.deepEqual(fixed.seen, ['default'])
  assert.equal(fallbacks(await fixed.reports()).length, 1)
  assert.equal(fixed.settings.overrides(chat).provider, undefined)
})

test('the route restored at boot is not installed a second time by the first generation', async (t) => {
  const fixed = await fixture(t)
  const saved = await fixed.handlers['connection.save']({
    provider: 'deepseek', model: 'deepseek-chat', baseURL: ENDPOINT, apiKey: 'sk-x',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  await fixed.handlers['connection.activate']({ id })
  assert.equal(fixed.installs.length, 1)

  // A restart: new stores over the same files, so nothing of the first
  // process's registry or its bookkeeping survives.
  const restarted = await host(fixed.dir)
  assert.equal(await restarted.service.restoreActiveConnection(), 'deepseek')
  assert.deepEqual(restarted.installs, [{
    route: 'deepseek',
    endpoint: { baseURL: ENDPOINT, apiKey: 'sk-x' },
  }])

  const chat = (await restarted.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await restarted.handlers['chat.send']({ chatId: chat, text: 'Go on.' })
  await restarted.settled()

  assert.deepEqual(restarted.seen, ['deepseek'])
  assert.equal(restarted.installs.length, 1, 'the boot-restored route was installed again by the first turn')
  assert.deepEqual(fallbacks(await restarted.reports()), [])
})

test('a host with no installer refuses the route rather than reporting it served', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-route-bare-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'default', model: 'local-model' })
  const connections = new ConnectionStore(join(dir, 'connections.json'))
  const seen: string[] = []
  const pushed: IrisEvent[] = []
  let ends = 0
  const service = new IrisAppService({
    stream: async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      seen.push(options.provider)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    library,
    chats: new ChatStore(join(dir, 'chats'), library),
    settings,
    connections,
    diagnostics: new DiagnosticBuffer(),
    env: {},
    userName: 'Traveller',
    // No `installConnection`: this composition cannot register adapters at all.
    broadcast: (event: IrisEvent) => {
      if (event.type === 'stream.end' || event.type === 'stream.error') ends += 1
      if (event.type === 'report') pushed.push(event)
    },
  })
  const handlers = service.handlers()
  const chat = (await handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await handlers['connection.save']({ provider: 'deepseek', model: 'deepseek-chat', baseURL: ENDPOINT })
  await settings.set(chat, { provider: 'deepseek' })

  await handlers['chat.send']({ chatId: chat, text: 'Go on.' })
  while (ends < 1) await new Promise(resolve => setTimeout(resolve, 1))

  // The profile is on disk, but nothing here can put an adapter behind it — so
  // "installed" must not be inferred from "the installer returned". The request
  // goes where something is actually listening.
  assert.deepEqual(seen, ['default'])
  const said = (await handlers['debug.reports']({})).reports
  assert.equal(fallbacks(said).length, 1)
  // And the setting is **not** repaired: the connection exists, so there is no
  // dangling reference to clean, only a host that cannot serve it.
  assert.equal(said.some(report => report.message.includes('no longer exists')), false)
  assert.equal(settings.overrides(chat).provider, 'deepseek')
  // **Nothing of the user's changed, so nothing is pushed.** The pushed channel
  // is for a value that is already gone; a fall back that left the setting
  // intact is a diagnosis to be fetched, not an interruption — and a channel
  // used for both stops meaning either.
  assert.deepEqual(pushed, [])
})
