/**
 * Task S live acceptance: persona storage + wiring against a real host process
 * on port 8815.
 *
 * Spawned the way `qa/verify-widescreen.mjs` drives its host — `apps/iris/bin.ts`
 * as its own process, its PID recorded here and stopped by PID alone — against
 * the mock provider and the measured install's own 啊不吃 book (the 践踏 entry,
 * uid 4), read from the upstream checkout. The per-entry
 * `matchPersonaDescription` tick is applied the way upstream's editor writes
 * it: top level plus the extensions mirror.
 *
 * Run from the repo root with: node qa/persona-acceptance.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startMockProvider } from '../apps/iris/tests/mock-provider.ts'

const PORT = 8815
const BOOK = '啊不吃'
const BASE = `http://127.0.0.1:${String(PORT)}`

let seq = 0

/** One RPC call. Returns the full frame (`{id, ok, result|error}`). */
async function rpc(method, params = {}) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-persona-${++seq}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  return res.json()
}

/** One RPC call that throws on an error frame and unwraps the result. */
async function call(method, params = {}) {
  const frame = await rpc(method, params)
  if (frame.ok === false) {
    throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  }
  return frame.result
}

async function waitUntil(predicate, what) {
  const deadline = Date.now() + 15000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

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

const mock = await startMockProvider()
const dataDir = await mkdtemp(join(tmpdir(), 'iris-persona-qa-'))
await mkdir(join(dataDir, 'default-user', 'characters'), { recursive: true })
await mkdir(join(dataDir, 'default-user', 'worlds'), { recursive: true })
await writeFile(join(dataDir, 'default-user', 'characters', 'aria.json'), ARIA, 'utf8')
// The real corpus book, copied in as-is: the entry under test is uid 4
// (keys 踩/脚踩/践踏/踏, secondary 脸/头/身体).
await copyFile(
  'E:/sillyTavern/SillyTavern/data/default-user/worlds/啊不吃.json',
  join(dataDir, 'default-user', 'worlds', `${BOOK}.json`),
)
// The corpus ships every entry with `match_persona_description: false` — it is
// a per-entry checkbox in upstream's editor (world-info.js:4018, default
// false), and the acceptance is that a persona description CAN trigger the
// secondary key once the user ticks it. Upstream's editor writes the TOP-LEVEL
// field and mirrors the extensions block (handleMatchCheckboxHelper,
// world-info.js:2979-2980), and the scan reads the top-level one
// (world-info.js:299) — so both homes are written here, exactly as a tick in
// the real editor leaves the file.
{
  const { readFile, writeFile: rewrite } = await import('node:fs/promises')
  const path = join(dataDir, 'default-user', 'worlds', `${BOOK}.json`)
  const book = JSON.parse(await readFile(path, 'utf8'))
  book.entries['4'].matchPersonaDescription = true
  book.entries['4'].extensions.match_persona_description = true
  await rewrite(path, JSON.stringify(book), 'utf8')
}

// The host process, composed by the product's own cordis.yml — the same one a
// user runs. Its PID is the only way it is managed.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const host = spawn(process.execPath, ['apps/iris/bin.ts'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    IRIS_PORT: String(PORT),
    IRIS_DATA_DIR: dataDir,
    IRIS_BASE_URL: mock.baseURL,
    IRIS_MODEL: 'mock-model',
    IRIS_USER_NAME: 'Traveller',
  },
  stdio: 'inherit',
})
console.log(`host process PID ${String(host.pid)} on port ${String(PORT)}`)

// The mock keeps only the last request body, and a chat-completion body
// carries the whole conversation — so a text-based wait would be satisfied by
// a stale body from an earlier turn or chat. Each request re-parses into a
// fresh object, so identity change is the honest "a new request arrived".
async function nextRequest(action) {
  const seen = mock.capture.body
  await action()
  await waitUntil(() => mock.capture.body !== undefined && mock.capture.body !== seen, 'the next request to reach the provider')
}

