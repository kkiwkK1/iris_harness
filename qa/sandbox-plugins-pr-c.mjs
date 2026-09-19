/**
 * PR-C acceptance for sandbox plugins: a plugin's stylesheet crossing into this
 * card's **message** frames.
 *
 * Runs `docs/SANDBOX-PLUGINS.md` §15 PR-C against a real host, a real production
 * bundle, a real card-script frame and real message-interface frames. Hard
 * failures: a `console.error` followed by more output is indistinguishable, in
 * the report, from "this box was fine" (`qa/README.md`).
 *
 * ## The instrument, and why it is this one
 *
 * **No model, nothing spent.** PR-B's acceptance drives `sandboxPlugin.define`
 * and pays for a completion each time; it left no test seam that produces a
 * plugin without one. PR-A's instrument does, and it is the one used here: open
 * an isolated world in the card-script frame, read the run token out of the
 * frame's own `<meta name="iris-token">`, and post the same `plugin:mount` the
 * shell posts. **The bytes on the wire are identical** — `parseToFrame`
 * validates the token and nothing else about the sender — so what runs below the
 * message is the real tree, the real facade, the real `plugin:style` journey to
 * the shell, the real fan-out store, and the real rebuild of the message frames.
 * What it skips is the sidecar and the confirmation card, which are PR-B's and
 * are not what this PR changes.
 *
 * ## What the cascade measurement is for
 *
 * A plugin's sheet is folded into a message frame's **head**, riding the road
 * `withMessageCss` already walks. A card's own `<style>` sits in its markup and
 * is therefore later in the document, and its rules are usually class rules —
 * so a plain plugin rule can lose twice over, once on document order at equal
 * specificity and once on specificity itself. Item 1 mounts the rule plainly and
 * item 2 mounts it with `!important`, and both readings are kept. A script that
 * only ever ran the `!important` version would report "the fan-out works" and
 * leave the reader of a plain rule with no explanation at all.
 *
 * Measured on 爱衣, 2026-09-19: the plain rule **did** reach the frame and did
 * repaint `body` (transparent -> rgb(16,20,24)), and lost on the card's own
 * panels — `body > *` is specificity 0-0-1 against the card's `.card`, which is
 * 0-1-0. With `!important` every panel went dark. So the honest sentence is
 * "the sheet arrives and then competes normally", not "a plugin cannot win".
 *
 * ## Observation windows
 *
 * - Adding or dropping a sheet **rebuilds** the message frames, and the rebuild
 *   parks the old set on screen until the replacement boots. So every count is
 *   taken twice, at a named moment, and both are printed: one reading cannot
 *   tell "the fold did not happen" from "the replacement has not booted yet".
 * - The srcdoc byte totals stand in for the frame budget panel, because
 *   `FramePlan.spent` has **no reader in the UI** — see the note printed with
 *   them. What is read instead is the quantity the budget rations: the bytes
 *   actually inlined into the message frames.
 *
 * Usage: node qa/sandbox-plugins-pr-c.mjs
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

// Host ports go from 8791 up, one per script (qa/README.md): PR-A took 8791 and
// PR-B took 8793, so this is 8794 — 8792 belongs to `rpc.mjs`.
const PORT = Number(process.env.IRIS_PORT ?? 8794)
const BASE = `http://127.0.0.1:${String(PORT)}`
// CDP from 9333 up, all distinct; PR-A took 9345 and PR-B 9346. The pid offset
// is `cdpPort`'s and is not copied here.
const CDP = String(cdpPort(9347))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * The card this runs on.
 *
 * 爱衣 by default: `notes/CARD-REGRESSION-2026-09-17.md` §2 records its greeting
 * as a live status bar in a message-interface frame, which is exactly the shape
 * PR-C exists to reach. Overridable, because a data dir is whatever the operator
 * has — and a **named** refusal when it is absent, rather than a quiet skip that
 * reads in the output like a feature with nothing wrong.
 */
const CARD = process.env.IRIS_CARD ?? '爱衣'

const outDir = new URL('./results/sandbox-plugins-pr-c/', import.meta.url)
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
 * "my listener" from "theirs", so the only honest evidence that the host came up
 * is that its own output carries no `EADDRINUSE`.
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
 * A **copy** of the product's data dir, with the lock removed. Since #72 one
 * data dir has one host and there is no bypass, so a QA host on the repo's own
 * `apps/iris/data` would either refuse to start or fight the operator's dev
 * host.
 */
