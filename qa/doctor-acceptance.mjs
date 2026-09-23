/**
 * Acceptance for the composer's `/doctor` (owner, 2026-09-23).
 *
 * `/doctor` is typed into a real conversation on a real host, and the report
 * is read **off the rendered notice** — the thing a reader sees — not off an
 * RPC. Then three states are forced without spending a token, and the row that
 * should flip is read flipping:
 *
 * 1. **Authoring model cleared** through the product's own `connection.authoring`
 *    on the copied data dir → the 「写插件」 row goes ⚠ (it is set first when
 *    the copy had none, so the flip is measured in the direction that matters).
 * 2. **Card scripts declined** through `script.setScriptsAllowed` on the open
 *    card → the 「卡片脚本」 row goes ⚠. Skipped by name when no conversation's
 *    card has scripts.
 * 3. **Stale bundle.** The host serves a **copy** of the built dist; with the
 *    page still open, the copy's entry is renamed and `index.html` rewritten to
 *    name it — exactly what a rebuild under a running host produces — and the
 *    「页面构建」 row must go ⚠ naming both files. Then the page is reloaded and
 *    the row must be ✓ again: the negative control that proves the ⚠ was the
 *    comparison and not the row being broken.
 *
 * Also read: the notice is still on screen after the 3.2 s an information
 * notice lives (it is `lasting`), its rows are separate lines, and it is in
 * the notice log.
 *
 * **Nothing is spent.** No message is sent. The only outbound call is the
 * provider test row, which is the connection card's own test button
 * (`GET /models`).
 *
 * Hard failures: exit 1 = a check did not pass, 2 = port or data-dir trouble,
 * 3 = hard timeout. Kills only its own host and its own Chrome (both adopted by
 * `qa/chrome-profile.mjs` handles).
 *
 * Usage: node qa/doctor-acceptance.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { en, zh } from '../apps/iris-web/src/app/i18n/strings.ts'
import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy, tempDir } from './chrome-profile.mjs'
import { openDrawerExpr } from './locators.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
// CDP from 9333 up, all distinct; 9355 is the last one taken (review6).
const CDP = String(cdpPort(9356))

const outDir = new URL('./results/doctor/', import.meta.url)
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
 * The port: the first one from 8791 up that nothing is listening on, asserted
 * **before** the host starts and never re-checked (qa/README.md, 2026-09-06: a
 * collision does not make requests fail, it makes them succeed against
 * somebody else's host). `IRIS_PORT` pins it instead, and is asserted the same.
 */
const listening = (() => {
  const netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
  return new Set((netstat.stdout ?? '').split('\n')
    .filter(line => line.includes('LISTENING'))
    .map(line => /:(\d+)\s/.exec(line)?.[1])
    .filter(port => port !== undefined)
    .map(Number))
})()
let PORT = process.env.IRIS_PORT === undefined ? undefined : Number(process.env.IRIS_PORT)
if (PORT === undefined) {
  for (let candidate = 8791; candidate < 8900; candidate += 1) {
    if (!listening.has(candidate)) { PORT = candidate; break }
  }
}
if (PORT === undefined || listening.has(PORT)) {
  console.error(`FAIL  port ${String(PORT)} is already listening — refusing to start`)
  process.exit(2)
}
const BASE = `http://127.0.0.1:${String(PORT)}`

/* A copy of the product's data dir with the lock removed. */
const data = dataCopy('iris-doctor-qa-')
const dataDir = data.dir
const dataSource = process.env.IRIS_DATA_SOURCE
  ?? join(repoRoot, '..', 'iris_cordis_traven', 'apps', 'iris', 'data')
await cp(dataSource, dataDir, { recursive: true }).catch(error => {
  console.error(`FAIL  no data dir to copy from (${dataSource}): ${String(error)}`)
  process.exit(2)
})
await rm(join(dataDir, 'host.lock'), { force: true })
await rm(join(dataDir, 'default-user', 'host.lock'), { force: true })

/* A copy of the built interface, so the stale-bundle step can rebuild it
 * under the running host without touching this worktree's dist. */
const dist = tempDir('iris-doctor-dist-')
const distSource = join(repoRoot, 'apps', 'iris-web', 'dist')
await cp(distSource, dist.dir, { recursive: true }).catch(error => {
  console.error(`FAIL  no built interface to copy (${distSource}): ${String(error)} — run npm run build in apps/iris-web`)
  process.exit(2)
})
const distIndex = join(dist.dir, 'index.html')

