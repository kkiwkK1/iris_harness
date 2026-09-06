/**
 * Task Z2 verification: message-frame geometry **and in-frame scrolling** over CDP.
 *
 * Extends `measure-frame-fit.mjs` (task U, frame size + occlusion) with the
 * half that task did not measure: what happens **inside** each clamped frame.
 * A frame can sit exactly at the band and still be a dead window — the reset
 * style's `overflow:hidden!important` swallows every scroll unless the frame's
 * own bootstrap turns `overflow-y` back on, and nothing outside an opaque
 * origin can see that. So this instrument rides CDP execution contexts into
 * each sandboxed frame and reads the scroll state from in there.
 *
 * Per card chat, per viewport:
 *   - page level: band height, each slot's frame rect / inline height / sizing,
 *     text-rect occlusion, composer midline, height oscillation over 3s;
 *   - frame level: inner viewport vs content height, computed overflow-y and
 *     overscroll-behavior on html/body, whether the document actually scrolls
 *     (scrollTop driven to both ends — content reachability), and a real
 *     `Input.dispatchMouseEvent` wheel over the frame to see which layer moves;
 *   - screenshots.
 *
 * Usage: node qa/measure-z2-scroll.mjs <baseline|fixed> [chatKey ...]
 *   chatKey: shibian | zhengjing | hanren
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = 'http://127.0.0.1:8822/'
const DEBUG_PORT = 9422
const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'results')

const CHATS = {
  // One-message chats: the greeting **is** the heavy interface, so every
  // measurement sees it without depending on how much of a long tail the
  // reading window mounted.
  shibian: { chat: '尸变纪元-v0-20260906-193237', title: '尸变纪元 v0.5（NSFW）', card: '尸变纪元' },
  zhengjing: { chat: '新架空政治经济模拟器-20260905-061145', title: '新·架空政治经济模拟器', card: '政经博弈' },
  hanren: { chat: '哈人冰恋世界-20260906-193236', title: '哈人冰恋世界', card: '哈人冰恋' },
  // The multi-message 政经博弈 chat: its reply carries a frame whose card pins
  // its own body, so `bodyScroll` read 100 against a 1069px range — the case
  // that forced the scroll decision off the honest extent.
  zhengjing2: { chat: '新架空政治经济模拟器-20260906-193237', title: '新·架空政治经济模拟器', card: '政经博弈' },
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
const eventHandlers = []
browser.on('message', raw => {
  const msg = JSON.parse(raw)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
  if (msg.method) for (const h of eventHandlers) h(msg)
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

// Child iframes arrive as their own targets; the handler above stashes them.
await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })

await cdp('Page.enable')
await cdp('Runtime.enable')

/*
 * Frame sessions: sandboxed srcdoc frames are cross-origin (opaque origin), so
 * Chrome splits them out as their own debuggee targets — they are **not**
 * children in the page's frame tree and their contexts never appear on the
 * page's session. `Target.setAutoAttach` hands us one session per iframe; the
 * interface frames identify themselves by `body[data-iris-interface]`.
 */
const innerSessions = new Map() // sessionId -> { probed: bool, isInterface: bool }
eventHandlers.push(msg => {
  if (msg.method !== 'Target.attachedToTarget') return
  const ti = msg.params.targetInfo
  if (ti.type !== 'iframe') return
  const sid = msg.params.sessionId
  innerSessions.set(sid, { probed: false, isInterface: false })
  void send('Runtime.enable', {}, sid).catch(() => innerSessions.delete(sid))
})

