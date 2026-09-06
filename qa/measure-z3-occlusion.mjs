/**
 * Task Z3 verification: message-frame geometry, in-frame scroll reach, and
 * marginalia occlusion over CDP, on the three heavy cards.
 *
 * Extends Task U's `measure-frame-fit.mjs` with what Z3 adds:
 * - the visible band as published (`--iris-app-frame-height`) read back from
 *   the live page, not assumed;
 * - per-frame geometry against the band AND against the owning message row;
 * - in-frame scrollability, read inside each opaque-origin frame through an
 *   OOPIF child session (scrollHeight vs clientHeight, computed overflow-y,
 *   and a real scrollTop probe that proves the content is reachable);
 * - marginalia occlusion: rail rect ∩ frame rect plus elementFromPoint at the
 *   rail's own centre.
 * - height-echo sampling: frame heights sampled continuously, as Task U did.
 *
 * Usage: node qa/measure-z3-occlusion.mjs <baseline|fixed> [chatKey ...]
 *   chatKey: shibian | zhengjing | hanren
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8823/'
const DEBUG_PORT = Number(process.env.Z3_DEBUG_PORT ?? 9345)
const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'results')

const CHATS = {
  shibian: { chat: '尸变纪元-v0-20260903-194944', title: '尸变纪元 v0.5（NSFW）', card: '尸变纪元' },
  zhengjing: { chat: '新架空政治经济模拟器-20260905-061145', title: '新·架空政治经济模拟器', card: '政经博弈' },
  hanren: { chat: '哈人冰恋世界-20260903-194925', title: '哈人冰恋世界', card: '哈人冰恋' },
  /*
   * Fresh greetings: a new chat on the same card opens on its greeting floor,
   * which is where these cards mount their real screens (the aged chats end in
   * status-bar tails). This is the user's repro path: open card, read floor 0.
   */
  shibianFresh: { chat: '尸变纪元-v0-20260907-015809', title: '尸变纪元 v0.5（NSFW）', card: '尸变纪元' },
  zhengjingFresh: { chat: '新架空政治经济模拟器-20260907-015809', title: '新·架空政治经济模拟器', card: '政经博弈' },
  hanrenFresh: { chat: '哈人冰恋世界-20260907-015809', title: '哈人冰恋世界', card: '哈人冰恋' },
}

const tag = process.argv[2] === 'fixed' ? 'fixed' : 'baseline'
const keys = process.argv.slice(3).filter(a => CHATS[a] !== undefined)
const wanted = keys.length > 0 ? keys : ['shibian', 'zhengjing', 'hanren', 'shibianFresh', 'zhengjingFresh', 'hanrenFresh']

mkdirSync(OUT, { recursive: true })

const wsPath = new URL('../node_modules/.pnpm/ws@8.21.3/node_modules/ws/index.js', import.meta.url).href
const WebSocket = (await import(wsPath)).default ?? (await import(wsPath))

const profile = mkdtempSync(join(tmpdir(), 'iris-z3-chrome-'))
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
/** sessionId -> set of event names wanted (unused in filtering; events logged) */
const childSessions = new Set()
browser.on('message', raw => {
  const msg = JSON.parse(raw)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) {
    childSessions.add(msg.params.sessionId)
  }
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
// OOPIF frames attach as their own targets; flattened sessions arrive as events.
await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })

async function evaluate(expression, sessionId_) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails))
  return r.result.value
}

async function setViewport(width, height) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false })
  await sleep(400)
}

async function shot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'))
  console.log('shot:', name)
}

/**
 * Enumerate the page's interface frames together with their in-frame state.
 *
 * The main world reads geometry; each frame's own document is read through its
 * OOPIF child session, matched back to the owning slot by the frame owner's
 * `data-instance` attribute.
 */
