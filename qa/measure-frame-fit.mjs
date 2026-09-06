/**
 * Task U verification: message-frame size + occlusion geometry over CDP.
 *
 * Opens real chats for the heavy cards, measures every message interface
 * frame's geometry against the visible reading band, checks text occlusion by
 * rect intersection plus elementFromPoint sampling, watches for height
 * oscillation by continuous sampling, and screenshots each state.
 *
 * Usage: node qa/measure-frame-fit.mjs <baseline|fixed> [chatKey ...]
 *   chatKey: shibian | zhengjing | hanren | shenyin | quanzhi
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = 'http://127.0.0.1:8821/'
const DEBUG_PORT = 9341
const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'results')

const CHATS = {
  shibian: { chat: '尸变纪元-v0-20260903-194944', title: '尸变纪元 v0.5（NSFW）', card: '尸变纪元' },
  zhengjing: { chat: '新架空政治经济模拟器-20260905-061145', title: '新·架空政治经济模拟器', card: '政经博弈' },
  hanren: { chat: '哈人冰恋世界-20260903-194925', title: '哈人冰恋世界', card: '哈人冰恋' },
  shenyin: { chat: '不要被神隐挑战-V1.5-20260904-124737', title: '不要被神隐挑战 V1.5.4 测试版', card: '神隐挑战' },
  quanzhi: { chat: '全职高手-20260905-111826', title: '全职高手', card: '全职高手' },
}

const wanted = process.argv.slice(2).filter(a => !['baseline', 'fixed'].includes(a))
const tag = process.argv[2] === 'fixed' || process.argv[3] === 'fixed' ? 'fixed' : 'baseline'
const keys = wanted.length > 0 ? wanted : ['shibian', 'zhengjing', 'hanren']

mkdirSync(OUT, { recursive: true })

// ws ships in the pnpm store; resolve it without adding a dependency.
const require = createRequire(import.meta.url)
const wsPath = new URL('../node_modules/.pnpm/ws@8.21.3/node_modules/ws/index.js', import.meta.url).href
const WebSocket = (await import(wsPath)).default ?? (await import(wsPath))

const profile = mkdtempSync(join(tmpdir(), 'iris-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1920,1080',
  'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))

let version = null
for (let i = 0; i < 50 && !version; i++) {
  await sleep(200)
  try {
    version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
  } catch { /* not up yet */ }
}
if (!version) { console.error('chrome debugger never came up'); process.exit(1) }

const browser = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((res, rej) => { browser.on('open', res); browser.on('error', rej) })

let seq = 0
const pending = new Map()
browser.on('message', raw => {
  const msg = JSON.parse(raw)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
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
const cdp = (method, params) => send(method, params, sessionId)

await cdp('Page.enable')
await cdp('Runtime.enable')

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails))
  return r.result.value
}

async function setViewport(width, height) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false })
  await sleep(300)
}

async function shot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'))
  console.log('shot:', name)
}

let rpcSeq = 0
async function rpc(method, params) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `u-${++rpcSeq}`, method, params }),
  })
  return res.json()
}

// The geometry probe. Everything read off the live layout.
const MEASURE = `(() => {
  const rect = el => el ? el.getBoundingClientRect().toJSON() : null
  const scroller = document.querySelector('.iris-scroll')
  const band = scroller ? { top: scroller.getBoundingClientRect().top, height: scroller.clientHeight } : null
  const slots = [...document.querySelectorAll('.iris-interfaces__slot')].map(slot => {
    const frame = slot.querySelector('iframe')
    return {
      instance: slot.dataset.instance,
      slotRect: rect(slot),
      hasFrame: !!frame,
      frameRect: rect(frame),
      inlineHeight: frame ? frame.style.height || null : null,
      cssHeight: frame ? getComputedStyle(frame).height : null,
      sizing: frame ? (frame.dataset.irisSizing ?? null) : null,
    }
  })
  // Text segments: the prose blocks the reading view renders (each segment of
  // each assistant row, plus user rows' text wrappers).
  const textRects = []
  for (const el of document.querySelectorAll('.iris-msg__text')) {
    for (const child of el.children) {
      if (child.classList.contains('iris-interfaces__slot')) continue
      const r = child.getBoundingClientRect()
      if (r.height > 0) textRects.push({ tag: child.tagName, rect: r.toJSON() })
    }
  }
  const overlay = document.querySelector('.iris-overlay-surface')
  const overlayVisible = overlay ? getComputedStyle(overlay).visibility !== 'hidden' : false
  // The surface div itself paints nothing (transparent, pointer-events:none);
  // only its child frames paint. Intersect text with those, not with the box.
  const overlayFrames = overlay
    ? [...overlay.querySelectorAll('iframe')].map(f => f.getBoundingClientRect().toJSON())
    : []
  // Midline: prose column vs composer field.
  const prose = document.querySelector('.iris-column')
  const field = document.querySelector('.iris-composer__field')
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scroller: scroller ? { clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight, scrollTop: scroller.scrollTop } : null,
    band,
    slots,
    textRects: textRects.slice(0, 60),
    overlayRect: rect(overlay),
    overlayFrames,
    overlayVisible,
    proseRect: rect(prose),
    fieldRect: rect(field),
  }
})()`

