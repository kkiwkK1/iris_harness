/**
 * Task P live acceptance: the character manager against a real host process on
 * port 8812.
 *
 * Spawned the way `qa/persona-acceptance.mjs` drives its host —
 * `apps/iris/bin.ts` as its own process, its PID recorded here and stopped by
 * PID alone — over a throwaway profile holding the real corpus card
 * `哈人冰恋 1_5.png` (107 embedded book entries, bound to the named book
 * `哈人冰恋世界v2.0`). The five acceptance properties:
 *
 * 1. rename keeps the worldbook binding intact — the id does not move, the
 *    binding row and the materialised book survive, 107 entries still resolve;
 * 2. a duplicate can open a new chat and shares its source's materialised book
 *    rather than minting a second one;
 * 3. an exported PNG re-imports field-for-field equal (the chunks' JSON is
 *    compared against the stored card's);
 * 4. a tag edit writes back to the card and shows in the list at once;
 * 5. a star lands in the profile's favorites and rides `character.list`.
 *
 * Run from the repo root with: node qa/character-ops-acceptance.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'

import { readCardChunks } from '../packages/iris-character/src/index.ts'

// This script spawns its own host, so the port is the one it listens on rather
// than one it must find something at; it is still a variable, because two QA
// runs on one machine must not fight over it.
const PORT = Number(process.env.IRIS_PORT ?? 8812)
const BASE = `http://127.0.0.1:${String(PORT)}`
const CORPUS = process.env.IRIS_CORPUS ?? 'D:/workspace/小项目/iris_分支/测试用卡'
const CARD_SOURCE = `${CORPUS}/1_5.png`
const CARD_FILE = '哈人冰恋 1_5.png'
const BOUND_BOOK = '哈人冰恋世界v2.0'

let seq = 0

/** One RPC call. Returns the full frame (`{id, ok, result|error}`). */
async function rpc(method, params = {}) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-charops-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
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
  const deadline = Date.now() + 20000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const dataDir = await mkdtemp(join(tmpdir(), 'iris-charops-qa-'))
const profile = join(dataDir, 'default-user')
await mkdir(join(profile, 'characters'), { recursive: true })
await copyFile(CARD_SOURCE, join(profile, 'characters', CARD_FILE))