async function measureFrames() {
  // 1. Main world: bring the first framed row to the top of the band, then read
  // slots, frames, rows, rails — and who catches a click inside the rail's box.
  const main = await evaluate(`(() => {
    const rect = el => el ? el.getBoundingClientRect().toJSON() : null
    const scroller = document.querySelector('.iris-scroll')
    const bandVar = scroller ? scroller.style.getPropertyValue('--iris-app-frame-height') : null
    const first = document.querySelector('.iris-interfaces__slot')
    if (first) {
      const row = first.closest('.iris-msg')
      if (row) row.scrollIntoView({ block: 'start' })
    }
    const slots = [...document.querySelectorAll('.iris-interfaces__slot')].map(slot => {
      const frame = slot.querySelector('iframe')
      // Marker for the CDP owner probe: getFrameOwner hands back the iframe,
      // and this is how the child session says which slot it belongs to.
      if (frame) frame.setAttribute('data-z3-instance', slot.dataset.instance)
      const row = slot.closest('.iris-msg')
      const margin = row ? row.querySelector('.iris-msg__margin') : null
      const rail = margin ? margin.querySelector('.iris-rail') : null
      // Who actually catches a click inside the rail's own box: the marginalia
      // (rail or its children), or the frame that overlaps it. Geometric
      // overlap is by design — the breakout reclaims the gutter — so paint and
      // hit-testing order is the question.
      const hit = el => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return null
        const points = [
          [r.x + r.width / 2, r.y + r.height / 2],
          [r.x + r.width / 2, r.y + 2],
          [r.x + r.width / 2, r.y + r.height - 2],
        ]
        return points.map(([x, y]) => {
          const top = document.elementFromPoint(x, y)
          if (top === null) return 'none'
          if (el.contains(top)) return 'rail:' + top.tagName.toLowerCase()
          if (top.tagName === 'IFRAME') return 'IFRAME'
          return top.tagName.toLowerCase() + '.' + String(top.className).split(' ')[0]
        })
      }
      return {
        instance: slot.dataset.instance,
        slotRect: rect(slot),
        hasFrame: !!frame,
        frameRect: rect(frame),
        inlineHeight: frame ? frame.style.height || null : null,
        cssHeight: frame ? getComputedStyle(frame).height : null,
        cssMaxHeight: frame ? getComputedStyle(frame).maxHeight : null,
        sizing: frame ? (frame.dataset.irisSizing ?? null) : null,
        rowRect: rect(row),
        railRect: rect(rail),
        railCount: rail ? rail.textContent.trim() : null,
        railHits: hit(rail),
        ordinalRect: row ? rect(row.querySelector('.iris-msg__floor')) : null,
        bandVar,
        scrollerTop: scroller ? scroller.getBoundingClientRect().top : null,
        band: scroller ? scroller.clientHeight : null,
      }
    })
    return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, slots }
  })()`)

  // 2. Child target sessions (OOPIF): the parent's frame tree does not list
  // opaque-origin frames, so walk the attached sessions themselves and map each
  // to its owning slot through the owner node's `data-instance`.
  const sessionByFrameId = new Map()
  for (const sid of childSessions) {
    try {
      const childTree = await send('Page.getFrameTree', {}, sid)
      sessionByFrameId.set(childTree.frameTree.frame.id, sid)
    } catch { /* gone or not a page target */ }
  }

  const frameStates = []
  for (const [frameId, childSession] of sessionByFrameId) {
    let ownerInstance = null
    try {
      const owner = await cdp('DOM.getFrameOwner', { frameId })
      const nodeId = owner?.nodeId ?? 0
      const backendNodeId = owner?.backendNodeId
      if (nodeId > 0 || backendNodeId !== undefined) {
        const desc = await cdp('DOM.describeNode', {
          ...(nodeId > 0 ? { nodeId } : { backendNodeId }),
          depth: 0,
        })
        const attrs = desc.node.attributes ?? []
        const at = attrs.indexOf('data-z3-instance')
        ownerInstance = at >= 0 ? attrs[at + 1] : null
      }
    } catch { /* a frame the shell does not own (none expected) */ }

    // A script frame (hidden, off-screen) has no slot instance; skip it.
    if (ownerInstance === null) continue

    const inner = await send('Runtime.evaluate', {
      expression: `(() => {
        const html = document.documentElement, body = document.body
        const overflowOf = el => el ? getComputedStyle(el).overflowY : null
        const before = body ? body.scrollTop : 0
        let scrolled = 0
        if (body) { body.scrollTop = 999999; scrolled = body.scrollTop; body.scrollTop = before }
        let docScrolled = 0
        const docBefore = html.scrollTop
        html.scrollTop = 999999; docScrolled = html.scrollTop; html.scrollTop = docBefore
        return {
          viewportW: html.clientWidth,
          viewportH: html.clientHeight,
          bodyScrollHeight: body ? body.scrollHeight : null,
          docScrollHeight: html.scrollHeight,
          bodyClientHeight: body ? body.clientHeight : null,
          htmlOverflowY: overflowOf(html),
          bodyOverflowY: overflowOf(body),
          bodyScrollTopMax: scrolled,
          docScrollTopMax: docScrolled,
          childBottom: body ? Math.max(0, ...[...body.children].map(c => c.getBoundingClientRect().bottom)) : 0,
          hasInterface: body ? body.hasAttribute('data-iris-interface') : false,
        }
      })()`,
      returnByValue: true,
    }, childSession).then(r => r.result?.value).catch(error => ({ error: String(error).slice(0, 120) }))
    frameStates.push({ instance: ownerInstance, inner })
  }

  return { main, frameStates }
}

