/**
 * Acceptance for ruling 7: Iris's EJS engine is the plugin-center row
 * `iris-templates`, off by default, enabled through a risk confirmation.
 *
 * Against a **copy** of the product's data dir, on its own port, with a real
 * headless Chrome driving the real plugin center:
 *
 * 1. The copy's catalog has no row for the engine (it predates this build) and
 *    `IRIS_TEMPLATES` is unset, so the row must come up installed and off.
 * 2. A corpus card whose prompt carries `<%` is found by sending one line per
 *    candidate conversation to a **local mock provider** and reading the
 *    request body it received. With the row off, that body carries `<%`.
 * 3. In the browser: settings → plugins → the engine row's Enable. The risk
 *    confirmation must appear, its confirm must be unavailable until the box is
 *    ticked, and nothing may be enabled before the confirm.
 * 4. Confirmed, the row reads enabled with no restart, and the next request the
 *    mock receives for the same conversation carries fewer `<%` tags and the
 *    expanded text in their place.
 *
 * **Nothing is spent.** The copy's `connections.json` / `connections.key` are
 * deleted before boot, so the provider list is empty and the host's first-start
 * import copies the launch environment in — which points at the mock. Every
 * request this host makes goes to 127.0.0.1. The count of requests the mock
 * served is compared with the count of sends.
 *
 * **Why the request body and not the prompt panel.** The prompt panel
 * (`prompt.itemize`) carries labels and token counts, no text, and Iris's
 * engine runs at the stream seam, after itemization. The body the provider
 * receives is the one place the evaluated text exists.
 *
 * Exit: 1 = a check failed, 2 = port or data-dir trouble, 3 = hard timeout.
 * Kills only its own host and its own Chrome; removes the data copy and the
 * Chrome profile on every exit (`qa/chrome-profile.mjs`).
 *
 * Usage: IRIS_PORT=8797 node qa/ejs-builtin-acceptance.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, readFile, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { startMockProvider } from '../apps/iris/tests/mock-provider.ts'
import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'
import { openDrawerExpr } from './locators.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP = String(cdpPort(9361))
const ENGINE = 'iris-templates'

const outDir = new URL('./results/ejs-builtin/', import.meta.url)
mkdirSync(outDir, { recursive: true })

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}
const record = (what, value) => {
  console.log(`  READ  ${what} = ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
}

// ---- the port, asserted free before anything starts ------------------------
const PORT = Number(process.env.IRIS_PORT ?? 8797)
const listening = new Set((spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? '').split('\n')
  .filter(line => line.includes('LISTENING'))
  .map(line => /:(\d+)\s/.exec(line)?.[1])
  .filter(port => port !== undefined)
  .map(Number))
if (listening.has(PORT) || PORT === 8787) {
  console.error(`FAIL  port ${String(PORT)} is taken (or is the owner's 8787) — refusing to start`)
  process.exit(2)
}
const BASE = `http://127.0.0.1:${String(PORT)}`

// ---- the data copy ---------------------------------------------------------
const data = dataCopy('iris-ejs-builtin-qa-')
const dataDir = data.dir
const dataSource = process.env.IRIS_DATA_SOURCE
  ?? join(repoRoot, '..', 'iris_cordis_traven', 'apps', 'iris', 'data')
await cp(dataSource, dataDir, { recursive: true }).catch(error => {
  console.error(`FAIL  no data dir to copy from (${dataSource}): ${String(error)}`)
  process.exit(2)
})
await rm(join(dataDir, 'host.lock'), { force: true })
await rm(join(dataDir, 'default-user', 'host.lock'), { force: true })
// No real provider can be reached from this copy: see the module comment.
await rm(join(dataDir, 'default-user', 'connections.json'), { force: true })
await rm(join(dataDir, 'default-user', 'connections.key'), { force: true })
const catalogBefore = JSON.parse(await readFile(join(dataDir, 'default-user', 'system-plugins.json'), 'utf8').catch(() => '{"plugins":{}}'))
record('copied catalog rows before boot', Object.keys(catalogBefore.plugins ?? {}))

const mock = await startMockProvider()
let served = 0
{
  // Count every body the mock parses: the capture slot is replaced per request.
  let last
  setInterval(() => { if (mock.capture.body !== last) { last = mock.capture.body; if (last !== undefined) served += 1 } }, 5).unref()
}

const env = { ...process.env }
delete env.IRIS_TEMPLATES
delete env.IRIS_API_KEY_ENV
let hostOutput = ''
const host = data.adopt(spawn(process.execPath, ['apps/iris/bin.ts'], {
  cwd: repoRoot,
  env: {
    ...env,
    IRIS_PORT: String(PORT),
    IRIS_DATA_DIR: dataDir,
    IRIS_BASE_URL: mock.baseURL,
    IRIS_MODEL: 'mock-model',
    IRIS_WEB_DIST: join(repoRoot, 'apps', 'iris-web', 'dist', 'index.html'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
}))
host.stdout.on('data', chunk => { hostOutput += String(chunk) })
host.stderr.on('data', chunk => { hostOutput += String(chunk) })
console.log(`host PID ${String(host.pid)} on ${String(PORT)}, data copy ${dataDir}, mock ${mock.baseURL}`)

let seq = 0
const rpc = async (method, params = {}) => {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-ejs-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 480_000)

/** The text of every message in a chat-completion body. */
const bodyText = body => (body?.messages ?? [])
  .map(message => typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) ? message.content.map(part => part.text ?? '').join('') : '')
  .join('\n')
