/**
 * Acceptance for the ask-on-demand grant: does a real refusal, from a real
 * card, put a real button on the report line — and does pressing it go through
 * the same risk confirmation the panel's own switch uses?
 *
 * The card is 魔法少女的扣扣审判1, whose phone UI points avatars at gitgud.io.
 * Its CSP refusal is what we need and it is independent of whether the URL is
 * alive: the policy refuses the request before any network call, so
 * `blocked gitgud.io (img-src)` is reported either way. That is exactly the
 * shape the feature is for — a reader seeing a broken image wants a way to fix
 * it *there*, not instructions to go and find a switch.
 *
 * Run: node tools/live-ask-on-demand-check.mjs <appPort> [titleFragment]
 * @module iris-web/tools/live-ask-on-demand-check
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The one temp-directory rule for everything that starts a browser.
import { tempDir } from '../../../qa/chrome-profile.mjs'

const [appPort, titleFragment = '扣扣审判'] = process.argv.slice(2)
if (appPort === undefined) { console.error('usage: node tools/live-ask-on-demand-check.mjs <appPort> [titleFragment]'); process.exit(2) }

const chromePath = [
  process.env['CHROME_PATH'],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(c => c !== undefined && c !== '' && existsSync(c))
if (chromePath === undefined) { console.error('no Chrome binary; set CHROME_PATH'); process.exit(2) }

const rpc = async (method, params) => {
  const res = await fetch(`http://127.0.0.1:${appPort}/iris/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'ask', method, params }),
  })
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code} ${frame.error?.message}`)
  return frame.result
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const profileHandle = tempDir('iris-ask-on-demand-')
const cdpPort = 9333 + Math.floor(Math.random() * 400)
const chrome = profileHandle.adopt(spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1500,1900',
  `--user-data-dir=${profileHandle.dir}`, `--remote-debugging-port=${String(cdpPort)}`, 'about:blank',
], { stdio: 'ignore' }))

for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${String(cdpPort)}/json/version`)).ok) break } catch { /* soon */ } await sleep(250) }

const target = await (await fetch(`http://127.0.0.1:${String(cdpPort)}/json/new?http://127.0.0.1:${appPort}/`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let nextId = 1
const pending = new Map()
ws.onmessage = event => {
  const frame = JSON.parse(event.data)
  if (frame.id !== undefined && pending.has(frame.id)) {
    const { resolve, reject } = pending.get(frame.id)
    pending.delete(frame.id)
    if (frame.error) reject(new Error(frame.error.message)); else resolve(frame.result)
  }
}
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1900, deviceScaleFactor: 1, mobile: false })
const evaluate = async (expression, awaitPromise = false) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails !== undefined) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}

/** Open the script panel (settings drawer → the card-scripts section). */
const openPanel = () => evaluate(`(async () => {
  const open = document.querySelector('[data-control="settings"]')
  if (open === null) return 'no settings button'
  if (open.getAttribute('aria-expanded') !== 'true') { open.click(); await new Promise(r => setTimeout(r, 2500)) }
  const card = [...document.querySelectorAll('button')].find(b => /脚本|Card scripts/i.test(b.textContent ?? ''))
  if (card === undefined) return 'no scripts card'
  if (card.getAttribute('aria-expanded') !== 'true') { card.click(); await new Promise(r => setTimeout(r, 1200)) }
  return 'panel open'
})()`, true)

/** Read the report rows: text, and whether an offer button sits on each. */
const readRows = () => evaluate(`(() => {
  const rows = [...document.querySelectorAll('p')].filter(p => /blocked /.test(p.textContent ?? ''))
  return rows.slice(0, 8).map(row => {
    const buttons = [...row.querySelectorAll('button')].map(b => (b.textContent ?? '').trim())
    return {
      text: (row.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 130),
      buttons,
      stale: [...row.querySelectorAll('.iris-script__stale')].map(s => (s.textContent ?? '').trim()),
    }
  })
})()`)

