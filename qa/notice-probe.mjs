// Set up the notice-panel acceptance scenario over RPC against 127.0.0.1:8824.
// Imports three probe cards:
//   NoticeProbe       — two failing scripts plus an interface frame that faults
//                       in its markup (the interface-channel case);
//   NoticeProbeMerge  — exactly one throwing script, plain greeting (the dedup
//                       case: three opens must merge into one x3 row);
//   NoticeSilent      — no scripts, no interface (the quiet switch partner).
import { readFileSync, writeFileSync } from 'node:fs'

// Must match the host `notice-center-baseline.mjs` reads, since this script
// only sets that one's scenario up.
const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8824'
let seq = 0
async function call(method, params = {}) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `np-${++seq}`, method, params }),
  })
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code} ${frame.error?.message}`)
  return frame.result
}

async function importCard(file) {
  const content = readFileSync(new URL(file, import.meta.url)).toString('base64')
  return call('character.import', { filename: file, content })
}

const existing = await call('character.list', {})
for (const c of existing.characters) {
  if (c.name === 'NoticeProbe' || c.name === 'NoticeProbeMerge' || c.name === 'NoticeSilent') {
    await call('character.delete', { characterId: c.characterId })
    console.log('deleted previous', c.name, c.characterId)
  }
}

const state = { characters: {} }

for (const file of ['./notice-probe-card.json', './notice-probe-merge-card.json', './notice-probe-silent-card.json']) {
  const imported = await importCard(file)
  const id = imported.character.characterId
  state.characters[imported.character.name] = id
  const sl = await call('script.list', { characterId: id })
  if (sl.scripts.length > 0 && sl.scriptsAllowed !== true) {
    await call('script.setScriptsAllowed', { characterId: id, allowed: true })
    console.log(imported.character.name, 'scripts granted:', sl.scripts.map(s => s.name).join(','))
  } else {
    console.log(imported.character.name, 'no scripts')
  }
}

const { view } = await call('chat.create', { characterId: state.characters.NoticeProbe })
state.chatId = view.chatId
console.log('probe chat', view.chatId)

// Chats for the merge card and the silent partner, so the browser can switch
// between them from the chats tab.
const mergeChat = await call('chat.create', { characterId: state.characters.NoticeProbeMerge })
state.mergeChatId = mergeChat.view.chatId
const silentChat = await call('chat.create', { characterId: state.characters.NoticeSilent })
state.silentChatId = silentChat.view.chatId
console.log('merge chat', state.mergeChatId, 'silent chat', state.silentChatId)

const list = await call('character.list', {})
state.allCharacters = list.characters.map(c => ({ id: c.characterId, name: c.name }))
writeFileSync(new URL('./notice-probe-state.json', import.meta.url), JSON.stringify(state, null, 2))
console.log('state written')
