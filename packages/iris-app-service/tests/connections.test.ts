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
