/**
 * Acceptance for the authoring row's provider→model default (owner, 2026-09-19).
 *
 * The defect: on the connection page, the 「写插件用」 row's model `<select>`
 * displayed a model while React state held `''`, so 「用它写插件」 stayed dark
 * over a row that looked complete. The fix moves the model with the provider
 * (`apps/iris-web/src/app/authoring-pick.ts`), and the reading that decides it
 * is **the button's `disabled` immediately after the provider changes, with no
 * second interaction** — a second interaction is what used to fix it by hand,
 * so anything between the change and the read hides the defect instead of
 * catching it.
 *
 * ## What is measured, and where each reading comes from
 *
 * 1. `connection.list` **before any write** — the card set rule from
 *    `qa/README.md`, and the baseline for (5).
 * 2. The composer's 「创造」 entry **before** a model is set. The control
 *    written into the task as "disabled" is not disabled: `Composer.tsx` renders
 *    it always, adds `note` (`composerCreateNoModel`) when `canAuthor` is false
 *    and returns early from `onSelect`. So the honest reading is **the note's
 *    presence** plus **whether selecting it turns creating mode on**, and this
 *    step is the negative control for both — without it, a run on a host that
 *    already had the setting would report a working entry and prove nothing.
 * 3. The row itself: choose the provider, read `disabled` in the same
 *    expression as the change (no round trip between them), read what the model
 *    control displays, then save.
 * 4. The row's own sentence, and `connection.list`'s `authoring` — the field
 *    the store reads to set `authoringConnection`, which gates (2). A host that
 *    answered the write and omitted the field from the list would leave the
 *    composer entry dark forever while the panel looked right.
 * 5. A **reload**, then the row's sentence and the composer entry again: the
 *    boot path reads `authoring` out of `connection.list` too, and it is the
 *    one a reader who never opens the connection card is on.
 *
 * **Nothing is spent.** Selecting 「创造」 switches the composer into creating
 * mode; the request is made by *sending*, which this script never does.
 *
 * Hard failures, because a `console.error` followed by more output reads in a
 * report exactly like "this box was fine" (`qa/README.md`): exit 1 = a check
 * did not pass, 2 = port or data-dir trouble, 3 = hard timeout.
 *
 * Usage: node qa/authoring-row-acceptance.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { cdpPort } from './cdp-port.mjs'
import { chromeProfile, dataCopy } from './chrome-profile.mjs'
import { answerConsentExpr, openDrawerExpr } from './locators.mjs'

// Host ports go from 8791 up, one per script (qa/README.md). 8791/8793/8794/8795
// are the four sandbox-plugin scripts and 8792 is `rpc.mjs`, so this is 8796.
const PORT = Number(process.env.IRIS_PORT ?? 8796)
const BASE = `http://127.0.0.1:${String(PORT)}`
// CDP from 9333 up, all distinct; the sandbox-plugin scripts took 9345–9348.
// The pid offset is `cdpPort`'s and is not copied here.
const CDP = String(cdpPort(9349))
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const outDir = new URL('./results/authoring-row/', import.meta.url)
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
 * The port must be free **before** the host starts, and must never be
 * re-checked afterwards: a collision does not make the requests fail, it makes
 * them succeed against somebody else's host (qa/README.md, 2026-09-06).
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

/* A copy of the product's data dir with the lock removed: since #72 one data
 * dir has one host and there is no bypass. */
const data = dataCopy('iris-authoring-row-qa-')
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
console.log(`host process PID ${String(host.pid)} on port ${String(PORT)}, data dir ${dataDir}`)

let seq = 0
const rpc = async (method, params = {}) => {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-authoring-${String(++seq)}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 300_000)

/** The authoring row, and the reader's two facts about it, in one expression. */
const ROW = '[data-settings-route="connections"] [data-block="authoring"]'
/*
 * Structure, never words: every label in this row is translated and a headless
 * Chrome follows the machine's locale (`qa/README.md`). The provider control is
 * the `<select>` in the first field, the model control is whatever sits in the
 * second, and the save button is the one that is not 「清除」 — `.iris-act` is
 * the clear button's own class, and it is absent until something is stored, so
 * `button:first-of-type` would name different elements in the two states.
 */
