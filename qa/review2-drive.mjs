// REVIEW-2 card-family regression driver. One card per invocation.
//
// This is an instrument for the card-family acceptance record,
// `notes/CARD-REGRESSION-2026-09-17.md`:
// it opens a NEW conversation for one card through the real UI, records the
// greeting's shape, sends one real turn, records the reply's shape, reads the
// state panel and the diagnostics surface, then optionally regenerates and
// swipes back to test per-candidate variable state (U2).
//
// Usage:
//   node qa/review2-drive.mjs <characterId> "<display name>" [flags]
// Flags:
//   --turn "<text>"     the turn text (default: a neutral keep-in-character line)
//   --swipe             after the reply, regenerate once and swipe back to 0,
//                       recording message-scope variables at each step (U2)
//   --no-turn           greeting only (no generation)
//   --cdp <port>        explicit debug port (default 9700 + pid%100)
//
// Reads/writes under qa/results/review2/. Not part of any build.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import { chromeProfile } from './chrome-profile.mjs'

const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8787'
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const argv = process.argv.slice(2)
const characterId = argv[0]
const displayName = argv[1]
if (characterId === undefined || displayName === undefined) {
  console.error('usage: node qa/review2-drive.mjs <characterId> "<display name>" [--turn "..."] [--swipe] [--no-turn]')
  process.exit(64)
}
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const TURN = value('--turn', '（验收连通性测试）请用一两句话继续当前场景，保持角色本身，并照常输出你需要的格式标记。')
const DO_SWIPE = flag('--swipe')
const NO_TURN = flag('--no-turn')
const CDP_PORT = String(Number(value('--cdp', String(9700 + (process.pid % 100)))))

const outDir = new URL('./results/review2/', import.meta.url)
mkdirSync(outDir, { recursive: true })
const slug = characterId.replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 48)
const result = { characterId, displayName, base: BASE, at: new Date().toISOString(), turnText: TURN, flags: { swipe: DO_SWIPE, noTurn: NO_TURN } }

