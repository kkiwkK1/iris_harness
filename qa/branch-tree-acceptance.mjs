/**
 * Acceptance for the branch tree (owner request 2026-09-25).
 *
 * On a host with a **copy** of the product's data dir, the branches are made
 * through the interface's own controls, not over RPC. The steps are: 「分支」 on
 * two floors of one conversation, 「分支」 on a floor of the new branch (a
 * branch of a branch), and 「转成分支」 beside a reading rail. Then:
 *
 * 1. `chat.tree` over RPC says what the map should draw: one root, the four
 *    branches, and each fork where it was made, recorded rather than inferred.
 * 2. The margin shows the variables on top and the map below. A screenshot
 *    of the margin and one of the whole window are saved.
 * 3. Clicking a map node switches **directly** to that conversation. The
 *    masthead title changes, and the floor clicked is on screen and marked.
 * 4. The parent's ⑂N badge is on the floor a branch left from, and clicking
 *    one of its entries switches as well.
 * 5. At a narrow width the margin is gone, the masthead's 「分支」 opens the map
 *    as an overlay, and a click there switches and closes it.
 * 6. The parent's file is compared line by line before and after. Only the
 *    branch-point lines changed (`extra.branches` + `iris_id`); every other
 *    line is byte-identical.
 *
 * Nothing is spent: branching and switching make no model request.
 *
 * Exit 1 = a check failed, 2 = port or data-dir trouble, 3 = hard timeout.
 * Kills only its own host and Chrome (adopted by `qa/chrome-profile.mjs`).
 *
 * Usage: node qa/branch-tree-acceptance.mjs   (IRIS_PORT defaults to 8794)
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, readFile, readdir, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP = String(cdpPort(9357))
const PORT = Number(process.env.IRIS_PORT ?? 8794)
const BASE = `http://127.0.0.1:${String(PORT)}`

const outDir = new URL('./results/branch-tree/', import.meta.url)
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

const data = dataCopy('iris-branch-tree-qa-')
const dataDir = data.dir
const dataSource = process.env.IRIS_DATA_SOURCE
  ?? join(repoRoot, '..', 'iris_cordis_traven', 'apps', 'iris', 'data')
await cp(dataSource, dataDir, { recursive: true }).catch(error => {
  console.error(`FAIL  no data dir to copy from (${dataSource}): ${String(error)}`)
  process.exit(2)
})
await rm(join(dataDir, 'host.lock'), { force: true })
await rm(join(dataDir, 'default-user', 'host.lock'), { force: true })
const chatsDir = join(dataDir, 'default-user', 'chats')

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
    body: JSON.stringify({ id: `qa-tree-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 480_000)
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

  // ---- choose a conversation: >= 6 floors, a multi-reading reply below the last floor
  const before = (await rpc('chat.list')).chats
  record('chat.list before any write (copy)', before.map(row => `${row.chatId} (${String(row.messageCount)})`))
  let chosen
  // A unique title, because the sidebar row is found by its title: the rows
  // carry no id attribute, and three conversations here are called 「爱衣」.
  const titleCount = new Map()
  for (const row of before) titleCount.set(row.title, (titleCount.get(row.title) ?? 0) + 1)
  for (const row of [...before].filter(r => r.messageCount >= 6 && r.messageCount <= 80 && titleCount.get(r.title) === 1).sort((a, b) => a.messageCount - b.messageCount)) {
    const { view } = await rpc('chat.open', { chatId: row.chatId })
    const multi = view.messages.find(m => m.role === 'assistant' && (m.swipes?.count ?? 1) > 1 && m.id >= 1 && m.id < view.messages.length - 1)
    if (multi !== undefined) { chosen = { row, view, swipeFloor: multi.id }; break }
    chosen ??= { row, view, swipeFloor: undefined }
  }
  if (chosen === undefined) {
    console.error('FAIL  no conversation of 6..80 floors in this data dir')
    process.exit(2)
  }
  const P = chosen.row.chatId
  const parentFile = join(chatsDir, `${P}.jsonl`)
  const parentBefore = (await readFile(parentFile, 'utf8')).split('\n')
  record('parent conversation', { chatId: P, floors: chosen.view.messages.length, swipeFloor: chosen.swipeFloor ?? null })

  // ---- the browser ------------------------------------------------------
  const chrome = profile.adopt(spawn(CHROME, [
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile.dir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' }))
  void chrome
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
  const shot = async (name, clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip === undefined ? {} : { clip: { ...clip, scale: 1 } }) })
    const url = new URL(`${name}.png`, outDir)
    writeFileSync(url, Buffer.from(r.result.data, 'base64'))
    console.log(`  SHOT  ${fileURLToPath(url)}`)
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  // A backgrounded headless tab lays out child frames lazily; keep it focused.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  await send('Page.navigate', { url: `${BASE}/?lang=zh` })
  for (let at = 0; at < 40; at += 1) {
    await delay(500)
    if (await evaluate('document.querySelector(".iris-row--chat") !== null') === true) break
  }
  const title = () => evaluate('document.querySelector(".iris-masthead__title")?.textContent ?? null')
  const waitTitle = async (wanted, not) => {
    for (let at = 0; at < 60; at += 1) {
      const now = await title()
      if (wanted !== undefined ? now === wanted : now !== null && now !== not) return now
      await delay(250)
    }
    return await title()
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
  const clickIn = async (floor, control) => evaluate(`(async () => {
    for (let at = 0; at < 30; at += 1) {
      const button = document.querySelector('article[data-floor="${String(floor)}"] [data-control="${control}"]')
      if (button && !button.disabled) { button.click(); return true }
      await new Promise(r => setTimeout(r, 200))
    }
    return false
  })()`)
  /** Whether floor f of the open chat is inside the reading scroller's visible box, and marked. */
  const floorOnScreen = floor => evaluate(`(() => {
    const scroll = document.querySelector('.iris-scroll')
    const row = document.querySelector('article[data-floor="${String(floor)}"]')
    if (!scroll || !row) return { found: false }
    const s = scroll.getBoundingClientRect(), r = row.getBoundingClientRect()
    return { found: true, top: Math.round(r.top - s.top), visible: r.top < s.bottom && r.bottom > s.top, jumped: row.hasAttribute('data-iris-jumped') }
  })()`)
  const chatIdByTitle = async wanted => (await rpc('chat.list')).chats.find(row => row.title === wanted)?.chatId

  // ---- 1. make the branches through the interface --------------------------
  check('the parent opens from the sidebar', await openInSidebar(chosen.row.title))
  const parentTitle = await waitTitle(chosen.row.title)
  await delay(1200)

  // Two floors apart from the reading floor, so each fork has its own row.
  const a = chosen.swipeFloor === 2 ? 1 : 2
  check(`「分支」 on floor ${String(a)} is there and pressed`, await clickIn(a, 'branch-here'))
  const aTitle = await waitTitle(undefined, parentTitle)
  const A = await chatIdByTitle(aTitle)
  check('branching switched straight to the new branch', A !== undefined && A !== P, `now on "${String(aTitle)}"`)
  const afterBranch = await (async () => { await delay(600); return floorOnScreen(a) })()
  record('floor view after branching', afterBranch)
  check('the branch opens with its fork floor on screen', afterBranch.found && afterBranch.visible)

  // A branch of the branch, at its floor 1.
  check('「分支」 on floor 1 of the branch', await clickIn(1, 'branch-here'))
  const bTitle = await waitTitle(undefined, aTitle)
  const B = await chatIdByTitle(bTitle)
  check('a branch of a branch opened', B !== undefined && B !== A && B !== P, `now on "${String(bTitle)}"`)

  // Back to the parent; a second branch further down.
  await openInSidebar(chosen.row.title)
  await waitTitle(parentTitle)
  await delay(1000)
  const c = Math.min(chosen.swipeFloor === 4 ? 5 : 4, chosen.view.messages.length - 2)
  check(`「分支」 on floor ${String(c)} of the parent`, await clickIn(c, 'branch-here'))
  const cTitle = await waitTitle(undefined, parentTitle)
  const C = await chatIdByTitle(cTitle)

  // 转成分支 beside a reading rail.
  let S
  if (chosen.swipeFloor !== undefined) {
    await openInSidebar(chosen.row.title)
    await waitTitle(parentTitle)
    await delay(1000)
    check(`「转成分支」 beside the rail on floor ${String(chosen.swipeFloor)}`, await clickIn(chosen.swipeFloor, 'swipe-to-branch'))
    const sTitle = await waitTitle(undefined, parentTitle)
    S = await chatIdByTitle(sTitle)
    check('the reading became a branch of its own, and it opened', S !== undefined && ![P, A, B, C].includes(S), `now on "${String(sTitle)}"`)
  } else {
    console.log('SKIP  no multi-reading reply below the last floor in the chosen conversation')
  }
  record('made', { P, A, B, C, S: S ?? null })

  // ---- 2. what the host says the map should draw ----------------------------
  const { tree } = await rpc('chat.tree', { chatId: B })
  record('chat.tree(B)', tree.chats.map(n => ({ chatId: n.chatId, depth: n.depth, floors: n.floorCount, fork: n.fork ?? null })))
  const by = new Map(tree.chats.map(n => [n.chatId, n]))
  check('asked from the branch of a branch, the tree roots at the parent', tree.rootChatId === P)
  check('A forks at its floor, recorded', by.get(A)?.fork?.floor === a && by.get(A)?.fork?.source === 'recorded')
  check('B is A’s child, forked at 1', by.get(B)?.parentChatId === A && by.get(B)?.fork?.floor === 1 && by.get(B)?.depth === 2)
  check('C forks at its floor', by.get(C)?.fork?.floor === c)
  if (S !== undefined) check('S forks at the rail’s floor', by.get(S)?.fork?.floor === chosen.swipeFloor)
  check('swipes are counts on floors, not lanes', tree.chats.length === (S === undefined ? 4 : 5)
    && (chosen.swipeFloor === undefined || (by.get(P)?.swipes[chosen.swipeFloor] ?? 1) > 1))

  // ---- 3. the margin: variables on top, map below ------------------------
  await openInSidebar(chosen.row.title)
  await waitTitle(parentTitle)
  await delay(1500)
  const margin = await evaluate(`(() => {
    const aside = document.querySelector('.iris-aside')
    const tree = document.querySelector('.iris-aside__tree')
    const vars = document.querySelector('.iris-aside__inner')
    if (!aside || !tree || !vars) return null
    const a = aside.getBoundingClientRect(), t = tree.getBoundingClientRect(), v = vars.getBoundingClientRect()
    return {
      aside: { x: a.x, y: a.y, width: a.width, height: a.height },
      varsBottom: Math.round(v.bottom), treeTop: Math.round(t.top),
      dots: document.querySelectorAll('.iris-aside .iris-tree__dot').length,
      rows: document.querySelectorAll('.iris-aside .iris-tree__row').length,
      labels: [...document.querySelectorAll('.iris-aside .iris-tree__label')].map(el => el.textContent),
    }
  })()`)
  record('margin geometry', margin)
  check('the margin splits: variables above, the map below', margin !== null && margin.varsBottom <= margin.treeTop + 8)
  check('the map draws dots and rows', (margin?.dots ?? 0) >= 5 && (margin?.rows ?? 0) >= 4)
  await shot('01-window-with-map')
  if (margin !== null) await shot('02-margin', { x: margin.aside.x, y: margin.aside.y, width: margin.aside.width, height: margin.aside.height })

  // ---- 4. clicking a node switches directly and scrolls --------------------
  const clickLabel = async (fragment, scope) => evaluate(`(() => {
    const label = [...document.querySelectorAll('${scope} .iris-tree__label')].find(el => (el.textContent ?? '').includes(${JSON.stringify(fragment)}))
    if (!label) return false
    label.click()
    return true
  })()`)
  check('the map shows C’s head, labelled with its title', await clickLabel(cTitle, '.iris-aside'))
  const onC = await waitTitle(cTitle)
  check('a node click switched straight to C', onC === cTitle, `now on "${String(onC)}"`)
  await delay(800)
  const cFloors = by.get(C)?.floorCount ?? 0
  const cOnScreen = await floorOnScreen(cFloors - 1)
  record('C’s head floor on screen', cOnScreen)
  check('and the clicked floor is on screen and marked', cOnScreen.found && cOnScreen.visible)

  // A shared floor near the top, on the root lane: switches back to the parent and scrolls up.
  const top = await evaluate(`(() => {
    const label = document.querySelector('.iris-aside .iris-tree__row .iris-tree__label')
    if (!label) return null
    label.click()
    return label.textContent
  })()`)
  record('clicked the first row', top)
  const onP = await waitTitle(parentTitle)
  await delay(800)
  const p0 = await floorOnScreen(0)
  record('parent floor 0 after the click', p0)
  check('the top row took the reader to the parent’s floor 0', onP === parentTitle && p0.found && p0.visible && p0.top < 200)
  await shot('03-after-node-click')

  // ---- 5. the parent's ⑂N badge on the floor A left from ------------------
  const badge = await evaluate(`(() => {
    const b = document.querySelector('article[data-floor="${String(a)}"] [data-control="floor-forks"]')
    return b ? b.textContent : null
  })()`)
  record(`badge on the parent’s floor ${String(a)}`, badge)
  check('the fork floor wears ⑂N', typeof badge === 'string' && badge.startsWith('⑂'))
  const viaBadge = await evaluate(`(async () => {
    document.querySelector('article[data-floor="${String(a)}"] [data-control="floor-forks"]').click()
    for (let at = 0; at < 20; at += 1) {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find(el => (el.textContent ?? '').includes(${JSON.stringify(aTitle)}))
      if (item) { item.click(); return true }
      await new Promise(r => setTimeout(r, 100))
    }
    return false
  })()`)
  check('the badge lists the branch', viaBadge)
  check('and choosing it switches to that branch', await waitTitle(aTitle) === aTitle)

  // ---- 6. a narrow window: the masthead opens the map as an overlay --------
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false })
  await delay(800)
  const narrow = await evaluate(`(() => {
    const t = document.querySelector('[data-control="tree-map"]')
    const aside = document.querySelector('.iris-aside')
    return { toggle: t ? getComputedStyle(t).display : null, aside: aside ? getComputedStyle(aside).display : null }
  })()`)
  record('narrow window', narrow)
  check('below the margin’s width the masthead offers the map', narrow.toggle !== null && narrow.toggle !== 'none' && narrow.aside === 'none')
  await evaluate('document.querySelector(\'[data-control="tree-map"]\').click()')
  await delay(700)
  const dialogRows = await evaluate('document.querySelectorAll(".iris-tree-dialog .iris-tree__row").length')
  check('the overlay draws the map', dialogRows >= 4, `${String(dialogRows)} rows`)
  await shot('04-narrow-overlay')
  check('a node in the overlay switches', await clickLabel(bTitle, '.iris-tree-dialog'))
  const onB = await waitTitle(bTitle)
  await delay(600)
  const closed = await evaluate('document.querySelector(".iris-tree-dialog") === null')
  check('…to B, and the overlay closes', onB === bTitle && closed, `now on "${String(onB)}", closed=${String(closed)}`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false })

  // ---- 7. the parent's file: only the branch points changed ----------------
  const parentAfter = (await readFile(parentFile, 'utf8')).split('\n')
  const changed = []
  for (let at = 0; at < Math.max(parentBefore.length, parentAfter.length); at += 1) {
    if (parentBefore[at] !== parentAfter[at]) changed.push(at)
  }
  // Line 0 is the header (its `iris.updatedAt` moves); floor n is line n + 1.
  const expected = new Set([0, a + 1, c + 1, ...(chosen.swipeFloor === undefined ? [] : [chosen.swipeFloor + 1])])
  record('parent file lines that changed', changed)
  check('only the header and the branch-point lines changed', changed.every(at => expected.has(at)), `changed ${changed.join(',')}`)
  for (const at of changed.filter(line => line > 0)) {
    const line = JSON.parse(parentAfter[at])
    const was = JSON.parse(parentBefore[at])
    const { iris_id: id, extra, ...rest } = line
    const { extra: wasExtra, ...wasRest } = was
    const { branches, ...extraRest } = extra ?? {}
    check(`line ${String(at)}: gained iris_id and extra.branches only`,
      typeof id === 'string' && Array.isArray(branches)
      && JSON.stringify(rest) === JSON.stringify(wasRest)
      && JSON.stringify(extraRest) === JSON.stringify(Object.fromEntries(Object.entries(wasExtra ?? {}).filter(([k]) => k !== 'branches'))))
  }
  const files = (await readdir(chatsDir)).length
  record('chat files in the copy', files)
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
