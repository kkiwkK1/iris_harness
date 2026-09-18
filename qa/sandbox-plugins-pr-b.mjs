/**
 * PR-B acceptance for sandbox plugins: the sidecar, the confirmation card, and
 * a real model request.
 *
 * Runs `docs/SANDBOX-PLUGINS.md` §15 PR-B items 1–7 against a real host, the
 * production bundle, a real card-script frame and — for three of the items — a
 * **real provider, spending real money**. Hard failures: a `console.error`
 * followed by more output is indistinguishable, in the report, from "this box
 * was fine" (qa/README.md).
 *
 * ## What this costs, and the cap
 *
 * Every 「create」 sentence is one completion on the authoring profile. This
 * script sends **at most three** (items 1, 4 and 6) and says so before each one.
 * Items 2, 3, 5 and 7 spend nothing: they re-read, restart, remove and recycle
 * what item 1 already paid for. `SPEND_CAP` is enforced rather than documented —
 * a run that would exceed it stops.
 *
 * Nothing about a provider is printed. The authoring setting is made through the
 * product's own `connection.authoring` RPC against the copied data dir; no key
 * material is read, written or echoed, and the profile is named by its id and
 * label only.
 *
 * ## Observation windows
 *
 * - Every reading carries `observedAtMs`. "The panel is still there" is
 *   meaningless without "looked when": a row that arrives a second after the
 *   screenshot and one that never arrives look identical afterwards.
 * - `debug.reports` is a **persistent** channel, so every criterion over it is a
 *   delta from a baseline taken before the step. Note that a baseline is not a
 *   subset of the final read — the card report list is cleared on a character
 *   change — so the difference is the judgement, never the count.
 * - Item 4's expected outcome is a **known boundary, not a pass**: the style
 *   fan-out into message frames is PR-C, so a status bar drawn in a message
 *   frame is expected NOT to change. It is recorded as a boundary and printed as
 *   one.
 *
 * Usage: node qa/sandbox-plugins-pr-b.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { answerConsentExpr, clickTabExpr } from './locators.mjs'

// Host ports go from 8791 up, one per script; PR-A holds 8791.
const PORT = Number(process.env.IRIS_PORT ?? 8793)
const BASE = `http://127.0.0.1:${String(PORT)}`
// CDP ports go from 9333 up, all distinct; 9346 is unused by qa/README.md's
// table and by PR-A's 9345. The pid offset is `cdpPort`'s, not copied here.
const CDP = String(cdpPort(9346))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** How many completions this run may buy. Enforced, not documented. */
const SPEND_CAP = 8
let spent = 0

const outDir = new URL('./results/sandbox-plugins-pr-b/', import.meta.url)
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
/** A finding that is neither a pass nor a failure, because the design says so. */
const boundary = (what, detail) => {
  readings.push({ boundary: what, detail, observedAtMs: Date.now() })
  console.log(`  BOUNDARY  ${what} — ${detail}`)
}

/*
 * The port must be free **before** the host starts, and must never be re-checked
 * afterwards. A collision does not make the requests fail; it makes them succeed
 * against somebody else's host (qa/README.md, the 2026-09-06 incident).
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
 * A **copy** of the product's data dir, with the lock removed. One data dir has
 * one host since #72 and there is no bypass, so a QA host on the repo's own
 * `apps/iris/data` would either refuse to start or fight the operator's dev host.
 */
