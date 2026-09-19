/**
 * Quoted-dialogue colour acceptance, against a real host and a real browser.
 *
 * What it reads, in one run:
 *
 * 1. **The colour.** A TEXT-ONLY card whose greeting carries both `"…"` and
 *    `“…”` dialogue, a code span with quotes in it, and a quote that spans
 *    emphasis. The reading is `getComputedStyle(q).color` against the colour
 *    of the paragraph around it — a `<q>` that matched the prose would be the
 *    whole feature failing silently, so the comparison is the assertion.
 * 2. **The browser's own quote marks.** `::before` / `::after` content on the
 *    same element: upstream blanks them (`[ST] style.css:1208-1211`) because
 *    the marks a reader should see are inside the element.
 * 3. **The other theme.** The stored choice is the product's own reload path
 *    (`theme.ts` `loadThemeChoice`); the script writes it, reloads, confirms
 *    `data-iris-theme` moved, and reads the colour again.
 * 4. **The frame floor is untouched.** A FRAME-FENCED greeting (灭仇家满门,
 *    `2.1.0.png` in the corpus — its `first_mes` carries the document) is
 *    opened and its claimed slots and live iframes counted. Run this script on
 *    the build before the change and on the build after: the two numbers are
 *    the before/after the ruling asks for.
 *
 * No generation happens: every reading is a greeting, so no model is called
 * and no key is needed.
 *
 * Usage:  node qa/quote-colour-acceptance.mjs
 *   IRIS_PORT  host port (default 8791)
 *   CDP_PORT   debug port (default 9351 + pid%100, see qa/cdp-port.mjs)
 *   IRIS_CORPUS  card directory (default the operator's 测试用卡)
 *   QUOTE_TAG  a label written into the result file name (e.g. `before`)
 *
 * Results and screenshots land in `qa/results/quote-colour/`.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'

// 8797: the next free one after the sandbox-plugin acceptances (8791-8796).
const PORT = Number(process.env.IRIS_PORT ?? 8797)
const BASE = `http://127.0.0.1:${String(PORT)}`
const CHROME = process.env.IRIS_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const DEBUG_PORT = cdpPort(9351)
const CORPUS = process.env.IRIS_CORPUS ?? 'D:/workspace/小项目/iris_分支/测试用卡'
const TAG = process.env.QUOTE_TAG ?? 'run'
// 灭仇家满门之后我收养了想对我复仇的孤女 — FRAME-FENCED, and its greeting alone
// carries the fenced document, so the frame floor needs no generation.
const FRAME_CARD = process.env.QUOTE_FRAME_CARD ?? '2.1.0.png'

const out = fileURLToPath(new URL('./results/quote-colour/', import.meta.url))
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

/* ------------------------------------------------------------------ seeding */

/**
 * A card whose greeting is the sample of prose this acceptance reads.
 *
 * Written here rather than taken from the corpus on purpose: the six quote
 * kinds, a code span and an emphasis-spanning quote have to all be present in
 * one floor, and no corpus greeting is guaranteed to carry them. The rule
 * being checked is upstream's, so the sample is chosen to exercise it.
 */
const PROBE = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'QuoteProbe',
    description: 'A probe card for the quoted-dialogue colour.',
    personality: '',
    scenario: '',
    first_mes: [
      '她把伞收起来，说：“今天不会再下了。”',
      '',
      'He shook his head. "It will," he said, "before dark."',
      '',
      'A quote that spans emphasis: "hello *world*" — still one run upstream.',
      '',
      'And one that must not colour: `say "hi"` is code, not dialogue.',
      '',
      '「こんにちは」と『さようなら』と «bonjour» と ＂fullwidth＂ 。',
    ].join('\n'),
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '1',
    extensions: {},
  },
})

const data = dataCopy('iris-quote-qa-')
const dataDir = data.dir
// One host per data dir since #72; the copy carries the lock of the checkout it
// was copied from, and that lock belongs to nobody here.
try { rmSync(join(dataDir, 'host.lock'), { force: true }) } catch { /* not there */ }
mkdirSync(join(dataDir, 'default-user', 'characters'), { recursive: true })
writeFileSync(join(dataDir, 'default-user', 'characters', 'quoteprobe.json'), PROBE, 'utf8')

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const host = data.adopt(spawn(process.execPath, ['apps/iris/bin.ts'], {
  cwd: repoRoot,
  env: { ...process.env, IRIS_PORT: String(PORT), IRIS_DATA_DIR: dataDir, IRIS_USER_NAME: 'Traveller' },
  stdio: 'inherit',
}))
console.log(`host PID ${String(host.pid)} on ${BASE}, data ${dataDir}`)