const rowStateExpr = `(() => {
  const row = document.querySelector(${JSON.stringify(ROW)})
  if (row === null) return { error: 'no authoring row on the page' }
  const fields = [...row.querySelectorAll('.iris-field')]
  const provider = fields[0]?.querySelector('select')
  const model = fields[1]?.querySelector('select, input')
  const save = row.querySelector('.iris-probe__actions button:not(.iris-act)')
  return {
    providerValue: provider?.value ?? null,
    modelTag: model?.tagName ?? null,
    modelShown: model?.value ?? null,
    saveDisabled: save === null ? null : save.disabled,
    note: (row.querySelector('.iris-field__note')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    providerOptions: [...(provider?.options ?? [])].map(o => o.value),
  }
})()`

/**
 * Move the provider `<select>` and read the button in the **same** expression.
 *
 * Through the prototype's setter, because React installs its own `value`
 * property on the element to track what it last wrote: a plain assignment
 * leaves that tracker agreeing with the DOM, so the `change` event is dropped
 * as "no change" and the component never hears the move.
 *
 * The read happens after React has flushed, and the wait is a poll on the
 * provider's own value rather than a sleep — but nothing else is touched in
 * between, which is the point: one interaction, then the reading.
 * @param id - the provider id to select.
 * @returns an expression for `Runtime.evaluate`.
 */
