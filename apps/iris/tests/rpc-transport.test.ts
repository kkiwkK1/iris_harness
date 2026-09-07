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

/**
 * How many boots a wait may outlast before it counts as a hang.
 *
 * The wait used to be a wall clock — `Date.now() + 5000` — which is a
 * measurement of one machine wearing a constant's clothes (`notes/METHODS.md`
 * §二): it goes red on a loaded runner for a transport that did not change,
 * and a red that gets read as noise protects nothing. The yardstick is now the
 * boot of this same composition, measured in this same process: a uniformly
 * slower machine slows the boot and the wait together, so the ratio survives
 * what the constant did not. Same shape as the chat-search proportionality
 * bound (commit 21eb3cc).
 *
 * Measured, three runs, idle machine: boot 409–430 ms, socket connect 15–23 ms,
 * a whole turn through the mock provider 26–28 ms — about 0.065 of a boot. Five
 * boots is therefore some 75× the longest thing waited for, and a genuine hang
 * (an event that never arrives) still fails in seconds rather than never.
 *
 * **This is a smoke bound.** It turns a hang into a failure; it cannot see a
 * slow transport, because nothing here compares the turn to anything. That is
 * the honest scope of the old 5-second constant too — it just did not say so.
 */
const WAIT_SLACK = 5

/** How long the composition took to boot, in this process; the unit every wait is measured in. */
let bootMs: number

/** Wait for a condition the transport reaches asynchronously. */
async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const budget = bootMs * WAIT_SLACK
  const started = performance.now()
  while (!predicate()) {
    if (performance.now() - started > budget) {
      throw new Error(
        `timed out waiting for ${what}: ${budget.toFixed(0)}ms, `
        + `${String(WAIT_SLACK)}× the ${bootMs.toFixed(0)}ms this composition took to boot`,
      )
    }
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

  const bootStarted = performance.now()
  ctx = await boot('iris-transport', fileURLToPath(new URL('./fixtures/transport.cordis.yml', import.meta.url)))
  bootMs = performance.now() - bootStarted
  origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  client = new IrisHttpClient({ baseUrl: origin })
  await waitUntil(() => client.connected, 'the event socket to connect')
})

