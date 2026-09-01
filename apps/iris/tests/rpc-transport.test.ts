import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { requestSchemas, type IrisEvent } from '@iris/protocol'
import { IrisHttpClient } from '@iris/rpc-client'

import { startMockProvider, type MockProvider } from './mock-provider.ts'

/**
 * The browser half against a real host process.
 *
 * A booted composition, a real socket, and the actual `IrisClient` the interface
 * will use — because everything this covers only exists between the parts:
 * that the loader can mount the two rows at all, that a `chat.send` returns
 * while the reply is still being written, that the text arrives on the
 * WebSocket, and that the content-type gate is really in the path.
 */

let mock: MockProvider
let ctx: Context
let dataDir: string
let client: IrisHttpClient
let origin: string

/** A card file dropped into the library by hand, as a user would. */
const ARIA = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'A retired cartographer.',
    personality: '',
    scenario: '',
    first_mes: 'Hello, {{user}}.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '1',
    extensions: {},
  },
})

/** Wait for a condition the transport reaches asynchronously. */
async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

before(async () => {
  mock = await startMockProvider()
  dataDir = await mkdtemp(join(tmpdir(), 'iris-transport-'))
  // Under the profile segment: storage is profile-scoped, and the default
  // profile matches SillyTavern's own `data/<user>/` layout.
  await mkdir(join(dataDir, 'default-user', 'characters'), { recursive: true })
  await writeFile(join(dataDir, 'default-user', 'characters', 'aria.json'), ARIA, 'utf8')

  process.env.IRIS_TEST_BASE_URL = mock.baseURL
  process.env.IRIS_TEST_DATA_DIR = dataDir

  ctx = await boot('iris-transport', fileURLToPath(new URL('./fixtures/transport.cordis.yml', import.meta.url)))
  origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  client = new IrisHttpClient({ baseUrl: origin })
  await waitUntil(() => client.connected, 'the event socket to connect')
})

after(async () => {
  client.close()
  await ctx.fiber.dispose()
  await mock.close()
  await rm(dataDir, { recursive: true, force: true })
})

test('the composition mounts both rows and answers a method', async () => {
  const { characters } = await client.call('character.list', {})

  assert.deepEqual(characters.map(character => character.characterId), ['aria'])
})

test('a whole turn crosses the wire: request over POST, reply over the socket', async () => {
  const events: IrisEvent[] = []
  const dispose = client.subscribe(event => { events.push(event) })

  const created = await client.call('chat.create', { characterId: 'aria' })
  const chatId = created.view.chatId
  assert.equal(created.view.messages[0]?.text, 'Hello, Traveller.')

  const { turn } = await client.call('chat.send', { chatId, text: 'Hello?' })
  assert.equal(turn, 1)

  await waitUntil(() => events.some(event => event.type === 'stream.end'), 'the turn to finish')
  dispose()

  const deltas = events.filter(event => event.type === 'stream.text').map(event => event.delta)
  assert.equal(deltas.join(''), '*She looks up.* Hello, traveller.')
  assert.ok(
    events.some(event => event.type === 'stream.reasoning'),
    'reasoning arrives on its own channel so a UI can collapse it',
  )

  const end = events.find(event => event.type === 'stream.end')
  assert.equal(end?.view.messages.length, 3)
  assert.equal(end?.view.messages[2]?.text, '*She looks up.* Hello, traveller.')

  // The disposer really detaches: nothing arrives after it.
  const before = events.length
  await client.call('chat.rename', { chatId, title: 'Maps' })
  assert.equal(events.length, before)
})

test('the Iris sampling extension still reaches the wire through the whole stack', async () => {
  const created = await client.call('chat.create', { characterId: 'aria' })
  await client.call('settings.set', { chatId: created.view.chatId, settings: { topP: 0.92, temperature: 0.8 } })

  const events: IrisEvent[] = []
  const dispose = client.subscribe(event => { events.push(event) })
  await client.call('chat.send', { chatId: created.view.chatId, text: 'Hello?' })
  await waitUntil(() => events.some(event => event.type === 'stream.end'), 'the turn to finish')
  dispose()

  assert.equal((mock.capture.body ?? {}).top_p, 0.92)
  assert.equal((mock.capture.body ?? {}).temperature, 0.8)
})

test('a cross-site POST cannot reach a method', async () => {
  // `text/plain` is a CORS simple request, the one shape a hostile page can
  // send without a preflight. The host refuses it before parsing anything.
  const response = await fetch(`${origin}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ id: 'x', method: 'chat.list', params: {} }),
  })

  assert.equal(response.status, 415)
  await response.arrayBuffer()
})

test('a refusal reaches the client as a typed rejection', async () => {
  await assert.rejects(
    () => client.call('chat.open', { chatId: 'no-such-chat' }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )

  // The schema is enforced at the host, not just in the client's types.
  const response = await fetch(`${origin}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'x', method: 'chat.send', params: { chatId: 'c', text: '' } }),
  })
  const frame = await response.json() as { ok: boolean, error?: { code: string } }
  assert.equal(frame.ok, false)
  assert.equal(frame.error?.code, 'invalid-request')
})

