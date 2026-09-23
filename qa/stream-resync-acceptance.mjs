/**
 * Acceptance for the stuck-streaming defect (owner, 2026-09-24 00:05, card 黑兽).
 *
 * The symptom: a reply stops growing mid-sentence with the caret still
 * blinking, the composer still offers Stop, and a reload shows the whole
 * reply — the host finished, the page never learned. This drives a real host
 * on a copied data dir, through a **fake OpenAI-compatible endpoint** so no
 * model money is spent, and reads the page the reader sees.
 *
 * Scenarios, each on the same conversation:
 *
 * - **a · control.** A normal 20-chunk stream. At the end the caret is gone,
 *   Stop is gone and the reply's end marker is on the page.
 * - **b · gap across the end.** The page's event socket is closed from the page
 *   side after a third of the deltas, and every reconnect is refused until the
 *   host has broadcast `stream.end` (read on an independent socket this script
 *   holds) plus one second. Then the page may reconnect. On `main` before the
 *   fix the page stays stuck like the screenshot; after it the page must
 *   resync — caret gone, marker shown, Stop gone — within {@link RESYNC_BOUND_MS}.
 * - **c · silent socket.** The socket stays open but the page's listener is
 *   muted after a third of the deltas (a half-open connection: no `close`
 *   ever fires, so no reconnect ever happens). Only the silence watchdog can
 *   end this; it must resync within the watchdog bound plus slack.
 * - **d · gap mid-stream only.** The gap closes while the host is still
 *   generating: the page must keep streaming and settle normally.
 *
 * Every reading is recorded with the time it was taken; a negative reading
 * carries its observation window.
 *
 * Page-side control of the socket is an init script that wraps `WebSocket` for
 * `/iris/events` only: it records every instance, can refuse a new one
 * (`__qaBlock`), and can drop arriving frames (`__qaMute`). CDP's offline
 * emulation was not used because whether it closes an already-open WebSocket
 * is a Chrome detail this script would then be measuring instead.
 *
 * `EXPECT=stuck` runs the same scenarios against a build without the fix and
 * turns b and c into "the page is still stuck at the end of the window" —
 * the recorded red. Default is `EXPECT=resync`.
 *
 * Hard failures: exit 1 = a check did not pass, 2 = port or data-dir trouble,
 * 3 = hard timeout. Kills only its own host and its own Chrome.
 *
 * Usage: node qa/stream-resync-acceptance.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, readFile, readdir, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
// CDP from 9333 up, all distinct; 9356 is doctor-acceptance's.
const CDP = String(cdpPort(9357))
const EXPECT = process.env.EXPECT ?? 'resync'
/** Reconnect backoff tops out at 10 s; a resync RPC and a render on top. */
const RESYNC_BOUND_MS = 15_000
/** The client's silence watchdog (store.ts) plus slack for the RPC and render. */
const WATCHDOG_BOUND_MS = 20_000 + 6_000

const outDir = new URL('./results/stream-resync/', import.meta.url)
mkdirSync(outDir, { recursive: true })