let seq = 0
async function rpc(method, params = {}) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `quote-${++seq}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  return res.json()
}
async function call(method, params = {}) {
  const frame = await rpc(method, params)
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const result = { tag: TAG, at: new Date().toISOString(), base: BASE, port: PORT }

try {
  for (let i = 0; ; i++) {
    if (await rpc('character.list', {}).then(f => f.ok).catch(() => false)) break
    if (i > 120) fail('the host never answered')
    await sleep(250)
  }

  /*
   * The card set, before any write. Exactly one card means this is the host
   * this script started — the discriminator qa/README.md asks for, and the one
   * that would have caught eleven chats created in a stranger's profile.
   */
  const seeded = await call('character.list', {})
  const names = seeded.characters.map(c => c.name)
  if (names.length !== 1 || names[0] !== 'QuoteProbe') {
    fail(`this host is not mine: character.list says ${JSON.stringify(names)}`)
  }

  const probeChat = (await call('chat.create', { characterId: seeded.characters[0].characterId })).view.chatId

  // The frame card, imported from the corpus for the second half.
  const content = readFileSync(join(CORPUS, FRAME_CARD)).toString('base64')
  const imported = await call('character.import', { filename: FRAME_CARD, content })
  const frameCardId = imported.character.characterId ?? imported.character.id
  const frameChat = (await call('chat.create', { characterId: frameCardId })).view.chatId
  result.cards = { probe: 'QuoteProbe', frame: imported.character.name, frameFile: FRAME_CARD }
  console.log(`seeded: probe chat ${probeChat}, frame card ${JSON.stringify(imported.character.name)} chat ${frameChat}`)

  /* ---------------------------------------------------------------- browser */

  const require = createRequire(import.meta.url)
  void require
  const wsPath = new URL('../node_modules/.pnpm/ws@8.21.3/node_modules/ws/index.js', import.meta.url).href
  const WebSocket = (await import(wsPath)).default ?? (await import(wsPath))

  const profile = chromeProfile('iris-quote-chrome-')
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })

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

  /** Open the conversation whose row text contains `name`. */
  async function openChat(name) {
    await cdp('Page.navigate', { url: `${BASE}/` })
    for (let i = 0; i < 80; i++) {
      await sleep(250)
      if (await evaluate(`!!document.querySelector('.iris-list')`).catch(() => false)) break
    }
    // The reading tab, by its stable `data-tab` rather than by its words: the
    // sidebar opens on whichever tab it last remembered, and the rows this
    // script wants are only on that one.
    await evaluate(`(() => {
      const tab = document.querySelector('.iris-tab[data-tab="chats"]')
      if (tab !== null && tab.getAttribute('aria-selected') !== 'true') tab.click()
    })()`)
    await sleep(600)
    const clicked = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.iris-list .iris-row')]
      const row = rows.find(r => (r.textContent ?? '').includes(${JSON.stringify(name)}))
      if (row === undefined) {
        return {
          rows: rows.map(r => (r.textContent ?? '').trim().slice(0, 40)),
          tabs: [...document.querySelectorAll('.iris-tab')].map(t => ({ tab: t.dataset['tab'], selected: t.getAttribute('aria-selected') })),
          empty: [...document.querySelectorAll('.iris-list__empty')].map(e => (e.textContent ?? '').trim().slice(0, 80)),
        }
      }
      row.click()
      return true
    })()`)
    if (clicked !== true) fail(`no conversation row for ${name}; ${JSON.stringify(clicked)}`)
    for (let i = 0; i < 80; i++) {
      await sleep(250)
      if (await evaluate(`!!document.querySelector('.iris-msg__text')`).catch(() => false)) break
    }
    // The consent gate, when the card carries scripts. "Run them" is the first
    // button of `.iris-grant__actions`.
    await evaluate(`(() => {
      const ask = document.querySelector('.iris-grant__actions button')
      if (ask !== null) ask.click()
      return ask !== null
    })()`)
    await sleep(2500)
  }

  /*
   * The reading itself. Every `<q>` inside a message's prose, with the colour
   * of the element and of its own parent — the pair is the judgement, because
   * "the dialogue is a different colour" is a comparison and not a value.
   */
  const READ_QUOTES = `(() => {
    const rows = [...document.querySelectorAll('.iris-msg__text')]
    const marks = []
    for (const row of rows) {
      for (const q of row.querySelectorAll('q')) {
        const parent = q.parentElement
        marks.push({
          text: (q.textContent ?? '').slice(0, 60),
          colour: getComputedStyle(q).color,
          parentColour: parent === null ? null : getComputedStyle(parent).color,
          quotesProperty: getComputedStyle(q).quotes,
          before: getComputedStyle(q, '::before').content,
          after: getComputedStyle(q, '::after').content,
          inCode: q.closest('code') !== null || q.closest('pre') !== null,
          inSlot: q.closest('.iris-interfaces__slot') !== null,
          inLeak: q.closest('.iris-bodyleak') !== null,
        })
      }
    }
    return {
      theme: document.documentElement.getAttribute('data-iris-theme'),
      quoteToken: getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeQuoteColor').trim(),
      proseColour: rows.length === 0 ? null : getComputedStyle(rows[0]).color,
      proseText: rows.map(r => (r.textContent ?? '').trim()).join(' ⏎ ').slice(0, 600),
      marks,
    }
  })()`

  const FRAME_COUNT = `(() => ({
    slots: document.querySelectorAll('.iris-interfaces__slot').length,
    iframes: document.querySelectorAll('.iris-msg__text .iris-interfaces__slot iframe').length,
    captions: [...document.querySelectorAll('.iris-interfaces__state')].map(e => (e.textContent ?? '').trim().slice(0, 120)),
    leaks: document.querySelectorAll('.iris-bodyleak').length,
    quotes: document.querySelectorAll('.iris-msg__text q').length,
  }))()`

  /*
   * `QUOTE_FRAMES_ONLY=1` reads the frame floor and nothing else. That is how
   * the "before" half of the frame count is taken: on a build without this
   * change there is no `<q>` to read, and a run that hard-fails at the first
   * colour assertion never reaches the frame card.
   */
  const framesOnly = process.env.QUOTE_FRAMES_ONLY === '1'
  result.framesOnly = framesOnly

  if (!framesOnly) {
    /* ------------------------------------------ 1-2. the colour, 雪 (default) */

    await openChat('QuoteProbe')
    const light = await evaluate(READ_QUOTES)
    await shot(`${TAG}-light.png`)
    result.light = light
    console.log(`theme ${light.theme}: ${String(light.marks.length)} <q>, prose ${light.proseColour}`)
    for (const mark of light.marks) console.log(`   ${JSON.stringify(mark.text)} ${mark.colour} (parent ${mark.parentColour}) before=${mark.before}`)

    if (light.marks.length === 0) fail('no <q> on the reading surface at all')
    if (light.marks.some(m => m.inCode)) fail('a <q> was made inside code')
    if (light.marks.some(m => m.colour === m.parentColour)) fail('a <q> reads in the same colour as the prose around it')
    if (light.marks.some(m => m.before !== 'none' && m.before !== '""' && m.before !== "''")) {
      fail(`the browser is adding its own quote marks: ${JSON.stringify(light.marks.map(m => m.before))}`)
    }
    if (!light.proseText.includes('say "hi"')) fail('the code span lost its characters')

    /* --------------------------------------------------- 3. the other theme */

    await evaluate(`localStorage.setItem('iris.theme', 'dark')`)
    await cdp('Page.navigate', { url: `${BASE}/` })
    for (let i = 0; i < 80; i++) {
      await sleep(250)
      if (await evaluate(`document.documentElement.getAttribute('data-iris-theme') === 'dark'`).catch(() => false)) break
    }
    await openChat('QuoteProbe')
    const dark = await evaluate(READ_QUOTES)
    await shot(`${TAG}-dark.png`)
    result.dark = dark
    console.log(`theme ${dark.theme}: ${String(dark.marks.length)} <q>, prose ${dark.proseColour}, quote ${dark.marks[0]?.colour}`)

    if (dark.theme !== 'dark') fail(`the theme did not switch: ${String(dark.theme)}`)
    if (dark.marks.length !== light.marks.length) fail('the theme switch changed how many runs were marked')
    if (dark.marks.some(m => m.colour === m.parentColour)) fail('a <q> reads in the prose colour on the dark theme')
    if (dark.marks[0]?.colour === light.marks[0]?.colour) fail('the quote colour did not follow the theme')

    await evaluate(`localStorage.setItem('iris.theme', 'light')`)
  }

  /* ------------------------------------------------ 4. the frame floor, unmoved */

  await openChat(imported.character.name)
  const frames = await evaluate(FRAME_COUNT)
  await shot(`${TAG}-frames.png`)
  result.frames = frames
  console.log(`frame card ${JSON.stringify(imported.character.name)}: ${JSON.stringify(frames)}`)

  result.ok = true
} catch (error) {
  result.ok = false
  result.error = String(error?.stack ?? error)
  console.error(result.error)
} finally {
  writeFileSync(join(out, `${TAG}.json`), JSON.stringify(result, null, 2), 'utf8')
  console.log(`result written to qa/results/quote-colour/${TAG}.json`)
}

process.exit(result.ok === true ? 0 : 1)