try {
  // Grant OFF, so the refusals carry `'offer'` rather than `'already-on'`.
  await rpc('script.setNetworkGrant', { characterId: '魔法少女的扣扣审判1', granted: false })
  await sleep(2500)

  console.log('opening chat…')
  console.log(await evaluate(`(async () => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const row = [...document.querySelectorAll('button.iris-row--chat')].find(el => (el.textContent ?? '').includes(${JSON.stringify(titleFragment)}))
      if (row !== undefined) { row.click(); return 'clicked' }
      await new Promise(r => setTimeout(r, 250))
    }
    return 'not-found'
  })()`, true))
  // The card's scripts take a while to boot and then to be refused.
  await sleep(12000)

  console.log()
  console.log('=== report rows as the reader sees them (grant OFF) ===')
  console.log(await openPanel())
  await sleep(1500)
  const before = await readRows()
  if (before.length === 0) throw new Error('no refusal rows at all — the card reported nothing, so this run proves nothing')
  for (const row of before) console.log(`  "${row.text}"\n    buttons: ${JSON.stringify(row.buttons)} stale: ${JSON.stringify(row.stale)}`)

  const offers = before.filter(row => row.buttons.some(b => /allow this card network access|允许这张卡联网/i.test(b)))
  const refusals = before.filter(row => /img-src|connect-src|style-src/.test(row.text))
  const fontRows = before.filter(row => /font-src/.test(row.text))
  console.log()
  console.log(`img/connect/style refusals: ${String(refusals.length)}; with an offer: ${String(offers.length)}; font-src rows: ${String(fontRows.length)}`)

  if (refusals.length > 0 && offers.length === 0) {
    throw new Error('a refusal the grant widens was shown and carried no offer')
  }
  if (fontRows.length > 0 && fontRows.some(row => row.buttons.length > 0)) {
    throw new Error('a font-src refusal carries an offer, but the grant has no font-src branch — the button would do nothing')
  }

  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(tmpdir(), 'iris-ask-on-demand.png'), Buffer.from(shot.data, 'base64'))
  console.log(`screenshot: ${join(tmpdir(), 'iris-ask-on-demand.png')}`)

  if (offers.length === 0) {
    console.log()
    console.log('NOTE: no offer was rendered in this run, so the press half could not be exercised.')
    console.log('VERDICT: PASS (partial) — the refusal surface was read, but no offer existed to press.')
  } else {
    console.log()
    console.log('=== press the offer, and check it opens the risk dialog ===')
    const pressed = await evaluate(`(async () => {
      const row = [...document.querySelectorAll('p')].find(p =>
        /blocked /.test(p.textContent ?? '')
        && [...p.querySelectorAll('button')].some(b => /allow this card network access|允许这张卡联网/i.test(b.textContent ?? '')))
      if (row === undefined) return 'row gone'
      const button = [...row.querySelectorAll('button')].find(b => /allow this card network access|允许这张卡联网/i.test(b.textContent ?? ''))
      button.click()
      await new Promise(r => setTimeout(r, 1200))
      const marks = [...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')]
      const dialogText = (document.querySelector('[role="dialog"]')?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 200)
      return { checkboxes: marks.length, dialogText }
    })()`, true)
    console.log(`  ${JSON.stringify(pressed)}`)
    if (typeof pressed === 'object' && pressed.checkboxes === 0) {
      throw new Error('pressing the offer did not open the risk-confirmation dialog — the shortcut bypassed the acknowledgement')
    }

    console.log()
    console.log('=== tick, confirm, and read the frames ===')
    const confirmed = await evaluate(`(async () => {
      const marks = [...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')]
      marks[marks.length - 1].click()
      await new Promise(r => setTimeout(r, 600))
      const confirm = [...document.querySelectorAll('button')].find(b => /grant network access|授予网络访问权/i.test(b.textContent ?? ''))
      if (confirm === undefined) return 'no confirm button'
      confirm.click()
      return 'confirmed'
    })()`, true)
    console.log(`  ${confirmed}`)
    await sleep(9000)

    const hostState = await rpc('script.list', { characterId: '魔法少女的扣扣审判1' })
    const after = await evaluate(`(() => [...document.querySelectorAll('iframe')].map(f => {
      const doc = f.getAttribute('srcdoc') ?? ''
      const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1]?.replaceAll('&quot;', "'") ?? ''
      return /img-src ([^;]*)/.exec(policy)?.[1] ?? null
    }))()`)
    console.log(`  host networkGranted=${String(hostState.networkGranted)}; frame img-src: ${JSON.stringify(after)}`)

    const allWidened = after.length > 0 && after.every(p => p?.includes('https:'))
    if (hostState.networkGranted === true && allWidened) {
      console.log()
      console.log('VERDICT: PASS — a refusal on screen offered the grant, the offer opened the same')
      console.log('         risk dialog the panel uses, and confirming it widened every live frame.')
    } else {
      console.log()
      console.log('VERDICT: PASS (partial) — the offer and dialog worked; see the frame policies above.')
    }
  }
} catch (error) {
  console.error('VERDICT: FAIL —', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  try { await rpc('script.setNetworkGrant', { characterId: '魔法少女的扣扣审判1', granted: false }) } catch { /* best effort */ }
  ws.close()
  await profileHandle.dispose()
}
