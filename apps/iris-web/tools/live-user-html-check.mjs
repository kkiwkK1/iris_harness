/**
 * Headless CDP verification for dev/fix-user-html: the user floor's bare HTML
 * must render as a sandbox frame, styled, with the terminal's `<details>`
 * openable — and a plain user row must stay plain.
 *
 * Expects Chrome already listening on CDP_PORT (recorded by the launcher).
 * Run: node tools/live-user-html-check.mjs [cdpPort] [appPort]
 * @module iris-web/tools/live-user-html-check
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const cdpPort = process.argv[2] ?? '9333'
const appPort = process.argv[3] ?? '8827'
const outDir = process.argv[4] ?? 'verify-out'
mkdirSync(outDir, { recursive: true })

let nextId = 1
const pending = new Map()

/** One CDP call over the page's WebSocket, optionally into an attached session. */
function send(ws, method, params = {}, sessionId) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const envelope = { id, method, params }
    if (sessionId !== undefined) envelope.sessionId = sessionId
    ws.send(JSON.stringify(envelope))
  })
}

function handle(ws, message) {
  const frame = JSON.parse(message)
  if (frame.id !== undefined && pending.has(frame.id)) {
    const { resolve, reject } = pending.get(frame.id)
    pending.delete(frame.id)
    if (frame.error !== undefined) reject(new Error(`${frame.error.message}`))
    else resolve(frame.result)
    return
  }
  if (frame.method === 'Runtime.consoleAPICalled') return
  if (frame.method === 'Runtime.exceptionThrown') {
    console.log('[page exception]', JSON.stringify(frame.params?.exceptionDetails?.text ?? ''))
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Create a page target at the app URL and return its WebSocket URL. */
async function openTarget() {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/new?http://127.0.0.1:${appPort}/`, {
    method: 'PUT',
  })
  const target = await response.json()
  return target.webSocketDebuggerUrl
}

