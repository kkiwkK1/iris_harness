// Render-only pass over an existing chat: no new chat, no new turn. Opens the
// app, switches to the Reading tab, opens the named chat from the list, then
// samples the interface frames at the QA cadence (5 samples, 1.5s apart).
// Used to answer "is the frame geometry viewport-dependent?" for the
// 哈人冰恋世界 baseline without spending another conversation turn.
//
// Usage: node qa/render-only.mjs "<chat title or character name>" [width] [height]
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { BASE } from './rpc.mjs'

const [, , target, widthArg, heightArg] = process.argv
if (target === undefined) {
  console.error('usage: node qa/render-only.mjs "<chat title>" [width] [height]')
  process.exit(64)
}
const WIDTH = Number(widthArg ?? 1680)
const HEIGHT = Number(heightArg ?? 1050)
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = process.env.CDP_PORT ?? '9334'
const HARD_DEADLINE = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 180_000)

const outDir = new URL('./results/', import.meta.url)
mkdirSync(outDir, { recursive: true })

const userDataDir = `${process.env.TEMP}/iris-qa-cdp-${CDP_PORT}-${Date.now()}`
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run', '--no-default-browser-check', '--headless=new',
  `--window-size=${String(WIDTH)},${String(HEIGHT)}`, 'about:blank',
], { stdio: 'ignore' })

try {
  let page
  for (let at = 0; at < 30 && page === undefined; at += 1) {
    await delay(1000)
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json())
      page = targets.find(t => t.type === 'page' && t.url.startsWith('about:blank'))
    } catch { /* chrome not up yet */ }
  }
  if (page === undefined) throw new Error('chrome never came up')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let seq = 0
  const pending = new Map()
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails !== undefined) return { error: String(r.result.exceptionDetails.exception?.description ?? '?') }
    return r.result?.result?.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: BASE })
  await delay(7000)

  const opened = await evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const wanted = ${JSON.stringify(target)}
    const tabs = [...document.querySelectorAll('[role=tab]')]
    const readingTab = tabs.find(b => (b.textContent ?? '').includes('Reading'))
    if (readingTab === undefined) return { error: 'no Reading tab' }
    readingTab.click()
    await sleep(500)
    const rows = [...document.querySelectorAll('button, [role=button], a, li')].filter(el => (el.textContent ?? '').includes(wanted))
    if (rows.length === 0) return { error: 'chat row not found for ' + wanted }
    rows[0].click()
    return { clicked: rows.length }
  })()`)
  console.log('open:', JSON.stringify(opened))
  await delay(12_000) // script frames boot

  const series = await evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const read = () => [...document.querySelectorAll('.iris-interfaces__slot iframe')].map(f => {
      const box = f.getBoundingClientRect()
      return { w: Math.round(box.width), h: Math.round(box.height), inline: f.style.height || '' }
    })
    const samples = []
    for (let at = 0; at < 5; at += 1) { samples.push(read()); if (at < 4) await sleep(1500) }
    return samples
  })()`)
  const count = Array.isArray(series) && series.length > 0 ? series[0].length : 0
  for (let i = 0; i < count; i += 1) {
    const sizes = [...new Set(series.map(s => s[i] ? `${s[i].w}x${s[i].h}` : 'gone'))]
    const tail = new Set(series.slice(-3).map(s => s[i] ? `${s[i].w}x${s[i].h}` : 'gone'))
    console.log(`frame#${i}: sizes=[${sizes.join(',')}] stable=${tail.size === 1 ? 'yes' : 'NO'} inline=[${[...new Set(series.map(s => s[i]?.inline))].join(' | ')}]`)
  }
  if (count === 0) console.log('frames: none')

  const inner = await evaluate(`[...document.querySelectorAll('.iris-interfaces__slot iframe')].map(f => ({
    w: Math.round(f.getBoundingClientRect().width),
    column: (() => { const p = f.closest('[class*=iris]'); return p?.className ?? '' })(),
  }))`)
  console.log('viewport:', `${String(WIDTH)}x${String(HEIGHT)}`, 'frames detail:', JSON.stringify(inner))

  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })
  writeFileSync(new URL(`./results/render-${target.replace(/[^\p{L}\p{N}-]+/gu, '-')}-${String(WIDTH)}.jpeg`, import.meta.url), Buffer.from(shot.result?.data ?? '', 'base64'))
  clearTimeout(HARD_DEADLINE)
  ws.close()
} finally {
  chrome.kill()
  await delay(500)
}
process.exit(0)