const OSCILLATE_SAMPLE = `(() => {
  const frames = [...document.querySelectorAll('.iris-interfaces__slot iframe')]
  return frames.map(f => f.getBoundingClientRect().height + '|' + (f.style.height || 'css'))
})()`

await cdp('Page.navigate', { url: BASE })
for (let i = 0; i < 60; i++) {
  await sleep(500)
  const ready = await evaluate(`!!document.querySelector('.iris-stage') && !!document.querySelector('.iris-list')`).catch(() => false)
  if (ready) break
}

async function openChat(spec) {
  // Row buttons carry the chat title inside a .iris-row__title span. The list
  // loads asynchronously, so retry until the row exists.
  const start = Date.now()
  while (Date.now() - start < 20_000) {
    const clicked = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.iris-list .iris-row')]
      const row = rows.find(r => (r.querySelector('.iris-row__title')?.textContent ?? '').trim() === ${JSON.stringify(spec.title)})
      if (row) { row.click(); return true }
      return false
    })()`)
    if (clicked) return true
    await sleep(500)
  }
  return false
}

async function waitForFrames(timeoutMs = 45_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const n = await evaluate(`document.querySelectorAll('.iris-interfaces__slot iframe').length`).catch(() => 0)
    if (n > 0) {
      // Give the frame's own height report a moment to land and settle.
      await sleep(4_000)
      return true
    }
    await sleep(500)
  }
  return false
}

function intersect(a, b) {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > left && bottom > top ? (right - left) * (bottom - top) : 0
}

function analyse(m) {
  const findings = { frames: [], occlusions: [], midline: null }
  for (const slot of m.slots) {
    if (!slot.frameRect) continue
    const frame = slot.frameRect
    const bandBottom = m.band ? m.band.top + m.band.height : m.innerHeight
    findings.frames.push({
      instance: slot.instance,
      frameHeight: Math.round(frame.height),
      inlineHeight: slot.inlineHeight,
      cssHeight: slot.cssHeight,
      sizing: slot.sizing,
      bandHeight: m.band ? Math.round(m.band.height) : null,
      tallerThanBand: m.band ? frame.height > m.band.height + 1 : frame.height > m.innerHeight + 1,
    })
    // Occlusion: frame rect vs every prose text rect.
    for (const t of m.textRects) {
      const area = intersect(frame, t.rect)
      if (area > 40) {
        findings.occlusions.push({
          kind: 'frame-over-text',
          instance: slot.instance,
          textTag: t.tag,
          area: Math.round(area),
          textRect: t.rect,
        })
      }
    }
  }
  // Overlay-card family: the card's own frame paints over the column by
  // design (the collapse toggle is the escape). Report it as its own kind so
  // it can be told from a message-frame fault.
  if (m.overlayVisible) {
    for (const of_ of m.overlayFrames) {
      for (const t of m.textRects) {
        const area = intersect(of_, t.rect)
        if (area > 400) {
          findings.occlusions.push({
            kind: 'overlay-frame-over-text',
            area: Math.round(area),
            overlayRect: of_,
            textRect: t.rect,
          })
        }
      }
    }
  }
  if (m.proseRect && m.fieldRect) {
    findings.midline = {
      proseCentre: Math.round(m.proseRect.x + m.proseRect.width / 2),
      fieldCentre: Math.round(m.fieldRect.x + m.fieldRect.width / 2),
    }
  }
  return findings
}

const report = {}

for (const [W, H] of [[1920, 1080], [1366, 768]]) {
  await setViewport(W, H)
  for (const key of keys) {
    const spec = CHATS[key]
    if (!spec) continue
    const opened = await openChat(spec)
    if (!opened) { console.error(`row for ${spec.chat} not found`); continue }
    // Wait until the row actually switched.
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      const up = await evaluate(`!!document.querySelector('.iris-composer__field')`).catch(() => false)
      if (up) break
    }
    await waitForFrames()
    const m = await evaluate(MEASURE)
    const a = analyse(m)

    // Oscillation: sample frame heights every 250ms for 3s.
    const samples = []
    for (let i = 0; i < 12; i++) {
      samples.push(await evaluate(OSCILLATE_SAMPLE))
      await sleep(250)
    }
    const flat = samples.map(s => s.join(','))
    const distinct = [...new Set(flat)]

    // Scroll the first frame's row into view at the top of the band, then screenshot.
    await evaluate(`(() => {
      const slot = document.querySelector('.iris-interfaces__slot')
      if (slot) slot.scrollIntoView({ block: 'start' })
    })()`)
    await sleep(400)
    await shot(`u-${tag}-${key}-${W}x${H}.png`)

    report[`${key}@${W}x${H}`] = {
      measure: m,
      findings: a,
      oscillation: { distinctStates: distinct.length, states: distinct.slice(0, 4) },
    }
    console.log(`measured ${key}@${W}x${H}: frames=${a.frames.length} occlusions=${a.occlusions.length} oscStates=${distinct.length}`)
  }
}

const outName = `u-frame-fit-${tag}-report.json`
writeFileSync(join(OUT, outName), JSON.stringify(report, null, 2))
console.log('report:', join(OUT, outName))

chrome.kill()
process.exit(0)