const INNER_PROBE = `(() => {
  try {
    if (!document.body || !document.body.hasAttribute('data-iris-interface')) return null
    const html = document.documentElement, body = document.body
    const cs = el => getComputedStyle(el)
    const range = document.createRange(); range.selectNodeContents(body)
    let childBottom = 0
    for (const el of body.querySelectorAll('*')) {
      const b = el.getBoundingClientRect().bottom
      if (b > childBottom) childBottom = b
    }
    return {
      viewport: html.clientHeight,
      bodyScroll: body.scrollHeight,
      docScroll: html.scrollHeight,
      rangeHeight: Math.round(range.getBoundingClientRect().height),
      childBottom: Math.round(childBottom),
      htmlOverflowY: cs(html).overflowY,
      bodyOverflowY: cs(body).overflowY,
      htmlOverscroll: cs(html).overscrollBehaviorY,
      bodyOverscroll: cs(body).overscrollBehaviorY,
      scrollingElement: document.scrollingElement === html ? 'html' : (document.scrollingElement === body ? 'body' : String(document.scrollingElement?.tagName ?? 'other')),
    }
  } catch (e) { return { error: String(e) } }
})()`

/** Read the scroll state of every live interface frame. Sessions carry the
 *  identity — a stale index into the session map silently measures the wrong
 *  frame, so each result comes home with its own session id. */
async function interfaceFrames() {
  const found = []
  for (const [sid] of innerSessions) {
    let value = null
    for (let i = 0; i < 6 && value === null; i++) {
      const r = await send('Runtime.evaluate', {
        expression: INNER_PROBE, returnByValue: true,
      }, sid).catch(() => undefined)
      if (r === undefined) break // session is dead — its frame was disposed
      value = r?.result?.value ?? null
      if (value === null) await sleep(400) // frame still parsing; try again
    }
    if (value) found.push({ sid, ...value })
  }
  return found
}

/** Read one interface frame's document scroll position, without moving it. */
async function readFrameScroll(sid) {
  if (sid === undefined) return null
  const r = await send('Runtime.evaluate', {
    expression: `document.scrollingElement.scrollTop`,
    returnByValue: true,
  }, sid).catch(() => undefined)
  return r === undefined ? null : (r?.result?.value ?? null)
}