let failures = 0
const readings = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}
const record = (what, value) => {
  readings.push({ what, value, observedAtMs: Date.now() })
  console.log(`  READ  ${what} = ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
}

/* ---- port, asserted free before the host starts ------------------------ */
const listening = (() => {
  const netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
  return new Set((netstat.stdout ?? '').split('\n')
    .filter(line => line.includes('LISTENING'))
    .map(line => /:(\d+)\s/.exec(line)?.[1])
    .filter(port => port !== undefined)
    .map(Number))
})()
let PORT = process.env.IRIS_PORT === undefined ? undefined : Number(process.env.IRIS_PORT)
if (PORT === undefined) {
  for (let candidate = 8791; candidate < 8900; candidate += 1) {
    if (!listening.has(candidate)) { PORT = candidate; break }
  }
}
if (PORT === undefined || listening.has(PORT)) {
  console.error(`FAIL  port ${String(PORT)} is already listening — refusing to start`)
  process.exit(2)
}
const BASE = `http://127.0.0.1:${String(PORT)}`

/* ---- the fake endpoint --------------------------------------------------- */
/** What the next request streams. Mutated between scenarios. */
const plan = { text: '', chunks: 20, delayMs: 150 }
let served = 0
const fake = createServer((request, response) => {
  if (request.method === 'GET' && request.url?.endsWith('/models')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'qa-fake-stream' }] }))
    return
  }
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404).end()
    return
  }
  request.resume()
  request.on('end', async () => {
    served += 1
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
    const { text, chunks, delayMs } = plan
    const size = Math.ceil(text.length / chunks)
    const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
    for (let at = 0; at < text.length; at += size) {
      if (response.destroyed) return
      response.write(frame({ choices: [{ delta: { content: text.slice(at, at + size) } }] }))
      await delay(delayMs)
    }
    response.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    response.write(frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: chunks, total_tokens: 100 + chunks } }))
    response.write('data: [DONE]\n\n')
    response.end()
  })
})
await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
const FAKE = `http://127.0.0.1:${String(fake.address().port)}`

/* ---- the data copy and the host ----------------------------------------- */
const data = dataCopy('iris-stream-resync-qa-')
const dataDir = data.dir
const dataSource = process.env.IRIS_DATA_SOURCE
  ?? join(repoRoot, '..', 'iris_cordis_traven', 'apps', 'iris', 'data')
await cp(dataSource, dataDir, { recursive: true }).catch(error => {
  console.error(`FAIL  no data dir to copy from (${dataSource}): ${String(error)}`)
  process.exit(2)
})
await rm(join(dataDir, 'host.lock'), { force: true })
await rm(join(dataDir, 'default-user', 'host.lock'), { force: true })

/*
 * The reply the fake streams: the owner's own stuck reply when the copy has
 * it (the newest assistant floor of the 黑兽 conversation — its prose, then its
 * `<UpdateVariable>` block, so the card's variable writer sees the real shape),
 * with an end marker spliced in before the update block so "the whole reply
 * is on the page" is a string match. Never printed.
 */
const WANTED = process.env.IRIS_CHAT_PREFIX ?? '黑兽-'
const chatsDir = join(dataDir, 'default-user', 'chats')
const chatFile = (await readdir(chatsDir)).filter(name => name.startsWith(WANTED)).sort().at(-1)
let ownerReply = ''
if (chatFile !== undefined) {
  const lines = (await readFile(join(chatsDir, chatFile), 'utf8')).split('\n').filter(Boolean)
  for (const line of lines.slice(1).reverse()) {
    const row = JSON.parse(line)
    if (row.is_user === false && typeof row.mes === 'string' && row.mes.length > 500) { ownerReply = row.mes; break }
  }
}
const replyWith = marker => {
  if (ownerReply === '') return `第一段。\n\n${'他没有回答，只是看着。'.repeat(60)}\n\n${marker}`
  const cut = ownerReply.indexOf('<UpdateVariable>')
  return cut === -1
    ? `${ownerReply}\n\n${marker}`
    : `${ownerReply.slice(0, cut)}${marker}\n\n${ownerReply.slice(cut)}`
}

