// REVIEW-5 §3.5 — the causal switch for #128.
//
// REVIEW-2's anomaly A was that the body tag decided which interfaces a
// message had: `MessageInterfaces` handed `<content>`'s *inner* text to the
// claim, so a reply that wrapped its fenced docs and bare-HTML regions
// outside `<content>` built no frames at all. #128 made the claim read the
// whole repaired message and left the tag to lay out prose and fold
// scaffolding. The claim under test here is that the tag no longer decides
// the frame count.
//
// This is a one-shot instrument for that one claim. It opens a page on the
// given host, opens one existing conversation through the sidebar the way a
// reader does, and reads the frame count of every floor. Then it sets
// `iris.bodyTag` to a name that matches nothing, reloads, reads again; then
// removes the key, reloads, reads once more. The expectation is that the
// three readings agree on the frame count (the tag has nothing to match, and
// no longer decides the count), while the `<content>`/`</content>` markers
// show up as text on the middle pass — that text is the observable that says
// the switch actually took.
//
// Usage:
//   IRIS_BASE=http://127.0.0.1:8788 node qa/review5-causal-switch.mjs <chatId> [--title "card name"] [--tag zzznotatag] [--cdp <port>]
// Reads/writes under qa/results/review5/. Not part of any build.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8788'
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const argv = process.argv.slice(2)
const chatId = argv[0]
if (chatId === undefined) {
  console.error('usage: IRIS_BASE=http://127.0.0.1:8788 node qa/review5-causal-switch.mjs <chatId> [--tag zzznotatag] [--cdp <port>]')
  process.exit(64)
}
const value = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const TAG = value('--tag', 'zzznotatag')
// The row title to click, when the chat id's own prefix is not the card's
// display name (they differ for several corpus cards).
const TITLE = value('--title', undefined)
const CDP_PORT = String(Number(value('--cdp', String(9800 + (process.pid % 100)))))

function slugify(input) {
  return String(input).replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 48)
}

const outDir = new URL('./results/review5/', import.meta.url)
mkdirSync(outDir, { recursive: true })
const result = { chatId, base: BASE, at: new Date().toISOString(), tag: TAG, readings: {} }

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
    if (r.result?.exceptionDetails !== undefined) {
      return { error: String(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text ?? '?').slice(0, 240) }
    }
    return r.result?.result?.value
  }
  return { ws, opened, send, evaluate }
}

// One reading of the reading pane: per-floor slot and frame counts, the
// folded-scaffolding count, and the page text (so the `<content>` markers can
// be counted). A collapsed `<details>` is where a matched tag puts its
// scaffolding; with a tag that matches nothing there is no scaffolding to
// fold and the raw markers show up in the prose instead.
const READ = `(() => {
  const floors = [...document.querySelectorAll('.iris-msg')].map(m => ({
    floor: (m.querySelector('.iris-msg__floor') ?? {}).textContent ?? '',
    slots: m.querySelectorAll('.iris-interfaces__slot').length,
    iframes: m.querySelectorAll('.iris-interfaces__slot iframe').length,
    bodyleaks: m.querySelectorAll('.iris-bodyleak').length,
  }))
  return {
    slots: document.querySelectorAll('.iris-interfaces__slot').length,
    iframes: document.querySelectorAll('.iris-interfaces__slot iframe').length,
    bodyleaks: document.querySelectorAll('.iris-bodyleak').length,
    floors,
    text: [...document.querySelectorAll('.iris-msg__text')].map(e => e.textContent ?? '').join('\\n'),
  }
})()`

const contentMarkers = text => (text.match(/<\/?content>/g) ?? []).length

const chrome = spawn(CHROME, [
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + process.env.TEMP + '/iris-r5-' + CDP_PORT + '-' + Date.now(),
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

  // Open the conversation through the sidebar: chats tab -> the row whose
  // title matches the card's display name -> click. This is the reader's
  // path, not a harness that mounts one component.
  //
  // There is no per-chat identity in the DOM, so the row is found by its
  // title, which is a card's display name — two conversations of one card
  // share it. The acceptance for this instrument opens one conversation per
  // card (the rerun batch), so the ambiguity does not arise here; the reading
  // records which title it clicked so a wrong row would be visible rather
  // than silent.
  const title = TITLE ?? chatId.replace(/-\d{8}-\d{6}$/, '')
  const openChat = async () => {
    await p.send('Page.navigate', { url: BASE })
    await delay(8000)
    await p.evaluate(`[...document.querySelectorAll('[data-tab=chats]')][0]?.click(); 'ok'`)
    await delay(1800)
    const clicked = await p.evaluate(`(() => {
      const wanted = ${JSON.stringify(title)}
      const rows = [...document.querySelectorAll('.iris-row--chat')]
      const byTitle = (el) => (el.querySelector('.iris-row__title')?.textContent ?? '').trim()
      const hit = rows.find(el => byTitle(el) === wanted) ?? rows.find(el => byTitle(el).includes(wanted))
      if (hit === undefined) return { error: 'no row titled ' + wanted, seen: rows.slice(0, 15).map(byTitle) }
      hit.click()
      return { clicked: true, title: byTitle(hit), rows: rows.length }
    })()`)
    await delay(10_000)
    const read = await p.evaluate(READ)
    return { clicked, read }
  }

  await p.evaluate(`localStorage.removeItem('iris.bodyTag')`)
  result.readings.baseline = await openChat()

  await p.evaluate(`localStorage.setItem('iris.bodyTag', ${JSON.stringify(TAG)})`)
  result.readings.switched = await openChat()

  await p.evaluate(`localStorage.removeItem('iris.bodyTag')`)
  result.readings.restored = await openChat()

  for (const [name, r] of Object.entries(result.readings)) {
    const rd = r.read ?? {}
    console.log(name + ': slots=' + (rd.slots ?? '?') + ' iframes=' + (rd.iframes ?? '?') + ' bodyleaks=' + (rd.bodyleaks ?? '?') + ' contentMarkers=' + contentMarkers(rd.text ?? '') + ' clicked=' + JSON.stringify(r.clicked))
  }
  writeFileSync(new URL(slugify(chatId) + '.json', outDir), JSON.stringify(result, null, 2))
  console.log('results -> qa/results/review5/' + slugify(chatId) + '.json')
} finally {
  chrome.kill()
  await delay(500)
}
