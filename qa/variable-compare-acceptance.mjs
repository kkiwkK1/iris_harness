/**
 * Acceptance for the tree map's 「比较变量」 mode (owner request 2026-09-26):
 * pick two floors on the map and see how their variables differ, in the
 * margin's upper half.
 *
 * On a host with a **copy** of the product's data dir, reading the 黑兽
 * conversation and the branch the copy already holds (「黑兽 - Branch #1」,
 * cut at floor 30). Nothing is generated and the comparison writes nothing: every step is
 * a click on the map or the compare header, and the page's RPCs are recorded
 * so "no generation" is a reading. (The card's own frame writes its MVU
 * variables on open, as it does in any session; those are reported apart.)
 *
 * 1. Mode on (the map's 「比较变量」), A = floor #0 by a click, B = the trunk's
 *    newest floor by a click, then B moved to #30 with the header's floor
 *    field. The reader never leaves the trunk. The page's counts equal the
 *    host's own answer for the same pair (`chat.variablesDiff` over RPC).
 * 2. A = #32 on the trunk (its floor label), B = #32 on the branch (the
 *    branch's head label): the diff renders with its counts, which again
 *    equal the host's answer. Screenshots in 雪 and 墨.
 * 3. Escape leaves the mode and the variable tree comes back.
 * 4. The floor-30 ⑂1 list's 「比较变量」 compares that floor on both lines.
 *
 * Exit 1 = a check failed, 2 = port or data-dir trouble, 3 = hard timeout.
 * Kills only its own host and Chrome (adopted by `qa/chrome-profile.mjs`).
 *
 * Usage: node qa/variable-compare-acceptance.mjs   (IRIS_PORT defaults to 8807)
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
const PORT = Number(process.env.IRIS_PORT ?? 8807)
const BASE = `http://127.0.0.1:${String(PORT)}`

const outDir = new URL('./results/variable-compare/', import.meta.url)
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

const data = dataCopy('iris-variable-compare-qa-')
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

let seq = 0
const rpc = async (method, params = {}) => {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-compare-${String(++seq)}`, method, params }),
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

  // ---- the two conversations, read from the copy -------------------------
  const rows = (await rpc('chat.list')).chats
  const trunk = rows.find(row => row.title === '黑兽' && row.parentChatId === undefined)
  const branch = rows.find(row => trunk !== undefined && row.parentChatId === trunk.chatId)
  if (trunk === undefined || branch === undefined) throw new Error('the copy has no 黑兽 with a branch')
  record('trunk', { chatId: trunk.chatId, floors: trunk.messageCount })
  record('branch', { chatId: branch.chatId, title: branch.title, floors: branch.messageCount })
  const newest = trunk.messageCount - 1

  // ---- the browser ------------------------------------------------------
  profile.adopt(spawn(CHROME, [
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile.dir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    '--window-size=1600,1000', 'about:blank',
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
  const session = (await raw('Target.attachToTarget', { targetId, flatten: true })).result.sessionId
  const send = (method, params = {}) => raw(method, params, session)
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails !== undefined) throw new Error(`evaluate: ${JSON.stringify(r.result.exceptionDetails)}`)
    return r.result?.result?.value
  }
  const shot = async name => {
    const box = await evaluate(`(() => { const a = document.querySelector('.iris-aside'); if (!a) return null; const r = a.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    const whole = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(new URL(`${name}-page.png`, outDir), Buffer.from(whole.result.data, 'base64'))
    if (box !== null) {
      const clip = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } })
      writeFileSync(new URL(`${name}-margin.png`, outDir), Buffer.from(clip.result.data, 'base64'))
    }
    console.log(`  SHOT  ${fileURLToPath(new URL(`${name}-page.png`, outDir))} (+ -margin.png)`)
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  const pageMethods = []
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data)
    if (msg.method === 'Network.requestWillBeSent' && msg.params?.request?.url?.includes('/iris/rpc')) {
      try { pageMethods.push(JSON.parse(msg.params.request.postData ?? '{}').method) } catch { /* not JSON */ }
    }
  })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  const load = async theme => {
    await send('Page.navigate', { url: `${BASE}/?lang=zh` })
    await delay(400)
    await evaluate(`(() => { try { localStorage.setItem('iris.theme', ${JSON.stringify(theme)}) } catch {} })()`)
    await send('Page.navigate', { url: `${BASE}/?lang=zh` })
    for (let at = 0; at < 40; at += 1) {
      await delay(500)
      if (await evaluate('document.querySelector(".iris-row--chat") !== null') === true) break
    }
  }
  const openInSidebar = async wanted => evaluate(`(async () => {
    for (let at = 0; at < 30; at += 1) {
      const rows = [...document.querySelectorAll('.iris-row--chat')]
        .filter(el => (el.querySelector('.iris-row__title')?.textContent ?? '').replace('↳', '').trim() === ${JSON.stringify(wanted)})
      if (rows.length === 1) { rows[0].click(); return true }
      await new Promise(r => setTimeout(r, 200))
    }
    return false
  })()`)
  const masthead = () => evaluate('document.querySelector(".iris-masthead__title")?.textContent ?? null')
  const waitFor = async (what, expression) => {
    for (let at = 0; at < 60; at += 1) {
      if (await evaluate(expression) === true) return true
      await delay(200)
    }
    check(`waited for ${what}`, false)
    return false
  }
  /** Click a floor label on the margin's map. */
  const clickFloor = floor => evaluate(`(() => {
    const label = [...document.querySelectorAll('.iris-aside .iris-tree__label--floor')]
      .find(el => el.querySelector('.iris-tree__floor')?.textContent === '#${String(floor)}')
    if (!label) return false
    label.click()
    return true
  })()`)
  /** Click a lane's head label on the map, by its title. */
  const clickHead = title => evaluate(`(() => {
    const head = [...document.querySelectorAll('.iris-aside .iris-tree__label--head')]
      .find(el => (el.querySelector('.iris-tree__title')?.textContent ?? '') === ${JSON.stringify(title)})
    if (!head) return false
    head.click()
    return true
  })()`)
  const setField = (side, floor) => evaluate(`(() => {
    const field = document.querySelector('[data-control="compare-floor-${side}"]')
    if (!field) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(field, '${String(floor)}')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  const view = () => evaluate(`(() => {
    const c = document.querySelector('[data-control="variable-compare"]')
    if (!c) return null
    return {
      head: c.querySelector('.iris-compare__head')?.textContent ?? '',
      summary: c.querySelector('[data-control="compare-summary"]')?.textContent ?? null,
      hint: c.querySelector('[data-control="compare-hint"]')?.textContent ?? null,
      notes: [...c.querySelectorAll('.iris-compare__notes li')].map(li => li.textContent),
      changed: [...c.querySelectorAll('.iris-var__row[data-changed]')].slice(0, 6).map(row => (row.querySelector('.iris-var__key')?.textContent ?? '') + ' = ' + (row.querySelector('.iris-var__value')?.textContent ?? '')),
      rows: c.querySelectorAll('.iris-var__row, .iris-var__summary').length,
      removed: c.querySelectorAll('[data-control="compare-removed"] .iris-var__row').length,
      marks: [...document.querySelectorAll('.iris-aside .iris-tree__rows .iris-tree__pick')].map(m => m.textContent),
      rings: document.querySelectorAll('.iris-aside .iris-tree__pickring').length,
    }
  })()`)
  const counts = diff => `+${String(diff.summary.added)} ~${String(diff.summary.changed)} −${String(diff.summary.removed)}`

  await load('light')
  check('the trunk opens from the sidebar', await openInSidebar('黑兽'))
  await waitFor('the masthead', `document.querySelector(".iris-masthead__title")?.textContent === "黑兽"`)
  await waitFor('the map', `document.querySelector('.iris-aside .iris-tree__label--floor') !== null`)
  await delay(800)

  // ---- 1. #0 against #30 ----------------------------------------------------
  check('the 「比较变量」 switch is on the map', await evaluate(`(() => { const b = document.querySelector('[data-control="tree-compare"]'); if (!b) return false; b.click(); return true })()`))
  await waitFor('the compare view', `document.querySelector('[data-control="variable-compare"]') !== null`)
  const empty = await view()
  record('mode on', empty)
  check('the variable tree gives way to the comparison', await evaluate(`document.querySelector('.iris-aside__inner > .iris-var__tools') === null`))
  check('A = #0 by a click', await clickFloor(0))
  check(`B = #${String(newest)} by a click`, await clickFloor(newest))
  await waitFor('the first diff', `document.querySelector('[data-control="compare-summary"]') !== null`)
  check('B moved to #30 with the header field', await setField('b', 30))
  await delay(1200)
  const first = await view()
  record('#0 ↔ #30 on the page', first)
  const host1 = (await rpc('chat.variablesDiff', { a: { chatId: trunk.chatId, floor: 0 }, b: { chatId: trunk.chatId, floor: 30 } })).diff
  record('#0 ↔ #30 from the host', { summary: host1.summary, a: host1.a, b: host1.b, entries: host1.entries.length })
  check('the page shows the host’s counts for #0 ↔ #30', first?.summary === counts(host1), `${String(first?.summary)} vs ${counts(host1)}`)
  check('the reader is still on the trunk', await masthead() === '黑兽')
  check('A and B are marked on the map', JSON.stringify(first?.marks) === '["A","B"]' || (first?.marks?.includes('A') === true), JSON.stringify(first?.marks))
  if (host1.b.missing !== undefined) {
    check('a floor with no table says so', (first?.notes ?? []).some(note => note.includes('B')), JSON.stringify(first?.notes))
  }
  await shot('1-floor0-vs-floor30')

  // ---- 2. #32 trunk against #32 branch ------------------------------------
  check(`A = #${String(newest)} on the trunk`, await clickFloor(newest))
  check('B = the branch’s newest floor, by its head', await clickHead(branch.title))
  await delay(1500)
  const second = await view()
  record(`#${String(newest)} trunk ↔ branch on the page`, second)
  const host2 = (await rpc('chat.variablesDiff', {
    a: { chatId: trunk.chatId, floor: newest },
    b: { chatId: branch.chatId, floor: branch.messageCount - 1 },
  })).diff
  record(`#${String(newest)} trunk ↔ branch from the host`, { summary: host2.summary, a: host2.a, b: host2.b, first: host2.entries.slice(0, 8).map(e => `${e.kind} ${e.path.join('/')}`) })
  check('the page shows the host’s counts for trunk ↔ branch', second?.summary === counts(host2), `${String(second?.summary)} vs ${counts(host2)}`)
  check('the header names both lines', (second?.head ?? '').includes('黑兽') && (second?.head ?? '').includes(branch.title), second?.head)
  check('A and B are both marked on the map (B on the branch’s head)', (second?.marks ?? []).includes('A') && (second?.marks ?? []).includes('B'), JSON.stringify(second?.marks))
  check('changed rows are drawn with their two readings', (second?.changed ?? []).some(row => row.includes('→')), JSON.stringify(second?.changed))
  check('the reader is still on the trunk', await masthead() === '黑兽')
  await shot('2-trunk32-vs-branch32')
  // 「只看变化」 off: the whole of B around the changes.
  await evaluate(`document.querySelector('[data-control="compare-only-changes"]')?.click()`)
  await delay(400)
  const full = await view()
  record('only-changes off', { rows: full?.rows })
  check('turning 「只看变化」 off draws more rows', (full?.rows ?? 0) > (second?.rows ?? 0), `${String(full?.rows)} > ${String(second?.rows)}`)
  await evaluate(`document.querySelector('[data-control="compare-only-changes"]')?.click()`)
  // Swap.
  await evaluate(`document.querySelector('[data-control="compare-swap"]')?.click()`)
  await delay(1200)
  const swapped = await view()
  check('swap mirrors the counts', swapped?.summary === `+${String(host2.summary.removed)} ~${String(host2.summary.changed)} −${String(host2.summary.added)}`, String(swapped?.summary))
  await evaluate(`document.querySelector('[data-control="compare-swap"]')?.click()`)
  await delay(1200)

  // The same comparison in 墨.
  await evaluate(`(() => { try { localStorage.setItem('iris.theme', 'dark') } catch {} ; document.documentElement.setAttribute('data-iris-theme', 'dark') })()`)
  await delay(500)
  await shot('2-trunk32-vs-branch32-dark')
  await evaluate(`(() => { try { localStorage.setItem('iris.theme', 'light') } catch {} ; document.documentElement.setAttribute('data-iris-theme', 'light') })()`)
  await delay(300)

  // ---- 3. Escape ------------------------------------------------------------
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await delay(400)
  check('Escape leaves the mode', await evaluate(`document.querySelector('[data-control="variable-compare"]') === null`))
  check('the variable tree is back', await evaluate(`document.querySelector('.iris-aside__inner .iris-var') !== null || document.querySelector('.iris-aside__inner .iris-aside__empty') !== null`))
  await shot('3-after-escape')

  // ---- 4. the ⑂N list ---------------------------------------------------------
  const forked = await evaluate(`(async () => {
    const badge = document.querySelector('article[data-floor="30"] [data-control="floor-forks"]')
    if (!badge) return 'no badge'
    badge.scrollIntoView({ block: 'center' })
    badge.click()
    for (let at = 0; at < 20; at += 1) {
      const group = [...document.querySelectorAll('[role="menuitem"]')].find(el => (el.textContent ?? '').trim() === '比较变量：')
      if (group) {
        group.click()
        await new Promise(r => setTimeout(r, 150))
        const rows = [...document.querySelectorAll('[role="menuitem"]')].filter(el => (el.textContent ?? '').trim() === ${JSON.stringify(branch.title)})
        if (rows.length < 2) return 'no submenu row'
        rows.at(-1).click()
        return 'ok'
      }
      await new Promise(r => setTimeout(r, 100))
    }
    return 'no group'
  })()`)
  check('⑂1 on floor 30 → 比较变量 → the branch', forked === 'ok', forked)
  await delay(1200)
  const fromBadge = await view()
  record('⑂1 compare', fromBadge)
  check('the badge comparison names #30 on both lines', (fromBadge?.head ?? '').includes(branch.title) && await evaluate(`document.querySelector('[data-control="compare-floor-a"]')?.value === '30' && document.querySelector('[data-control="compare-floor-b"]')?.value === '30'`))
  await shot('4-fork-badge-compare')
  await evaluate(`document.querySelector('[data-control="compare-close"]')?.click()`)

  // ---- nothing generated, nothing written -------------------------------------
  // Generation and chat edits are what this feature must never cause. The
  // card's own frame does write — 黑兽's MVU scripts call script.setVariables
  // and script.setExtensionSettings when the chat opens — and those are read
  // and reported, not attributed to the comparison.
  const chatWrites = pageMethods.filter(method => /^chat\.(send|regenerate|continue|impersonate|swipe|branch|delete|rename|editMessage|deleteMessage)$/u.test(method))
  record('page RPC methods', [...new Set(pageMethods)])
  record('card-frame writes seen (not the comparison)', pageMethods.filter(method => method.startsWith('script.set')))
  check('the page generated nothing and edited no chat', chatWrites.length === 0, JSON.stringify(chatWrites))
  check('the page asked chat.variablesDiff', pageMethods.includes('chat.variablesDiff'))
} catch (error) {
  failures += 1
  console.error(`FAIL  ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  clearTimeout(HARD)
  await profile.dispose().catch(() => undefined)
  await data.dispose().catch(() => undefined)
}
console.log(failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`)
process.exit(failures === 0 ? 0 : 1)