test('the avatar route answers only for cards that have a picture', async () => {
  // A `.json` card has no image, so the library serves the file it does have
  // rather than pretending; an unknown id is simply not there.
  const missing = await fetch(`${origin}/iris/avatar/nobody`)
  assert.equal(missing.status, 404)
  await missing.arrayBuffer()

  const traversal = await fetch(`${origin}/iris/avatar/..%2F..%2Fsettings`)
  assert.equal(traversal.status, 404, 'an id that would escape the folder finds nothing')
  await traversal.arrayBuffer()
})

/**
 * Valid-shaped params for every method, so the call reaches a handler.
 *
 * Params must satisfy each schema: validation runs before the handler lookup,
 * so a malformed body answers `invalid-request` and proves nothing about
 * whether anything is registered. The ids are deliberately bogus — reaching a
 * handler is the whole assertion, and what it then says about a chat that does
 * not exist is not this test's business.
 */
const PROBES: Record<string, unknown> = {
  'chat.list': {},
  'chat.create': { characterId: 'no-such-card' },
  'chat.open': { chatId: 'no-such-chat' },
  'chat.delete': { chatId: 'no-such-chat' },
  'chat.rename': { chatId: 'no-such-chat', title: 'x' },
  'chat.send': { chatId: 'no-such-chat', text: 'x' },
  'chat.regenerate': { chatId: 'no-such-chat' },
  'chat.abort': { chatId: 'no-such-chat' },
  'chat.swipe': { chatId: 'no-such-chat', turn: 0, index: 0 },
  'chat.editMessage': { chatId: 'no-such-chat', id: 0, text: 'x' },
  'chat.deleteMessage': { chatId: 'no-such-chat', id: 0 },
  'chat.branch': { chatId: 'no-such-chat', id: 0 },
  'prompt.itemize': { chatId: 'no-such-chat' },
  'script.slash': { chatId: 'no-such-chat', command: '/send hi|/trigger' },
  'script.getVariables': { chatId: 'no-such-chat', scope: 'chat' },
  'script.setVariables': { chatId: 'no-such-chat', scope: 'chat', op: 'replace', variables: {} },
  'script.swipeTo': { chatId: 'no-such-chat', messageId: 0, swipeIndex: 0 },
  'connection.list': {},
  'connection.save': { provider: 'default', model: 'mock-model' },
  'connection.delete': { id: 'no-such-profile' },
  'connection.activate': { id: 'no-such-profile' },
  'character.list': {},
  'character.import': { filename: 'x.json', content: 'e30=' },
  'character.delete': { characterId: 'no-such-card' },
  'settings.get': {},
  'settings.set': { settings: {} },
  'script.list': { characterId: 'no-such-card' },
  'script.setEnabled': { characterId: 'no-such-card', scriptId: 'x', enabled: true },
  'script.body': { characterId: 'no-such-card', scriptId: 'x' },
  'script.setDocumentGrant': { characterId: 'no-such-card', granted: false },
  'script.setScriptsAllowed': { characterId: 'no-such-card', allowed: true },
  'script.fetch': { url: 'https://blocked.example/x.js' },
  'script.context': { chatId: 'no-such-chat', characterId: 'no-such-card' },
  'script.saveMetadata': { chatId: 'no-such-chat', metadata: {} },
  'script.saveChat': { chatId: 'no-such-chat' },
  'script.setExtensionPrompt': { chatId: 'no-such-chat', key: 'k', value: 'v' },
  'script.setExtensionSettings': { characterId: 'no-such-card', settings: {} },
  'script.generateRaw': { chatId: 'no-such-chat', prompt: 'x' },
}

test('every method in the contract is actually reachable over the wire', async () => {
  // Implementing a handler and registering it are two different lists, and
  // only one of them was being checked: five bridge methods were written,
  // tested through the handler table, and unreachable from a browser, while
  // the suite stayed green. This asserts the property that was missing —
  // reachability — against a running host rather than against source text.
  const methods = Object.keys(requestSchemas)
  assert.ok(methods.length > 20, `read ${String(methods.length)} methods from the contract`)

  const unreachable: string[] = []
  for (const method of methods) {
    const params = PROBES[method]
    // A method with no probe cannot be checked, so the absence is the failure:
    // this is what makes the table maintain itself when the contract grows.
    assert.ok(params !== undefined, `no probe for "${method}" — add one so it is covered`)

    const response = await fetch(`${origin}/iris/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `probe-${method}`, method, params }),
    })
    const frame = await response.json() as { ok: boolean, error?: { code: string, message: string } }

    // Matched on the transport's own words rather than on `unsupported`: some
    // handlers legitimately answer `unsupported` (a blocked fetch host), and
    // conflating the two would let a genuinely missing registration hide.
    if (frame.ok === false && /no handler is registered/.test(frame.error?.message ?? '')) {
      unreachable.push(method)
    }
  }

  assert.deepEqual(unreachable, [], `methods with no handler registered: ${unreachable.join(', ')}`)
})