let hostOutput = ''
const host = data.adopt(spawn(process.execPath, ['apps/iris/bin.ts'], {
  cwd: repoRoot,
  env: { ...process.env, IRIS_PORT: String(PORT), IRIS_DATA_DIR: dataDir, IRIS_WEB_DIST: distIndex },
  stdio: ['ignore', 'pipe', 'pipe'],
}))
host.stdout.on('data', chunk => { hostOutput += String(chunk) })
host.stderr.on('data', chunk => { hostOutput += String(chunk) })
console.log(`host process PID ${String(host.pid)} on port ${String(PORT)}, data dir ${dataDir}, dist ${dist.dir}`)

let seq = 0
const rpc = async (method, params = {}) => {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-doctor-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 420_000)

/** Every row label in both columns, so the parse does not depend on Chrome's locale. */
const CHECKS = ['Host', 'Bundle', 'Provider', 'ProviderTest', 'Authoring', 'Consent', 'DataDir',
  'Faults', 'Sandbox', 'Policy', 'Plugins', 'Storage', 'Corpus']
const LABEL_TO_CHECK = new Map()
for (const name of CHECKS) {
  LABEL_TO_CHECK.set(en[`doctorLabel${name}`], name)
  LABEL_TO_CHECK.set(zh[`doctorLabel${name}`], name)
}
const VERDICT = { '✓': 'ok', '⚠': 'warn', '✗': 'fail' }

/**
 * Parse the report text into rows.
 * @param {string} text - the notice's text, newlines intact.
 * @returns {{heading: string, rows: Record<string, {verdict: string, line: string}>, count: number}}
 */
