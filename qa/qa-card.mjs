// Full per-card acceptance run against a live host on IRIS_BASE (default
// :8792). One card per invocation; one real conversation turn per card.
//
// Phases:
//   A. RPC pre-flight — script inventory, per-card script consent, a snapshot
//      of the host's retained diagnostic reports.
//   B. Browser (CDP over a private headless Chrome) — open the app, start a
//      chat from the character library, watch the greeting's interface frames,
//      send one real turn, watch the reply's frames for stability, and capture
//      notices, report rows and console errors.
//   C. RPC post — MVU variable scopes, diagnostic-report delta.
//
// Report rows are read from the rows themselves and then SPLIT by the known
// wording, not selected by it: `panel.unlisted` holds the rows no known word
// matched, and it is printed first. A word list can only speak about the names
// on it, so selecting by one turns a newly worded report into an empty column.
//
// Usage: node qa/qa-card.mjs <characterId> "<library display name>" [probeTurnText]
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { clickTabExpr } from './locators.mjs'
import { call, rpc, eventWatcher, debugReports, BASE } from './rpc.mjs'

const [, , characterId, displayName, turnTextArg] = process.argv
if (characterId === undefined || displayName === undefined) {
  console.error('usage: node qa/qa-card.mjs <characterId> "<display name>" [turn text]')
  process.exit(64)
}
const TURN_TEXT = turnTextArg
  ?? '（连通性测试）请用一两句话保持角色感打个招呼，不要推进剧情。'
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = process.env.CDP_PORT ?? '9333'
const HARD_DEADLINE = setTimeout(() => {
  console.log('HARD TIMEOUT')
  process.exit(3)
}, 420_000)

const outDir = new URL('./results/', import.meta.url)
mkdirSync(outDir, { recursive: true })
const slug = characterId.replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 40)
const result = { characterId, displayName, turnText: TURN_TEXT, base: BASE }

// ---------- generic CDP plumbing ----------
async function withPage(fn) {
  const userDataDir = `${process.env.TEMP}/iris-qa-cdp-${CDP_PORT}-${Date.now()}`
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    '--window-size=1400,900', 'about:blank',
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
    return await fn(page.webSocketDebuggerUrl)
  } finally {
    chrome.kill() // our own child handle; never by name or port
    await delay(500)
  }
}

function socket(url) {
  const ws = new WebSocket(url)
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`socket failed: ${url}`)) })
  let seq = 0
  const pending = new Map()
  const consoleLines = []
  const httpFailures = []
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ')
      consoleLines.push({ level: msg.params.type, text: String(text).slice(0, 300) })
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleLines.push({ level: 'exception', text: String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '?').slice(0, 300) })
    }
    if (msg.method === 'Log.entryAdded') {
      consoleLines.push({ level: msg.params.entry?.level ?? 'log', text: String(msg.params.entry?.text ?? '').slice(0, 300) })
    }
    if (msg.method === 'Network.responseReceived') {
      const { status, url } = msg.params.response ?? {}
      if (status >= 400) httpFailures.push({ status, url: String(url).slice(0, 200) })
    }
    if (msg.method === 'Network.loadingFailed') {
      httpFailures.push({ status: `failed:${msg.params.errorText}`, url: 'see requestWillBeSent' })
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
  return { ws, opened, send, evaluate, consoleLines, httpFailures }
}

