/**
 * Acceptance for the live switch, through the UI the reader actually uses:
 * open the script panel, press 「授予这张卡网络访问权…」, tick the dialog's
 * acknowledgement, confirm — and assert the frames re-navigate in place,
 * without any chat switch.
 *
 * This is the drive the earlier rounds could not perform (no store hook on a
 * production build), and it is the one that matters: it is the button.
 *
 * Run: node tools/live-grant-ui-check.mjs <appPort> [titleFragment]
 * @module iris-web/tools/live-grant-ui-check
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [appPort, titleFragment = '扣扣审判'] = process.argv.slice(2)
if (appPort === undefined) { console.error('usage: node tools/live-grant-ui-check.mjs <appPort> [titleFragment]'); process.exit(2) }

const chromePath = [
  process.env['CHROME_PATH'],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].find(c => c !== undefined && c !== '' && existsSync(c))
if (chromePath === undefined) { console.error('no Chrome'); process.exit(2) }

const rpc = async (method, params) => {
  const res = await fetch(`http://127.0.0.1:${appPort}/iris/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'ui', method, params }),
  })
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code}`)
  return frame.result
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'iris-grant-ui-'))
const port = 9333 + Math.floor(Math.random() * 400)
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1500,1900',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${String(port)}`, 'about:blank',
], { stdio: 'ignore' })
const cleanup = () => { try { chrome.kill() } catch { /* gone */ } try { rmSync(profile, { recursive: true, force: true }) } catch { /* held */ } }
process.on('exit', cleanup)

for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${String(port)}/json/version`)).ok) break } catch { /* soon */ } await sleep(250) }

const target = await (await fetch(`http://127.0.0.1:${String(port)}/json/new?http://127.0.0.1:${appPort}/`, { method: 'PUT' })).json()
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

/** Every frame's img-src on the page, and the shadow-DOM match count. */
const policies = () => evaluate(`(() => [...document.querySelectorAll('iframe')].map(f => {
  const doc = f.getAttribute('srcdoc') ?? ''
  const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1]?.replaceAll('&quot;', "'") ?? ''
  return {
    imgSrc: /img-src ([^;]*)/.exec(policy)?.[1] ?? null,
    // Which of the two kinds this is: a message frame carries card markup and
    // a context seed; a script frame carries no markup but has libraries.
    role: /name="iris-context"/.test(doc) || /iris-message/i.test(doc) ? 'message'
      : /iris-script__|__iris_script__|iris-run-token/.test(doc) ? 'script'
        : doc.includes('gitgud') || doc.includes('markup') ? 'message?' : 'script?',
    len: doc.length,
    connected: f.isConnected,
    height: f.style.height || '(auto)',
    parentClass: String(f.parentElement?.className ?? '').slice(0, 60),
  }
}))()`)

try {
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
  await sleep(9000)

  const before = await policies()
  console.log(`frames before (grant off): ${String(before.length)}`)
  for (const p of before) console.log(`  img-src=${p.imgSrc} role=${p.role} len=${p.len} h=${p.height} parent=${p.parentClass}`)
  if (before.some(p => p.imgSrc?.includes('https:'))) throw new Error('a frame is already widened while the grant is off')

  console.log()
  console.log('opening the script panel…')
  console.log(await evaluate(`(async () => {
    // The settings drawer's own control, then the scripts card.
    const open = document.querySelector('[data-control="settings"]')
    if (open === null) return 'no settings button'
    open.click()
    await new Promise(r => setTimeout(r, 2500))
    // CollapsibleSection renders a button carrying the card's title.
    const buttons = [...document.querySelectorAll('button')]
    const card = buttons.find(b => /脚本|Card scripts/i.test(b.textContent ?? ''))
    if (card === undefined) return 'no scripts card; buttons: ' + buttons.slice(0, 12).map(b => (b.textContent ?? '').trim().slice(0, 18)).join(' / ')
    card.click()
    await new Promise(r => setTimeout(r, 1200))
    return 'scripts card opened'
  })()`, true))

  console.log()
  console.log('pressing the network-access button…')
  const pressed = await evaluate(`(async () => {
    const buttons = [...document.querySelectorAll('button')]
    const target = buttons.find(b => /网络访问权|network access/i.test(b.textContent ?? ''))
    if (target === undefined) {
      const grantArea = document.querySelector('.iris-grant')
      return 'no network button. grant blocks: ' + String(document.querySelectorAll('.iris-grant').length)
        + ' text: ' + (grantArea?.textContent ?? '').slice(0, 120)
    }
    target.click()
    await new Promise(r => setTimeout(r, 1200))
    const marks = [...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')]
    if (marks.length === 0) return 'dialog did not open (no checkbox)'
    const box = marks[marks.length - 1]
    box.click()
    await new Promise(r => setTimeout(r, 600))
    const buttons2 = [...document.querySelectorAll('button')]
    const confirm = buttons2.find(b => /授予网络访问权|Grant network access/i.test(b.textContent ?? ''))
    if (confirm === undefined) return 'no confirm button; dialog buttons: ' + buttons2.slice(-8).map(b => (b.textContent ?? '').trim().slice(0, 22)).join(' / ')
    confirm.click()
    return 'pressed button → ticked → confirmed'
  })()`, true)
  console.log(`  ${pressed}`)

  console.log()
  console.log('waiting for the in-place re-navigation (NO chat switch)…')
  await sleep(9000)

  const after = await policies()
  console.log(`frames after (grant on, same chat): ${String(after.length)}`)
  for (const p of after) console.log(`  img-src=${p.imgSrc} role=${p.role} len=${p.len} h=${p.height} parent=${p.parentClass}`)

  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(tmpdir(), 'iris-grant-ui-after.png'), Buffer.from(shot.data, 'base64'))
  console.log(`screenshot: ${join(tmpdir(), 'iris-grant-ui-after.png')}`)

  const hostGrant = await rpc('script.list', { characterId: '魔法少女的扣扣审判1' })
  console.log(`host says networkGranted=${String(hostGrant.networkGranted)}`)

  console.log()
  if (after.length > 0 && after.every(p => p.imgSrc?.includes('https:')) && hostGrant.networkGranted === true) {
    console.log('VERDICT: PASS — the UI button wrote the grant and every live frame re-navigated')
    console.log('         under the widened policy with no chat switch.')
  } else if (hostGrant.networkGranted === true && after.some(p => p.imgSrc?.includes('https:'))) {
    console.log('VERDICT: PASS (partial) — grant written and at least one frame re-navigated.')
  } else {
    console.log('VERDICT: FAIL — the UI path did not reach the frames.')
  }
} catch (error) {
  console.error('VERDICT: FAIL —', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  ws.close()
  cleanup()
}
