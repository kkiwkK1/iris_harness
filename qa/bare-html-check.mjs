// Acceptance for dev/fix-bare-html: bare HTML regions in a model reply render
// as sandbox frames (the fence pipeline's own path), with no raw source leaking
// into the prose, and the fence path itself unchanged.
//
// Modes:
//   node qa/bare-html-check.mjs setup    — import the cards, grant scripts,
//                                          create and rename the chats, edit a
//                                          floor of each fixture chat to carry
//                                          bare HTML (no LLM is called).
//   node qa/bare-html-check.mjs render "<chat title>" — open the chat in a
//                                          headless Chrome (spawned here, killed
//                                          by its own process handle), measure
//                                          frame geometry, check for source
//                                          leaks, and screenshot.
//
// Two properties of the render pass, because both are easy to lose:
//   - the card-report list is read as a DELTA, against a baseline taken once the
//     list has gone QUIET (1.5 s without a new row, 15 s cap). Those rows never
//     expire and are cleared only when the CHARACTER changes, and both fixture
//     chats are the same card — so presence alone cannot tell this chat's report
//     from the other chat's leftovers. The chat the page opens by itself keeps
//     reporting well past the boot window, and that traffic is not this chat's:
//     it is subtracted, and counted separately as `arrivedBeforeSettle`.
//     `settled` says whether the wait ever got its quiet moment; a run that hit
//     the cap has a time-based delta again, and must be read as one.
//     NOTE the baseline and the final read are NOT nested sets: clicking a chat
//     of a different CHARACTER clears `cardReports`, so `rowsNow` can be smaller
//     than the baseline. The set difference is still the right answer; a reader
//     expecting "final ⊇ baseline" will think the instrument broke.
//   - every reading prints the observation window it was taken at. All the
//     judgements here are negatives, and a negative without its window cannot
//     be reviewed by the next reader.
//
// The fixtures are card shapes, not card-specific branches: the de24 widget is
// 尸变纪元's MVU status panel as seen on 8790, the fragment chat is the
// 936-floor corpus shape (details/style + narrative + an unclosed tail), and
// the two untouched cards are the fenced-greeting baseline.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { clickTabExpr, openDrawerExpr } from './locators.mjs'
import { BASE, call, rpc } from './rpc.mjs'

const [, , mode, target, widthArg, heightArg] = process.argv
const CORPUS = process.env.IRIS_CORPUS ?? 'D:/workspace/小项目/iris_分支/测试用卡'
const CARDS = {
  corpse: 'v0.5NSFW.png', // 尸变纪元
  lights: 'Lights_ON.png', // 人偶演出Lights-ON
  ice: '1_5.png', // 哈人冰恋世界
}
const CHAT_A = 'G验收-裸组件'
const CHAT_B = 'G验收-碎片与未闭合'
const NL = String.fromCharCode(10)
const TICKS = String.fromCharCode(96, 96, 96)

const widget = (label) => [
  '<div class="de24-update-widget">',
  '<style>',
  '.de24-update-widget { border: 1px solid #642; padding: 6px; font: 13px sans-serif; }',
  '.de24-update-widget .row { display: flex; justify-content: space-between; }',
  '</style>',
  `<div class="row"><span>项目</span><span>${label}</span></div>`,
  '</div>',
].join(NL)

// Narrative + bare widget + narrative + a fenced block: both kinds in one
// floor, instances numbered across both.
const FLOOR_A = [
  '雨停之后，巷子里的灯一盏盏灭回去。',
  '',
  widget('理智 38/100'),
  '',
  '她把袖口卷起来，记下这个数字。',
  '',
  `${TICKS}html`,
  '<body><h1 style="font-family:sans-serif">告示：今晚封锁巷口</h1></body>',
  TICKS,
].join(NL)

// The corpus fragment band: a details panel, narrative between regions, a
// second widget, and an unclosed tail that must claim the rest AND be reported.
const FLOOR_B = [
  '<details>',
  '<summary>状态</summary>',
  '',
  '<div>好感度 32</div>',
  '',
  '</details>',
  '',
  '中间这段是叙事。',
  '',
  widget('零件 7'),
  '',
  '尾段叙事。',
  '',
  '<div>',
  '<span>这个块没有闭合',
].join(NL)