/** Drive one interface frame's document scroller, by the session that owns it. */
async function driveFrameScroll(sid, top) {
  if (sid === undefined) return null
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.scrollingElement
      if (!el) return null
      el.scrollTop = ${top}
      return { requested: ${top}, got: el.scrollTop, max: el.scrollHeight - el.clientHeight }
    })()`,
    returnByValue: true,
  }, sid).catch(() => undefined)
  return r?.result?.value ?? null
}

async function evaluate(expression) {
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

let rpcSeq = 0
async function rpc(method, params) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `z2-${++rpcSeq}`, method, params }),
  })
  return res.json()
}

// The page-level geometry probe (task U's, minus nothing).
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
      stateLine: slot.querySelector('.iris-interfaces__state')?.textContent ?? null,
      overLine: slot.querySelector('.iris-interfaces__over') ? (slot.querySelector('.iris-interfaces__over')?.textContent ?? '') : null,
    }
  })
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
  const overlayFrames = overlay
    ? [...overlay.querySelectorAll('iframe')].map(f => f.getBoundingClientRect().toJSON())
    : []
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

/*
 * Frame churn: watch the interface slots for 15s and report every iframe that
 * is added or removed. A frame that is rebuilt after its height report lands
 * comes back at the 60vh starting height with nothing applied — which no
 * snapshot of a single moment can tell from a frame that never reported.
 */
const CHURN_WATCH = `(() => new Promise(resolve => {
  const slots = document.querySelector('.iris-column')
  const added = []
  const removed = []
  const mark = el => el.tagName === 'IFRAME'
    ? 'iframe@slot' + (el.closest('.iris-interfaces__slot')?.dataset.instance ?? '?')
    : el.tagName
  const mo = new MutationObserver(records => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeType === 1) added.push(mark(n))
      for (const n of r.removedNodes) if (n.nodeType === 1) removed.push(mark(n))
    }
  })
  mo.observe(slots ?? document.body, { childList: true, subtree: true })
  setTimeout(() => {
    mo.disconnect()
    const frames = [...document.querySelectorAll('.iris-interfaces__slot iframe')]
    resolve({
      added: added.filter(a => a.startsWith('iframe')),
      removed: removed.filter(a => a.startsWith('iframe')),
      finalHeights: frames.map(f => f.getBoundingClientRect().height + '|' + (f.style.height || 'css')),
      finalCount: frames.length,
    })
  }, 15000)
}))()`

await cdp('Page.navigate', { url: BASE })
for (let i = 0; i < 60; i++) {
  await sleep(500)
  const ready = await evaluate(`!!document.querySelector('.iris-stage') && !!document.querySelector('.iris-list')`).catch(() => false)
  if (ready) break
}

async function openChat(spec) {
  /*
   * Disambiguate by chat, not by title: several chats share a card's title,
   * and the sidebar sorts by recency — **including the row the last click
   * moved to the top**, so the ordinal is recomputed on every attempt.
   */
  const start = Date.now()
  while (Date.now() - start < 20_000) {
    const listed = await rpc('chat.list', {})
    const sameTitle = (listed.result?.chats ?? [])
      .filter(c => c.title === spec.title)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const ordinal = sameTitle.findIndex(c => c.chatId === spec.chat)
    if (ordinal === -1) { console.error(`chat ${spec.chat} not in chat.list`); return false }
    const clicked = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.iris-list .iris-row')]
      const mine = rows.filter(r => (r.querySelector('.iris-row__title')?.textContent ?? '').trim() === ${JSON.stringify(spec.title)})
      const row = mine[${ordinal}]
      if (row) { row.click(); return true }
      return false
    })()`)
    if (clicked) {
      // The composer says a chat is open. The mounted-row count is only an
      // *information* check, not a fingerprint: the host's messageCount counts
      // floors the reading view may mount differently (is_system rows, the
      // window tail), so a mismatch here is a hint, not a failure — the
      // ordinal above is what picked the chat.
      await sleep(1_000)
      const rows = await evaluate(`document.querySelectorAll('.iris-msg').length`).catch(() => -1)
      if (rows !== -1 && rows !== sameTitle[ordinal].messageCount) {
        console.error(`note: ${String(rows)} rows mounted vs ${String(sameTitle[ordinal].messageCount)} counted for ${spec.chat}`)
      }
      return true
    }
    await sleep(800)
  }
  return false
}

