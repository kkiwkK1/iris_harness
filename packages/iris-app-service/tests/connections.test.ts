import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createServer, type Server } from 'node:http'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ConnectionStore, routeOf } from '../src/connections.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type ConnectionEndpoint, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Saved connections.
 *
 * The property worth guarding is the one upstream loses: a profile's displayed
 * name and its contents cannot disagree, because nothing displayed is stored.
 * Measured on the user's own install, their selected profile reads
 * `deepseek deepseek-chat - Default` and points at a Gemini model on another
 * endpoint — true when written, wrong ever since.
 *
 * The endpoint-and-key half adds one more asymmetry to guard: the key is
 * **write-only**. It lands in the store (the profile's own file, inside the
 * gitignored data folder) and it reaches the adapter's request headers — and
 * nowhere else, ever. Every read answers with `hasKey` and, when the key is
 * long enough not to be given away by it, its last four characters.
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

const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function fixture(
  t: TestContext,
  options: { probeTimeoutMs?: number, installConnection?: (route: string, endpoint: ConnectionEndpoint) => void } = {},
): Promise<{
  handlers: Handlers
  settings: SettingsStore
  dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-conn-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'default', model: 'local-model' })
  const connections = new ConnectionStore(join(dir, 'connections.json'))

  const handlers = new IrisAppService({
    stream, library, chats, settings, connections,
    broadcast: () => {},
    userName: 'Traveller',
    ...options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs },
    ...options.installConnection === undefined ? {} : { installConnection: options.installConnection },
  }).handlers()

  return { handlers, settings, dir }
}

test('a profile’s summary follows its contents, because it is not stored', async (t) => {
  const { handlers, dir } = await fixture(t)

  const created = await handlers['connection.save']({ provider: 'deepseek', model: 'deepseek-chat' })
  const id = created.profiles[0]?.id
  assert.ok(id !== undefined)
  assert.equal(created.profiles[0]?.summary, 'deepseek · deepseek-chat')

  // The exact move that breaks upstream: change the model, keep the profile.
  const updated = await handlers['connection.save']({ id, provider: 'openrouter', model: 'gemini-2.5-pro' })
  assert.equal(updated.profiles[0]?.summary, 'openrouter · gemini-2.5-pro')

  // And nothing derived is on disk to go stale.
  const file = JSON.parse(await readFile(join(dir, 'connections.json'), 'utf8')) as { profiles: Record<string, unknown>[] }
  assert.equal('summary' in (file.profiles[0] ?? {}), false, 'the summary is derived, never written')
})