// ---------- in-page samplers ----------
const sampleFramesExpr = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const read = () => [...document.querySelectorAll('.iris-interfaces__slot iframe')].map(f => {
    const box = f.getBoundingClientRect()
    return { w: Math.round(box.width), h: Math.round(box.height), inline: f.style.height || '', sizing: f.dataset['irisSizing'] || '' }
  })
  const samples = []
  for (let at = 0; at < 5; at += 1) { samples.push(read()); if (at < 4) await sleep(1500) }
  return samples
})()`

const captureStateExpr = `(() => {
  const text = sel => [...document.querySelectorAll(sel)].map(e => (e.textContent ?? '').trim().replaceAll('\\n', ' ⏎ ').slice(0, 400)).filter(t => t.length > 0)
  return {
    slots: [...document.querySelectorAll('.iris-interfaces__slot')].map(s => ({
      instance: s.dataset['instance'] ?? '',
      caption: (s.querySelector('.iris-interfaces__state')?.textContent ?? '').trim().replaceAll('\\n', ' ⏎ ').slice(0, 400),
      iframes: s.querySelectorAll('iframe').length,
    })),
    notices: text('.iris-notices__list p, .iris-notices__list span.iris-reports__message'),
    /*
     * Every row the three report surfaces are showing, read from the ROWS —
     * and then split by the old filter's vocabulary instead of being selected
     * by it.
     *
     * It used to scan the whole page's innerText for a word list
     * (blocked|height sources|interface after|drawn nothing|timed out|failed|
     * UnsupportedApiError|refused| KB of markup). A list can only speak about
     * the names on it: a report worded any other way produced no line, and that
     * column then read as "nothing was reported" — the failure that does not
     * produce output, which is the side every silent failure grows on.
     *
     * So the vocabulary is kept, because triage wants it, but it no longer
     * decides what is SEEN. \`unlisted\` is the point of the reversal: rows that
     * match none of the known words are exactly what the old filter dropped on
     * the floor, and now they are the ones printed first.
     *
     * \`present\` is separate from an empty row list: a surface that is not on
     * the page and a surface with nothing to say are different findings, and
     * folding them together turns a missing container into a clean zero.
     */
    panel: (() => {
      const VOCABULARY = /blocked|height sources|interface after|drawn nothing|timed out|failed|UnsupportedApiError|refused| KB of markup/
      const clip = s => (s ?? '').trim().replaceAll('\\n', ' ⏎ ').slice(0, 300)
      const ownText = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('')
      const rows = []
      const card = document.querySelector('#iris-card-scripts')
      // Scoped to the scripts card: .iris-script__report is also the notice
      // log's row class, so an unscoped selector describes two lists at once.
      for (const row of card === null ? [] : card.querySelectorAll('.iris-script__report')) {
        rows.push({
          source: 'card',
          channel: row.querySelector('.iris-reports__area')?.textContent ?? null,
          fault: String(row.className).includes('iris-script__report--fault'),
          text: clip(ownText(row)),
        })
      }
      for (const row of document.querySelectorAll('.iris-notices__list li')) {
        rows.push({
          source: 'notice',
          channel: null,
          fault: String(row.className).includes('--error'),
          text: clip(row.querySelector('.iris-reports__message')?.textContent ?? row.textContent),
        })
      }
      for (const row of document.querySelectorAll('.iris-reports__list li')) {
        rows.push({
          source: 'host',
          channel: row.querySelector('.iris-reports__area')?.textContent ?? null,
          fault: String(row.className).includes('--fault'),
          text: clip(row.querySelector('.iris-reports__message')?.textContent ?? row.textContent),
        })
      }
      return {
        present: {
          card: card !== null,
          notices: document.querySelector('.iris-notices__list') !== null,
          host: document.querySelector('.iris-reports__list') !== null,
        },
        rows: rows.slice(0, 60),
        // Rows the old word list would have shown.
        matched: rows.filter(r => VOCABULARY.test(r.text)).map(r => r.text).slice(0, 40),
        // Rows it would have swallowed. Read this column first.
        unlisted: rows.filter(r => !VOCABULARY.test(r.text)).map(r => r.text).slice(0, 40),
      }
    })(),
    hostReportsSection: (document.querySelector('.iris-reports')?.textContent ?? '').trim().replaceAll('\\n', ' ⏎ ').slice(0, 1200),
  }
})()`

async function collectIframeProbes(cdpPort) {
  const probes = []
  let targets = []
  try {
    targets = await fetch(`http://127.0.0.1:${cdpPort}/json`).then(r => r.json())
  } catch { return probes }
  for (const t of targets.filter(x => x.type === 'iframe')) {
    const frame = socket(t.webSocketDebuggerUrl)
    try {
      await Promise.race([frame.opened, delay(4000).then(() => { throw new Error('socket timeout') })])
      await frame.send('Runtime.enable')
      await frame.send('Network.enable')
      const probe = await Promise.race([
        frame.evaluate(`(() => {
          const b = document.body
          if (!b) return { empty: true }
          const visible = [...b.querySelectorAll('*')].slice(0, 500)
            .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }).length
          return {
            title: document.title,
            bodyChildren: [...b.children].map(e => e.tagName + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '')).slice(0, 10),
            visibleBoxes: visible,
            textLen: (b.innerText ?? '').trim().length,
            viewport: document.documentElement.clientHeight,
            scrollH: document.body.scrollHeight,
            hasMvu: typeof window.Mvu !== 'undefined',
            head: document.head ? document.head.children.length : 'NO-HEAD',
          }
        })()`),
        delay(6000, () => ({ error: 'probe timeout' })),
      ])
      probes.push({ url: String(t.url).slice(0, 120), probe, httpFailures: frame.httpFailures })
    } catch (e) {
      probes.push({ url: String(t.url).slice(0, 120), probe: { error: String(e.message ?? e) } })
    } finally {
      try { frame.ws.close() } catch { /* already closed */ }
    }
  }
  return probes
}