const dataDir = await mkdtemp(join(tmpdir(), 'iris-sandbox-plugins-b-qa-'))
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
let host
const startHost = async () => {
  hostOutput = ''
  host = spawn(process.execPath, ['apps/iris/bin.ts'], {
    cwd: repoRoot,
    env: { ...process.env, IRIS_PORT: String(PORT), IRIS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  host.stdout.on('data', chunk => { hostOutput += String(chunk) })
  host.stderr.on('data', chunk => { hostOutput += String(chunk) })
  console.log(`host process PID ${String(host.pid)} on port ${String(PORT)}, data dir ${dataDir}`)
  // Up, or dead with its own reason. Nothing is asked of the port afterwards:
  // "the port is listening" is not "my process is listening".
  for (let at = 0; at < 60; at += 1) {
    await delay(500)
    if (hostOutput.includes('EADDRINUSE')) {
      throw new Error(`the host died on EADDRINUSE — another process holds ${String(PORT)}:\n${hostOutput}`)
    }
    if (await rpc('character.list').then(() => true).catch(() => false)) return
  }
  throw new Error(`the host on ${String(PORT)} never answered\n${hostOutput}`)
}
const stopHost = async () => {
  if (host?.exitCode === null) {
    const pid = host.pid
    host.kill()
    await new Promise(resolve => { host.once('exit', resolve) })
    console.log(`  host PID ${String(pid)} stopped`)
  }
}

let seq = 0
const rpc = async (method, params = {}) => {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-plugins-b-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const sidecarNames = async () =>
  readdir(join(dataDir, 'default-user', 'sandbox-plugins')).then(names => names.sort()).catch(() => [])

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 900_000)

let chrome
try {
  await startHost()

  /*
   * The card set, read before anything is written. Printed rather than asserted
   * against a fixed list — the data dir is a copy of whatever the repo ships —
   * and what it is *for* is the README's rule: cards this script did not expect
   * mean the host being talked to is not the one started above.
   */
  const cards = await rpc('character.list')
  record('character.list before any write', cards.characters?.map(c => c.characterId) ?? [])

  // ---- the authoring connection, through the product's own RPC ------------
  const connections = await rpc('connection.list')
  record('saved providers (ids and labels only)', (connections.profiles ?? []).map(p => ({
    id: p.id, label: p.label ?? null, model: p.model, current: p.id === connections.activeId,
  })))
  if ((connections.profiles ?? []).length === 0) {
    throw new Error('this data dir has no saved provider; items 1, 4 and 6 need one to spend on')
  }
  if (connections.authoring === undefined) {
    const pick = (connections.profiles ?? []).find(p => p.id === connections.activeId)
      ?? connections.profiles[0]
    /*
     * Through `connection.authoring`, never by editing the file. The key lives
     * beside `connections.json` under an OS protector, and a hand edit is the
     * one operation that can leave the store readable and the key not.
     */
    const set = await rpc('connection.authoring', { id: pick.id, model: pick.model })
    record('authoring connection set through the product', {
      id: set.authoring?.id ?? null, model: set.authoring?.model ?? null,
    })
  } else {
    record('authoring connection already configured', {
      id: connections.authoring.id, model: connections.authoring.model,
    })
  }

  // The card this run plays. A card with scripts, so "the card still chats after
  // a plugin failed" is a statement about something that was running.
  const withScripts = []
  for (const card of cards.characters ?? []) {
    const listed = await rpc('script.list', { characterId: card.characterId }).catch(() => ({ scripts: [] }))
    if ((listed.scripts ?? []).some(s => s.enabled)) withScripts.push(card.characterId)
  }
  record('cards with at least one enabled script', withScripts)
  if (withScripts.length === 0) throw new Error('no card in this data dir ships an enabled script')
  const characterId = withScripts[0]

  const created = await rpc('chat.create', { characterId })
  const chatId = created.view?.chatId ?? created.chatId
  const chatTitle = created.view?.title ?? created.title
    ?? (await rpc('chat.list')).chats?.find(row => row.chatId === chatId)?.title
  record('chat created for items 1-6', { characterId, chatId, chatTitle })
  if (chatTitle === undefined) throw new Error('the host did not name the chat it created')

  // ---- the browser -------------------------------------------------------
  chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${tmpdir()}/iris-qa-cdp-${CDP}-${String(Date.now())}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    '--window-size=1480,1000', 'about:blank',
  ], { stdio: 'ignore' })

  let version
  for (let at = 0; at < 40 && version === undefined; at += 1) {
    await delay(500)
    try {
      version = await fetch(`http://127.0.0.1:${CDP}/json/version`).then(r => r.json())
    } catch { /* chrome not up yet */ }
  }
  if (version === undefined) throw new Error('chrome never came up')

  /*
   * The **browser** endpoint and per-target sessions: a card frame is
   * `sandbox="allow-scripts"`, so Chrome splits it out as its own debuggee and
   * it never appears in the page's frame tree (`qa/measure-z2-scroll.mjs`
   * records the same finding).
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
   * Probed by the absence of `data-iris-interface` — the attribute `srcdoc.ts`
   * stamps on a **message** frame's body and on nothing else — rather than
   * assumed from the attach order, which is a fact about boot timing.
   * @returns the session id, or undefined.
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

  /**
   * What the composer's mode is, read off the two things that show it.
   *
   * The row's `aria-checked` is the state; the placeholder and the send
   * control's name are what a *reader* sees. All three are returned because the
   * point of the mode being visible is that these agree — and the first run of
   * this script proved why it matters: a toggle that assumed it was off turned
   * the mode off instead of on, and the next sentence went into the
   * conversation as a line of dialogue.
   * @returns the mode, from the row and from the two visible signals.
   */
  const composerMode = async () => evaluate(`(async () => {
    const plus = document.querySelector('.iris-composer__disc--quiet')
    if (plus === null) return { error: 'no 「+」 disc in the composer' }
    const wasOpen = plus.getAttribute('aria-expanded') === 'true'
    if (!wasOpen) plus.click()
    await new Promise(r => setTimeout(r, 400))
    const rows = [...document.querySelectorAll('[role="menu"] button[role^="menuitem"]')]
    const row = rows[rows.length - 1]
    const state = {
      rowCount: rows.length,
      label: (row?.textContent ?? '').trim(),
      note: (row?.querySelector('.iris-composer-menu__note')?.textContent ?? '').trim(),
      checked: row?.getAttribute('aria-checked') ?? null,
      placeholder: document.querySelector('.iris-composer__field')?.getAttribute('placeholder') ?? null,
      sendLabel: document.querySelector('.iris-composer__send')?.getAttribute('aria-label') ?? null,
    }
    // Left open on purpose when the caller is about to click it.
    return state
  })()`)

  /** Click the last row of the open 「+」 menu, which is the mode toggle. */
  const toggleCreateMode = async () => evaluate(`(async () => {
    const rows = [...document.querySelectorAll('[role="menu"] button[role^="menuitem"]')]
    const row = rows[rows.length - 1]
    if (row === undefined) return { error: 'the 「+」 menu is not open' }
    const label = (row.textContent ?? '').trim()
    row.click()
    await new Promise(r => setTimeout(r, 400))
    return {
      clickedLabel: label,
      placeholder: document.querySelector('.iris-composer__field')?.getAttribute('placeholder') ?? null,
      sendLabel: document.querySelector('.iris-composer__send')?.getAttribute('aria-label') ?? null,
    }
  })()`)

  /**
   * Put the composer into 「create」 mode, whatever mode it is in now.
   *
   * **Idempotent, and that is the fix for a real bug in this instrument.** The
   * first run clicked the toggle unconditionally; after item 4 the mode was
   * still on (nothing had navigated since), so item 6's click turned it *off*
   * and the sentence went into the conversation as dialogue — no refusal, no
   * report, and a real turn bought by accident. The mode is read first, and the
   * result is verified rather than assumed.
   *
   * The 「+」 disc is located by class and its menu row **by position**, with the
   * row's visible text recorded as evidence: chrome is never located by text (it
   * is translated, and headless Chrome follows `navigator.language`), and the
   * composer menu carries no identity attribute.
   * @returns the state before, what was clicked, and the state after.
   */
  const enterCreateMode = async () => {
    const before = await composerMode()
    if (before?.error !== undefined) return before
    if (before.checked === 'true') {
      // Already in the mode; close the menu and say so rather than toggling.
      await evaluate('document.querySelector(".iris-composer__disc--quiet")?.click()')
      return { alreadyOn: true, before }
    }
    const clicked = await toggleCreateMode()
    const after = await composerMode()
    await evaluate(`(() => {
      const plus = document.querySelector('.iris-composer__disc--quiet')
      if (plus?.getAttribute('aria-expanded') === 'true') plus.click()
    })()`)
    return { before, clicked, after }
  }

  /** Whether the composer is in 「create」 mode right now, by what a reader sees. */
  const inCreateMode = async () => evaluate(`(() => {
    const send = document.querySelector('.iris-composer__send')?.getAttribute('aria-label') ?? ''
    const field = document.querySelector('.iris-composer__field')?.getAttribute('placeholder') ?? ''
    return { sendLabel: send, placeholder: field }
  })()`)

  /**
   * Type a sentence into the composer and press its send control.
   *
   * The value goes in through React's own setter so the component's state moves;
   * writing `.value` alone leaves React's tracker stale and the draft empty,
   * which looks exactly like a send that did nothing.
   * @param text - the sentence.
   * @returns what the field and the disc looked like at the moment of the press.
   */
  const saySentence = async text => evaluate(`(async () => {
    const field = document.querySelector('.iris-composer__field')
    if (field === null) return { error: 'no composer field' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(field, ${JSON.stringify(text)})
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 300))
    const disc = document.querySelector('.iris-composer__send')
    if (disc === null) return { error: 'no send disc' }
    const label = disc.getAttribute('aria-label')
    const disabled = disc.disabled === true
    if (!disabled) disc.click()
    return { sent: !disabled, sendLabel: label, wasDisabled: disabled }
  })()`)

  /** Everything the confirmation card is showing, so the six lines can be read. */
  const confirmCard = async () => evaluate(`(() => {
    const regions = [...document.querySelectorAll('.iris-notice[role="region"]')]
    const card = regions.find(el => el.querySelectorAll('.iris-var__row').length >= 5)
    if (card === undefined) {
      return { present: false, regions: regions.map(el => (el.getAttribute('aria-label') ?? '').slice(0, 60)) }
    }
    return {
      present: true,
      heading: (card.querySelector('.iris-label')?.textContent ?? '').trim(),
      rows: [...card.querySelectorAll('.iris-var__row')].map(row => ({
        key: (row.querySelector('.iris-var__key')?.textContent ?? '').trim(),
        value: (row.querySelector('.iris-var__value')?.textContent ?? '').trim().slice(0, 240),
      })),
      notes: [...card.querySelectorAll('.iris-field__note')].map(p => (p.textContent ?? '').trim().slice(0, 240)),
      buttons: [...card.querySelectorAll('.iris-probe__actions button')].map(b => (b.textContent ?? '').trim()),
    }
  })()`)

  /** Press the confirmation card's first control — the single tick. */
  const acceptThisVersion = async () => evaluate(`(() => {
    const regions = [...document.querySelectorAll('.iris-notice[role="region"]')]
    const card = regions.find(el => el.querySelectorAll('.iris-var__row').length >= 5)
    if (card === undefined) return { error: 'no confirmation card to answer' }
    const buttons = [...card.querySelectorAll('.iris-probe__actions button')]
    if (buttons.length < 3) return { error: 'the card has ' + buttons.length + ' controls, expected 3' }
    const label = (buttons[0].textContent ?? '').trim()
    buttons[0].click()
    return { clicked: label }
  })()`)

  /** The sidebar panel's rows, which is what 「this conversation grew」 shows. */
  const panelRows = async () => evaluate(`(() => {
    const side = document.querySelector('.iris-sidebar')
    if (side === null) return { error: 'no sidebar' }
    const sections = [...side.querySelectorAll('.iris-section')]
    return {
      sectionHeads: sections.map(s => (s.querySelector('.iris-section__head')?.textContent ?? '').trim()),
      rows: sections.flatMap(s => [...s.querySelectorAll('.iris-conn')].map(row => ({
        name: (row.querySelector('.iris-conn__name')?.textContent ?? '').trim(),
        meta: [...row.querySelectorAll('.iris-conn__meta')].map(m => (m.textContent ?? '').trim().slice(0, 160)),
      }))),
      empties: sections.map(s => (s.querySelector('.iris-field__note')?.textContent ?? '').trim().slice(0, 160)),
    }
  })()`)

  /**
   * What the composer looks like in its **ordinary** mode, captured once.
   *
   * Held so the mode can be judged by "different from this" rather than by
   * matching translated copy — the placeholder and the send control's name are
   * chrome, and this machine's interface comes up in Chinese.
   */
  let ordinaryComposer

  /**
   * One 「create」 sentence, against the cap and against the mode.
   *
   * **Refuses rather than sends when the composer is not in create mode.** The
   * first run of this script sent one into the conversation instead — a line of
   * dialogue, a real turn, and a box that read as "the model behaved" when what
   * had happened was that nobody had asked it anything. A silent mode is the one
   * way this interaction fails, on the reader's side and on the instrument's.
   * @param why - which item is spending.
   * @param sentence - the sentence.
   * @returns what the field and the disc looked like at the press.
   */
  const spend = async (why, sentence) => {
    if (spent >= SPEND_CAP) throw new Error(`the spend cap of ${String(SPEND_CAP)} completions is reached`)
    const mode = await inCreateMode()
    if (mode.sendLabel === ordinaryComposer?.sendLabel && mode.placeholder === ordinaryComposer?.placeholder) {
      throw new Error(
        `${why}: the composer is still in its ordinary mode (${JSON.stringify(mode)}), so this sentence would `
        + 'go into the conversation as dialogue rather than to the authoring model',
      )
    }
    spent += 1
    console.log(`  SPEND ${String(spent)}/${String(SPEND_CAP)} — ${why}: ${JSON.stringify(sentence)}`)
    const said = await saySentence(sentence)
    record(`the sentence was sent (${why})`, { ...said, mode })
    return said
  }

  await nav(`${BASE}/`)
  record('opening the chat for items 1-6', await openChat(chatTitle))
  await delay(8000)
  const world = await scriptFrameSession()
  check('a card-script frame exists before any plugin', world !== undefined,
    'looked 8s after the chat opened')

  const styleTags = async session =>
    session === undefined ? -1 : evaluate('document.querySelectorAll("[data-iris-plugin-style]").length', session)
  const panelCells = async session =>
    session === undefined ? -1 : evaluate('document.querySelectorAll("[data-iris-plugin-panel]").length', session)

  // ---- item 1: a sentence, a confirmation card, a single tick, a panel ----
  // The ordinary composer, read before anything is toggled, so 「in create mode」
  // can be judged as "not this" rather than by matching translated copy.
  ordinaryComposer = await inCreateMode()
  record('the composer in its ordinary mode', ordinaryComposer)
  record('the 「create」 toggle', await enterCreateMode())
  record('the composer after the toggle', await inCreateMode())
  const baseline1 = await reportBaseline()
  await spend('item 1', '加一个显示回合数的小面板')
  // A completion takes time. The window is stated so a zero below reads as
  // "not within 120s" rather than as an unlabelled zero.
  let card
  for (let at = 0; at < 120; at += 1) {
    await delay(1000)
    card = await confirmCard()
    if (card?.present === true) break
  }
  record('the confirmation card, up to 120s after the sentence', card)
  await shot('1-confirmation-card')
  check('item 1 — a confirmation card appeared', card?.present === true, 'waited up to 120s')

  if (card?.present === true) {
    /*
     * The six lines of §4.1, each checked by the presence of its own row rather
     * than by matching translated copy: the labels are chrome. What is asserted
     * is the **shape** — five labelled rows, the sandbox sentence, three
     * controls — and the text is recorded beside it as evidence.
     */
    check('item 1 — the card carries five labelled rows (name, purpose, declares, code, the sentence)',
      (card.rows?.length ?? 0) >= 5, `saw ${String(card.rows?.length ?? 0)}`)
    check('item 1 — the card shows a byte count for the code',
      (card.rows ?? []).some(row => /\d/u.test(row.value)), 'the code row carries a number')
    check('item 1 — the card quotes the sentence the reader said',
      JSON.stringify(card.rows ?? []).includes('回合'), 'the prompt row carries the words typed')
    check('item 1 — the card says where the code runs',
      (card.notes ?? []).some(note => note.length > 20), 'a sandbox sentence is present')
    check('item 1 — three controls: this version, this plugin, no thanks',
      (card.buttons?.length ?? 0) === 3, `saw ${String(card.buttons?.length ?? 0)}`)

    record('single tick', await acceptThisVersion())
    await delay(4000)
    const afterAccept = await scriptFrameSession()
    const cells = await panelCells(afterAccept)
    const rows = await panelRows()
    record('plugin panel cells in the card-script frame, 4s after the tick', cells)
    record('the sidebar panel, 4s after the tick', rows)
    await shot('1-after-accept')
    check('item 1 — the plugin mounted and drew its cell', cells >= 1,
      'read 4s after the tick, inside the card-script frame')
    check('item 1 — the sidecar holds one file for this conversation',
      (await sidecarNames()).includes(`${chatId}.json`), 'read from the copied data dir')
    record('sandbox-plugin reports from item 1', await newPluginReports(baseline1, 2000))
  }

  // ---- item 2: away and back ---------------------------------------------
  await nav(`${BASE}/`)
  record('re-opening the chat for item 2', await openChat(chatTitle))
  await delay(9000)
  const world2 = await scriptFrameSession()
  const cells2 = await panelCells(world2)
  record('plugin panel cells 9s after re-opening the chat', cells2)
  record('the sidebar panel after re-opening', await panelRows())
  await shot('2-after-reopen')
  check('item 2 — the plugin is still there after leaving and coming back', cells2 >= 1,
    'read 9s after the chat was re-opened; this is the only criterion for 「persists per conversation」')

  // ---- item 3: a host restart ---------------------------------------------
  await stopHost()
  await delay(1500)
  await startHost()
  await nav(`${BASE}/`)
  record('re-opening the chat for item 3, on the restarted host', await openChat(chatTitle))
  await delay(9000)
  const world3 = await scriptFrameSession()
  const cells3 = await panelCells(world3)
  record('plugin panel cells 9s after a host restart', cells3)
  await shot('3-after-host-restart')
  check('item 3 — the plugin survives a host restart', cells3 >= 1,
    'read 9s after the chat was re-opened on a host started after the first was stopped; '
    + 'this is the only criterion for 「not session-only」')

  // ---- item 4: a style, and the boundary it stops at ----------------------
  const stylesBefore = await styleTags(world3)
  record('plugin style tags in the card-script frame before item 4', stylesBefore)
  const messageFrameStyles = async () => {
    let total = 0
    for (const sessionId of [...frameSessions.keys()]) {
      const isInterface = await evaluate(
        'document.body ? document.body.hasAttribute("data-iris-interface") : false', sessionId,
      ).catch(() => false)
      if (isInterface !== true) continue
      total += await evaluate('document.querySelectorAll("[data-iris-plugin-style]").length', sessionId)
        .catch(() => 0)
    }
    return total
  }
  record('plugin style tags in message frames before item 4', await messageFrameStyles())
  record('the 「create」 toggle for item 4', await enterCreateMode())
  record('the composer mode before item 4 is spent', await inCreateMode())
  await spend('item 4', '把状态栏改成深色')
  let card4
  for (let at = 0; at < 120; at += 1) {
    await delay(1000)
    card4 = await confirmCard()
    if (card4?.present === true) break
  }
  record('the confirmation card for item 4, up to 120s after the sentence', card4)
  if (card4?.present === true) {
    record('single tick for item 4', await acceptThisVersion())
    await delay(5000)
    const world4 = await scriptFrameSession()
    const stylesAfter = await styleTags(world4)
    const inMessages = await messageFrameStyles()
    record('plugin style tags in the card-script frame 5s after the tick', stylesAfter)
    record('plugin style tags in message frames 5s after the tick', inMessages)
    await shot('4-style-plugin')
    check('item 4 — the style landed in the card-script frame', stylesAfter > stylesBefore,
      'read 5s after the tick')
    /*
     * **Recorded as a boundary, not as a pass.** The fan-out into this card's
     * message frames is PR-C (§15), so a status bar drawn in a message frame is
     * expected NOT to change here. Writing this box green would be the exact
     * error the design warns about — 「验收要把这个记成已知边界并指向 PR-C，
     * 不是记成通过」.
     */
    boundary(
      'item 4 — the style did not reach the message frames',
      `message-frame plugin style tags: ${String(inMessages)} (expected 0 until PR-C). `
      + 'The fan-out of `plugin:style` into a card\'s message frames is PR-C; until then a status bar '
      + 'drawn inside a message stays as it was, and this is a known boundary rather than a pass.',
    )
  } else {
    check('item 4 — a confirmation card appeared', false, 'waited up to 120s')
  }

  // ---- item 5: remove it --------------------------------------------------
  const filesBefore = await sidecarNames()
  const sidecarRows = async () => {
    const path = join(dataDir, 'default-user', 'sandbox-plugins', `${chatId}.json`)
    return readFile(path, 'utf8').then(text => JSON.parse(text).plugins?.length ?? 0).catch(() => 0)
  }
  const rowsBefore = await sidecarRows()
  record('sidecar files and rows before item 5', { files: filesBefore, rows: rowsBefore })
  /*
   * **Through the panel's own 「delete」, not a sentence.** The design's item 5
   * says 「说『把它删掉』」, and there is no such path: `sandboxPlugin.define` only
   * creates or replaces, and removal is one of `decide`'s six verdicts, which is
   * the panel's control (§4.3, §10.2). Recorded as a boundary rather than
   * quietly substituted.
   */
  boundary(
    'item 5 — removal is the panel\'s control, not a sentence',
    'The design writes item 5 as 「说「把它删掉」」. The contract has no such road: `define` creates or '
    + 'replaces a plugin and `decide` carries the six verdicts, of which `remove` is one, and §12 puts it '
    + 'on the list panel. Driven through the panel here.',
  )
  const removed = await evaluate(`(() => {
    const side = document.querySelector('.iris-sidebar')
    if (side === null) return { error: 'no sidebar' }
    const rows = [...side.querySelectorAll('.iris-section .iris-conn')]
    if (rows.length === 0) return { error: 'no plugin rows in the sidebar' }
    const buttons = [...rows[0].querySelectorAll('.iris-conn__actions button')]
    const danger = buttons[buttons.length - 1]
    const label = (danger?.textContent ?? '').trim()
    danger?.click()
    return { rows: rows.length, clicked: label }
  })()`)
  record('the panel\'s remove control', removed)
  await delay(4000)
  const world5 = await scriptFrameSession()
  const cells5 = await panelCells(world5)
  const styles5 = await styleTags(world5)
  const rowsAfter = await sidecarRows()
  record('plugin cells, style tags and sidecar rows 4s after the removal',
    { cells: cells5, styles: styles5, rows: rowsAfter })
  record('the sidebar panel after the removal', await panelRows())
  await shot('5-after-remove')
  check('item 5 — the sidecar has one row fewer', rowsAfter === rowsBefore - 1,
    `${String(rowsBefore)} → ${String(rowsAfter)}, read from the copied data dir 4s after the click`)
  /*
   * The removed plugin's own artefact is gone from the frame, and **only** its
   * own: the removal above takes the first row, which is the panel plugin, so
   * the style tag belonging to the *other* plugin is expected to stay. A check
   * that demanded zero style tags would be asserting that removing one plugin
   * tears down another's work.
   */
  check('item 5 — the removed plugin\'s panel cell came away', cells5 === 0,
    `panel cells ${String(cells5)}, style tags ${String(styles5)} (the surviving plugin's), read 4s after the click`)

  // ---- item 6: the model writes code that will not compile ----------------
  const baseline6 = await reportBaseline()
  record('the 「create」 toggle for item 6', await enterCreateMode())
  record('the composer mode before item 6 is spent', await inCreateMode())
  await spend('item 6', '写一个插件，但在代码里故意少写一个右花括号，让它无法编译。不要修正这个错误。')
  // A refusal takes one round trip after the completion; the window is stated.
  await delay(1000)
  let refusal
  for (let at = 0; at < 120; at += 1) {
    await delay(1000)
    refusal = await evaluate(`(() => ({
      hint: (document.querySelector('.iris-composer__hint')?.textContent ?? '').trim().slice(0, 300),
      retry: [...document.querySelectorAll('.iris-composer__hint .iris-act')].map(b => (b.textContent ?? '').trim()),
      notice: (document.querySelector('.iris-notice--error')?.textContent ?? '').trim().slice(0, 300),
      card: document.querySelectorAll('.iris-notice[role="region"]').length,
    }))()`)
    if ((refusal?.retry?.length ?? 0) > 0 || (refusal?.notice ?? '') !== '') break
  }
  record('what the composer said after item 6, up to 120s after the sentence', refusal)
  const reports6 = await newPluginReports(baseline6, 4000)
  record('sandbox-plugin reports from item 6', reports6.map(row => ({
    seq: row.seq, grade: row.grade, message: String(row.message).slice(0, 300),
  })))
  await shot('6-bad-code')
  /*
   * A model asked to write broken code may simply refuse or write working code,
   * and that is not a defect in this build. So the box is judged on **what
   * happened**: a named refusal with a retry entry (the design's requirement) if
   * the code was bad, and a recorded reading if the model behaved.
   */
  const named = (refusal?.retry?.length ?? 0) > 0
  if (named) {
    check('item 6 — a named refusal with a retry entry', true,
      `the composer says: ${String(refusal?.hint ?? '').slice(0, 160)}`)
    check('item 6 — the failure reached the host\'s report buffer under `sandbox-plugin`',
      reports6.length > 0, `${String(reports6.length)} new row(s) within 4s of the refusal`)
  } else {
    boundary(
      'item 6 — the model did not produce code that fails to compile',
      'The refusal path is exercised deterministically by `sandbox-plugins.test.ts` '
      + "('code the model cannot compile is refused by name, before anything is stored'). "
      + `What the composer showed instead: ${JSON.stringify(refusal)}`,
    )
  }
  // The card is still a card: a plugin that failed must not take the
  // conversation with it (AUTORUN §3.3, carried to plugins).
  const stillChatting = await evaluate(`({
    messages: document.querySelectorAll('.iris-msg').length,
    composer: document.querySelectorAll('.iris-composer__field').length,
    frames: document.querySelectorAll('iframe').length,
  })`)
  record('the conversation right after item 6', stillChatting)
  check('item 6 — the card is still running and the conversation is still usable',
    stillChatting.composer >= 1 && stillChatting.frames >= 1, 'read immediately after the refusal')

  // ---- item 7: a recycled chat id -----------------------------------------
  /*
   * Chat ids are minted as `toId(title)-<yyyymmdd-hhmmss>`, so deleting a
   * conversation and creating another of the same name **within the same
   * second** hands the new one the old id. That is the condition §10.3's hard
   * requirement exists for, and it is forced here rather than hoped for: the
   * loop keeps trying until the id comes back, and says how many tries it took.
   */
  const before7 = await sidecarNames()
  record('sidecar files before item 7', before7)
  /*
   * **A chat id is only recyclable inside the second it was minted in.**
   *
   * `chats.ts` mints `toId(title)-<yyyymmdd-hhmmss>` and `uniqueId` appends a
   * counter when that is taken, so a conversation created minutes ago can never
   * be handed its id back — the first run of this script tried thirteen times
   * against an id from four minutes earlier, which could not have worked once.
   * The recyclable one is a conversation **created and deleted inside one
   * second**, so this item builds its own.
   *
   * It is given a sidecar for free, by branching: a branch copies its parent's
   * plugins (§10.3), which is both what makes the id-reuse question meaningful
   * here and a live reading of the branch rule that otherwise only a unit test
   * sees. The branch's title is released when it is deleted, so branching again
   * in the same second re-mints the same id.
   */
  /*
   * **The conversation handed the recycled id must be one that has no business
   * holding a plugin**, and that is what the second run of this script got
   * wrong: it re-branched the *same* parent, so the new conversation got a fresh
   * legitimate copy and the reading could not tell inheritance from copying.
   *
   * So there are two parents. The **carrier** is a branch of the conversation
   * that grew something, so its sidecar exists and its id is a fresh one. The
   * **blank** is an ordinary new chat with nothing in it, and a branch of it
   * carries the same title — `branchTitle` derives from the parent's title, and
   * both parents are titled after the same card — so it mints the same id when
   * it lands in the same second. A plugin in *that* conversation came from
   * exactly one place: a file the delete should have taken.
   */
  const blank = await rpc('chat.create', { characterId })
  const blankId = blank.view?.chatId ?? blank.chatId
  record('a conversation with nothing in it, to branch from', blankId)

  let recycled
  let tries = 0
  let carrier
  let seenBranchCopy
  for (; tries < 20 && recycled === undefined; tries += 1) {
    const carried = await rpc('chat.branch', { chatId, id: 0 })
    carrier = carried.view?.chatId ?? carried.chatId
    if (seenBranchCopy === undefined) {
      const branchPlugins = await rpc('sandboxPlugin.list', { chatId: carrier })
      seenBranchCopy = (branchPlugins.plugins ?? []).map(p => ({
        id: p.id, authorized: p.authorized, branchedFrom: p.branchedFrom ?? null,
      }))
      record('a branch of the conversation that grew something', {
        carrier, plugins: seenBranchCopy, sidecar: await sidecarNames(),
      })
      check('item 7 (setup) — the branch carries the parent\'s plugin, authorised and marked',
        seenBranchCopy.length === 1
        && seenBranchCopy[0]?.authorized === true
        && seenBranchCopy[0]?.branchedFrom === chatId,
        'read immediately after `chat.branch`; the coordinator\'s 2026-09-19 ruling, live')
    }
    await rpc('chat.delete', { chatId: carrier })
    const reborn = await rpc('chat.branch', { chatId: blankId, id: 0 })
    const rebornId = reborn.view?.chatId ?? reborn.chatId
    if (rebornId === carrier) { recycled = rebornId; break }
    await rpc('chat.delete', { chatId: rebornId })
  }
  record('chat id recycling', { got: recycled ?? null, lastCarrier: carrier, tries: tries + 1 })
  if (recycled === undefined) {
    boundary(
      'item 7 — the chat id could not be recycled in this run',
      `tried ${String(tries + 1)} times; ids carry a one-second stamp, so a delete and a re-create have to `
      + 'land in the same second. The hard requirement is covered deterministically by '
      + "`sandbox-plugins.test.ts` ('deleting a conversation takes its plugins with it').",
    )
  } else {
    const inherited = await rpc('sandboxPlugin.list', { chatId: recycled })
    const after7 = await sidecarNames()
    record('what the recycled conversation holds', {
      plugins: inherited.plugins?.length ?? 0, mounts: inherited.mounts?.length ?? 0, files: after7,
    })
    /*
     * Both halves. An empty list alone is also what a **leftover** file produces
     * right up until something reads it as this conversation's, so the file has
     * to be gone as well as the list empty.
     */
    check('item 7 — a conversation handed a recycled id inherits nothing',
      (inherited.plugins?.length ?? 0) === 0 && !after7.includes(`${recycled}.json`),
      `the id ${recycled} belonged to a branch of the conversation that grew something, was deleted with `
      + 'its plugins, and was minted again for a branch of an empty conversation; read immediately after '
      + "— this is §10.3's hard requirement")
  }

  record('completions spent', spent)
  await writeFile(new URL('readings.json', outDir), JSON.stringify(readings, null, 2), 'utf8')
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${String(failures)} CHECK(S) FAILED`}`)
} catch (error) {
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  failures += 1
  await writeFile(new URL('readings.json', outDir), JSON.stringify(readings, null, 2), 'utf8').catch(() => undefined)
} finally {
  clearTimeout(HARD)
  // Only what this script started, and only by the pid it holds.
  if (chrome?.pid !== undefined && chrome.exitCode === null) chrome.kill()
  await stopHost().catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}

process.exit(failures === 0 ? 0 : 1)
