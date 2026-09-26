/**
 * Acceptance for branch-segment summaries on the tree map (owner request
 * 2026-09-26): every run of floors between fork points gets a model-written
 * summary, shown when the cursor hovers it.
 *
 * On a host with a **copy** of the product's data dir, on its own port, with a
 * real headless Chrome and a **local mock provider** — nothing is spent:
 *
 * - the copy's `connections.json` / `connections.key` are deleted before boot,
 *   so the host's first start imports the launch environment, which points at
 *   the mock on 127.0.0.1; every request the host makes is counted there and
 *   compared with what this script caused.
 * - the mock answers a segment-summary request with a sentence built from the
 *   floors it was sent (their count, first and last words), so a card that
 *   shows the wrong segment's summary is visible as such.
 *
 * Steps, on 黑兽 (the copy already holds 黑兽 and 黑兽 - Branch #1, cut from
 * floor 30):
 *
 * 1. Build a branch in the interface: 「分支」 on floor 20 of 黑兽, then two
 *    floors of its own (one line sent, answered by the mock).
 * 2. Hover the folded prefix row (a real mouse move): the card says "not yet"
 *    and nothing was requested by the hover. 「总结这一段」 → one request, and
 *    the card shows the summary.
 * 3. 「总结所有分支段」: the confirm names how many; confirmed, one request per
 *    remaining segment, one at a time; afterwards the button is disabled.
 * 4. Hover a lane segment (the new branch's own run) and the root's folded
 *    middle: each shows its own summary. The shared prefix is one record, read
 *    the same from every member of the family.
 * 5. Edit a floor of the new branch: its card reads stale with 「重新总结」;
 *    re-summarized, it is fresh again.
 * 6. The usage page's share: one `segmentSummary` record per request; the
 *    requests' bodies carried only their segment's floors.
 *
 * Exit 1 = a check failed, 2 = port or data-dir trouble, 3 = hard timeout.
 * Kills only its own host and Chrome; removes the data copy and the Chrome
 * profile on every exit (`qa/chrome-profile.mjs`).
 *
 * Usage: node qa/segment-summary-acceptance.mjs   (IRIS_PORT defaults to 8806)
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { cp, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP = String(cdpPort(9371))
const PORT = Number(process.env.IRIS_PORT ?? 8806)
const BASE = `http://127.0.0.1:${String(PORT)}`
const ROOT_TITLE = process.env.IRIS_SEGMENT_ROOT ?? '黑兽'

const outDir = new URL('./results/segment-summary/', import.meta.url)
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
const listening = new Set((spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? '').split('\n')
  .filter(line => line.includes('LISTENING'))
  .map(line => /:(\d+)\s/.exec(line)?.[1])
  .filter(port => port !== undefined)
  .map(Number))
if (listening.has(PORT) || PORT === 8787) {
  console.error(`FAIL  port ${String(PORT)} is taken (or is the owner's 8787) — refusing to start`)
  process.exit(2)
}

// ---- the data copy ---------------------------------------------------------
const data = dataCopy('iris-segment-summary-qa-')
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

// ---- the mock provider -----------------------------------------------------
/** Every body the mock served, in order, with whether it was a segment summary. */
const served = []
const textOf = message => typeof message.content === 'string' ? message.content
  : Array.isArray(message.content) ? message.content.map(part => part.text ?? '').join('') : ''
const isSummary = body => textOf(body.messages?.at(-1) ?? {}).includes('summarizer for one stretch')
const mock = createServer((request, response) => {
  if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
    response.writeHead(404).end()
    return
  }
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const summary = isSummary(body)
    served.push({ summary, body })
    let text
    if (summary) {
      const floors = body.messages.slice(0, -1).map(textOf).filter(line => !line.startsWith('(Note:'))
      const cut = line => line.replace(/\s+/gu, ' ').slice(0, 14)
      text = `（模拟总结）这一段共 ${String(floors.length)} 条消息，从「${cut(floors[0] ?? '')}」开始，到「${cut(floors.at(-1) ?? '')}」为止。`
    } else {
      text = '*黑兽抬起头。* 雪还在下。'
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
    const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
    response.write(frame({ choices: [{ delta: { content: text } }] }))
    response.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    response.write(frame({ choices: [], usage: { prompt_tokens: summary ? 900 : 300, completion_tokens: summary ? 60 : 20, total_tokens: summary ? 960 : 320 } }))
    response.write('data: [DONE]\n\n')
    response.end()
  })
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const mockURL = `http://127.0.0.1:${String(mock.address().port)}`