// ---------------------------------------------------------------- RPC
let seq = 0
async function rpc(method, params = {}) {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `r2-${++seq}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  return res.json()
}
async function call(method, params = {}) {
  const frame = await rpc(method, params)
  if (frame.ok === false) {
    const err = new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
    err.code = frame.error?.code
    throw err
  }
  return frame.result
}
async function debugReports() {
  const frame = await rpc('debug.reports', {})
  return frame.ok === false ? { reports: [] } : frame.result
}

function summarizeVars(vars) {
  if (vars === null || vars === undefined) return null
  const out = {}
  for (const [k, v] of Object.entries(vars)) {
    out[k] = v !== null && typeof v === 'object'
      ? { keys: Object.keys(v).slice(0, 10), bytes: JSON.stringify(v)?.length ?? 0 }
      : v
  }
  return out
}

// ---------------------------------------------------------------- CDP
function socket(url) {
  const ws = new WebSocket(url)
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`socket failed: ${url}`)) })
  let id = 0
  const pending = new Map()
  const consoleLines = []
  const httpFailures = []
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ')
      consoleLines.push({ level: msg.params.type, text: String(text).slice(0, 260) })
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleLines.push({ level: 'exception', text: String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '?').slice(0, 260) })
    }
    if (msg.method === 'Log.entryAdded') {
      consoleLines.push({ level: msg.params.entry?.level ?? 'log', text: String(msg.params.entry?.text ?? '').slice(0, 260) })
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
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
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

const readStateExpr = `(() => {
  const text = sel => [...document.querySelectorAll(sel)].map(e => (e.textContent ?? '').trim().replaceAll('\\n', ' ⏎ ').slice(0, 500)).filter(t => t.length > 0)
  const iframes = [...document.querySelectorAll('.iris-interfaces__slot iframe')]
  return {
    consentGate: [...document.querySelectorAll('.iris-grant__actions button')].map(b => (b.textContent ?? '').trim()),
    slots: [...document.querySelectorAll('.iris-interfaces__slot')].map(s => ({
      instance: s.dataset['instance'] ?? '',
      caption: (s.querySelector('.iris-interfaces__state')?.textContent ?? '').trim().replaceAll('\\n', ' ⏎ ').slice(0, 300),
      iframes: s.querySelectorAll('iframe').length,
    })),
    iframes: iframes.map(f => {
      const box = f.getBoundingClientRect()
      return { w: Math.round(box.width), h: Math.round(box.height), inline: f.style.height || '', sizing: f.dataset['irisSizing'] || '' }
    }),
    messages: [...document.querySelectorAll('.iris-msg')].map(m => ({
      floor: m.querySelector('.iris-msg__floor')?.textContent ?? '',
      who: m.querySelector('.iris-msg__who')?.textContent ?? '',
      textLen: (m.querySelector('.iris-msg__text')?.textContent ?? '').trim().length,
      swipes: (m.querySelector('.iris-rail__count')?.textContent ?? '').trim(),
    })),
    aside: (() => {
      const a = document.querySelector('.iris-aside')
      if (a === null) return { present: false }
      return { present: true, showing: a.getAttribute('data-iris-aside'), head: (a.querySelector('.iris-aside__head')?.textContent ?? '').trim(), text: (a.textContent ?? '').trim().replaceAll('\\n', ' ⏎ ').slice(0, 700) }
    })(),
    notices: text('.iris-notices__list li').slice(0, 20),
    // REVIEW-5 3.3: the folded scaffolding, one entry per .iris-bodyleak
    // details element. The edge field says which side of the body tag it came
    // from and text is what a reader sees when they expand it; the check is
    // that this is scaffolding (details, status placeholders), never a block
    // that should have built a frame. Written without backticks or regex
    // escapes because this whole expression is itself a template literal.
    bodyleaks: [...document.querySelectorAll('.iris-bodyleak')].map(el => ({
      edge: String(el.className).split('iris-bodyleak--')[1]?.split(' ')[0] ?? '',
      open: el.hasAttribute('open'),
      summary: (el.querySelector('.iris-bodyleak__summary')?.textContent ?? '').trim(),
      text: (el.querySelector('.iris-bodyleak__text')?.textContent ?? '').trim().split(String.fromCharCode(10)).join(' | ').slice(0, 400),
      len: (el.querySelector('.iris-bodyleak__text')?.textContent ?? '').length,
    })),
    panel: (() => {
      const VOCABULARY = /blocked|height sources|interface after|drawn nothing|timed out|failed|UnsupportedApiError|refused| KB of markup|failed to fetch|404|refused to/i
      const clip = s => (s ?? '').trim().replaceAll('\\n', ' ⏎ ').slice(0, 300)
      const ownText = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('')
      const rows = []
      const card = document.querySelector('#iris-card-scripts')
      for (const row of card === null ? [] : card.querySelectorAll('.iris-script__report')) {
        rows.push({ source: 'card', channel: row.querySelector('.iris-reports__area')?.textContent ?? null, fault: String(row.className).includes('--fault'), text: clip(ownText(row)) })
      }
      for (const row of document.querySelectorAll('.iris-notices__list li')) {
        rows.push({ source: 'notice', channel: null, fault: String(row.className).includes('--error'), text: clip(row.querySelector('.iris-reports__message')?.textContent ?? row.textContent) })
      }
      for (const row of document.querySelectorAll('.iris-reports__list li')) {
        rows.push({ source: 'host', channel: row.querySelector('.iris-reports__area')?.textContent ?? null, fault: String(row.className).includes('--fault'), text: clip(row.querySelector('.iris-reports__message')?.textContent ?? row.textContent) })
      }
      return { present: { card: card !== null, notices: document.querySelector('.iris-notices__list') !== null, host: document.querySelector('.iris-reports__list') !== null }, rows, matched: rows.filter(r => VOCABULARY.test(r.text)).map(r => r.text).slice(0, 40), unlisted: rows.filter(r => !VOCABULARY.test(r.text)).map(r => r.text).slice(0, 40) }
    })(),
    cardScriptsText: (() => {
      const el = document.querySelector('#iris-card-scripts')
      return el === null ? null : (el.textContent ?? '').trim().replaceAll('\\n', ' ⏎ ').slice(0, 1500)
    })(),
    composerPresent: document.querySelector('.iris-composer') !== null,
    drawerOpen: document.querySelector('.iris-drawer--open') !== null,
  }
})()`

const sampleFramesExpr = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const read = () => [...document.querySelectorAll('.iris-interfaces__slot iframe')].map(f => {
    const box = f.getBoundingClientRect()
    return { w: Math.round(box.width), h: Math.round(box.height), scrollH: f.contentWindow ? (() => { try { return f.contentWindow.document.body.scrollHeight } catch { return -1 } })() : -1 }
  })
  const samples = []
  for (let at = 0; at < 5; at += 1) { samples.push(read()); if (at < 4) await sleep(1500) }
  return samples
})()`

function frameStability(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return { frames: 0, stable: false, frames0: [] }
  const count = Math.max(...samples.map(s => s.length))
  const frames = []
  for (let i = 0; i < count; i += 1) {
    const sizes = samples.map(s => s[i] ? `${s[i].w}x${s[i].h}` : 'gone')
    const tail = sizes.slice(-3)
    frames.push({ index: i, sizes: [...new Set(sizes)], stable: new Set(tail).size === 1 })
  }
  return { frames: count, stable: frames.every(f => f.stable), detail: frames }
}

async function collectIframeProbes(port) {
  const probes = []
  let targets = []
  try { targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()) } catch { return probes }
  for (const t of targets.filter(x => x.type === 'iframe')) {
    const frame = socket(t.webSocketDebuggerUrl)
    try {
      await Promise.race([frame.opened, delay(4000).then(() => { throw new Error('socket timeout') })])
      await frame.send('Runtime.enable')
      const probe = await Promise.race([
        frame.evaluate(`(() => {
          const b = document.body
          if (!b) return { empty: true }
          const visible = [...b.querySelectorAll('*')].slice(0, 600).filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }).length
          return {
            title: document.title,
            bodyChildren: [...b.children].map(e => e.tagName + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '')).slice(0, 12),
            visibleBoxes: visible,
            textLen: (b.innerText ?? '').trim().length,
            scrollH: b.scrollHeight,
            viewport: document.documentElement.clientHeight,
            hasMvu: typeof window.Mvu !== 'undefined',
            buttons: [...b.querySelectorAll('button,[role=button],.iris-script-button,input[type=button]')].map(x => ((x.textContent ?? x.value ?? '').trim().slice(0, 40))).filter(Boolean).slice(0, 20),
            hasStorage: (() => { try { localStorage.setItem('iris-probe', '1'); localStorage.removeItem('iris-probe'); return true } catch { return false } })(),
          }
        })()`),
        delay(6000, () => ({ error: 'probe timeout' })),
      ])
      probes.push({ url: String(t.url).slice(0, 140), probe })
    } catch (e) {
      probes.push({ url: String(t.url).slice(0, 140), probe: { error: String(e.message ?? e) } })
    } finally { try { frame.ws.close() } catch { /* closed */ } }
  }
  return probes
}