function frameStability(samples) {
  // samples: array (5) of frame arrays. Stability judged on the last 3 samples
  // (the first may land mid-mount). Any size movement afterwards = flicker.
  if (!Array.isArray(samples) || samples.length === 0) return { frames: 0 }
  const count = Math.max(...samples.map(s => s.length))
  const frames = []
  for (let i = 0; i < count; i += 1) {
    const sizes = samples.map(s => s[i] ? `${s[i].w}x${s[i].h}` : 'gone')
    const tail = sizes.slice(-3)
    frames.push({
      index: i,
      sizes: [...new Set(sizes)],
      stable: new Set(tail).size === 1,
      inlineSeen: [...new Set(samples.map(s => s[i]?.inline).filter(v => v !== undefined && v !== ''))],
      sizingSeen: [...new Set(samples.map(s => s[i]?.sizing).filter(v => v !== undefined && v !== ''))],
    })
  }
  return { frames, stable: frames.every(f => f.stable) }
}

// ---------- Phase A: RPC pre-flight ----------
console.log(`=== A. pre-flight for ${characterId} ===`)
const scripts = await call('script.list', { characterId })
result.scripts = {
  allowed: scripts.scriptsAllowed,
  list: scripts.scripts.map(s => ({ name: s.name ?? s.id, bytes: s.bytes, enabled: s.enabled !== false })),
}
console.log(`scriptsAllowed=${scripts.scriptsAllowed}, ${scripts.scripts.length} script(s): ${scripts.scripts.map(s => `${s.name ?? s.id}(${s.bytes ?? '?'}B${s.enabled === false ? ', card-disabled' : ''})`).join(', ')}`)
if (scripts.scripts.length > 0 && scripts.scriptsAllowed !== true) {
  await call('script.setScriptsAllowed', { characterId, allowed: true })
  result.scripts.grantedNow = true
  console.log('script.setScriptsAllowed -> true')
}
const scriptsAfter = scripts.scripts.length > 0 ? await call('script.list', { characterId }) : scripts
result.scripts.allowedAfterGrant = scriptsAfter.scriptsAllowed
console.log(`scriptsAllowed after grant: ${scriptsAfter.scriptsAllowed}`)
const reportsBefore = await debugReports()
const beforeSeq = Math.max(0, ...(reportsBefore.reports ?? []).map(r => r.seq ?? 0))

