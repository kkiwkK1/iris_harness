// REVIEW-5 §4 — the claim-vs-frame caliper for existing conversations.
//
// The judgment REVIEW-5 §4 states is "frame 数对不上 claim 数才是异常": for
// every floor, the number of interface slots the shell built must equal the
// number of blocks `claimMessageSurfaces` claims on that floor's own text. A
// floor the model wrote with no interface blocks is expected to have zero
// slots, and one that wrote blocks must have one slot each.
//
// This reads **existing** conversations; it generates nothing and costs no
// tokens. That is deliberately a different instrument from
// `qa/review2-drive.mjs`, whose `frameStability.frames` counts every
// `.iris-interfaces__slot iframe` on the page — greeting floors included — so
// its "reply frames" overstates the reply floor by however many frames the
// greeting built. The per-floor number is the one this judgment needs, so it
// is measured per floor here rather than inferred from the page total.
//
// Usage:
//   IRIS_BASE=http://127.0.0.1:8788 node qa/review5-claims.mjs <cardsFile>
//   IRIS_BASE=http://127.0.0.1:8788 node qa/review5-claims.mjs --chat <chatId> [--chat <chatId> …]
// cardsFile: one `characterId` per line, `#` comments and blanks skipped; the
// most recent conversation of that card is the one opened. Not part of any
// build; reads/writes nothing.

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import { claimMessageSurfaces } from '../apps/iris-web/src/sandbox/frontend-blocks.ts'
import { repairStrayFences } from '../apps/iris-web/src/app/stray-fences.ts'

const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8788'
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = String(Number(process.env.IRIS_CDP ?? '9864'))

const argv = process.argv.slice(2)
const chats = []
for (let at = 0; at < argv.length; at += 1) {
  if (argv[at] === '--chat') chats.push(argv[at + 1])
}
let cards = null
if (chats.length === 0) {
  const file = argv.find(a => !a.startsWith('--'))
  if (file === undefined) {
    console.error('usage: node qa/review5-claims.mjs <cardsFile> | --chat <chatId> [--chat <chatId> …]')
    process.exit(64)
  }
  cards = readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))
  // The card list is the batch driver's own format, `id|displayName|flags`;
  // only the id is wanted here, so the later columns are dropped rather than
  // asked for a second file.
  cards = cards.map(l => l.split('|')[0])
}

let seq = 0
async function call(method, params = {}) {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `r5c-${++seq}`, method, params }),
  })
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

if (cards !== null) {
  const list = await call('chat.list', {})
  for (const card of cards) {
    const mine = list.chats.filter(c => c.characterId === card).sort((a, b) => String(b.chatId).localeCompare(String(a.chatId)))
    if (mine[0] === undefined) { console.error(`no conversation for ${card}`); continue }
    chats.push(mine[0].chatId)
  }
}

function socket(url) {
  const ws = new WebSocket(url)
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('socket failed: ' + url)) })
  let id = 0
  const pending = new Map()
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  const send = (method, params = {}) => new Promise(async res => {
    await opened
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails !== undefined) return { error: String(r.result.exceptionDetails.exception?.description ?? '?').slice(0, 240) }
    return r.result?.result?.value
  }
  return { ws, opened, send, evaluate }
}

// Per-floor geometry, scoped to the floor's own `.iris-msg` element. The
// document-wide counts are reported beside it so the difference between this
// caliper and the batch driver's page-wide `frames` stays visible.
const READ = `(() => {
  const floors = [...document.querySelectorAll('.iris-msg')].map(m => ({
    floor: (m.querySelector('.iris-msg__floor') || {}).textContent || '',
    who: ((m.querySelector('.iris-msg__who') || {}).textContent || '').trim(),
    slots: m.querySelectorAll('.iris-interfaces__slot').length,
    iframes: m.querySelectorAll('.iris-interfaces__slot iframe').length,
    folds: m.querySelectorAll('.iris-bodyleak').length,
    textLen: ((m.querySelector('.iris-msg__text') || {}).textContent || '').trim().length,
  }))
  return {
    floors,
    pageSlots: document.querySelectorAll('.iris-interfaces__slot').length,
    pageIframes: document.querySelectorAll('.iris-interfaces__slot iframe').length,
  }
})()`

const rows = []
const chrome = spawn(CHROME, [
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + process.env.TEMP + '/iris-r5c-' + CDP_PORT + '-' + Date.now(),
  '--no-first-run', '--no-default-browser-check', '--headless=new', '--window-size=1500,950', 'about:blank',
], { stdio: 'ignore' })

try {
  let page
  for (let at = 0; at < 30 && page === undefined; at += 1) {
    await delay(1000)
    try { const t = await fetch('http://127.0.0.1:' + CDP_PORT + '/json').then(r => r.json()); page = t.find(x => x.type === 'page' && x.url.startsWith('about:blank')) } catch { /* not up */ }
  }
  if (page === undefined) throw new Error('chrome never came up')
  const p = socket(page.webSocketDebuggerUrl)
  await p.opened
  await p.send('Page.enable')
  await p.send('Runtime.enable')

  console.log('card | floor | slots | claims | folds | replyChars | verdict')
  for (const chatId of chats) {
    const view = await call('chat.open', { chatId })
    const texts = view.view.messages.map(m => repairStrayFences(m.text ?? ''))
    const kinds = texts.map(t => claimMessageSurfaces(t).blocks.map(b => b.kind))

    await p.send('Page.navigate', { url: BASE })
    await delay(6500)
    await p.evaluate(`[...document.querySelectorAll('[data-tab=chats]')][0]?.click(); 'ok'`)
    await delay(1400)
    const clicked = await p.evaluate(`document.querySelector('[data-chat=${JSON.stringify(chatId)}]') === null ? false : (document.querySelector('[data-chat=${JSON.stringify(chatId)}]').click(), true)`)
    await delay(10_000)
    const read = await p.evaluate(READ)

    for (let at = 0; at < (read?.floors?.length ?? 0); at += 1) {
      const f = read.floors[at]
      const claims = kinds[at] ?? []
      const verdict = f.slots === claims.length ? 'ok' : 'MISMATCH'
      rows.push({ chatId, floor: f.floor, slots: f.slots, claims: claims.length, kinds: claims, folds: f.folds, textLen: f.textLen, verdict })
      console.log(`${chatId} | ${f.floor} | ${f.slots} | ${claims.length} | ${f.folds} | ${f.textLen} | ${verdict}${claims.length === 0 ? ' (no blocks)' : ''}`)
    }
    if (clicked !== true) console.log(`${chatId} | row for this chat was not in the sidebar`)
    console.log(`${chatId} |      | page-wide slots=${read?.pageSlots} iframes=${read?.pageIframes}`)
  }

  const bad = rows.filter(r => r.verdict !== 'ok')
  console.log(`\nsummary: floors=${rows.length} ok=${rows.length - bad.length} MISMATCH=${bad.length}`)
  const outDir = new URL('./results/review5/', import.meta.url)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(new URL('claims.json', outDir), JSON.stringify({ base: BASE, at: new Date().toISOString(), rows }, null, 2))
  console.log('results -> qa/results/review5/claims.json')
} finally {
  chrome.kill()
  await delay(500)
}