const OSCILLATE_SAMPLE = `(() => {
  const frames = [...document.querySelectorAll('.iris-interfaces__slot iframe')]
  return frames.map(f => Math.round(f.getBoundingClientRect().height) + '|' + (f.style.height || 'css'))
})()`

await cdp('Page.navigate', { url: BASE })
for (let i = 0; i < 60; i++) {
  await sleep(500)
  const ready = await evaluate(`!!document.querySelector('.iris-stage') && !!document.querySelector('.iris-list')`).catch(() => false)
  if (ready) break
}

let rpcSeq = 0
async function rpc(method, params) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `z3-${++rpcSeq}`, method, params }),
  })
  return res.json()
}

/**
 * One chat per page load: a fresh navigate, then the row click. The page's own
 * openChat is the only thing that switches chats (a host-side `chat.open` does
 * not announce into this page's store), and reloading leaves the previous
 * chat's frames — and its main-thread cost — behind.
 */
async function openChat(spec) {
  await cdp('Page.navigate', { url: BASE })
  const start = Date.now()
  let listed = false
  while (Date.now() - start < 30_000) {
    listed = await evaluate(`!!document.querySelector('.iris-list .iris-row')`).catch(() => false)
    if (listed) break
    await sleep(500)
  }
  if (!listed) { console.error('list never rendered'); return false }

  let clicked = false
  let seen = '[]'
  for (let i = 0; i < 40 && !clicked; i++) {
    const r = await evaluate(`(() => {
      const wanted = ${JSON.stringify(spec.title)}
      const rows = [...document.querySelectorAll('.iris-list .iris-row')]
      const row = rows.find(el => (el.querySelector('.iris-row__title')?.textContent ?? '').trim() === wanted)
      if (row) {
        // Mark the exact row: two chats of one card share a title, so the
        // switch check below reads aria-current on THIS row, not any row.
        row.setAttribute('data-z3-target', '1')
        row.click()
        return 'clicked'
      }
      return JSON.stringify(rows.slice(0, 20).map(el => (el.querySelector('.iris-row__title')?.textContent ?? '').trim()))
    })()`).catch(e => 'eval-error: ' + e.message.slice(0, 80))
    if (r === 'clicked') { clicked = true; break }
    seen = typeof r === 'string' ? r : '[]'
    await sleep(500)
  }
  if (!clicked) { console.error(`row not found; titles seen: ${seen}`); return false }

  // The switch is done when the clicked row itself reads as current.
  while (Date.now() - start < 40_000) {
    const switched = await evaluate(
      `!!document.querySelector('.iris-composer__field') && document.querySelector('[data-z3-target="1"]')?.getAttribute('aria-current') === 'true'`,
    ).catch(() => false)
    if (switched) return true
    await sleep(500)
  }
  console.error(`page never switched to ${spec.chat}`)
  return false
}

