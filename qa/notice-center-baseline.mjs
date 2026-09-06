/**
 * dev/fix-notice-center acceptance: notice panel visibility + composer midline.
 *
 * Headless Chrome over CDP against the built interface on 127.0.0.1:8824.
 *
 * Scenario cards (imported by qa/notice-probe.mjs):
 *  - NoticeProbe: two failing scripts + an interface frame that faults in its
 *    markup — the interface-channel case the user measured as "the panel is
 *    empty";
 *  - NoticeProbeMerge: exactly one throwing script — re-opening its chat three
 *    times raises the same fault three times, consecutively, with a fresh blob
 *    address per run — the dedup case (must read as one row with x3);
 *  - NoticeSilent: raises nothing, so switching through it keeps the merge
 *    card's errors consecutive.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = 'http://127.0.0.1:8824/'
const DEBUG_PORT = 9341
const OUT_DIR = 'D:/workspace/小项目/iris_分支/wt-notice-center/qa/shots-notice-center'

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
  writeFileSync(join(OUT_DIR, name), Buffer.from(data, 'base64'))
  console.log('shot:', name)
}

/** Read the notice section's rows. */
const READ = `(() => {
  const rows = [...document.querySelectorAll('.iris-notices__list li')].map(li => ({
    text: li.querySelector('.iris-reports__message')?.textContent ?? '',
    times: li.querySelector('.iris-notices__times')?.textContent ?? '',
    healed: !!li.querySelector('.iris-notices__healed'),
    fault: li.className.includes('iris-script__report--fault'),
  }))
  return {
    rows,
    emptyNote: document.querySelector('.iris-notices .iris-field__note')?.textContent ?? null,
    count: rows.length,
  }
})()`

const openDrawer = async () => {
  await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.iris-masthead button')]
    buttons[buttons.length - 1].click()
  })()`)
  for (let i = 0; i < 20; i++) {
    await sleep(100)
    if (await evaluate(`!!document.querySelector('.iris-drawer--open')`)) break
  }
  await sleep(300)
}

const closeDrawer = async () => {
  await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.iris-drawer__head button')]
    buttons[buttons.length - 1]?.click()
  })()`)
  await sleep(400)
}

const openChat = async name => {
  const hit = await evaluate(`(() => {
    // The row's title element holds the chat's name and nothing else; matching
    // the row's whole text would catch the meta line and never compare equal.
    const rows = [...document.querySelectorAll('.iris-list .iris-row')]
    const row = rows.find(r => {
      const title = r.querySelector('.iris-row__title')?.textContent?.trim()
      return title === ${JSON.stringify(name)}
    })
    if (row) row.click()
    return !!row
  })()`)
  if (!hit) return false
  for (let i = 0; i < 30; i++) {
    await sleep(400)
    if (await evaluate(`!!document.querySelector('.iris-composer__field')`)) return true
  }
  return false
}

/** Scroll the notice section to the top of the drawer body, for the shot. */
const showNotices = async () => {
  await evaluate(`(() => {
    document.querySelector('.iris-notices')?.scrollIntoView({ block: 'start' })
  })()`)
  await sleep(300)
}

// --- run ---------------------------------------------------------------
const report = { notice: {}, geometry: {} }

await cdp('Page.navigate', { url: BASE })
for (let i = 0; i < 60; i++) {
  await sleep(500)
  const ready = await evaluate(`!!document.querySelector('.iris-stage') && !!document.querySelector('.iris-list')`).catch(() => false)
  if (ready) break
}

// 1. Fresh boot, no chat open: the panel must be clean.
await openDrawer()
report.notice.freshBoot = await evaluate(READ)
await closeDrawer()

// 2. The interface-channel case: one open of the full probe card.
report.notice.openedProbe = await openChat('NoticeProbe')
await sleep(4000)
await openDrawer()
report.notice.afterOneOpen = await evaluate(READ)
await shot('notice-after-first-open.png')
await closeDrawer()

// 3. The dedup case: three consecutive faults of the merge card. The switch
// partner raises nothing, so the three faults stay neighbours in the log.
report.notice.openedMerge = await openChat('NoticeProbeMerge')
await sleep(2500)
for (let round = 2; round <= 3; round++) {
  report.notice[`silent${round}`] = await openChat('NoticeSilent')
  await sleep(1200)
  report.notice[`mergeBack${round}`] = await openChat('NoticeProbeMerge')
  await sleep(2500)
  console.log(`merge round ${round} done`)
}
await openDrawer()
report.notice.afterThreeOpens = await evaluate(READ)
await showNotices()
await shot('notice-after-three-opens.png')
await closeDrawer()

// 4. Geometry, both named viewports plus a narrow window.
const GEOM = `(() => {
  const centre = r => r.left + r.width / 2
  const q = sel => document.querySelector(sel)
  const msgs = [...document.querySelectorAll('.iris-msg')]
  const last = msgs[msgs.length - 1]
  const prose = last?.querySelector('.iris-msg__body, .iris-msg > :nth-child(2)')
  const column = q('.iris-column')
  const field = q('.iris-composer__field')
  const inner = q('.iris-composer__inner')
  const scroller = q('.iris-scroll')
  const rect = el => el ? el.getBoundingClientRect().toJSON() : null
  return {
    msgs: msgs.length,
    proseCentre: prose ? centre(rect(prose)) : null,
    columnCentre: column ? centre(rect(column)) : null,
    fieldCentre: field ? centre(rect(field)) : null,
    innerCentre: inner ? centre(rect(inner)) : null,
    lane: scroller ? scroller.getBoundingClientRect().width - scroller.clientWidth : null,
    fieldWidth: rect(field)?.width ?? null,
    gutter: scroller ? getComputedStyle(scroller).scrollbarGutter : null,
  }
})()`

for (const [W, H] of [[1920, 1080], [1366, 768], [800, 700]]) {
  await setViewport(W, H)
  const g = await evaluate(GEOM)
  g.deviation_prose_vs_field = (g.proseCentre !== null && g.fieldCentre !== null)
    ? +(g.proseCentre - g.fieldCentre).toFixed(2)
    : null
  report.geometry[`${W}x${H}`] = g
  await shot(`geometry-${W}x${H}.png`)
}

console.log(JSON.stringify(report, null, 2))
writeFileSync(join(OUT_DIR, 'acceptance-report.json'), JSON.stringify(report, null, 2))

chrome.kill()
process.exit(0)