async function newChatId(characterId, before) {
  const list = await call('chat.list', {})
  const mine = list.chats.filter(c => c.characterId === characterId && !before.has(c.chatId))
  return mine[0]?.chatId
}
async function waitForIdle(chatId, timeoutMs = 420_000) {
  const started = Date.now()
  const wsBase = BASE.replace(/^http/, 'ws')
  const ws = new WebSocket(new URL('/iris/events', wsBase))
  const events = []
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('event socket failed')) })
  ws.onmessage = m => { try { const e = JSON.parse(m.data); if (e.chatId === chatId) events.push(e) } catch { /* ignore */ } }
  const waitUntil = async (predicate, ms) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const hit = events.find(predicate)
      if (hit !== undefined) return hit
      await delay(250)
    }
    return undefined
  }
  return { events, waitUntil, close: () => ws.close(), started }
}

// ---------------------------------------------------------------- Phase A
console.log(`=== A. pre-flight ${characterId} ===`)
const chars = await call('character.list', {})
const me = chars.characters.find(c => c.characterId === characterId)
result.character = me === undefined ? null : { name: me.name, creator: me.creator, tags: me.tags, embedded: me.embeddedBookEntries, hasGreeting: me.hasGreeting }
const scripts = await call('script.list', { characterId })
result.scripts = {
  allowed: scripts.scriptsAllowed === undefined ? 'absent(unasked)' : scripts.scriptsAllowed,
  documentGranted: scripts.documentGranted,
  list: scripts.scripts.map(s => ({ name: s.name ?? s.id, bytes: s.bytes, enabled: s.enabled !== false })),
}
const listed = await call('regex.scopedList', { characterId }).catch(() => null)
result.scopedRegex = listed
const reportsBefore = await debugReports()
const beforeSeq = Math.max(0, ...(reportsBefore.reports ?? []).map(r => r.seq ?? 0))
const chatsBefore = await call('chat.list', {})
result.chatsBefore = chatsBefore.chats.filter(c => c.characterId === characterId).map(c => c.chatId)
console.log(`scriptsAllowed=${String(result.scripts.allowed)} scripts=${scripts.scripts.length} reports@${beforeSeq}`)

