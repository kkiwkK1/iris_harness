/**
 * What one streaming delta costs the page, and whether a reply can stall.
 *
 * The owner's two reports (2026-09-26): the UI stutters while a reply streams,
 * and the interfaces of floors that are not streaming re-render with it; and
 * sometimes the caret keeps blinking with no text arriving, while a reload
 * shows the host had the whole reply.
 *
 * This drives a real host on a **copied** data dir through a **fake
 * OpenAI-compatible endpoint** (no model money), on the 黑兽 conversation, and
 * reads the page through three instruments installed before any page script:
 *
 * - **React commits.** A `__REACT_DEVTOOLS_GLOBAL_HOOK__` stub: React calls
 *   `onCommitFiberRoot` on every commit, production builds included. Each
 *   commit is walked for function components that actually ran their render
 *   (`PerformedWork`), and each such fiber is attributed to the row it sits in —
 *   the streaming row, a settled row, the composer, or elsewhere. A subtree
 *   whose child pointer did not change was bailed out and is not walked, so a
 *   stale flag from an earlier commit is never counted. Component names need a
 *   build without minification (`IRIS_WEB_DIST`, see below); minified, the
 *   per-row split still works because the row is found by its props.
 * - **CPU.** The CDP sampling profiler over the streaming window, with the time
 *   under React's `performWorkOnRoot` summed as "React work".
 * - **Frames.** Every `<iframe>` added to or removed from the document, every
 *   `createElement('iframe')`, and every `message` a frame posts to the shell,
 *   each attributed to the floor of the row it sits in.
 *
 * Modes (`MODE`):
 *
 * - `perf` (default): `ROUNDS` streams of `CHUNKS` chunks every `DELAY_MS`
 *   (defaults 3, 120, 50) in one page session; readings per delta.
 * - `stall`: `ROUNDS` long streams (default 6 × 400 chunks × 50 ms) with
 *   `TABS` pages (default 3) on the same conversation; `DROP=1` closes the
 *   first tab's event socket from the page side once per stream, a third of
 *   the way in, and lets it reconnect at once. Per tab and per round: when
 *   the page settled after the host's `stream.end`, main-thread gaps, and
 *   the socket log.
 *
 * `IRIS_WEB_DIST` points the host at another build (an unminified one for
 * names). `IRIS_PORT` defaults to 8801 and is asserted free before launch.
 *
 * Exit: 0 = ran (readings are the product; `MODE=stall` fails if a tab never
 * settled inside `SETTLE_BOUND_MS`), 1 = a check failed, 2 = port/data trouble.
 *
 * Usage: node qa/stream-perf-acceptance.mjs
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
const CDP = String(cdpPort(9371))
const MODE = process.env.MODE ?? 'perf'
const ROUNDS = Number(process.env.ROUNDS ?? (MODE === 'stall' ? 6 : 3))
const CHUNKS = Number(process.env.CHUNKS ?? (MODE === 'stall' ? 400 : 120))
const DELAY_MS = Number(process.env.DELAY_MS ?? 50)
const TABS = Number(process.env.TABS ?? (MODE === 'stall' ? 3 : 1))
const DROP = process.env.DROP === '1'
/** The watchdog (20 s) plus a reconnect and a render. */
const SETTLE_BOUND_MS = Number(process.env.SETTLE_BOUND_MS ?? 30_000)
const LABEL = process.env.LABEL ?? 'run'

const outDir = new URL('./results/stream-perf/', import.meta.url)
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
const listening = new Set((spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? '').split('\n')
  .filter(line => line.includes('LISTENING'))
  .map(line => /:(\d+)\s/.exec(line)?.[1])
  .filter(port => port !== undefined)
  .map(Number))
const PORT = Number(process.env.IRIS_PORT ?? 8801)
if (listening.has(PORT)) {
  console.error(`FAIL  port ${String(PORT)} is already listening — refusing to start`)
  process.exit(2)
}
const BASE = `http://127.0.0.1:${String(PORT)}`

/* ---- the fake endpoint --------------------------------------------------- */
const plan = { text: '', chunks: CHUNKS, delayMs: DELAY_MS }
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
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
    const { text, chunks, delayMs } = plan
    const size = Math.max(1, Math.ceil(text.length / chunks))
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
const data = dataCopy('iris-stream-perf-qa-')
const dataDir = data.dir
const dataSource = process.env.IRIS_DATA_SOURCE
  ?? join(repoRoot, '..', 'iris_cordis_traven', 'apps', 'iris', 'data')