const data = dataCopy('iris-sandbox-pr-c-qa-')
const dataDir = data.dir
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
    body: JSON.stringify({ id: `qa-pr-c-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 420_000)

let chrome
const profile = chromeProfile('iris-qa-cdp-')
try {
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
   * The card set, read before anything is written. Printed rather than asserted
   * against a fixed list — the data dir is a copy of whatever the operator has.
   * What it is *for* is the README's rule: cards this script did not expect mean
   * the host being talked to is not the one started above, and every write below
   * would land in somebody else's profile.
   */
  const cards = await rpc('character.list')
  const ids = (cards.characters ?? []).map(one => one.characterId)
  record('character.list before any write', ids)

  const characterId = ids.find(id => id === CARD) ?? ids.find(id => id.includes(CARD))
  if (characterId === undefined) {
    console.error(`FAIL  no card named ${CARD} in this data dir; set IRIS_CARD to one whose`)
    console.error('      greeting renders a card interface in a message frame')
    process.exit(2)
  }
  record('the card this run drives', characterId)

  const created = await rpc('chat.create', { characterId })
  const chatId = created.view?.chatId ?? created.chatId
  const chatTitle = created.view?.title ?? created.title
    ?? (await rpc('chat.list')).chats?.find(row => row.chatId === chatId)?.title
  record('chat created', { characterId, chatId, chatTitle })
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
   * The **browser** endpoint and per-target sessions. A card frame is
   * `sandbox="allow-scripts"`, so its origin is opaque and Chrome splits it out
   * as its own debuggee target: it is not a child in the page's frame tree and
   * its execution contexts never appear on the page's session.
   */
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
    if (r.result?.exceptionDetails !== undefined) {
      throw new Error(`evaluate: ${JSON.stringify(r.result.exceptionDetails)}`)
    }
    return r.result?.result?.value
  }
  const quiet = async (expression, sessionId) => evaluate(expression, sessionId).catch(() => undefined)
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
   * Split the attached frames into the card-script one and the message ones.
   *
   * `srcdoc.ts` stamps `data-iris-interface` on a message frame's body and on
   * nothing else, so the body is what tells them apart — probed rather than
   * assumed from attach order, which is a fact about boot timing rather than
   * about which frame is which. A frame whose body is not there yet answers
   * neither, which is why the two lists are built rather than one derived from
   * the other by negation.
   * @returns the sessions, by kind.
   */
  const frameKinds = async () => {
    const script = []
    const message = []
    for (const sessionId of [...frameSessions.keys()]) {
      const answer = await quiet(
        'document.body ? (document.body.hasAttribute("data-iris-interface") ? "message" : "script") : "unborn"',
        sessionId,
      )
      if (answer === 'message') message.push(sessionId)
      if (answer === 'script') script.push(sessionId)
    }
    return { script, message }
  }

  /**
   * How many plugin style tags this conversation's message frames carry.
   * @returns the total, and the per-frame breakdown for the record.
   */
  const messageFrameStyleTags = async () => {
    const { message } = await frameKinds()
    const per = []
    for (const sessionId of message) {
      per.push(await quiet('document.querySelectorAll("[data-iris-plugin-style]").length', sessionId) ?? -1)
    }
    return { frames: message.length, total: per.reduce((sum, one) => sum + Math.max(one, 0), 0), per }
  }

  /**
   * What a message frame's own body and its first element are painted.
   *
   * The card's status bar **is** the message frame's content, so the frame's own
   * background and its outermost element's are the two honest readings of "did
   * the status bar change colour". The element's tag and class ride along, so a
   * later reader knows what was measured rather than trusting a colour.
   * @returns one row per message frame.
   */
  const statusBarPaint = async () => {
    const { message } = await frameKinds()
    const rows = []
    for (const sessionId of message) {
      rows.push(await quiet(`(() => {
        /*
         * Not \`firstElementChild\`: a card interface's markup opens with its own
         * <script>, so that answers about an element that paints nothing. What
         * is wanted is the panels a reader sees, so the first three laid-out
         * elements are reported with their tag and class as evidence of what
         * was measured — a colour with no element beside it is not a reading.
         */
        const painted = [...document.body.querySelectorAll('*')]
          .filter(el => !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(el.tagName))
          .filter(el => el.getBoundingClientRect().height > 0)
          .slice(0, 3)
          .map(el => ({
            tag: el.tagName,
            cls: (el.className ?? '').toString().slice(0, 40),
            background: getComputedStyle(el).backgroundColor,
          }))
        return { body: getComputedStyle(document.body).backgroundColor, painted }
      })()`, sessionId) ?? { error: 'frame did not answer' })
    }
    return rows
  }

  /**
   * The bytes actually inlined into this conversation's message frames.
   *
   * Read from the **shell** page, off the `srcdoc` attributes, because that is
   * the physical quantity the 2 MiB budget rations. It stands in for the budget
   * panel the design's acceptance asks for, and the reason is printed with the
   * reading: `FramePlan.spent` has no reader in the UI at all.
   * @returns the frame count and the total.
   */
  const inlinedBytes = async () => evaluate(`(() => {
    const docs = [...document.querySelectorAll('iframe')]
      .map(frame => frame.getAttribute('srcdoc') ?? '')
      .filter(text => text.includes('data-iris-interface'))
    return { frames: docs.length, totalChars: docs.reduce((sum, text) => sum + text.length, 0) }
  })()`)

  /** Plugin style tags on the shell's **own** document. Must stay zero (§16.3). */
  const shellStyleTags = async () =>
    evaluate('document.querySelectorAll("[data-iris-plugin-style]").length')

  /**
   * Plugin style tags in the card-script frame — the realm the plugin runs in.
   *
   * Read so that a zero in the message frames is **attributable**: "the plugin
   * never mounted" and "the plugin mounted and the fan-out did not reach" are
   * different defects and they produce the same message-frame reading. Without
   * this the first acceptance run's five red boxes would all have pointed at the
   * fan-out, and only one of the two possible causes would have been ruled out.
   * @param session - the card-script frame's session.
   * @returns how many sheets the plugin has in its own frame.
   */
  const scriptFrameStyleTags = async session =>
    await quiet('document.querySelectorAll("[data-iris-plugin-style]").length', session) ?? -1

  /**
   * Open a chat through the product's own UI.
   *
   * The chats tab by `data-tab` (chrome, translated, never located by text); the
   * row by its **title**, which is user data and the only honest handle there is.
   * Both rules are `qa/locators.mjs`'s.
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
  record('opening the chat', await openChat(chatTitle))
  // Cards take seconds to boot, and the greeting's interface frames boot after
  // the card's own. The wait is long and it is stated, so a zero below reads as
  // "not within 12s" rather than as an unlabelled zero.
  await delay(12_000)

  const kinds = await frameKinds()
  record('card-script frames 12s after opening the chat', kinds.script.length)
  record('message-interface frames 12s after opening the chat', kinds.message.length)
  await shot('0-chat-open')
  check('a card-script frame exists to mount into', kinds.script.length > 0,
    'looked once, ~12s after the chat opened')
  check(
    'the greeting carries at least one message-interface frame',
    kinds.message.length > 0,
    `this whole PR is about reaching them; ${CARD} is chosen because its greeting has one`,
  )
  if (kinds.script.length === 0 || kinds.message.length === 0) {
    throw new Error('without both frame families there is nothing for PR-C to cross')
  }

  const world = kinds.script[0]
  const token = await evaluate(
    'document.querySelector(\'meta[name="iris-token"]\')?.getAttribute("content") ?? ""', world,
  )
  if (token === '') throw new Error('the frame carries no run token')

  const post = async message => evaluate(`window.postMessage(${JSON.stringify(message)}, "*")`, world)
  const mount = async (pluginId, version, code) =>
    post({ iris: token, type: 'plugin:mount', pluginId, version, code })
  const unmount = async pluginId => post({ iris: token, type: 'plugin:unmount', pluginId })
  const styler = css => `return { apply() { iris.styles.insert(${JSON.stringify(css)}) } }`

  /** Reports the host holds now, so a step can be judged by its delta. */
  const reportBaseline = async () => {
    const answer = await rpc('debug.reports', { limit: 2000 })
    return new Set((answer.reports ?? []).map(row => row.seq))
  }
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

  // ---- baseline ----------------------------------------------------------
  const tagsBefore = await messageFrameStyleTags()
  const paintBefore = await statusBarPaint()
  const bytesBefore = await inlinedBytes()
  const shellBefore = await shellStyleTags()
  record('message-frame plugin style tags before any mount', tagsBefore)
  record('status bar paint before any mount', paintBefore)
  record('inlined message-frame srcdoc chars (budget baseline)', bytesBefore)
  record('shell-document plugin style tags before any mount', shellBefore)
  check('item 0 — no message frame carries a plugin sheet before a plugin exists', tagsBefore.total === 0)
  check('item 0 — the shell page carries none either', shellBefore === 0)

  // ---- item 1: a plain rule, and what the cascade does with it -------------
  /*
   * **Not `!important`**, deliberately. The sheet lands in the message frame's
   * head; the card's own `<style>` is in its markup and therefore later in the
   * document, so at equal specificity the card wins. This box measures which
   * way that goes rather than avoiding the question.
   */
  const base1 = await reportBaseline()
  await mount('1-plain', 1, styler('body, body > * { background: rgb(16, 20, 24); }'))
  await delay(4000)
  const tagsPlainEarly = await messageFrameStyleTags()
  await delay(5000)
  const tagsPlain = await messageFrameStyleTags()
  const paintPlain = await statusBarPaint()
  record('message-frame plugin style tags 4s after the plain mount', tagsPlainEarly)
  record('card-script frame plugin style tags after the plain mount', await scriptFrameStyleTags(world))
  record('message-frame plugin style tags 9s after the plain mount', tagsPlain)
  record('status bar paint after the plain mount', paintPlain)
  record('sandbox-plugin report rows after the plain mount', (await newPluginReports(base1, 6_000)).map(r => `${r.grade}:${r.message}`))
  await shot('1-plain-rule')
  check(
    'item 1 — the plugin sheet reaches every message-interface frame',
    tagsPlain.total > 0 && tagsPlain.per.every(one => one > 0),
    `0 → ${String(tagsPlain.total)} across ${String(tagsPlain.frames)} frames; read at 4s and 9s`,
  )
  console.log(
    '  NOTE  item 1 is a cascade measurement, not a pass/fail. The sheet is folded into the frame’s '
    + 'head; the card’s own <style> is later in the document and its rules are class rules, so a plain '
    + 'plugin rule competes normally and can lose on order or on specificity. The paint readings above '
    + 'are the measurement; item 2 is the same rule with !important.',
  )

  await unmount('1-plain')
  await delay(7000)
  record('message-frame plugin style tags after the plain plugin is unmounted', await messageFrameStyleTags())

  // ---- item 2: the design's own scenario, 「把状态栏改成深色」 -------------
  const base2 = await reportBaseline()
  await mount('2-dark', 1, styler('body, body > *, body * { background: rgb(16, 20, 24) !important; }'))
  await delay(4000)
  const tagsDarkEarly = await messageFrameStyleTags()
  await delay(5000)
  const tagsDark = await messageFrameStyleTags()
  const paintDark = await statusBarPaint()
  const bytesDark = await inlinedBytes()
  const shellDark = await shellStyleTags()
  record('message-frame plugin style tags 4s after the dark mount', tagsDarkEarly)
  record('card-script frame plugin style tags after the dark mount', await scriptFrameStyleTags(world))
  record('message-frame plugin style tags 9s after the dark mount', tagsDark)
  record('status bar paint after the dark mount', paintDark)
  record('inlined message-frame srcdoc chars with the sheet folded', bytesDark)
  record('shell-document plugin style tags after the dark mount', shellDark)
  record('sandbox-plugin report rows after the dark mount', (await newPluginReports(base2, 6_000)).map(r => `${r.grade}:${r.message}`))
  await shot('2-dark-mounted')

  check(
    'item 2 — the sheet is in every message frame',
    tagsDark.total > 0 && tagsDark.per.every(one => one > 0),
    `0 → ${String(tagsDark.total)} across ${String(tagsDark.frames)} frames; read at 4s and 9s`,
  )
  const changed = paintDark.filter((row, at) =>
    row?.body !== undefined && row.body !== paintBefore[at]?.body)
  check(
    'item 2 — the status bar is actually painted differently',
    changed.length > 0,
    `${JSON.stringify(paintBefore.map(one => one?.body))} → ${JSON.stringify(paintDark.map(one => one?.body))}`,
  )
  /*
   * §16.3's tooth, on the live page. The frame's sink and the shell's fold write
   * the **same** attribute, so this counts exactly the population the fan-out
   * produces — and it must be empty here, because nothing of this may reach the
   * shell's own document.
   */
  check(
    'item 2 — the shell’s own page still carries zero plugin style tags',
    shellDark === 0,
    'read with the sheet live in the frames, which is the only moment the assertion can fail',
  )

  // ---- item 3: removal --------------------------------------------------
  await unmount('2-dark')
  await delay(4000)
  const tagsGoneEarly = await messageFrameStyleTags()
  await delay(5000)
  const tagsGone = await messageFrameStyleTags()
  const paintGone = await statusBarPaint()
  const bytesGone = await inlinedBytes()
  const shellGone = await shellStyleTags()
  record('message-frame plugin style tags 4s after the unmount', tagsGoneEarly)
  record('message-frame plugin style tags 9s after the unmount', tagsGone)
  record('status bar paint after the unmount', paintGone)
  record('inlined message-frame srcdoc chars after the unmount (budget final)', bytesGone)
  record('shell-document plugin style tags after the unmount', shellGone)
  await shot('3-removed')
  /*
   * Read **twice**, 4s and 9s out. One reading cannot tell "the sheet is gone"
   * from "the replacement frames have not booted yet" — the rebuild parks the
   * old set on screen until its replacement is ready, which is exactly the
   * window in which a single reading lies.
   */
  check(
    'item 3 — removal takes the sheet out of every message frame',
    tagsGone.total === 0,
    `read at 4s (${String(tagsGoneEarly.total)}) and 9s (${String(tagsGone.total)}) after the unmount`,
  )
  check(
    'item 3 — the status bar is painted as it was before any plugin',
    paintGone.every((row, at) => row?.body === paintBefore[at]?.body),
    `${JSON.stringify(paintBefore.map(one => one?.body))} → ${JSON.stringify(paintGone.map(one => one?.body))}`,
  )
  check('item 3 — and the shell page never carried one', shellGone === 0)

  // ---- item 4: the budget ------------------------------------------------
  record('budget: baseline / folded / final inlined chars', {
    baseline: bytesBefore,
    folded: bytesDark,
    final: bytesGone,
  })
  console.log(
    '  NOTE  the design asks for "the frame budget panel’s readings". There is no such panel: '
    + '`FramePlan.spent` has no reader anywhere in the UI. What is read above is the quantity the '
    + 'budget rations — the srcdoc bytes actually inlined into the message frames — measured from '
    + 'the shell. That the plan charges those bytes is pinned by a unit test '
    + '(`plugin-style-fanout.test.ts`, "the frame budget charges what the fold inlines").',
  )
  check(
    'item 4 — folding a sheet costs bytes, and removing it gives them back',
    bytesDark.totalChars > bytesBefore.totalChars && bytesGone.totalChars === bytesBefore.totalChars,
    `${String(bytesBefore.totalChars)} → ${String(bytesDark.totalChars)} → ${String(bytesGone.totalChars)}`,
  )

  // ---- item 5: one plugin's removal is not another's ---------------------
  await mount('3-a', 1, styler('body { outline: 1px solid rgb(1, 2, 3); }'))
  await mount('4-b', 1, styler('body { border-top: 1px solid rgb(4, 5, 6); }'))
  await delay(9000)
  const tagsBoth = await messageFrameStyleTags()
  record('message-frame plugin style tags with two plugins mounted', tagsBoth)
  await unmount('4-b')
  await delay(9000)
  const tagsOne = await messageFrameStyleTags()
  record('message-frame plugin style tags after only the second is unmounted', tagsOne)
  await shot('4-one-of-two-removed')
  /*
   * The survivor is the assertion, not the departure: a store keyed by chat
   * alone would answer "was B's sheet dropped" with a cheerful yes and take A's
   * with it, which from the reader's side is the wrong plugin being removed.
   */
  check(
    'item 5 — unmounting one plugin leaves the other’s sheet in place',
    tagsBoth.total === 2 * tagsBoth.frames && tagsOne.total === tagsOne.frames && tagsOne.frames > 0,
    `${String(tagsBoth.total)} tags over ${String(tagsBoth.frames)} frames → `
    + `${String(tagsOne.total)} over ${String(tagsOne.frames)}`,
  )
  await unmount('3-a')

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
