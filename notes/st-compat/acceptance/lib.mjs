/**
 * Shared halves of the C-final acceptance scenarios: the host RPC client, the
 * browser-side UI driver (one implementation per gesture), and the evidence
 * writer. The scenarios (`run-*.mjs`) compose these; nothing here decides a
 * verdict — a scenario records what it saw and asserts in its own file.
 */

import { readFile, writeFile, mkdir, stat, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { withBrowser, evaluate, until, screenshot } from './cdp.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
export const PORT = process.env.PILOT_PORT ?? '8799'
export const APP_URL = `http://127.0.0.1:${PORT}/?transport=rpc`
export const EXTENSION_ID = 'prompt-template'
export const UPSTREAM_DIST_SHA256 = '61a87e9295dbcb2dc8335f90e95dbb67517457958d855bfb8f31798a042f71fd'
export const UPSTREAM_DIR = 'E:/sillyTavern/SillyTavern/public/scripts/extensions/third-party/ST-Prompt-Template'

/** One host RPC round. Throws on a refused frame. */
export async function rpc(method, params = {}) {
  const frame = await rpcRaw(method, params)
  if (!frame.ok) {
    const error = new Error(`${method} refused: ${frame.error?.code}: ${frame.error?.message}`)
    error.frame = frame.error
    throw error
  }
  return frame.result
}

/** One host RPC round, returning the raw frame (refusals included). */
export async function rpcRaw(method, params = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, method, params }),
  })
  return response.json()
}

/** The running seed's data directory, parsed from its log. */
export async function dataDir() {
  const log = await readFile(join(here, 'seed-acceptance.log'), 'utf8')
  const match = /DATA_DIR=(\S+)/.exec(log)
  if (match === null) throw new Error('the seed log names no DATA_DIR')
  return match[1]
}

/** The profile root inside the data directory (the seed host uses default-user). */
export async function profileDir() {
  const dir = await dataDir()
  return join(dir, 'default-user')
}

/** The installed extension's tree root under the profile. */
export async function installedDir(extensionId = EXTENSION_ID) {
  return join(await profileDir(), 'st-extensions', 'installed', extensionId)
}

/** The running seed's chat id, parsed from its log. */
export async function chatId() {
  const log = await readFile(join(here, 'seed-acceptance.log'), 'utf8')
  const match = /SEED COMPLETE: [^ ]* CHAT_ID=(\S+)/.exec(log)
  if (match === null) throw new Error('the seed log names no CHAT_ID')
  return match[1]
}

export const sha256 = async file => {
  const bytes = await readFile(file)
  return createHash('sha256').update(bytes).digest('hex')
}

// ---- evidence -----------------------------------------------------------------

