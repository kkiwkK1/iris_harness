/**
 * PR-D acceptance for sandbox plugins: the read-only source view, the empty
 * state, and the plugin row on the usage page.
 *
 * Runs `docs/SANDBOX-PLUGINS.md` §15 PR-D against a real host and a real
 * production bundle. Hard failures: a `console.error` followed by more output is
 * indistinguishable, in the report, from "this box was fine" (`qa/README.md`).
 *
 * ## The instrument, and what it skips
 *
 * **Nothing is spent.** PR-B's `sandboxPlugin.define` pays for a completion each
 * time and there is no seam that makes a record without one, so this script
 * **writes the sidecar itself** — `<profile>/sandbox-plugins/<chatId>.json`, the
 * shape `§10.1` fixes — into the *copy* of the data directory it started the
 * host on. The host reads that file on every `sandboxPlugin.list`, so everything
 * downstream of it is the product: the projection that drops `code`, the mount
 * list, the frame that mounts, the panel that draws the row, and
 * `sandboxPlugin.source` reading the bytes back off disk.
 *
 * What it skips is the model request and the confirmation card, which are PR-B's
 * and are covered by `qa/sandbox-plugins-pr-b.mjs`. A seeded record is written
 * **already authorised**, because the card is not what is being measured here.
 *
 * The seeded plugin carries **two versions with different bytes**, which is what
 * makes item 2 a judgement rather than a coincidence: a source view that ignored
 * the version and answered the first row would agree with the right one on a
 * one-version record.
 *
 * ## The one box that reads a file the product wrote
 *
 * The usage row needs a `source: 'plugin'` side-usage record, and the only
 * product path that writes one is a paid 「create」. So item 5 splices one into a
 * chat's own header line (`iris_side_usage`, `side-usage.ts`) on a conversation
 * this script **never opens in the browser** — an open chat is loaded in the
 * host and would be rewritten from memory. `usage.summary` scans files, so the
 * reading is the host's own arithmetic over a record of the shape it writes. If
 * the splice does not survive, the box says so by name rather than passing: the
 * same property is pinned deterministically by `usage-summary.test.ts` and
 * `sandbox-plugin-panel.test.ts`.
 *
 * ## Observation windows
 *
 * Every count below is read at a named moment and the moment is printed. The
 * panel's rows arrive on a round trip (`sandboxPlugin.list` after the chat
 * opens) and the source view arrives on a second one, so a zero read too early
 * and a zero that means "nothing is there" are the same reading — which is why
 * the source block is polled to a deadline rather than read once.
 *
 * Usage: node qa/sandbox-plugins-pr-d.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'
import { answerConsentExpr, clickTabExpr } from './locators.mjs'

// Host ports go from 8791 up, one per script (qa/README.md): PR-A 8791,
// `rpc.mjs` 8792, PR-B 8793, PR-C 8794 — so this is 8795.
const PORT = Number(process.env.IRIS_PORT ?? 8795)
const BASE = `http://127.0.0.1:${String(PORT)}`
// CDP from 9333 up, all distinct; PR-C took 9347. The pid offset is `cdpPort`'s.
const CDP = String(cdpPort(9348))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** The card this runs on. Any card will do: nothing here needs a card interface. */
const CARD = process.env.IRIS_CARD ?? '爱衣'

const outDir = new URL('./results/sandbox-plugins-pr-d/', import.meta.url)
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

/** The two versions the seeded plugin carries. Different bytes on purpose. */
const V1_CODE = "return { apply() { iris.styles.insert('body { outline: 1px solid rgb(1, 2, 3) }') } }"
const V2_CODE = "return {\n  apply() { iris.styles.insert('body { background: rgb(16, 20, 24) }') },\n}"
/** `hashOfPluginCode`'s rule, restated here because `qa/` imports no app source. */
const hashOf = code => createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 12)

/*
 * The port must be free **before** the host starts, and never re-checked after.
 *
 * A collision does not make the requests fail; it makes them succeed against
 * somebody else's host (qa/README.md, the 2026-09-06 incident). The only honest
 * evidence the host came up is its own output carrying no `EADDRINUSE`.
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
 * data dir has one host and there is no bypass.
 */
