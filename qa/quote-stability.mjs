/**
 * Does the quote colour stay on the page? A stability reading, not a gate.
 *
 * `quote-colour-acceptance.mjs` answers "is the dialogue a different colour
 * from the prose" on a probe card whose greeting was written for the rule.
 * This script answers a different question, on **real** conversations that
 * nobody wrote for it: having been marked once, do the `<q>` elements survive
 * time and a re-render?
 *
 * The suspicion is specific. The marking is a `useLayoutEffect` over React's
 * own text nodes: it empties the node React owns and hangs the decorated copy
 * beside it (`app/quoted-dialogue.ts`). A commit that re-renders the row
 * **without changing any of the effect's dependencies** would write React's
 * value back into that host and leave nothing to re-mark it — the colour would
 * simply go, with nothing in any log to say so. A scripted card is the place
 * to look, because its message rows are re-rendered by things the reading
 * surface does on its own: frame claims settle, a card's script writes state,
 * a plugin's style fans out.
 *
 * ## What is read, and when
 *
 * `document.querySelectorAll('.iris-msg__text q').length` at **2 s, 10 s and
 * 30 s** after the conversation is opened, and again **after a deliberate
 * re-render** — the state panel collapsed and re-expanded, then the viewport
 * resized and put back. Both of those change what React renders while leaving
 * the message row's own inputs (text, role, body tag, quote scope, swipe
 * index) exactly as they were, which is the situation the suspicion names.
 *
 * Two conversations: **黑兽** (a scripted card, the subject) and **Assistant**
 * (no card, no scripts, the control). A drop on the subject alone says the
 * re-render came from the card's own machinery; a drop on both says it is the
 * shell's.
 *
 * Every number is printed with the moment it was taken, because a count of
 * zero read too early and a count of zero that means "the colour is gone" are
 * the same reading (qa/README.md).
 *
 * **Nothing is spent and nothing is written.** Both conversations already
 * exist in the data directory; this script opens them and reads. No
 * generation, no key, no chat is created.
 *
 * Usage:  node qa/quote-stability.mjs
 *   IRIS_PORT         host port (default 8798)
 *   CDP_PORT          debug port (default 9352 + pid%100, qa/cdp-port.mjs)
 *   IRIS_DATA_SOURCE  the data dir to copy (default the main checkout's)
 *   QUOTE_TAG         a label for the result file (default `run`)
 *
 * Results land in `qa/results/quote-stability/`.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'

// 8798: the next free one after quote-colour-acceptance's 8797.
const PORT = Number(process.env.IRIS_PORT ?? 8798)
const BASE = `http://127.0.0.1:${String(PORT)}`
const CHROME = process.env.IRIS_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const DEBUG_PORT = cdpPort(9352)
const TAG = process.env.QUOTE_TAG ?? 'run'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const DATA_SOURCE = process.env.IRIS_DATA_SOURCE
  ?? join(repoRoot, '..', 'iris_cordis_traven', 'apps', 'iris', 'data')

/** The conversations, by the title their row carries. Both must already exist. */
const SUBJECT = process.env.QUOTE_SUBJECT ?? '黑兽'
const CONTROL = process.env.QUOTE_CONTROL ?? 'Assistant'

