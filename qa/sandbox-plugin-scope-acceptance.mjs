/**
 * Acceptance for the sandbox-plugin scope round: the owner id per conversation,
 * the owner scope at teardown, and the forget/branch rules on the host.
 *
 * Runs against a real host, the production bundle and a real card-script frame.
 * **It spends nothing.** Plugin versions are seeded straight into the copied
 * data dir's sidecar (`<profile>/sandbox-plugins/<chatId>.json`, the §10.1
 * shape, already authorised), the way `sandbox-plugins-pr-d.mjs` does, so no
 * authoring model is called.
 *
 * What it reads, and where:
 * - **in the frame** (a CDP session on the card-script iframe): the plugin's
 *   panel cell, and whether the global it published is on the card's shared
 *   namespace (`name in window.parent`, the parent proxy card scripts read);
 * - **on disk in the copy**: `script-variables.json`, for the owner ids the
 *   plugin's script-scope write landed under;
 * - **the product's own controls**: the panel's disable / enable buttons, and
 *   the `sandboxPlugin.decide` / `chat.delete` RPCs.
 *
 * Every frame reading is polled to a stated deadline, because a mount and a
 * teardown each arrive after a round trip.
 *
 * Usage: node qa/sandbox-plugin-scope-acceptance.mjs
 * Hard failures: 1 = a check failed, 2 = port or data-dir problem, 3 = hard timeout.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'
import { answerConsentExpr, clickTabExpr } from './locators.mjs'

const PORT = Number(process.env.IRIS_PORT ?? 8796)
const BASE = `http://127.0.0.1:${String(PORT)}`
const CDP = String(cdpPort(9359))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const CARD = process.env.IRIS_CARD ?? '爱衣'
const PLUGIN = '01-probe'

const outDir = new URL('./results/sandbox-plugin-scope/', import.meta.url)
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

const PROBE = [
  'return {',
  '  apply() {',
  '    const c = iris.card',
  "    c.initializeGlobal('QA_SCOPE', iris.id)",
  '    globalThis.__qaSid = String(c.getScriptId())',
  '    globalThis.__qaChatAtApply = String(window.SillyTavern?.getCurrentChatId?.())',
  "    setTimeout(() => { globalThis.__qaSidLater = String(c.getScriptId()) }, 3000)",
  "    Promise.resolve(c.insertOrAssignVariables({ probe: iris.id }, { type: 'script' })).then(() => { globalThis.__qaWrite = 'ok' }, error => { globalThis.__qaWrite = String(error) })",
  "    c.eventOn('qa_scope_ping', () => {})",
  "    iris.panel.mount('<b data-qa-probe>probe</b>')",
  '  },',
  '}',
].join('\n')
const hashOf = code => createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 12)

{
  const netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
  const taken = (netstat.stdout ?? '').split('\n')
    .filter(line => line.includes(`:${String(PORT)} `) && line.includes('LISTENING'))
  if (taken.length > 0) {
    console.error(`FAIL  port ${String(PORT)} is already listening — refusing to start:\n${taken.join('\n')}`)
    process.exit(2)
  }
}

const data = dataCopy('iris-sandbox-scope-qa-')
const dataDir = data.dir
const dataSource = process.env.IRIS_DATA_SOURCE ?? join(repoRoot, '..', 'iris_cordis_traven', 'apps', 'iris', 'data')
await cp(dataSource, dataDir, { recursive: true }).catch(error => {
  console.error(`FAIL  no data dir to copy from (${dataSource}): ${String(error)}`)
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
console.log(`host process PID ${String(host.pid)} on port ${String(PORT)}, data dir ${dataDir}`)

let seq = 0
const rpc = async (method, params = {}) => {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-scope-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 420_000)

/** The script-variable owners stored for one card in the copy. */
const storedOwners = async characterId => {
  try {
    const file = JSON.parse(await readFile(join(profileDir, 'script-variables.json'), 'utf8'))
    return Object.keys(file[characterId] ?? {})
  } catch {
    return []
  }
}

