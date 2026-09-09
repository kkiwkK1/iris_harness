import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createServer, type Server } from 'node:http'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ConnectionStore, hostDefaultView, routeOf } from '../src/connections.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type ConnectionEndpoint, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { listenOnFetchablePort } from './support/fetchable-port.ts'

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
  options: {
    probeTimeoutMs?: number
    installConnection?: (route: string, endpoint: ConnectionEndpoint) => void
    /**
     * The environment the host-connection fallback reads.
     *
     * Defaulted to **empty**, not omitted. Omitted means `process.env`, and an
     * assertion about the host row would then depend on whether whoever ran the
     * suite happens to have `IRIS_BASE_URL` exported — green on one machine and
     * red on another, with the difference nowhere in the source.
     */
    env?: Record<string, string | undefined>
  } = {},
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
    env: options.env ?? {},
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
  /**
   * The rows the list answers with.
   *
   * Bare ids by default, which is what DeepSeek's own documented `/models` row
   * is — `id`, `object`, `owned_by` and nothing else. A test about reading a
   * context length off the row replaces them, rather than every other test in
   * this file getting a fixture that quietly claims DeepSeek reports one.
   */
  rows: unknown[] = [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-chat' }, { id: 'deepseek-reasoner' }]

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
        response.end(JSON.stringify({ data: this.rows }))
      }, this.delayMs)
    })
  }

  async start(): Promise<void> {
    // Through the shared guard rather than `listen(0)` directly: an ephemeral
    // draw can land on a port WHATWG Fetch refuses outright, and the probe
    // would then report the *endpoint* as unreachable — a false negative in
    // exactly the assertion this class exists to support. See
    // `support/fetchable-port.ts`.
    this.#port = await listenOnFetchablePort(this.#server)
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
  // The reason under "fetch failed" is the actionable half: undici hangs the
  // real error on `.cause`, and a message that stopped at the outer sentence
  // told the person nothing. Port 1 is on WHATWG fetch's bad-port list, so the
  // cause here is the platform's own "bad port" — carried through verbatim.
  assert.match(result.error?.message ?? '', /could not reach http:\/\/127\.0\.0\.1:1\/v1\/models: /)
  assert.match(result.error?.message ?? '', /bad port/)
})

test('a closed port answers network with the socket code in the reason', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  // A port this process just served and then closed: nothing listens there,
  // the connection is refused at the socket, and that code is the reason.
  const closed = endpoint.baseURL
  await endpoint.close()
  const result = await handlers['connection.test']({ baseURL: `${closed}/v1` })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'network')
  assert.match(result.error?.message ?? '', /ECONNREFUSED/)
})

/* ------------------------------------------------------------------------- *
 * Faults in the field, not on the network.
 *
 * The report, 2026-09-09: 「无法连接到端点。请检查地址与网络。」 in one
 * millisecond, with a key and endpoint that worked on every other client. A
 * `fetch` given an address it cannot parse, or a header value it cannot carry,
 * throws a `TypeError` before any packet leaves — and the catch filed every
 * non-timeout throw under `network`. Both are now said by name, before the
 * wire, and neither message carries the key.
 * ------------------------------------------------------------------------- */

test('an address without a scheme answers bad-url before any request', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const bare = endpoint.baseURL.replace(/^http:\/\//, '')
  const result = await handlers['connection.test']({ baseURL: `${bare}/v1` })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'bad-url')
  assert.equal(result.latencyMs, 0)
  assert.match(result.error?.message ?? '', /https:\/\//)
  // Nothing left the process: the endpoint saw no request.
  assert.equal(endpoint.lastHadHeaders, false)
})

test('a full-width colon from an IME is a bad-url, not a network fault', async (t) => {
  const { handlers } = await keyedFixture(t)
  const result = await handlers['connection.test']({ baseURL: 'https：//api.example.test/v1' })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'bad-url')
})