const env = { ...process.env }
delete env.IRIS_API_KEY_ENV
let hostOutput = ''
const host = data.adopt(spawn(process.execPath, ['apps/iris/bin.ts'], {
  cwd: repoRoot,
  env: {
    ...env,
    IRIS_PORT: String(PORT),
    IRIS_DATA_DIR: dataDir,
    IRIS_BASE_URL: mockURL,
    IRIS_MODEL: 'mock-model',
    IRIS_WEB_DIST: join(repoRoot, 'apps', 'iris-web', 'dist', 'index.html'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
}))
host.stdout.on('data', chunk => { hostOutput += String(chunk) })
host.stderr.on('data', chunk => { hostOutput += String(chunk) })
console.log(`host PID ${String(host.pid)} on ${String(PORT)}, data copy ${dataDir}, mock ${mockURL}`)

let seq = 0
const rpc = async (method, params = {}) => {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-seg-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}
const settle = async chatId => {
  for (let at = 0; at < 100; at += 1) {
    const state = await rpc('chat.resync', { chatId, reason: 'silence' }).catch(() => undefined)
    if (state === undefined || state.generating === undefined) return
    await delay(100)
  }
}
const summaryRequests = () => served.filter(one => one.summary).length

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 480_000)
const profile = chromeProfile('iris-segment-summary-cdp-')

try {
  let up = false
  for (let at = 0; at < 80 && !up; at += 1) {
    await delay(500)
    if (hostOutput.includes('EADDRINUSE')) {
      console.error(`FAIL  EADDRINUSE on ${String(PORT)}:\n${hostOutput}`)
      process.exit(2)
    }
    up = await rpc('chat.list').then(() => true).catch(() => false)
  }
  if (!up) throw new Error(`the host on ${String(PORT)} never answered\n${hostOutput}`)

  const connections = await rpc('connection.list')
  record('providers in the copy (must be the mock only)', (connections.profiles ?? []).map(p => ({ id: p.id, baseURL: p.baseURL })))
  check('every provider in the copy is the local mock',
    (connections.profiles ?? []).every(p => p.baseURL === undefined || p.baseURL.startsWith('http://127.0.0.1')))

  const rows = (await rpc('chat.list')).chats
  const root = rows.find(row => row.title === ROOT_TITLE && row.parentChatId === undefined)
  if (root === undefined) throw new Error(`no root conversation titled ${ROOT_TITLE} in the copy`)
  const before = await rpc('chat.tree', { chatId: root.chatId })
  record('黑兽 family before', before.tree.chats.map(n => `${n.title} floors ${String(n.floorCount)} fork ${JSON.stringify(n.fork ?? null)}`))

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
  const openAndWait = async wanted => {
    await openInSidebar(wanted)
    const now = await waitTitle(wanted)
    await delay(1200)
    return now
  }
  const clickIn = async (floor, control) => evaluate(`(async () => {
    for (let at = 0; at < 30; at += 1) {
      const button = document.querySelector('article[data-floor="${String(floor)}"] [data-control="${control}"]')
      if (button && !button.disabled) { button.click(); return true }
      await new Promise(r => setTimeout(r, 200))
    }
    return false
  })()`)
  const aside = async () => evaluate(`(() => {
    const a = document.querySelector('.iris-aside')
    if (!a) return null
    const r = a.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })()`)
  /** A real pointer move to the middle of the element the selector finds in the margin (scrolled into view). */
  const hoverAt = async (selector, textIncludes) => {
    const point = await evaluate(`(() => {
      const all = [...document.querySelectorAll('.iris-aside ' + ${JSON.stringify(selector)})]
      const el = all.find(one => ${JSON.stringify(textIncludes ?? '')} === '' || (one.textContent ?? '').includes(${JSON.stringify(textIncludes ?? '')}))
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.left + Math.max(1, r.width / 2), y: r.top + r.height / 2 }
    })()`)
    if (point === null) return false
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 })
    await delay(300)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await delay(400)
    return true
  }
  const cardText = () => evaluate('document.querySelector(".iris-aside .iris-seg-card")?.textContent ?? null')
  const waitCard = async includes => {
    for (let at = 0; at < 80; at += 1) {
      const now = await cardText()
      if (now !== null && now.includes(includes)) return now
      await delay(250)
    }
    return await cardText()
  }

  await load('light')

  // ---- 1. build a branch in the interface -------------------------------
  const onRoot = await openAndWait(ROOT_TITLE)
  check('黑兽 opens from the sidebar', onRoot === ROOT_TITLE, String(onRoot))
  check('「分支」 on floor 20 of 黑兽', await clickIn(20, 'branch-here'))
  const branchTitle = await waitTitle(undefined, ROOT_TITLE)
  const branch = (await rpc('chat.list')).chats.find(row => row.title === branchTitle)
  check('… opened the new branch', branch !== undefined && branchTitle !== ROOT_TITLE, String(branchTitle))
  const B = branch.chatId
  await rpc('chat.send', { chatId: B, text: '我们换一条路走，去北边的山谷。' })
  await settle(B)
  await delay(1500)
  const { tree } = await rpc('chat.tree', { chatId: B })
  record('family after the branch', tree.chats.map(n => `${n.title} floors ${String(n.floorCount)} fork ${JSON.stringify(n.fork ?? null)}`))
  const b1 = tree.chats.find(n => n.chatId !== root.chatId && n.chatId !== B)
  check('the family is 黑兽, its Branch #1 from 30, and the new branch from 20 with two floors of its own',
    tree.chats.length === 3 && tree.chats.find(n => n.chatId === B)?.fork?.floor === 20 && tree.chats.find(n => n.chatId === B)?.floorCount === 23)
  const turnsSent = served.length
  record('requests the mock served for the turn', turnsSent)

  // ---- 2. hover the folded prefix; summarize it from its card --------------
  const readsBefore = summaryRequests()
  check('hover the folded prefix row (⋯ 19 层)', await hoverAt('.iris-tree__label--gap', '19'))
  const empty = await waitCard('第 0–20 层')
  record('card before', empty)
  check('the card names the segment and says it is not summarized yet', (empty ?? '').includes('还没有总结') && (empty ?? '').includes('总结这一段'))
  check('hovering asked for nothing', summaryRequests() === readsBefore)
  const box = await aside()
  if (box !== null) await shot('01-hover-not-yet', box)
  await evaluate('document.querySelector(".iris-aside .iris-seg-card [data-control=\\"segment-summarize\\"]").click()')
  const after = await waitCard('模拟总结')
  record('card after', after)
  check('「总结这一段」 made one request and the card shows its summary',
    summaryRequests() === readsBefore + 1 && (after ?? '').includes('这一段共 21 条消息'), `requests ${String(summaryRequests() - readsBefore)}`)
  check('… with the time and the model', (after ?? '').includes('mock-model') && (after ?? '').includes('生成于'))
  if (box !== null) await shot('02-hover-summarized', box)

  // ---- 3. summarize all ---------------------------------------------------
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 })
  await delay(400)
  await evaluate('document.querySelector(".iris-aside [data-control=\\"segment-summarize-all\\"]").click()')
  await delay(500)
  const confirm = await evaluate('document.querySelector(".iris-seg-confirm")?.textContent ?? null')
  record('confirm', confirm)
  const expected = 4 // root 21–30, root 31–32, Branch #1 31–32, the new branch 21–22
  check('the confirm names how many segments will be summarized', (confirm ?? '').includes(`将总结 ${String(expected)} 段`), String(confirm))
  check('… and nothing was sent before confirming', summaryRequests() === readsBefore + 1)
  await shot('03-summarize-all-confirm')
  await evaluate('document.querySelector("[data-control=\\"segment-summarize-all-confirm\\"]").click()')
  let running = false
  for (let at = 0; at < 20 && !running; at += 1) {
    running = await evaluate('document.querySelector(".iris-aside [data-control=\\"segment-summarize-stop\\"]") !== null')
    if (!running) await delay(50)
  }
  record('the stop control appeared during the run', running)
  for (let at = 0; at < 120; at += 1) {
    const done = await evaluate('document.querySelector(".iris-aside [data-control=\\"segment-summarize-all\\"]")?.disabled === true')
    if (done) break
    await delay(250)
  }
  check('one request per remaining segment', summaryRequests() === readsBefore + 1 + expected, `total ${String(summaryRequests() - readsBefore)}`)
  check('afterwards 「总结所有分支段」 is disabled: every segment is current',
    await evaluate('document.querySelector(".iris-aside [data-control=\\"segment-summarize-all\\"]")?.disabled === true'))

  // ---- 4. hover lane segments; the family shares one prefix record ---------
  check('hover the new branch’s own run (floors 21–22)', await hoverAt(`path[data-segment="${B}:21-22"]`))
  const own = await waitCard('第 21–22 层')
  record('branch card', own)
  check('its card shows its own summary (two messages)', (own ?? '').includes('这一段共 2 条消息'))
  if (box !== null) await shot('04-hover-lane-segment', box)
  check('hover the root’s folded middle (⋯ 7 层)', await hoverAt('.iris-tree__label--gap', '7'))
  const middle = await waitCard('第 21–30 层')
  record('middle card', middle)
  check('the root’s 21–30 shows its own summary (ten messages)', (middle ?? '').includes('这一段共 10 条消息'))
  const fromRoot = (await rpc('chat.segmentSummaries', { chatId: root.chatId })).summaries
  const fromB1 = (await rpc('chat.segmentSummaries', { chatId: b1.chatId })).summaries
  record('summaries from the root', fromRoot.map(s => `${s.chatId === root.chatId ? 'root' : s.chatId === B ? 'new' : 'b1'} ${String(s.from)}–${String(s.to)} stale=${String(s.stale)}`))
  check('five segments, all current, and every member reads the same list', fromRoot.length === 5 && fromRoot.every(s => !s.stale)
    && JSON.stringify(fromRoot) === JSON.stringify(fromB1))
  check('the shared prefix 0–20 is one record, on the root', fromRoot.filter(s => s.from === 0).length === 1 && fromRoot.find(s => s.from === 0)?.chatId === root.chatId)

  // Keyboard: focus opens the same card.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 })
  await delay(400)
  await evaluate('[...document.querySelectorAll(".iris-aside .iris-tree__label--gap")].find(el => el.textContent.includes("19"))?.focus()')
  const keyed = await waitCard('第 0–20 层')
  check('focusing the folded row opens its card too', (keyed ?? '').includes('模拟总结'))
  await evaluate('document.activeElement?.blur()')
  await delay(400)

  // ---- 5. edit a floor → stale → re-summarize -----------------------------
  await rpc('chat.editMessage', { chatId: B, id: 22, text: '*黑兽停下脚步。* 山谷里没有雪。（验收改写）' })
  await delay(1500)
  check('hover the new branch’s run again', await hoverAt(`path[data-segment="${B}:21-22"]`))
  const stale = await waitCard('改动过')
  record('stale card', stale)
  check('the edited segment reads stale and offers 「重新总结」', (stale ?? '').includes('这段内容在总结之后改动过') && (stale ?? '').includes('重新总结'))
  if (box !== null) await shot('05-stale', box)
  const beforeRe = summaryRequests()
  await evaluate('document.querySelector(".iris-aside .iris-seg-card [data-control=\\"segment-summarize\\"]").click()')
  for (let at = 0; at < 60; at += 1) {
    const now = await cardText()
    if (now !== null && !now.includes('改动过') && now.includes('黑兽停下脚步')) break
    await delay(250)
  }
  const fresh = await cardText()
  record('re-summarized card', fresh)
  check('re-summarized: fresh again, from the edited text', summaryRequests() === beforeRe + 1 && !(fresh ?? '').includes('改动过') && (fresh ?? '').includes('黑兽停下脚步'))
  if (box !== null) await shot('06-resummarized', box)

  // ---- 6. dark theme, usage, and what was sent ------------------------------
  await load('dark')
  await openAndWait(branchTitle)
  await hoverAt('.iris-tree__label--gap', '19')
  await waitCard('模拟总结')
  const darkBox = await aside()
  if (darkBox !== null) await shot('07-ink-card', darkBox)
  await shot('08-ink-window')

  const usage = (await rpc('usage.summary', {})).summary
  record('usage share', usage.totals.segmentSummary)
  check('the usage summary carries one segment-summary record per request', usage.totals.segmentSummary?.turns === summaryRequests(),
    `${String(usage.totals.segmentSummary?.turns)} vs ${String(summaryRequests())}`)
  // The new branch's 21–22: the lead-in, its two floors, the directive — no
  // system prompt, and nothing of floors 0–20.
  const branchBody = served.filter(one => one.summary).map(one => one.body)
    .find(body => textOf(body.messages[0]).includes('begins at message 21') && body.messages.some(m => textOf(m).includes('我们换一条路走')))
  record('the new branch’s summary request', branchBody?.messages.map(m => `${String(m.role)}: ${textOf(m).slice(0, 40)}`))
  check('a later segment went out with its lead-in and only its own floors',
    branchBody !== undefined && branchBody.messages.length === 4 && branchBody.messages.every(m => m.role !== 'system')
    && textOf(branchBody.messages[0]).includes('Before it:'))
  const hovers = pageMethods.filter(method => method === 'chat.summarizeSegment').length
  record('page RPC methods', [...new Set(pageMethods)].sort())
  check('the page asked for exactly the summaries the buttons asked for', hovers === summaryRequests(), `${String(hovers)} vs ${String(summaryRequests())}`)
  check('every request the host made reached the local mock', served.length === turnsSent + summaryRequests())
} catch (error) {
  failures += 1
  console.error(`FAIL  ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  clearTimeout(HARD)
  mock.close()
  await profile.dispose().catch(() => undefined)
  await data.dispose().catch(() => undefined)
}
console.log(failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`)
process.exit(failures === 0 ? 0 : 1)
