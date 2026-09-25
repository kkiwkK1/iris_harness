/**
 * Acceptance for 「收起卡片界面」 with a sandbox plugin in the card's frame: the
 * card's interface goes, the plugin's panel and styles stay.
 *
 * Runs against a real host, the production bundle and a real card-script frame.
 * **It spends nothing.** The plugin is seeded straight into the copied data
 * dir's sidecar (`<profile>/sandbox-plugins/<chatId>.json`, already authorised),
 * the pattern of `sandbox-plugin-scope-acceptance.mjs`.
 *
 * What it reads, and where:
 * - **in the frame** (a CDP session on the card-script iframe): whether any of
 *   the card's own elements is painted (non-zero box, computed `visibility`
 *   visible), whether the plugin's cell is, and how many plugin sheets are in
 *   `head`;
 * - **in the page**: the surface element's `visibility`, the frame's clip, the
 *   toggle's `aria-pressed`, and what `elementFromPoint` hits at the plugin
 *   cell's centre and at the card's first painted element;
 * - **screenshots** of both states, and of the no-plugin control.
 *
 * The control: disabling the plugin through the product's own panel leaves a
 * card with no plugins, where collapse must still hide the surface from
 * outside, as it always did.
 *
 * Usage: node qa/card-collapse-plugin-acceptance.mjs   (IRIS_PORT, IRIS_CARD)
 * Hard failures: 1 = a check failed, 2 = port or data-dir problem, 3 = hard timeout.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'
import { answerConsentExpr, clickTabExpr } from './locators.mjs'

const PORT = Number(process.env.IRIS_PORT ?? 8803)
const BASE = `http://127.0.0.1:${String(PORT)}`
const CDP = String(cdpPort(9363))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CARD = process.env.IRIS_CARD ?? '银麒赎世'
const PLUGIN = '01-collapse-probe'

const outDir = new URL('./results/card-collapse-plugin/', import.meta.url)
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

// A panel that is easy to see, placed by the plugin's own sheet (sheets are
// unscoped, §5.4), so the screenshot shows it wherever the card's UI sits.
const PROBE = [
  'return {',
  '  apply() {',
  `    iris.styles.insert('[data-iris-plugin-panel="${PLUGIN}"] { position: fixed; left: 24px; top: 24px; z-index: 2147483647; background: #fde047; color: #111; padding: 10px 14px; border-radius: 8px; font: 600 15px sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,.4); }')`,
  "    iris.panel.mount('<span data-qa-probe>QA sandbox plugin panel</span>')",
  '  },',
  '}',
].join('\n')
const hashOf = code => createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 12)

{
  const netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
  const taken = (netstat.stdout ?? '').split('\n')
    .filter(line => line.includes(`:${String(PORT)} `) && line.includes('LISTENING'))
  if (taken.length > 0) {
    console.error(`FAIL  port ${String(PORT)} is already listening — refusing to start:\n${taken.join('\n')}`)
    process.exit(2)
  }
}

const data = dataCopy('iris-card-collapse-qa-')
const dataDir = data.dir
const dataSource = process.env.IRIS_DATA_SOURCE ?? join(repoRoot, '..', 'iris_cordis_traven', 'apps', 'iris', 'data')
await cp(dataSource, dataDir, { recursive: true }).catch(error => {
  console.error(`FAIL  no data dir to copy from (${dataSource}): ${String(error)}`)
  process.exit(2)
})
await rm(join(dataDir, 'host.lock'), { force: true })
await rm(join(dataDir, 'default-user', 'host.lock'), { force: true })
const profileDir = join(dataDir, 'default-user')

let hostOutput = ''
const host = data.adopt(spawn(process.execPath, ['apps/iris/bin.ts'], {
  cwd: repoRoot,
  env: { ...process.env, IRIS_PORT: String(PORT), IRIS_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
}))
host.stdout.on('data', chunk => { hostOutput += String(chunk) })
host.stderr.on('data', chunk => { hostOutput += String(chunk) })
console.log(`host process PID ${String(host.pid)} on port ${String(PORT)}, data dir ${dataDir}`)

let seq = 0
const rpc = async (method, params = {}) => {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-collapse-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 300_000)

let chrome
const profile = chromeProfile('iris-qa-cdp-')
try {
  let up = false
  for (let at = 0; at < 60 && !up; at += 1) {
    await delay(500)
    if (hostOutput.includes('EADDRINUSE')) {
      console.error(`FAIL  the host died on EADDRINUSE:\n${hostOutput}`)
      process.exit(2)
    }
    up = await rpc('character.list').then(() => true).catch(() => false)
  }
  if (!up) throw new Error(`the host on ${String(PORT)} never answered\n${hostOutput}`)

  const ids = ((await rpc('character.list')).characters ?? []).map(one => one.characterId)
  record('character.list before any write', ids.length)
  const characterId = ids.find(id => id === CARD) ?? ids.find(id => id.includes(CARD))
  if (characterId === undefined) {
    console.error(`FAIL  no card named ${CARD} in this data dir; set IRIS_CARD`)
    process.exit(2)
  }

  const created = await rpc('chat.create', { characterId })
  const chatId = created.view?.chatId ?? created.chatId
  const title = `qa-collapse-${String(Date.now()).slice(-6)}`
  await rpc('chat.rename', { chatId, title })
  const hash = hashOf(PROBE)
  await mkdir(join(profileDir, 'sandbox-plugins'), { recursive: true })
  await writeFile(join(profileDir, 'sandbox-plugins', `${chatId}.json`), JSON.stringify({
    version: 1,
    chatId,
    characterId,
    plugins: [{
      id: PLUGIN,
      versions: [{
        version: 1, name: 'QA collapse probe', purpose: 'a visible panel and a sheet',
        declares: [{ kind: 'panel' }, { kind: 'style' }],
        code: PROBE, bytes: Buffer.byteLength(PROBE, 'utf8'), hash, prompt: 'qa',
        authored: { connectionId: 'qa-seed', model: 'qa-seed', at: Date.now() },
        facade: 1,
      }],
      enabled: true, trustFutureVersions: false, authorizedHashes: [hash],
    }],
  }), 'utf8')
  record('seeded', { chatId, title, plugin: PLUGIN })

  // ---- browser ------------------------------------------------------------
  chrome = profile.adopt(spawn(CHROME, [
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile.dir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new', '--window-size=1480,1000', 'about:blank',
  ], { stdio: 'ignore' }))
  let version
  for (let at = 0; at < 40 && version === undefined; at += 1) {
    await delay(500)
    try { version = await fetch(`http://127.0.0.1:${CDP}/json/version`).then(r => r.json()) } catch { /* not yet */ }
  }
  if (version === undefined) throw new Error('chrome never came up')

  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let wsSeq = 0
  const pending = new Map()
  const frameSessions = new Map()
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
    if (msg.method === 'Target.attachedToTarget' && msg.params?.targetInfo?.type === 'iframe') {
      frameSessions.set(msg.params.sessionId, { url: msg.params.targetInfo.url })
    }
    if (msg.method === 'Target.detachedFromTarget') frameSessions.delete(msg.params?.sessionId)
  }
  const raw = (method, params = {}, sessionId) => new Promise(res => {
    const id = ++wsSeq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  })
  const { targetId } = (await raw('Target.createTarget', { url: 'about:blank' })).result
  const pageSession = (await raw('Target.attachToTarget', { targetId, flatten: true })).result.sessionId
  const send = (method, params = {}, sessionId = pageSession) => raw(method, params, sessionId)
  const evaluate = async (expression, sessionId) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.result?.exceptionDetails !== undefined) throw new Error(`evaluate: ${JSON.stringify(r.result.exceptionDetails)}`)
    return r.result?.result?.value
  }
  const quiet = async (expression, sessionId) => evaluate(expression, sessionId).catch(() => undefined)
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1480, height: 1000, deviceScaleFactor: 1, mobile: false })
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const path = fileURLToPath(new URL(name, outDir))
    await writeFile(path, Buffer.from(r.result.data, 'base64'))
    record(`screenshot ${name}`, path)
    return path
  }

  await send('Page.navigate', { url: `${BASE}/` })
  for (let at = 0; at < 40; at += 1) {
    await delay(500)
    if (await evaluate('document.readyState') === 'complete') break
  }
  await delay(2000)
  await evaluate(clickTabExpr('chats'))
  await delay(600)
  record('open chat', await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.iris-list .iris-row')]
      .filter(el => (el.querySelector('.iris-row__title')?.textContent ?? '').trim() === ${JSON.stringify(title)})
    if (rows.length !== 1) return { error: 'rows titled so: ' + rows.length }
    rows[0].click()
    return { clicked: 1 }
  })()`))
  await delay(1500)
  record('consent', await evaluate(answerConsentExpr))

  /** The card-script frame's own reading. */
  const frameState = async () => {
    for (const sessionId of [...frameSessions.keys()]) {
      const state = await quiet(`(() => {
        if (!document.body || document.body.hasAttribute('data-iris-interface')) return undefined
        const painted = el => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility === 'visible'
        }
        const cardRoots = [...document.body.children].filter(el => el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE'
          && el.id !== 'tavern_helper' && !el.hasAttribute('data-iris-plugin-panels'))
        const cardPainted = cardRoots.flatMap(root => [root, ...root.querySelectorAll('*')]).filter(painted)
        const first = cardPainted[0]
        const cell = document.querySelector('[data-iris-plugin-panel="${PLUGIN}"]')
        const cellRect = cell?.getBoundingClientRect()
        const firstRect = first?.getBoundingClientRect()
        return {
          collapsedAttr: document.documentElement.hasAttribute('data-iris-card-collapsed'),
          cardRoots: cardRoots.length,
          cardPainted: cardPainted.length,
          firstCard: first === undefined ? null : { tag: first.tagName.toLowerCase() + (first.id ? '#' + first.id : ''),
            x: firstRect.x + firstRect.width / 2, y: firstRect.y + firstRect.height / 2 },
          cell: cell === null ? null : { painted: painted(cell), x: cellRect.x + cellRect.width / 2, y: cellRect.y + cellRect.height / 2,
            bg: getComputedStyle(cell).backgroundColor },
          pluginSheets: document.querySelectorAll('[data-iris-plugin-style="${PLUGIN}"]').length,
          sheetShapes: [...document.querySelectorAll('[data-iris-plugin-style="${PLUGIN}"]')]
            .map(el => ({ parent: el.parentElement?.tagName.toLowerCase(), seq: el.getAttribute('data-seq'), chars: (el.textContent ?? '').length })),
        }
      })()`, sessionId)
      if (state !== undefined) return state
    }
    return { frame: false }
  }
  const frameUntil = async (done, waitMs = 15_000) => {
    const started = Date.now()
    let state
    do {
      await delay(500)
      state = await frameState()
    } while (!done(state) && Date.now() - started < waitMs)
    return { state, tookMs: Date.now() - started, window: `polled to ${String(waitMs)}ms` }
  }
  /** The shell's side, and what a click at a frame point would hit. */
  const pageState = async points => evaluate(`(() => {
    const surface = document.querySelector('.iris-overlay-surface')
    const frame = surface?.querySelector('iframe')
    const toggle = document.querySelector('.iris-overlay-toggle')
    const box = frame?.getBoundingClientRect()
    const hit = p => {
      if (p == null || box === undefined) return null
      const el = document.elementFromPoint(box.x + p.x, box.y + p.y)
      return el === null ? null : (el === frame ? 'card frame' : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''))
    }
    return {
      surfaceVisibility: surface ? getComputedStyle(surface).visibility : null,
      clip: frame ? frame.style.clipPath : null,
      toggle: toggle ? { pressed: toggle.getAttribute('aria-pressed'), label: (toggle.textContent ?? '').trim() } : null,
      hitAtCell: hit(${JSON.stringify(points.cell ?? null)}),
      hitAtCard: hit(${JSON.stringify(points.card ?? null)}),
    }
  })()`)
  const clickToggle = async () => evaluate(`(() => {
    const toggle = document.querySelector('.iris-overlay-toggle')
    if (toggle === null) return { error: 'no toggle' }
    toggle.click()
    return { clicked: (toggle.textContent ?? '').trim() }
  })()`)

  // ---- 1: open state: card UI and plugin panel both up --------------------
  const open = await frameUntil(s => s.cell?.painted === true && s.cardPainted > 0, 25_000)
  record('frame, open', open)
  // The clip lands one round trip after the frame paints; read the page after it.
  let openPage
  for (let at = 0; at < 20; at += 1) {
    openPage = await pageState({ cell: open.state.cell, card: open.state.firstCard })
    if (openPage.clip !== 'path("M 0 0 Z")') break
    await delay(500)
  }
  record('page, open', openPage)
  check('open: the card draws its own UI in the frame', open.state.cardPainted > 0, `${String(open.state.cardPainted)} painted card element(s)`)
  check('open: the plugin panel is painted and its sheet applied',
    open.state.cell?.painted === true && open.state.pluginSheets >= 1, open.window)
  check('open: clicks reach the card’s UI and the plugin panel', openPage.hitAtCell === 'card frame' && openPage.hitAtCard === 'card frame',
    `${String(openPage.hitAtCell)} / ${String(openPage.hitAtCard)}`)
  await delay(800)
  const shotOpen = await shot('1-open.png')

  // ---- 2: collapsed: card UI gone, plugin panel stays -----------------------
  record('press collapse', await clickToggle())
  const shut = await frameUntil(s => s.collapsedAttr === true && s.cardPainted === 0)
  record('frame, collapsed', shut)
  await delay(800)
  const shutPage = await pageState({ cell: shut.state.cell, card: open.state.firstCard })
  record('page, collapsed', shutPage)
  check('collapsed: none of the card’s own elements is painted (control: collapse still hides the card)',
    shut.state.cardPainted === 0, `${String(shut.state.cardPainted)} painted; ${shut.window}`)
  check('collapsed: the plugin panel is still painted and its sheet still applied',
    shut.state.cell?.painted === true && shut.state.pluginSheets === open.state.pluginSheets
      && shut.state.pluginSheets >= 1 && shut.state.cell?.bg === open.state.cell?.bg,
    `${String(shut.state.pluginSheets)} sheet(s), background ${String(shut.state.cell?.bg)}`)
  check('collapsed: the surface is left visible (the frame does the hiding)', shutPage.surfaceVisibility === 'visible')
  check('collapsed: a click at the plugin panel reaches the frame', shutPage.hitAtCell === 'card frame', String(shutPage.hitAtCell))
  check('collapsed: a click where the card’s UI was reaches the shell, not the frame',
    shutPage.hitAtCard !== 'card frame', String(shutPage.hitAtCard))
  check('collapsed: the toggle reads pressed', shutPage.toggle?.pressed === 'true')
  const shotShut = await shot('2-collapsed.png')

  // ---- 3: restore -----------------------------------------------------------
  record('press restore', await clickToggle())
  const back = await frameUntil(s => s.collapsedAttr === false && s.cardPainted > 0)
  record('frame, restored', back)
  check('restored: the card UI is back, the panel still there',
    back.state.cardPainted > 0 && back.state.cell?.painted === true)

  // ---- 4: control: no plugins, collapse hides the surface from outside -----
  record('disable plugin', await evaluate(`(() => {
    const row = document.querySelector('[data-panel="sandbox-plugins"] [data-plugin-id="${PLUGIN}"]')
    if (row === null) return { error: 'no row' }
    const buttons = [...row.querySelectorAll('.iris-conn__actions button')]
    const button = buttons[1]
    if (button === undefined) return { error: 'no button', count: buttons.length }
    button.click()
    return { clicked: (button.textContent ?? '').trim() }
  })()`))
  const gone = await frameUntil(s => s.cell === null && s.cardPainted > 0, 20_000)
  record('frame, plugin disabled', gone)
  await delay(1000)
  record('press collapse (no plugins)', await clickToggle())
  await delay(1200)
  const bare = await pageState({})
  record('page, collapsed with no plugins', bare)
  check('control: with no plugins, collapse hides the surface from outside as before',
    bare.surfaceVisibility === 'hidden', String(bare.surfaceVisibility))
  const shotBare = await shot('3-collapsed-no-plugins.png')

  record('screenshots', { open: shotOpen, collapsed: shotShut, controlNoPlugins: shotBare })
  await rpc('chat.delete', { chatId })
} catch (error) {
  console.error(`FAIL  ${error instanceof Error ? error.stack : String(error)}`)
  failures += 1
} finally {
  clearTimeout(HARD)
  await writeFile(new URL('readings.json', outDir), JSON.stringify(readings, null, 2), 'utf8').catch(() => undefined)
  if (chrome?.pid !== undefined && chrome.exitCode === null) chrome.kill()
  if (host.exitCode === null) {
    host.kill()
    await new Promise(resolve => { host.once('exit', resolve) })
  }
  await profile.dispose()
  await data.dispose()
}
console.log(failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`)
process.exit(failures === 0 ? 0 : 1)