// ---------- Phase B: browser ----------
console.log('=== B. browser run ===')
result.browser = await withPage(async pageUrl => {
  const page = socket(pageUrl)
  await page.opened
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Log.enable')
  await page.send('Network.enable')
  await page.send('Page.navigate', { url: BASE })
  await delay(7000)

  // The notice log is session-scoped and page boot opens the most recent chat
  // (the previous card's, in a sequential run). Capture it as a baseline so the
  // per-card judgement subtracts whatever the boot chat announced.
  const noticesBaseline = await page.evaluate(captureStateExpr)

  /*
   * The tab is found by order and confirmed structurally (qa/locators.mjs); the
   * character row is found by its name, which is user data and the only handle.
   *
   * It used to find the tab by `textContent.includes('Characters')`. The shell
   * follows `navigator.language`, so on a Chinese machine the tabs read
   * 阅读 / 角色库 and every run of this script died at
   * `no Characters tab: 阅读|角色库` — loudly, but for every card.
   */
  const tabbed = await page.evaluate(clickTabExpr('characters'))
  const clickFlow = tabbed?.error !== undefined ? tabbed : await page.evaluate(`(() => {
    const wanted = ${JSON.stringify(displayName)}
    const hit = [...document.querySelectorAll('.iris-list .iris-row')]
      .filter(el => (el.querySelector('.iris-row__title')?.textContent ?? '').includes(wanted))
    if (hit.length === 0) {
      return {
        error: 'no character row named ' + wanted,
        names: [...document.querySelectorAll('.iris-list .iris-row .iris-row__title')].map(t => (t.textContent ?? '').trim()).slice(0, 20),
      }
    }
    hit[0].click()
    return { clicked: hit.length }
  })()`)
  console.log('click flow:', JSON.stringify({ tab: tabbed, ...clickFlow }))
  if (clickFlow?.error !== undefined) throw new Error(`UI navigation failed: ${clickFlow.error}`)
  await delay(10_000) // script frames boot (V1.5.4 boots 9-12s)

  const greetingState = await page.evaluate(captureStateExpr)
  const greetingSamples = await page.evaluate(sampleFramesExpr)
  const greetingFrames = frameStability(greetingSamples)
  console.log(`greeting frames: ${JSON.stringify(greetingFrames.frames?.map(f => `${f.index}:${f.sizes.join('/')}${f.stable ? '' : ' UNSTABLE'}`))}`)
  const shotGreeting = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })
  writeFileSync(new URL(`./results/${slug}-greeting.jpeg`, import.meta.url), Buffer.from(shotGreeting.result?.data ?? '', 'base64'))

  // Find the chat the UI just created and send one real turn through RPC so
  // the run exercises the same chat the browser is watching. Read-only list:
  // an RPC `chat.open` here would register a second session on a chat whose
  // script runs are still live and produce a bogus "injections still live"
  // host report.
  const chats = await call('chat.list', {})
  const mine = chats.chats.filter(c => c.characterId === characterId)
  if (mine.length === 0) throw new Error('UI did not create a chat for this character')
  const chatId = mine[0].chatId
  result.chatId = chatId

  const watcher = eventWatcher({ chatId })
  await watcher.ready
  const started = Date.now()
  const send = await call('chat.send', { chatId, text: TURN_TEXT })
  const end = await watcher.waitUntil(e => e.type === 'stream.end' && e.chatId === chatId, 240_000)
  result.turn = {
    seconds: Math.round((Date.now() - started) / 1000),
    reason: end?.reason ?? 'timeout-240s',
  }
  if (end !== undefined) {
    // The settled view carries the whole conversation, greeting included.
    const greetingMsg = end.view?.messages[0]
    result.greeting = { chars: greetingMsg?.text?.length ?? 0, head: (greetingMsg?.text ?? '').replace(/\s+/g, ' ').slice(0, 120) }
    // `turn` is a position index; the streamed reply is the last non-user
    // message in the settled view (stream.end's turn has pointed at the user
    // floor in practice).
    const msg = end.view?.messages.filter(m => m.role !== 'user').at(-1) ?? end.view?.messages.at(-1)
    result.turn.replyChars = msg?.text?.length ?? 0
    result.turn.replyHead = (msg?.text ?? '').replace(/\s+/g, ' ').slice(0, 160)
    result.turn.replyTail = (msg?.text ?? '').replace(/\s+/g, ' ').slice(-160)
  } else {
    const err = watcher.events.find(e => e.type === 'stream.error' && e.chatId === chatId)
    result.turn.error = err ? `${err.code ?? 'stream.error'}: ${err.message ?? ''}` : 'no stream.end within 240s'
  }
  watcher.close()

  await delay(12_000) // reply-side interface frames mount after stream.end
  const replyState = await page.evaluate(captureStateExpr)
  const replySamples = await page.evaluate(sampleFramesExpr)
  const replyFrames = frameStability(replySamples)
  console.log(`reply frames: ${JSON.stringify(replyFrames.frames?.map(f => `${f.index}:${f.sizes.join('/')}${f.stable ? '' : ' UNSTABLE'}`))}`)
  const shotReply = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })
  writeFileSync(new URL(`./results/${slug}-reply.jpeg`, import.meta.url), Buffer.from(shotReply.result?.data ?? '', 'base64'))

  const iframeProbes = await collectIframeProbes(CDP_PORT)
  console.log(`iframe targets probed: ${iframeProbes.length}`)

  return {
    greeting: { state: greetingState, frames: greetingFrames },
    reply: { state: replyState, frames: replyFrames },
    noticesBaseline: noticesBaseline.notices,
    iframeProbes,
    consoleErrors: page.consoleLines.filter(l => l.level === 'error' || l.level === 'exception'),
    consoleHead: page.consoleLines.slice(0, 30),
    httpFailures: page.httpFailures,
  }
})