try {
  await waitUntil(() => rpc('persona.list', {}).then(frame => frame.ok).catch(() => false), `the host on port ${String(PORT)} to answer`)

  // 0. Baseline, no persona: a fresh profile answers empty.
  const listed = await call('persona.list', {})
  assert.equal(listed.personas.length, 0, 'a fresh profile has no personas')
  const none = await call('persona.get', {})
  assert.equal(none.persona, undefined, 'no active persona on a fresh profile')

  // 1. persona.* RPC round trip.
  const set = await call('persona.set', {
    name: '验收人格',
    description: '她的目光落在你的身体上。',
    position: 'inprompt',
    active: true,
  })
  assert.equal(set.activeId, set.personas[0]?.id)
  const got = await call('persona.get', {})
  assert.equal(got.persona?.name, '验收人格')
  console.log('1. persona.set/get/list round trip OK')

  // A chat bound to the real book.
  const created = await call('chat.create', { characterId: 'aria' })
  const chatId = created.view.chatId
  await call('worldbook.bindChat', { chatId, name: BOOK })

  // 2. IN_PROMPT: the description reaches the REAL request the provider got.
  // The first message carries no primary key (踩) of the uid-4 entry, so the
  // 践踏 guide must stay out: a selective entry needs its primary key in the
  // scan no matter what the persona supplies.
  await nextRequest(() => call('chat.send', { chatId, text: '你好，请介绍一下你自己。' }))
  const firstBody = JSON.stringify(mock.capture.body)
  assert.ok(firstBody.includes('她的目光落在你的身体上。'), 'the persona description must ride the personaDescription slot at IN_PROMPT')
  assert.ok(!firstBody.includes('【践踏 - 描写指导】'), 'no primary key in the chat yet: the selective entry cannot fire without one')
  console.log('2. IN_PROMPT: personaDescription slot reaches the provider request')

  // 2b. prompt.itemize shows the personaDescription line carrying the text.
  const itemized = (await call('prompt.itemize', { chatId })).itemization
  const personaRow = itemized.entries.find(entry => entry.id === 'personaDescription')
  assert.ok(personaRow !== undefined, 'prompt.itemize must show a personaDescription row')
  assert.ok(personaRow.tokens > 0, 'the personaDescription row must carry the description, not an empty slot')
  console.log('2b. prompt.itemize shows the personaDescription row (tokens > 0)')

  // 3. {{persona}} macro: point main at the macro; the next request expands it.
  await call('preset.upsertPrompt', { prompt: { identifier: 'main', role: 'system', content: 'User is: {{persona}}' } })

  // 4. WI secondary key fired by the persona description: this turn says 踩
  // (primary), only the persona description carries 身体 (secondary).
  await nextRequest(() => call('chat.send', { chatId, text: '他踩过落叶。' }))
  const secondBody = JSON.stringify(mock.capture.body)
  assert.ok(secondBody.includes('User is: 她的目光落在你的身体上。'), 'the {{persona}} macro must expand to the active description')
  assert.ok(secondBody.includes('【践踏 - 描写指导】'), 'the uid-4 entry must activate: primary 踩 in the chat, secondary 身体 only in the persona description')
  console.log('3. {{persona}} macro expanded in the real request')
  console.log('4. WI secondary key (身体) fired via the persona description: 践踏 guide injected')

  // 5. Zero change when the persona goes away: a fresh chat, the same two
  // messages, persona deleted — no persona text and no WI activation anywhere.
  await call('persona.delete', { id: set.activeId })
  const cleared = await call('persona.list', {})
  assert.equal(cleared.personas.length, 0)
  const created2 = await call('chat.create', { characterId: 'aria' })
  const chatId2 = created2.view.chatId
  await call('worldbook.bindChat', { chatId: chatId2, name: BOOK })
  await nextRequest(() => call('chat.send', { chatId: chatId2, text: '你好，请介绍一下你自己。' }))
  await nextRequest(() => call('chat.send', { chatId: chatId2, text: '他踩过落叶。' }))
  const cleanBody = JSON.stringify(mock.capture.body)
  assert.ok(!cleanBody.includes('她的目光'), 'no persona text may remain after deletion')
  assert.ok(!cleanBody.includes('User is: 她的目光'), 'the macro must be empty again')
  assert.ok(!cleanBody.includes('【践踏 - 描写指导】'), 'without the persona the secondary key cannot fire')
  console.log('5. zero-change red line: cleared persona restores the pre-persona request exactly (no persona text, no WI firing)')

  console.log(`\nALL LIVE ACCEPTANCE CHECKS PASSED (host process PID ${String(host.pid)}, port ${String(PORT)})`)
} finally {
  if (host.pid !== undefined && host.exitCode === null) {
    host.kill()
    await new Promise(resolve => { host.once('exit', resolve) })
  }
  await mock.close()
  await rm(dataDir, { recursive: true, force: true })
}
