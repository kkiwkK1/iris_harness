/**
 * Task X verification, problem 1: the 尸变纪元 SYSTEM_START click chain.
 *
 * Seeds the real card, appends floors AFTER the greeting (so turn 0 is not the
 * last turn — the exact shape that used to make `script.swipeTo` refuse the
 * card's `setChatMessages([{ message_id: 0, swipe_id: 1 }])`), opens the chat
 * in headless Chrome, clicks the card's own button inside its interface frame,
 * and asserts floor 0 switched to the swipe the button addresses.
 *
 * Also re-checks the drawer overlay invariants on a page with real content:
 * scroll position and sheet rect must not move when the drawer opens/closes.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const CHROME = process.env.IRIS_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8825/'
// `CDP_PORT` is the name the other QA scripts use; `CHROME_DEBUG_PORT` still
// answers so an existing invocation of this one keeps working.
const DEBUG_PORT = Number(process.env.CDP_PORT ?? process.env.CHROME_DEBUG_PORT ?? 9338)
const CORPUS = process.env.IRIS_CORPUS ?? 'D:/workspace/小项目/iris_分支/测试用卡'
const CARD = `${CORPUS}/v0.5NSFW.png`

const require = createRequire(import.meta.url)
const wsPath = new URL('../node_modules/.pnpm/ws@8.21.3/node_modules/ws/index.js', import.meta.url).href
const WebSocket = (await import(wsPath)).default ?? (await import(wsPath))

// --- seed over the same RPC the page uses ------------------------------------

let seedSeq = 0
async function rpc(method, params) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `x-${++seedSeq}`, method, params }),
  })
  return res.json()
}
function assertOk(frame, what) {
  if (frame.ok === false) throw new Error(`${what} failed: ${JSON.stringify(frame.error)}`)
  return frame.result
}

const roster = assertOk(await rpc('character.list', {}), 'character.list').characters
let characterId = roster.find(c => (c.name ?? '').includes('尸变'))?.characterId
if (characterId === undefined) {
  const imported = assertOk(await rpc('character.import', {
    filename: 'v0.5NSFW.png',
    content: readFileSync(CARD).toString('base64'),
  }), 'character.import')
  characterId = imported.character.characterId ?? imported.character.id
}
console.log('character:', characterId)

const chat = assertOk(await rpc('chat.create', { characterId }), 'chat.create').view
console.log('chat:', chat.chatId)

// Floors after the greeting: this is what made the old swipe arm refuse —
// turn 0 was no longer the last turn.
const append = await rpc('script.createChatMessages', {
  chatId: chat.chatId,
  messages: [
    { name: '测试者', is_user: true, mes: '（用户已经聊过一句）' },
    { name: '尸变纪元', is_user: false, mes: '（后续楼层的回复）' },
  ],
})
assertOk(append, 'script.createChatMessages')

const before = assertOk(await rpc('chat.export', { chatId: chat.chatId }), 'chat.export')
const beforeLines = (before.content ?? '')
  .split('\n').filter(line => line.trim() !== '').slice(1) // line 0 is the header
  .map(line => JSON.parse(line))
console.log('floors before click:', beforeLines.length,
  '| floor0 swipe count:', beforeLines[0]?.swipes?.length,
  '| floor0 head:', JSON.stringify((beforeLines[0]?.mes ?? '').slice(0, 12)))
if (beforeLines.length !== 3) throw new Error(`expected 3 floors after seeding, got ${beforeLines.length}`)

// --- headless Chrome ----------------------------------------------------------

const profile = mkdtempSync(join(tmpdir(), 'iris-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1920,1080', 'about:blank',
], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let version = null
for (let i = 0; i < 50 && !version; i++) {
  await sleep(200)
  try { version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json() } catch { /* not up yet */ }
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

// Execution contexts of every frame, so we can reach into the sandboxed
// interface frame where the card's markup (and its button) lives. The interface
// frames are sandbox iframes (opaque origin → out-of-process), so each one is
// its own CDP target: auto-attach BEFORE navigating, then evaluate in the child
// sessions — the page session never sees their contexts.
const frameSessions = new Set()
browser.on('message', raw => {
  const msg = JSON.parse(raw)
  if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'iframe') {
    frameSessions.add(msg.params.sessionId)
  }
})
await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
async function evaluateIn(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) throw new Error('frame eval failed: ' + JSON.stringify(r.exceptionDetails))
  return r.result.value
}
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails))
  return r.result.value
}