test('a key holding a character a header cannot carry answers bad-key and never echoes the key', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const key = 'sk-secret-键-tail'
  const result = await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1`, apiKey: key })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'bad-key')
  assert.equal(result.latencyMs, 0)
  // Position and code point, so the person can find it; nothing of the value.
  assert.match(result.error?.message ?? '', /index 10/)
  assert.match(result.error?.message ?? '', /code point 38190/)
  assert.equal(result.error?.message.includes('secret'), false)
  assert.equal(result.error?.message.includes('键'), false)
  assert.equal(endpoint.lastHadHeaders, false)
})

test('a key pasted with a trailing newline still reaches the endpoint — the platform trims it', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const result = await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1`, apiKey: 'sk-fine\n' })
  // Whatever the fixture endpoint answers, the request left the process: this
  // is not a `bad-key`, because `fetch` would not have refused it either.
  assert.notEqual(result.error?.code, 'bad-key')
  assert.equal(endpoint.lastHadHeaders, true)
})

/* ------------------------------------------------------------------------- *
 * The key is typed once.
 *
 * The user's report, verbatim: "每次测试连接都要重新填一次 apikey，众所周知
 * apikey 在绝大多数平台都是只能看到一次". The fix is that an absent `apiKey`
 * asks the host to use what it holds — and the tests below have to pin both
 * halves of that, because the useful half and the dangerous half are the same
 * mechanism read in two directions:
 *
 * - it works: a second probe of a saved profile needs nothing typed;
 * - it is bounded: the same absent key pointed at a *different* origin does
 *   **not** spend the stored credential there.
 *
 * The second is the one that would pass unnoticed if it were never written: a
 * missing origin check has no symptom until somebody asks the page to probe
 * `https://collector.example/v1`.
 * ------------------------------------------------------------------------- */

test('a saved profile can be re-tested with nothing typed, and says which key it used', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  // The whole point: the form re-sends the endpoint it is showing and **no
  // key**, because it was never given one to re-send.
  const result = await handlers['connection.test']({ profileId: id, baseURL: `${endpoint.baseURL}/v1` })

  assert.equal(result.ok, true)
  assert.equal(result.keySource, 'stored', 'the stored key was not reached for')
  assert.equal(endpoint.lastAuthorization, 'Bearer sk-real-key', 'the endpoint did not receive the stored key')
  assert.equal(JSON.stringify(result).includes('sk-real-key'), false, 'the verdict carries the key')
})

test('an absent key is not a way to spend a stored one at another origin', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  await handlers['connection.activate']({ id })

  /*
   * The attack this refuses: the page cannot read the key, but without an
   * origin check it could still ask the host to post it somewhere of its
   * choosing. `127.0.0.1:1` is refused by the OS, so the assertion is about
   * `keySource` — which is the field that says whether a credential was
   * *selected*, before any socket decided whether it could be delivered.
   */
  const elsewhere = await handlers['connection.test']({
    profileId: id,
    baseURL: 'http://127.0.0.1:1/v1',
  })
  assert.equal(elsewhere.keySource, 'none', 'a stored key was selected for a foreign origin')

  // And the same probe with no profile named — the "active connection"
  // fallback — is bounded the same way.
  const bare = await handlers['connection.test']({ baseURL: 'http://127.0.0.1:1/v1' })
  assert.equal(bare.keySource, 'none', 'the active profile’s key was selected for a foreign origin')
})

test('an untouched form tests the connection in force, using its key', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  await handlers['connection.activate']({ id })

  // No `profileId`: this is the form as it opens, pointed at the active
  // endpoint with an empty key field.
  const result = await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1` })
  assert.equal(result.ok, true)
  assert.equal(result.keySource, 'stored')
})

test('the host’s own environment key answers a probe of the host’s own endpoint', async (t) => {
  const endpoint = new ModelsEndpoint()
  await endpoint.start()
  t.after(async () => { await endpoint.close() })

  const { handlers } = await fixture(t, {
    probeTimeoutMs: 300,
    // Exactly the three variables `apps/iris/cordis.yml` reads for its
    // `llm-openai-compat` row, with the key one indirection away — the
    // variable names the variable that holds it.
    env: {
      IRIS_BASE_URL: `${endpoint.baseURL}/v1`,
      IRIS_MODEL: 'mock-model',
      IRIS_API_KEY_ENV: 'PROBE_KEY',
      PROBE_KEY: 'sk-real-key',
    },
  })

  const result = await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1` })
  assert.equal(result.ok, true)
  assert.equal(result.keySource, 'host', 'the host’s own credential was not reached for')
  assert.equal(JSON.stringify(result).includes('sk-real-key'), false, 'the verdict carries the key')
})

