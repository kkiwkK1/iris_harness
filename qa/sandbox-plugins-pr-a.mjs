/**
 * PR-A acceptance for sandbox plugins: the tree in the frame, with no model.
 *
 * Runs `docs/SANDBOX-PLUGINS.md` §15 PR-A items 1–5 against a real host, a real
 * production bundle and a real card-script frame. Hard failures: a
 * `console.error` followed by more output is indistinguishable, in the report,
 * from "this box was fine" (qa/README.md).
 *
 * ## The instrument, and why it is this one
 *
 * The **only** source of plugins in PR-A is a dev panel, which a production
 * build drops — that is the design's own choice (§15 PR-A) and it is right, but
 * it means a bundle served by a host has no way for a person to ask for a mount.
 * So this script drives the frame from the other end: it opens an isolated world
 * in the card-script frame, reads the run token out of the frame's own
 * `<meta name="iris-token">`, and posts the same `plugin:mount` message the
 * shell posts. **The bytes on the wire are identical** — `parseToFrame`
 * validates the token and nothing else about the sender — so what is exercised
 * below the message is the real tree, the real facade, the real checklist, and
 * the real `plugin:failed` journey back to the shell and on to the host's
 * report buffer.
 *
 * What that instrument cannot reach is item 5's positive half; see the note
 * printed at the end.
 *
 * ## Observation windows
 *
 * - **Frame and style counts** are read at a named moment and the moment is
 *   printed with the reading. "No residue after unmount" is meaningless without
 *   "looked when, for how long" — an async `dispose` that leaves something
 *   after the screenshot and one that never leaves anything look identical
 *   afterwards.
 * - **`debug.reports` is a persistent channel**, so the criterion is the delta
 *   from a baseline taken before the step, never presence. A baseline is taken
 *   before every mount.
 *
 * Usage: node qa/sandbox-plugins-pr-a.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'
import { answerConsentExpr, clickTabExpr } from './locators.mjs'

// Host ports go from 8791 up, one per script (qa/README.md). This is the first.
const PORT = Number(process.env.IRIS_PORT ?? 8791)
const BASE = `http://127.0.0.1:${String(PORT)}`
// CDP ports go from 9333 up, one per script, all distinct; 9345 is unused by
// the table in qa/README.md. The pid offset is `cdpPort`'s, not copied here.
const CDP = String(cdpPort(9345))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const outDir = new URL('./results/sandbox-plugins-pr-a/', import.meta.url)
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

/*
 * The port must be free **before** the host starts, and it must never be
 * re-checked afterwards.
 *
 * A collision does not make the requests fail; it makes them succeed against
 * somebody else's host (qa/README.md, the 2026-09-06 incident: eleven chats
 * created in the operator's own profile). `netstat` after the fact cannot tell
 * "my listener" from "theirs", so the only honest evidence that the host came
 * up is that its own output carries no `EADDRINUSE`.
 */
{
  const netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
  const taken = (netstat.stdout ?? '')
    .split('\n')
    .filter(line => line.includes(`:${String(PORT)} `) && line.includes('LISTENING'))
  if (taken.length > 0) {
    console.error(`FAIL  port ${String(PORT)} is already listening — refusing to start:\n${taken.join('\n')}`)
    process.exit(2)
  }
}

/*
 * A **copy** of the product's data dir, with the lock removed.
 *
 * Since #72 one data dir has one host and there is no bypass, so a QA host on
 * the repo's own `apps/iris/data` would either refuse to start or fight the
 * operator's dev host. The copy's `host.lock` belongs to whatever wrote it and
 * means nothing here.
 */
const data = dataCopy('iris-sandbox-plugins-qa-')
const dataDir = data.dir
/*
 * `IRIS_DATA_SOURCE` because `data/` is gitignored, so a fresh worktree has
 * none: the cards live in whichever checkout the operator actually runs. The
 * default is the main checkout, and a missing source is a **named** refusal
 * rather than an empty profile — an empty profile would make every item below
 * skip, which reads in the output exactly like a feature with nothing wrong.
 */
const dataSource = process.env.IRIS_DATA_SOURCE
  ?? join(repoRoot, '..', 'iris_cordis_traven', 'apps', 'iris', 'data')