const tags = text => (text.match(/<%/gu) ?? []).length

let sends = 0
/** Send one line and return the body the mock received for it. */
const sendAndCapture = async (chatId, text) => {
  const before = mock.capture.body
  sends += 1
  await rpc('chat.send', { chatId, text })
  for (let at = 0; at < 200; at += 1) {
    await delay(50)
    if (mock.capture.body !== undefined && mock.capture.body !== before) break
  }
  // Let the turn settle, so the next send is not refused as busy.
  for (let at = 0; at < 100; at += 1) {
    const state = await rpc('chat.resync', { chatId, reason: 'silence' }).catch(() => undefined)
    if (state === undefined || state.generating === undefined) break
    await delay(100)
  }
  await delay(300)
  return mock.capture.body === before ? undefined : mock.capture.body
}

let chrome
const profile = chromeProfile('iris-ejs-builtin-cdp-')
try {
  let up = false
  for (let at = 0; at < 80 && !up; at += 1) {
    await delay(500)
    if (hostOutput.includes('EADDRINUSE')) {
      console.error(`FAIL  EADDRINUSE on ${String(PORT)}:\n${hostOutput}`)
      process.exit(2)
    }
    up = await rpc('character.list').then(() => true).catch(() => false)
  }
  if (!up) throw new Error(`the host on ${String(PORT)} never answered\n${hostOutput}`)

  // ---- 1. the row, off ----------------------------------------------------
  const listed = await rpc('plugin.list')
  const row = listed.plugins.find(plugin => plugin.id === ENGINE)
  record('engine row at boot', row === undefined ? null : { installed: row.installed, enabled: row.enabled, status: row.status, name: row.name })
  check('the copied profile gets the engine row, installed and off', row?.installed === true && row.enabled === false && row.status === 'disabled')
  check('no retired-variable notice was logged (IRIS_TEMPLATES unset)', !hostOutput.includes('IRIS_TEMPLATES is retired'))
  const connections = await rpc('connection.list')
  record('providers in the copy (must be the mock only)', (connections.profiles ?? []).map(p => ({ id: p.id, baseURL: p.baseURL })))
  check('every provider in the copy is the local mock',
    (connections.profiles ?? []).length > 0 && connections.profiles.every(p => p.baseURL === undefined || p.baseURL.startsWith('http://127.0.0.1')))

  // ---- 2. a card whose prompt carries <% ------------------------------------
  const cards = (await rpc('character.list')).characters ?? []
  record('cards in the copy', cards.length)
  let found
  for (const card of cards) {
    const created = await rpc('chat.create', { characterId: card.characterId }).catch(() => undefined)
    if (created === undefined) continue
    const body = await sendAndCapture(created.view.chatId, 'Hello.')
    const text = bodyText(body)
    if (tags(text) > 0) { found = { card, chatId: created.view.chatId, off: text }; break }
  }
  if (found === undefined) throw new Error('no card in the copy put <% into its prompt')
  record('EJS card', { characterId: found.card.characterId, name: found.card.name, tagsWithRowOff: tags(found.off) })
  check('with the row off, the provider receives raw <%', tags(found.off) > 0)
  const rawSample = found.off.slice(Math.max(0, found.off.indexOf('<%') - 60), found.off.indexOf('<%') + 120)
  record('raw sample (row off)', rawSample)

  // ---- 3. the browser: enable through the confirm -------------------------
  chrome = profile.adopt(spawn(CHROME, [
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile.dir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new', '--window-size=1480,1000', 'about:blank',
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
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
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
  await send('Page.navigate', { url: `${BASE}/` })
  for (let at = 0; at < 60; at += 1) {
    await delay(500)
    if (await evaluate('document.querySelector("[data-control=\\"settings\\"]") !== null') === true) break
  }
  record('open drawer', await evaluate(openDrawerExpr))
  const toPlugins = await evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const row = document.querySelector('[data-settings-destination="plugins"]')
    if (row === null) return { error: 'no plugins destination' }
    row.click()
    for (let at = 0; at < 40; at += 1) {
      await sleep(150)
      const engine = document.querySelector('[data-plugin-id="${ENGINE}"]')
      if (engine !== null && engine.offsetParent !== null) return { ok: true, text: engine.textContent.slice(0, 400) }
    }
    return { error: 'the engine row never became visible' }
  })()`)
  record('plugin center engine row', toPlugins)
  check('the plugin center shows the engine row', toPlugins?.ok === true)
  await shot('01-engine-row-off')

  const asked = await evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const engine = document.querySelector('[data-plugin-id="${ENGINE}"]')
    const enable = engine.querySelector('.iris-plugin__actions button')
    const label = enable.textContent.trim()
    enable.click()
    for (let at = 0; at < 20; at += 1) {
      await sleep(100)
      const dialog = document.querySelector('[role="dialog"]')
      if (dialog !== null) {
        const buttons = [...dialog.querySelectorAll('button')]
        return {
          label,
          dialog: true,
          title: dialog.querySelector('h2, h3, [class*="title"]')?.textContent ?? null,
          text: dialog.textContent.slice(0, 600),
          disabledButtons: buttons.filter(b => b.disabled).map(b => b.textContent.trim()),
          checkbox: dialog.querySelector('input[type="checkbox"]')?.checked ?? null,
        }
      }
    }
    return { label, dialog: false }
  })()`)
  record('after Enable', asked)
  check('Enable opened the risk confirmation', asked?.dialog === true)
  check('the confirm is unavailable until the box is ticked', (asked?.disabledButtons?.length ?? 0) === 1 && asked?.checkbox === false)
  const midway = (await rpc('plugin.list')).plugins.find(plugin => plugin.id === ENGINE)
  check('nothing was enabled before the confirm', midway?.enabled === false)
  await shot('02-confirmation')

  const confirmed = await evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const dialog = document.querySelector('[role="dialog"]')
    const confirm = [...dialog.querySelectorAll('button')].find(b => b.disabled)
    dialog.querySelector('input[type="checkbox"]').click()
    await sleep(200)
    if (confirm.disabled) return { error: 'the tick did not free the confirm' }
    const label = confirm.textContent.trim()
    confirm.click()
    for (let at = 0; at < 50; at += 1) {
      await sleep(150)
      const engine = document.querySelector('[data-plugin-id="${ENGINE}"]')
      if (engine.getAttribute('data-plugin-status') === 'enabled') {
        return { label, status: 'enabled', dialogGone: document.querySelector('[role="dialog"]') === null }
      }
    }
    return { label, status: document.querySelector('[data-plugin-id="${ENGINE}"]').getAttribute('data-plugin-status') }
  })()`)
  record('after confirm', confirmed)
  check('the confirmed row reads enabled in the page', confirmed?.status === 'enabled' && confirmed.dialogGone === true)
  const after = (await rpc('plugin.list')).plugins.find(plugin => plugin.id === ENGINE)
  check('the host reports the row enabled (no restart)', after?.enabled === true && after.status === 'enabled')
  await shot('03-engine-row-on')

  // ---- 4. the same conversation, next request ------------------------------
  const onBody = await sendAndCapture(found.chatId, 'And now?')
  const on = bodyText(onBody)
  record('tags with the row on', tags(on))
  check('with the row on, the provider receives fewer <% tags', tags(on) < tags(found.off), `${String(tags(found.off))} → ${String(tags(on))}`)
  const anchor = rawSample.slice(0, Math.min(40, rawSample.indexOf('<%')))
  const at = anchor.length > 0 ? on.indexOf(anchor) : -1
  record('expanded sample (row on), at the same anchor', at === -1 ? '(anchor not found)' : on.slice(at, at + 180))

  const catalogAfter = JSON.parse(await readFile(join(dataDir, 'default-user', 'system-plugins.json'), 'utf8'))
  record('stored engine row after enable', catalogAfter.plugins?.[ENGINE])
  check('the enable is catalog-persisted', catalogAfter.plugins?.[ENGINE]?.enabled === true)
  await delay(500)
  check('every send reached the local mock and nothing else', served >= sends, `sends=${String(sends)} mockServed=${String(served)}`)
} catch (error) {
  console.error(`FAIL  ${error instanceof Error ? error.stack : String(error)}`)
  failures += 1
} finally {
  clearTimeout(HARD)
  await mock.close().catch(() => {})
  await profile.dispose()
  await data.dispose()
}
console.log(failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`)
process.exit(failures === 0 ? 0 : 1)
