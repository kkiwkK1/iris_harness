/**
 * Z3 pre-flight: C17 snapshots of the heavy-card chats before any operation.
 *
 * The C17 mechanism snapshots a conversation in front of a rewrite
 * (`script.setChatMessages` takes a 'rewrite-messages' snapshot before it
 * touches anything), so the snapshot is taken by replaying each chat's own
 * floor 0 back to it — a content no-op whose only effect is the pre-change
 * copy the store writes while the disk still holds it.
 *
 * **Message index, not file line.** The export is the chat file verbatim, and
 * its first line is the metadata line, not a message: message 0 is export line
 * 1. The first version of this probe read line 0 and replayed `undefined` —
 * blanking floor 0 in the host's memory (not on disk; `setChatMessages` does
 * not persist). Read the true floor from line 1, and compare the export
 * against the on-disk file afterwards.
 *
 * Usage: node qa/z3-rpc-probe.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8823/'

const CHATS = [
  { key: 'shibian', chat: '尸变纪元-v0-20260903-194944' },
  { key: 'zhengjing', chat: '新架空政治经济模拟器-20260905-061145' },
  { key: 'hanren', chat: '哈人冰恋世界-20260903-194925' },
]

let seq = 0
async function rpc(method, params = {}) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `z3-${++seq}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  return res.json()
}
async function call(method, params = {}) {
  const frame = await rpc(method, params)
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code} ${frame.error?.message}`)
  return frame.result
}

const out = {}
for (const spec of CHATS) {
  // Truth from the on-disk file: line 0 is the chat-file meta line, so the
  // first message — the floor `chat.editMessage` calls 0 — is line 1.
  const disk = readFileSync(
    new URL(`../apps/iris/data/default-user/chats/${spec.chat}.jsonl`, import.meta.url),
    'utf8',
  )
  const lines = disk.split('\n').filter(Boolean)
  const floor0 = JSON.parse(lines[1])
  const text = floor0.mes ?? ''

  // The C17 snapshot: setChatMessages snapshots before rewriting; the rewrite
  // carries the very bytes that are already stored, so nothing changes.
  await call('script.setChatMessages', {
    chatId: spec.chat,
    messages: [{ messageId: 0, message: text }],
  })

  // The rewrite is in-memory only and announce-only, but verify against disk
  // anyway: identical bytes modulo the meta line's `updatedAt` touch.
  const exported = await call('chat.export', { chatId: spec.chat })
  const stripStamp = text_ => text_.replace(/"updatedAt":\d+/, '"updatedAt":0')
  const identical = stripStamp(exported.content) === stripStamp(disk)
  out[spec.key] = {
    chat: spec.chat,
    floors: lines.length - 1,
    floor0Chars: text.length,
    exportMatchesDisk: identical,
  }
  console.log(`${spec.key}: floors=${lines.length - 1} floor0chars=${text.length} exportMatchesDisk=${identical}`)
}

const backups = await call('backup.list', {})
const ids = new Set(CHATS.map(spec => spec.chat))
out.backups = backups.backups.filter(b => ids.has(b.chatId))
console.log('C17 snapshots for target chats:', out.backups.length)
writeFileSync(new URL('./z3-rpc-state.json', import.meta.url), JSON.stringify(out, null, 2))