/** The profile's materialised books, so the test can see what a rename did. */
const worldsDir = join(profile, 'worlds')
const worldList = async () => {
  try {
    return (await readdir(worldsDir)).sort()
  } catch {
    return []
  }
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
    IRIS_USER_NAME: 'Traveller',
  },
  stdio: 'inherit',
})
console.log(`host process PID ${String(host.pid)} on port ${String(PORT)}`)
try {
  await waitUntil(async () => {
    try {
      return (await rpc('character.list')).ok === true
    } catch {
      return false
    }
  }, 'the host to answer its first RPC')

  // -- the library sees the dropped card -----------------------------------
  const listed = await call('character.list')
  const original = listed.characters.find(row => row.characterId === '哈人冰恋 1_5')
  assert.ok(original !== undefined, 'the card did not land under its file name')
  assert.equal(original.name, '哈人冰恋世界')
  assert.deepEqual(original.tags, [])
  assert.ok(typeof original.updatedAt === 'number', 'the listing carried no file time')

  // -- first open materialises the bound book from the embedded copy --------
  const created = await call('chat.create', { characterId: original.characterId })
  const chatId = created.view.chatId
  assert.equal(created.view.messages.length, 1, 'the chat did not seed exactly a greeting')
  assert.ok((created.view.messages[0]?.text ?? '').length > 0, 'the greeting was empty')
  const names = await call('worldbook.charNames', { characterId: original.characterId })
  assert.equal(names.primary, BOUND_BOOK, 'the binding name is not the card\'s own')
  const book = await call('worldbook.get', { name: BOUND_BOOK })
  assert.equal(book.entries.length, 107, 'the bound book is not the embedded 107')
  assert.deepEqual(await worldList(), [`${BOUND_BOOK}.json`])
  const bindingsFile = JSON.parse(await readFile(join(profile, 'worldbook-bindings.json'), 'utf8'))
  assert.equal(bindingsFile[original.characterId]?.name, BOUND_BOOK)

  // -- 1: rename must not break the binding --------------------------------
  const NEW_NAME = '哈人冰恋世界·更名版'
  const renamed = await call('character.rename', { characterId: original.characterId, name: NEW_NAME })
  assert.equal(renamed.character.characterId, original.characterId, 'the id moved with the name')
  assert.equal(renamed.character.name, NEW_NAME)

  const renamedNames = await call('worldbook.charNames', { characterId: original.characterId })
  assert.equal(renamedNames.primary, BOUND_BOOK, 'the binding broke across a rename')
  const renamedBook = await call('worldbook.get', { name: BOUND_BOOK })
  assert.equal(renamedBook.entries.length, 107, 'the book behind the binding changed')
  assert.deepEqual(await worldList(), [`${BOUND_BOOK}.json`], 'the materialised book was re-minted')
  // Reopening the chat still assembles from the same book.
  await call('chat.open', { chatId })

  // -- 2: duplicate shares the book and can open a new chat ----------------
  const { character: copy } = await call('character.duplicate', { characterId: original.characterId })
  assert.notEqual(copy.characterId, original.characterId)
  assert.equal(copy.name, NEW_NAME, 'the copy is not the card as it stands')
  const copyNames = await call('worldbook.charNames', { characterId: copy.characterId })
  assert.equal(copyNames.primary, BOUND_BOOK, 'the duplicate minted its own book')
  assert.deepEqual(await worldList(), [`${BOUND_BOOK}.json`], 'the duplicate grew a second book file')
  const copyChat = await call('chat.create', { characterId: copy.characterId })
  assert.equal(copyChat.view.characterId, copy.characterId, 'the copy could not open a chat of its own')
  assert.equal(copyChat.view.messages.length, 1, 'the copy opened with someone else\'s history')

  // -- 3: export is field-for-field the stored card -------------------------
  const cardPath = join(profile, 'characters', `${original.characterId}.png`)
  const stored = jsonOf(await readFile(cardPath))
  const exported = await call('character.export', { characterId: original.characterId, format: 'png' })
  assert.equal(exported.filename, `${original.characterId}.png`)
  const exportedChunks = readCardChunks(new Uint8Array(Buffer.from(exported.content, 'base64')))
  const exportedJson = JSON.parse(Buffer.from(exportedChunks.ccv3, 'base64').toString('utf8'))
  assert.deepEqual(exportedJson.data, stored.data, 'the exported card body differs from the stored card')
  assert.equal(exportedJson.name, stored.name, 'the exported V1 mirror differs')
  assert.equal('chat' in exportedJson, false, 'the export carried a last-open pointer')
  const jsonExport = await call('character.export', { characterId: original.characterId, format: 'json' })
  const jsonBody = JSON.parse(jsonExport.content)
  assert.deepEqual(jsonBody.data, stored.data, 'the JSON export differs from the stored card')

  // -- 4: tags write back to the card --------------------------------------
  const TAGS = ['dark', '惊悚']
  const tagged = await call('character.setTags', { characterId: original.characterId, tags: TAGS })
  assert.deepEqual(tagged.character.tags, TAGS)
  const afterTags = jsonOf(await readFile(cardPath))
  assert.deepEqual(afterTags.data.tags, TAGS, 'the tags did not reach the card file')
  const relisted = await call('character.list')
  assert.deepEqual(relisted.characters.find(row => row.characterId === original.characterId)?.tags, TAGS,
    'the list did not show the new tags')

  // -- 5: favorites are profile-level --------------------------------------
  await call('character.favorite', { characterId: original.characterId, favorite: true })
  const favoritesFile = JSON.parse(await readFile(join(profile, 'favorites.json'), 'utf8'))
  assert.ok(favoritesFile.favorites.includes(original.characterId), 'the star never landed')
  const favList = await call('character.list')
  const favRow = favList.characters.find(row => row.characterId === original.characterId)
  assert.equal(favRow?.favorite, true, 'the star did not ride the listing')
  const favCard = jsonOf(await readFile(cardPath))
  assert.equal(favCard.data.extensions.fav, stored.data.extensions.fav,
    'the star was written into the card')
  assert.equal(favCard.data.extensions.fav === true, false,
    'the card carries a starred flag')

  console.log('all character-manager acceptance checks passed')
} finally {
  // Managed by the recorded PID alone.
  host.kill()
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}

/** The card JSON a PNG file carries (ccv3 first, matching the reader). */
function jsonOf(bytes) {
  const chunks = readCardChunks(new Uint8Array(bytes))
  return JSON.parse(Buffer.from(chunks.ccv3 ?? chunks.chara, 'base64').toString('utf8'))
}