// ---------- Phase C: variables + diagnostics ----------
console.log('=== C. variables + diagnostics ===')
try {
  const messageScope = await call('script.getVariables', { chatId: result.chatId, scope: 'message' })
  const chatScope = await call('script.getVariables', { chatId: result.chatId, scope: 'chat' }).catch(e => ({ variables: null, error: String(e.message) }))
  const summarize = vars => {
    if (vars === null || vars === undefined) return null
    const out = {}
    for (const [k, v] of Object.entries(vars)) {
      out[k] = v !== null && typeof v === 'object' ? { objectKeys: Object.keys(v).slice(0, 12), approxBytes: JSON.stringify(v)?.length ?? 0 } : v
    }
    return out
  }
  result.variables = { message: summarize(messageScope.variables), chat: summarize(chatScope.variables) }
} catch (e) {
  result.variables = { error: String(e.message ?? e) }
}
const reportsAfter = await debugReports()
result.newReports = (reportsAfter.reports ?? []).filter(r => (r.seq ?? 0) > beforeSeq).map(r => ({
  seq: r.seq, kind: r.kind, chatId: r.chatId, characterId: r.characterId, scriptId: r.scriptId,
  message: String(r.message ?? '').slice(0, 260),
}))

clearTimeout(HARD_DEADLINE)
writeFileSync(new URL(`./results/${slug}.json`, import.meta.url), JSON.stringify(result, null, 2))
console.log(`\n=== summary for ${displayName} ===`)
console.log(`turn: ${JSON.stringify(result.turn)}`)
console.log(`greeting: ${JSON.stringify(result.greeting)}`)
console.log(`frames stable: greeting=${result.browser.greeting.frames.stable ?? 'n/a'} reply=${result.browser.reply.frames.stable ?? 'n/a'}`)
console.log(`new host reports: ${result.newReports.length}`)
for (const r of result.newReports) console.log(`  - #${r.seq} [${r.kind}] ${r.message.slice(0, 160)}`)

/*
 * The unlisted rows are printed, not just written to the JSON.
 *
 * They are the ones the old word list would have dropped, so they are the ones
 * nobody has ever seen for this card — and a column that exists only in a file
 * nobody opens is the same silence the filter produced.
 */
const panel = result.browser?.reply?.state?.panel
if (panel === undefined) {
  console.log('panel: not captured')
} else {
  console.log(`panel rows: ${panel.rows.length} (known wording ${panel.matched.length}, UNLISTED ${panel.unlisted.length}) surfaces present: ${JSON.stringify(panel.present)}`)
  for (const line of panel.unlisted.slice(0, 10)) console.log(`  ? ${line}`)
}
console.log(`results -> qa/results/${slug}.json`)
