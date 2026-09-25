/**
 * Acceptance for branch management on the tree map (owner request
 * 2026-09-26): delete, rename, per-branch colour, and line weight by activity.
 *
 * On a host with a **copy** of the product's data dir. Every branch is made
 * with the interface's own 「分支」 button (which copies floors; nothing is
 * generated, so nothing is spent), including branches of branches:
 *
 *     P ─┬─ A (P#2) ─┬─ C (A#1, above A's fork)
 *        │           └─ B (A#2) ── D (B#2)
 *        └─ E (P#n-3)
 *
 * Then, through the map's own controls:
 *
 * 1. Colour: every lane has a hue, the root is the trunk, the branches' hues
 *    are all different, and each branch's sidebar 「↳」 is its lane's colour.
 *    The lane tooltip states the weight's definition. Screenshots in 雪 and 墨.
 * 2. Rename A inline (⋯ → 重命名, type, Enter): the sidebar, the masthead and
 *    the map all show the new title, and so does `chat.list`.
 * 3. Delete A, a middle branch with children, from its ⋯: the dialog names A
 *    and its floor count and says the children re-attach to P. Afterwards
 *    `chat.tree` has C on P at 1, B on P at 2, D still under B, and no lane
 *    names a parent that is gone.
 * 4. Delete the branch being read (B): the reader lands on its parent P, and
 *    D re-attaches to P.
 * 5. Delete the root P while reading it: the first child (C, leaving at 1) is
 *    promoted, D and E re-attach to it at 1, and the reader lands on C. E now
 *    owns most of P's floors and is drawn thickest. Screenshots in 雪 and 墨.
 * 6. Backups are kept: the copy's backup dir still has P's snapshots.
 *
 * Exit 1 = a check failed, 2 = port or data-dir trouble, 3 = hard timeout.
 * Kills only its own host and Chrome (adopted by `qa/chrome-profile.mjs`).
 *
 * Usage: node qa/branch-manage-acceptance.mjs   (IRIS_PORT defaults to 8804)
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, readdir, rm } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP = String(cdpPort(9367))
const PORT = Number(process.env.IRIS_PORT ?? 8804)
const BASE = `http://127.0.0.1:${String(PORT)}`

const outDir = new URL('./results/branch-manage/', import.meta.url)
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

const data = dataCopy('iris-branch-manage-qa-')
const dataDir = data.dir
const dataSource = process.env.IRIS_DATA_SOURCE
  ?? join(repoRoot, '..', 'iris_cordis_traven', 'apps', 'iris', 'data')
await cp(dataSource, dataDir, { recursive: true }).catch(error => {
  console.error(`FAIL  no data dir to copy from (${dataSource}): ${String(error)}`)
  process.exit(2)
})
await rm(join(dataDir, 'host.lock'), { force: true })
await rm(join(dataDir, 'default-user', 'host.lock'), { force: true })
const userDir = join(dataDir, 'default-user')

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
    body: JSON.stringify({ id: `qa-manage-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}
/** Every method this script sent, so "nothing was generated" is a reading, not a promise. */
const sent = []
const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 540_000)
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

  // ---- choose a root: 10..80 floors, a unique title, no family of its own yet
  const before = (await rpc('chat.list')).chats
  record('chat.list before any write (copy)', before.length)
  const titleCount = new Map()
  for (const row of before) titleCount.set(row.title, (titleCount.get(row.title) ?? 0) + 1)
  const parents = new Set(before.map(row => row.parentChatId).filter(id => id !== undefined))
  const alone = [...before]
    .filter(r => r.messageCount >= 10 && r.messageCount <= 80 && r.parentChatId === undefined && !parents.has(r.chatId))
    .sort((a, b) => (titleCount.get(a.title) === 1 ? 0 : 1) - (titleCount.get(b.title) === 1 ? 0 : 1) || a.messageCount - b.messageCount)
  let chosen = alone[0]
  // The sidebar row is found by its title, and the copy's three 「爱衣」 share
  // one: give the chosen one a unique title first (a write to the copy only).
  if (chosen !== undefined && titleCount.get(chosen.title) !== 1) {
    const unique = `${chosen.title}·验收`
    await rpc('chat.rename', { chatId: chosen.chatId, title: unique })
    record('renamed the chosen root in the copy', { from: chosen.title, to: unique })
    chosen = { ...chosen, title: unique }
  }
  if (chosen === undefined) {
    record('rows', before.map(r => `${r.title} (${String(r.messageCount)})${r.parentChatId === undefined ? '' : ' <-'}${parents.has(r.chatId) ? ' parent' : ''}`))
    throw new Error('no stand-alone conversation of 10..80 floors with a unique title in this data dir')
  }
  const P = chosen.chatId
  const floorsP = chosen.messageCount
  record('root', { chatId: P, floors: floorsP })

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
  await send('Network.enable')
  // Every RPC the page sends is recorded, so the absence of a generation is read.
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
  await load('light')

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
  const byTitle = async wanted => (await rpc('chat.list')).chats.find(row => row.title === wanted)?.chatId
  /** Branch the open chat at a floor with 「分支」 and return the new chat's id and title. */
  const branchAt = async (floor, fromTitle) => {
    check(`「分支」 on floor ${String(floor)} of "${fromTitle}"`, await clickIn(floor, 'branch-here'))
    const now = await waitTitle(undefined, fromTitle)
    const id = await byTitle(now)
    check(`… opened the new branch "${String(now)}"`, id !== undefined && now !== fromTitle)
    await delay(700)
    return { id, title: now }
  }
  const openAndWait = async wanted => {
    await openInSidebar(wanted)
    const now = await waitTitle(wanted)
    await delay(900)
    return now
  }
  /** The ⋯ menu of a lane head in the margin, then one of its items. */
  const laneAction = async (laneTitle, item) => evaluate(`(async () => {
    const head = [...document.querySelectorAll('.iris-aside .iris-tree__head')]
      .find(el => (el.querySelector('.iris-tree__title')?.textContent ?? '') === ${JSON.stringify(laneTitle)})
    if (!head) return 'no head'
    head.querySelector('[data-control="tree-lane-actions"]').click()
    for (let at = 0; at < 20; at += 1) {
      const entry = [...document.querySelectorAll('[role="menuitem"]')].find(el => (el.textContent ?? '').trim() === ${JSON.stringify(item)})
      if (entry) { entry.click(); return 'ok' }
      await new Promise(r => setTimeout(r, 100))
    }
    return 'no item'
  })()`)
  const dialogText = () => evaluate(`(async () => {
    for (let at = 0; at < 20; at += 1) {
      const d = document.querySelector('.iris-tree-delete')
      if (d) return d.textContent
      await new Promise(r => setTimeout(r, 100))
    }
    return null
  })()`)
  const confirmDelete = () => evaluate('(() => { const b = document.querySelector(\'[data-control="tree-delete-confirm"]\'); if (!b) return false; b.click(); return true })()')
  const waitGone = async id => {
    for (let at = 0; at < 40; at += 1) {
      if (!(await rpc('chat.list')).chats.some(row => row.chatId === id)) return true
      await delay(250)
    }
    return false
  }
  const tree = async id => (await rpc('chat.tree', { chatId: id })).tree
  const whole = t => t.chats.filter(n => n.parentChatId === undefined).length === 1
    && t.chats.every(n => n.detachedFrom === undefined)
    && t.chats.every(n => n.parentChatId === undefined || t.chats.some(m => m.chatId === n.parentChatId))
  const margin = async () => evaluate(`(() => {
    const aside = document.querySelector('.iris-aside')
    if (!aside) return null
    const a = aside.getBoundingClientRect()
    const lanes = [...aside.querySelectorAll('.iris-tree__lane')].map(g => {
      const run = g.querySelector('.iris-tree__run:not(.iris-tree__run--path)') ?? g.querySelector('.iris-tree__edge')
      return {
        hue: g.getAttribute('data-iris-hue'),
        weight: Number(g.getAttribute('data-weight')),
        stroke: run ? getComputedStyle(run).stroke : null,
        tip: g.querySelector('title')?.textContent ?? '',
      }
    })
    const heads = [...aside.querySelectorAll('.iris-tree__head')].map(h => ({
      title: h.querySelector('.iris-tree__title')?.textContent ?? '',
      hue: h.getAttribute('data-iris-hue'),
      swatch: getComputedStyle(h.querySelector('.iris-tree__swatch')).backgroundColor,
    }))
    const markers = [...document.querySelectorAll('.iris-row--chat')].map(row => {
      const mark = row.querySelector('.iris-row__branch')
      return mark ? { title: (row.querySelector('.iris-row__title')?.textContent ?? '').replace('↳', '').trim(), hue: mark.getAttribute('data-iris-hue'), color: getComputedStyle(mark).color } : null
    }).filter(Boolean)
    return { box: { x: a.x, y: a.y, width: a.width, height: a.height }, lanes, heads, markers, theme: document.documentElement.getAttribute('data-iris-theme') }
  })()`)

  // ---- make the family through the interface -----------------------------
  const titleP = await openAndWait(chosen.title)
  check('the root opens from the sidebar', titleP === chosen.title)
  const A = await branchAt(2, titleP)
  const C = await branchAt(1, A.title)
  await openAndWait(A.title)
  const B = await branchAt(2, A.title)
  const D = await branchAt(2, B.title)
  await openAndWait(titleP)
  const deep = floorsP - 3
  const E = await branchAt(deep, titleP)
  const ids = { P, A: A.id, B: B.id, C: C.id, D: D.id, E: E.id }
  record('made', ids)

  const t0 = await tree(P)
  const by0 = new Map(t0.chats.map(n => [n.chatId, n]))
  record('chat.tree before', t0.chats.map(n => `${n.chatId}<-${n.parentChatId ?? '-'}@${String(n.fork?.floor ?? '-')}`))
  check('the family is nested as made', by0.get(C.id)?.parentChatId === A.id && by0.get(B.id)?.parentChatId === A.id
    && by0.get(D.id)?.parentChatId === B.id && by0.get(E.id)?.parentChatId === P && t0.chats.length === 6)

  // ---- 1. colour, weight, tooltip; screenshots in 雪 and 墨 --------------
  await openAndWait(titleP)
  await delay(800)
  const m1 = await margin()
  record('lanes (雪)', m1?.lanes.map(l => `${l.hue}:${String(l.weight)}px ${l.stroke}`))
  const branchHues = (m1?.lanes ?? []).filter(l => l.hue !== 'trunk').map(l => l.hue)
  check('six lanes, the root as the trunk and five different branch colours',
    m1?.lanes.length === 6 && m1.lanes.filter(l => l.hue === 'trunk').length === 1 && new Set(branchHues).size === 5)
  check('the root, with floors of its own, is drawn thicker than the fresh branches',
    (m1?.lanes.find(l => l.hue === 'trunk')?.weight ?? 0) > Math.max(...(m1?.lanes ?? []).filter(l => l.hue !== 'trunk').map(l => l.weight)))
  check('the lane tooltip states the definition', (m1?.lanes[0]?.tip ?? '').includes('线宽') && (m1?.lanes[0]?.tip ?? '').includes('7 天减半'), m1?.lanes[0]?.tip)
  const markE = m1?.markers.find(mk => mk.title === E.title)
  const headE = m1?.heads.find(h => h.title === E.title)
  record('E: sidebar marker vs lane swatch', { marker: markE, head: headE })
  check('a branch’s sidebar 「↳」 wears its lane’s colour', markE !== undefined && headE !== undefined
    && markE.hue === headE.hue && markE.color === headE.swatch)
  if (m1 !== null) await shot('01-snow-six-lanes', m1.box)
  await load('dark')
  await openAndWait(titleP)
  const m1d = await margin()
  check('墨 is on, and the lanes repaint', m1d?.theme === 'dark' && m1d.lanes.length === 6
    && m1d.lanes[1]?.stroke !== m1?.lanes[1]?.stroke, `${String(m1?.lanes[1]?.stroke)} → ${String(m1d?.lanes[1]?.stroke)}`)
  if (m1d !== null) await shot('02-ink-six-lanes', m1d.box)
  await load('light')

  // ---- 2. rename A inline ----------------------------------------------------
  await openAndWait(A.title)
  const renamed = '重命名测试·雨夜'
  check('⋯ → 重命名 on A’s lane', await laneAction(A.title, '重命名') === 'ok')
  await delay(300)
  const focused = await evaluate('document.activeElement?.getAttribute("data-control")')
  check('the name became a focused field', focused === 'tree-rename', String(focused))
  await send('Input.insertText', { text: renamed })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const masthead = await waitTitle(renamed)
  await delay(900)
  const seen = await evaluate(`(() => ({
    sidebar: [...document.querySelectorAll('.iris-row--chat .iris-row__title')].some(el => el.textContent.replace('↳', '').trim() === ${JSON.stringify(renamed)}),
    map: [...document.querySelectorAll('.iris-aside .iris-tree__title')].some(el => el.textContent === ${JSON.stringify(renamed)}),
  }))()`)
  record('rename seen', { masthead, ...seen })
  check('the new title is in the masthead, the sidebar and the map', masthead === renamed && seen.sidebar && seen.map)
  check('… and in chat.list', (await rpc('chat.list')).chats.find(r => r.chatId === A.id)?.title === renamed)
  await shot('03-renamed')

  // ---- 3. delete A, a middle branch with children ----------------------------
  await openAndWait(titleP)
  check('⋯ → 删除分支 on A', await laneAction(renamed, '删除分支') === 'ok')
  const text3 = await dialogText()
  record('dialog', text3)
  const floorsA = by0.get(A.id)?.floorCount
  check('the dialog names A, its floor count, and where its children go',
    typeof text3 === 'string' && text3.includes(renamed) && text3.includes(`${String(floorsA)} 层`) && text3.includes(`接到「${titleP}」上`))
  check('… and offers to take the sub-branches too', typeof text3 === 'string' && text3.includes('同时删除它下面的 3 个子分支'))
  await shot('04-delete-dialog')
  check('confirm', await confirmDelete())
  check('A is gone', await waitGone(A.id))
  const t3 = await tree(P)
  const by3 = new Map(t3.chats.map(n => [n.chatId, n]))
  record('chat.tree after deleting A', t3.chats.map(n => `${n.chatId}<-${n.parentChatId ?? '-'}@${String(n.fork?.floor ?? '-')}/${String(n.fork?.shared ?? '-')}`))
  check('C re-attached to P at floor 1', by3.get(C.id)?.parentChatId === P && by3.get(C.id)?.fork?.floor === 1 && by3.get(C.id)?.fork?.source === 'recorded')
  check('B re-attached to P at floor 2', by3.get(B.id)?.parentChatId === P && by3.get(B.id)?.fork?.floor === 2)
  check('D is still B’s', by3.get(D.id)?.parentChatId === B.id)
  check('no orphaned lane', whole(t3) && t3.chats.length === 5)
  check('the reader stayed on P', await title() === titleP)

  // ---- 4. delete the branch being read ----------------------------------
  await openAndWait(B.title)
  check('⋯ → 删除分支 on B, while reading B', await laneAction(B.title, '删除分支') === 'ok')
  const text4 = await dialogText()
  check('the dialog says where the reader goes', typeof text4 === 'string' && text4.includes(`会转到「${titleP}」`), String(text4))
  check('confirm', await confirmDelete())
  check('B is gone', await waitGone(B.id))
  const landed = await waitTitle(titleP)
  check('the reader landed on B’s parent', landed === titleP, String(landed))
  const t4 = await tree(P)
  const by4 = new Map(t4.chats.map(n => [n.chatId, n]))
  check('D re-attached to P at 2', by4.get(D.id)?.parentChatId === P && by4.get(D.id)?.fork?.floor === 2 && whole(t4))

  // ---- 5. delete the root, while reading it ----------------------------
  await delay(900)
  check('⋯ → 删除对话 on the root', await laneAction(titleP, '删除对话') === 'ok')
  const text5 = await dialogText()
  check('the dialog says which child becomes the root', typeof text5 === 'string' && text5.includes(`「${C.title}」会成为新的根`), String(text5))
  check('confirm', await confirmDelete())
  check('P is gone', await waitGone(P))
  const onC = await waitTitle(C.title)
  check('the reader landed on the promoted root', onC === C.title, String(onC))
  const t5 = await tree(C.id)
  const by5 = new Map(t5.chats.map(n => [n.chatId, n]))
  record('chat.tree after deleting the root', t5.chats.map(n => `${n.chatId}<-${n.parentChatId ?? '-'}@${String(n.fork?.floor ?? '-')} floors ${String(n.floorCount)}`))
  check('C is the root, D and E fork from it at 1', t5.rootChatId === C.id && by5.get(D.id)?.fork?.floor === 1
    && by5.get(E.id)?.fork?.floor === 1 && by5.get(E.id)?.parentChatId === C.id && whole(t5) && t5.chats.length === 3)
  await delay(900)
  const m5 = await margin()
  record('lanes after (雪)', m5?.lanes.map(l => `${l.hue}:${String(l.weight)}px`))
  const eLane = m5?.lanes.find(l => l.tip.startsWith(E.title))
  check('E, now owning most of the old root’s floors, is the thickest lane',
    eLane !== undefined && eLane.weight === Math.max(...(m5?.lanes ?? []).map(l => l.weight)) && eLane.weight > 3, String(eLane?.weight))
  if (m5 !== null) await shot('05-snow-weighted', m5.box)
  await shot('06-snow-window')
  await load('dark')
  await openAndWait(C.title)
  const m5d = await margin()
  if (m5d !== null) await shot('07-ink-weighted', m5d.box)
  await shot('08-ink-window')

  // ---- 6. backups kept; nothing generated ----------------------------------
  const backupRoot = join(userDir, 'backups')
  record('backups dir exists', existsSync(backupRoot))
  const generated = pageMethods.filter(m => ['chat.send', 'chat.regenerate', 'chat.continue', 'chat.impersonate', 'script.generate'].includes(m))
  record('page RPC methods', [...new Set(pageMethods)].sort())
  check('nothing was generated', generated.length === 0, generated.join(','))
  const files = (await readdir(join(userDir, 'chats'))).length
  record('chat files in the copy', files)
  void sent
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