function parseReport(text) {
  const [heading = '', ...lines] = text.split('\n')
  const rows = {}
  for (const line of lines) {
    const glyph = line.slice(0, 1)
    const rest = line.slice(2)
    const colon = rest.indexOf(': ')
    const label = colon === -1 ? rest : rest.slice(0, colon)
    const name = LABEL_TO_CHECK.get(label) ?? `?${label}`
    rows[name] = { verdict: VERDICT[glyph] ?? `?${glyph}`, line }
  }
  return { heading, rows, count: lines.length }
}

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

  // ---- the host, before anything is written ------------------------------
  const cards = await rpc('character.list')
  record('character.list before any write', (cards.characters ?? []).map(one => one.characterId))
  const facts = (await rpc('debug.doctor')).facts
  record('debug.doctor facts (over RPC, for comparison with the rendered rows)', {
    ...facts, dataDir: { ...facts.dataDir, path: '<copy>' },
  })
  check('debug.doctor names this host’s own pid as the lock holder', facts.dataDir.lockPid === host.pid && facts.pid === host.pid,
    `lockPid=${String(facts.dataDir.lockPid)} pid=${String(facts.pid)} spawned=${String(host.pid)}`)
  const connections = await rpc('connection.list')
  record('connection.list: in use / authoring', { activeId: connections.activeId ?? null, authoring: connections.authoring ?? null })

  // A conversation whose card has scripts, for the consent step; else any.
  const chats = (await rpc('chat.list')).chats ?? []
  let chosen
  for (const chat of chats) {
    if (chat.characterId === undefined) continue
    const scripts = await rpc('script.list', { characterId: chat.characterId }).catch(() => undefined)
    if ((scripts?.scripts?.length ?? 0) > 0) { chosen = { chat, scripts }; break }
  }
  const chat = chosen?.chat ?? chats[0]
  if (chat === undefined) {
    console.error('FAIL  this data dir has no conversation to type /doctor into')
    process.exit(2)
  }
  record('the conversation /doctor is typed into', {
    chatId: chat.chatId, characterId: chat.characterId, scripts: chosen?.scripts?.scripts?.length ?? 0,
    scriptsAllowed: chosen?.scripts?.scriptsAllowed ?? null,
  })

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
  const send = (method, params = {}) => raw(method, params, pageSession)
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails !== undefined) throw new Error(`evaluate: ${JSON.stringify(r.result.exceptionDetails)}`)
    return r.result?.result?.value
  }
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(new URL(`${name}.png`, outDir), Buffer.from(r.result.data, 'base64'))
  }
  await send('Page.enable')
  await send('Runtime.enable')

  /** Load the app, open the chosen conversation, and wait for the composer. */
  const load = async () => {
    await send('Page.navigate', { url: `${BASE}/` })
    for (let at = 0; at < 40; at += 1) {
      await delay(500)
      if (await evaluate('document.querySelector(".iris-composer__field") !== null') === true) break
    }
    const opened = await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      for (let at = 0; at < 30; at += 1) {
        const wanted = ${JSON.stringify(chat.chatId)}
        const row = [...document.querySelectorAll('[data-chat]')].find(el => el.getAttribute('data-chat') === wanted) ?? null
        if (row !== null) { row.click(); return true }
        await sleep(200)
      }
      return false
    })()`)
    await delay(1500)
    return opened
  }

  /** Clear any notice on screen, type /doctor, press Enter, and read the report notice. */
  const runDoctor = async () => {
    await evaluate(`(() => { for (const b of document.querySelectorAll('.iris-notice__dismiss')) b.click() })()`)
    await delay(300)
    const typed = await evaluate(`(() => {
      const field = document.querySelector('.iris-composer__field')
      if (field === null) return false
      field.focus()
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(field, '/doctor')
      field.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    if (!typed) throw new Error('no composer field to type into')
    await delay(200)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    const startedAt = Date.now()
    for (let at = 0; at < 60; at += 1) {
      await delay(250)
      const text = await evaluate(`(() => {
        const notice = [...document.querySelectorAll('.iris-notice')]
          .find(el => /^(Doctor|体检)/.test(el.textContent ?? ''))
        // The text nodes only: the notice also holds its ✕ button, and the raw
        // text keeps the newlines the rows are separated by.
        return notice === undefined ? null
          : [...notice.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('')
      })()`)
      if (text !== null) return { text, afterMs: Date.now() - startedAt }
    }
    throw new Error('no /doctor report appeared')
  }

  await load()
  const lang = await evaluate('document.documentElement.lang')
  record('page language', lang)
  const pageEntry = await evaluate(`[...document.querySelectorAll('script[type="module"][src]')].map(s => s.src.split('/').pop())`)
  record('page module scripts', pageEntry)

  // ---- 1. the first report -----------------------------------------------
  const first = await runDoctor()
  const report = parseReport(first.text)
  record('report 1 heading', report.heading)
  record('report 1 rows', Object.fromEntries(Object.entries(report.rows).map(([k, v]) => [k, v.line])))
  await shot('01-first-report')
  check('the report came from typing /doctor, one line per row under a count line',
    report.count >= 11 && Object.keys(report.rows).every(name => !name.startsWith('?')),
    `${String(report.count)} rows, unknown labels: ${Object.keys(report.rows).filter(n => n.startsWith('?')).join(', ') || 'none'}`)
  for (const name of ['Host', 'Bundle', 'DataDir', 'Sandbox', 'Policy']) {
    check(`row ${name} is ✓ on a healthy host`, report.rows[name]?.verdict === 'ok', report.rows[name]?.line ?? 'missing')
  }
  check('the composer field was emptied (nothing was sent as a message)',
    await evaluate(`document.querySelector('.iris-composer__field').value`) === '')
  const draftSent = await rpc('chat.open', { chatId: chat.chatId })
  record('conversation length after /doctor', draftSent.view?.messages?.length ?? null)

  // Lasting: still on screen after an information notice's lifetime.
  await delay(4000)
  const stillThere = await evaluate(`[...document.querySelectorAll('.iris-notice')].some(el => /^(Doctor|体检)/.test(el.textContent ?? ''))`)
  check('the report is still on screen 4 s later (lasting, not the 3.2 s timer)', stillThere === true)
  const lines = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.iris-notice')].find(e => /^(Doctor|体检)/.test(e.textContent ?? ''))
    return { whiteSpace: getComputedStyle(el).whiteSpace, height: el.getBoundingClientRect().height }
  })()`)
  record('report notice layout', lines)
  check('the rows render as separate lines', lines.whiteSpace === 'pre-line' && lines.height > 100, JSON.stringify(lines))

  // ---- 2. authoring cleared → ⚠ ------------------------------------------
  if (connections.authoring === undefined) {
    const target = (connections.profiles ?? [])[0]
    if (target !== undefined) {
      await rpc('connection.authoring', { id: target.id, model: target.model })
      record('set an authoring model first so the clear is a flip', { id: target.id, model: target.model })
      const set = parseReport((await runDoctor()).text)
      record('authoring row after setting', set.rows.Authoring?.line)
      check('with an authoring model set, the plugin-writing row is ✓', set.rows.Authoring?.verdict === 'ok', set.rows.Authoring?.line)
    }
  } else {
    check('the copy starts with an authoring model, and the row says ✓', report.rows.Authoring?.verdict === 'ok', report.rows.Authoring?.line)
  }
  await rpc('connection.authoring', {})
  const cleared = parseReport((await runDoctor()).text)
  record('authoring row after connection.authoring {}', cleared.rows.Authoring?.line)
  check('after clearing the authoring model, the plugin-writing row flips to ⚠ with a remedy',
    cleared.rows.Authoring?.verdict === 'warn' && /——| — /.test(cleared.rows.Authoring?.line ?? ''),
    cleared.rows.Authoring?.line)
  await shot('02-authoring-cleared')

  // ---- 3. consent declined → ⚠ -------------------------------------------
  if (chosen !== undefined) {
    check('the consent row is present for a card with scripts', report.rows.Consent !== undefined, report.rows.Consent?.line ?? 'missing')
    await rpc('script.setScriptsAllowed', { characterId: chat.characterId, allowed: false })
    const declined = parseReport((await runDoctor()).text)
    record('consent row after script.setScriptsAllowed false', declined.rows.Consent?.line)
    check('after declining the card’s scripts, the card-scripts row is ⚠', declined.rows.Consent?.verdict === 'warn', declined.rows.Consent?.line)
  } else {
    console.log('SKIP  consent flip — no conversation in this copy belongs to a card with scripts')
  }

  // ---- 4. stale bundle ----------------------------------------------------
  const html = await readFile(distIndex, 'utf8')
  const entry = /<script[^>]*type="module"[^>]*src="\.\/assets\/(index-[\w-]+\.js)"/.exec(html)?.[1]
  if (entry === undefined) throw new Error('the copied index names no module entry')
  const renamed = 'index-DOCTORQA1.js'
  // What a rebuild under a running host looks like: a new entry name in the
  // index the host serves, and the old file gone.
  await writeFile(join(dist.dir, 'assets', renamed), await readFile(join(dist.dir, 'assets', entry)))
  await writeFile(distIndex, html.replace(`./assets/${entry}`, `./assets/${renamed}`))
  await rm(join(dist.dir, 'assets', entry), { force: true })
  record('simulated rebuild', { from: entry, to: renamed })
  const stale = parseReport((await runDoctor()).text)
  record('bundle row with the page still open', stale.rows.Bundle?.line)
  check('with the host serving a new build under the open page, the page-build row is ⚠ and names both files',
    stale.rows.Bundle?.verdict === 'warn' && (stale.rows.Bundle?.line ?? '').includes(entry) && (stale.rows.Bundle?.line ?? '').includes(renamed),
    stale.rows.Bundle?.line)
  await shot('03-stale-bundle')

  await load()
  const reloaded = parseReport((await runDoctor()).text)
  record('bundle row after reloading', reloaded.rows.Bundle?.line)
  check('after a reload the page runs the new build and the row is ✓ again (negative control)',
    reloaded.rows.Bundle?.verdict === 'ok' && (reloaded.rows.Bundle?.line ?? '').includes(renamed),
    reloaded.rows.Bundle?.line)

  // The notice log keeps the report too.
  const drawer = await evaluate(openDrawerExpr)
  record('settings drawer', drawer)
  const logged = await evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const row = document.querySelector('[data-settings-destination="diagnostics"]')
    row?.click()
    await sleep(800)
    const items = [...document.querySelectorAll('.iris-notices__list .iris-reports__message')]
    return items.filter(el => /^(Doctor|体检)/.test(el.textContent ?? '')).length
  })()`)
  record('doctor reports in the notice log', logged)
  check('the notice log holds the reports', typeof logged === 'number' && logged >= 1, String(logged))
  await shot('04-notice-log')

  // Nothing was spent and nothing sent: the conversation did not grow.
  const after = await rpc('chat.open', { chatId: chat.chatId })
  check('the conversation did not grow — /doctor never sent anything',
    (after.view?.messages?.length ?? -1) === (draftSent.view?.messages?.length ?? -2),
    `${String(draftSent.view?.messages?.length)} → ${String(after.view?.messages?.length)}`)

  writeFileSync(new URL('readings.json', outDir), `${JSON.stringify(readings, null, 2)}\n`)
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${String(failures)} CHECK(S) FAILED`}`)
} catch (error) {
  console.error(`FAIL  ${String(error?.stack ?? error)}`)
  failures += 1
} finally {
  clearTimeout(HARD)
  await profile.dispose().catch(() => undefined)
  await data.dispose().catch(() => undefined)
  await dist.dispose().catch(() => undefined)
}
process.exit(failures === 0 ? 0 : 1)
