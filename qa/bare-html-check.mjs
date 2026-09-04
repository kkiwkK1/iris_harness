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
// The fixtures are card shapes, not card-specific branches: the de24 widget is
// 尸变纪元's MVU status panel as seen on 8790, the fragment chat is the
// 936-floor corpus shape (details/style + narrative + an unclosed tail), and
// the two untouched cards are the fenced-greeting baseline.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
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
  const CDP_PORT = process.env.CDP_PORT ?? '9437'
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

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Page.navigate', { url: BASE })
    await delay(7000)

    const opened = await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      const wanted = ${JSON.stringify(target)}
      const tabs = [...document.querySelectorAll('[role=tab]')]
      const readingTab = tabs.find(b => (b.textContent ?? '').includes('Reading'))
      if (readingTab === undefined) return { error: 'no Reading tab' }
      readingTab.click()
      await sleep(500)
      const rows = [...document.querySelectorAll('button, [role=button], a, li')].filter(el => (el.textContent ?? '').includes(wanted))
      if (rows.length === 0) return { error: 'chat row not found for ' + wanted }
      rows[0].click()
      return { clicked: rows.length }
    })()`)
    console.log('open:', JSON.stringify(opened))
    await delay(12_000) // script frames boot

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
    console.log('reading:', JSON.stringify(reading, null, 1))

    // The refused note: open the settings drawer, where the card report list
    // lives, and look for the split's own sentence.
    const reports = await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      const buttons = [...document.querySelectorAll('button')]
      const settings = buttons.find(b => (b.textContent ?? '').trim() === 'Settings')
      if (settings === undefined) return { error: 'no Settings button' }
      settings.click()
      await sleep(1200)
      const text = document.body.textContent ?? ''
      return { neverClosed: text.includes('never closed'), channel: text.includes('interface') }
    })()`)
    console.log('reports:', JSON.stringify(reports))

    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })
    const name = target.replace(/[^\p{L}\p{N}-]+/gu, '-')
    writeFileSync(new URL(`./results/bare-html-${name}-${String(WIDTH)}.jpeg`, import.meta.url), Buffer.from(shot.result?.data ?? '', 'base64'))
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