let hostOutput = ''
const host = data.adopt(spawn(process.execPath, ['apps/iris/bin.ts'], {
  cwd: repoRoot,
  env: { ...process.env, IRIS_PORT: String(PORT), IRIS_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
}))
host.stdout.on('data', chunk => { hostOutput += String(chunk) })
host.stderr.on('data', chunk => { hostOutput += String(chunk) })
console.log(`host process PID ${String(host.pid)} on port ${String(PORT)}, fake endpoint ${FAKE}, EXPECT=${EXPECT}`)

let seq = 0
const rpc = async (method, params = {}) => {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-resync-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 600_000)

/* The page-side socket control, installed before any page script runs. */
const SOCKET_CONTROL = `(() => {
  const Native = window.WebSocket
  if (Native === undefined || window.__qaSockets !== undefined) return
  window.__qaSockets = []
  window.__qaBlock = false
  window.__qaMute = false
  window.__qaLog = []
  window.__qaFrames = 0
  /* Armed per scenario: after the page itself has handled \`after\` stream.text
   * frames, open the gap from inside the delivery — in event order, so the
   * gap's position does not depend on how busy the main thread is when a CDP
   * evaluate would have been scheduled. */
  window.__qaArm = undefined
  window.__qaLong = []
  window.__qaTimes = []
  /* Main-thread stalls: a 100 ms interval that records any gap over 1 s. */
  window.__qaStalls = []
  let lastTick = Date.now()
  setInterval(() => {
    const now = Date.now()
    if (now - lastTick > 1000) window.__qaStalls.push([lastTick, now - lastTick])
    lastTick = now
  }, 100)
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__qaLong.push([Date.now(), Math.round(entry.duration)])
    }).observe({ type: 'longtask', buffered: true })
  } catch {}
  const isEvents = url => String(url).includes('/iris/events')
  class Controlled extends Native {
    constructor(url, protocols) {
      if (isEvents(url) && window.__qaBlock) {
        window.__qaLog.push(['refused', Date.now()])
        throw new Error('qa: event socket refused')
      }
      super(url, protocols)
      if (!isEvents(url)) return
      window.__qaSockets.push(this)
      window.__qaLog.push(['construct', Date.now()])
      super.addEventListener('open', () => window.__qaLog.push(['open', Date.now()]))
      super.addEventListener('close', () => window.__qaLog.push(['close', Date.now()]))
      this.__events = true
    }
    addEventListener(type, listener, options) {
      if (this.__events !== true || type !== 'message') return super.addEventListener(type, listener, options)
      return super.addEventListener(type, event => {
        if (window.__qaMute) return
        window.__qaFrames += 1
        const began = performance.now()
        listener.call(this, event)
        if (String(event.data).includes('"type":"stream.text"')) {
          window.__qaTimes.push([Date.now(), Math.round(performance.now() - began)])
        }
        const arm = window.__qaArm
        if (arm !== undefined && String(event.data).includes('"type":"stream.text"')) {
          arm.seen += 1
          if (arm.seen >= arm.after) {
            window.__qaArm = undefined
            window.__qaLog.push(['gap-' + arm.kind, Date.now(), arm.seen])
            if (arm.kind === 'mute') window.__qaMute = true
            else { window.__qaBlock = true; this.close() }
          }
        }
      }, options)
    }
  }
  window.WebSocket = Controlled
})()`

let chrome
const profile = chromeProfile('iris-qa-cdp-')
let watcher
try {
  let up = false
  for (let at = 0; at < 60 && !up; at += 1) {
    await delay(500)
    if (hostOutput.includes('EADDRINUSE')) {
      console.error(`FAIL  the host died on EADDRINUSE — another process holds ${String(PORT)}:\n${hostOutput}`)
      process.exit(2)
    }
    up = await rpc('character.list').then(() => true).catch(() => false)
  }
  if (!up) throw new Error(`the host on ${String(PORT)} never answered\n${hostOutput}`)

  const cards = await rpc('character.list')
  record('character.list before any write (count)', (cards.characters ?? []).length)
  const chats = (await rpc('chat.list')).chats ?? []
  const chat = chats.find(row => row.chatId === chatFile?.replace(/\.jsonl$/, '')) ?? chats[0]
  if (chat === undefined) { console.error('FAIL  no conversation in the copy'); process.exit(2) }
  record('the conversation', { chatId: chat.chatId, title: chat.title, characterId: chat.characterId, ownerReplyChars: ownerReply.length })

  // The fake endpoint, through the product's own verbs — never connections.json.
  const saved = await rpc('connection.save', { provider: 'default', model: 'qa-fake-stream', baseURL: FAKE, label: 'qa-fake-stream' })
  const profileId = saved.profiles.find(row => row.label === 'qa-fake-stream')?.id
  if (profileId === undefined) throw new Error('connection.save returned no qa profile')
  await rpc('connection.activate', { id: profileId })
  await rpc('connection.activate', { id: profileId, chatId: chat.chatId })
  record('provider activated (global and this chat)', profileId)
  if (process.env.DECLINE_SCRIPTS === '1') {
    // Diagnostic only: the same run with the card's scripts declined, to tell
    // a stall in the card's frames from one in the shell's own rendering.
    await rpc('script.setScriptsAllowed', { characterId: chat.characterId, allowed: false })
    record('card scripts declined for this run', chat.characterId)
  }

  // An independent observer of the host's own broadcasts.
  const hostEvents = []
  watcher = new WebSocket(`${BASE.replace(/^http/, 'ws')}/iris/events`)
  await new Promise((res, rej) => { watcher.onopen = res; watcher.onerror = rej })
  watcher.onmessage = message => {
    const event = JSON.parse(String(message.data))
    if (event.chatId === chat.chatId && String(event.type).startsWith('stream.')) {
      hostEvents.push({ type: event.type, turn: event.turn, at: Date.now(), ...event.type === 'stream.end' ? { view: event.view } : {} })
    }
  }

  // ---- browser -------------------------------------------------------------
  chrome = profile.adopt(spawn(CHROME, [
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile.dir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    '--window-size=1480,1000', 'about:blank',
  ], { stdio: 'ignore' }))
  let version
  for (let at = 0; at < 40 && version === undefined; at += 1) {
    await delay(500)
    try { version = await fetch(`http://127.0.0.1:${CDP}/json/version`).then(r => r.json()) } catch { /* not up yet */ }
  }
  if (version === undefined) throw new Error('chrome never came up')
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let wsSeq = 0
  const pending = new Map()
  const pageErrors = []
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push({ at: Date.now(), text: msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text })
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageErrors.push({ at: Date.now(), text: (msg.params.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' ').slice(0, 300) })
    }
  }
  const raw = (method, params = {}, sessionId) => new Promise(res => {
    const id = ++wsSeq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  })
  const { targetId } = (await raw('Target.createTarget', { url: 'about:blank' })).result
  const pageSession = (await raw('Target.attachToTarget', { targetId, flatten: true })).result.sessionId
  const send = (method, params = {}) => raw(method, params, pageSession)
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails !== undefined) throw new Error(`evaluate: ${JSON.stringify(r.result.exceptionDetails)}`)
    return r.result?.result?.value
  }
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(new URL(`${name}.png`, outDir), Buffer.from(r.result.data, 'base64'))
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: SOCKET_CONTROL })

  const load = async () => {
  await send('Page.navigate', { url: `${BASE}/` })
  for (let at = 0; at < 40; at += 1) {
    await delay(500)
    if (await evaluate('document.querySelector(".iris-composer__field") !== null') === true) break
  }
  const opened = await evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    document.querySelector('[data-tab="chats"]')?.click()
    for (let at = 0; at < 30; at += 1) {
      const rows = [...document.querySelectorAll('.iris-row--chat')]
        .filter(el => (el.querySelector('.iris-row__title')?.textContent ?? '').trim() === ${JSON.stringify(chat.title)})
      if (rows.length === 1) { rows[0].click(); return true }
      if (rows.length > 1) return 'ambiguous title'
      await sleep(200)
    }
    return false
  })()`)
  if (opened !== true) throw new Error(`the conversation row never appeared (${String(opened)})`)
  const header = await evaluate(`document.querySelector('.iris-masthead')?.textContent ?? ''`)
  record('masthead after opening', header.slice(0, 80))
  await delay(4000)
  }
  await load()
  record('page event sockets after load', await evaluate('window.__qaLog'))

  /** What the reader sees right now. */
  const PAGE_STATE = `(() => {
    const texts = [...document.querySelectorAll('.iris-msg__text')]
    const last = texts.at(-1)
    return {
      caret: document.querySelector('.iris-caret') !== null,
      stop: document.querySelector('.iris-composer__send--stop') !== null,
      lastText: last === undefined ? '' : last.textContent ?? '',
      frames: window.__qaFrames,
    }
  })()`
  const pageState = async () => evaluate(PAGE_STATE)

  const reportsSince = async since => (await rpc('debug.reports', { since })).reports ?? []
  const lastSeq = async () => {
    const all = (await rpc('debug.reports', {})).reports ?? []
    return all.reduce((max, row) => Math.max(max, row.seq), 0)
  }

  /** Type a line and press Enter in the composer. */
  const sendLine = async text => {
    const typed = await evaluate(`(() => {
      const field = document.querySelector('.iris-composer__field')
      if (field === null) return false
      field.focus()
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(field, ${JSON.stringify(text)})
      field.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    if (!typed) throw new Error('no composer field')
    await delay(200)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }

  const waitFor = async (predicate, timeoutMs, stepMs = 100) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const value = await predicate()
      if (value) return Date.now() - start
      await delay(stepMs)
    }
    return undefined
  }

  /**
   * One scenario.
   * @param {string} name
   * @param {{chunks: number, delayMs: number, gap?: 'close-across-end' | 'mute-across-end' | 'close-mid'}} options
   */
  const scenario = async (name, options) => {
    // A page left stuck by the previous scenario cannot send (its composer is
    // on Stop), so it is reloaded first — and the reload is recorded.
    const before = await pageState()
    if (before.caret || before.stop) {
      record(`${name}: page still generating from the previous scenario — reloading it first`, before.stop)
      await load()
    }
    await evaluate('window.__qaLong.length = 0; window.__qaTimes.length = 0; window.__qaStalls.length = 0')
    const marker = `【QA-END-${name}-${String(Date.now() % 100000)}】`
    Object.assign(plan, { text: replyWith(marker), chunks: options.chunks, delayMs: options.delayMs })
    const baseSeq = await lastSeq()
    const eventsBefore = hostEvents.length
    const errorsBefore = pageErrors.length
    const profiling = process.env.PROFILE === name
    if (profiling) {
      await send('Profiler.enable')
      await send('Profiler.setSamplingInterval', { interval: 500 })
      await send('Profiler.start')
    }
    const sentAt = Date.now()

    if (options.gap !== undefined) {
      const third = Math.floor(options.chunks / 3)
      await evaluate(`window.__qaArm = { after: ${String(third)}, seen: 0, kind: ${JSON.stringify(options.gap === 'mute-across-end' ? 'mute' : 'close')} }`)
    }
    await sendLine(`qa ${name}`)
    const hostTexts = () => hostEvents.slice(eventsBefore).filter(e => e.type === 'stream.text').length
    const hostEnd = () => hostEvents.slice(eventsBefore).find(e => e.type === 'stream.end' || e.type === 'stream.error')

    if (options.gap !== undefined) {
      const opened = await waitFor(async () => (await evaluate('window.__qaArm === undefined')) === true, 60_000, 200)
      if (opened === undefined) throw new Error(`${name}: the page never saw a third of the deltas`)
      const gapAt = (await evaluate('window.__qaLog')).filter(row => String(row[0]).startsWith('gap-')).at(-1)
      record(`${name}: gap opened by the page after its own delta`, { pageDeltaSeen: gapAt?.[2], hostDeltasByThen: hostEvents.slice(eventsBefore).filter(e => e.type === 'stream.text' && e.at <= gapAt?.[1]).length, atMs: (gapAt?.[1] ?? 0) - sentAt, kind: options.gap })
      if (options.gap === 'close-mid') {
        await delay(3000)
        await evaluate('window.__qaBlock = false')
        record(`${name}: gap closed while host still streaming`, { hostEnded: hostEnd() !== undefined, atMs: Date.now() - sentAt })
      }
    }

    const endIn = await waitFor(async () => hostEnd() !== undefined, 90_000, 200)
    const end = hostEnd()
    if (end === undefined) throw new Error(`${name}: the host never settled`)
    const hostView = end.view
    const hostLast = hostView?.messages?.at(-1)
    record(`${name}: host terminal event`, {
      type: end.type, turn: end.turn, afterSendMs: endIn === undefined ? null : end.at - sentAt,
      hostDeltas: hostTexts(), hostLastHasMarker: (hostLast?.text ?? '').includes(marker), fakeRequestsServed: served,
    })
    const gapClosedAt = Date.now()
    if (options.gap === 'close-across-end' || options.gap === 'mute-across-end') {
      await delay(1000)
      const stuck = await pageState()
      record(`${name}: page 1 s after host settled, gap still open`, { caret: stuck.caret, stop: stuck.stop, markerShown: stuck.lastText.includes(marker), lastChars: stuck.lastText.length })
      await shot(`${name}-during-gap`)
      if (options.gap === 'close-across-end') await evaluate('window.__qaBlock = false')
    }

    const bound = options.boundMs ?? options.gap === 'mute-across-end' ? WATCHDOG_BOUND_MS : options.gap === 'close-across-end' ? RESYNC_BOUND_MS : 8_000
    const settledIn = await waitFor(async () => {
      const state = await pageState()
      return !state.caret && !state.stop && state.lastText.includes(marker)
    }, bound, 200)
    const final = await pageState()
    await shot(`${name}-end`)
    if (profiling) {
      const { profile: cpu } = (await send('Profiler.stop')).result
      writeFileSync(new URL(`${name}.cpuprofile`, outDir), JSON.stringify(cpu))
      const self = new Map()
      const byId = new Map(cpu.nodes.map(node => [node.id, node]))
      const counts = new Map()
      for (const id of cpu.samples) counts.set(id, (counts.get(id) ?? 0) + 1)
      const step = (cpu.endTime - cpu.startTime) / cpu.samples.length / 1000
      for (const [id, count] of counts) {
        const frame = byId.get(id).callFrame
        const key = `${frame.functionName || '(anon)'} ${frame.url.split('/').pop()}:${String(frame.lineNumber + 1)}`
        self.set(key, (self.get(key) ?? 0) + count * step)
      }
      record(`${name}: cpu self time top 25 (ms)`, [...self].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, v]) => `${Math.round(v)} ${k}`))
    }
    record(`${name}: page after window`, {
      windowMs: bound, fromMs: gapClosedAt - sentAt, settledInMs: settledIn ?? null,
      caret: final.caret, stop: final.stop, markerShown: final.lastText.includes(marker), lastChars: final.lastText.length,
      socketLog: (await evaluate('window.__qaLog')).slice(-6).map(row => [row[0], row[1] - sentAt, ...row.slice(2)]),
      visibility: await evaluate('document.visibilityState'),
      pageDeltaTimes: (await evaluate('window.__qaTimes')).map(row => [row[0] - sentAt, row[1]]),
      hostDeltaTimes: hostEvents.slice(eventsBefore).filter(e => e.type === 'stream.text').map(e => e.at - sentAt),
      stalls: (await evaluate('window.__qaStalls')).map(row => [row[0] - sentAt, row[1]]),
      longestTaskMs: Math.max(0, ...(await evaluate('window.__qaLong')).map(row => row[1])),
      longTasks: (await evaluate('window.__qaLong')).length,
    })
    const newReports = await reportsSince(baseSeq)
    const notes = newReports.map(row => `${row.kind}/${row.grade}: ${row.message.slice(0, 160)}`)
    record(`${name}: host reports filed during the scenario`, notes)
    record(`${name}: page errors during the scenario`, pageErrors.slice(errorsBefore))
    if (options.gap === 'mute-across-end') await evaluate('window.__qaMute = false')
    return { settledIn, final, marker, notes }
  }

  /*
   * ---- e · a token-rate stream, no gap made by this script ----------------
   * Diagnostic, run alone with ONLY=e (E_CHUNKS, E_DELAY; DECLINE_SCRIPTS=1
   * declines the card's scripts first). It is how the main-thread stall was
   * measured: with 黑兽's scripts allowed the page stops handling frames for
   * several seconds early in every stream; declined, it keeps the host's pace.
   */
  const onlyE = process.env.ONLY === 'e'
  if (onlyE) {
    // E_REPEAT streams in one page session: the stall was measured to grow
    // with the number of generations the page has shown.
    for (let round = 1; round <= Number(process.env.E_REPEAT ?? 1); round += 1) {
      const e = await scenario(`e${String(round)}`, { chunks: Number(process.env.E_CHUNKS ?? 1200), delayMs: Number(process.env.E_DELAY ?? 25), boundMs: 120_000 })
      check(`e${String(round)}: a stream with no gap made by this script settles on the page`, e.settledIn !== undefined, `settled in ${String(e.settledIn)} ms after the host's end`)
    }
  }
  if (!onlyE) {

  // ---- a · control ---------------------------------------------------------
  const a = await scenario('a', { chunks: 20, delayMs: 150 })
  check('a: a normal stream settles — caret gone, Stop gone, the whole reply shown', a.settledIn !== undefined,
    `settled in ${String(a.settledIn)} ms after the host's stream.end`)

  // ---- b · the event socket is gone across the end -------------------------
  const b = await scenario('b', { chunks: 30, delayMs: 150, gap: 'close-across-end' })
  if (EXPECT === 'stuck') {
    check('b (unfixed): the page is still stuck after the reconnect — caret, Stop, reply cut short',
      b.settledIn === undefined && b.final.caret && b.final.stop && !b.final.lastText.includes(b.marker),
      `window ${String(RESYNC_BOUND_MS)} ms`)
  } else {
    check('b: after the socket reconnects the page resyncs — caret gone, Stop gone, whole reply shown',
      b.settledIn !== undefined, `within ${String(b.settledIn)} ms of the gap closing (bound ${String(RESYNC_BOUND_MS)} ms)`)
    check('b: the resync is on the record as a host note', b.notes.some(line => /resynced/.test(line)), b.notes.filter(line => /resync/.test(line)).join(' | ') || 'none')
  }

  // ---- c · a socket that never closes but delivers nothing -----------------
  const c = await scenario('c', { chunks: 30, delayMs: 150, gap: 'mute-across-end' })
  if (EXPECT === 'stuck') {
    check('c (unfixed): with a silent socket the page is still stuck at the end of the window',
      c.settledIn === undefined && c.final.caret, `window ${String(WATCHDOG_BOUND_MS)} ms`)
  } else {
    check('c: with a silent socket the watchdog resyncs within its bound', c.settledIn !== undefined,
      `within ${String(c.settledIn)} ms (bound ${String(WATCHDOG_BOUND_MS)} ms)`)
    check('c: the watchdog resync is on the record as a host note', c.notes.some(line => /resynced/.test(line)), c.notes.filter(line => /resync/.test(line)).join(' | ') || 'none')
  }

  // ---- d · a gap that closes while the host is still generating ------------
  const d = await scenario('d', { chunks: 40, delayMs: 200, gap: 'close-mid' })
  check('d: a gap that closes mid-stream still ends settled', d.settledIn !== undefined, `settled in ${String(d.settledIn)} ms`)
  }

  // The host's own hang-ups (rpc-host §3), read off its log for the whole run.
  record('host log: event-socket drops during the run', hostOutput.split('\n').filter(line => line.includes('event socket:')).map(line => line.trim().slice(0, 240)))
  writeFileSync(new URL(`readings-${onlyE ? "e" : EXPECT}.json`, outDir), `${JSON.stringify(readings, null, 2)}\n`)
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${String(failures)} CHECK(S) FAILED`}`)
} catch (error) {
  console.error(`FAIL  ${String(error?.stack ?? error)}`)
  failures += 1
} finally {
  clearTimeout(HARD)
  try { watcher?.close() } catch { /* already closed */ }
  fake.close()
  await profile.dispose().catch(() => undefined)
  await data.dispose().catch(() => undefined)
}
process.exit(failures === 0 ? 0 : 1)
