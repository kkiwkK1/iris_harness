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
  'script.generate': { chatId: 'no-such-chat', userInput: 'x' },
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

test('the third state crosses the wire as an absent key, not a present undefined', async () => {
  // The browser distinguishes "never asked" from "asked and declined" by this
  // key. `{ scriptsAllowed: undefined }` would have the key while meaning
  // neither — and a browser testing `'scriptsAllowed' in response` would read
  // it as "asked", then fall through to declined: the same silent suppression
  // as reading absent-as-false, reached from the other direction.
  //
  // Asserted on the parsed JSON of a real response rather than on a returned
  // object, because that is where the guarantee has to hold. The host builds the
  // field with a conditional spread and `JSON.stringify` drops `undefined`
  // besides, so there are two reasons — this pins the result of both.
  const unasked = await fetch(`${origin}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'p1', method: 'script.list', params: { characterId: 'aria' } }),
  })
  const unaskedFrame = await unasked.json() as { ok: boolean, result?: Record<string, unknown> }
  assert.equal(unaskedFrame.ok, true)
  assert.equal(
    'scriptsAllowed' in (unaskedFrame.result ?? {}),
    false,
    'an unanswered card sent the key anyway',
  )

  await fetch(`${origin}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'p2', method: 'script.setScriptsAllowed', params: { characterId: 'aria', allowed: false } }),
  })

  const declined = await fetch(`${origin}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'p3', method: 'script.list', params: { characterId: 'aria' } }),
  })
  const declinedFrame = await declined.json() as { ok: boolean, result?: Record<string, unknown> }
  // And `false` must survive the trip as `false`, not be dropped as falsy.
  assert.equal('scriptsAllowed' in (declinedFrame.result ?? {}), true, 'a declined answer vanished on the wire')
  assert.equal(declinedFrame.result?.['scriptsAllowed'], false)
})

/**
 * The composition neither half can see from inside its own boundary.
 *
 * `GRANTS.md` §1 asks for exactly this path — *deleted card → reimport → open* —
 * because the leak it describes lived on the seam: the host forgot its grants
 * and was correct, the browser's cache never asked and was also defensible, and
 * both suites stayed green. This one runs the real id minting against real files
 * on disk, the real policy store, and the real wire, so the id reuse that makes
 * inheritance possible is not a premise here — it is asserted.
 */
test('a reused character id inherits no answer the user gave about the card before it', async () => {
  const card = JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Nadia', description: '', personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1', extensions: {},
    },
  })
  const content = Buffer.from(card, 'utf8').toString('base64')

  const first = await client.call('character.import', { filename: 'nadia.json', content })
  const characterId = first.character.characterId

  await client.call('script.setDocumentGrant', { characterId, granted: true })
  await client.call('script.setScriptsAllowed', { characterId, allowed: true })
  const granted = await client.call('script.list', { characterId })
  assert.equal(granted.documentGranted, true)
  assert.equal(granted.scriptsAllowed, true)

  await client.call('character.delete', { characterId })
  const second = await client.call('character.import', { filename: 'nadia.json', content })

  // The premise of the whole failure, asserted rather than assumed: ids are
  // minted against the cards that exist, so deleting one hands its id to the
  // next card of that name. A client that never reuses ids cannot express this
  // scenario at all, which is how it stays invisible during development.
  assert.equal(second.character.characterId, characterId, 'the id was not reused; this test proves nothing')

  const after = await client.call('script.list', { characterId })
  assert.equal(after.documentGranted, false, 'a new card inherited page access nobody gave it')
  // Before any `setScriptsAllowed` on this card: the third state, not `false`.
  // `false` would mean the shell never asks, so the scripts never run, with
  // nothing reported anywhere — and a card may not have its consent pre-filled
  // (`AUTORUN.md` §1), including pre-filled as a refusal.
  assert.equal(
    'scriptsAllowed' in after,
    false,
    'a new card inherited an answer given about another card',
  )
})

/**
 * The remote-bundle route, mounted on the real host.
 *
 * The seam this covers is the one neither half can see alone: the browser
 * rewrites a card's `import()` to this path, and nothing in the browser's tests
 * can prove the host actually mounted it or that the whitelist is enforced on
 * this side rather than assumed. A network fetch is deliberately not exercised —
 * every host that would answer one is outside the whitelist by design, which is
 * itself the property worth asserting.
 */
test('the bundle route is mounted, and refuses on the host side', async () => {
  const ask = async (query: string): Promise<{ status: number, reason: string, body: string }> => {
    const response = await fetch(`${origin}/iris/script-bundle${query}`)
    return {
      status: response.status,
      reason: decodeURIComponent(response.headers.get('x-iris-reason') ?? ''),
      body: await response.text(),
    }
  }

  // Mounted: a missing parameter is answered by the route, not by a 404 from the
  // server's fallback.
  const missing = await ask('')
  assert.equal(missing.status, 400)
  assert.match(missing.reason, /needs a \?url= parameter/u)

  // The URL is a proposal from the untrusted side, and it is judged here.
  const refused = await ask(`?url=${encodeURIComponent('https://evil.example/payload.js')}`)
  assert.equal(refused.status, 403)
  assert.match(refused.reason, /evil\.example/u, 'a refusal that does not name the host is not diagnosable')
  // The reason is in the body too, because a failed `import()` hands its caller
  // no response to read.
  assert.match(refused.body, /evil\.example/u)

  // A near-miss on the whitelist's own shape: a suffix match would have let this
  // through, and it is the mistake a second copy of the rule would make.
  const lookalike = await ask(`?url=${encodeURIComponent('https://jsdelivr.net.evil.example/x.js')}`)
  assert.equal(lookalike.status, 403)

  // Method gate, like every other route here.
  const posted = await fetch(`${origin}/iris/script-bundle?url=x`, { method: 'POST' })
  assert.equal(posted.status, 405)

  // The header a module fetch cannot do without, on the real socket. `import()`
  // and `<script type="module">` fetch in CORS mode unconditionally, and the
  // card's frame is opaque-origin, so every request here arrives with
  // `Origin: null`. Without this the browser has the bytes and hands the module
  // system nothing — reporting a failure against the outer blob URL, which
  // names neither this route nor the dependency that was blocked.
  for (const [what, response] of [
    ['a refusal', await fetch(`${origin}/iris/script-bundle?url=${encodeURIComponent('https://evil.example/x.js')}`)],
    ['a missing parameter', await fetch(`${origin}/iris/script-bundle`)],
  ] as const) {
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      '*',
      `${what} answered without the header a module fetch needs`,
    )
    // Without this an opaque-origin frame reads zeroes from Resource Timing, and
    // a judgement built on those can say a request was sent but not whether it
    // finished — the two readings that matter when a card stops loading.
    assert.equal(response.headers.get('timing-allow-origin'), '*', `${what} withheld timing`)
    assert.equal(response.headers.get('vary'), 'Origin', `${what} answered without the vary net`)
    // Nothing on this route may be held past a header change. The cold-CDN cost
    // it exists to avoid is already paid on the host's disk.
    assert.equal(
      (response.headers.get('cache-control') ?? '').includes('max-age'),
      false,
      `${what} told the browser it may hold this response`,
    )
  }
})