// ---------------------------------------------------------------- Phase B
let chatId
result.browser = await (async () => {
  const profile = chromeProfile('iris-r2-')
  const chrome = profile.adopt(spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile.dir}`, '--no-first-run', '--no-default-browser-check', '--headless=new', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' }))
  try {
    let page
    for (let at = 0; at < 30 && page === undefined; at += 1) {
      await delay(1000)
      try { const t = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json()); page = t.find(x => x.type === 'page' && x.url.startsWith('about:blank')) } catch { /* not up */ }
    }
    if (page === undefined) throw new Error('chrome never came up')
    const p = socket(page.webSocketDebuggerUrl)
    await p.opened
    await p.send('Page.enable'); await p.send('Runtime.enable'); await p.send('Log.enable'); await p.send('Network.enable')
    await p.send('Page.navigate', { url: BASE })
    await delay(7000)
    const boot = await p.evaluate(readStateExpr)

    // characters tab -> the card's row -> its page
    await p.evaluate(`document.querySelector('[data-tab=characters]')?.click()`)
    await delay(1200)
    const clicked = await p.evaluate(`(() => {
      const wanted = ${JSON.stringify(displayName)}
      const hit = [...document.querySelectorAll('.iris-list .iris-row')].filter(el => (el.querySelector('.iris-row__title')?.textContent ?? '').includes(wanted))
      if (hit.length === 0) return { error: 'no row named ' + wanted, names: [...document.querySelectorAll('.iris-list .iris-row .iris-row__title')].map(t => (t.textContent ?? '').trim()).slice(0, 25) }
      hit[0].click(); return { clicked: hit.length }
    })()`)
    if (clicked?.error !== undefined) throw new Error(`row click failed: ${clicked.error}`)
    await delay(2500)
    const face = await p.evaluate(`(() => ({ actions: [...document.querySelectorAll('.iris-face__actions button')].map(b => (b.textContent ?? '').trim()), grants: [...document.querySelectorAll('.iris-grant__actions button')].map(b => (b.textContent ?? '').trim()) }))()`)

    // create a NEW conversation through the face's own action
    const beforeIds = new Set((await call('chat.list', {})).chats.map(c => c.chatId))
    await p.evaluate(`(() => { const b = [...document.querySelectorAll('.iris-face__actions button')].find(x => /开始新对话|New conversation|Start/.test(x.textContent ?? '')) ?? document.querySelector('.iris-face__actions button'); b?.click(); return true })()`)
    let created
    for (let at = 0; at < 40 && created === undefined; at += 1) {
      await delay(500)
      created = await newChatId(characterId, beforeIds)
    }
    if (created === undefined) throw new Error('UI did not create a chat')
    chatId = created
    result.chatId = chatId

    // greeting: consent gate first, before any script effect (read at +2s,
    // before a card's scripts could have drawn anything)
    await delay(2000)
    const gate = await p.evaluate(readStateExpr)
    // let the greeting's interface frames boot before sampling their geometry
    await delay(10_000)
    const greetingProbes = await p.evaluate(readStateExpr)
    const gSamples = await p.evaluate(sampleFramesExpr)
    const greetingFrames = frameStability(gSamples)
    await delay(4000)
    const greetingAfter = await p.evaluate(readStateExpr)

    const shotG = await p.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })
    writeFileSync(new URL(`./results/review2/${slug}-greeting.jpeg`, import.meta.url), Buffer.from(shotG.result?.data ?? '', 'base64'))

    // one real turn
    let turn = null
    if (!NO_TURN) {
      const watcher = await waitForIdle(chatId)
      const started = Date.now()
      await call('chat.send', { chatId, text: TURN })
      const end = await watcher.waitUntil(e => e.type === 'stream.end', 420_000)
      turn = { seconds: Math.round((Date.now() - started) / 1000), reason: end?.reason ?? 'timeout-420s' }
      if (end === undefined) {
        const err = watcher.events.find(e => e.type === 'stream.error')
        turn.error = err === undefined ? 'no stream.end' : `${err.code ?? 'stream.error'}: ${err.message ?? ''}`
      } else {
        const last = end.view?.messages?.filter(m => m.role !== 'user').at(-1)
        turn.replyChars = last?.text?.length ?? 0
        turn.replyHead = (last?.text ?? '').replace(/\s+/g, ' ').slice(0, 160)
        turn.replyTail = (last?.text ?? '').replace(/\s+/g, ' ').slice(-160)
        turn.greetingChars = end.view?.messages?.[0]?.text?.length ?? 0
      }
      watcher.close()
      await delay(14_000) // reply-side interface frames mount after stream.end
    }
    const replyProbes = await p.evaluate(readStateExpr)
    const rSamples = await p.evaluate(sampleFramesExpr)
    const replyFrames = frameStability(rSamples)
    const shotR = await p.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })
    writeFileSync(new URL(`./results/review2/${slug}-reply.jpeg`, import.meta.url), Buffer.from(shotR.result?.data ?? '', 'base64'))

    const iframeProbes = await collectIframeProbes(CDP_PORT)

    // prompt breakdown: open the drawer's prompt panel is heavy; read the RPC
    // instead (same host assembly the panel shows).
    let itemize = null
    try {
      const it = await call('prompt.itemize', { chatId })
      const I = it.itemization
      // A `PromptItemEntry` carries no `text`: a zero row is `tokens === 0`.
      // Every such row must either name a reason or be a blank preset item
      // that is not a marker (the host only zeroes marker slots).
      const zero = I.entries.filter(e => e.tokens === 0)
      const explained = zero.filter(e => e.explanation?.zeroReason !== undefined)
      const unexplained = zero.filter(e => e.explanation?.zeroReason === undefined)
      itemize = {
        tokens: I.tokens,
        actualTokens: I.actualTokens,
        entries: I.entries.length,
        zeroEntries: zero.length,
        zeroExplained: explained.length,
        zeroUnexplained: unexplained.length,
        zeroUnexplainedRows: unexplained.slice(0, 20).map(e => ({ id: e.id, label: e.label, kind: e.kind, source: e.explanation?.source?.kind ?? null })),
        zeroKinds: [...new Set(zero.map(e => e.explanation?.zeroReason ?? '(none)'))],
        zeroReasons: zero.slice(0, 40).map(e => ({ label: e.label, kind: e.kind, source: e.explanation?.source?.kind ?? null, reason: e.explanation?.zeroReason ?? null })),
        messages: I.messages?.length ?? null,
        messageRoles: I.messages?.map(m => m.role) ?? null,
        stablePrefixTokens: I.stablePrefixTokens,
        droppedHistory: I.droppedHistory,
        preview: I.preview,
        deferred: I.entries.filter(e => e.deferred === true).map(e => e.label).slice(0, 20),
        promoted: I.entries.filter(e => e.promoted === true).map(e => e.label).slice(0, 20),
      }
    } catch (e) { itemize = { error: String(e.message ?? e) } }

    return {
      boot: { grants: boot.consentGate, composer: boot.composerPresent },
      face,
      gateBeforeConsent: gate.consentGate,
      greeting: { before: greetingProbes, after: greetingAfter, frames: greetingFrames },
      turn,
      reply: { state: replyProbes, frames: replyFrames },
      iframeProbes,
      itemize,
      consoleErrors: p.consoleLines.filter(l => l.level === 'error' || l.level === 'exception').slice(0, 60),
      consoleHead: p.consoleLines.slice(0, 40),
      httpFailures: p.httpFailures.slice(0, 60),
    }
  } finally {
    chrome.kill()
    await delay(500)
  }
})()

// ---------------------------------------------------------------- Phase C
console.log(`=== C. variables / swipe / diagnostics (${chatId}) ===`)
if (chatId !== undefined) {
  const readVars = async (label) => {
    const out = { label }
    try { out.messageScope = summarizeVars((await call('script.getVariables', { chatId, scope: 'message' })).variables) } catch (e) { out.messageScopeError = String(e.message ?? e) }
    try { out.chatScope = summarizeVars((await call('script.getVariables', { chatId, scope: 'chat' })).variables) } catch (e) { out.chatScopeError = String(e.message ?? e) }
    const view = await call("chat.open", { chatId }).then(r => r.view).catch(() => null)
    out.viewVariables = summarizeVars(view?.variables)
    out.messages = view?.messages?.map(m => ({ id: m.id, turn: m.turn, swipes: m.swipes?.count ?? 0, selected: m.swipes?.index ?? null })) ?? null
    return out
  }
  result.variablesAfterReply = await readVars('after-reply')

  const turnFinished = NO_TURN === false && result.browser?.turn !== null && result.browser?.turn !== undefined && result.browser?.turn?.error === undefined
  if (DO_SWIPE && turnFinished) {
    try {
      // Candidate 1: regenerate once (a new candidate on the same turn).
      const watcher = await waitForIdle(chatId)
      await call('chat.regenerate', { chatId })
      const end = await watcher.waitUntil(e => e.type === 'stream.end', 420_000)
      result.regenerate = { reason: end?.reason ?? 'timeout' }
      watcher.close()
      await delay(6000)
      result.variablesAfterRegenerate = await readVars('after-regenerate')
      // Swipe back to candidate 0: the panel's table must be candidate 0's.
      const view = await call("chat.open", { chatId }).then(r => r.view)
      const reply = view.messages.filter(m => m.role !== 'user').at(-1)
      const count = reply.swipes?.count ?? 0
      await call('chat.swipe', { chatId, turn: reply.turn, index: 0 })
      await delay(3000)
      result.variablesAfterSwipeBack = await readVars('after-swipe-back-to-0')
      result.swipeBack = { turn: reply.turn, candidates: count }
    } catch (e) {
      result.swipeError = String(e.message ?? e)
    }
  }
}
const reportsAfter = await debugReports()
result.newReports = (reportsAfter.reports ?? []).filter(r => (r.seq ?? 0) > beforeSeq)
  .map(r => ({ seq: r.seq, kind: r.kind, chatId: r.chatId, scriptId: r.scriptId, message: String(r.message ?? '').slice(0, 300) }))

writeFileSync(new URL(`./results/review2/${slug}.json`, import.meta.url), JSON.stringify(result, null, 2))
console.log(`\n=== ${displayName} ===`)
console.log(`chat: ${String(chatId)}`)
console.log(`greeting: gate=${JSON.stringify(result.browser?.gateBeforeConsent)} slotIframes=${result.browser?.greeting?.after?.iframes?.length ?? 0} frames=${result.browser?.greeting?.frames?.frames} stable=${result.browser?.greeting?.frames?.stable}`)
console.log(`turn: ${JSON.stringify(result.browser?.turn)}`)
console.log(`reply: slotIframes=${result.browser?.reply?.state?.iframes?.length ?? 0} frames=${result.browser?.reply?.frames?.frames} stable=${result.browser?.reply?.frames?.stable}`)
// REVIEW-5 §4: the judgment is per floor — one slot per claimed block on that
// floor's own text. The two lines above count every slot on the page, so this
// one names the reply floor's own number; `qa/review5-claims.mjs` reads it,
// and the claim count it must equal, for a whole card list at once.
console.log(`reply floor slots: ${JSON.stringify((result.browser?.reply?.state?.slots ?? []).map(s => s.instance))}`)
console.log(`folded scaffolding: greeting=${result.browser?.greeting?.after?.bodyleaks?.length ?? 0} reply=${result.browser?.reply?.state?.bodyleaks?.length ?? 0} last=${result.browser?.reply?.state?.bodyleaks?.at(-1)?.edge ?? '-'}/${result.browser?.reply?.state?.bodyleaks?.at(-1)?.len ?? 0}B`)
console.log(`console: exceptions=${(result.browser?.consoleErrors ?? []).filter(c => c.level === 'exception').length} errors=${(result.browser?.consoleErrors ?? []).length} http>=400=${result.browser?.httpFailures?.length ?? 0}`)
console.log(`iframe probes: ${result.browser?.iframeProbes?.length ?? 0}`)
for (const pr of result.browser?.iframeProbes ?? []) console.log(`  - ${pr.url} :: ${JSON.stringify(pr.probe).slice(0, 220)}`)
console.log(`itemize: ${JSON.stringify(result.browser?.itemize)?.slice(0, 500)}`)
console.log(`vars after reply: ${JSON.stringify(result.variablesAfterReply?.messageScope)?.slice(0, 400)}`)
console.log(`view vars: ${JSON.stringify(result.variablesAfterReply?.viewVariables)?.slice(0, 300)}`)
if (result.variablesAfterRegenerate !== undefined) console.log(`vars after regen: ${JSON.stringify(result.variablesAfterRegenerate?.messageScope)?.slice(0, 400)}`)
if (result.variablesAfterSwipeBack !== undefined) console.log(`vars after swipe0: ${JSON.stringify(result.variablesAfterSwipeBack?.messageScope)?.slice(0, 400)}`)
console.log(`new host reports: ${result.newReports.length}`)
for (const r of result.newReports) console.log(`  - #${r.seq} [${r.kind}] ${r.message.slice(0, 180)}`)
console.log(`console errors: ${result.browser?.consoleErrors?.length ?? 0}`)
for (const c of (result.browser?.consoleErrors ?? []).slice(0, 8)) console.log(`  ! ${c.level}: ${c.text.slice(0, 180)}`)
console.log(`http>=400: ${result.browser?.httpFailures?.length ?? 0}`)
for (const h of (result.browser?.httpFailures ?? []).slice(0, 8)) console.log(`  # ${h.status} ${h.url}`)
console.log(`cardScriptsText: ${(result.browser?.reply?.state?.cardScriptsText ?? '').slice(0, 700)}`)
console.log(`results -> qa/results/review2/${slug}.json`)
