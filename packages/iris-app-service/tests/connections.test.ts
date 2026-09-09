import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createServer, type Server } from 'node:http'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ConnectionStore, hostDefaultView, routeCredential, routeOf } from '../src/connections.ts'
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
  /**
   * The service itself, for the one thing that is not a handler: the boot-time
   * import of the launch environment into the provider list (host §61).
   */
  service: IrisAppService
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

  const service = new IrisAppService({
    stream, library, chats, settings, connections,
    broadcast: () => {},
    userName: 'Traveller',
    env: options.env ?? {},
    ...options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs },
    ...options.installConnection === undefined ? {} : { installConnection: options.installConnection },
  })

  return { handlers: service.handlers(), service, settings, dir }
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

test('a bad address on a keyed preset is a bad-url, not a missing key', async (t) => {
  // Measured on the live host 2026-09-09: with the deepseek preset and no typed
  // key, `api.deepseek.com/v1` came back `missing-key`, because the host key is
  // adopted only at a matching origin and a scheme-less string has none. True,
  // and beside the point — the fault is in the address field.
  const { handlers, endpoint } = await keyedFixture(t)
  const bare = endpoint.baseURL.replace(/^http:\/\//, '')
  const result = await handlers['connection.test']({ baseURL: `${bare}/v1`, preset: 'deepseek' })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'bad-url')
  assert.equal(result.keySource, 'none')
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

/* ------------------------------------------------------------------------- *
 * The launch environment is imported into the provider list, once (host §61).
 *
 * The user's ruling, 2026-09-10: 「宿主环境这个功能废弃了，以后都从在 Iris 中自己
 * 添加供应商来调用模型」. So the 「宿主环境」 row is gone, `connection.deactivate`
 * with it, and a generation with no provider in use is refused. Which leaves
 * one migration to get right: a host whose `connections.json` is empty while
 * its `.env` names an endpoint used to generate through that endpoint, and
 * would now refuse everything until the user retyped what the file says.
 *
 * The `adoptHostKey` tests stood here — the flag the 存为供应商 button sent,
 * asking the host to copy its own credential into a profile. The copy is what
 * survives; the press is what is gone.
 * ------------------------------------------------------------------------- */

test('a first start with an empty list imports the launch environment and applies it', async (t) => {
  const installs: { route: string, endpoint: ConnectionEndpoint }[] = []
  const { service, handlers, settings, dir } = await fixture(t, {
    installConnection: (route, endpoint) => { installs.push({ route, endpoint }) },
    env: {
      // No `IRIS_MODEL` here on purpose: this runtime never reads it. The
      // endpoint and the credential come from the environment; the model comes
      // from the composition (this fixture's settings default, `local-model`).
      IRIS_BASE_URL: 'https://api.deepseek.com/v1',
      IRIS_API_KEY_ENV: 'PROBE_KEY',
      PROBE_KEY: 'sk-host-secret-9999',
    },
  })
  // The premise, asserted before anything is concluded from the change: this
  // host has no providers at all, which is the only state that imports.
  assert.deepEqual((await handlers['connection.list']({})).profiles, [])

  const id = await service.importLaunchConnection()
  assert.ok(id !== undefined, 'nothing was imported')

  const listed = await handlers['connection.list']({})
  assert.equal(listed.profiles.length, 1, 'the import did not produce exactly one provider')
  const imported = listed.profiles[0]
  assert.equal(imported?.id, id)
  assert.equal(imported?.baseURL, 'https://api.deepseek.com/v1')
  // The endpoint and the key come from the **environment**; the model comes
  // from the launch snapshot, which is the composition's own configured model
  // (this fixture's `local-model`, `IRIS_MODEL` on the shipped composition).
  // Two sources, said here because a reader will assume one.
  assert.equal(imported?.model, 'local-model')
  assert.equal(imported?.label, '启动环境', 'the row does not say where it came from')
  // The credential came across **inside the host**, and the answer says so the
  // only way a read ever may: a state and a mask.
  assert.equal(imported?.hasKey, true, 'the import left the key in the environment')
  assert.equal(imported?.keyTail, '9999')

  // In use, not merely saved. A provider in the list that nothing generates
  // through is exactly the state this method exists to prevent.
  assert.equal(listed.activeId, id, 'the imported provider is not the one in use')
  const route = routeOf({
    id,
    provider: 'default',
    model: 'local-model',
    baseURL: 'https://api.deepseek.com/v1',
  })
  assert.equal(settings.get().provider, route, 'the settings layer does not name the imported route')
  assert.equal(settings.get().model, 'local-model')
  // And the adapter for it is installed, with the copied key — otherwise the
  // first turn would reach a route the registry has never heard of.
  assert.deepEqual(installs.map(entry => entry.route), [route])
  assert.equal(installs[0]?.endpoint.baseURL, 'https://api.deepseek.com/v1')
  assert.equal(installs[0]?.endpoint.apiKey, 'sk-host-secret-9999')

  // The key is on disk, which is the whole point of importing rather than
  // borrowing: a later host started without the variable still generates.
  const file = await readFile(join(dir, 'connections.json'), 'utf8')
  assert.equal(file.includes('sk-host-secret-9999'), true, 'the key was borrowed rather than imported')
})

test('the boot after an import installs the route once, not twice', async (t) => {
  // The plugin calls `importLaunchConnection()` and then
  // `restoreActiveConnection()`, in that order. The import installs what it
  // applied, so the restore must see it as served — otherwise every first start
  // installs one connection twice and logs two "connection now generates
  // through…" lines for it.
  const installs: string[] = []
  const { service } = await fixture(t, {
    installConnection: (route) => { installs.push(route) },
    env: { IRIS_BASE_URL: 'https://api.deepseek.com/v1' },
  })
  const id = await service.importLaunchConnection()
  assert.ok(id !== undefined, 'nothing was imported, so this test is about nothing')
  assert.equal(installs.length, 1, 'the import did not install the route it applied')

  assert.equal(await service.restoreActiveConnection(), undefined, 'the restore claimed a route it did not install')
  assert.equal(installs.length, 1, 'the boot installed one connection twice')
})

test('the imported key never crosses the protocol, in either direction', async (t) => {
  const { service, handlers } = await fixture(t, {
    env: {
      IRIS_BASE_URL: 'https://api.deepseek.com/v1',
      IRIS_API_KEY_ENV: 'PROBE_KEY',
      PROBE_KEY: 'sk-host-secret-9999',
    },
  })
  await service.importLaunchConnection()
  const listed = await handlers['connection.list']({})
  assert.equal(JSON.stringify(listed).includes('sk-host-secret-9999'), false, 'the list leaked the imported key')
  const id = listed.profiles[0]?.id
  assert.ok(id !== undefined)
  const saved = await handlers['connection.save']({ id, provider: 'default', model: 'local-model' })
  assert.equal(JSON.stringify(saved).includes('sk-host-secret-9999'), false, 'a save leaked the imported key')
  // And the key survived that save, which is the merge rule doing its job on
  // the one profile nobody ever typed a key into.
  assert.equal(saved.profiles[0]?.hasKey, true, 'editing the imported provider disarmed it')
})

test('a host that already has a provider is left alone, however its environment is configured', async (t) => {
  const { service, handlers, settings } = await fixture(t, {
    env: { IRIS_BASE_URL: 'https://api.deepseek.com/v1' },
  })
  // One provider of the user's own, and deliberately **not** in use: "nothing
  // is active" is not the condition — an empty *list* is. A user who has saved
  // anything has made this decision themselves, and a row appearing at their
  // next start would be this host editing their list behind them.
  const saved = await handlers['connection.save']({ provider: 'openrouter', model: 'x/y' })
  const before = settings.get().provider

  assert.equal(await service.importLaunchConnection(), undefined, 'the import ran on a list that was not empty')
  const listed = await handlers['connection.list']({})
  assert.deepEqual(
    listed.profiles.map(row => row.id),
    saved.profiles.map(row => row.id),
    'the list gained a row',
  )
  assert.equal(listed.activeId, undefined, 'the import applied something on a host it should not have touched')
  assert.equal(settings.get().provider, before, 'the settings layer moved')
})

test('an environment that names no endpoint imports nothing, rather than inventing one', async (t) => {
  // `IRIS_BASE_URL` unset is the composition's `http://127.0.0.1:11434/v1`
  // default, which lives in a `!!js` expression this runtime cannot read. A
  // copy of it here would be a constant that drifts, so the import declines and
  // the user adds a provider by hand — the one behaviour cost of the ruling.
  const { service, handlers } = await fixture(t, { env: {} })
  assert.equal(await service.importLaunchConnection(), undefined)
  assert.deepEqual((await handlers['connection.list']({})).profiles, [])
})

test('an endpoint with no key still imports, because a local serve needs none', async (t) => {
  const { service, handlers } = await fixture(t, {
    env: { IRIS_BASE_URL: 'http://127.0.0.1:11434/v1' },
  })
  const id = await service.importLaunchConnection()
  assert.ok(id !== undefined, 'a keyless environment was refused, which locks out the simplest setup')
  const listed = await handlers['connection.list']({})
  assert.equal(listed.profiles[0]?.hasKey, undefined, 'a key was invented out of an empty environment')
  assert.equal(listed.profiles[0]?.baseURL, 'http://127.0.0.1:11434/v1')
  assert.equal(listed.activeId, id)
})

/* ------------------------------------------------------------------------- *
 * The environment is not a connection any more (host §61).
 *
 * Host §60 gave this file three tests: the 「宿主环境」 row kept describing the
 * launch configuration after an activation, `connection.deactivate` put the
 * global layer back on it, and `clearActive()` on a store with nothing active
 * wrote no file. All three pinned a row a person could select, which the ruling
 * of the following day retires — so what is pinned here now is the absence,
 * field by field, because a projection that keeps answering `provider` is one
 * an interface can keep reading.
 * ------------------------------------------------------------------------- */

test('the host row carries the credential’s facts and nothing that describes a connection', async (t) => {
  const { handlers, settings } = await fixture(t, {
    env: {
      IRIS_BASE_URL: 'https://api.deepseek.com/v1',
      IRIS_API_KEY_ENV: 'PROBE_KEY',
      PROBE_KEY: 'sk-host-secret-9999',
    },
  })
  const listed = await handlers['connection.list']({})
  const host = listed.host
  assert.ok(host !== undefined, 'the host stopped describing its environment at all')
  // What is left, and why: the provider editor reads exactly these to explain a
  // key field left blank at this origin (§58's ladder, now a fallback).
  assert.equal(host.baseURL, 'https://api.deepseek.com/v1')
  assert.equal(host.keySource, 'env')
  assert.equal(host.keyEnv, 'PROBE_KEY')

  // And what is gone. Checked as **keys on the object**, which is what a
  // browser reading `host.provider` would find — the fields, not their values,
  // because a field answering `undefined` is still a field to code against.
  for (const field of ['provider', 'model', 'models', 'modelsProbedAt', 'modelContexts']) {
    assert.equal(
      Object.hasOwn(host, field),
      false,
      `the host row still carries "${field}", so it still describes a connection`,
    )
  }

  // The verb that row had for one day is gone from the handler table with it,
  // so "apply no profile" is not a state anything can ask for.
  assert.equal(
    Object.hasOwn(handlers, 'connection.deactivate'),
    false,
    'connection.deactivate is still registered',
  )

  // An activation still moves the settings layer, which is the half of §60's
  // first test that outlives it: the row cannot follow an activation, because
  // there is nothing left on the row for it to follow with.
  const saved = await handlers['connection.save']({
    provider: 'deepseek', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  await handlers['connection.activate']({ id })
  assert.equal(settings.get().provider, 'deepseek', 'the activation did not write the route')
  const after = await handlers['connection.list']({})
  assert.equal(after.host?.baseURL, 'https://api.deepseek.com/v1', 'the environment’s endpoint moved')
  assert.equal(after.host?.keySource, 'env')
})

/* ------------------------------------------------------------------------- *
 * The route generates with the key the probe would have used.
 *
 * The report, 2026-09-09: a profile on the deepseek preset, saved with the key
 * field blank (the form says "由宿主环境提供，留空即使用它"), probed green — the
 * probe adopts the host's key at the same origin — and then every generation
 * answered `401 Authentication Fails (governor)`, which is DeepSeek's sentence
 * for a request carrying **no** Authorization header at all. Activation had
 * installed the route with the profile's own credential only, and the profile
 * had none. The probe and the route must resolve the key the same way.
 * ------------------------------------------------------------------------- */

const HOST_ENV = {
  IRIS_BASE_URL: 'https://api.deepseek.com/v1',
  IRIS_MODEL: 'deepseek-chat',
  IRIS_API_KEY_ENV: 'PROBE_KEY',
  PROBE_KEY: 'sk-host-secret-9999',
}

async function activatedEndpoint(
  t: TestContext,
  profile: { provider: string, baseURL: string, apiKey?: string },
): Promise<{ route: string, endpoint: ConnectionEndpoint }> {
  const installed: { route: string, endpoint: ConnectionEndpoint }[] = []
  const { handlers } = await fixture(t, {
    env: HOST_ENV,
    installConnection: (route, endpoint) => { installed.push({ route, endpoint }) },
  })
  const saved = await handlers['connection.save']({ model: 'deepseek-chat', ...profile })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  await handlers['connection.activate']({ id })
  const last = installed.at(-1)
  assert.ok(last !== undefined, 'activation installed no route')
  return last
}

test('a same-origin profile with no key of its own generates with the host key', async (t) => {
  // Bare origin, as the deepseek preset fills it — the same *place* as the
  // host's `/v1`, which is the comparison sameEndpointOrigin makes.
  const { route, endpoint } = await activatedEndpoint(t, { provider: 'deepseek', baseURL: 'https://api.deepseek.com' })
  assert.equal(route, 'deepseek')
  assert.equal(endpoint.apiKey, 'sk-host-secret-9999')
})

test('a profile with its own key generates with that key, not the host’s', async (t) => {
  const { endpoint } = await activatedEndpoint(t, {
    provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: 'sk-typed-key-1234',
  })
  assert.equal(endpoint.apiKey, 'sk-typed-key-1234')
})

test('a profile at a different origin never receives the host key', async (t) => {
  // The guard that makes the adoption safe: the host's credential goes to the
  // host's endpoint and nowhere else, exactly as the probe already refuses.
  const { endpoint } = await activatedEndpoint(t, { provider: 'default', baseURL: 'https://other.example/v1' })
  assert.equal(endpoint.apiKey, undefined)
})

test('routeCredential names the source it resolved, and the header travels with the key that won', () => {
  const host = { provider: 'default', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-host', apiKeyHeader: 'x-api-key' }
  assert.deepEqual(
    routeCredential({ baseURL: 'https://api.deepseek.com', apiKey: 'sk-own' }, host),
    { apiKey: 'sk-own', keySource: 'stored' },
  )
  assert.deepEqual(
    routeCredential({ baseURL: 'https://api.deepseek.com/' }, host),
    { apiKey: 'sk-host', apiKeyHeader: 'x-api-key', keySource: 'host' },
  )
  assert.deepEqual(routeCredential({ baseURL: 'https://elsewhere.example' }, host), { keySource: 'none' })
  const { apiKey: _unused, ...keyless } = host
  assert.deepEqual(routeCredential({ baseURL: 'https://api.deepseek.com' }, keyless), { keySource: 'none' })
  // An empty stored key is no key — the form's "blank means keep" never writes
  // one, but an imported profile might carry the empty string.
  assert.equal(routeCredential({ baseURL: 'https://api.deepseek.com', apiKey: '' }, host).keySource, 'host')
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
 * A bare probe records nothing (host §61).
 *
 * Five tests stood here, all of them about a model list the host kept **in
 * memory** for its own endpoint: a probe filled it, a probe of a neighbouring
 * endpoint neither filled nor displaced it, a profile at the same origin filled
 * both, the projection dropped it when the route moved, and it never reached
 * the connections file. Its reader was the composer capsule's fallback list for
 * a host with no profile in use, which is a state the interface no longer has —
 * so `#hostProbe`, `#recordHostModels` and `HostProbeRecord` are gone, and what
 * is pinned here is that a bare probe answers its caller and files nothing.
 *
 * `hostEndpointFixture` stays: the context-window tests below run against a
 * host whose own `IRIS_BASE_URL` is a live endpoint, which is still a real
 * shape (it is where the environment credential comes from).
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

test('a bare probe of the host’s own endpoint files nothing anywhere', async (t) => {
  const { handlers, endpoint, dir } = await hostEndpointFixture(t)

  // The probe still works, and still borrows the startup credential at the
  // host's own origin — that is §58's ladder, which the ruling keeps as a
  // fallback. What it must not do any more is record.
  const verdict = await handlers['connection.test']({ baseURL: `${endpoint.baseURL}/v1` })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.keySource, 'host', 'the probe did not use the startup credential')
  // The floor on the fixture: the endpoint really did answer with a list, so
  // "nothing was recorded" is not "there was nothing to record".
  assert.ok((verdict.models ?? []).length >= 3, 'the endpoint answered with no list to file')

  const listed = await handlers['connection.list']({})
  assert.deepEqual(listed.profiles, [], 'a bare probe created a profile')
  for (const field of ['models', 'modelsProbedAt']) {
    assert.equal(
      Object.hasOwn(listed.host ?? {}, field),
      false,
      `a bare probe filed "${field}" against the environment row`,
    )
  }
  // And nothing reached the user's file either, which was already true and is
  // now true for the simpler reason that nothing is recorded at all.
  const file = await readFile(join(dir, 'connections.json'), 'utf8').catch(() => undefined)
  assert.equal(file?.includes('deepseek-v4-chat') ?? false, false, 'a probe wrote a list into the file')
  assert.equal(JSON.stringify(listed).includes('sk-real-key'), false, 'the credential reached the wire')
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