await cp(dataSource, dataDir, { recursive: true }).catch(error => {
  console.error(`FAIL  no data dir to copy from (${dataSource}): ${String(error)}`)
  console.error('      set IRIS_DATA_SOURCE to a checkout that has apps/iris/data')
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
const hostPid = host.pid
console.log(`host process PID ${String(hostPid)} on port ${String(PORT)}, data dir ${dataDir}`)

let seq = 0
const rpc = async (method, params = {}) => {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-plugins-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 300_000)

let chrome
// The browser's profile. Made here rather than at the spawn below so the
// `finally` can reach it whichever way the run ends.
const profile = chromeProfile('iris-qa-cdp-')
try {
  // Up, or dead with its own reason. Nothing is asked of the port afterwards.
  let up = false
  for (let at = 0; at < 60 && !up; at += 1) {
    await delay(500)
    if (hostOutput.includes('EADDRINUSE')) {
      console.error(`FAIL  the host died on EADDRINUSE — another process holds ${String(PORT)}:\n${hostOutput}`)
      process.exit(2)
    }
    up = await rpc('character.list').then(() => true).catch(() => false)
  }
  if (!up) throw new Error(`the host on ${String(PORT)} never answered\n${hostOutput}`)

  /*
   * The card set, read before anything is written.
   *
   * Printed rather than asserted against a fixed list: the data dir is a copy of
   * whatever the repo ships, so the list is a reading. What it is *for* is the
   * README's rule — if it ever shows cards this script did not expect, the host
   * being talked to is not the one started above, and every write below would
   * land in somebody else's profile.
   */
  const cards = await rpc('character.list')
  record('character.list before any write', cards.characters?.map(c => c.characterId) ?? [])

  // The card with scripts this run drives. Its scripts are what proves the frame
  // survives a plugin's throw: a card whose scripts were never running cannot
  // demonstrate that they kept running.
  const withScripts = []
  const withoutScripts = []
  for (const card of cards.characters ?? []) {
    const scripts = await rpc('script.list', { characterId: card.characterId }).catch(() => ({ scripts: [] }))
    const enabled = (scripts.scripts ?? []).filter(s => s.enabled)
    ;(enabled.length > 0 ? withScripts : withoutScripts).push(card.characterId)
  }
  record('cards with at least one enabled script', withScripts)
  record('cards with no enabled script', withoutScripts)
  if (withScripts.length === 0) throw new Error('no card in this data dir ships an enabled script; items 1-4 need one')

  const characterId = withScripts[0]
  const created = await rpc('chat.create', { characterId })
  const chatId = created.view?.chatId ?? created.chatId
  const chatTitle = created.view?.title ?? created.title
    ?? (await rpc('chat.list')).chats?.find(row => row.chatId === chatId)?.title
  record('chat created for items 1-4', { characterId, chatId, chatTitle })
  if (chatTitle === undefined) throw new Error('the host did not name the chat it created')

  // ---- the browser -------------------------------------------------------
  chrome = profile.adopt(spawn(CHROME, [
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile.dir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    '--window-size=1480,1000', 'about:blank',
  ], { stdio: 'ignore' }))

  let version
  for (let at = 0; at < 40 && version === undefined; at += 1) {
    await delay(500)
    try {
      version = await fetch(`http://127.0.0.1:${CDP}/json/version`).then(r => r.json())
    } catch { /* chrome not up yet */ }
  }
  if (version === undefined) throw new Error('chrome never came up')

  /*
   * The **browser** endpoint, not a page's, and per-target sessions.
   *
   * A card frame is `sandbox="allow-scripts"`, so its origin is opaque and
   * Chrome splits it out as its own debuggee target: it is **not** a child in
   * the page's frame tree and its execution contexts never appear on the page's
   * session (`qa/measure-z2-scroll.mjs` records the same finding). Reading
   * `Page.getFrameTree().childFrames` answered **zero** here on a page with two
   * live iframes — a number that reads as "no frame was built" when the truth
   * was "I was looking at the wrong tree".
   */
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let wsSeq = 0
  const pending = new Map()
  /** sessionId → what the frame on it said about itself. */
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
    if (r.result?.exceptionDetails !== undefined) {
      throw new Error(`evaluate: ${JSON.stringify(r.result.exceptionDetails)}`)
    }
    return r.result?.result?.value
  }
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(new URL(`${name}.png`, outDir), Buffer.from(r.result.data, 'base64'))
  }

  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  await send('Page.enable')
  await send('Runtime.enable')

  const nav = async url => {
    await send('Page.navigate', { url })
    for (let at = 0; at < 40; at += 1) {
      await delay(500)
      if (await evaluate('document.readyState') === 'complete') break
    }
    await delay(2000)
  }

  /**
   * The card-script frame's session.
   *
   * A message frame and a card-script frame are both `about:srcdoc` on an opaque
   * origin, and the only thing that tells them apart from inside is the body:
   * `srcdoc.ts` stamps `data-iris-interface` on a message frame's and on nothing
   * else. Probed rather than assumed from the attach order, which is a fact
   * about boot timing rather than about which frame is which.
   * @returns the session id, or undefined when there is no such frame.
   */
  const scriptFrameSession = async () => {
    for (const sessionId of [...frameSessions.keys()]) {
      const isInterface = await evaluate(
        'document.body ? document.body.hasAttribute("data-iris-interface") : true',
        sessionId,
      ).catch(() => undefined)
      if (isInterface === false) return sessionId
    }
    return undefined
  }
  const frameCount = () => frameSessions.size

  /** Reports the host holds now, so a step can be judged by its delta. */
  const reportBaseline = async () => {
    const answer = await rpc('debug.reports', { limit: 2000 })
    return new Set((answer.reports ?? []).map(row => row.seq))
  }
  /**
   * Sandbox-plugin rows that arrived since a baseline.
   * @param before - the seqs held before the step.
   * @param waitMs - how long to keep looking; printed with the reading.
   * @returns the new rows.
   */
  const newPluginReports = async (before, waitMs) => {
    const until = Date.now() + waitMs
    let rows = []
    do {
      await delay(400)
      const answer = await rpc('debug.reports', { limit: 2000 })
      rows = (answer.reports ?? []).filter(row => !before.has(row.seq) && row.kind === 'sandbox-plugin')
    } while (rows.length === 0 && Date.now() < until)
    return rows
  }

  /**
   * Open a chat through the product's own UI.
   *
   * The chats tab is found by `data-tab` (chrome, translated, never located by
   * text); the row is found by its **title**, which is user data and the only
   * honest handle there is — both rules are `qa/locators.mjs`'s. The consent
   * gate is answered by position, because its two buttons are chrome too.
   * @param title - the chat's title, as the host minted it.
   * @returns what the click found, for the record.
   */
  const openChat = async title => {
    const tabbed = await evaluate(clickTabExpr('chats'))
    await delay(600)
    const opened = await evaluate(`(() => {
      const wanted = ${JSON.stringify(title)}
      const rows = [...document.querySelectorAll('.iris-list .iris-row')]
        .filter(el => (el.querySelector('.iris-row__title')?.textContent ?? '').trim() === wanted)
      if (rows.length === 0) {
        return {
          error: 'no chat row titled ' + wanted,
          titles: [...document.querySelectorAll('.iris-list .iris-row .iris-row__title')]
            .map(t => (t.textContent ?? '').trim()).slice(0, 20),
        }
      }
      rows[0].click()
      return { clicked: rows.length }
    })()`)
    await delay(1200)
    const consent = await evaluate(answerConsentExpr)
    return { tabbed, opened, consent }
  }

  await nav(`${BASE}/`)
  record('opening the chat for items 1-4', await openChat(chatTitle))
  // Cards take seconds to boot: the wait is long and it is stated, so a zero
  // below is "not within 8s" rather than an unlabelled zero.
  await delay(8000)
  record('card frames attached 8s after opening the chat', frameCount())
  /*
   * Enough of the page to tell the three ways "no frame" can happen apart: the
   * chat never opened, the chat opened and the scripts were refused, or the
   * scripts ran and built nothing. Without this a zero above is one number with
   * three readings.
   */
  record('page state 8s after opening the chat', await evaluate(`({
    messages: document.querySelectorAll('.iris-msg').length,
    overlay: document.querySelectorAll('.iris-overlay, [data-iris-overlay]').length,
    iframes: document.querySelectorAll('iframe').length,
    grant: document.querySelectorAll('.iris-grant__actions button').length,
    notice: (document.querySelector('.iris-notice')?.textContent ?? '').slice(0, 200),
  })`))
  await shot('0-chat-open')

  let world = await scriptFrameSession()
  if (world === undefined) {
    // One retry with a longer window: a card frame takes seconds to boot, and
    // "not yet" and "never" are different answers.
    await delay(6000)
    world = await scriptFrameSession()
  }
  check('a card-script frame exists to mount into', world !== undefined,
    `looked twice, ~3s and ~9s after the chat opened`)
  if (world === undefined) throw new Error('no card-script frame; items 1-4 cannot run')

  const token = await evaluate(
    'document.querySelector(\'meta[name="iris-token"]\')?.getAttribute("content") ?? ""', world,
  )
  if (token === '') throw new Error('the frame carries no run token')

  /**
   * Post a `plugin:mount` into the frame, byte-identical to the shell's.
   * @param pluginId - the plugin's id.
   * @param version - its version.
   * @param code - the body.
   */
  const post = async message =>
    evaluate(`window.postMessage(${JSON.stringify(message)}, "*")`, world)
  const mount = async (pluginId, version, code) =>
    post({ iris: token, type: 'plugin:mount', pluginId, version, code })
  const unmount = async pluginId =>
    post({ iris: token, type: 'plugin:unmount', pluginId })

  const styleTags = async () =>
    evaluate('document.querySelectorAll("[data-iris-plugin-style]").length', world)
  const panelCells = async () =>
    evaluate('document.querySelectorAll("[data-iris-plugin-panel]").length', world)
  const bodyBackground = async () =>
    evaluate('getComputedStyle(document.body).backgroundColor', world)
  const scriptsAlive = async () =>
    evaluate('document.querySelectorAll("#tavern_helper div[data-script-id]").length', world)

  // ---- item 1: a plugin that changes something visible --------------------
  record('style tags before item 1', await styleTags())
  const beforeDark = await bodyBackground()
  record('body background before item 1', beforeDark)
  await mount('1-dark', 1, `return {
    apply() {
      iris.styles.insert('body { background: rgb(16, 20, 24) !important; }')
      const box = document.createElement('div')
      box.textContent = 'plugin panel: ' + iris.id
      iris.panel.mount(box)
    },
  }`)
  await delay(1500)
  const afterStyles = await styleTags()
  const afterCells = await panelCells()
  const afterDark = await bodyBackground()
  record('style tags 1.5s after item 1 mount', afterStyles)
  record('panel cells 1.5s after item 1 mount', afterCells)
  record('body background 1.5s after item 1 mount', afterDark)
  await shot('1-mounted')
  check('item 1 — a mounted plugin injects its style tag', afterStyles === 1)
  check('item 1 — a mounted plugin gets its panel cell', afterCells === 1)
  check('item 1 — the frame body actually changed', afterDark !== beforeDark,
    `${String(beforeDark)} → ${String(afterDark)}`)

  // ---- item 2: unmount leaves nothing -------------------------------------
  await unmount('1-dark')
  await delay(1500)
  const residueAt1500 = await styleTags()
  const cellsAt1500 = await panelCells()
  const restored = await bodyBackground()
  await delay(2500)
  const residueAt4000 = await styleTags()
  record('style tags 1.5s after unmount', residueAt1500)
  record('style tags 4.0s after unmount', residueAt4000)
  record('panel cells 1.5s after unmount', cellsAt1500)
  record('body background after unmount', restored)
  await shot('2-unmounted')
  /*
   * Read **twice**, 1.5s and 4.0s out. One reading cannot tell "nothing was
   * left" from "something is left but had not been written yet when I looked";
   * a second reading after the `dispose` deadline (1s) has certainly passed
   * closes that window rather than assuming it.
   */
  check('item 2 — no plugin style tag survives the unmount',
    residueAt1500 === 0 && residueAt4000 === 0, 'read at 1.5s and 4.0s')
  check('item 2 — no panel cell survives the unmount', cellsAt1500 === 0)
  check('item 2 — the frame body is back to what it was', restored === beforeDark,
    `${String(beforeDark)} → ${String(restored)}`)

  // ---- item 3: apply throws ----------------------------------------------
  const aliveBefore = await scriptsAlive()
  const base3 = await reportBaseline()
  await mount('2-throws', 1, 'return { apply() { throw new Error("qa: deliberate throw") } }')
  const rows3 = await newPluginReports(base3, 12_000)
  record('sandbox-plugin report rows after item 3', rows3.map(r => `${r.grade}:${r.message}`))
  record('card script divs still in the frame after item 3', await scriptsAlive())
  await shot('3-mount-failed')
  check('item 3 — the shell records mount-failed',
    rows3.some(row => row.message.includes('mount-failed') && row.message.includes('qa: deliberate throw')),
    'read from debug.reports as a delta, not from the console')
  check('item 3 — graded a fault', rows3.some(row => row.grade === 'fault'))
  check('item 3 — the frame is still alive and its card scripts are still listed',
    (await scriptsAlive()) >= aliveBefore && (await styleTags()) === 0)

  // ---- item 4: while(true) — the honesty check ----------------------------
  /*
   * **This one is not made to pass.** A synchronous infinite loop cannot be
   * interrupted: the deadline is a promise race and a race does not preempt
   * synchronous code, and the browser will not either. What is asserted is what
   * the design actually claims — that the *shell* stops waiting and records
   * `mount-timeout` — and what is *recorded* is the fact that the frame is dead
   * for the duration, measured rather than asserted away.
   */
  const base4 = await reportBaseline()
  const loopStarted = Date.now()
  await mount('3-spins', 1, 'return { apply() { const until = Date.now() + 6000; while (Date.now() < until) {} } }')
  // Measured from outside the frame: the frame cannot answer while it spins, so
  // the first answer it manages is the end of the freeze.
  let frozenForMs = 0
  for (let at = 0; at < 40; at += 1) {
    await delay(500)
    const answered = await evaluate('1 + 1', world).catch(() => undefined)
    if (answered === 2) { frozenForMs = Date.now() - loopStarted; break }
  }
  record('the frame answered again after (ms)', frozenForMs)
  const rows4 = await newPluginReports(base4, 20_000)
  record('sandbox-plugin report rows after item 4', rows4.map(r => `${r.grade}:${r.message}`))
  await shot('4-mount-timeout')
  check('item 4 — mount-timeout still reaches the shell',
    rows4.some(row => row.message.includes('mount-timeout')),
    `the frame was unresponsive for about ${String(frozenForMs)}ms while the loop ran; the deadline did not shorten that`)
  console.log(
    '  NOTE  item 4 is an honesty check, not a pass/fail of the design: a synchronous loop '
    + 'freezes the frame and nothing in this design can stop it. The observation window above is the measurement.',
  )

  // ---- item 5: a card with no scripts -------------------------------------
  /*
   * Two halves, and only one of them can run against a production bundle.
   *
   * The **negative** half is the compatibility floor and is measured here: a
   * card with no enabled script builds no card-script frame, exactly as before
   * this feature. The **positive** half — the same card building a frame because
   * a plugin wants one — cannot be driven from a production bundle at all,
   * because PR-A's only source of plugins is a dev-gated panel (§15 PR-A). It is
   * covered by `card-scripts.test.ts`, and that is said here rather than left as
   * a silently skipped box.
   */
  if (withoutScripts.length === 0) {
    console.log('  SKIP  item 5 — this data dir has no card without an enabled script')
  } else {
    const bare = await rpc('chat.create', { characterId: withoutScripts[0] })
    const bareChat = bare.view?.chatId ?? bare.chatId
    const bareTitle = bare.view?.title ?? bare.title
      ?? (await rpc('chat.list')).chats?.find(row => row.chatId === bareChat)?.title
    await nav(`${BASE}/`)
    record('opening the chat for item 5', await openChat(bareTitle))
    await delay(8000)
    const bareWorld = await scriptFrameSession()
    record('card-script frames for a card with no scripts and no plugins', bareWorld === undefined ? 0 : 1)
    await shot('5-no-scripts-no-plugins')
    check('item 5 (negative half) — no scripts and no plugins still builds no card-script frame',
      bareWorld === undefined, 'the compatibility floor, measured 4s after the chat opened')
    console.log(
      '  NOTE  item 5 positive half (no scripts + one plugin → a frame IS built) cannot run against a '
      + "production bundle: PR-A's only plugin source is the dev-gated bench. It is covered by "
      + "card-scripts.test.ts, 'a card with no runnable scripts still gets a frame when a plugin wants one'.",
    )
  }

  await writeFile(new URL('readings.json', outDir), JSON.stringify(readings, null, 2), 'utf8')
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${String(failures)} CHECK(S) FAILED`}`)
} catch (error) {
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  failures += 1
} finally {
  clearTimeout(HARD)
  // Only what this script started, and only by the pid it holds.
  if (chrome?.pid !== undefined && chrome.exitCode === null) chrome.kill()
  if (hostPid !== undefined && host.exitCode === null) {
    host.kill()
    await new Promise(resolve => { host.once('exit', resolve) })
  }
  await profile.dispose()
  await data.dispose()
}

process.exit(failures === 0 ? 0 : 1)
