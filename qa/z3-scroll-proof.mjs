/**
 * Z3 visual proof: open the fresh 尸变纪元 greeting (the 1847px interface in a
 * 546px band), scroll the frame's own document to the bottom, and screenshot —
 * the reader's wheel reaches the last of the card.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = 'http://127.0.0.1:8823/'
const DEBUG_PORT = 9347
const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'results')

const wsPath = new URL('../node_modules/.pnpm/ws@8.21.3/node_modules/ws/index.js', import.meta.url).href
const WebSocket = (await import(wsPath)).default ?? (await import(wsPath))
mkdirSync(OUT, { recursive: true })

const profile = mkdtempSync(join(tmpdir(), 'iris-z3scroll-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1366,768', 'about:blank',
], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let version = null
for (let i = 0; i < 50 && !version; i++) {
  await sleep(200)
  try { version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json() } catch {}
}
const browser = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((res, rej) => { browser.on('open', res); browser.on('error', rej) })
let seq = 0
const pending = new Map()
const childSessions = new Set()
browser.on('message', raw => {
  const msg = JSON.parse(raw)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) childSessions.add(msg.params.sessionId)
})
function send(method, params = {}, sessionId) {
  const id = ++seq
  return new Promise((res, rej) => {
    pending.set(id, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
    browser.send(JSON.stringify({ id, method, params, sessionId }))
  })
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const cdp = (m, p) => send(m, p, sessionId)
await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}

await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 0, mobile: false })
await cdp('Page.navigate', { url: BASE })
for (let i = 0; i < 60; i++) {
  await sleep(500)
  if (await evaluate(`!!document.querySelector('.iris-list .iris-row')`).catch(() => false)) break
}
for (let i = 0; i < 40; i++) {
  const ok = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.iris-list .iris-row')]
    const row = rows.find(el => (el.querySelector('.iris-row__title')?.textContent ?? '').trim() === '尸变纪元 v0.5（NSFW）' && /1 分钟|秒|分钟/.test(el.querySelector('.iris-row__meta')?.textContent ?? ''))
    const newest = rows.filter(el => (el.querySelector('.iris-row__title')?.textContent ?? '').trim() === '尸变纪元 v0.5（NSFW）')
    const target = newest[0]
    if (target) { target.click(); return true }
    return false
  })()`).catch(() => false)
  if (ok) break
  await sleep(500)
}
for (let i = 0; i < 90; i++) {
  await sleep(500)
  const n = await evaluate(`document.querySelectorAll('.iris-interfaces__slot iframe').length`).catch(() => 0)
  if (n > 0) { await sleep(4000); break }
}

// Mark the interface frame, find its child session, scroll it to the bottom.
await evaluate(`document.querySelector('.iris-interfaces__slot iframe')?.setAttribute('data-z3-proof', '1')`)
let inner = null
for (const sid of childSessions) {
  try {
    const tree = await send('Page.getFrameTree', {}, sid)
    const owner = await cdp('DOM.getFrameOwner', { frameId: tree.frameTree.frame.id }).catch(() => null)
    if (owner?.backendNodeId === undefined) continue
    const desc = await cdp('DOM.describeNode', { backendNodeId: owner.backendNodeId, depth: 0 })
    if (!(desc.node.attributes ?? []).includes('data-z3-proof')) continue
    inner = await send('Runtime.evaluate', {
      expression: `(() => { const h = document.documentElement; h.scrollTop = 999999; return { scrollTop: h.scrollTop, viewport: h.clientHeight, scrollHeight: h.scrollHeight } })()`,
      returnByValue: true,
    }, sid)
    break
  } catch {}
}
console.log('scrolled inside frame:', JSON.stringify(inner?.result?.value))
await sleep(600)
const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(OUT, 'z3-fixed-shibian-frame-bottom.png'), Buffer.from(data, 'base64'))
console.log('shot written')
chrome.kill()
process.exit(0)