test('a typed key outranks every stored one, and says so', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  // A wrong key, typed. The stored one would have passed — so a pass here
  // would mean the form's own field had been ignored.
  const result = await handlers['connection.test']({
    profileId: id,
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-not-the-one',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'unauthorized')
  assert.equal(result.keySource, 'typed')
})

test('every probe verdict names a key source, including the ones that never left the process', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  // A local serve needs none, and "none" is an answer rather than an absence.
  const local = await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1` })
  assert.equal(local.keySource, 'none')

  // The refusal that happens before any request: it still says what it would
  // have sent, because a form showing "ok"/"failed" with no source would let a
  // reader believe they had validated a key they never sent.
  const refused = await handlers['connection.test']({
    baseURL: 'https://api.deepseek.com/v1',
    preset: 'deepseek',
  })
  assert.equal(refused.error?.code, 'missing-key')
  assert.equal(refused.keySource, 'none')
})

/* ------------------------------------------------------------------------- *
 * The model comes from a list.
 * ------------------------------------------------------------------------- */

test('a successful probe files its model list on the profile it probed', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  assert.equal(saved.profiles[0]?.models, undefined, 'a never-probed profile must not carry a list')

  await handlers['connection.test']({ profileId: id })

  const listed = await handlers['connection.list']({})
  assert.deepEqual(listed.profiles[0]?.models, ['deepseek-v4-flash', 'deepseek-v4-chat', 'deepseek-reasoner'])
  // Stamped, so nothing downstream can read the list as a claim about now.
  assert.equal(typeof listed.profiles[0]?.modelsProbedAt, 'number')
})

test('a failed probe records no list, because an empty one would be a claim', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-wrong',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  const result = await handlers['connection.test']({ profileId: id })
  assert.equal(result.ok, false)
  assert.equal((await handlers['connection.list']({})).profiles[0]?.models, undefined)
})

test('a recorded list does not follow a profile to a different endpoint', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  await handlers['connection.test']({ profileId: id })
  assert.ok((await handlers['connection.list']({})).profiles[0]?.models !== undefined)

  // An edit that keeps the endpoint keeps the list — the caller has no probe
  // result to re-send, exactly as with the key.
  const relabelled = await handlers['connection.save']({
    id,
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    baseURL: `${endpoint.baseURL}/v1`,
  })
  assert.ok(relabelled.profiles[0]?.models !== undefined, 'a label edit dropped the recorded list')

  // An edit that moves the endpoint drops it: those model names are another
  // server's answer, not a stale version of this one's.
  const moved = await handlers['connection.save']({
    id,
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    baseURL: 'https://api.deepseek.com/v1',
  })
  assert.equal(moved.profiles[0]?.models, undefined, 'the list survived an endpoint change')
})

/* ------------------------------------------------------------------------- *
 * The host's own connection, and adopting it.
 * ------------------------------------------------------------------------- */

test('the host describes its own connection without ever projecting its key', async (t) => {
  const { handlers } = await fixture(t, {
    env: {
      IRIS_BASE_URL: 'https://api.deepseek.com/v1',
      IRIS_MODEL: 'deepseek-chat',
      IRIS_API_KEY_ENV: 'PROBE_KEY',
      PROBE_KEY: 'sk-host-secret-9999',
    },
  })

  const listed = await handlers['connection.list']({})
  assert.equal(listed.host?.baseURL, 'https://api.deepseek.com/v1')
  assert.equal(listed.host?.keySource, 'env')
  // The *name* of the variable, which is what a user needs in order to change
  // it, and nothing whose value is the credential.
  assert.equal(listed.host?.keyEnv, 'PROBE_KEY')
  assert.equal(JSON.stringify(listed).includes('sk-host-secret-9999'), false, 'the host row leaked the key')
})

test('a host with no environment credential says so rather than staying silent', async (t) => {
  const { handlers } = await fixture(t, { env: { IRIS_MODEL: 'local-model' } })
  const listed = await handlers['connection.list']({})
  assert.equal(listed.host?.keySource, 'none')
  assert.equal(listed.host?.keyEnv, undefined)
  // No `IRIS_BASE_URL` means absent, not the composition's default copied in
  // here: an absent endpoint already means "rides the host's route" everywhere
  // else in this protocol, and a copied default is a constant that drifts.
  assert.equal(listed.host?.baseURL, undefined)
})

test('adopting the host connection copies its key without the browser touching it', async (t) => {
  const { handlers, dir } = await fixture(t, {
    env: {
      IRIS_BASE_URL: 'https://api.deepseek.com/v1',
      IRIS_MODEL: 'deepseek-chat',
      IRIS_API_KEY_ENV: 'PROBE_KEY',
      PROBE_KEY: 'sk-host-secret-9999',
    },
  })

  // The whole request, as the panel sends it: no key field at all.
  const saved = await handlers['connection.save']({
    provider: 'default',
    model: 'deepseek-chat',
    baseURL: 'https://api.deepseek.com/v1',
    adoptHostKey: true,
  })

  assert.equal(saved.profiles[0]?.hasKey, true, 'the adoption did not carry the key across')
  assert.equal(saved.profiles[0]?.keyTail, '9999')
  assert.equal(JSON.stringify(saved).includes('sk-host-secret-9999'), false, 'the response leaked the key')
  // On disk it is there, which is the point of adopting: an editable profile
  // that can generate on its own.
  const file = await readFile(join(dir, 'connections.json'), 'utf8')
  assert.equal(file.includes('sk-host-secret-9999'), true)
})

test('adopting is ignored where there is no host credential, and outranked by a typed one', async (t) => {
  const { handlers } = await fixture(t, { env: {} })
  const none = await handlers['connection.save']({
    provider: 'default', model: 'm', adoptHostKey: true,
  })
  assert.equal(none.profiles[0]?.hasKey, undefined, 'a flag invented a key out of an empty environment')

  const { handlers: withHost } = await fixture(t, {
    env: { IRIS_API_KEY_ENV: 'PROBE_KEY', PROBE_KEY: 'sk-host-secret-9999' },
  })
  const typed = await withHost['connection.save']({
    provider: 'default', model: 'm', adoptHostKey: true, apiKey: 'sk-typed-key-1234',
  })
  // The newer decision of the two wins: the flag was set when the form opened,
  // the key was typed after.
  assert.equal(typed.profiles[0]?.keyTail, '1234')
})

/* ------------------------------------------------------------------------- *
 * A model chosen for one conversation.
 *
 * The user's report: "点击对话框下的模型名可以快速切换模型且只对当前对话生效".
 * The mechanism was already there — `settings.set` has always taken a
 * `chatId` — so what these pin is the part that was missing: the answer says
 * **which fields that chat overrides**, without which an interface can show
 * the value but cannot offer to undo it.
 * ------------------------------------------------------------------------- */

test('a model chosen for one conversation persists there and nowhere else', async (t) => {
  const { handlers } = await fixture(t)
  const one = (await handlers['chat.create']({ characterId: 'aria' })).view.chatId
  const other = (await handlers['chat.create']({ characterId: 'aria' })).view.chatId

  const set = await handlers['settings.set']({ chatId: one, settings: { model: 'deepseek-reasoner' } })
  assert.equal(set.settings.model, 'deepseek-reasoner')
  assert.deepEqual(set.overrides, { model: 'deepseek-reasoner' })

  // Persisted: a fresh read of the same chat, and the other two layers left
  // exactly as they were.
  assert.equal((await handlers['settings.get']({ chatId: one })).settings.model, 'deepseek-reasoner')
  assert.equal((await handlers['settings.get']({ chatId: other })).settings.model, 'local-model')
  assert.equal((await handlers['settings.get']({})).settings.model, 'local-model')
  assert.deepEqual((await handlers['settings.get']({ chatId: other })).overrides, {})
})

test('overrides tell a conversation’s own choice from the default showing through', async (t) => {
  const { handlers } = await fixture(t)
  const chatId = (await handlers['chat.create']({ characterId: 'aria' })).view.chatId

  // The case a value comparison gets wrong: the chat overrides `model` with
  // the string the global layer already carried. The merged read is identical
  // to an un-overridden chat's; the layer is not.
  const set = await handlers['settings.set']({ chatId, settings: { model: 'local-model' } })
  assert.equal(set.settings.model, 'local-model')
  assert.deepEqual(set.overrides, { model: 'local-model' }, 'an override equal to the default reads as absent')

  // `null` is the clear, which is what "back to the connection's model" sends.
  const cleared = await handlers['settings.set']({ chatId, settings: { model: null } })
  assert.deepEqual(cleared.overrides, {})
  assert.equal(cleared.settings.model, 'local-model', 'the layer below did not show through')
})

test('a global read carries no overrides at all, because presence is scope', async (t) => {
  const { handlers } = await fixture(t)
  const chatId = (await handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await handlers['settings.set']({ chatId, settings: { model: 'deepseek-reasoner' } })

  // Absent, not `{}`. A reader that defaulted absent to `{}` would report the
  // global layer as a conversation that overrides nothing — and then draw the
  // "this conversation" marker on a surface with no conversation.
  assert.equal((await handlers['settings.get']({})).overrides, undefined)
  assert.equal((await handlers['settings.set']({ settings: {} })).overrides, undefined)
})

/* ------------------------------------------------------------------------- *
 * The host's own connection gets a model list too.
 *
 * The reported failure (user, 2026-09-07): the composer's model menu answered
 * 「没有活动连接，因此没有可选的模型列表」 on a host configured entirely from
 * `IRIS_*` variables, with no profile ever saved. The menu's fallback source is
 * the `host` row, and until this section the row had nowhere to carry a list:
 * `recordModels` files against a profile id, and the host default has none.
 *
 * So the list is held in the **service process's memory**. Not a shortcut —
 * the choice is argued in `service.ts`: the host default is the environment the
 * process was launched with rather than a decision of the user's, and a
 * one-off observation about it does not belong in the file that records their
 * decisions. The last test here holds the "not on disk" half.
 * ------------------------------------------------------------------------- */

/**
 * A host whose own `IRIS_BASE_URL` is a live `/models` endpoint.
 * @param t - the test context, for closing the server.
 * @returns the handlers and the endpoint the host points at.
 */
async function hostEndpointFixture(t: TestContext): Promise<{
  handlers: Handlers
  endpoint: ModelsEndpoint
  dir: string
}> {
  const endpoint = new ModelsEndpoint()
  await endpoint.start()
  t.after(async () => { await endpoint.close() })
  const { handlers, dir } = await fixture(t, {
    probeTimeoutMs: 300,
    env: {
      IRIS_BASE_URL: `${endpoint.baseURL}/v1`,
      IRIS_MODEL: 'deepseek-v4-flash',
      IRIS_API_KEY_ENV: 'PROBE_KEY',
      // The key this endpoint accepts, held by the host and never typed.
      PROBE_KEY: 'sk-real-key',
    },
  })
  return { handlers, endpoint, dir }
}

test('probing the host’s own endpoint gives its row a model list', async (t) => {
  const { handlers, endpoint } = await hostEndpointFixture(t)

  // The state every launch starts in, asserted before anything is concluded
  // from the change: absent, not empty. A default-to-`[]` reader would call
  // this "the host advertises nothing" and never offer to look.
  const before = await handlers['connection.list']({})
  assert.equal(before.host?.models, undefined, 'a fresh process already carried a host model list')
  assert.equal(before.host?.modelsProbedAt, undefined)

  // The bare probe the composer's menu fires: the host's own endpoint, and no
  // key — the credential is the one the process was started with.
  const verdict = await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1` })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.keySource, 'host', 'the probe did not use the startup credential')

  const after = await handlers['connection.list']({})
  assert.deepEqual(after.host?.models, ['deepseek-v4-flash', 'deepseek-v4-chat', 'deepseek-reasoner'])
  assert.equal(typeof after.host?.modelsProbedAt, 'number', 'the list is not stamped')
  // No profile was created by any of this: the row is read-only and a probe of
  // it is not a save.
  assert.deepEqual(after.profiles, [])
  // And the credential is still nowhere on the wire.
  assert.equal(JSON.stringify(after).includes('sk-real-key'), false)
})