after(async () => {
  client.close()
  await ctx.fiber.dispose()
  await mock.close()
  // Windows can still hold a handle inside `default-user` for a moment after
  // the fiber is disposed (the store's last write closing, an antivirus scan
  // of the fresh chat file), and a bare `rm` then fails the whole file with
  // ENOTEMPTY - seen on three separate full-suite runs here, never on Linux.
  // `maxRetries` is Node's own answer for exactly this window; the tests
  // themselves are unaffected, only the tidy-up waits.
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
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
  // The scan reads the profile's chat directory, which the probe host has
  // created empty: the honest answer is no hits, and it proves registration.
  'chat.search': { query: 'x' },
  'chat.answerCleanup': { chatId: 'no-such-chat', answer: 'clean' },
  'chat.send': { chatId: 'no-such-chat', text: 'x' },
  'chat.regenerate': { chatId: 'no-such-chat' },
  'chat.abort': { chatId: 'no-such-chat' },
  'chat.swipe': { chatId: 'no-such-chat', turn: 0, index: 0 },
  'chat.editMessage': { chatId: 'no-such-chat', id: 0, text: 'x' },
  'chat.deleteMessage': { chatId: 'no-such-chat', id: 0 },
  'chat.branch': { chatId: 'no-such-chat', id: 0 },
  // The import probe names a card that is not in the library: reachability is
  // the property, and the not-found answer proves the handler ran.
  'chat.import': { filename: 'probe.jsonl', content: 'e30=', characterId: 'no-such-card' },
  'chat.export': { chatId: 'no-such-chat' },
  // The snapshot arms answer from a host whose profile has a snapshot store and
  // no snapshots: `list` answers empty, and the other three name what is not
  // there — the not-found and the named-confirm refusal both prove the handler
  // ran. Reachability is the property, not success.
  'backup.list': {},
  'backup.preview': { backupId: 'no-such-card/no-such-chat/20260101-000000-000-f1-save-chat.jsonl' },
  'backup.restore': {
    backupId: 'no-such-card/no-such-chat/20260101-000000-000-f1-save-chat.jsonl',
    confirm: 'no such conversation',
  },
  'backup.delete': { backupId: 'no-such-card/no-such-chat/20260101-000000-000-f1-save-chat.jsonl' },
  'prompt.itemize': { chatId: 'no-such-chat' },
  'script.slash': { chatId: 'no-such-chat', command: '/send hi|/trigger' },
  'script.runEnded': { chatId: 'no-such-chat', runId: 'probe-run' },
  'script.getVariables': { chatId: 'no-such-chat', scope: 'chat' },
  'script.setVariables': { chatId: 'no-such-chat', scope: 'chat', op: 'replace', variables: {} },
  'script.swipeTo': { chatId: 'no-such-chat', messageId: 0, swipeIndex: 0 },
  'connection.list': {},
  'connection.save': { provider: 'default', model: 'mock-model' },
  'connection.delete': { id: 'no-such-profile' },
  'connection.activate': { id: 'no-such-profile' },
  // A profile that does not exist answers not-found, which proves the handler
  // ran; the probe's verdict-on-failure shape is the connections suite's business.
  'connection.test': { profileId: 'no-such-profile' },
  'character.list': {},
  'character.import': { filename: 'x.json', content: 'e30=' },
  'character.delete': { characterId: 'no-such-card' },
  // The manager arms name a card that is not in the library: the not-found
  // answer proves the handler ran, the same reachability verdict the other
  // character probes answer.
  'character.duplicate': { characterId: 'no-such-card' },
  'character.rename': { characterId: 'no-such-card', name: 'probe' },
  'character.export': { characterId: 'no-such-card', format: 'json' },
  'character.setTags': { characterId: 'no-such-card', tags: ['probe'] },
  'character.favorite': { characterId: 'no-such-card', favorite: true },
  'settings.get': {},
  'settings.set': { settings: {} },
  // Preset arms answer from a host whose library is empty or absent: a
  // not-found or unsupported answer still proves the handler is registered.
  'preset.list': {},
  'preset.select': { name: 'no-such-preset' },
  'preset.view': {},
  'preset.setEnabled': { id: 'no-such-prompt', enabled: true },
  'preset.move': { id: 'no-such-prompt', index: 0 },
  'preset.upsertPrompt': { prompt: { name: 'probe' } },
  'preset.removePrompt': { id: 'no-such-prompt' },
  'preset.save': { name: 'probe-preset' },
  'preset.delete': { name: 'no-such-preset' },
  'preset.read': { name: 'no-such-preset' },
  'preset.import': {},
  // Empty JSON object: parses, is not a preset, and the named refusal proves
  // the handler ran — the same reachability verdict the other arms answer.
  'preset.importFile': { filename: 'probe.json', content: 'e30=' },
  // The persona group. `list` answers from the probe host's own (empty)
  // store; `set` writes one; a `get` and a `delete` for a persona that does
  // not exist answer absent/not-found, which proves the handler ran.
  'persona.list': {},
  'persona.set': { name: 'probe-persona', description: 'a persona the probe wrote', active: true },
  'persona.get': { id: 'no-such-persona' },
  'persona.delete': { id: 'no-such-persona' },
  // The global regex tier answers from a host with or without the store: an
  // unsupported refusal still proves the handler is registered.
  'regex.list': {},
  'regex.set': { scripts: [] },
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
  'script.setChatMessages': { chatId: 'no-such-chat', messages: [{ messageId: 0, message: 'x' }] },
  'script.createChatMessages': {
    chatId: 'no-such-chat', messages: [{ name: 'Aria', is_user: false, mes: 'x' }],
  },
  'script.deleteChatMessages': { chatId: 'no-such-chat', messageIds: [0] },
  'script.getPreset': { name: 'in_use' },
  'script.replaceScriptButtons': { characterId: 'no-such', scriptId: 'no-such', buttons: [] },
  'script.evalTemplate': { chatId: 'no-such-chat', content: 'x' },
  // Named world books. The probes name nothing real on purpose: reachability is
  // the property under test, and a not-found answer proves the handler ran just
  // as well as a successful read would.
  'worldbook.names': {},
  'worldbook.get': { name: 'no-such-book' },
  // Empty name is upstream's absent-answer path and needs no book to exist.
  'worldbook.load': { name: '' },
  'worldbook.charNames': { characterId: 'no-such-character' },
  // The character page's listing. Refused with not-found on the probe host —
  // no book store — which proves the handler ran, like the probes around it.
  'worldbook.charDigest': { characterId: 'no-such-character' },
  'worldbook.replace': { name: 'no-such-book', entries: [] },
  // Refused with not-found on the probe host (no store) — reachability, not success.
  'worldbook.create': { name: 'no-such-book' },
  'worldbook.bindChat': { chatId: 'no-such-chat', name: 'no-such-book' },
  // Empty list: no book existence to check, and the unknown character answers
  // not-found — which proves the handler ran, like the probes above it.
  'worldbook.setCharBooks': { characterId: 'no-such-character', names: [] },
  'worldbook.globalSelect': {},
  'worldbook.setGlobalSelect': { names: [] },
  'worldbook.settings': {},
  'worldbook.setSettings': {},
  // Empty params: the cursor and the limit are both optional, and reading
  // from the oldest held record is the page's first call.
  'debug.reports': {},
  // Storage arms refuse on a host without the store configured, which is what
  // the probe host is; the guard checks reachability, not success.
  'storage.set': { characterId: 'no-such-character', key: 'k', value: 'v' },
  'storage.remove': { characterId: 'no-such-character', key: 'k' },
  'storage.clear': { characterId: 'no-such-character' },
  // The same scan `chat.search` probes: the profile chat directory the probe
  // host created is empty, so the honest answer is a summary of nothing — and
  // an empty summary is a successful call, which is what proves registration.
  // Empty params on purpose: all three are optional, and "every record there
  // is, cut by day" is the page first call.
  'usage.summary': {},
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
 * `notes/apps/iris-web/GRANTS.md` §1 asks for exactly this path — *deleted card → reimport → open* —
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
  // (`docs/AUTORUN.md` §1), including pre-filled as a refusal.
  assert.equal(
    'scriptsAllowed' in after,
    false,
    'a new card inherited an answer given about another card',
  )
})