async function waitForFrames(timeoutMs = 45_000) {
  const start = Date.now()
  let sawAny = false
  while (Date.now() - start < timeoutMs) {
    const n = await evaluate(`document.querySelectorAll('.iris-interfaces__slot iframe').length`).catch(() => 0)
    if (n > 0) {
      if (!sawAny) { sawAny = true; await sleep(3_000) }
      // Settled means every visible frame has said *something* about its height
      // — an inline height from its report, or a sizing mark. A heavy card's
      // frames do not all finish at once; measuring mid-boot reads the 60vh
      // starting height and calls it a fault.
      const settled = await evaluate(`[...document.querySelectorAll('.iris-interfaces__slot iframe')]
        .every(f => (f.style.height && f.style.height !== '') || f.dataset.irisSizing !== undefined)`)
        .catch(() => false)
      if (settled) return true
    }
    await sleep(500)
  }
  return sawAny
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
    for (const t of m.textRects) {
      const area = intersect(frame, t.rect)
      if (area > 40) {
        findings.occlusions.push({
          kind: 'frame-over-text',
          instance: slot.instance,
          textTag: t.tag,
          area: Math.round(area),
        })
      }
    }
  }
  if (m.overlayVisible) {
    for (const of_ of m.overlayFrames) {
      for (const t of m.textRects) {
        const area = intersect(of_, t.rect)
        if (area > 400) {
          findings.occlusions.push({
            kind: 'overlay-frame-over-text',
            area: Math.round(area),
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
    // Fresh frame sessions per chat: this chat's frames attach after the old
    // chat's die, and a session kept across the switch measures a ghost.
    innerSessions.clear()
    const opened = await openChat(spec)
    if (!opened) { console.error(`row for ${spec.title} not found`); continue }
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      const up = await evaluate(`!!document.querySelector('.iris-composer__field')`).catch(() => false)
      if (up) break
    }
    await waitForFrames()

    const m = await evaluate(MEASURE)
    const a = analyse(m)

    // Bring the first frame fully into the band so wheel hits land on it.
    await evaluate(`(() => {
      const slot = document.querySelector('.iris-interfaces__slot')
      if (slot) slot.scrollIntoView({ block: 'start' })
    })()`)
    await sleep(400)

    // In-frame scroll state, straight from each frame's own realm.
    const inner = await interfaceFrames()
    const scrollChecks = []
    for (const f of inner) {
      if (f.error) { scrollChecks.push(f); continue }
      const end = await driveFrameScroll(f.sid, 10_000_000)
      const top = await driveFrameScroll(f.sid, 0)
      const contentTop = await evaluate(`(() => {
        const s = document.querySelector('.iris-scroll')
        return s ? { scrollTop: s.scrollTop } : null
      })()`)
      scrollChecks.push({
        viewport: f.viewport,
        bodyScroll: f.bodyScroll,
        docScroll: f.docScroll,
        rangeHeight: f.rangeHeight,
        childBottom: f.childBottom,
        htmlOverflowY: f.htmlOverflowY,
        bodyOverflowY: f.bodyOverflowY,
        htmlOverscroll: f.htmlOverscroll,
        bodyOverscroll: f.bodyOverscroll,
        scrollingElement: f.scrollingElement,
        scrollable: end !== null && end.max > 2,
        maxScroll: end?.max ?? null,
        reachedEnd: end !== null && end.max > 2 && end.got >= end.max - 2,
        reachedTop: top !== null && top.got <= 2,
        pageScrollTopAfterFrameScroll: contentTop?.scrollTop ?? null,
      })
    }

    // Real wheel over the tallest visible frame, from the frame's top: the
    // frame should scroll and the page should not. Then park the frame at its
    // end and wheel again — if the scroll chains, the page moves (the fault
    // "滚动带动页面"). The wheel point is read AFTER the scrollIntoView and the
    // page is left where the reader left it, so the coordinates cannot go stale.
    const visible = await evaluate(`(() => {
      const scroller = document.querySelector('.iris-scroll')
      const bandTop = scroller ? scroller.getBoundingClientRect().top : 0
      const bandBottom = window.innerHeight
      let best = null
      for (const frame of document.querySelectorAll('.iris-interfaces__slot iframe')) {
        const r = frame.getBoundingClientRect()
        const top = Math.max(r.top, bandTop)
        const bottom = Math.min(r.bottom, bandBottom)
        if (bottom - top < 80) continue
        const area = r.width * (bottom - top)
        if (best === null || area > best.area) {
          best = {
            area,
            cssHeight: Math.round(frame.getBoundingClientRect().height),
            x: Math.round(r.x + r.width / 2),
            y: Math.round(Math.max(r.top, bandTop) + Math.min((bottom - top) / 2, 220)),
          }
        }
      }
      return best
    })()`)
    let wheel = null
    if (visible && inner.length > 0) {
      // Match the session to the on-screen frame by viewport height; fall back
      // to the first session when heights collide.
      let target = inner[0]
      for (const f of inner) {
        if (f.viewport === visible.cssHeight) { target = f; break }
      }
      const pageBefore = await evaluate(`document.querySelector('.iris-scroll')?.scrollTop ?? null`)
      await driveFrameScroll(target.sid, 0)
      await sleep(200)
      for (let i = 0; i < 6; i++) {
        await cdp('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: visible.x, y: visible.y, deltaX: 0, deltaY: 120,
        })
        await sleep(60)
      }
      await sleep(300)
      const afterTopWheel = await evaluate(`(() => {
        const s = document.querySelector('.iris-scroll')
        return { pageScrollTop: s ? s.scrollTop : null }
      })()`)
      const frameTopScroll = await readFrameScroll(target.sid)
      // Frame at its end, wheel again.
      await driveFrameScroll(target.sid, 10_000_000)
      await sleep(200)
      for (let i = 0; i < 6; i++) {
        await cdp('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: visible.x, y: visible.y, deltaX: 0, deltaY: 120,
        })
        await sleep(60)
      }
      await sleep(300)
      const afterEndWheel = await evaluate(`(() => {
        const s = document.querySelector('.iris-scroll')
        return { pageScrollTop: s ? s.scrollTop : null }
      })()`)
      const frameEndScroll = await readFrameScroll(target.sid)
      // Mid-frame wheel: parked at half its range, the wheel should move the
      // frame itself. Distinguishes "the wheel cannot enter the frame" from
      // "the card's own edge handlers trap the wheel at the top".
      let frameScrollAfterMidWheel = null
      const maxScroll = await send('Runtime.evaluate', {
        expression: `document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight`,
        returnByValue: true,
      }, target.sid).catch(() => undefined)
      if (maxScroll !== undefined && Number(maxScroll?.result?.value) > 40) {
        await driveFrameScroll(target.sid, Math.floor(Number(maxScroll.result.value) / 2))
        await sleep(200)
        for (let i = 0; i < 6; i++) {
          await cdp('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: visible.x, y: visible.y, deltaX: 0, deltaY: 120,
          })
          await sleep(60)
        }
        await sleep(400)
        frameScrollAfterMidWheel = await readFrameScroll(target.sid)
      }
      wheel = {
        frameViewport: target.viewport,
        pageBefore,
        frameScrollAfterTopWheel: frameTopScroll,
        pageAfterTopWheel: afterTopWheel.pageScrollTop,
        pageMovedOnTopWheel:
          pageBefore !== null && afterTopWheel.pageScrollTop !== null
          && Math.abs(afterTopWheel.pageScrollTop - pageBefore) > 1,
        frameScrollAfterEndWheel: frameEndScroll,
        pageAfterEndWheel: afterEndWheel.pageScrollTop,
        pageMovedOnEndWheel:
          pageBefore !== null && afterEndWheel.pageScrollTop !== null
          && Math.abs(afterEndWheel.pageScrollTop - pageBefore) > 1,
        frameScrollAfterMidWheel,
      }
    }

    // Frame churn over 15s: is a frame being rebuilt after settling?
    const churn = await evaluate(CHURN_WATCH).catch(e => ({ error: String(e) }))

    // Oscillation: sample frame heights every 250ms for 3s.
    const samples = []
    for (let i = 0; i < 12; i++) {
      samples.push(await evaluate(OSCILLATE_SAMPLE))
      await sleep(250)
    }
    const flat = samples.map(s => s.join(','))
    const distinct = [...new Set(flat)]

    await shot(`z2-${tag}-${key}-${W}x${H}.png`)

    report[`${key}@${W}x${H}`] = {
      chat: spec.chat,
      measure: m,
      findings: a,
      inner,
      scrollChecks,
      wheel,
      churn,
      oscillation: { distinctStates: distinct.length, states: distinct.slice(0, 4) },
    }
    console.log(
      `measured ${key}@${W}x${H}: frames=${a.frames.length}`
      + ` innerScrollable=[${scrollChecks.filter(c => c.scrollable).length}/${scrollChecks.length}]`
      + ` wheel=${wheel ? JSON.stringify(wheel) : 'n/a'}`
      + ` oscStates=${distinct.length}`
      + ` churn=${churn && !churn.error ? `${churn.added.length}+/${churn.removed.length}-` : 'n/a'}`,
    )
  }
}

const outName = `z2-scroll-${tag}-report.json`
writeFileSync(join(OUT, outName), JSON.stringify(report, null, 2))
console.log('report:', join(OUT, outName))

chrome.kill()
process.exit(0)