test('a probe of a different endpoint does not become the host row’s list', async (t) => {
  const { handlers, endpoint } = await hostEndpointFixture(t)
  // A second server, on its own port: a neighbouring provider the user is
  // testing in the connection form while the host generates elsewhere.
  const elsewhere = new ModelsEndpoint()
  await elsewhere.start()
  t.after(async () => { await elsewhere.close() })
  assert.notEqual(elsewhere.baseURL, endpoint.baseURL, 'both fixtures landed on one port')

  // A *successful* probe — which is what makes this discriminating. A failed
  // one would record nothing anyway, and the test would pass on the wrong
  // reason.
  const verdict = await handlers['connection.test']({
    baseURL: `${elsewhere.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  assert.equal(verdict.ok, true)
  assert.ok((verdict.models ?? []).length >= 3, 'the other endpoint answered with no list')

  const listed = await handlers['connection.list']({})
  assert.equal(
    listed.host?.models,
    undefined,
    'another endpoint’s list was filed against the host’s own connection',
  )

  /*
   * And the other direction, which is the one a projection-time origin check
   * alone would not catch: with the host row's own list already recorded, a
   * successful probe of somewhere else must not **displace** it. Written after
   * a teeth-check found the first half of this test still green with the
   * recording guard removed — the row was being cleaned up on the way out
   * instead of never being polluted, and the difference shows exactly here.
   */
  await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1` })
  const mine = (await handlers['connection.list']({})).host?.models
  assert.ok((mine ?? []).length >= 3, 'the host’s own probe did not land')

  await handlers['connection.test']({ baseURL: `${elsewhere.baseURL}/v1`, apiKey: 'sk-real-key' })
  assert.deepEqual(
    (await handlers['connection.list']({})).host?.models,
    mine,
    'a probe of a neighbouring endpoint wiped the host row’s own list',
  )
})