test('a user’s own label is kept and never overwritten by a derived one', async (t) => {
  const { handlers } = await fixture(t)

  const saved = await handlers['connection.save']({
    label: '便宜的那个',
    provider: 'deepseek',
    model: 'deepseek-chat',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  const changed = await handlers['connection.save']({ id, label: '便宜的那个', provider: 'x', model: 'y' })
  // The label is the user's words, so it cannot go stale — only they can change
  // it. The summary next to it tells the truth about the contents.
  assert.equal(changed.profiles[0]?.label, '便宜的那个')
  assert.equal(changed.profiles[0]?.summary, 'x · y')
})

test('activating a profile applies it through the settings guard', async (t) => {
  const { handlers } = await fixture(t)
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-chat',
    sampling: { temperature: 0.7, topP: 0.9 },
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  const applied = await handlers['connection.activate']({ id })

  assert.equal(applied.settings.provider, 'deepseek')
  assert.equal(applied.settings.model, 'deepseek-chat')
  assert.equal(applied.settings.temperature, 0.7)
  assert.equal(applied.activeId, id)
  assert.equal((await handlers['connection.list']({})).activeId, id)
})

test('a profile cannot store a value that setting it by hand would be refused', async (t) => {
  const { handlers } = await fixture(t)

  // Sampling goes through the same `sanitize` a settings patch does, so a
  // profile is not a way around the range checks.
  await assert.rejects(
    () => handlers['connection.save']({ provider: 'p', model: 'm', sampling: { topP: 4 } }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
})

test('activating for one chat leaves the global route alone', async (t) => {
  const { handlers } = await fixture(t)
  const chat = await handlers['chat.create']({ characterId: 'aria' })
  const saved = await handlers['connection.save']({ provider: 'deepseek', model: 'deepseek-chat' })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  await handlers['connection.activate']({ id, chatId: chat.view.chatId })

  assert.equal((await handlers['settings.get']({ chatId: chat.view.chatId })).settings.model, 'deepseek-chat')
  assert.equal((await handlers['settings.get']({})).settings.model, 'local-model', 'the global layer is untouched')
})

test('deleting the active profile clears the active id with it', async (t) => {
  const { handlers } = await fixture(t)
  const saved = await handlers['connection.save']({ provider: 'p', model: 'm' })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  await handlers['connection.activate']({ id })

  const after = await handlers['connection.delete']({ id })

  // Pointing at a profile that is gone would report an active connection
  // nobody can open.
  assert.deepEqual(after.profiles, [])
  assert.equal(after.activeId, undefined)

  await assert.rejects(
    () => handlers['connection.delete']({ id }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
})

test('profiles survive a restart', async (t) => {
  const { handlers, dir } = await fixture(t)
  await handlers['connection.save']({ label: 'kept', provider: 'p', model: 'm', preset: 'Antennae_v18' })

  const reopened = new ConnectionStore(join(dir, 'connections.json'))
  const { profiles } = await reopened.list()

  assert.equal(profiles.length, 1)
  assert.equal(profiles[0]?.label, 'kept')
  assert.equal(profiles[0]?.preset, 'Antennae_v18')
  assert.equal(profiles[0]?.summary, 'p · m · Antennae_v18')
})

/** A /models endpoint that answers according to what the request carried. */
class ModelsEndpoint {
  readonly #server: Server
  #port = 0
  /** The Authorization header of the last request, and whether one came at all. */
  lastAuthorization: string | undefined = undefined
  lastHadHeaders = false
  /** When set, the endpoint stalls this long before answering. */
  delayMs = 0

  constructor() {
    this.#server = createServer((request, response) => {
      if (request.url !== '/v1/models' || request.method !== 'GET') {
        response.writeHead(404).end()
        return
      }
      const authorization = request.headers.authorization
      this.lastAuthorization = typeof authorization === 'string' ? authorization : undefined
      this.lastHadHeaders = true
      setTimeout(() => {
        if (this.lastAuthorization !== 'Bearer sk-real-key') {
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'Incorrect API key' } }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-chat' }, { id: 'deepseek-reasoner' }],
        }))
      }, this.delayMs)
    })
  }

  async start(): Promise<void> {
    await new Promise<void>(resolve => this.#server.listen(0, '127.0.0.1', resolve))
    const address = this.#server.address()
    if (address === null || typeof address === 'string') throw new Error('no bound port')
    this.#port = address.port
  }

  get baseURL(): string {
    return `http://127.0.0.1:${String(this.#port)}`
  }

  close(): Promise<void> {
    return new Promise<void>(resolve => this.#server.close(() => resolve()))
  }
}

async function keyedFixture(t: TestContext): Promise<{
  handlers: Handlers
  dir: string
  endpoint: ModelsEndpoint
  installed: { route: string, endpoint: ConnectionEndpoint }[]
}> {
  const installed: { route: string, endpoint: ConnectionEndpoint }[] = []
  const { handlers, dir } = await fixture(t, {
    probeTimeoutMs: 300,
    installConnection: (route, endpoint) => { installed.push({ route, endpoint }) },
  })
  const endpoint = new ModelsEndpoint()
  await endpoint.start()
  t.after(async () => { await endpoint.close() })
  return { handlers, dir, endpoint, installed }
}

test('a key is stored with its profile and never shown again', async (t) => {
  const { handlers, dir, endpoint } = await keyedFixture(t)
  const key = 'sk-real-key-4242'

  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: key,
  })
  const profile = saved.profiles[0]
  assert.ok(profile !== undefined)
  assert.equal(profile.hasKey, true)
  assert.equal(profile.keyTail, '4242')
  // The wire view carries no key, under any name.
  assert.equal(JSON.stringify(saved).includes(key), false, 'the response body contains the key')

  // On disk the key IS there — that is the deliberate storage decision, inside
  // the gitignored data folder, read by nothing but this store.
  const file = await readFile(join(dir, 'connections.json'), 'utf8')
  assert.equal(file.includes(key), true, 'the key is not in its own store')

  // And a plain re-read keeps masking it.
  const listed = await handlers['connection.list']({})
  assert.equal(JSON.stringify(listed).includes(key), false)
  assert.equal(listed.profiles[0]?.hasKey, true)
})

test('a short key shows no tail, because four characters would show the key', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)

  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-12',
  })
  assert.equal(saved.profiles[0]?.hasKey, true)
  assert.equal(saved.profiles[0]?.keyTail, undefined)
})

