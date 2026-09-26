/**
 * Caliper for the stable reading column (owner ruling 2026-09-26, web §135).
 *
 * On a host with a **copy** of the product's data dir and the 黑兽
 * conversation open, the four flank states — both folded, margin open,
 * sidebar open, both open — are set through the interface's own controls at
 * 1920×1047 and 1440×1047. In each state the script reads, with
 * `getBoundingClientRect`, the reading column, the first card frame, the
 * composer's box, the masthead title, the card-interface toggle and the turn
 * rail, and asks every card frame whether it saw a `resize` (its viewport
 * changed) or a width change on its own root since the previous state. The
 * ruling passes when every rect is identical across the four states at a width
 * and no frame re-measured.
 *
 * Also recorded: the scroller's real scrollbar lane (the `SCROLLBAR_LANE`
 * bound is 12), which properties the toggles animate (transform and
 * visibility only; never width), a screenshot of every state, one frozen
 * mid-slide per width, that `prefers-reduced-motion` leaves nothing animating,
 * and where focus goes when a flank opens and closes as a panel over the page.
 *
 * Nothing is spent: no model request is made.
 *
 * Exit 1 = a check failed, 2 = port or data-dir trouble, 3 = hard timeout.
 * Kills only its own host and Chrome (adopted by `qa/chrome-profile.mjs`,
 * which also removes the profile and the data copy).
 *
 * Usage: node qa/stable-column-caliper.mjs   (IRIS_PORT defaults to 8805)
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP = String(cdpPort(9375))
const PORT = Number(process.env.IRIS_PORT ?? 8805)
const BASE = `http://127.0.0.1:${String(PORT)}`
const HEIGHT = 1047
const WIDTHS = [1920, 1440]
const CHAT_TITLE = process.env.IRIS_CHAT_TITLE ?? '黑兽'

// `IRIS_QA_LABEL` separates runs — e.g. `baseline` against a pre-§135 build
// served through `IRIS_WEB_DIST` — so one run's screenshots never overwrite
// another's.
const LABEL = process.env.IRIS_QA_LABEL ?? 'branch'
const outDir = new URL(`./results/stable-column/${LABEL}/`, import.meta.url)
mkdirSync(outDir, { recursive: true })

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}
const record = (what, value) => {
  console.log(`  READ  ${what} = ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
}

// The port is asserted free before the host starts (qa/README.md).
const netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
const listening = new Set((netstat.stdout ?? '').split('\n')
  .filter(line => line.includes('LISTENING'))
  .map(line => /:(\d+)\s/.exec(line)?.[1])
  .filter(port => port !== undefined)
  .map(Number))
if (listening.has(PORT)) {
  console.error(`FAIL  port ${String(PORT)} is already listening — refusing to start`)
  process.exit(2)
}

const data = dataCopy('iris-stable-column-qa-')
const dataDir = data.dir
const dataSource = process.env.IRIS_DATA_SOURCE
  ?? join(repoRoot, '..', 'iris_cordis_traven', 'apps', 'iris', 'data')
await cp(dataSource, dataDir, { recursive: true }).catch(error => {
  console.error(`FAIL  no data dir to copy from (${dataSource}): ${String(error)}`)
  process.exit(2)
})
await rm(join(dataDir, 'host.lock'), { force: true })
await rm(join(dataDir, 'default-user', 'host.lock'), { force: true })

let hostOutput = ''
const host = data.adopt(spawn(process.execPath, ['apps/iris/bin.ts'], {
  cwd: repoRoot,
  env: { ...process.env, IRIS_PORT: String(PORT), IRIS_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
}))
host.stdout.on('data', chunk => { hostOutput += String(chunk) })
host.stderr.on('data', chunk => { hostOutput += String(chunk) })
console.log(`host PID ${String(host.pid)} on ${String(PORT)}, data dir ${dataDir}`)

const rpc = async (method, params = {}) => {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-col-${String(Date.now())}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 420_000)
const profile = chromeProfile('iris-qa-cdp-')

try {
  let up = false
  for (let at = 0; at < 60 && !up; at += 1) {
    await delay(500)
    if (hostOutput.includes('EADDRINUSE')) {
      console.error(`FAIL  EADDRINUSE on ${String(PORT)}:\n${hostOutput}`)
      process.exit(2)
    }
    up = await rpc('chat.list').then(() => true).catch(() => false)
  }
  if (!up) throw new Error(`the host on ${String(PORT)} never answered\n${hostOutput}`)
  const chats = (await rpc('chat.list')).chats
  const target = chats.filter(row => row.title === CHAT_TITLE).sort((a, b) => b.messageCount - a.messageCount)[0]
  if (target === undefined) {
    console.error(`FAIL  no conversation titled ${CHAT_TITLE} in the copy`)
    process.exit(2)
  }
  record('conversation', { chatId: target.chatId, floors: target.messageCount })

  // ---- the browser ------------------------------------------------------
  profile.adopt(spawn(CHROME, [
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile.dir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    `--window-size=1920,${String(HEIGHT)}`, 'about:blank',
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
  /** Every execution context the page session has seen: id → frame id. */
  const contexts = new Map()
  /** Card frames Chrome put in their own process (sandboxed srcdoc): session ids. */
  const frameSessions = new Set()
  let mainFrame
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    if (msg.method === 'Runtime.executionContextCreated') {
      const ctx = msg.params.context
      if (ctx.auxData?.isDefault === true) contexts.set(ctx.id, ctx.auxData.frameId)
    }
    if (msg.method === 'Runtime.executionContextDestroyed') contexts.delete(msg.params.executionContextId)
    if (msg.method === 'Runtime.executionContextsCleared') contexts.clear()
    if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo?.type === 'iframe') frameSessions.add(msg.params.sessionId)
    if (msg.method === 'Target.detachedFromTarget') frameSessions.delete(msg.params.sessionId)
  }
  const raw = (method, params = {}, sessionId) => new Promise(res => {
    const id = ++wsSeq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  })
  const { targetId } = (await raw('Target.createTarget', { url: 'about:blank' })).result
  const session = (await raw('Target.attachToTarget', { targetId, flatten: true })).result.sessionId
  const send = (method, params = {}) => raw(method, params, session)
  const inFrame = async (sessionId, expression) => {
    const r = await raw('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
    if (r.error !== undefined || r.result?.exceptionDetails !== undefined) throw new Error('frame evaluate failed')
    return r.result?.result?.value
  }
  const evaluate = async (expression, contextId) => {
    const r = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, ...(contextId === undefined ? {} : { contextId }),
    })
    if (r.result?.exceptionDetails !== undefined) throw new Error(`evaluate: ${JSON.stringify(r.result.exceptionDetails)}`)
    return r.result?.result?.value
  }
  const shots = []
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const url = new URL(`${name}.png`, outDir)
    writeFileSync(url, Buffer.from(r.result.data, 'base64'))
    shots.push(fileURLToPath(url))
    console.log(`  SHOT  ${fileURLToPath(url)}`)
  }
  await send('Page.enable')
  await send('Runtime.enable')
  // Out-of-process frames are only reachable as their own targets.
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  mainFrame = (await send('Page.getFrameTree')).result.frameTree.frame.id
  const size = async width => {
    await send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
    await delay(600)
  }
  await size(WIDTHS[0])
  // A backgrounded headless tab lays out child frames lazily; keep it focused.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  await send('Page.navigate', { url: `${BASE}/?lang=zh` })
  for (let at = 0; at < 40; at += 1) {
    await delay(500)
    if (await evaluate('document.querySelector(".iris-row--chat") !== null') === true) break
  }
  // Open the conversation through its sidebar row, as a reader would.
  const opened = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.iris-row--chat')]
    const row = rows.find(r => r.querySelector('.iris-row__title')?.textContent?.trim() === ${JSON.stringify(CHAT_TITLE)})
    if (row === undefined) return false
    row.click()
    return true
  })()`)
  check('the conversation row is in the sidebar and was clicked', opened === true)
  let framesUp = 0
  for (let at = 0; at < 60; at += 1) {
    await delay(500)
    framesUp = await evaluate(`document.querySelectorAll('.iris-column .iris-interfaces__slot iframe').length`)
    if (framesUp > 0 && at > 6) break
  }
  const consentWaiting = await evaluate(`document.querySelector('[role=region].iris-notice--info') !== null`)
  record('card frames in the column', framesUp)
  record('a first-run consent question is waiting', consentWaiting)
  check('黑兽 has card frames in the reading column', framesUp > 0)
  await delay(4000) // let the frames report their heights

  // ---- instruments --------------------------------------------------------
  /** Install a resize counter in every child frame's default context. */
  const INSTALL = `(() => {
    if (window.__qaCol !== undefined) return 'kept'
    const qa = window.__qaCol = { resizes: 0, widths: 0, lastWidth: document.documentElement.clientWidth, inner: innerWidth }
    addEventListener('resize', () => { qa.resizes += 1 })
    new ResizeObserver(() => {
      const width = document.documentElement.clientWidth
      if (width !== qa.lastWidth) { qa.widths += 1; qa.lastWidth = width }
    }).observe(document.documentElement)
    return 'installed'
  })()`
  const frameContexts = () => [...contexts.entries()].filter(([, frameId]) => frameId !== mainFrame).map(([id]) => id)
  /** Run one expression in every card frame, in-process or not. */
  const eachFrame = async expression => {
    const out = []
    for (const id of frameContexts()) {
      try { out.push(await evaluate(expression, id)) } catch { /* a context that went away */ }
    }
    for (const sessionId of frameSessions) {
      try { out.push(await inFrame(sessionId, expression)) } catch { /* a frame that went away */ }
    }
    return out
  }
  const instrument = async () => (await eachFrame(INSTALL)).length
  const READ_FRAME = 'window.__qaCol === undefined ? null : { resizes: window.__qaCol.resizes, widths: window.__qaCol.widths, size: innerWidth + "x" + innerHeight }'
  /*
   * Split by where the frame lives. A frame whose viewport is 764px wide is an
   * interface frame in the reading column (every one of 黑兽's is); anything
   * else is a card's script or overlay frame, which lives on the card stage —
   * the box between the flanks — and is sized by it, not by the column.
   */
  const readFrames = async (columnWidth = 764) => {
    const out = { resizes: 0, widths: 0, counted: 0, stageResizes: 0, stageFrames: [] }
    for (const qa of await eachFrame(READ_FRAME)) {
      if (qa === null || qa === undefined) continue
      if (qa.size.startsWith(`${String(columnWidth)}x`)) {
        out.resizes += qa.resizes; out.widths += qa.widths; out.counted += 1
      } else {
        out.stageResizes += qa.resizes
        out.stageFrames.push(`${qa.size}:${String(qa.resizes)}`)
      }
    }
    return out
  }

  const READ = `(() => {
    const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left * 100) / 100, Math.round(b.width * 100) / 100] }
    const scroll = document.querySelector('.iris-scroll--navigable, .iris-scroll')
    const slot = scroll?.firstElementChild
    const rail = slot && slot.firstElementChild
    const all = [...document.querySelectorAll('.iris-column .iris-interfaces__slot iframe')]
    const frame = all.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
    const fb = frame?.getBoundingClientRect()
    const every = all.map(f => { const b = f.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width), Math.round(b.height)].join(',') }).sort().join(';')
    return {
      column: r(document.querySelector('.iris-column')),
      frame: fb ? [Math.round(fb.left * 100) / 100, Math.round(fb.width * 100) / 100, Math.round(fb.height * 100) / 100] : null,
      frames: every,
      composer: r(document.querySelector('.iris-composer__inner')),
      title: r(document.querySelector('.iris-masthead__title'))?.[0] ?? null,
      settings: (() => { const b = document.querySelector('.iris-masthead__row button:last-of-type')?.getBoundingClientRect(); return b ? Math.round(b.right) : null })(),
      toggle: (() => { const b = document.querySelector('.iris-overlay-toggle')?.getBoundingClientRect(); return b ? Math.round(b.right * 100) / 100 : null })(),
      rail: rail && rail !== frame ? r(rail)?.[0] ?? null : null,
      lane: scroll ? scroll.offsetWidth - scroll.clientWidth : null,
      // Read off the sidebar's class, not the shell's attribute, so the same
      // caliper runs against a build from before web §135 (the baseline).
      nav: document.querySelector('.iris-sidebar')?.classList.contains('iris-sidebar--rail') ? 'rail' : 'open',
      aside: document.querySelector('.iris-aside')?.getAttribute('data-iris-aside') ?? null,
      sidebarTrack: Math.round(document.querySelector('.iris-sidebar').getBoundingClientRect().width),
      asideTrack: Math.round(document.querySelector('.iris-aside')?.getBoundingClientRect().width ?? 0),
    }
  })()`

  const CLICK = {
    sidebarOpen: `document.querySelector('.iris-sidebar__rail .iris-sidebar__ico--flip')`,
    sidebarFold: `document.querySelector('.iris-sidebar__full .iris-brand .iris-sidebar__ico')`,
    asideOpen: `(document.querySelector('.iris-aside__strip') ?? document.querySelector('.iris-aside__bar'))`,
    asideFold: `document.querySelector('.iris-aside__bar')`,
  }
  /** Press a control the way a keyboard does: focus it, then activate it. */
  const press = which => evaluate(`(() => { const el = ${CLICK[which]}; if (!el) return false; el.focus(); el.click(); return true })()`)
  const setState = async (nav, aside) => {
    const now = await evaluate(READ)
    if ((now.nav === 'open') !== nav) await press(nav ? 'sidebarOpen' : 'sidebarFold')
    if ((now.aside === 'open') !== aside) await press(aside ? 'asideOpen' : 'asideFold')
    await delay(500)
  }

  const STATES = [
    ['both-folded', false, false],
    ['margin-open', false, true],
    ['both-open', true, true],
    ['sidebar-open', true, false],
  ]
  const table = []
  for (const width of WIDTHS) {
    await size(width)
    await setState(false, false)
    const installed = await instrument()
    record(`frame contexts instrumented at ${String(width)}`, installed)
    await delay(300)
    const baseline = await readFrames()
    const rows = []
    for (const [name, nav, aside] of STATES) {
      await setState(nav, aside)
      const read = await evaluate(READ)
      const frames = await readFrames()
      rows.push({
        name, ...read,
        frameResizes: frames.resizes - baseline.resizes,
        frameWidthChanges: frames.widths - baseline.widths,
        framesCounted: frames.counted,
        stageFrameResizes: frames.stageResizes - baseline.stageResizes,
        stageFrames: frames.stageFrames.join(' '),
      })
      await shot(`${String(width)}-${name}`)
    }
    for (const row of rows) {
      table.push({ width, ...row })
      record(`${String(width)} ${row.name}`, row)
    }
    for (const key of ['column', 'frame', 'frames', 'composer', 'title', 'settings', 'toggle', 'rail']) {
      const values = new Set(rows.map(row => JSON.stringify(row[key])))
      check(`${String(width)}: ${key} is identical in all four flank states`, values.size === 1, [...values].join(' | '))
    }
    const last = rows.at(-1)
    check(`${String(width)}: no card frame in the column saw a resize across the four states`, last.framesCounted > 0 && last.frameResizes === 0 && last.frameWidthChanges === 0,
      `resize events ${String(last.frameResizes)}, root width changes ${String(last.frameWidthChanges)}, over ${String(last.framesCounted)} frames`)
    record(`${String(width)} stage frames (card scripts / overlay, sized by the stage): resizes over the four states`, { resizes: last.stageFrameResizes, frames: last.stageFrames })
    check(`${String(width)}: the column is centred on the viewport`, Math.abs((rows[0].column?.[0] ?? 0) + (rows[0].column?.[1] ?? 0) / 2 - width / 2) < 0.51,
      JSON.stringify(rows[0].column))

    // ---- one frozen mid-slide, and what the toggle animates ---------------
    await setState(false, false)
    await press('sidebarOpen')
    await press('asideOpen')
    const animated = await evaluate(`(() => {
      const list = document.getAnimations()
      const props = [...new Set(list.map(a => a.transitionProperty ?? a.animationName ?? '?'))]
      for (const a of list) { a.pause(); a.currentTime = 45 }
      return { count: list.length, props }
    })()`)
    record(`${String(width)} animations started by opening both flanks`, animated)
    check(`${String(width)}: the toggles animate no width`, !animated.props.includes('width') && animated.count > 0, animated.props.join(','))
    await delay(100)
    const midColumn = await evaluate(READ)
    check(`${String(width)}: mid-slide, the column is where it rests`, JSON.stringify(midColumn.column) === JSON.stringify(rows[0].column), JSON.stringify(midColumn.column))
    await shot(`${String(width)}-mid-slide`)
    await evaluate('document.getAnimations().forEach(a => a.finish())')
    await delay(300)
  }

  // ---- focus, over the page (1440) ------------------------------------------
  await size(1440)
  await setState(false, false)
  await press('sidebarOpen')
  await delay(300)
  const inSidebar = await evaluate(`document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.className`)
  const inPanel = await evaluate(`document.querySelector('.iris-sidebar__full').contains(document.activeElement)`)
  check('1440: opening the sidebar over the page moves focus into it', inPanel === true, String(inSidebar))
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await delay(400)
  const afterEscape = await evaluate(`({ nav: document.querySelector('.iris-sidebar').classList.contains('iris-sidebar--rail') ? 'rail' : 'open', back: document.activeElement === document.querySelector('.iris-sidebar__rail .iris-sidebar__ico--flip') })`)
  check('1440: Escape folds the sidebar panel and focus returns to the rail', afterEscape.nav === 'rail' && afterEscape.back === true, JSON.stringify(afterEscape))
  await press('asideOpen')
  await delay(300)
  const onBar = await evaluate(`document.activeElement === document.querySelector('.iris-aside__bar')`)
  check('1440: opening the margin over the page moves focus to its bar', onBar === true)
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await delay(400)
  const asideBack = await evaluate(`({ aside: document.querySelector('.iris-aside').getAttribute('data-iris-aside'), back: document.activeElement === document.querySelector('.iris-aside__strip') })`)
  check('1440: Escape folds the margin panel and focus returns to the strip', asideBack.aside === 'shut' && asideBack.back === true, JSON.stringify(asideBack))

  // ---- reduced motion ------------------------------------------------------
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await delay(200)
  await press('sidebarOpen')
  await press('asideOpen')
  const reduced = await evaluate(`document.getAnimations().filter(a => a.effect?.target?.matches?.('.iris-sidebar__full, .iris-aside__panel')).length`)
  check('reduced motion: neither flank panel animates', reduced === 0, String(reduced))
  await send('Emulation.setEmulatedMedia', { features: [] })

  console.log('\nRECT TABLE (left, width in CSS px; frame adds height)')
  for (const row of table) {
    console.log(`  ${String(row.width)}  ${row.name.padEnd(13)} nav=${String(row.nav).padEnd(4)} aside=${String(row.aside).padEnd(4)} tracks=${String(row.sidebarTrack)}/${String(row.asideTrack)} column=${JSON.stringify(row.column)} frame=${JSON.stringify(row.frame)} composer=${JSON.stringify(row.composer)} title=${String(row.title)} settingsRight=${String(row.settings)} toggleRight=${String(row.toggle)} rail=${String(row.rail)} lane=${String(row.lane)} frameResizes=${String(row.frameResizes)} frameWidthChanges=${String(row.frameWidthChanges)}`)
  }
  writeFileSync(new URL('table.json', outDir), JSON.stringify({ table, shots }, null, 2))
} catch (error) {
  console.error(`FAIL  ${error instanceof Error ? error.stack : String(error)}`)
  failures += 1
} finally {
  clearTimeout(HARD)
  await profile.dispose()
  await data.dispose()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${String(failures)} FAILED`)
process.exit(failures === 0 ? 0 : 1)