const chooseProviderExpr = id => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const row = document.querySelector(${JSON.stringify(ROW)})
  if (row === null) return { error: 'no authoring row on the page' }
  const select = row.querySelector('.iris-field select')
  if (select === null) return { error: 'the row has no provider select' }
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(select, ${JSON.stringify(id)})
  select.dispatchEvent(new Event('change', { bubbles: true }))
  for (let at = 0; at < 40; at += 1) {
    await sleep(50)
    if (select.value === ${JSON.stringify(id)}) break
  }
  const state = ${rowStateExpr}
  return { ...state, changedAt: Date.now() }
})()`

/**
 * The composer's 「创造」 entry: open 「+」, read the row, select it, read the mode.
 *
 * **Creating mode has no class and the entry has no `disabled`.** `Composer.tsx`
 * shows the mode in exactly two places — the field's placeholder and the send
 * control's `aria-label` — and both are translated, so the judgement here is
 * that they **changed**, not what they say. Their text is recorded as evidence.
 * Selecting the row is free: the request is made by sending, not by switching.
 * The row is selected a second time at the end to leave the composer as it was.
 */
const createEntryExpr = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const fieldOf = () => document.querySelector('.iris-composer__field')
  const sendOf = () => document.querySelector('.iris-composer__send')
  const mode = () => ({
    placeholder: fieldOf()?.getAttribute('placeholder') ?? null,
    sendLabel: sendOf()?.getAttribute('aria-label') ?? null,
  })
  const open = async () => {
    const plus = document.querySelector('.iris-composer__bar button[aria-haspopup="menu"]')
    if (plus === null) return null
    plus.click()
    for (let at = 0; at < 30; at += 1) {
      await sleep(100)
      // The only menuitemradio in the menu: 「创造」 is the one row rendered as
      // a mode toggle (\`checked\`), which is identity rather than a word.
      const item = document.querySelector('[role="menuitemradio"]')
      if (item !== null) return item
    }
    return null
  }
  const item = await open()
  if (item === null) return { error: 'the 「+」 menu never showed a mode-toggle row' }
  const before = mode()
  const answer = {
    label: (item.querySelector('.iris-composer-menu__label')?.textContent ?? '').trim(),
    note: (item.querySelector('.iris-composer-menu__note')?.textContent ?? '').trim(),
    ariaCheckedBefore: item.getAttribute('aria-checked'),
    modeBefore: before,
  }
  item.click()
  await sleep(500)
  const after = mode()
  answer.modeAfter = after
  answer.creatingAfterSelect = after.placeholder !== before.placeholder && after.sendLabel !== before.sendLabel
  if (answer.creatingAfterSelect) {
    // Put it back, so nothing downstream inherits a composer in creating mode.
    const again = await open()
    answer.ariaCheckedWhileOn = again?.getAttribute('aria-checked') ?? null
    again?.click()
    await sleep(300)
    document.body.click()
  } else {
    document.body.click()
  }
  return answer
})()`

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

  // ---- 1. the host, before anything is written --------------------------
  const cards = await rpc('character.list')
  record('character.list before any write', (cards.characters ?? []).map(one => one.characterId))

  const listedBefore = await rpc('connection.list')
  record('connection.list keys before any write', Object.keys(listedBefore))
  record('connection.list.authoring before any write', listedBefore.authoring ?? null)
  const profiles = listedBefore.profiles ?? []
  record('saved providers', profiles.map(one => ({ id: one.id, models: one.models?.length ?? null })))
  if (profiles.length === 0) {
    console.error('FAIL  this data dir has no saved provider; the row cannot be driven')
    process.exit(2)
  }
  /*
   * The provider this run drives: one with a probed model list, because the
   * defect is the `<select>` branch. A data dir with none puts the row on its
   * hand-typed path, which is a different (and unbroken) control — refused by
   * name rather than run as if it proved the same thing.
   */
  const target = profiles.find(one => (one.models?.length ?? 0) > 0)
  if (target === undefined) {
    console.error('FAIL  no saved provider has a probed model list; probe one first (the row would')
    console.error('      fall back to its hand-typed field, which is not the branch under test)')
    process.exit(2)
  }
  record('the provider this run drives', { id: target.id, firstModel: target.models[0], models: target.models.length })

  /*
   * Cleared first, so the run starts in the state the defect needs: nothing
   * stored, therefore an empty draft. A data dir that already carried the
   * setting would render a filled row and an armed button before a single
   * interaction, and every check below would pass without measuring anything.
   */
  if (listedBefore.authoring !== undefined) {
    await rpc('connection.authoring', {})
    record('cleared a pre-existing authoring setting', listedBefore.authoring)
  }

  // A conversation to read the composer in. The shell opens the most recent one
  // by itself, so this only has to make sure there is one.
  const chats = await rpc('chat.list')
  let chatId = chats.chats?.[0]?.chatId
  if (chatId === undefined) {
    const characterId = cards.characters?.[0]?.characterId
    if (characterId === undefined) {
      console.error('FAIL  this data dir has neither a conversation nor a card to start one from')
      process.exit(2)
    }
    chatId = (await rpc('chat.create', { characterId })).view?.chatId
  }
  record('the conversation the composer is read in', chatId)

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

  await send('Page.enable')
  await send('Runtime.enable')

  /** Load the app and wait for the composer, which is the last thing to arrive. */
  const load = async () => {
    await send('Page.navigate', { url: `${BASE}/` })
    for (let at = 0; at < 40; at += 1) {
      await delay(500)
      if (await evaluate('document.readyState') === 'complete') break
    }
    for (let at = 0; at < 40; at += 1) {
      await delay(500)
      if (await evaluate('document.querySelector(".iris-composer__bar") !== null') === true) break
    }
    await evaluate(answerConsentExpr)
    await delay(1000)
  }
  /** Open the settings drawer and walk to the connection page. */
  const openConnections = async () => {
    const drawer = await evaluate(openDrawerExpr)
    if (drawer?.opened !== true) throw new Error(`the drawer never opened: ${JSON.stringify(drawer)}`)
    const walked = await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      const row = document.querySelector('[data-settings-destination="connections"]')
      if (row === null) return { error: 'no connections row in the settings home' }
      row.click()
      for (let at = 0; at < 30; at += 1) {
        await sleep(100)
        const page = document.querySelector('[data-settings-route="connections"]')
        if (page !== null && !page.hidden) return { opened: true, label: (row.textContent ?? '').trim() }
      }
      return { error: 'the connections page never became visible' }
    })()`)
    if (walked?.opened !== true) throw new Error(`the connection page never opened: ${JSON.stringify(walked)}`)
    // The row renders from `connection.list`, which is one round trip away.
    for (let at = 0; at < 30; at += 1) {
      await delay(200)
      const state = await evaluate(rowStateExpr)
      if (state?.providerOptions?.length > 1) return state
    }
    throw new Error('the authoring row never listed the saved providers')
  }

  await load()

  // ---- 2. the composer entry with nothing set (negative control) ---------
  const createBefore = await evaluate(createEntryExpr)
  record('composer 「create」 entry before a model is set', createBefore)
  check(
    'with nothing set, the 「create」 entry carries its "no model" note',
    typeof createBefore?.note === 'string' && createBefore.note.length > 0,
    `note=${JSON.stringify(createBefore?.note ?? null)}`,
  )
  check(
    'with nothing set, selecting it does not enter creating mode',
    createBefore?.creatingAfterSelect === false,
    `creatingAfterSelect=${String(createBefore?.creatingAfterSelect)}`,
  )

  // ---- 3. the row: one interaction, then the reading ---------------------
  const fresh = await openConnections()
  record('the authoring row as it opens', fresh)
  check('the row opens on 「none」 with the button dark', fresh.providerValue === '' && fresh.saveDisabled === true,
    `providerValue=${JSON.stringify(fresh.providerValue)} saveDisabled=${String(fresh.saveDisabled)}`)

  const chosen = await evaluate(chooseProviderExpr(target.id))
  record('the row immediately after the provider was chosen', chosen)
  check(
    'THE DEFECT: the save button is armed immediately after choosing a provider',
    chosen?.saveDisabled === false,
    `saveDisabled=${String(chosen?.saveDisabled)} modelShown=${JSON.stringify(chosen?.modelShown)}`,
  )
  check(
    'the model control shows the provider’s first model, and the state holds it',
    chosen?.modelTag === 'SELECT' && chosen?.modelShown === target.models[0],
    `modelTag=${String(chosen?.modelTag)} shown=${JSON.stringify(chosen?.modelShown)} expected=${JSON.stringify(target.models[0])}`,
  )
  await shot('01-row-after-choosing-provider')

  // ---- 4. save, the row's sentence, and the host's answer ----------------
  const saved = await evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const row = document.querySelector(${JSON.stringify(ROW)})
    const save = row?.querySelector('.iris-probe__actions button:not(.iris-act)')
    if (save == null) return { error: 'no save button' }
    save.click()
    for (let at = 0; at < 40; at += 1) {
      await sleep(250)
      const clear = row.querySelector('.iris-probe__actions button.iris-act')
      if (clear !== null) break
    }
    return ${rowStateExpr}
  })()`)
  record('the row after 「use for writing plugins」', saved)
  check(
    'the row’s own sentence names the model that was saved',
    typeof saved?.note === 'string' && saved.note.includes(target.models[0]),
    `note=${JSON.stringify(saved?.note ?? null)}`,
  )
  await shot('02-row-after-save')

  const listedAfter = await rpc('connection.list')
  record('connection.list keys after the save', Object.keys(listedAfter))
  record('connection.list.authoring after the save', listedAfter.authoring ?? null)
  check(
    'connection.list returns the authoring pair the row saved',
    listedAfter.authoring?.id === target.id && listedAfter.authoring?.model === target.models[0],
    JSON.stringify(listedAfter.authoring ?? null),
  )

  // ---- 5. a reload, and the composer entry again -------------------------
  await load()
  const afterReload = await openConnections()
  record('the authoring row after a reload', afterReload)
  check(
    'after a reload the row still names the saved pair',
    afterReload.note.includes(target.models[0]) && afterReload.providerValue === target.id,
    `providerValue=${JSON.stringify(afterReload.providerValue)} note=${JSON.stringify(afterReload.note)}`,
  )
  check(
    'after a reload the button is armed without touching anything',
    afterReload.saveDisabled === false,
    `saveDisabled=${String(afterReload.saveDisabled)}`,
  )

  // Close the drawer, so the composer is the thing on screen again.
  await evaluate(`(() => {
    const icons = [...document.querySelectorAll('.iris-settings__header .iris-settings__icon')]
    icons.at(-1)?.click()
    return icons.length
  })()`)
  await delay(800)
  const createAfter = await evaluate(createEntryExpr)
  record('composer 「create」 entry after the setting is stored', createAfter)
  check(
    'with a model set, the 「create」 entry has dropped its "no model" note',
    createAfter?.note === '',
    `note=${JSON.stringify(createAfter?.note ?? null)}`,
  )
  check(
    'with a model set, selecting it enters creating mode',
    createAfter?.creatingAfterSelect === true,
    `creatingAfterSelect=${String(createAfter?.creatingAfterSelect)}`
    + ` mode ${JSON.stringify(createAfter?.modeBefore ?? null)} → ${JSON.stringify(createAfter?.modeAfter ?? null)}`,
  )
  await shot('03-composer-create-entry')

  writeFileSync(new URL('readings.json', outDir), `${JSON.stringify(readings, null, 2)}\n`)
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${String(failures)} CHECK(S) FAILED`}`)
} catch (error) {
  console.error(`FAIL  ${String(error?.stack ?? error)}`)
  failures += 1
} finally {
  clearTimeout(HARD)
  // Only this script's own processes: the host it started and the browser it
  // started, both adopted by the temp-dir handles that kill them on every exit
  // path (`qa/chrome-profile.mjs`).
  await profile.dispose().catch(() => undefined)
  await data.dispose().catch(() => undefined)
}
process.exit(failures === 0 ? 0 : 1)
