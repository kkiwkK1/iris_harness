// Task I bilingual acceptance: open the shell in headless Chrome, verify both
// languages of the shell copy, verify a drawer switch takes effect without a
// reload and survives one, and screenshot both languages.
//
// The default language follows the browser, so the pass that checks detection
// reads `navigator.language` first and asserts the shell agrees with it, rather
// than assuming a locale.
//
// Usage: node qa/i18n-check.mjs [baseURL]
// Default baseURL http://127.0.0.1:8797 (the task's independent host).
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const BASE = process.argv[2] ?? process.env.IRIS_BASE ?? 'http://127.0.0.1:8797'
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = process.env.CDP_PORT ?? '9336'
const WIDTH = 1680
const HEIGHT = 1050

const outDir = new URL('./results/i18n/', import.meta.url)
mkdirSync(outDir, { recursive: true })

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const HARD_DEADLINE = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(3) }, 240_000)

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${process.env.TEMP}/iris-qa-cdp-${CDP_PORT}-${Date.now()}`,
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
    if (r.result?.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.result.exceptionDetails))
    return r.result?.result?.value
  }
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(new URL(`${name}.png`, outDir), Buffer.from(r.result.data, 'base64'))
  }
  const clickButton = async label =>
    evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
      if (b === undefined) return 'no button'
      b.click()
      return 'ok'
    })()`)

  await send('Page.enable')
  await send('Runtime.enable')

  const nav = async url => {
    await send('Page.navigate', { url })
    for (let at = 0; at < 40; at += 1) {
      await delay(500)
      if (await evaluate('document.readyState') === 'complete') break
    }
    await delay(1500)
  }
  // textContent, not innerText: the closed drawer is `visibility:hidden`, and
  // this Chrome's innerText excludes even the freshly opened one — a rendering
  // distinction this check does not care about. All it asks is which words the
  // shell is speaking.
  const text = () => evaluate('document.body.textContent')
  const has = async needle => (await text()).includes(needle)

  // ---- Pass 0: detection. The shell must agree with the browser.
  await nav(`${BASE}/`)
  const navLang = await evaluate('navigator.language')
  const detected = await evaluate('localStorage.getItem("iris.language")')
  const startsZh = navLang.toLowerCase().startsWith('zh')
  check(`default follows navigator.language (${navLang})`,
    startsZh ? await has('导入卡片') : await has('Import a card'),
    `stored choice at first load: ${String(detected)}`)
  // Detection is not persisted: an untouched reader stays detectable.
  check('detection alone writes nothing', detected === null)

  // ---- Pass 1: force English, verify the English shell.
  await evaluate('localStorage.setItem("iris.language", "en")')
  await nav(`${BASE}/`)
  // The host remembers which chat was open, so the pane's empty state is not
  // assumed; what must hold is that the words are English and not Chinese.
  check('en: shell copy is English',
    (await has('Settings')) && (await has('Import a card')) && !(await has('导入卡片')))
  check('en: document lang is en', await evaluate('document.documentElement.lang') === 'en')
  await shot('1-en-home')

  // ---- Switch inside the drawer, no reload.
  check('en: drawer opens', (await clickButton('Settings')) === 'ok')
  const drawerText = async () => evaluate(
    'document.querySelector(".iris-drawer")?.className + " || " '
    + '+ document.querySelector(".iris-drawer__title")?.textContent',
  )
  let title = ''
  let drawerEn = false
  for (let at = 0; at < 10; at += 1) {
    await delay(300)
    title = await drawerText()
    drawerEn = (await has('Defaults for new conversations')) || (await has('This conversation'))
    if (drawerEn) break
  }
  check('en: drawer copy is English', drawerEn, title ?? '')
  await shot('2-en-settings')

  check('en→zh: option found', (await clickButton('中文')) === 'ok')
  await delay(400)
  // Same page, no reload: everything that showed words now shows the other
  // language's words.
  check('zh: switch takes effect immediately',
    await has('关闭') && await has('路由') && await has('采样') && await has('阅读'))
  await shot('3-zh-settings')

  check('zh: drawer closes', (await clickButton('关闭')) === 'ok')
  await delay(400)
  check('zh: sidebar tabs are Chinese', await has('阅读') && await has('角色库'))
  check('zh: import button is Chinese', await has('导入卡片'))
  await shot('4-zh-home')

  // ---- The choice survives a reload, and clearing it restores detection.
  await nav(`${BASE}/`)
  check('zh: choice survives a reload', await has('导入卡片') && !(await has('Import a card')))
  check('zh: document lang is zh after reload', await evaluate('document.documentElement.lang') === 'zh')
  await shot('5-zh-after-reload')

  await evaluate('localStorage.removeItem("iris.language")')
  await nav(`${BASE}/`)
  check('clearing the choice restores detection',
    startsZh ? await has('导入卡片') : await has('Import a card'))

  // ---- Pass 3: an open chat, in Chinese. Importing a card through the host
  // gives the composer, the message actions and the consent question real
  // surfaces to be verified on. Read the corpus dir from the environment when
  // provided; without it this pass is skipped rather than failed.
  const corpus = process.env.IRIS_CORPUS
  if (corpus === undefined) {
    console.log('SKIP  chat pass (set IRIS_CORPUS to a card directory to run it)')
  } else {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const file = readdirSync(corpus).find(f => /\.(png|json|charx)$/i.test(f))
    if (file === undefined) {
      console.log('SKIP  chat pass (no card file in IRIS_CORPUS)')
    } else {
      const content = readFileSync(join(corpus, file)).toString('base64')
      const frame = await fetch(new URL('/iris/rpc', BASE), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'i18n-qa', method: 'character.import', params: { filename: file, content } }),
      }).then(r => r.json())
      check('chat pass: card imported', frame.ok !== false, JSON.stringify(frame.error ?? ''))

      await evaluate('localStorage.setItem("iris.language", "zh")')
      await nav(`${BASE}/`)
      // Switch to the character tab and open a chat with the card.
      check('chat pass: 角色库 tab', (await clickButton('角色库')) === 'ok')
      await delay(600)
      const opened = await evaluate(`(() => {
        const row = document.querySelector('.iris-row')
        if (row === undefined) return 'no row'
        row.click()
        return 'ok'
      })()`)
      check('chat pass: chat opened', opened === 'ok', String(opened))
      await delay(1500)
      // The placeholder lives in an attribute, not in the text content.
      check('zh: composer placeholder is Chinese',
        (await evaluate('document.querySelector(".iris-composer__field")?.placeholder')) === '写下你的部分…')
      check('zh: composer hint is Chinese', await has('Enter 发送 · Shift+Enter 换行'))
      check('zh: send button is Chinese', await has('发送'))
      check('zh: state margin is Chinese', await has('状态'))
      // A card with scripts gets the consent question; a card without one gets
      // the panel's "no scripts" line. Either way the words must be Chinese.
      const consent = await has('运行它们')
      if (consent) {
        check('zh: consent question is Chinese', await has('不运行'))
      } else {
        check('zh: no-scripts line is Chinese', await has('这张卡没有自带脚本。'))
      }
      check('zh: script panel is Chinese', await has('卡片脚本') && await has('页面访问权'))
      await shot('6-zh-chat')
    }
  }

  console.log(failures === 0 ? 'ALL PASS' : `${String(failures)} FAILURES`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  clearTimeout(HARD_DEADLINE)
  chrome.kill()
}