/**
 * The secret-storage boundary, asserted on real frames.
 *
 * A connection profile's key is stored host-side — that is the deliberate
 * design — but the **wire** must behave as if it did not exist: no read, no
 * listing, no echo of any field a save accepted. Asserted on the parsed JSON
 * of an HTTP response rather than on handler return values, because the frame
 * is the thing a hostile or careless reader gets.
 */
test('a saved key never crosses the wire back, only its mask does', async () => {
  const key = 'sk-iris-transport-secret-a1b2'

  const saved = await client.call('connection.save', {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseURL: 'https://api.deepseek.test/v1',
    apiKey: key,
  })
  const profile = saved.profiles.find(row => row.provider === 'deepseek')
  assert.ok(profile !== undefined, 'the profile was saved')

  const response = await fetch(`${origin}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'mask', method: 'connection.list', params: {} }),
  })
  const frame = await response.json() as { ok: boolean, result?: unknown }
  assert.equal(frame.ok, true)
  const body = JSON.stringify(frame.result)
  assert.equal(body.includes(key), false, 'the listing carries the key')
  assert.equal(body.includes('sk-iris-transport-secret'), false, 'the listing carries part of the key')

  const listed = frame.result as { profiles: { id: string, hasKey?: boolean, keyTail?: string }[] }
  const read = listed.profiles.find(row => row.id === profile.id)
  assert.ok(read !== undefined)
  assert.equal(read.hasKey, true)
  assert.equal(read.keyTail, 'a1b2')

  // And the boundary is the wire's, not the handler's: an update that does
  // not send the key leaves it armed, which only the store can see.
  const updated = await client.call('connection.save', {
    id: profile.id,
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    baseURL: 'https://api.deepseek.test/v1',
  })
  assert.equal(updated.profiles.find(row => row.id === profile.id)?.hasKey, true)

  // Clean up, so the rest of the suite sees the profile list it started with.
  await client.call('connection.delete', { id: profile.id })
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
