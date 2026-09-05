/**
 * Task T verification: real wide-viewport geometry check over CDP.
 *
 * Opens the built interface in headless Chrome at 1920x1080 and 2400x1200,
 * walks the four states from the task book, screenshots each, and measures
 * the sheet's centring with getBoundingClientRect.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = 'http://127.0.0.1:8816/'
const DEBUG_PORT = 9333

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

// Wait for the debugger endpoint.
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

// --- seed: a card and an open conversation, so the composer and the STATE
// margin actually render. Done over the same RPC the page uses.
let id = 0
async function rpc(method, params) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `seed-${++id}`, method, params }),
  })
  return res.json()
}
{
  const list = await rpc('character.list', {})
  let characterId = list.ok === false ? undefined : (list.result.characters[0]?.characterId ?? list.result.characters[0]?.id)
  if (characterId === undefined) {
    const card = await import('node:fs').then(fs =>
      fs.readdirSync('D:/workspace/小项目/iris_分支/测试用卡').filter(f => /\.(png|json)$/i.test(f)))
    const file = card[0]
    const content = (await import('node:fs')).readFileSync(`D:/workspace/小项目/iris_分支/测试用卡/${file}`).toString('base64')
    const imported = await rpc('character.import', { filename: file, content })
    if (imported.ok === false) throw new Error('card import failed: ' + JSON.stringify(imported.error))
    characterId = imported.result.character.characterId ?? imported.result.character.id
  }
  const chats = await rpc('chat.list', {})
  let chatId = chats.ok === false ? undefined : chats.result.chats[0]?.chatId
  if (chatId === undefined) {
    const created = await rpc('chat.create', { characterId })
    if (created.ok === false) throw new Error('chat create failed: ' + JSON.stringify(created.error))
    chatId = created.result.view.chatId
  }
  globalThis.__seededChatId = chatId
  console.log('seeded chat:', chatId)
}

async function setViewport(width, height) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false })
  await sleep(250)
}

async function shot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(name, Buffer.from(data, 'base64'))
  console.log('shot:', name)
}

// The four measured states. Everything below is plain geometry read off the
// live layout — no screenshots involved in the numbers.
const MEASURE = `(() => {
  const rect = sel => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect().toJSON() : null }
  const q = sel => !!document.querySelector(sel)
  const asideDisplay = (() => {
    const el = document.querySelector('.iris-aside')
    return el ? getComputedStyle(el).display : 'absent'
  })()
  // The reading surface's prose column and the composer field, for the midline check.
  const prose = document.querySelector('.iris-turn, .iris-empty, .iris-column')?.getBoundingClientRect().toJSON() ?? null
  const field = rect('.iris-composer__field')
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    sidebar: rect('.iris-sidebar'),
    main: rect('.iris-main'),
    sheet: rect('.iris-sheet'),
    aside: rect('.iris-aside'),
    asideInner: rect('.iris-aside__inner'),
    drawer: rect('.iris-drawer'),
    drawerOpen: q('.iris-drawer--open'),
    asideDisplay,
    prose,
    field,
    scrollbarGutter: getComputedStyle(document.querySelector('.iris-scroll') ?? document.body).scrollbarGutter,
  }
})()`

await cdp('Page.navigate', { url: BASE })
// Wait for the app to mount and connect.
for (let i = 0; i < 60; i++) {
  await sleep(500)
  const ready = await evaluate(`!!document.querySelector('.iris-stage') && !!document.querySelector('.iris-list')`).catch(() => false)
  if (ready) break
}
// Open the seeded conversation, so the composer and the STATE margin render.
await evaluate(`(() => {
  const row = document.querySelector('.iris-list .iris-row')
  if (row) row.click()
})()`)
for (let i = 0; i < 40; i++) {
  await sleep(500)
  const ready = await evaluate(`!!document.querySelector('.iris-composer__field') && !!document.querySelector('.iris-aside')`).catch(() => false)
  if (ready) break
}
const asideUp = await evaluate(`!!document.querySelector('.iris-aside')`)
if (!asideUp) { console.error('the STATE aside never rendered — cannot verify'); process.exit(1) }

const openDrawer = async () => {
  await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.iris-masthead button')]
    const last = buttons[buttons.length - 1]
    last.click()
  })()`)
  for (let i = 0; i < 20; i++) {
    await sleep(100)
    if (await evaluate(`!!document.querySelector('.iris-drawer--open')`)) break
  }
  await sleep(300) // let the slide-in settle
}
const closeDrawer = async () => {
  await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.iris-drawer__head button')]
    buttons[buttons.length - 1]?.click()
  })()`)
  for (let i = 0; i < 20; i++) {
    await sleep(100)
    if (!(await evaluate(`!!document.querySelector('.iris-drawer--open')`))) break
  }
  await sleep(300)
  if (await evaluate(`!!document.querySelector('.iris-drawer--open')`)) throw new Error('drawer refused to close')
}

const report = []
function centre(r) { return r.left + r.width / 2 }

for (const [W, H] of [[1920, 1080], [2400, 1200]]) {
  await setViewport(W, H)

  // State 1: drawer closed, STATE panel on.
  const a = await evaluate(MEASURE)
  const visibleRight = a.innerWidth
  const segCenterA = (a.sidebar.right + visibleRight) / 2
  const devClosed = Math.abs(centre(a.sheet) - segCenterA)
  await shot(`t-state1-drawer-closed-${W}x${H}.png`)

  // Midline: reading surface vs composer field (scrollbar-gutter regression check).
  const midlineDev = Math.abs(centre(a.prose) - centre(a.field))

  // State 2: drawer open — the sheet must re-centre between sidebar and drawer edge.
  await openDrawer()
  const b = await evaluate(MEASURE)
  const visibleOpenRight = b.drawer.left
  const segCenterB = (b.sidebar.right + visibleOpenRight) / 2
  const devOpen = Math.abs(centre(b.sheet) - segCenterB)
  const leftDeskOpen = b.sheet.left - b.sidebar.right
  await shot(`t-state2-drawer-open-${W}x${H}.png`)
  await closeDrawer()

  report.push({
    viewport: `${W}x${H}`,
    closed: {
      sheet: a.sheet, aside: a.aside, asideInner: a.asideInner,
      segmentCenter: segCenterA, sheetCenter: centre(a.sheet), deviation: devClosed,
      gapSheetToAside: a.asideInner ? a.asideInner.left - a.sheet.right : null,
      asideBreathingToEdge: a.asideInner ? visibleRight - a.asideInner.right : null,
      proseMidline: centre(a.prose), fieldMidline: centre(a.field), midlineDev,
      scrollbarGutter: a.scrollbarGutter,
    },
    open: {
      sheet: b.sheet, drawer: b.drawer, asideDisplay: b.asideDisplay,
      segmentCenter: segCenterB, sheetCenter: centre(b.sheet), deviation: devOpen,
      leftDeskOpen,
    },
  })
}

// State 3: narrow window — zero regression: aside hidden, sheet fills the main pane.
await setViewport(1280, 800)
const n = await evaluate(MEASURE)
await shot('t-state3-narrow-1280x800.png')
await openDrawer()
const nd = await evaluate(MEASURE)
await shot('t-state3b-narrow-drawer-open-1280x800.png')
report.push({
  viewport: '1280x800',
  narrow: {
    asideDisplay: n.asideDisplay,
    sheetFillsMain: Math.abs(n.sheet.left - n.main.left) < 1 && Math.abs(n.main.right - n.sheet.right) < 1,
    sheet: n.sheet, main: n.main,
  },
  narrowDrawerOpen: {
    drawerOpen: nd.drawerOpen,
    drawerWidth: nd.drawer ? nd.drawer.width : null,
    sheetUnchanged: Math.abs(nd.sheet.left - n.sheet.left) < 1 && Math.abs(nd.sheet.width - n.sheet.width) < 1,
  },
})

console.log(JSON.stringify(report, null, 2))

const fails = []
for (const row of report) {
  if (row.closed && row.closed.deviation >= 8) fails.push(`${row.viewport} closed deviation ${row.closed.deviation}`)
  if (row.open && row.open.deviation >= 8) fails.push(`${row.viewport} open deviation ${row.open.deviation}`)
  if (row.closed && row.closed.midlineDev >= 8) fails.push(`${row.viewport} midline deviation ${row.closed.midlineDev}`)
  if (row.narrow && !row.narrow.sheetFillsMain) fails.push(`${row.viewport} narrow sheet does not fill main`)
  if (row.narrowDrawerOpen && !row.narrowDrawerOpen.drawerOpen) fails.push('narrow drawer did not open')
  if (row.narrowDrawerOpen && !row.narrowDrawerOpen.sheetUnchanged) fails.push('narrow: drawer changed the sheet layout (regression)')
}
console.log(fails.length ? 'FAIL:\n' + fails.join('\n') : 'ALL CHECKS PASS')

browser.close()
chrome.kill()
process.exit(fails.length ? 1 : 0)