test('a profile pointed at the host’s endpoint fills both, because it is one server', async (t) => {
  const { handlers, endpoint } = await hostEndpointFixture(t)
  // The origin is what decides, not how the caller addressed the probe: this
  // profile and the host row describe the same server, so its answer is both
  // rows' answer. Addressed by `profileId` with no `baseURL` and no key, which
  // is the ask the menu sends for an active profile.
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: `${endpoint.baseURL}/v1`,
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  assert.equal(saved.host?.models, undefined, 'saving a profile invented a host list')

  const verdict = await handlers['connection.test']({ profileId: id })
  assert.equal(verdict.ok, true)

  const listed = await handlers['connection.list']({})
  assert.ok((listed.profiles[0]?.models ?? []).length >= 3, 'the profile lost its own record')
  assert.deepEqual(listed.host?.models, listed.profiles[0]?.models)
})

test('a recorded host list is dropped rather than reattributed when the route moves', () => {
  /*
   * The projection's own guard, which is a different failure from the
   * recording guard above and is why both exist. The record is held for the
   * life of the process and the host connection it describes is read fresh on
   * every answer — a composition that hands a new one in, or an environment
   * that now says something else. A list attributed to whatever the host
   * happens to point at *now* would be a claim about an endpoint nobody
   * probed, so it goes.
   */
  const probe = {
    origin: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    probedAt: 1_800_000_000_000,
  }
  const same = hostDefaultView({ provider: 'default', baseURL: 'https://api.deepseek.com/v1/' }, probe)
  // Same origin, different trailing slash: one server, one list. The origin is
  // what is compared, as everywhere else a key or a list is reused.
  assert.deepEqual(same.models, probe.models)
  assert.equal(same.modelsProbedAt, probe.probedAt)

  const moved = hostDefaultView({ provider: 'default', baseURL: 'https://api.example.test/v1' }, probe)
  assert.equal(moved.models, undefined, 'the list followed the host to another endpoint')
  assert.equal(moved.modelsProbedAt, undefined, 'the stamp outlived the list it dates')

  const nowhere = hostDefaultView({ provider: 'default' }, probe)
  assert.equal(nowhere.models, undefined, 'a host with no endpoint inherited a list')
})

