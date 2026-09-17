// REVIEW-5 §4.1 — per-candidate message-scope state, read as raw bytes.
//
// REVIEW-2's finding (U2) was that a reply's `message`-scope variables follow
// the *selected candidate*, not "the last generation": writing a sentinel into
// candidate 0, swiping to candidate 1, then swiping back to 0 brings candidate
// 0's own table back. This re-measures that on existing conversations and adds
// the reading the batch driver cannot give: the **raw byte size** of the table
// per candidate, so "candidate 1 holds a different table" is visible even when
// both candidates agree on which top-level keys they carry.
//
// `qa/review2-drive.mjs --swipe` records `variablesAfterRegenerate` and
// `variablesAfterSwipeBack`, but those are the host's *summarised view* (top
// keys and byte counts per key), and for a card whose two candidates differ
// only inside `stat_data` the summary can read the same both times. The raw
// serialization below is the sharper ruler; both are kept, and their readings
// do not conflict.
//
// Usage:
//   IRIS_BASE=http://127.0.0.1:8788 node qa/review5-swipe-vars.mjs <cardsFile>
//   IRIS_BASE=http://127.0.0.1:8788 node qa/review5-swipe-vars.mjs --card <characterId> [--card …]
// cardsFile: the batch driver's own `<id>|<displayName>|<flags>` lines; only the
// id is read. Not part of any build. Reads only — it swipes through candidates,
// which changes `selectedCandidate` (and puts it back to 0), nothing else.

import { readFileSync } from 'node:fs'

const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8788'
const argv = process.argv.slice(2)
const cards = []
for (let at = 0; at < argv.length; at += 1) {
  if (argv[at] === '--card') cards.push(argv[at + 1])
}
if (cards.length === 0) {
  const file = argv.find(a => !a.startsWith('--'))
  if (file === undefined) {
    console.error('usage: node qa/review5-swipe-vars.mjs <cardsFile> | --card <characterId> [--card …]')
    process.exit(64)
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    cards.push(trimmed.split('|')[0])
  }
}

let seq = 0
async function call(method, params = {}) {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `r5s-${++seq}`, method, params }),
  })
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const list = await call('chat.list', {})
console.log('card | candidates | per-candidate bytes | swipe back to 0')
for (const card of cards) {
  const mine = list.chats.filter(c => c.characterId === card).sort((a, b) => String(b.chatId).localeCompare(String(a.chatId)))
  if (mine[0] === undefined) { console.log(`${card} | no conversation | |`); continue }
  const chatId = mine[0].chatId
  const view = await call('chat.open', { chatId })
  const reply = view.view.messages.filter(m => m.role !== 'user').at(-1)
  const count = reply.swipes?.count ?? 0
  if (count < 2) { console.log(`${card} | ${count} | (no swipe to compare) | |`); continue }

  const read = async () => JSON.stringify((await call('script.getVariables', { chatId, scope: 'message' })).variables ?? {})
  const sizes = []
  for (let index = 0; index < count; index += 1) {
    await call('chat.swipe', { chatId, turn: reply.turn, index })
    await wait(900)
    sizes.push(await read())
  }
  // Back to 0, which is the state a reader sees after a round trip.
  await call('chat.swipe', { chatId, turn: reply.turn, index: 0 })
  await wait(900)
  const back = await read()
  const verdict = back === sizes[0] ? 'identical' : `DIFFERS (${String(back.length)} vs ${String(sizes[0].length)})`
  console.log(`${card} | ${count} | ${sizes.map(s => String(s.length)).join(' -> ')} | ${verdict}`)
}
