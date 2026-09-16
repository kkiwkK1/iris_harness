// U2 candidate-level variable probe: does the message scope follow the SELECTED
// candidate? Reads message-scope variables for one turn before and after a
// `chat.swipe`, and reports whether the table changed with the selection.
//
// Usage: node qa/results/u2-probe.mjs <chatId> [turn]
import { setTimeout as delay } from 'node:timers/promises'

const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8787'
const [chatId, turnArg] = process.argv.slice(2)
if (chatId === undefined) { console.error('usage: node qa/results/u2-probe.mjs <chatId> [turn]'); process.exit(64) }
let seq = 0
async function call(method, params = {}) {
  const r = await fetch(`${BASE}/iris/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `u2-${++seq}`, method, params }) })
  const frame = await r.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code} ${frame.error?.message}`)
  return frame.result
}
const summarize = v => {
  if (v === null || v === undefined) return null
  const o = {}
  for (const [k, x] of Object.entries(v)) o[k] = x !== null && typeof x === 'object' ? { keys: Object.keys(x).slice(0, 14), bytes: JSON.stringify(x).length } : x
  return o
}
const open = () => call('chat.open', { chatId }).then(r => r.view)
let view = await open()
const reply = view.messages.filter(m => m.role !== 'user' && m.swipes !== undefined).at(-1)
const turn = turnArg === undefined ? reply.turn : Number(turnArg)
console.log(`chat ${chatId} turn ${turn} candidates ${reply.swipes?.count} showing ${reply.swipes?.index}`)

async function snapshot(label) {
  const v = await open()
  const msg = v.messages.find(m => m.turn === turn && m.role !== 'user')
  const msgScope = summarize((await call('script.getVariables', { chatId, scope: 'message' })).variables)
  const chatScope = summarize((await call('script.getVariables', { chatId, scope: 'chat' })).variables)
  // Read the floor-addressed scope too: {message_id: turn} is what a card's
  // floor read answers with.
  const floorScope = summarize((await call('script.getVariables', { chatId, scope: 'message', messageId: msg.id })).variables)
  console.log(`\n=== ${label} ===`)
  console.log(`  selected index: ${msg.swipes?.index}  count: ${msg.swipes?.count}  textLen: ${msg.text.length}  textHead: ${msg.text.slice(0, 70).replace(/\s+/g, ' ')}`)
  console.log(`  message-scope: ${JSON.stringify(msgScope)?.slice(0, 500)}`)
  console.log(`  floor(${msg.id})-scope: ${JSON.stringify(floorScope)?.slice(0, 300)}`)
  console.log(`  chat-scope:    ${JSON.stringify(chatScope)?.slice(0, 200)}`)
  return { index: msg.swipes?.index, msgScope, floorScope, textHead: msg.text.slice(0, 120) }
}

const out = { chatId, turn, steps: [] }
out.steps.push(await snapshot('as-is'))
const count = reply.swipes?.count ?? 1
const other = (reply.swipes?.index ?? 0) === 0 ? 1 : 0
if (count > 1) {
  await call('chat.swipe', { chatId, turn, index: other })
  await delay(2500)
  out.steps.push(await snapshot(`after swipe -> index ${other}`))
  await call('chat.swipe', { chatId, turn, index: reply.swipes?.index ?? 0 })
  await delay(2500)
  out.steps.push(await snapshot(`after swipe back -> index ${reply.swipes?.index ?? 0}`))
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
console.log(`\nverdict: message-scope identical across candidates = ${same(out.steps[0].msgScope, out.steps[1]?.msgScope)}`)
console.log(`verdict: message-scope round-trips = ${out.steps.length > 2 ? same(out.steps[0].msgScope, out.steps[2].msgScope) : 'n/a'}`)