const out = fileURLToPath(new URL('./results/quote-stability/', import.meta.url))
mkdirSync(out, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = message => { console.error(`FAIL: ${message}`); process.exit(1) }

/*
 * The port has to be free BEFORE the host starts, and this is the only moment
 * the question can be answered honestly: after boot, a listening port proves
 * nothing about whose listener it is, and every RPC would succeed against a
 * stranger's profile (qa/README.md, the 2026-09-06 incident).
 */
{
  const reachable = await fetch(`${BASE}/iris/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(() => true).catch(() => false)
  if (reachable) fail(`something already answers on ${BASE} — pick another IRIS_PORT`)
}

const data = dataCopy('iris-quote-stability-qa-')
const dataDir = data.dir
await cp(DATA_SOURCE, dataDir, { recursive: true }).catch(error => {
  console.error(`FAIL: no data dir to copy from (${DATA_SOURCE}): ${String(error)}`)
  process.exit(2)
})
// One host per data dir since #72; the copy carries the lock of the checkout it
// was copied from, and that lock belongs to nobody here.
try { rmSync(join(dataDir, 'host.lock'), { force: true }) } catch { /* not there */ }
try { rmSync(join(dataDir, 'default-user', 'host.lock'), { force: true }) } catch { /* not there */ }

const host = data.adopt(spawn(process.execPath, ['apps/iris/bin.ts'], {
  cwd: repoRoot,
  env: { ...process.env, IRIS_PORT: String(PORT), IRIS_DATA_DIR: dataDir },
  stdio: 'inherit',
}))
console.log(`host PID ${String(host.pid)} on ${BASE}, data ${dataDir}`)

let seq = 0
async function rpc(method, params = {}) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `stab-${++seq}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  return res.json()
}
async function call(method, params = {}) {
  const frame = await rpc(method, params)
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const result = { tag: TAG, at: new Date().toISOString(), base: BASE, port: PORT, readings: [] }

try {
  for (let i = 0; ; i++) {
    if (await rpc('character.list', {}).then(f => f.ok).catch(() => false)) break
    if (i > 120) fail('the host never answered')
    await sleep(250)
  }

  /*
   * The card set, before anything else. This script writes nothing, so the
   * check is not "did my seed land" but "is this the host I started": a data
   * directory that does not hold the subject card is the wrong copy, and the
   * readings below would be about somebody else's conversations.
   */
  const seeded = await call('character.list', {})
  const names = seeded.characters.map(c => c.name)
  result.characters = names
  console.log(`character.list (${String(names.length)}): ${names.join(', ')}`)
  if (!names.some(name => name.includes(SUBJECT))) fail(`no card named ${SUBJECT} in ${DATA_SOURCE}`)

  /* ---------------------------------------------------------------- browser */

  const wsPath = new URL('../node_modules/.pnpm/ws@8.21.3/node_modules/ws/index.js', import.meta.url).href
  const WebSocket = (await import(wsPath)).default ?? (await import(wsPath))

  const profile = chromeProfile('iris-quote-stability-chrome-')
  profile.adopt(spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${String(DEBUG_PORT)}`,
    `--user-data-dir=${profile.dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,1000',
    'about:blank',
  ], { stdio: 'ignore' }))

  let version = null
  for (let i = 0; i < 60 && version === null; i++) {
    await sleep(250)
    try { version = await (await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/version`)).json() } catch { /* not up */ }
  }
  if (version === null) fail('chrome debugger never came up')

  const browser = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => { browser.on('open', res); browser.on('error', rej) })
  let wire = 0
  const pending = new Map()
  browser.on('message', raw => {
    const msg = JSON.parse(raw)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  })
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++wire
    pending.set(id, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
    browser.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const cdp = (method, params) => send(method, params, sessionId)
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  const metrics = (width, height) =>
    cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await metrics(1440, 1000)

  async function evaluate(expression) {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails !== undefined) throw new Error(`page eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`)
    return r.result.value
  }
  async function shot(name) {
    const { data: png } = await cdp('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(out, name), Buffer.from(png, 'base64'))
    console.log(`shot: ${name}`)
  }

  /**
   * The reading. One number, plus the colour that makes it worth reading, plus
   * enough of the surroundings to tell "the colour went" from "the prose went".
   */
  const READ = `(() => {
    const rows = [...document.querySelectorAll('.iris-msg__text')]
    const marks = [...document.querySelectorAll('.iris-msg__text q')]
    const first = marks[0] ?? null
    return {
      quotes: marks.length,
      rows: rows.length,
      chars: rows.reduce((sum, row) => sum + (row.textContent ?? '').length, 0),
      colour: first === null ? null : getComputedStyle(first).color,
      proseColour: rows.length === 0 ? null : getComputedStyle(rows[0]).color,
      token: getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeQuoteColor').trim(),
      theme: document.documentElement.getAttribute('data-iris-theme'),
      slots: document.querySelectorAll('.iris-interfaces__slot').length,
      iframes: document.querySelectorAll('.iris-msg__text iframe').length,
      aside: document.querySelector('.iris-aside')?.getAttribute('data-iris-aside') ?? null,
      width: window.innerWidth,
    }
  })()`

  /** Read, print and keep one measurement, with the moment it was taken. */
  const readingsFor = {}
  async function read(chat, what, sinceOpenMs) {
    const value = await evaluate(READ)
    const row = { chat, what, sinceOpenMs, ...value, observedAt: new Date().toISOString() }
    result.readings.push(row)
    ;(readingsFor[chat] ??= []).push(row)
    console.log(`  READ  ${chat} @${what}: q=${String(value.quotes)} rows=${String(value.rows)} chars=${String(value.chars)} colour=${String(value.colour)} prose=${String(value.proseColour)} slots=${String(value.slots)} aside=${String(value.aside)} width=${String(value.width)}`)
    return row
  }

  /** Open the conversation whose row text contains `name`; returns the click moment. */
  async function openChat(name) {
    await cdp('Page.navigate', { url: `${BASE}/` })
    for (let i = 0; i < 80; i++) {
      await sleep(250)
      if (await evaluate(`!!document.querySelector('.iris-list')`).catch(() => false)) break
    }
    // The reading tab by its stable `data-tab`, never by its words: a headless
    // Chrome inherits the machine's locale and the shell comes up in Chinese.
    await evaluate(`(() => {
      const tab = document.querySelector('.iris-tab[data-tab="chats"]')
      if (tab !== null && tab.getAttribute('aria-selected') !== 'true') tab.click()
    })()`)
    await sleep(600)
    const clicked = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.iris-list .iris-row')]
      const hits = rows.filter(r => (r.textContent ?? '').includes(${JSON.stringify(name)}))
      if (hits.length === 0) return { rows: rows.map(r => (r.textContent ?? '').trim().slice(0, 40)) }
      // A title is user data and the only honest handle for a conversation —
      // but only while it is unique. Two rows carrying the same words means the
      // next line would click whichever one happened to sort first.
      if (hits.length > 1) return { ambiguous: hits.map(r => (r.textContent ?? '').trim().slice(0, 40)) }
      hits[0].click()
      return true
    })()`)
    if (clicked !== true) fail(`cannot open ${name}: ${JSON.stringify(clicked)}`)
    const openedAt = Date.now()
    // The consent gate, when the card carries scripts: "run them" is the first
    // button of `.iris-grant__actions`. Clicked at once so the scripted card
    // behaves as it does for a reader who has said yes.
    for (let i = 0; i < 20; i++) {
      const asked = await evaluate(`(() => {
        const ask = document.querySelector('.iris-grant__actions button')
        if (ask !== null) ask.click()
        return ask !== null
      })()`)
      if (asked) break
      await sleep(100)
    }
    return openedAt
  }

  /**
   * One conversation, read at 2 s / 10 s / 30 s and after a re-render.
   *
   * The re-render is done twice over, by two different means, because they
   * reach the row differently: collapsing the state panel is a React commit in
   * the shell, and resizing is a layout change the reading surface answers to.
   * Neither touches the message's own text, role or swipe index — which is
   * what makes a dropped count a defect rather than a re-run.
   */
  async function measure(name) {
    console.log(`\n--- ${name} ---`)
    const openedAt = await openChat(name)
    for (const at of [2000, 10_000, 30_000]) {
      const wait = openedAt + at - Date.now()
      if (wait > 0) await sleep(wait)
      await read(name, `${String(at / 1000)}s`, Date.now() - openedAt)
    }
    await shot(`${TAG}-${name}-30s.png`)

    // Re-render 1: the state panel's own toggle, collapsed and re-expanded.
    const toggled = await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      const bar = document.querySelector('.iris-aside__bar')
      if (bar === null) return { error: 'no .iris-aside__bar on the page' }
      const before = document.querySelector('.iris-aside')?.getAttribute('data-iris-aside') ?? null
      bar.click(); await sleep(600)
      const middle = document.querySelector('.iris-aside')?.getAttribute('data-iris-aside') ?? null
      bar.click(); await sleep(600)
      const after = document.querySelector('.iris-aside')?.getAttribute('data-iris-aside') ?? null
      return { before, middle, after }
    })()`)
    console.log(`  state panel toggled: ${JSON.stringify(toggled)}`)
    result.readings.push({ chat: name, what: 'aside-toggle', detail: toggled })
    await read(name, 'after-state-panel-toggle', Date.now() - openedAt)

    // Re-render 2: the viewport, narrowed and put back.
    await metrics(1100, 900)
    await sleep(1200)
    await metrics(1440, 1000)
    await sleep(1200)
    await read(name, 'after-resize', Date.now() - openedAt)

    /*
     * Re-render 3, and the only one of the three that is **proved**.
     *
     * The first two change what the shell shows, and neither can demonstrate
     * that the message row itself was committed again: React writes nothing to
     * the DOM when a re-render produces the same output, so "the row
     * re-rendered and the colour survived" and "the row never re-rendered" are
     * the same reading. The prompt breakdown is different: it is `ChatPane`'s
     * own `explaining` state (`ChatPane.tsx` `onPreviewPrompt`), and `Message`
     * is neither memoised nor keyed on it — so opening the panel commits the
     * whole pane, every row included, while the rows' own inputs (text, role,
     * body tag, quote scope, swipe index) do not move. The panel appearing in
     * the DOM is the evidence that the commit happened.
     *
     * `prompt.itemize` assembles the request on the host and sends nothing to
     * any provider, so this costs no tokens.
     */
    const explained = await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      const disc = document.querySelector('.iris-composer__disc--quiet')
      if (disc === null) return { error: 'no composer disc on the page' }
      disc.click(); await sleep(400)
      const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]
      if (items.length === 0) return { error: 'the composer menu did not open' }
      // The prompt breakdown is the menu's first item (ComposerMenu's order),
      // located by position because its words are translated.
      items[0].click()
      for (let at = 0; at < 40; at += 1) {
        await sleep(250)
        if (document.querySelector('.iris-prompt-dialog') !== null) {
          return { opened: true, waitedMs: at * 250, label: (items[0].textContent ?? '').trim() }
        }
      }
      return { error: 'the prompt panel never opened', label: (items[0].textContent ?? '').trim() }
    })()`)
    console.log(`  prompt panel: ${JSON.stringify(explained)}`)
    result.readings.push({ chat: name, what: 'prompt-panel', detail: explained })
    if (explained.opened !== true) fail(`the proved re-render did not happen for ${name}: ${JSON.stringify(explained)}`)
    const duringPanel = await read(name, 'during-prompt-panel', Date.now() - openedAt)
    // Closed again, and read once more: the close is a second commit of the
    // same pane, and it is the one that would land after the panel's own
    // effects have run.
    const closed = await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      const dialog = document.querySelector('.iris-prompt-dialog')
      if (dialog === null) return { error: 'the panel was already gone' }
      const close = dialog.querySelector('button')
      if (close !== null) close.click()
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(800)
      return { closed: document.querySelector('.iris-prompt-dialog') === null }
    })()`)
    console.log(`  prompt panel closed: ${JSON.stringify(closed)}`)
    await read(name, 'after-prompt-panel', Date.now() - openedAt)
    await shot(`${TAG}-${name}-after-rerender.png`)
    return duringPanel
  }

  await measure(SUBJECT)
  await measure(CONTROL)

  /*
   * The verdict is a comparison, so it is computed here rather than left to a
   * reader of five numbers: the settled count is the 30 s one, and a re-render
   * that ends below it is the defect this script exists to find.
   */
  result.verdict = {}
  for (const chat of [SUBJECT, CONTROL]) {
    const rows = (readingsFor[chat] ?? []).filter(row => typeof row.quotes === 'number')
    const settled = rows.find(row => row.what === '30s')?.quotes ?? null
    const lowest = Math.min(...rows.filter(row => row.what.startsWith('after')).map(row => row.quotes))
    result.verdict[chat] = {
      at2s: rows.find(row => row.what === '2s')?.quotes ?? null,
      at10s: rows.find(row => row.what === '10s')?.quotes ?? null,
      at30s: settled,
      afterStatePanel: rows.find(row => row.what === 'after-state-panel-toggle')?.quotes ?? null,
      afterResize: rows.find(row => row.what === 'after-resize')?.quotes ?? null,
      duringPromptPanel: rows.find(row => row.what === 'during-prompt-panel')?.quotes ?? null,
      afterPromptPanel: rows.find(row => row.what === 'after-prompt-panel')?.quotes ?? null,
      colour: rows[rows.length - 1]?.colour ?? null,
      proseColour: rows[rows.length - 1]?.proseColour ?? null,
      dropped: settled !== null && lowest < settled,
    }
    console.log(`\nVERDICT ${chat}: ${JSON.stringify(result.verdict[chat])}`)
  }

  result.ok = true
} catch (error) {
  result.ok = false
  result.error = String(error?.stack ?? error)
  console.error(result.error)
} finally {
  writeFileSync(join(out, `${TAG}.json`), JSON.stringify(result, null, 2), 'utf8')
  console.log(`result written to qa/results/quote-stability/${TAG}.json`)
}

process.exit(result.ok === true ? 0 : 1)