const data = dataCopy('iris-sandbox-pr-d-qa-')
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
const profileDir = join(dataDir, 'default-user')

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
    body: JSON.stringify({ id: `qa-pr-d-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}
/** The same call, answering the refusal instead of throwing it. */
const rpcRefusal = async (method, params = {}) =>
  rpc(method, params).then(() => ({ refused: false }), error => ({ refused: true, why: String(error.message) }))

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
   * The card set, read before anything is written. Cards this script did not
   * expect mean the host being talked to is not the one started above, and every
   * write below would land in somebody else's profile (qa/README.md).
   */
  const cards = await rpc('character.list')
  const ids = (cards.characters ?? []).map(one => one.characterId)
  record('character.list before any write', ids)
  const characterId = ids.find(id => id === CARD) ?? ids.find(id => id.includes(CARD))
  if (characterId === undefined) {
    console.error(`FAIL  no card named ${CARD} in this data dir; set IRIS_CARD`)
    process.exit(2)
  }

  /*
   * **Renamed, and that is not cosmetic.** `chat.create` names a conversation
   * after its card, so a data directory that already holds conversations with
   * this card has several rows reading the same words — measured here: six. The
   * row locator is by title because a title is user data and the only honest
   * handle (`qa/locators.mjs`), so without a unique one the script clicks
   * somebody else's conversation and then reports an empty panel as a defect.
   * Renaming does not move `chatId` (§10.3 rename), so the sidecar seeded below
   * is unaffected — which is itself worth one reading.
   */
  const stamp = String(Date.now()).slice(-6)
  const made = []
  for (const role of ['grown', 'bare', 'billed']) {
    const created = await rpc('chat.create', { characterId })
    const chatId = created.view?.chatId ?? created.chatId
    if (chatId === undefined) throw new Error('the host did not name the chat it created')
    const title = `qa-pr-d-${role}-${stamp}`
    await rpc('chat.rename', { chatId, title })
    made.push({ role, chatId, title })
  }
  const [grownRow, bareRow, billedRow] = made
  const grownId = grownRow.chatId
  const grownTitle = grownRow.title
  const bareId = bareRow.chatId
  const bareTitle = bareRow.title
  const billedId = billedRow.chatId
  record('conversations created and given unique titles', made)

  // ---- seed: one plugin, two versions, already authorised -----------------
  const V2_HASH = hashOf(V2_CODE)
  const V1_HASH = hashOf(V1_CODE)
  const authored = { connectionId: 'qa-seed', model: 'qa-seed-model', at: Date.now() }
  const sidecar = {
    version: 1,
    chatId: grownId,
    characterId,
    plugins: [{
      id: '1-dark-status',
      versions: [
        {
          version: 1,
          name: 'QA 轮廓线',
          purpose: '给帧画一条轮廓线，只为让第一版与第二版的字节不同。',
          declares: [{ kind: 'style' }],
          code: V1_CODE,
          bytes: Buffer.byteLength(V1_CODE, 'utf8'),
          hash: V1_HASH,
          prompt: '画一条轮廓线',
          authored,
        },
        {
          version: 2,
          name: '深色状态栏',
          purpose: '把这张卡的底色改成深色。',
          declares: [{ kind: 'style' }],
          code: V2_CODE,
          bytes: Buffer.byteLength(V2_CODE, 'utf8'),
          hash: V2_HASH,
          prompt: '把状态栏改成深色',
          authored,
        },
      ],
      enabled: true,
      trustFutureVersions: false,
      authorizedHashes: [V1_HASH, V2_HASH],
    }],
  }
  await mkdir(join(profileDir, 'sandbox-plugins'), { recursive: true })
  await writeFile(join(profileDir, 'sandbox-plugins', `${grownId}.json`), JSON.stringify(sidecar), 'utf8')
  record('sidecar seeded', { file: `${grownId}.json`, versions: 2, v1Hash: V1_HASH, v2Hash: V2_HASH })

  // ---- item 1: the host answers the source, by version, and refuses the rest
  const current = await rpc('sandboxPlugin.source', { chatId: grownId, pluginId: '1-dark-status' })
  const earlier = await rpc('sandboxPlugin.source', { chatId: grownId, pluginId: '1-dark-status', version: 1 })
  record('sandboxPlugin.source, no version asked for', { version: current.version, hash: current.hash, bytes: current.code.length })
  record('sandboxPlugin.source, version 1', { version: earlier.version, hash: earlier.hash, bytes: earlier.code.length })
  check(
    'item 1 — the current version answers the stored bytes and their hash',
    current.code === V2_CODE && current.hash === V2_HASH && current.version === 2,
    `v${String(current.version)} hash ${current.hash}, bytes ${current.code === V2_CODE ? 'identical' : 'DIFFERENT'}`,
  )
  check(
    'item 1 — a kept earlier version answers its own bytes, not the current ones',
    earlier.code === V1_CODE && earlier.hash === V1_HASH && earlier.code !== current.code,
    `v${String(earlier.version)} hash ${earlier.hash}`,
  )
  const noVersion = await rpcRefusal('sandboxPlugin.source', { chatId: grownId, pluginId: '1-dark-status', version: 7 })
  const noPlugin = await rpcRefusal('sandboxPlugin.source', { chatId: grownId, pluginId: 'no-such-plugin' })
  const otherChat = await rpcRefusal('sandboxPlugin.source', { chatId: bareId, pluginId: '1-dark-status' })
  record('refusals', { noVersion, noPlugin, otherChat })
  check('item 1 — a version that is not kept is refused by name', noVersion.refused && noVersion.why.includes('version 7'))
  check('item 1 — a plugin this conversation does not have is refused by name', noPlugin.refused)
  check(
    'item 1 — another conversation cannot read this one’s plugin',
    otherChat.refused,
    'the id is real and the conversation exists; only the ownership is wrong',
  )
  // And the list still never carries source, which is what makes the call above
  // worth having at all.
  const listed = await rpc('sandboxPlugin.list', { chatId: grownId })
  record('sandboxPlugin.list', {
    rows: (listed.plugins ?? []).length,
    mounts: (listed.mounts ?? []).length,
    anyCodeOnARow: JSON.stringify(listed.plugins ?? []).includes('iris.styles'),
  })
  check(
    'item 1 — the list answers rows without source, and a mount list with it',
    (listed.plugins ?? []).length === 1
      && !JSON.stringify(listed.plugins ?? []).includes('iris.styles')
      && (listed.mounts ?? []).length === 1,
  )

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
  const pageSession = (await raw('Target.attachToTarget', { targetId, flatten: true })).result.sessionId
  const send = (method, params = {}, sessionId = pageSession) => raw(method, params, sessionId)
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails !== undefined) {
      throw new Error(`evaluate: ${JSON.stringify(r.result.exceptionDetails)}`)
    }
    return r.result?.result?.value
  }
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(new URL(`${name}.png`, outDir), Buffer.from(r.result.data, 'base64'))
  }
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
   * Open a chat through the product's own UI.
   *
   * The chats tab by `data-tab` (chrome, translated, never located by text); the
   * row by its title, which is user data and the only honest handle. Both rules
   * are `qa/locators.mjs`'s.
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
      // More than one row under this title would mean the rename below did not
      // take, and the click would be landing on somebody else's conversation.
      if (rows.length > 1) return { error: 'ambiguous title', matched: rows.length }
      rows[0].click()
      return { clicked: rows.length }
    })()`)
    await delay(1500)
    const consent = await evaluate(answerConsentExpr)
    return { tabbed, opened, consent }
  }

  /** What the panel says right now, located by identity rather than by wording. */
  const panelState = async () => evaluate(`(() => {
    const panel = document.querySelector('[data-panel="sandbox-plugins"]')
    if (panel === null) return { present: false }
    const pre = panel.querySelector('[data-plugin-code]')
    return {
      present: true,
      rows: [...panel.querySelectorAll('[data-plugin-id]')].map(row => ({
        id: row.getAttribute('data-plugin-id'),
        name: (row.querySelector('.iris-conn__name')?.textContent ?? '').trim(),
        meta: (row.querySelector('.iris-conn__meta')?.textContent ?? '').trim(),
      })),
      notes: [...panel.querySelectorAll('p')].map(p => (p.textContent ?? '').trim()),
      code: pre === null ? null : pre.textContent,
      head: pre === null ? null : (pre.previousElementSibling?.textContent ?? ''),
      foot: pre === null ? null : (pre.nextElementSibling?.textContent ?? ''),
      editable: panel.querySelectorAll('textarea, input, [contenteditable]').length,
    }
  })()`)

  /**
   * Poll until the panel answers what the caller is waiting for.
   *
   * The rows and the source both arrive on a round trip, so "not yet" and "not
   * there" are the same single reading. The deadline is printed with whatever
   * came back, so a failure says how long it was looked at.
   * @param done - given the panel state, whether this is the answer.
   * @param waitMs - how long to keep looking.
   * @returns the last state read, and how long it took.
   */
  const panelUntil = async (done, waitMs = 15_000) => {
    const started = Date.now()
    let state
    do {
      await delay(500)
      state = await panelState()
    } while (!done(state) && Date.now() - started < waitMs)
    return { state, tookMs: Date.now() - started, window: `polled to ${String(waitMs)}ms` }
  }

  await nav(`${BASE}/`)
  record('opening the grown conversation', await openChat(grownTitle))

  // ---- item 2: the panel row, and 「see the code」 -------------------------
  const rowed = await panelUntil(one => (one.rows ?? []).length > 0)
  record('panel rows after the conversation opened', rowed)
  await shot('1-panel-row')
  check(
    'item 2 — the panel carries a row for the seeded plugin',
    (rowed.state.rows ?? []).some(row => row.id === '1-dark-status'),
    `${rowed.window}; took ${String(rowed.tookMs)}ms`,
  )
  check(
    'item 2 — the row shows the current version, not the first',
    (rowed.state.rows ?? []).some(row => row.name === '深色状态栏' && row.meta.includes('v2')),
    JSON.stringify(rowed.state.rows ?? []),
  )

  const clicked = await evaluate(`(() => {
    const button = document.querySelector('[data-panel="sandbox-plugins"] [data-plugin-action="source"]')
    if (button === null) return { error: 'no source control on the row' }
    button.click()
    return { clicked: true, label: (button.textContent ?? '').trim() }
  })()`)
  record('「see the code」 pressed', clicked)
  const opened = await panelUntil(one => one.code !== null && one.code !== '')
  record('the source block', {
    tookMs: opened.tookMs,
    head: opened.state.head,
    chars: (opened.state.code ?? '').length,
    editableElements: opened.state.editable,
  })
  await shot('2-source-open')
  check(
    'item 2 — the block holds the bytes that were mounted, exactly',
    opened.state.code === V2_CODE,
    `${String((opened.state.code ?? '').length)} chars vs ${String(V2_CODE.length)} stored; ${opened.window}`,
  )
  check(
    'item 2 — the head names the version and the hash the authorisation is recorded under',
    (opened.state.head ?? '').includes(V2_HASH) && /2/.test(opened.state.head ?? ''),
    opened.state.head ?? '(no head)',
  )
  check(
    'item 2 — the view is read-only: no edit control anywhere in the panel',
    opened.state.editable === 0,
    `${String(opened.state.editable)} textarea/input/contenteditable elements`,
  )
  check(
    'item 2 — and it says what to do instead of editing',
    (opened.state.foot ?? '').length > 0,
    opened.state.foot ?? '(no note)',
  )

  // ---- item 3: the empty state, both columns ------------------------------
  record('opening the conversation that grew nothing', await openChat(bareTitle))
  const emptyEn = await panelUntil(one => (one.notes ?? []).length > 0)
  record('empty-state notes (as this Chrome came up)', emptyEn.state.notes)
  await shot('3-empty-state')
  check(
    'item 3 — an empty conversation says a sentence rather than showing a blank panel',
    (emptyEn.state.notes ?? []).length > 0 && (emptyEn.state.rows ?? []).length === 0,
    `${emptyEn.window}; took ${String(emptyEn.tookMs)}ms`,
  )

  const authoringSet = (await rpc('connection.list').catch(() => ({}))).authoring !== undefined
  record('an authoring connection is configured in this data dir', authoringSet)
  check(
    'item 3 — with no authoring model the panel says so first, and points at the row that fixes it',
    authoringSet || ((emptyEn.state.notes ?? []).length === 2
      && /写插件用|Writes plugins/.test(emptyEn.state.notes[0] ?? '')),
    authoringSet
      ? 'this data dir has one configured, so only the entry sentence is expected'
      : JSON.stringify(emptyEn.state.notes ?? []),
  )

  for (const language of ['zh', 'en']) {
    await evaluate(`localStorage.setItem('iris.language', ${JSON.stringify(language)})`)
    await nav(`${BASE}/`)
    await openChat(bareTitle)
    const said = await panelUntil(one => (one.notes ?? []).length > 0)
    record(`empty-state notes in ${language}`, said.state.notes)
    await shot(`4-empty-state-${language}`)
    const wanted = language === 'zh' ? /「创造」/ : /Grow a feature/
    check(
      `item 3 — the empty state reads in ${language}`,
      (said.state.notes ?? []).some(note => wanted.test(note)),
      `${said.window}; ${JSON.stringify(said.state.notes ?? [])}`,
    )
  }

  // ---- item 4: the usage row ---------------------------------------------
  /*
   * A `source: 'plugin'` record spliced onto a conversation's own header, which
   * is where `side-usage.ts` writes one. The conversation is never opened in the
   * browser, because an open chat is loaded in the host and gets written back
   * from memory.
   */
  const chatFile = join(profileDir, 'chats', `${billedId}.jsonl`)
  const before = await readFile(chatFile, 'utf8').catch(() => '')
  const lines = before.split('\n')
  let spliced = false
  if (lines[0] !== undefined && lines[0].trim() !== '') {
    const header = JSON.parse(lines[0])
    header.iris_side_usage = [{
      inputTokens: 8_300,
      outputTokens: 640,
      model: 'qa-seed-model',
      provider: 'qa-seed',
      at: Date.now(),
      source: 'plugin',
      caller: 'sandboxPlugin.define',
    }]
    lines[0] = JSON.stringify(header)
    await writeFile(chatFile, lines.join('\n'), 'utf8')
    spliced = true
  }
  record('a plugin-writing usage record spliced onto a conversation nobody opened', { chatFile, spliced })

  const summary = spliced ? (await rpc('usage.summary', {})).summary : undefined
  record('usage.summary totals.plugin', summary?.totals?.plugin ?? null)
  record('usage.summary totals.turns', summary?.totals?.turns ?? null)
  if (!spliced) {
    console.log(
      '  NOTE  item 4 could not be driven: there was no chat file to splice a side-usage record onto, '
      + 'and the only product path that writes one is a paid 「create」. The same property is pinned '
      + 'deterministically by packages/iris-app-service/tests/usage-summary.test.ts and '
      + 'apps/iris-web/tests/sandbox-plugin-panel.test.ts.',
    )
    check('item 4 — the usage page shows the plugin share', false, 'not driven; see the note above')
  } else {
    check(
      'item 4 — the host reports the plugin-writing spend as its own share',
      summary?.totals?.plugin?.turns === 1 && summary.totals.plugin.cacheMiss === 8_300,
      JSON.stringify(summary?.totals?.plugin ?? null),
    )
    check(
      'item 4 — and it is inside the whole, not beside it',
      (summary?.totals?.cacheMiss ?? 0) >= 8_300,
      `whole cacheMiss ${String(summary?.totals?.cacheMiss ?? 0)} against the share's 8300`,
    )

    // And on the page: the settings drawer's usage card opens the report.
    await evaluate("localStorage.setItem('iris.language', 'zh')")
    await nav(`${BASE}/`)
    const usageOpened = await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      document.querySelector('[data-control="settings"]')?.click()
      await sleep(900)
      const buttons = [...document.querySelectorAll('button')]
      const open = buttons.find(b => (b.textContent ?? '').includes('用量'))
      if (open === undefined) return { error: 'no usage control in the drawer', seen: buttons.length }
      open.click()
      await sleep(2500)
      return { opened: true }
    })()`)
    record('opening the usage page', usageOpened)
    const usageText = await evaluate(
      "(document.querySelector('.iris-usage') ?? document.body).textContent ?? ''",
    )
    await shot('5-usage-page')
    record('usage page mentions the plugin share', /其中写插件请求/.test(usageText))
    check(
      'item 4 — the usage page draws the plugin sentence under the total',
      /其中写插件请求/.test(usageText),
      'read once, ~2.5s after the report opened; see the screenshot beside this run',
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