test('the host row’s list is never written to the connections file', async (t) => {
  const { handlers, endpoint, dir } = await hostEndpointFixture(t)
  await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1` })
  assert.ok(((await handlers['connection.list']({})).host?.models ?? []).length >= 3)

  // The file is the record of the *user's* decisions. Nothing here was one:
  // the endpoint is in the environment, and the list is an observation of it.
  // A missing file is the strongest form of this passing — there were no
  // profiles to write — so both shapes are accepted and neither may contain
  // the list.
  const file = await readFile(join(dir, 'connections.json'), 'utf8').catch(() => undefined)
  assert.equal(
    file?.includes('deepseek-v4-chat') ?? false,
    false,
    'the in-memory host list reached the user’s connections file',
  )
})

test('a probe reads the context length the endpoint put on the row', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  // Three real spellings in one list, and one row with none — which is the
  // shape a mixed serve actually produces (vLLM leaves `max_model_len` null on
  // its LoRA adapters, OpenRouter documents both its fields as nullable).
  endpoint.rows = [
    { id: 'served-by-vllm', max_model_len: 131_072 },
    { id: 'listed-by-openrouter', context_length: 163_840 },
    { id: 'loaded-in-lm-studio', max_context_length: 32_768 },
    { id: 'says-nothing' },
  ]
  const verdict = await handlers['connection.test']({
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  assert.equal(verdict.ok, true, verdict.error?.message)
  assert.deepEqual(verdict.modelContexts?.['served-by-vllm'], { tokens: 131_072, source: 'provider' })
  assert.deepEqual(verdict.modelContexts?.['listed-by-openrouter'], { tokens: 163_840, source: 'provider' })
  assert.deepEqual(verdict.modelContexts?.['loaded-in-lm-studio'], { tokens: 32_768, source: 'provider' })
  // Absent, not zero. Nothing knows this one's window, and a record saying
  // "zero" would make every consumer that divides by it report the
  // conversation as infinitely full.
  assert.equal(verdict.modelContexts?.['says-nothing'], undefined)
  // The ids are unaffected by any of this — the control for the reading above,
  // which would otherwise pass for a probe that had stopped listing models.
  assert.deepEqual(verdict.models, [
    'served-by-vllm',
    'listed-by-openrouter',
    'loaded-in-lm-studio',
    'says-nothing',
  ])
})

test('the table answers for the rows the endpoint said nothing about', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  // The default rows: bare ids, as DeepSeek's documented `/models` row is. A
  // probe of that endpoint can learn nothing, so the built-in table is the only
  // thing that will ever answer — and it says so in the source field.
  const verdict = await handlers['connection.test']({
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  assert.deepEqual(verdict.modelContexts?.['deepseek-v4-flash'], { tokens: 1_000_000, source: 'table' })
  assert.deepEqual(verdict.modelContexts?.['deepseek-reasoner'], { tokens: 1_000_000, source: 'table' })
})

test('the endpoint’s own answer wins over the table', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  // A serve that runs `deepseek-v4-flash` with a shorter window than DeepSeek's
  // own — a proxy, a quantised local copy — is telling the truth about itself,
  // and a constant compiled into this host months ago is not in a position to
  // overrule it.
  endpoint.rows = [{ id: 'deepseek-v4-flash', max_model_len: 65_536 }]
  const verdict = await handlers['connection.test']({
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  assert.deepEqual(verdict.modelContexts?.['deepseek-v4-flash'], { tokens: 65_536, source: 'provider' })
})

test('a nonsense window is refused rather than put on the wire', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  // Bounded by the same 4 000 000 the settings store allows a user to type
  // (`MAX_CONTEXT_WINDOW`), so an endpoint cannot hand this host a window it
  // would refuse a person for asking about.
  endpoint.rows = [{ id: 'wild', max_model_len: 40_000_000 }, { id: 'sane', max_model_len: 4_000_000 }]
  const verdict = await handlers['connection.test']({
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  assert.equal(verdict.modelContexts?.['wild'], undefined, 'a 40M window reached the wire')
  assert.deepEqual(verdict.modelContexts?.['sane'], { tokens: 4_000_000, source: 'provider' })
})

test('what a probe learned is filed on the profile beside its list', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  endpoint.rows = [{ id: 'served-by-vllm', max_model_len: 131_072 }]
  const { profiles } = await handlers['connection.save']({
    provider: 'default',
    model: 'served-by-vllm',
    baseURL: `${endpoint.baseURL}/v1`,
    apiKey: 'sk-real-key',
  })
  const id = profiles[0]?.id
  assert.ok(id !== undefined)
  await handlers['connection.test']({ profileId: id, baseURL: `${endpoint.baseURL}/v1` })
  const listed = (await handlers['connection.list']({})).profiles.find(one => one.id === id)
  assert.deepEqual(listed?.modelContexts?.['served-by-vllm'], { tokens: 131_072, source: 'provider' })
})

test('a probe’s reading clamps the chat’s window without anything being saved', async (t) => {
  const { handlers, endpoint } = await keyedFixture(t)
  // The half of feature A the table cannot do: a serve nobody has a table row
  // for, whose own answer becomes the clamp for a conversation running on it.
  endpoint.rows = [{ id: 'local/qwen3-8b', max_model_len: 40_960 }]
  await handlers['settings.set']({ settings: { model: 'local/qwen3-8b', contextWindow: 2_000_000 } })
  const before = await handlers['chat.create']({ characterId: 'aria' })
  assert.equal(before.view.budget?.context, 2_000_000, 'a window was clamped before anything knew the model')
  assert.equal(before.view.budget?.source, 'settings')

  await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1`, apiKey: 'sk-real-key' })

  const after = await handlers['chat.open']({ chatId: before.view.chatId })
  assert.equal(after.view.budget?.context, 40_960, 'the probe’s reading did not reach the budget')
  assert.equal(after.view.budget?.source, 'model')
  assert.equal(after.view.budget?.modelContext, 40_960)
})

