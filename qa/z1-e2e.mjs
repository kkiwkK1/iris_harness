// Z1 browser E2E: the founding console's real UI path on a fresh chat.
//
//   RPC: grant scripts, create a fresh chat for the 政经博弈 card.
//   CDP: open the app (boots into the newest chat = ours), reach INTO the
//        console's interface frame, fill two fields, click 确认建国.
//   Then: watch notices (no errUnsupported), the user floor, the STATE panel's
//   variables (must survive the append — the Z1 regression), and the reply.
//
// Usage: node qa/z1-e2e.mjs   (IRIS_BASE selects the host)
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { call, rpc, BASE } from './rpc.mjs'

const CHARACTER = '新架空政治经济模拟器'
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = process.env.CDP_PORT ?? '9343'
const HARD_DEADLINE = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 420_000)
const outDir = new URL('./results/', import.meta.url)
mkdirSync(outDir, { recursive: true })

const result = { base: BASE }

// ---------- RPC pre-flight: scripts allowed + fresh chat ----------
const scripts = await call('script.list', { characterId: CHARACTER })
if (scripts.scripts.length > 0 && scripts.scriptsAllowed !== true) {
  await call('script.setScriptsAllowed', { characterId: CHARACTER, allowed: true })
  console.log('scripts granted')
}
const { view } = await call('chat.create', { characterId: CHARACTER })
const chatId = view.chatId
console.log('chat:', chatId)
result.chatId = chatId

// ---------- CDP plumbing (same shape as qa-card.mjs) ----------
function socket(url) {
  const ws = new WebSocket(url)
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`socket failed: ${url}`)) })
  let seq = 0
  const pending = new Map()
  const consoleLines = []
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ')
      consoleLines.push({ level: msg.params.type, text: String(text).slice(0, 240) })
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleLines.push({ level: 'exception', text: String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '?').slice(0, 240) })
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
    if (r.result?.exceptionDetails !== undefined) {
      return { error: String(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text ?? '?').slice(0, 240) }
    }
    return r.result?.result?.value
  }
  return { ws, opened, send, evaluate, consoleLines }
}

const userDataDir = `${process.env.TEMP}/iris-z1-cdp-${CDP_PORT}-${Date.now()}`
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run', '--no-default-browser-check', '--headless=new',
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' })
let page

try {
  for (let at = 0; at < 30 && page === undefined; at += 1) {
    await delay(1000)
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json())
      page = targets.find(t => t.type === 'page' && t.url.startsWith('about:blank'))
    } catch { /* chrome not up yet */ }
  }
  if (page === undefined) throw new Error('chrome never came up')
  page = socket(page.webSocketDebuggerUrl)
  await page.opened
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Log.enable')
  await page.send('Page.navigate', { url: BASE })
  await delay(8000)

  // Confirm the app booted into our chat and the console frame exists.
  const boot = await page.evaluate(`(() => ({
    title: document.title,
    hasConsoleIframe: [...document.querySelectorAll('iframe')].some(f =>
      (f.contentDocument?.body?.innerText ?? '').includes('建国初始化控制台')),
    notices: [...document.querySelectorAll('.iris-notices__list p, .iris-reports__message')]
      .map(e => e.textContent.trim()).slice(0, 10),
    floors: document.querySelectorAll('[class*=message]').length,
  }))()`)
  console.log('boot:', JSON.stringify(boot))
  result.boot = boot
  if (boot.hasConsoleIframe !== true) {
    // wait a little more for frames
    await delay(6000)
    boot.hasConsoleIframe = await page.evaluate(`[...document.querySelectorAll('iframe')].some(f =>
      (f.contentDocument?.body?.innerText ?? '').includes('建国初始化控制台'))`)
    console.log('console frame after wait:', boot.hasConsoleIframe)
  }

  // Reach into the console iframe and drive the founding flow.
  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json())
  const consoleTarget = targets.find(t => t.type === 'iframe')
  if (consoleTarget === undefined) throw new Error('no iframe target for the console')
  const frame = socket(consoleTarget.webSocketDebuggerUrl)
  await frame.opened
  await frame.send('Runtime.enable')

  const filled = await frame.evaluate(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; return el !== null }
    return {
      country: set('pol-country', 'E2E测试共和国'),
      name: set('self-name', '测试员'),
      era: document.getElementById('pol-era')?.value ?? null,
      hasSubmit: document.getElementById('console-submit') !== null,
      status: document.getElementById('sync-status')?.textContent ?? null,
    }
  })()`)
  console.log('filled:', JSON.stringify(filled))
  result.filled = filled

  const clicked = await frame.evaluate(`(() => {
    const btn = document.getElementById('console-submit')
    if (btn === null) return false
    btn.click()
    return true
  })()`)
  console.log('clicked submit:', clicked)
  result.clicked = clicked

  // Sample: status line inside the frame, notices and floors in the shell.
  for (const wait of [3, 5, 8, 10, 12, 15, 15]) {
    await delay(wait * 1000)
    const sample = await page.evaluate(`(() => ({
      notices: [...document.querySelectorAll('.iris-notices__list p, .iris-reports__message')]
        .map(e => e.textContent.trim().slice(0, 200)).slice(0, 12),
      lastFloorRole: [...document.querySelectorAll('[data-role]')].map(e => e.dataset.role).slice(-3),
      bodyHasPolSimInit: (document.body.innerText ?? '').includes('PolSimInit'),
      generating: document.querySelector('[class*=generating], [class*=streaming]') !== null,
    }))()`)
    const frameStatus = await frame.evaluate(`document.getElementById('sync-status')?.textContent ?? null`)
    console.log(`t+~${wait}s status=${JSON.stringify(frameStatus)} sample=${JSON.stringify(sample)}`)
    result.sample ??= []
    result.sample.push({ frameStatus, ...sample })
  }

  const consoleTail = page.consoleLines.filter(l => l.level === 'exception' || l.level === 'error')
  console.log('page console errors:', JSON.stringify(consoleTail.slice(-8)))
  result.pageErrors = consoleTail

  // Final verdicts.
  const chatNow = await rpc('chat.open', { chatId })
  const v = chatNow.result?.view
  result.final = {
    floors: v?.messages?.length,
    variablesGuoming: v?.variables?.stat_data?.['政局']?.['国名'] ?? null,
    userFloorText: v?.messages?.map(m => m.role).join(','),
  }
  console.log('final:', JSON.stringify(result.final))
  console.log('VERDICT',
    'noErrUnsupported=' + String(result.sample.every(s => s.notices.every(n => !n.includes('还做不到')))),
    'userFloor=' + String(result.final.userFloorText.includes('user')),
    'varsSurvived=' + String(result.final.variablesGuoming === 'E2E测试共和国' || result.final.variablesGuoming !== null))
} finally {
  chrome.kill() // our own child handle; never by name or port
  await delay(500)
}

console.log(JSON.stringify(result, (_k, v) => v, 2).slice(0, 4000))
clearTimeout(HARD_DEADLINE)