test('editing a profile keeps the key the caller was never shown', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)

  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key-4242',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  // The form's edit: every field re-sent except the key, which cannot be.
  const updated = await handlers['connection.save']({
    id,
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    baseURL: `${endpoint.baseURL}/v1`,
  })
  assert.equal(updated.profiles[0]?.model, 'deepseek-reasoner')
  assert.equal(updated.profiles[0]?.hasKey, true, 'the stored key did not survive an edit')

  // And the explicit clear is the one way to remove it.
  const cleared = await handlers['connection.save']({
    id,
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: '',
  })
  assert.equal(cleared.profiles[0]?.hasKey, undefined)
})

test('the summary names where a keyed profile actually points', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
  })
  assert.equal(saved.profiles[0]?.summary, `deepseek · deepseek-v4-flash · ${endpoint.baseURL}`)
})

test('activating a keyed profile installs an adapter for its route', async (t) => {
  const { handlers, endpoint, installed } = await keyedFixture(t)
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key-4242',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  const applied = await handlers['connection.activate']({ id })

  // The route the profile names is the one installed, and it carries the key
  // to the adapter — which is the only place it goes.
  assert.deepEqual(installed, [{
    route: 'deepseek',
    endpoint: { baseURL: `${endpoint.baseURL}/v1`, apiKey: 'sk-real-key-4242' },
  }])
  assert.equal(applied.settings.provider, 'deepseek')
  assert.equal(applied.settings.model, 'deepseek-v4-flash')
})

test('a keyed profile on the default route is served under a derived one', async (t) => {
  const { handlers, endpoint, installed } = await keyedFixture(t)
  const saved = await handlers['connection.save']({
    provider: 'default',
    model: 'mock-model',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key-4242',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  const applied = await handlers['connection.activate']({ id })

  // `default` belongs to the composition's own registration, which activation
  // neither owns nor may displace — so a profile with an endpoint of its own
  // gets a route that is unambiguously its.
  assert.equal(installed.length, 1)
  assert.equal(installed[0]?.route, `conn/${id}`)
  assert.equal(applied.settings.provider, `conn/${id}`)
})

test('routeOf leaves endpointless profiles on the route they name', async () => {
  assert.equal(routeOf({ id: 'p1', provider: 'deepseek', model: 'm' }), 'deepseek')
  assert.equal(routeOf({ id: 'p2', provider: 'default', model: 'm' }), 'default')
  assert.equal(routeOf({ id: 'x', provider: 'default', model: 'm', baseURL: 'http://x/v1' }), 'conn/x')
})

test('connection.test answers with the model list, latency and no key', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  const result = await handlers['connection.test']({ profileId: id })

  assert.equal(result.ok, true)
  assert.equal(typeof result.latencyMs, 'number')
  assert.ok((result.models ?? []).includes('deepseek-v4-flash'))
  assert.equal(endpoint.lastAuthorization, 'Bearer sk-real-key')
  // The verdict carries no credential either.
  assert.equal(JSON.stringify(result).includes('sk-real-key'), false)
})

test('connection.test on unsaved form values probes what was typed', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const result = await handlers['connection.test']({
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
    preset: 'deepseek',
  })
  assert.equal(result.ok, true)
  assert.equal((result.models ?? []).length, 3)
})

test('a wrong key answers unauthorized, by name', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const result = await handlers['connection.test']({
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-wrong-key',
    preset: 'deepseek',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'unauthorized')
  assert.equal(typeof result.latencyMs, 'number')
  assert.equal(result.error?.message.includes('sk-wrong-key'), false, 'the refusal quotes the key')
})

test('a known-to-need-a-key endpoint with none answers missing-key before any request', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const result = await handlers['connection.test']({
    baseURL: `${endpoint.baseURL}/v1`,
    preset: 'deepseek',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'missing-key')
  // The refusal happened before the wire: no request ever arrived.
  assert.equal(endpoint.lastHadHeaders, false)
})

test('a silent endpoint answers timeout, by name', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  endpoint.delayMs = 2000
  const result = await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1` })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'timeout')
})

test('a profile without an endpoint of its own says so instead of guessing', async (t) => {
  const { handlers } = await keyedFixture(t)
  const saved = await handlers['connection.save']({ provider: 'default', model: 'mock-model' })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  const result = await handlers['connection.test']({ profileId: id })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'no-endpoint')
})

test('a probe with nothing to probe is refused as malformed', async (t) => {
  const { handlers } = await keyedFixture(t)
  await assert.rejects(
    () => handlers['connection.test']({}),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
})

test('an unreachable endpoint answers network, by name', async (t) => {
  const { handlers } = await keyedFixture(t)
  // Port 1 on loopback is not served by this test process; the connection
  // itself refuses, which is the case the code names.
  const result = await handlers['connection.test']({ baseURL: 'http://127.0.0.1:1/v1' })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'network')
})