async function waitForFrames(timeoutMs = 45_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const n = await evaluate(`document.querySelectorAll('.iris-interfaces__slot iframe').length`).catch(() => 0)
    if (n > 0) {
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
  const right = Math.min(a.x + a.width, b.x + a.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > left && bottom > top ? (right - left) * (bottom - top) : 0
}

function analyse(m) {
  const findings = { frames: [], occlusions: [], band: null }
  const bandHeight = m.slots[0]?.band ?? null
  findings.band = bandHeight
  for (const slot of m.slots) {
    if (!slot.frameRect) continue
    const frame = slot.frameRect
    const row = slot.rowRect
    const rail = slot.railRect
    // The scroller's visible box, so hit-tests are only judged where the rail
    // is actually on screen (a row scrolled out reads whatever is in view).
    const scrollerTop = slot.scrollerTop ?? 0
    const bandBottom = scrollerTop + (bandHeight ?? 0)
    const railVisible =
      rail !== null && rail.height > 0 &&
      rail.y >= scrollerTop - 1 && rail.y + rail.height <= bandBottom + 1
    const entry = {
      instance: slot.instance,
      frameHeight: Math.round(frame.height),
      inlineHeight: slot.inlineHeight,
      cssHeight: slot.cssHeight,
      cssMaxHeight: slot.cssMaxHeight,
      sizing: slot.sizing,
      bandHeight: bandHeight === null ? null : Math.round(bandHeight),
      tallerThanBand: bandHeight !== null && frame.height > bandHeight + 1,
      insideRow: row !== null && frame.y >= row.y - 1 && frame.y + frame.height <= row.y + row.height + 1,
      rowHeight: row === null ? null : Math.round(row.height),
    }
    // Occlusion: the rail's own box under the frame, and who paints there —
    // judged only when the rail is inside the visible band.
    if (rail !== null && rail.width > 0 && rail.height > 0) {
      entry.railArea = Math.round(rail.width * rail.height)
      entry.railUnderFrame = Math.round(intersect(frame, rail))
      entry.railHits = slot.railHits
      entry.railVisible = railVisible
      entry.railOccluded = railVisible && (slot.railHits ?? []).some(h => h === 'IFRAME')
    }
    findings.frames.push(entry)
  }
  return findings
}

const report = {}

for (const [W, H] of [[1920, 1080], [1366, 768]]) {
  await setViewport(W, H)
  for (const key of wanted) {
    const spec = CHATS[key]
    if (!spec) continue
    const opened = await openChat(spec)
    if (!opened) { console.error(`row for ${spec.chat} not found`); continue }
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      const up = await evaluate(`!!document.querySelector('.iris-composer__field')`).catch(() => false)
      if (up) break
    }
    await waitForFrames()
    const { main, frameStates } = await measureFrames()
    const a = analyse(main)

    // Echo check: sample frame heights every 250ms for 3.5s.
    const samples = []
    for (let i = 0; i < 14; i++) {
      samples.push(await evaluate(OSCILLATE_SAMPLE).catch(() => []))
      await sleep(250)
    }
    const distinct = [...new Set(samples.map(s => s.join(',')))]

    // Scroll reach: scroll the first frame's row to the top of the band.
    await evaluate(`(() => {
      const slot = document.querySelector('.iris-interfaces__slot')
      if (slot) slot.scrollIntoView({ block: 'start' })
    })()`)
    await sleep(400)
    await shot(`z3-${tag}-${key}-${W}x${H}.png`)

    report[`${key}@${W}x${H}`] = {
      main,
      frameStates,
      findings: a,
      oscillation: { distinctStates: distinct.length, states: distinct.slice(0, 4) },
    }
    console.log(`measured ${key}@${W}x${H}: frames=${a.frames.length} oscStates=${distinct.length}`)
  }
}

const outName = `z3-occlusion-${tag}-report.json`
writeFileSync(join(OUT, outName), JSON.stringify(report, null, 2))
console.log('report:', join(OUT, outName))

chrome.kill()
process.exit(0)