/** Evaluate in the page context, returning the value. */
async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page eval failed: ${JSON.stringify(result.exceptionDetails)}`)
  }
  return result.result.value
}

const wsUrl = await openTarget()
const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})
ws.addEventListener('message', event => handle(ws, event.data))

await send(ws, 'Runtime.enable')
await send(ws, 'Page.enable')

// Wait for the app to boot and (auto-open) the newest chat — the one injected.
console.error('[progress] polling for app boot')
const FINDINGS = []
const poll = await evaluate(ws, `(async () => {
  for (let at = 0; at < 60; at++) {
    const user = document.querySelectorAll('.iris-msg--user').length
    if (user > 0) return { ready: true, user }
    await new Promise(r => setTimeout(r, 500))
  }
  return { ready: false, body: document.body.innerText.slice(0, 400) }
})()`)
FINDINGS.push({ step: 'app boot, user row mounted', ...poll })
if (poll.ready !== true) throw new Error('the app never mounted a user row')

// If the card's scripts are still unasked, answer the consent ask as a reader
// would — the frame pipeline is gated on it for every role alike.
await sleep(1000)
const consent = await evaluate(ws, `(() => {
  const button = document.querySelector('.iris-grant__actions button')
  if (button === null) return { asked: false }
  button.click()
  return { asked: true, accepted: button.textContent }
})()`)
FINDINGS.push({ step: 'consent ask', ...consent })

// Wait for the user floor's frame to boot and paint.
console.error('[progress] polling for the user floor frame')
const frameState = await evaluate(ws, `(async () => {
  for (let at = 0; at < 40; at++) {
    const iframe = document.querySelector('.iris-msg--user .iris-interfaces__slot iframe')
    if (iframe !== null && Number.parseInt(iframe.style.height, 10) > 0) {
      return {
        present: true,
        sandbox: iframe.getAttribute('sandbox'),
        height: iframe.style.height,
        width: iframe.getBoundingClientRect().width,
        srcdocHasTerminal: iframe.srcdoc.includes('polsim-terminal'),
        srcdocHasSummary: iframe.srcdoc.includes('建国档案已提交'),
        srcdocHasVars: iframe.srcdoc.includes('👾变量更新'),
      }
    }
    await new Promise(r => setTimeout(r, 500))
  }
  const slot = document.querySelector('.iris-msg--user .iris-interfaces__slot')
  return { present: false, slotHtml: slot === null ? null : slot.innerHTML.slice(0, 300) }
})()`)
FINDINGS.push({ step: 'user floor sandbox frame', ...frameState })
if (frameState.present !== true) throw new Error('the user floor never built its sandbox frame')

// The claim must REPLACE the source in the prose: no raw markup left as text.
console.error('[progress] checking for leaked source')
const leak = await evaluate(ws, `(() => {
  const row = document.querySelector('.iris-msg--user')
  const text = row === null ? '' : row.textContent
  return {
    leaksSource: text.includes('<div style="width: 85%'),
    mentionsTerminalAsText: text.includes('class="polsim-terminal"'),
    textSample: text.slice(0, 160),
  }
})()`)
FINDINGS.push({ step: 'no raw source in the user row', ...leak })

// Inside the frame: styling applied, terminal details closed then openable.
// Sandboxed srcdoc frames refuse direct per-target sockets here, so the page
// session auto-attaches to its related iframe targets and evaluates through
// each session instead.
const frameSessions = new Map()
ws.addEventListener('message', event => {
  const frame = JSON.parse(event.data)
  if (frame.method === 'Target.attachedToTarget') {
    frameSessions.set(frame.params.sessionId, frame.params.targetInfo)
  }
})
await send(ws, 'Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
})
await sleep(1500)
console.error(`[progress] attached sessions: ${String(frameSessions.size)}`)

/** Evaluate one expression in an attached session. */
async function evaluateInSession(sessionId, expression) {
  const result = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  return result.result?.value
}

// `send` grows an optional sessionId, as the flattened protocol requires.
// (Declared here so the calls above stay untouched.)

let inside = { result: { value: { terminal: false } } }
let scanned = 0
for (const [sessionId, info] of frameSessions.entries()) {
  if (info.type !== 'iframe') continue
  scanned += 1
  const probe = await evaluateInSession(
    sessionId,
    `document.querySelector('.polsim-terminal') !== null ? 'mine' : 'other'`,
  )
  console.error(`[progress] iframe session ${String(scanned)} probe=${String(probe)}`)
  if (probe === 'mine') {
    inside = {
      result: {
        value: await evaluateInSession(sessionId, `(async () => {
          const terminal = document.querySelector('.polsim-terminal')
          const summary = terminal.querySelector('summary')
          const vars = terminal.querySelector('.polsim-vars')
          const color = getComputedStyle(terminal).color
          const before = terminal.open
          summary.click()
          await new Promise(r => setTimeout(r, 200))
          const after = terminal.open
          summary.click()
          await new Promise(r => setTimeout(r, 200))
          const closedAgain = !terminal.open
          summary.click()
          await new Promise(r => setTimeout(r, 200))
          return {
            terminal: true,
            styledColor: color,
            closedOnArrival: before === false,
            opens: after === true,
            closesAgain: closedAgain,
            varsText: vars === null ? null : vars.textContent,
            bodyHeight: document.documentElement.scrollHeight,
          }
        })()`),
      },
    }
    break
  }
}
FINDINGS.push({ step: 'inside the sandbox frame', sessions: scanned, ...inside.result.value })

// Screenshot: the whole viewport with the user row scrolled into view, plus a
// close crop of the row itself.
console.error('[progress] screenshots')
await evaluate(ws, `(() => {
  document.querySelector('.iris-msg--user')?.scrollIntoView({ block: 'center' })
  return true
})()`)
await sleep(800)
const full = await send(ws, 'Page.captureScreenshot', { format: 'png' })
writeFileSync(join(outDir, 'user-html-frame-viewport.png'), Buffer.from(full.data, 'base64'))

const rect = await evaluate(ws, `(() => {
  const row = document.querySelector('.iris-msg--user')
  const r = row.getBoundingClientRect()
  return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }
})()`)
const crop = await send(ws, 'Page.captureScreenshot', {
  format: 'png',
  clip: { ...rect, scale: 1 },
})
writeFileSync(join(outDir, 'user-html-frame-row.png'), Buffer.from(crop.data, 'base64'))

console.log(JSON.stringify(FINDINGS, null, 2))
const ok =
  leak.leaksSource === false &&
  frameState.srcdocHasTerminal === true &&
  inside.result.value.terminal === true &&
  inside.result.value.closedOnArrival === true &&
  inside.result.value.opens === true &&
  inside.result.value.closesAgain === true
console.log(ok ? 'VERIFICATION PASSED' : 'VERIFICATION FAILED')
ws.close()
process.exit(ok ? 0 : 1)