if (mode === 'setup') {
  const ids = {}
  for (const [key, file] of Object.entries(CARDS)) {
    const content = readFileSync(`${CORPUS}/${file}`).toString('base64')
    const frame = await rpc('character.import', { filename: file, content })
    if (frame.ok === false) throw new Error(`import ${file}: ${frame.error?.code} ${frame.error?.message}`)
    const id = frame.result.character.characterId ?? frame.result.character.id
    ids[key] = id
    console.log(`imported ${file} -> ${id}`)
    // Grant before any page opens, so the reading view can build frames at all.
    await call('script.setScriptsAllowed', { characterId: id, allowed: true })
  }

  const a = await call('chat.create', { characterId: ids.corpse })
  const chatA = a.view.chatId ?? a.view.id
  await call('chat.rename', { chatId: chatA, title: CHAT_A })
  await call('chat.editMessage', { chatId: chatA, id: 0, text: FLOOR_A })
  console.log(`chat A: ${chatA} "${CHAT_A}"`)

  const b = await call('chat.create', { characterId: ids.corpse })
  const chatB = b.view.chatId ?? b.view.id
  await call('chat.rename', { chatId: chatB, title: CHAT_B })
  await call('chat.editMessage', { chatId: chatB, id: 0, text: FLOOR_B })
  console.log(`chat B: ${chatB} "${CHAT_B}"`)

  for (const [key, title] of [['lights', 'G验收-Lights基线'], ['ice', 'G验收-冰恋基线']]) {
    const created = await call('chat.create', { characterId: ids[key] })
    const chatId = created.view.chatId ?? created.view.id
    await call('chat.rename', { chatId, title })
    console.log(`chat ${key}: ${chatId} "${title}" (greeting untouched)`)
  }

  writeFileSync(new URL('./bare-html-state.json', import.meta.url), JSON.stringify({ ids, chatA, chatB }, null, 2))
  console.log('setup done')
  process.exit(0)
}