test('a capital letter does not hand the table an answer the endpoint already gave', async (t) => {
  /*
   * The two lookups the resolver runs back to back have to fold alike. The
   * table folds (its docblock argues why at length); the probe map did not, so
   * an endpoint that lists `DeepSeek-V4-Flash` against settings that say
   * `deepseek-v4-flash` missed the probe and fell through to the table —
   * silently inverting "the endpoint's own answer wins over the table" on
   * nothing but capitalisation.
   *
   * The fixture discriminates: the table's answer for this id is 1 000 000 and
   * the endpoint's is 65 536, so a miss is visible as the wrong number rather
   * than as a missing one.
   */
  const { handlers, endpoint } = await keyedFixture(t)
  endpoint.rows = [{ id: 'DeepSeek-V4-Flash', max_model_len: 65_536 }]
  await handlers['settings.set']({ settings: { model: 'deepseek-v4-flash', contextWindow: 2_000_000 } })
  await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1`, apiKey: 'sk-real-key' })

  const { view } = await handlers['chat.create']({ characterId: 'aria' })
  assert.equal(view.budget?.modelContext, 65_536, 'the differently-cased probe reading was not found')
  assert.equal(view.budget?.context, 65_536)
  assert.equal(view.budget?.source, 'model')
})

test('and it folds the other way too: odd casing in the settings still finds the probe', async (t) => {
  /*
   * The mirror of the case above, and it is a separate assertion because it
   * fails on a *different* line. Folding only where the probe is written keeps
   * the previous test green — the settings model was already lowercase, so the
   * lookup hit the folded key by luck. This one puts the odd casing in the
   * settings instead, which is the half that needs the read to fold.
   *
   * Not hypothetical: `settings.model` is a free-text field on the connection
   * form whenever the endpoint advertises no list, and vendor documentation
   * writes these ids both ways.
   */
  const { handlers, endpoint } = await keyedFixture(t)
  endpoint.rows = [{ id: 'deepseek-v4-flash', max_model_len: 65_536 }]
  await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1`, apiKey: 'sk-real-key' })
  await handlers['settings.set']({ settings: { model: 'DeepSeek-V4-Flash', contextWindow: 2_000_000 } })

  const { view } = await handlers['chat.create']({ characterId: 'aria' })
  assert.equal(view.budget?.modelContext, 65_536, 'the probe reading was missed for a differently-cased setting')
  assert.equal(view.budget?.context, 65_536)
})