await cdp('Page.navigate', { url: BASE })
for (let i = 0; i < 60; i++) {
  await sleep(500)
  if (await evaluate(`!!document.querySelector('.iris-stage') && !!document.querySelector('.iris-list')`).catch(() => false)) break
}

// Open the seeded chat: pick the row whose title names the card.
const opened = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.iris-list .iris-row')]
  const row = rows.find(r => r.textContent.includes('尸变纪元')) ?? rows[0]
  row.click()
  return { rows: rows.length, picked: row.textContent.slice(0, 40) }
})()`)
console.log('opened row:', JSON.stringify(opened))
// The card ships scripts, so the consent gate holds the message frames back:
// answer it the way a reader does (运行它们). The banner needs a moment to
// render after the chat opens — but the answer is remembered per profile, so a
// re-run on a host that already granted sees no banner at all. Both are fine:
// poll briefly, click if it shows up, carry on if it does not.
const consent = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('.iris-grant__actions button')]
  const run = buttons.find(b => b.textContent.includes('运行') && !b.textContent.includes('不'))
    ?? buttons[0]
  run?.click()
  return run?.textContent ?? null
})()`)
for (let i = 0; i < 12 && consent === null; i++) {
  await sleep(250)
  const clicked = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.iris-grant__actions button')]
    const run = buttons.find(b => b.textContent.includes('运行') && !b.textContent.includes('不'))
      ?? buttons[0]
    run?.click()
    return run?.textContent ?? null
  })()`)
  if (clicked !== null) break
}
console.log('consent:', consent ?? 'already granted (no banner)')
let frameSessionId = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  for (const sid of frameSessions) {
    const has = await evaluateIn(sid, `!!document.querySelector('.start-btn')`).catch(() => false)
    if (has) { frameSessionId = sid; break }
  }
  if (frameSessionId !== null) break
}
if (frameSessionId === null) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync('x-click-debug.png', Buffer.from(data, 'base64'))
  const debug = await evaluate(`JSON.stringify({
    turns: document.querySelectorAll('.iris-turn').length,
    turnTexts: [...document.querySelectorAll('.iris-turn')].map(t => t.textContent.slice(0, 40)),
    slots: document.querySelectorAll('.iris-interfaces__slot').length,
    states: [...document.querySelectorAll('.iris-interfaces__state')].map(e => e.textContent),
    frames: [...document.querySelectorAll('iframe')].map(f => f.title),
    masthead: document.querySelector('.iris-masthead')?.textContent?.slice(0, 60) ?? null,
  })`)
  throw new Error('the SYSTEM_START interface frame never rendered; page state: ' + debug)
}

const frameState = await evaluateIn(frameSessionId, `(() => ({
  scriptType: [...document.querySelectorAll('script')].map(s => s.type || 'classic'),
  jumpGlobal: typeof jumpToOpening11,
  hint: document.querySelector('.floating-hint')?.textContent ?? null,
  buttonText: document.querySelector('.start-btn')?.textContent ?? null,
}))()`)
console.log('frame state:', JSON.stringify(frameState))

// The click. The card's own handler runs inside its frame; it awaits
// setChatMessages([{message_id: 0, swipe_id: 1}]) over the TH bridge.
await evaluateIn(frameSessionId, `(() => { document.querySelector('.start-btn').click(); return 'clicked' })()`)

// Wait for the swipe to land and the view to re-render.
let floor0 = null
for (let i = 0; i < 40; i++) {
  await sleep(500)
  const exported = assertOk(await rpc('chat.export', { chatId: chat.chatId }), 'chat.export')
  const lines = (exported.content ?? '')
    .split('\n').filter(line => line.trim() !== '').slice(1)
    .map(line => JSON.parse(line))
  if (lines[0]?.mes !== '<开局>') { floor0 = lines[0]; break }
}
if (floor0 === null) throw new Error('floor 0 never switched after the SYSTEM_START click')
console.log('floor0 after click — swipe_id:', floor0.swipe_id, '| head:', JSON.stringify(floor0.mes.slice(0, 16)))
const swiped = floor0.swipe_id === 1 && floor0.mes.includes('<介绍>')

// The hint: after the swipe the greeting floor renders the 介绍 interface, so
// the INIT hint and button are gone from floor 0.
const hintAfter = await evaluateIn(frameSessionId, `(() => ({
  hint: document.querySelector('.floating-hint')?.textContent ?? null,
  startBtn: !!document.querySelector('.start-btn'),
}))()`).catch(() => 'frame reloaded')
console.log('frame after click:', JSON.stringify(hintAfter))

// Screenshot of the switched state.
{
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync('x-system-start-after-click.png', Buffer.from(data, 'base64'))
  console.log('shot: x-system-start-after-click.png')
}

// --- drawer overlay invariants on a page with real content --------------------

// Scroll down first so the check has something to bite on — parked at least
// 128px short of the bottom, so ChatPane's stick-to-bottom (a reader within
// 64px of the bottom snaps to the moving bottom on any store update) stays out
// of the measurement: the drawer must be measured alone.
await evaluate(`(() => {
  const scroller = document.querySelector('.iris-scroll')
  if (!scroller) return
  const max = scroller.scrollHeight - scroller.clientHeight
  scroller.scrollTop = Math.max(0, Math.min(300, max - 128))
})()`)
await sleep(150)
const geo = sel => `(() => { const el = document.querySelector('${sel}'); return el ? el.getBoundingClientRect().toJSON() : null })()`
const beforeOpen = await evaluate(`JSON.stringify({
  scrollTop: document.querySelector('.iris-scroll')?.scrollTop ?? -1,
  sheet: ${geo('.iris-sheet')},
})`)
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
  for (let i = 0; i < 20; i++) {
    await sleep(100)
    if (!(await evaluate(`!!document.querySelector('.iris-drawer--open')`))) break
  }
  await sleep(300)
}
await openDrawer()
const whileOpen = await evaluate(`JSON.stringify({
  scrollTop: document.querySelector('.iris-scroll')?.scrollTop ?? -2,
  sheet: ${geo('.iris-sheet')},
  drawer: ${geo('.iris-drawer')},
})`)
{
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync('x-drawer-open-on-content.png', Buffer.from(data, 'base64'))
  console.log('shot: x-drawer-open-on-content.png')
}
await closeDrawer()
const afterClose = await evaluate(`JSON.stringify({
  scrollTop: document.querySelector('.iris-scroll')?.scrollTop ?? -3,
  sheet: ${geo('.iris-sheet')},
})`)

const parse = s => JSON.parse(s)
const same = (a, b) => ['left', 'top', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) < 0.5)
const b = parse(beforeOpen), o = parse(whileOpen), a2 = parse(afterClose)
const drawerChecks = {
  scrollUnchangedWhileOpen: Math.abs(o.scrollTop - b.scrollTop) < 0.5,
  scrollUnchangedAfterClose: Math.abs(a2.scrollTop - b.scrollTop) < 0.5,
  sheetUnchangedWhileOpen: same(b.sheet, o.sheet),
  sheetUnchangedAfterClose: same(b.sheet, a2.sheet),
  drawerWidth: o.drawer?.width ?? null,
}
console.log('drawer on content page:', JSON.stringify(drawerChecks))

const fails = []
if (!swiped) fails.push('floor 0 did not switch to swipe 1')
if (!drawerChecks.scrollUnchangedWhileOpen) fails.push('drawer open shifted scrollTop')
if (!drawerChecks.scrollUnchangedAfterClose) fails.push('drawer close shifted scrollTop')
if (!drawerChecks.sheetUnchangedWhileOpen) fails.push('drawer open changed the sheet rect')
if (!drawerChecks.sheetUnchangedAfterClose) fails.push('drawer close changed the sheet rect')

console.log(fails.length ? 'FAIL:\n' + fails.join('\n') : 'ALL CHECKS PASS')
browser.close()
chrome.kill()
process.exit(fails.length ? 1 : 0)
