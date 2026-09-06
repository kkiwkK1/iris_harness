/**
 * Task R acceptance: the drawer's folded cards, their memory, the new keys and
 * the credential statement — driven against a live host on 8814.
 * Usage: node qa/r-cards-check.mjs [baseURL]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import { openDrawerExpr } from './locators.mjs'

const BASE = process.argv[2] ?? process.env.IRIS_BASE ?? 'http://127.0.0.1:8814'
// Default CDP port is offset by the pid: two runs back to back would
// otherwise fight over one debug port, and the loser dies as
// "chrome never came up" — which reads as a broken environment, not as a
// collision. An explicit CDP_PORT is honoured verbatim (see qa/README.md).
const CDP_PORT = Number(process.env.CDP_PORT ?? 9341) + (process.env.CDP_PORT === undefined ? process.pid % 100 : 0)
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const outDir = new URL('./results/r-cards/', import.meta.url)
mkdirSync(outDir, { recursive: true })

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${process.env.TEMP}/iris-qa-cdp-${CDP_PORT}-${Date.now()}`,
  '--no-first-run', '--no-default-browser-check', '--headless=new',
  '--window-size=1680,1050', 'about:blank',
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
  /*
   * The masthead's last button, confirmed by `.iris-drawer--open` — not by its
   * label. `Masthead.tsx` gives it no `aria-label` and no id, so the old
   * `aria-label === 'Settings'` arm never matched and the run depended entirely
   * on the English text arm beside it. This script sets the language itself, so
   * it was not the one that broke; the locator was still keyed on a translation.
   */
  const openDrawer = async () => {
    const r = await evaluate(openDrawerExpr)
    await delay(600)
    return r?.opened === true ? 'ok' : (r?.error ?? 'no settings button')
  }
  const cardState = () => evaluate(`(() => {
    const cards = [...document.querySelectorAll('.iris-card')]
    return cards.map(card => ({
      title: card.querySelector('.iris-card__title')?.textContent ?? '',
      summary: card.querySelector('.iris-card__summary')?.textContent ?? '',
      open: card.querySelector('.iris-card__head')?.getAttribute('aria-expanded') === 'true',
      bodyHidden: card.querySelector('.iris-card__body')?.hidden ?? null,
    }))
  })()`)
  const toggleCard = async title => evaluate(`(() => {
    const head = [...document.querySelectorAll('.iris-card__head')].find(h => h.querySelector('.iris-card__title')?.textContent === ${JSON.stringify(title)})
    if (head === undefined) return 'no card'
    head.click()
    return 'ok'
  })()`)

  await nav(`${BASE}/`)
  await evaluate('localStorage.clear()')
  await evaluate('localStorage.setItem("iris.language", "en")')
  await nav(`${BASE}/`)
  check('drawer opens', await openDrawer() === 'ok')

  // ---- The default: connection and reading open, the rest folded.
  let cards = await cardState()
  const titles = cards.map(c => c.title)
  // Eight on this host: the scripts card exists only under an open chat with a
  // character, and this fresh host has neither.
  check('eight cards render with no chat open', cards.length === 8, titles.join(' | '))
  const openByDefault = cards.filter(c => c.open).map(c => c.title)
  check('connection and reading stand open by default',
    openByDefault.includes('Connection') && openByDefault.includes('Reading') && openByDefault.length === 2,
    openByDefault.join(' | '))
  check('folded cards hide their bodies and open cards show them',
    cards.every(c => c.open === !c.bodyHidden),
    'aria-expanded must agree with hidden')

  // ---- Summaries read while folded.
  const summaryOf = title => cards.find(c => c.title === title)?.summary ?? ''
  check('route summary names the route', /·/.test(summaryOf('Route')), summaryOf('Route'))
  check('sampling summary says the host defaults', summaryOf('Sampling') === 'host defaults', summaryOf('Sampling'))
  check('replies summary names the separator', summaryOf('Replies').includes('continue'), summaryOf('Replies'))
  check('about summary names the three things', summaryOf('General & about').includes('credentials'), summaryOf('General & about'))

  // ---- Toggle: open Sampling and Replies, close Reading. The store remembers.
  await toggleCard('Sampling')
  await toggleCard('Replies')
  await toggleCard('Reading')
  cards = await cardState()
  check('sampling is open after the click', cards.find(c => c.title === 'Sampling')?.open === true)
  check('reading is folded after the click', cards.find(c => c.title === 'Reading')?.open === false)

  // ---- Reload: the state survives.
  await nav(`${BASE}/`)
  await openDrawer()
  cards = await cardState()
  check('sampling survives the reload', cards.find(c => c.title === 'Sampling')?.open === true)
  check('replies survives the reload', cards.find(c => c.title === 'Replies')?.open === true)
  check('reading stays folded after the reload', cards.find(c => c.title === 'Reading')?.open === false)

  // ---- The three reply keys, from the UI to the host and back.
  const setTrim = await evaluate(`(async () => {
    const card = [...document.querySelectorAll('.iris-card')].find(c => c.querySelector('.iris-card__title')?.textContent === 'Replies')
    // The trim is the card's first toggle; its pressed state may be either way
    // (a host setting persists across runs), so flip whatever is showing and
    // expect the host to end at the new value.
    const toggle = [...card.querySelectorAll('button')].find(b => b.getAttribute('aria-pressed') !== null)
    if (toggle === undefined) return 'no toggle'
    const was = toggle.getAttribute('aria-pressed') === 'true'
    toggle.click()
    await new Promise(r => setTimeout(r, 600))
    const get = await fetch('/iris/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'ui1', method: 'settings.get', params: {} }) }).then(r => r.json())
    return { host: get?.result?.settings?.trimSentences, was }
  })()`)
  check('trim toggle reaches the host', setTrim?.host === !setTrim?.was, `host says ${String(setTrim?.host)}, was ${String(setTrim?.was)}`)
  // And the summary agrees with the host, whichever way the flip landed.
  cards = await cardState()
  const trimNow = await evaluate(`fetch('/iris/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'ui2', method: 'settings.get', params: {} }) }).then(r => r.json()).then(f => f?.result?.settings?.trimSentences === true)`)
  check('replies summary tracks the trim',
    (cards.find(c => c.title === 'Replies')?.summary ?? '').includes('trim') === (trimNow === true),
    `summary ${(cards.find(c => c.title === 'Replies')?.summary ?? '')} vs host ${String(trimNow)}`)

  // ---- Floors: the reading preference flips the document attribute.
  const floors = await evaluate(`(async () => {
    const card = [...document.querySelectorAll('.iris-card')].find(c => c.querySelector('.iris-card__title')?.textContent === 'Reading')
    if (card === undefined) return 'no reading card'
    card.querySelector('.iris-card__head').click()
    await new Promise(r => setTimeout(r, 300))
    const before = document.documentElement.getAttribute('data-iris-floors')
    const toggle = [...card.querySelectorAll('button')].find(b => b.getAttribute('aria-pressed') !== null && b.textContent.trim() === 'Off')
    if (toggle === undefined) return 'no floors toggle'
    toggle.click()
    await new Promise(r => setTimeout(r, 600))
    return { before, after: document.documentElement.getAttribute('data-iris-floors') }
  })()`)
  check('floors toggle flips the document attribute',
    floors?.before === 'off' && floors?.after === 'on', JSON.stringify(floors))

  // ---- The credential statement and the transfer buttons are in the about card.
  const about = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.iris-card')].find(c => c.querySelector('.iris-card__title')?.textContent === 'General & about')
    if (card === undefined) return null
    card.querySelector('.iris-card__head').click()
    return {
      credential: card.textContent.includes('no RPC ever returns one'),
      transport: card.textContent.includes('transport boundary'),
      exportButton: [...card.querySelectorAll('button')].some(b => b.textContent.includes('Export settings')),
      importButton: [...card.querySelectorAll('button')].some(b => b.textContent.includes('Import settings')),
      startup: card.textContent.includes('Open the most recent conversation'),
    }
  })()`)
  check('about card carries the credential statement', about?.credential === true)
  check('about card carries the transport sentence', about?.transport === true)
  check('about card carries export and import', about?.exportButton === true && about?.importButton === true)
  check('about card carries the startup switch', about?.startup === true)

  // ---- The zh half of every new string.
  await evaluate('localStorage.setItem("iris.language", "zh")')
  await nav(`${BASE}/`)
  await openDrawer()
  const zhCards = await cardState()
  const zhTitles = zhCards.map(c => c.title)
  check('zh card titles render', zhTitles.includes('连接') && zhTitles.includes('回复') && zhTitles.includes('通用与关于'), zhTitles.join(' | '))
  const zhAbout = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.iris-card')].find(c => c.querySelector('.iris-card__title')?.textContent === '通用与关于')
    if (card === undefined) return null
    card.querySelector('.iris-card__head').click()
    return {
      credential: card.textContent.includes('任何 RPC 都不会回显'),
      trim: [...document.querySelectorAll('.iris-card')].some(c => c.querySelector('.iris-card__title')?.textContent === '回复' && c.textContent.includes('裁剪未完成的句子')),
    }
  })()`)
  check('zh credential statement renders', zhAbout?.credential === true)
  check('zh reply keys render', zhAbout?.trim === true)

  await shot('r-cards-final')
} finally {
  chrome.kill()
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