await cp(dataSource, dataDir, { recursive: true }).catch(error => {
  console.error(`FAIL  no data dir to copy from (${dataSource}): ${String(error)}`)
  process.exit(2)
})
await rm(join(dataDir, 'host.lock'), { force: true })
await rm(join(dataDir, 'default-user', 'host.lock'), { force: true })

const WANTED = process.env.IRIS_CHAT_PREFIX ?? '黑兽-2'
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
/** The owner's newest long reply, repeated to reach the chunk count, with an end marker. */
const replyWith = (marker, chunks) => {
  const base = ownerReply === '' ? `第一段。\n\n${'他没有回答，只是看着。'.repeat(60)}` : ownerReply
  const cut = base.indexOf('<UpdateVariable>')
  const prose = cut === -1 ? base : base.slice(0, cut)
  const tail = cut === -1 ? '' : base.slice(cut)
  // At least ~12 characters per chunk, so a long stream is long in text too.
  let body = prose
  while (body.length < chunks * 12) body += `\n\n${prose}`
  return `${body}${marker}\n\n${tail}`
}

let hostOutput = ''
const host = data.adopt(spawn(process.execPath, ['apps/iris/bin.ts'], {
  cwd: repoRoot,
  env: { ...process.env, IRIS_PORT: String(PORT), IRIS_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
}))
host.stdout.on('data', chunk => { hostOutput += String(chunk) })
host.stderr.on('data', chunk => { hostOutput += String(chunk) })
console.log(`host PID ${String(host.pid)} on ${String(PORT)}, fake ${FAKE}, MODE=${MODE} LABEL=${LABEL} dist=${process.env.IRIS_WEB_DIST ?? '(default)'}`)

let seq = 0
const rpc = async (method, params = {}) => {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-perf-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 1_800_000)

/*
 * The page-side instruments, installed before any page script runs. Kept in
 * one string so every tab gets the same ones.
 */
const INSTRUMENTS = `(() => {
  if (window.__qa !== undefined) return
  const qa = window.__qa = {
    commits: [], names: {}, origins: {}, frameKinds: {}, blockedLines: {}, iframesAdded: [], iframesRemoved: [], iframesCreated: 0,
    frameMessages: {}, deltas: [], sockets: [], log: [], stalls: [], mute: false, block: false,
    arm: undefined, streamingFloor: undefined,
  }
  /* ---- React commits ---- */
  const nameOf = fiber => {
    const type = fiber.type
    if (type == null) return undefined
    if (typeof type === 'function') return type.displayName || type.name || 'anon'
    if (typeof type === 'object') {
      const inner = type.render ?? type.type
      if (typeof inner === 'function') return type.displayName || inner.displayName || inner.name || 'anon'
    }
    return undefined
  }
  const COMPONENT = new Set([0, 1, 11, 14, 15])
  const walk = root => {
    const out = { total: 0, streaming: 0, settled: 0, composer: 0, other: 0, settledRows: 0, settledInterfaces: 0, composerRan: 0 }
    const stack = [[root.current, 0, false, false]]
    while (stack.length > 0) {
      const [fiber, row, inComposer, parentRan] = stack.pop()
      let ran = parentRan
      let nextRow = row
      let nextComposer = inComposer
      const props = fiber.memoizedProps
      const name = COMPONENT.has(fiber.tag) ? nameOf(fiber) : undefined
      if (props != null && typeof props === 'object' && props.message != null && typeof props.message === 'object'
        && typeof props.message.id === 'number' && props.handlers !== undefined) {
        nextRow = props.message.streaming === true ? 1 : 2
      }
      if (name === 'Composer') nextComposer = true
      if (COMPONENT.has(fiber.tag)) ran = (fiber.flags & 1) === 1
      if (COMPONENT.has(fiber.tag) && (fiber.flags & 1) === 1) {
        if (!parentRan) qa.origins[name] = (qa.origins[name] ?? 0) + 1
        out.total += 1
        qa.names[name] = (qa.names[name] ?? 0) + 1
        if (nextComposer) { out.composer += 1; if (name === 'Composer') out.composerRan += 1 }
        else if (nextRow === 1) out.streaming += 1
        else if (nextRow === 2) {
          out.settled += 1
          if (name === 'Message') out.settledRows += 1
          if (name === 'MessageInterfaces') out.settledInterfaces += 1
        } else out.other += 1
      }
      const alternate = fiber.alternate
      if (fiber.child !== null && (alternate === null || fiber.child !== alternate.child)) {
        for (let child = fiber.child; child !== null; child = child.sibling) stack.push([child, nextRow, nextComposer, ran])
      }
    }
    return out
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false, checkDCE() {},
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id },
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      if (!qa.recording) return
      const began = performance.now()
      const counts = walk(root)
      qa.commits.push([Math.round(began), counts.total, counts.streaming, counts.settled, counts.composer, counts.other, counts.settledRows, counts.settledInterfaces, counts.composerRan, Math.round((performance.now() - began) * 100) / 100])
    },
  }
  /* ---- frames ---- */
  const floorOf = node => node?.closest?.('[data-floor]')?.getAttribute('data-floor') ?? 'none'
  const createElement = Document.prototype.createElement
  Document.prototype.createElement = function (tag, options) {
    if (qa.recording && String(tag).toLowerCase() === 'iframe') qa.iframesCreated += 1
    return createElement.call(this, tag, options)
  }
  const iframesIn = node => node.nodeType !== 1 ? [] : node.tagName === 'IFRAME' ? [node] : [...node.querySelectorAll('iframe')]
  new MutationObserver(records => {
    if (!qa.recording) return
    for (const record of records) {
      for (const node of record.addedNodes) for (const frame of iframesIn(node)) qa.iframesAdded.push(floorOf(frame))
      for (const node of record.removedNodes) for (const frame of iframesIn(node)) qa.iframesRemoved.push(floorOf(record.target))
    }
  }).observe(document, { childList: true, subtree: true })
  window.addEventListener('message', event => {
    if (!qa.recording || event.source === window || event.source === null) return
    let floor = 'unknown'
    for (const frame of document.querySelectorAll('iframe')) {
      if (frame.contentWindow === event.source) { floor = floorOf(frame); break }
    }
    qa.frameMessages[floor] = (qa.frameMessages[floor] ?? 0) + 1
    const d = event.data
    const kind = floor + ':' + (d !== null && typeof d === 'object' ? String(d.type ?? d.kind ?? d.method ?? Object.keys(d).slice(0, 3).join('|')) + (d.method !== undefined && d.type !== undefined ? '/' + String(d.method) : '') : typeof d)
    qa.frameKinds[kind] = (qa.frameKinds[kind] ?? 0) + 1
    if (d !== null && typeof d === 'object' && d.type === 'blocked') {
      const line = floor + ' ' + String(d.host) + ' ' + String(d.directive) + ' ' + String(d.detail ?? '').slice(0, 80)
      qa.blockedLines[line] = (qa.blockedLines[line] ?? 0) + 1
    }
  }, true)
  /* ---- main-thread gaps ---- */
  let lastTick = Date.now()
  setInterval(() => {
    const now = Date.now()
    if (now - lastTick > 500) qa.stalls.push([lastTick, now - lastTick])
    lastTick = now
  }, 100)
  /* ---- the event socket ---- */
  const Native = window.WebSocket
  class Controlled extends Native {
    constructor(url, protocols) {
      const events = String(url).includes('/iris/events')
      if (events && qa.block) { qa.log.push(['refused', Date.now()]); throw new Error('qa: refused') }
      super(url, protocols)
      if (!events) return
      qa.sockets.push(this)
      qa.log.push(['construct', Date.now()])
      super.addEventListener('open', () => qa.log.push(['open', Date.now()]))
      super.addEventListener('close', () => qa.log.push(['close', Date.now()]))
      this.__events = true
    }
    addEventListener(type, listener, options) {
      if (this.__events !== true || type !== 'message') return super.addEventListener(type, listener, options)
      return super.addEventListener(type, event => {
        if (qa.mute) return
        const text = String(event.data)
        const delta = text.startsWith('{"type":"stream.text"')
        const began = performance.now()
        listener.call(this, event)
        if (delta) qa.deltas.push([Date.now(), Math.round((performance.now() - began) * 100) / 100])
        if (text.startsWith('{"type":"stream.end"')) qa.log.push(['stream.end', Date.now()])
        const arm = qa.arm
        if (arm !== undefined && delta) {
          arm.seen += 1
          if (arm.seen >= arm.after) { qa.arm = undefined; qa.log.push(['drop', Date.now(), arm.seen]); this.close() }
        }
      }, options)
    }
  }
  window.WebSocket = Controlled
})()`

let chrome
const profile = chromeProfile('iris-qa-perf-')
let watcher
try {
  let up = false
  for (let at = 0; at < 60 && !up; at += 1) {
    await delay(500)
    if (hostOutput.includes('EADDRINUSE')) { console.error(`FAIL  EADDRINUSE on ${String(PORT)}`); process.exit(2) }
    up = await rpc('character.list').then(() => true).catch(() => false)
  }
  if (!up) throw new Error(`the host on ${String(PORT)} never answered\n${hostOutput}`)

  const chats = (await rpc('chat.list')).chats ?? []
  const chat = chats.find(row => row.chatId === chatFile?.replace(/\.jsonl$/, ''))
  if (chat === undefined) { console.error(`FAIL  no ${WANTED} conversation in the copy`); process.exit(2) }
  record('conversation', { chatId: chat.chatId, title: chat.title, ownerReplyChars: ownerReply.length })

  const saved = await rpc('connection.save', { provider: 'default', model: 'qa-fake-stream', baseURL: FAKE, label: 'qa-fake-stream' })
  const profileId = saved.profiles.find(row => row.label === 'qa-fake-stream')?.id
  if (profileId === undefined) throw new Error('connection.save returned no qa profile')
  await rpc('connection.activate', { id: profileId })
  await rpc('connection.activate', { id: profileId, chatId: chat.chatId })

  const hostEvents = []
  watcher = new WebSocket(`${BASE.replace(/^http/, 'ws')}/iris/events`)
  await new Promise((res, rej) => { watcher.onopen = res; watcher.onerror = rej })
  watcher.onmessage = message => {
    const event = JSON.parse(String(message.data))
    if (event.chatId === chat.chatId && String(event.type).startsWith('stream.')) {
      hostEvents.push({ type: event.type, at: Date.now(), bytes: String(message.data).length })
    }
  }

  chrome = profile.adopt(spawn(CHROME, [
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile.dir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    '--window-size=1480,1000', 'about:blank',
  ], { stdio: 'ignore' }))
  let version
  for (let at = 0; at < 40 && version === undefined; at += 1) {
    await delay(500)
    try { version = await fetch(`http://127.0.0.1:${CDP}/json/version`).then(r => r.json()) } catch { /* not up */ }
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
  }
  const raw = (method, params = {}, sessionId) => new Promise(res => {
    const id = ++wsSeq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  })

  /** One page on the conversation. */
  const openTab = async index => {
    const { targetId } = (await raw('Target.createTarget', { url: 'about:blank' })).result
    const session = (await raw('Target.attachToTarget', { targetId, flatten: true })).result.sessionId
    const send = (method, params = {}) => raw(method, params, session)
    const evaluate = async expression => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.result?.exceptionDetails !== undefined) throw new Error(`evaluate: ${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`)
      return r.result?.result?.value
    }
    await send('Page.enable')
    await send('Runtime.enable')
    // Every tab is "visible" to the page: headless tabs are not backgrounded
    // by focus, and a hidden tab would void timers and rAF alike.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENTS })
    await send('Page.navigate', { url: `${BASE}/` })
    for (let at = 0; at < 60; at += 1) {
      await delay(500)
      if (await evaluate('document.querySelector(".iris-composer__field") !== null') === true) break
    }
    const opened = await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      document.querySelector('[data-tab="chats"]')?.click()
      for (let at = 0; at < 40; at += 1) {
        const rows = [...document.querySelectorAll('.iris-row--chat')]
          .filter(el => (el.querySelector('.iris-row__title')?.textContent ?? '').trim() === ${JSON.stringify(chat.title)})
        if (rows.length >= 1) { rows[0].click(); return true }
        await sleep(250)
      }
      return false
    })()`)
    if (opened !== true) {
      const seen = await evaluate(`({ url: location.href, text: (document.body?.innerText ?? '').slice(0, 600), rows: document.querySelectorAll('.iris-row--chat').length })`)
      throw new Error(`tab ${String(index)}: the conversation row never appeared — ${JSON.stringify(seen)}`)
    }
    await delay(6000)
    return { index, send, evaluate }
  }

  const tabs = []
  for (let index = 0; index < TABS; index += 1) tabs.push(await openTab(index))
  const main = tabs[0]
  record('tabs open', TABS)
  record('floors mounted / iframes on the page (tab 0)', await main.evaluate(`({ floors: document.querySelectorAll('[data-floor]').length, iframes: document.querySelectorAll('iframe').length })`))

  const PAGE_STATE = `(() => {
    const texts = [...document.querySelectorAll('.iris-msg__text')]
    const last = texts.at(-1)
    return {
      caret: document.querySelector('.iris-caret') !== null,
      stop: document.querySelector('.iris-composer__send--stop') !== null,
      lastText: last === undefined ? '' : last.textContent ?? '',
    }
  })()`
  const waitFor = async (predicate, timeoutMs, stepMs = 100) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return Date.now() - start
      await delay(stepMs)
    }
    return undefined
  }
  const sendLine = async (tab, text) => {
    const typed = await tab.evaluate(`(() => {
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
    await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }

  const REACT_WORK = new Set(['performWorkOnRoot', 'performWorkOnRootViaSchedulerTask', 'flushSyncWorkAcrossRoots_impl', 'commitRoot'])
  const summarizeProfile = cpu => {
    const byId = new Map(cpu.nodes.map(node => [node.id, node]))
    const parent = new Map()
    for (const node of cpu.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
    const underReact = new Map()
    const isReact = id => {
      if (underReact.has(id)) return underReact.get(id)
      const node = byId.get(id)
      const up = parent.get(id)
      const value = REACT_WORK.has(node.callFrame.functionName) || (up !== undefined && isReact(up))
      underReact.set(id, value)
      return value
    }
    let react = 0
    let busy = 0
    const self = new Map()
    for (let at = 0; at < cpu.samples.length; at += 1) {
      const id = cpu.samples[at]
      const step = (cpu.timeDeltas[at + 1] ?? cpu.timeDeltas[at] ?? 0) / 1000
      const frame = byId.get(id).callFrame
      if (frame.functionName !== '(idle)' && frame.functionName !== '(program)' && frame.functionName !== '(garbage collector)') busy += step
      if (isReact(id)) react += step
      const key = `${frame.functionName || '(anon)'} ${frame.url.split('/').pop()}:${String(frame.lineNumber + 1)}`
      self.set(key, (self.get(key) ?? 0) + step)
    }
    return {
      busyMs: Math.round(busy),
      reactMs: Math.round(react),
      topSelf: [...self].filter(([k]) => !k.startsWith('(idle)')).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => `${Math.round(v)} ${k}`),
    }
  }

  /*
   * The idle control: the same instruments over a window with no stream. What
   * the page does here it does regardless of streaming, so a per-delta figure
   * is only attributable to the deltas once this has been subtracted.
   */
  const IDLE_MS = Number(process.env.IDLE_MS ?? 8000)
  await main.evaluate(`Object.assign(window.__qa, { commits: [], names: {}, origins: {}, frameKinds: {}, iframesAdded: [], iframesRemoved: [], iframesCreated: 0, frameMessages: {}, deltas: [], stalls: [], log: [], recording: true })`)
  await main.send('Profiler.enable')
  await main.send('Profiler.setSamplingInterval', { interval: 250 })
  await main.send('Profiler.start')
  if (process.env.PROBE_RESIZE === '1') {
    // Diagnostic: does re-laying-out the page make the card's frames re-request
    // what the policy refuses? Twenty height changes of the viewport, 100 ms apart.
    for (let at = 0; at < 20; at += 1) {
      await main.send('Emulation.setDeviceMetricsOverride', { width: 1480, height: 1000 - (at % 2) * 40, deviceScaleFactor: 1, mobile: false })
      await delay(100)
    }
    await main.send('Emulation.clearDeviceMetricsOverride')
  }
  await delay(IDLE_MS)
  {
    const q = await main.evaluate(`(() => { const q = window.__qa; q.recording = false; return { commits: q.commits, frameMessages: q.frameMessages, names: q.names, origins: q.origins, iframesCreated: q.iframesCreated, frameKinds: q.frameKinds } })()`)
    const { profile: cpu } = (await main.send('Profiler.stop')).result
    const idle = summarizeProfile(cpu)
    record('idle control (no stream)', {
      windowMs: IDLE_MS,
      commits: q.commits.length,
      renderedFibers: q.commits.reduce((t, row) => t + row[1], 0),
      composerRenders: q.commits.reduce((t, row) => t + row[8], 0),
      frameMessages: q.frameMessages,
      iframesCreated: q.iframesCreated,
      busyMs: idle.busyMs,
      topNames: Object.entries(q.names).sort((x, y) => y[1] - x[1]).slice(0, 8),
      origins: Object.entries(q.origins).sort((x, y) => y[1] - x[1]).slice(0, 12),
      frameKinds: Object.entries(q.frameKinds ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 8),
    })
  }

  const results = []
  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const tab of tabs) {
      const state = await tab.evaluate(PAGE_STATE)
      if (state.caret || state.stop) record(`round ${String(round)}: tab ${String(tab.index)} still generating before send`, state)
    }
    const marker = `【QA-END-${String(round)}-${String(Date.now() % 100000)}】`
    Object.assign(plan, { text: replyWith(marker, CHUNKS), chunks: CHUNKS, delayMs: DELAY_MS })
    for (const tab of tabs) {
      await tab.evaluate(`Object.assign(window.__qa, { commits: [], names: {}, origins: {}, frameKinds: {}, blockedLines: {}, iframesAdded: [], iframesRemoved: [], iframesCreated: 0, frameMessages: {}, deltas: [], stalls: [], log: [], recording: true, streamingFloor: undefined })`)
    }
    if (DROP) await main.evaluate(`window.__qa.arm = { after: ${String(Math.floor(CHUNKS / 3))}, seen: 0 }`)
    const eventsBefore = hostEvents.length
    const errorsBefore = pageErrors.length
    await main.send('Profiler.enable')
    await main.send('Profiler.setSamplingInterval', { interval: 250 })
    await main.send('Profiler.start')
    const sentAt = Date.now()
    await sendLine(main, `qa round ${String(round)}`)
    // The streaming floor, read once the row exists.
    await waitFor(async () => (await main.evaluate(`(() => {
      const caret = document.querySelector('.iris-caret')
      if (caret === null) return false
      window.__qa.streamingFloor = caret.closest('[data-floor]')?.getAttribute('data-floor')
      return true
    })()`)) === true, 20_000, 50)

    const hostEnd = () => hostEvents.slice(eventsBefore).find(e => e.type === 'stream.end' || e.type === 'stream.error')
    await waitFor(async () => hostEnd() !== undefined, CHUNKS * DELAY_MS * 3 + 60_000, 200)
    const end = hostEnd()
    if (end === undefined) throw new Error(`round ${String(round)}: the host never settled`)
    const hostDeltas = hostEvents.slice(eventsBefore).filter(e => e.type === 'stream.text').length

    const perTab = []
    for (const tab of tabs) {
      const settledIn = await waitFor(async () => {
        const state = await tab.evaluate(PAGE_STATE)
        return !state.caret && !state.stop && state.lastText.includes(marker)
      }, SETTLE_BOUND_MS, 200)
      const final = await tab.evaluate(PAGE_STATE)
      const qa = await tab.evaluate(`(() => { const q = window.__qa; q.recording = false; return { commits: q.commits, names: q.names, origins: q.origins, frameKinds: q.frameKinds, blockedLines: q.blockedLines, iframesAdded: q.iframesAdded, iframesRemoved: q.iframesRemoved, iframesCreated: q.iframesCreated, frameMessages: q.frameMessages, deltas: q.deltas, stalls: q.stalls, log: q.log, streamingFloor: q.streamingFloor } })()`)
      perTab.push({ tab: tab.index, settledIn, final, qa })
    }
    const { profile: cpu } = (await main.send('Profiler.stop')).result
    writeFileSync(new URL(`${LABEL}-round${String(round)}.cpuprofile`, outDir), JSON.stringify(cpu))
    const cpuSummary = summarizeProfile(cpu)

    const m = perTab[0].qa
    const streamWindow = m.deltas.length === 0 ? [0, 0] : [m.deltas[0][0], m.deltas.at(-1)[0]]
    const commitsInWindow = m.commits.length
    const sum = index => m.commits.reduce((total, row) => total + row[index], 0)
    const streamingFloor = m.streamingFloor
    const otherFloors = obj => Object.entries(obj).filter(([floor]) => floor !== streamingFloor).reduce((t, [, n]) => t + n, 0)
    const addedOther = m.iframesAdded.filter(floor => floor !== streamingFloor).length
    const removedOther = m.iframesRemoved.filter(floor => floor !== streamingFloor).length
    const deltas = m.deltas.length
    const per = n => deltas === 0 ? null : Math.round((n / deltas) * 100) / 100
    const summary = {
      round,
      hostDeltas,
      pageDeltas: deltas,
      streamSpanMs: streamWindow[1] - streamWindow[0],
      streamingFloor,
      commits: commitsInWindow,
      commitsPerDelta: per(commitsInWindow),
      renderedFibersPerDelta: per(sum(1)),
      streamingRowFibersPerDelta: per(sum(2)),
      settledRowFibersPerDelta: per(sum(3)),
      settledMessageRendersPerDelta: per(sum(6)),
      settledInterfaceRendersPerDelta: per(sum(7)),
      composerFibersPerDelta: per(sum(4)),
      composerRendersTotal: sum(8),
      otherFibersPerDelta: per(sum(5)),
      reactMsPerDelta: per(cpuSummary.reactMs),
      busyMsPerDelta: per(cpuSummary.busyMs),
      reactMsTotal: cpuSummary.reactMs,
      busyMsTotal: cpuSummary.busyMs,
      listenerMsMax: Math.max(0, ...m.deltas.map(row => row[1])),
      iframesCreated: m.iframesCreated,
      iframesAddedOtherFloors: addedOther,
      iframesRemovedOtherFloors: removedOther,
      iframesAddedStreamingFloor: m.iframesAdded.length - addedOther,
      frameMessagesOtherFloors: otherFloors(m.frameMessages),
      frameMessagesStreamingFloor: m.frameMessages[streamingFloor] ?? 0,
      frameMessagesByFloor: m.frameMessages,
      topNames: Object.entries(m.names).sort((x, y) => y[1] - x[1]).slice(0, 12),
      origins: Object.entries(m.origins).sort((x, y) => y[1] - x[1]).slice(0, 12),
      frameKinds: Object.entries(m.frameKinds ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 12),
      blockedDistinct: Object.keys(m.blockedLines ?? {}).length,
      blockedSample: Object.entries(m.blockedLines ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 4),
      topSelf: cpuSummary.topSelf,
      tabs: perTab.map(t => ({
        tab: t.tab,
        settledAfterHostEndMs: t.settledIn ?? null,
        stuck: t.settledIn === undefined,
        caret: t.final.caret,
        stop: t.final.stop,
        markerShown: t.final.lastText.includes(marker),
        pageDeltas: t.qa.deltas.length,
        longestGapMs: Math.max(0, ...t.qa.stalls.map(row => row[1])),
        gapsOver1s: t.qa.stalls.filter(row => row[1] > 1000).length,
        socketLog: t.qa.log.map(row => [row[0], row[1] - sentAt, ...row.slice(2)]),
      })),
      pageErrors: pageErrors.slice(errorsBefore).map(e => String(e.text).slice(0, 200)),
    }
    record(`round ${String(round)}`, summary)
    results.push(summary)
    if (MODE === 'stall') {
      for (const t of summary.tabs) {
        check(`round ${String(round)} tab ${String(t.tab)}: settles within ${String(SETTLE_BOUND_MS)} ms of the host's stream.end`, !t.stuck, `after ${String(t.settledAfterHostEndMs)} ms`)
      }
    }
    await delay(1500)
  }
  record('host log: event-socket drops', hostOutput.split('\n').filter(line => line.includes('event socket:')).map(line => line.trim().slice(0, 240)))
  record('host reports: resync notes', ((await rpc('debug.reports', {})).reports ?? []).filter(row => /resync/.test(row.message)).map(row => row.message.slice(0, 200)))
  writeFileSync(new URL(`${LABEL}-${MODE}.json`, outDir), `${JSON.stringify({ label: LABEL, mode: MODE, rounds: ROUNDS, chunks: CHUNKS, delayMs: DELAY_MS, tabs: TABS, drop: DROP, results, readings }, null, 2)}\n`)
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
