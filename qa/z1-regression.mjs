// Z1 regression: one real turn on a status-bar MVU card, watching the STATE
// panel's variables across the user→reply window (the surface Z1 changed).
//
//   RPC: grant scripts, create a fresh chat (the app boots into it).
//   CDP: boot, sample the greeting's interface frames.
//   RPC: send one real turn; watch stream.end; then read the message scope.
//
// Usage: node qa/z1-regression.mjs <characterId> "<turn text>"
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { call, eventWatcher, BASE } from './rpc.mjs'

const [, , characterId, turnText] = process.argv
if (characterId === undefined || turnText === undefined) {
  console.error('usage: node qa/z1-regression.mjs <characterId> "<turn text>"')
  process.exit(64)
}
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = process.env.CDP_PORT ?? '9353'
const HARD_DEADLINE = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 420_000)

const scripts = await call('script.list', { characterId })
if (scripts.scripts.length > 0 && scripts.scriptsAllowed !== true) {
  await call('script.setScriptsAllowed', { characterId: CHARACTER_ID(characterId), allowed: true })
}
function CHARACTER_ID(id) { return id }

const { view } = await call('chat.create', { characterId })
const chatId = view.chatId
console.log('chat:', chatId)

// ---------- minimal CDP ----------
function socket(url) {
  const ws = new WebSocket(url)
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`socket failed`)) })
  let seq = 0
  const pending = new Map()
  const consoleLines = []
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
    if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown') {
      const text = msg.method === 'Runtime.exceptionThrown'
        ? String(msg.params.exceptionDetails?.exception?.description ?? '?')
        : (msg.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ')
      consoleLines.push({ level: msg.params.type ?? 'exception', text: String(text).slice(0, 200) })
    }
  }
  const send = (method, params = {}) => new Promise(async res => {
    await opened
    const id = ++seq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails !== undefined) return { error: String(r.result.exceptionDetails.exception?.description ?? '?').slice(0, 200) }
    return r.result?.result?.value
  }
  return { ws, opened, send, evaluate, consoleLines }
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${process.env.TEMP}/iris-z1-reg-${CDP_PORT}-${Date.now()}`,
  '--no-first-run', '--no-default-browser-check', '--headless=new',
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' })

try {
  let page
  for (let at = 0; at < 30 && page === undefined; at += 1) {
    await delay(1000)
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json())
      page = targets.find(t => t.type === 'page' && t.url.startsWith('about:blank'))
    } catch { /* chrome not up */ }
  }
  if (page === undefined) throw new Error('chrome never came up')
  page = socket(page.webSocketDebuggerUrl)
  await page.opened
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Page.navigate', { url: BASE })
  await delay(9000)

  const frames = () => page.evaluate(`[...document.querySelectorAll('.iris-interfaces__slot iframe')]
    .map(f => { const b = f.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height) })`)
  console.log('greeting frames:', JSON.stringify(await frames()))

  const watcher = eventWatcher({ chatId })
  await watcher.ready
  await call('chat.send', { chatId, text: turnText })
  const end = await watcher.waitUntil(e => e.type === 'stream.end', 300_000)
  console.log('stream.end:', end !== undefined ? (end.reason ? JSON.stringify(end.reason) : 'ok') : 'TIMEOUT')
  watcher.close()

  await delay(10_000) // reply-side frames mount
  console.log('reply frames:', JSON.stringify(await frames()))
  const state = await page.evaluate(`(() => {
    const panel = document.querySelector('[class*=state], aside')
    return {
      notices: [...document.querySelectorAll('.iris-notices__list p, .iris-reports__message')]
        .map(e => e.textContent.trim().slice(0, 160)).slice(0, 10),
      panelHead: (panel?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 300),
    }
  })()`)
  console.log('state:', JSON.stringify(state))
  const errors = page.consoleLines.filter(l => l.level === 'exception' || l.level === 'error')
  console.log('console errors:', JSON.stringify(errors.slice(-6)))

  const after = await call('chat.open', { chatId })
  const v = after.view
  console.log('RESULT', JSON.stringify({
    floors: v.messages.length,
    variablesKeys: Object.keys(v.variables ?? {}),
    replyChars: (v.messages.at(-1)?.text ?? '').length,
  }))
} finally {
  chrome.kill() // our own child handle; never by name or port
  await delay(500)
}
clearTimeout(HARD_DEADLINE)