if (mode === 'render') {
  if (target === undefined) {
    console.error('usage: node qa/bare-html-check.mjs render "<chat title>" [width] [height]')
    process.exit(64)
  }
  const WIDTH = Number(widthArg ?? 1680)
  const HEIGHT = Number(heightArg ?? 1050)
  const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  // Default CDP port is offset by the pid: two runs back to back would
  // otherwise fight over one debug port, and the loser dies as
  // "chrome never came up" — which reads as a broken environment, not as a
  // collision. An explicit CDP_PORT is honoured verbatim (see qa/README.md).
  const CDP_PORT = String(Number(process.env.CDP_PORT ?? 9437) + (process.env.CDP_PORT === undefined ? process.pid % 100 : 0))
  const HARD_DEADLINE = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 180_000)
  const outDir = new URL('./results/', import.meta.url)
  mkdirSync(outDir, { recursive: true })

  const userDataDir = `${process.env.TEMP}/iris-qa-cdp-${CDP_PORT}-${Date.now()}`
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    `--window-size=${String(WIDTH)},${String(HEIGHT)}`, 'about:blank',
  ], { stdio: 'ignore' })

  try {
    let page
    for (let at = 0; at < 30 && page === undefined; at += 1) {
      await delay(1000)
      try {
        const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json())
        page = targets.find(t => t.type === 'page' && t.url.startsWith('about:blank'))
      } catch { /* chrome not up yet */ }
    }
    if (page === undefined) throw new Error('chrome never came up')

    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let seq = 0
    const pending = new Map()
    ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
    const send = (method, params = {}) => new Promise(res => {
      const id = ++seq
      pending.set(id, res)
      ws.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async expression => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.result?.exceptionDetails !== undefined) return { error: String(r.result.exceptionDetails.exception?.description ?? '?') }
      return r.result?.result?.value
    }

    /*
     * The observation windows, named once so every reading below can print the
     * one it used.
     *
     * Every judgement here is a negative one — no leak, no report, no frame —
     * and a negative reading without its window is not reviewable: "did not see
     * it" and "looked too early" are the same sentence (TEST-CARDS §九 ③之二).
     */
    const WINDOW = { boot: 7000, framesBoot: 12_000, drawerSettle: 1200 }

    /**
     * The card-report rows, scoped to the scripts card.
     *
     * `#iris-card-scripts` is `CollapsibleSection`'s own body id — stable and
     * language-independent, where the card's title is neither. The scoping
     * matters: `.iris-script__report` is also the notice log's row class, and
     * `.iris-field__note` is on a dozen unrelated paragraphs, so an unscoped
     * selector would describe two lists at once.
     *
     * Rows are read even while the card is folded: `hidden` removes it from the
     * rendering, not from the DOM. `cardPresent` is separate from an empty row
     * list on purpose — "no scripts card here" and "the card is here and says
     * nothing" are different facts, and a missing key must not read as a zero.
     */
    const READ_REPORTS = `(() => {
      const card = document.querySelector('#iris-card-scripts')
      if (card === null) return { cardPresent: false, rows: [] }
      const rows = [...card.querySelectorAll('.iris-script__report')].map(row => ({
        // Direct text children only: the channel label and the staleness marks
        // are spans, so this is the report's own sentence and nothing else.
        text: [...row.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('').trim(),
        channel: row.querySelector('.iris-reports__area')?.textContent ?? null,
        fault: String(row.className).includes('iris-script__report--fault'),
      }))
      return { cardPresent: true, rows }
    })()`

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Page.navigate', { url: BASE })
    const navigatedAt = Date.now()
    const since = () => Date.now() - navigatedAt
    await delay(WINDOW.boot)

    /*
     * Baseline of the card-report list, taken BEFORE this chat is opened.
     *
     * These rows are a durable channel: `addCardReport` writes them into
     * `cardReports`, which has no expiry and is cleared only when the
     * **character** changes (`store.ts` `loadScripts`, first line:
     * `if (scriptsFor === characterId) return`). Both fixture chats belong to
     * one card, so a row the other chat left is still standing — under a plain
     * `includes()` "this chat reported it" and "the previous one did" take the
     * same value. **The delta is the judgement; the presence is not**
     * (TEST-CARDS §九 ③之三).
     */
    const bootBaseline = await evaluate(READ_REPORTS)
    console.log('reports baseline (boot):', JSON.stringify({ observedAtMs: since(), bootWindowMs: WINDOW.boot, ...bootBaseline }))

    // The tab by order and confirmation, never by its label (see qa/locators.mjs);
    // the chat by its title, which is user data and the only handle there is.
    const tabbed = await evaluate(clickTabExpr('chats'))

    /*
     * The judgement baseline, taken once the report list has gone **quiet**.
     *
     * Two earlier shapes and why each failed, because the difference is the
     * whole lesson:
     *
     *  - **boot baseline alone (7 s).** The page opens the most recent chat by
     *    itself and that chat's frames keep reporting well past 7 s. Twenty-five
     *    rows of `height sources` / `libraries cost` / `parent.Mvu` / MVU
     *    `toastr.info` — start-up traffic a statically edited floor cannot
     *    produce — landed in what was labelled "added this run". So the number
     *    meant *"rows that appeared after 7 s"*, not *"rows this chat reported"*.
     *  - **a second baseline taken just before the click.** It named the right
     *    variable and sampled it at the wrong moment: clicking a tab costs about
     *    ten milliseconds, so the second read was the same instant as the first
     *    and `arrivedBeforeSettle` came back empty on both fixtures. The run that
     *    *looked* fixed (25 rows down to 6) was luck — the boot chat had simply
     *    finished by 7 s that time, which the two baselines being 3 rows apart on
     *    one run and 29 on another says out loud.
     *
     * So the wait is on the thing that actually has to finish: the list not
     * growing for `quietMs`. `settled` and `settleWaitedMs` ride the reading,
     * because a run that hit the cap did **not** get a quiet baseline and its
     * delta is back to being time-based — the reader has to be able to see that
     * rather than infer it.
     */
    const SETTLE = { quietMs: 1500, maxMs: 15_000, pollMs: 250 }
    const settleReports = async () => {
      const startedAt = Date.now()
      let snapshot = await evaluate(READ_REPORTS)
      let count = snapshot?.rows?.length ?? 0
      let lastChangeAt = Date.now()
      while (Date.now() - startedAt < SETTLE.maxMs) {
        await delay(SETTLE.pollMs)
        snapshot = await evaluate(READ_REPORTS)
        const next = snapshot?.rows?.length ?? 0
        if (next !== count) {
          count = next
          lastChangeAt = Date.now()
        }
        if (Date.now() - lastChangeAt >= SETTLE.quietMs) {
          return { snapshot, settled: true, waitedMs: Date.now() - startedAt }
        }
      }
      return { snapshot, settled: false, waitedMs: Date.now() - startedAt }
    }
    const settle = await settleReports()
    const clickBaseline = settle.snapshot
    console.log('reports baseline (settled):', JSON.stringify({
      observedAtMs: since(),
      settled: settle.settled,
      settleWaitedMs: settle.waitedMs,
      quietMs: SETTLE.quietMs,
      rows: clickBaseline?.rows?.length ?? null,
    }))

    const opened = tabbed?.error !== undefined ? tabbed : await evaluate(`(() => {
      const wanted = ${JSON.stringify(target)}
      const rows = [...document.querySelectorAll('.iris-list .iris-row')]
        .filter(el => (el.querySelector('.iris-row__title')?.textContent ?? '').includes(wanted))
      if (rows.length === 0) {
        return {
          error: 'no chat row titled ' + wanted,
          titles: [...document.querySelectorAll('.iris-list .iris-row .iris-row__title')].map(t => (t.textContent ?? '').trim()).slice(0, 20),
        }
      }
      rows[0].click()
      return { clicked: rows.length }
    })()`)
    console.log('open:', JSON.stringify({ observedAtMs: since(), tab: tabbed, ...opened }))

    /*
     * Stop here when the chat did not open.
     *
     * Everything below measures whatever chat the page happens to be showing —
     * on a fresh boot that is the most recent one — and labels the readings with
     * `target`. A reading pinned to the wrong object is worse than no reading:
     * it is wrong in a way the report cannot show. (This is not the "should this
     * script have a pass/fail" question, which was settled as no; it is the
     * instrument not having measured the thing it names.)
     */
    if (opened?.error !== undefined) {
      console.error(`bare-html-check: never opened ${JSON.stringify(target)} — ${opened.error}`)
      console.error('Nothing below would describe that chat, so nothing below was measured.')
      clearTimeout(HARD_DEADLINE)
      ws.close()
      chrome.kill()
      await delay(500)
      process.exit(2)
    }

    await delay(WINDOW.framesBoot) // script frames boot

    /*
     * And **which** chat opened, read from the masthead once the click has
     * settled.
     *
     * The refusal above only covers "no row carried that title". A row that
     * matched and a chat that opened are two facts, and the click can land on
     * neither (an overlay eats it) or on a neighbour (two chats of one card
     * share a title prefix) — in both cases every reading below would describe
     * some other chat under this one's name, which is the failure the block
     * above exists to prevent and could not see. Same exit as never opening,
     * because the instrument is wrong in the same way.
     */
    const showing = await evaluate(`(() => {
      const title = document.querySelector('.iris-masthead__title')?.textContent ?? ''
      return { title: title.trim(), wanted: ${JSON.stringify(target)} }
    })()`)
    console.log('showing:', JSON.stringify({ observedAtMs: since(), ...showing }))
    if (!(showing?.title ?? '').includes(target)) {
      console.error(`bare-html-check: opened ${JSON.stringify(showing?.title ?? '')}, wanted ${JSON.stringify(target)}`)
      console.error('Nothing below would describe that chat, so nothing below was measured.')
      clearTimeout(HARD_DEADLINE)
      ws.close()
      chrome.kill()
      await delay(500)
      process.exit(2)
    }

    const reading = await evaluate(`(() => {
      const frames = [...document.querySelectorAll('.iris-interfaces__slot iframe')].map(f => {
        const box = f.getBoundingClientRect()
        return {
          w: Math.round(box.width), h: Math.round(box.height),
          inline: f.style.height || '',
          sandbox: f.getAttribute('sandbox') ?? '',
          hasWidget: (f.getAttribute('srcdoc') ?? '').includes('de24-update-widget'),
          hasFenced: (f.getAttribute('srcdoc') ?? '').includes('告示：今晚封锁巷口'),
        }
      })
      // A leak is the claimed markup reaching the prose as *text*: the message
      // body's own text content, which cannot see inside an iframe document.
      const bodies = [...document.querySelectorAll('.iris-msg__text')]
      const leaks = bodies
        .map(b => b.textContent ?? '')
        .map(t => ({ widget: t.includes('<div class="de24-update-widget"'), details: t.includes('<details>'), fenced: t.includes('<body>'), style: t.includes('.de24-update-widget {') }))
      return { frames, leaks, slots: document.querySelectorAll('.iris-interfaces__slot').length }
    })()`)
    // The leak checks below are negatives, so they carry the window they were
    // read at: everything here was sampled once, this long after the navigate.
    console.log('reading:', JSON.stringify({ observedAtMs: since(), sinceOpenMs: WINDOW.framesBoot, ...reading }, null, 1))

    const name0 = target.replace(/[^\p{L}\p{N}-]+/gu, '-')
    // The reading view, before anything is opened over it.
    const clean = await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })
    writeFileSync(new URL(`./results/bare-html-${name0}-${String(WIDTH)}.jpeg`, import.meta.url), Buffer.from(clean.result?.data ?? '', 'base64'))

    // The refused note: open the settings drawer, where the card report list
    // lives, and read the rows — not the page's prose.
    const drawer = await evaluate(openDrawerExpr)
    const after = drawer?.error !== undefined ? drawer : await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      await sleep(${WINDOW.drawerSettle})
      return ${READ_REPORTS}
    })()`)

    const bootRows = bootBaseline?.rows ?? []
    const clickRows = clickBaseline?.rows ?? []
    const afterRows = after?.rows ?? []
    // Judged against the pre-click baseline; the boot one only measures how
    // busy the page already was.
    const seenAtBoot = new Set(bootRows.map(row => row.text))
    const seenAtClick = new Set(clickRows.map(row => row.text))
    const arrivedBeforeSettle = clickRows.filter(row => !seenAtBoot.has(row.text))
    const added = afterRows.filter(row => !seenAtClick.has(row.text))
    const neverClosed = added.find(row => row.text.includes('never closed'))
    console.log('reports:', JSON.stringify({
      observedAtMs: since(),
      drawerSettleMs: WINDOW.drawerSettle,
      drawer,
      ...(after?.error === undefined ? {} : { error: after.error }),
      // A missing card and a card with nothing to say are different findings.
      baselineCardPresent: bootBaseline?.cardPresent === true,
      cardPresent: after?.cardPresent === true,
      bootBaselineRows: bootRows.length,
      settledBaselineRows: clickRows.length,
      rowsNow: afterRows.length,
      /*
       * The boot chat still talking, kept out of the judgement and reported on
       * its own. A large number here does not invalidate the run — it says the
       * page was busy when this one started, which is the fact that used to be
       * folded into `addedThisRun` and read as this chat's own output.
       */
      settled: settle.settled,
      settleWaitedMs: settle.waitedMs,
      arrivedBeforeSettle: arrivedBeforeSettle.map(row => row.text.slice(0, 100)),
      addedThisRun: added.map(row => ({ channel: row.channel, fault: row.fault, text: row.text.slice(0, 140) })),
      // The judgement: this run ADDED the row, measured from the moment the
      // target row was clicked. "The words are somewhere on the page" cannot
      // tell that from a row the previous chat of the same card left behind —
      // the list is only cleared when the character changes.
      neverClosedAddedThisRun: neverClosed !== undefined,
      // Read off the row's own label element, not from the word "interface"
      // appearing anywhere in the drawer — the drawer is full of that word, so
      // the old check was true whatever the row said.
      neverClosedChannel: neverClosed?.channel ?? null,
      // Both printed, so a false reading is diagnosable rather than just
      // negative: in the boot baseline it was standing before this run touched
      // anything; arriving between the baselines means the boot chat said it.
      neverClosedAtBoot: bootRows.some(row => row.text.includes('never closed')),
      neverClosedArrivedBeforeSettle: arrivedBeforeSettle.some(row => row.text.includes('never closed')),
    }, null, 1))

    // And the drawer itself, where the report line lives — kept as a second
    // image so the reading view above stays unobstructed.
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })
    writeFileSync(new URL(`./results/bare-html-${name0}-drawer-${String(WIDTH)}.jpeg`, import.meta.url), Buffer.from(shot.result?.data ?? '', 'base64'))
    clearTimeout(HARD_DEADLINE)
    ws.close()
  } finally {
    chrome.kill()
    await delay(500)
  }
  process.exit(0)
}

console.error('modes: setup | render "<chat title>"')
process.exit(64)