export async function record(scenario, name, value) {
  const dir = join(here, 'evidence')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${scenario}.json`)
  let doc = {}
  if (existsSync(file)) {
    try { doc = JSON.parse(await readFile(file, 'utf8')) } catch { doc = {} }
  }
  doc[name] = value
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  const line = `${new Date().toISOString()} ${scenario} ${name}: ${JSON.stringify(value).slice(0, 400)}`
  await writeFile(join(dir, 'evidence.log'), `${line}\n`, { flag: 'a' })
  console.log(line)
}

// ---- browser-side UI gestures --------------------------------------------------

/** The extension plane frame's token, read from its srcdoc attribute. */
export function planeTokenExpression() {
  return `(() => {
    const f = document.querySelector('iframe[title="Iris ST-compat extension plane"]')
    if (!f) return null
    const m = /iris-st-ext-token" content="([^"]+)"/.exec(f.getAttribute('srcdoc'))
    return m ? m[1] : null
  })()`
}

/**
 * Probe the extension frame's kernel health. Resolves with the kernel's own
 * answer, or an error shape when the frame is absent or silent.
 */
export function probeExpression(timeoutMs = 8000) {
  return `(() => new Promise(resolve => {
    const f = document.querySelector('iframe[title="Iris ST-compat extension plane"]')
    if (!f) { resolve({ absent: 'no plane iframe' }); return }
    const token = /iris-st-ext-token" content="([^"]+)"/.exec(f.getAttribute('srcdoc'))
    if (!token) { resolve({ absent: 'no token in srcdoc' }); return }
    const timer = setTimeout(() => resolve({ absent: 'probe timeout' }), ${timeoutMs})
    window.addEventListener('message', function onMsg(event) {
      if (event.source !== f.contentWindow) return
      const d = event.data
      if (d && d.type === 'member-result' && d.callId === 'probe') {
        clearTimeout(timer); window.removeEventListener('message', onMsg); resolve(d.result)
      }
    })
    f.contentWindow.postMessage({ irisStExt: token[1], type: 'probe' }, '*')
  }))()`
}

/** Count every `bridge-result` the page receives from the extension frame. */
export const BRIDGE_COUNTER = `(() => {
  if (window.__irisBridgeCounts) return window.__irisBridgeCounts
  window.__irisBridgeCounts = { rounds: 0, all: [] }
  window.addEventListener('message', event => {
    const d = event.data
    if (!d || typeof d !== 'object') return
    const f = document.querySelector('iframe[title="Iris ST-compat extension plane"]')
    if (!f || event.source !== f.contentWindow) return
    if (d.type === 'bridge-result') { window.__irisBridgeCounts.rounds += 1; window.__irisBridgeCounts.all.push({ kind: d.result?.kind, error: d.error }) }
  })
  return window.__irisBridgeCounts
})()`

/** Every message the page receives from any extension-plane frame (old or new). */
export const PLANE_MESSAGE_TAP = `(() => {
  if (window.__irisPlaneTap) return window.__irisPlaneTap
  window.__irisPlaneTap = { messages: [] }
  window.addEventListener('message', event => {
    const d = event.data
    if (!d || typeof d !== 'object') return
    const planes = [...document.querySelectorAll('.iris-st-ext-plane iframe'), window.__irisOldPlaneFrame].filter(Boolean)
    if (!planes.some(f => event.source === f.contentWindow)) return
    window.__irisPlaneTap.messages.push({ type: d.type, callId: d.callId, kind: d.result?.kind, error: d.error, fromOld: window.__irisOldPlaneFrame ? event.source === window.__irisOldPlaneFrame.contentWindow : null })
  })
  return window.__irisPlaneTap
})()`

/** Type into the composer through the DOM events React listens for. */
export function sendViaComposerExpression(text) {
  return `(() => {
    const field = document.querySelector('.iris-composer__field')
    if (!field) return { sent: false, why: 'no composer field' }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(field, ${JSON.stringify(text)})
    field.dispatchEvent(new Event('input', { bubbles: true }))
    const button = document.querySelector('.iris-composer__send')
    if (!button || button.disabled) return { sent: false, why: 'send button not ready' }
    button.click()
    return { sent: true }
  })()`
}

/** Whether the composer still shows a generation in flight. */
const GENERATING = `(() => {
  const stop = document.querySelector('button[aria-label="Stop"], button[aria-label="停止"]')
  return stop !== null
})()`

/**
 * Drive one user message through the composer and wait for the reply to land.
 * The wait polls the page (the composer's stop control disappears when the
 * stream ends) rather than the host, because every `chat.open` re-announces
 * chat-open to the plane and would muddy the bridge-round counters; the host's
 * own view is read once, after the stream settles.
 */
export async function sendAndAwaitReply(evalPage, chatId, text, { timeoutMs = 60_000, settleMs = 800 } = {}) {
  const sent = await evalPage(sendViaComposerExpression(text))
  if (sent.sent !== true) throw new Error(`composer refused: ${JSON.stringify(sent)}`)
  await until('the generation ends', async () => {
    const generating = await evalPage(GENERATING)
    return generating ? undefined : true
  }, { tries: Math.ceil(timeoutMs / 400), gapMs: 400 })
  await new Promise(wake => setTimeout(wake, settleMs))
  const view = await rpc('chat.open', { chatId })
  const messages = view.view?.messages ?? []
  return messages.at(-1)
}

/** The world-info contributions of the next request, as text. */
export async function wiTexts(chatId) {
  const itemization = await rpc('prompt.itemize', { chatId })
  const entries = itemization.itemization?.entries ?? []
  return entries
    .filter(entry => entry.kind === 'worldInfoBefore' || entry.kind === 'worldInfoAfter')
    .map(entry => ({ kind: entry.kind, tokens: entry.tokens, deferred: entry.deferred === true }))
}

/**
 * The recorded request of the latest generation: the WI entry's text exactly as
 * it went to the provider, read host-side. `prompt.itemize` with a turn re-runs
 * the preview (expansion included only while armed), so this is the honest
 * record of what was sent — but the preview runs the bridge again today; see
 * the report's note. The floors' stored text is read from the chat view.
 */
export async function chatFloors(chatId) {
  const view = await rpc('chat.open', { chatId })
  return (view.view?.messages ?? []).map((message, index) => ({
    index,
    role: message.is_user === true ? 'user' : 'assistant',
    text: String(message.mes ?? message.text ?? ''),
  }))
}

/** Read one scope's variables host-side. */
export async function variables(chatId, scope, messageId) {
  const result = await rpc('script.getVariables', {
    chatId, scope, ...(messageId === undefined ? {} : { messageId }),
  })
  return result.variables
}

/** The provider-side captures, oldest first. */
export async function providerCaptures() {
  const file = join(here, 'evidence', 'provider-capture.jsonl')
  if (!existsSync(file)) return []
  const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean)
  return lines.map(line => JSON.parse(line))
}

/**
 * The WI template's segment exactly as one provider request carried it.
 *
 * `marker` is the round's unique user text: the WI entry is injected at depth,
 * which lands AFTER the newest user message, so matching only after the marker
 * index can never pick up an older floor's echo (a stored reply that still
 * carries template text — the disabled-round floor — would otherwise win).
 * Without a marker, the LAST matching message is returned (the WI entry is the
 * last template-bearing slot in the request).
 */
export function wiSegmentOf(capture, marker) {
  const request = JSON.parse(capture.body)
  const messages = request.messages ?? []
  const markers = ['defaults: 0 }) > 50', '你是我信赖的朋友', '我仍然对你保持警惕']
  const from = marker === undefined
    ? 0
    : messages.findIndex(message => (typeof message.content === 'string' ? message.content : '').includes(marker)) + 1
  if (from === 0) return undefined
  let found
  for (const message of messages.slice(from)) {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    if (markers.some(one => content.includes(one))) found = { role: message.role, content }
  }
  return found
}

/** Poll the provider captures until THIS round's request (by its marker) lands. */
export async function captureForRound(marker, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const captures = await providerCaptures()
    const found = captures.find(one => (one.body ?? '').includes(marker))
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`the provider never captured a request carrying "${marker}"`)
    await new Promise(wake => setTimeout(wake, 250))
  }
}

/** Wait until the extension plane iframe is mounted and its kernel answers. */
export async function waitForPlane(page, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let probe
  for (;;) {
    probe = await page(probeExpression(4000))
    if (probe?.ejsPublished === true) return probe
    if (Date.now() > deadline) return probe ?? { absent: 'waitForPlane timed out' }
  }
}

/** A one-shot probe with a short timeout (for states expected to be absent). */
export function probeQuiet() {
  return `(() => new Promise(resolve => {
    const f = document.querySelector('iframe[title="Iris ST-compat extension plane"]')
    if (!f) { resolve({ absent: 'no plane iframe' }); return }
    const token = /iris-st-ext-token" content="([^"]+)"/.exec(f.getAttribute('srcdoc'))
    if (!token) { resolve({ absent: 'no token in srcdoc' }); return }
    const timer = setTimeout(() => resolve({ absent: 'probe timeout' }), 2500)
    window.addEventListener('message', function onMsg(event) {
      if (event.source !== f.contentWindow) return
      const d = event.data
      if (d && d.type === 'member-result' && d.callId === 'probe') {
        clearTimeout(timer); window.removeEventListener('message', onMsg); resolve(d.result)
      }
    })
    f.contentWindow.postMessage({ irisStExt: token[1], type: 'probe' }, '*')
  }))()`
}
/** The extension plane's state as the page sees it. */
export const PLANE_STATE = `(() => {
  const plane = document.querySelector('.iris-st-ext-plane')
  const frame = document.querySelector('iframe[title="Iris ST-compat extension plane"]')
  const section = document.querySelector('[data-iris-st-ext-section]')
  const projection = document.querySelector('[data-iris-st-ext-section] iframe')
  return {
    planePresent: plane !== null,
    framePresent: frame !== null,
    frameToken: frame ? (/iris-st-ext-token" content="([^"]+)"/.exec(frame.getAttribute('srcdoc')) ?? [])[1] ?? null : null,
    sectionPresent: section !== null,
    projectionPresent: projection !== null,
  }
})()`

/** Open the settings drawer and walk to one settings route by its visible name. */
export function openSettingsExpression(routeEn, routeZh) {
  return `(() => new Promise(resolve => {
    const open = document.querySelector('[data-control="settings"]')
    if (!open) { resolve({ ok: false, why: 'no settings control' }); return }
    open.click()
    setTimeout(() => {
      const rows = [...document.querySelectorAll('button')]
      const row = rows.find(b => b.textContent.trim().startsWith(${JSON.stringify(routeEn)}) || b.textContent.trim().startsWith(${JSON.stringify(routeZh)}))
      if (!row) { resolve({ ok: false, why: 'no settings row names the route' }); return }
      row.click()
      setTimeout(() => resolve({ ok: true }), 250)
    }, 300)
  }))()`
}

/** Close the settings drawer. */
export const CLOSE_SETTINGS = `(() => {
  const close = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? '').toLowerCase().includes('close settings') || (b.getAttribute('aria-label') ?? '').includes('关闭设置'))
  if (close) { close.click(); return { ok: true } }
  return { ok: false }
})()`

/** The projection iframe's visible text, read from inside it (needs its CDP session). */
export function projectionTextInFrame() {
  return `document.body ? document.body.innerText.slice(0, 3000) : '(no body)'`
}

/** Screenshot helper bound to the evidence directory. */
export async function shot(cdp, sessionId, name) {
  const file = await screenshot(cdp, sessionId, name)
  return file
}

/** Run a scenario's browser half with the standard scaffold. */
export function inBrowser(run, { url = APP_URL } = {}) {
  return withBrowser(run, { url })
}

export { evaluate, until, withBrowser }