let chrome
const profile = chromeProfile('iris-qa-cdp-')
try {
  let up = false
  for (let at = 0; at < 60 && !up; at += 1) {
    await delay(500)
    if (hostOutput.includes('EADDRINUSE')) {
      console.error(`FAIL  the host died on EADDRINUSE:\n${hostOutput}`)
      process.exit(2)
    }
    up = await rpc('character.list').then(() => true).catch(() => false)
  }
  if (!up) throw new Error(`the host on ${String(PORT)} never answered\n${hostOutput}`)

  const ids = ((await rpc('character.list')).characters ?? []).map(one => one.characterId)
  record('character.list before any write', ids.length)
  const characterId = ids.find(id => id === CARD) ?? ids.find(id => id.includes(CARD))
  if (characterId === undefined) {
    console.error(`FAIL  no card named ${CARD} in this data dir; set IRIS_CARD`)
    process.exit(2)
  }

  // Two conversations with the same card, each seeded with plugin 01-probe.
  const stamp = String(Date.now()).slice(-6)
  const made = []
  for (const role of ['A', 'B']) {
    const created = await rpc('chat.create', { characterId })
    const chatId = created.view?.chatId ?? created.chatId
    const title = `qa-scope-${role}-${stamp}`
    await rpc('chat.rename', { chatId, title })
    made.push({ role, chatId, title })
  }
  const [A, B] = made
  record('conversations', made)
  const hash = hashOf(PROBE)
  await mkdir(join(profileDir, 'sandbox-plugins'), { recursive: true })
  for (const chat of made) {
    await writeFile(join(profileDir, 'sandbox-plugins', `${chat.chatId}.json`), JSON.stringify({
      version: 1,
      chatId: chat.chatId,
      characterId,
      plugins: [{
        id: PLUGIN,
        versions: [{
          version: 1, name: 'QA probe', purpose: 'publish a global, write a variable, fill a panel',
          declares: [{ kind: 'panel' }, { kind: 'members', names: ['initializeGlobal', 'insertOrAssignVariables', 'eventOn'] }],
          code: PROBE, bytes: Buffer.byteLength(PROBE, 'utf8'), hash, prompt: 'qa',
          authored: { connectionId: 'qa-seed', model: 'qa-seed', at: Date.now() },
          facade: 1,
        }],
        enabled: true, trustFutureVersions: false, authorizedHashes: [hash],
      }],
    }), 'utf8')
  }
  record('sidecars seeded', made.map(chat => `${chat.chatId}.json`))

  // ---- browser ------------------------------------------------------------
  chrome = profile.adopt(spawn(CHROME, [
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile.dir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new', '--window-size=1480,1000', 'about:blank',
  ], { stdio: 'ignore' }))
  let version
  for (let at = 0; at < 40 && version === undefined; at += 1) {
    await delay(500)
    try { version = await fetch(`http://127.0.0.1:${CDP}/json/version`).then(r => r.json()) } catch { /* not yet */ }
  }
  if (version === undefined) throw new Error('chrome never came up')

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
    if (r.result?.exceptionDetails !== undefined) throw new Error(`evaluate: ${JSON.stringify(r.result.exceptionDetails)}`)
    return r.result?.result?.value
  }
  const quiet = async (expression, sessionId) => evaluate(expression, sessionId).catch(() => undefined)
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
  const openChat = async title => {
    const tabbed = await evaluate(clickTabExpr('chats'))
    await delay(600)
    const opened = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.iris-list .iris-row')]
        .filter(el => (el.querySelector('.iris-row__title')?.textContent ?? '').trim() === ${JSON.stringify(title)})
      if (rows.length !== 1) return { error: 'rows titled so: ' + rows.length }
      rows[0].click()
      return { clicked: 1 }
    })()`)
    await delay(1500)
    const consent = await evaluate(answerConsentExpr)
    return { tabbed, opened, consent }
  }

  /** What the card-script frame that holds the plugin says right now. */
  const frameState = async () => {
    for (const sessionId of [...frameSessions.keys()]) {
      const state = await quiet(`(() => {
        if (!document.body || document.body.hasAttribute('data-iris-interface')) return undefined
        let published
        try { published = 'QA_SCOPE' in window.parent } catch { published = 'unreadable' }
        return {
          write: globalThis.__qaWrite,
          chat: (() => { try { return String(window.SillyTavern?.getCurrentChatId?.()) } catch (e) { return 'threw ' + e } })(),
          sid: globalThis.__qaSid,
          chatAtApply: globalThis.__qaChatAtApply,
          sidLater: globalThis.__qaSidLater,
          cell: document.querySelector('[data-iris-plugin-panel="${PLUGIN}"] [data-qa-probe]') !== null,
          published,
        }
      })()`, sessionId)
      if (state !== undefined) return state
    }
    return { frame: false }
  }
  const frameUntil = async (done, waitMs = 15_000) => {
    const started = Date.now()
    let state
    do {
      await delay(500)
      state = await frameState()
    } while (!done(state) && Date.now() - started < waitMs)
    return { state, tookMs: Date.now() - started, window: `polled to ${String(waitMs)}ms` }
  }
  const pressRow = async action => {
    // Second button is disable/enable, third is remove (SandboxPluginPanel's order).
    const index = action === 'remove' ? 2 : 1
    return evaluate(`(() => {
      const row = document.querySelector('[data-panel="sandbox-plugins"] [data-plugin-id="${PLUGIN}"]')
      if (row === null) return { error: 'no row' }
      const buttons = [...row.querySelectorAll('.iris-conn__actions button')]
      const button = buttons[${String(index)}]
      if (button === undefined) return { error: 'no button', count: buttons.length }
      button.click()
      return { clicked: (button.textContent ?? '').trim() }
    })()`)
  }

  await nav(`${BASE}/`)
  record('open A', await openChat(A.title))

  // ---- 1: mounted in A, under A's owner id ---------------------------------
  const upA = await frameUntil(s => s.cell === true && s.published === true, 20_000)
  record('frame after opening A', upA)
  check('A: the plugin mounted and published its global', upA.state.cell === true && upA.state.published === true,
    `${upA.window}; took ${String(upA.tookMs)}ms`)
  await delay(1500)
  const ownersAfterA = await storedOwners(characterId)
  record('script-variable owners after A', ownersAfterA)
  if (ownersAfterA.length === 0) {
    const text = await readFile(join(profileDir, 'script-variables.json'), 'utf8').catch(() => '(no file)')
    record('script-variables.json, sp: owners anywhere', (text.match(/"sp:[^"]*"/gu) ?? []))
    const reports = await rpc('debug.reports', { limit: 50 }).catch(error => ({ error: String(error) }))
    record('recent reports', (reports.reports ?? []).slice(-8).map(row => `${row.kind}: ${String(row.message).slice(0, 200)}`))
  }
  check('A: the script-scope write landed under sp:<A>:01-probe, not the bare plugin id',
    ownersAfterA.includes(`sp:${A.chatId}:${PLUGIN}`) && !ownersAfterA.includes(PLUGIN))

  // ---- 2: disable through the panel → teardown via scope.dispose() ---------
  record('press disable', await pressRow('disable'))
  const downA = await frameUntil(s => s.cell === false && s.published === false)
  record('frame after disable', downA)
  check('A: after disable the panel cell and the published global are both gone',
    downA.state.cell === false && downA.state.published === false, `${downA.window}; took ${String(downA.tookMs)}ms`)

  // The control: enabling it again brings both back, so the absence above was
  // the teardown and not a frame that had stopped answering.
  record('press enable', await pressRow('enable'))
  const againA = await frameUntil(s => s.cell === true && s.published === true)
  record('frame after enable', againA)
  check('A: enabling again brings both back (control)', againA.state.cell === true && againA.state.published === true,
    `${againA.window}`)

  // ---- 3: switch to B: its own owner ----------------------------------------
  record('open B', await openChat(B.title))
  const upB = await frameUntil(s => s.cell === true && s.published === true, 20_000)
  record('frame after opening B', upB)
  check('B: the same plugin id mounted in the other conversation', upB.state.cell === true && upB.state.published === true)
  await delay(1500)
  const ownersAB = await storedOwners(characterId)
  record('owners with both chats', ownersAB)
  check('A and B hold separate tables for plugin 01-probe',
    ownersAB.includes(`sp:${A.chatId}:${PLUGIN}`) && ownersAB.includes(`sp:${B.chatId}:${PLUGIN}`))

  // ---- 4: remove in A forgets A only; delete B forgets B -------------------
  await rpc('sandboxPlugin.decide', { chatId: A.chatId, characterId, pluginId: PLUGIN, verdict: 'remove' })
  const afterRemove = await storedOwners(characterId)
  record('owners after removing the plugin in A', afterRemove)
  check('removing in A forgets A’s table and leaves B’s',
    !afterRemove.includes(`sp:${A.chatId}:${PLUGIN}`) && afterRemove.includes(`sp:${B.chatId}:${PLUGIN}`))

  await rpc('chat.delete', { chatId: B.chatId })
  const afterDelete = await storedOwners(characterId)
  record('owners after deleting chat B', afterDelete)
  check('deleting B forgets B’s table', !afterDelete.some(owner => owner.startsWith(`sp:${B.chatId}:`)))
  await rpc('chat.delete', { chatId: A.chatId })

  const errors = hostOutput.split('\n').filter(line => /error/i.test(line) && !/EADDRINUSE/.test(line)).slice(0, 5)
  record('host output lines mentioning error', errors)
} catch (error) {
  console.error(`FAIL  ${error instanceof Error ? error.stack : String(error)}`)
  failures += 1
} finally {
  clearTimeout(HARD)
  await writeFile(new URL('readings.json', outDir), JSON.stringify(readings, null, 2), 'utf8').catch(() => undefined)
  // Only what this script started, and only by the handles it holds.
  if (chrome?.pid !== undefined && chrome.exitCode === null) chrome.kill()
  if (host.exitCode === null) {
    host.kill()
    await new Promise(resolve => { host.once('exit', resolve) })
  }
  await profile.dispose()
  await data.dispose()
}
console.log(failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`)
process.exit(failures === 0 ? 0 : 1)
