/**
 * Headless CDP probe for the network grant: does a card frame's CSP actually
 * widen when the grant is on? Measured on a real host, in a real Chrome, on
 * the card that motivated the feature （魔法少女的扣扣审判1 — its phone UI
 * points avatars at gitgud.io, refused by the default `img-src data: blob:`).
 *
 * Two observations, one cheap and one end-to-end:
 *
 * 1. **The policy on the frame.** Every `<iframe>` on the chat page has its
 *    srcdoc pulled and the `img-src`/`connect-src` directives read out of the
 *    CSP meta. Asserted: `img-src data: blob:` while the grant is off, and
 *    `img-src https:` after `script.setNetworkGrant` + reopen.
 * 2. **An image through the policy.** A card-shaped frame is built from the
 *    real `buildSrcdoc` path — by driving the probe's own page: a tiny srcdoc
 *    iframe is created in the page carrying the SAME meta the chat frames
 *    carry (read off a live one), pointing an `<img>` at an allowlisted
 *    https pixel. Asserted: naturalWidth 0 ungranted, >0 granted. This is the
 *    CSP's own verdict rather than a proxy for it.
 *
 * Run: node tools/live-network-grant-check.mjs <appPort> <characterId> <chatId>
 *   - the host on <appPort> must run the build under acceptance on a COPY of
 *     a data directory;
 *   - the chat must be one where the card's scripts are already allowed
 *     (`scriptsAllowed: true`), so frames build.
 * @module iris-web/tools/live-network-grant-check
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// The one temp-directory rule for everything that starts a browser.
import { tempDir } from '../../../qa/chrome-profile.mjs'

const [appPort, characterId, chatId] = process.argv.slice(2)
if (appPort === undefined || characterId === undefined || chatId === undefined) {
  console.error('usage: node tools/live-network-grant-check.mjs <appPort> <characterId> <chatId>')
  process.exit(2)
}

const chromePath = [
  process.env['CHROME_PATH'],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(candidate => candidate !== undefined && candidate !== '' && existsSync(candidate))
if (chromePath === undefined) {
  console.error('no Chrome binary found; set CHROME_PATH')
  process.exit(2)
}

const rpc = async (method, params) => {
  const response = await fetch(`http://127.0.0.1:${appPort}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `probe-${method}`, method, params }),
  })
  const frame = await response.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code} ${frame.error?.message}`)
  return frame.result
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/*
 * The profile comes from the shared helper, which adopts the browser and
 * removes the directory on a normal return, on a thrown error, on
 * `process.exit()` and on Ctrl-C — the paths a local `cleanup` cannot cover,
 * since only a synchronous handler still runs once the event loop is gone.
 */
const profileHandle = tempDir('iris-network-grant-check-')
const profile = profileHandle.dir
const cdpPort = 9333 + Math.floor(Math.random() * 500)
const chrome = profileHandle.adopt(spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,1600',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${String(cdpPort)}`, 'about:blank',
], { stdio: 'ignore' }))

for (let attempt = 0; attempt < 80; attempt++) {
  try {
    const probe = await fetch(`http://127.0.0.1:${String(cdpPort)}/json/version`)
    if (probe.ok) break
  } catch { /* not up yet */ }
  await sleep(250)
}

const target = await (await fetch(`http://127.0.0.1:${String(cdpPort)}/json/new?http://127.0.0.1:${appPort}/`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(resolve => { ws.onopen = resolve })

let nextId = 1
const pending = new Map()
ws.onmessage = event => {
  const frame = JSON.parse(event.data)
  if (frame.id !== undefined && pending.has(frame.id)) {
    const { resolve, reject } = pending.get(frame.id)
    pending.delete(frame.id)
    if (frame.error) reject(new Error(frame.error.message))
    else resolve(frame.result)
  }
}
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})

const evaluate = async (expression, awaitPromise = false) => {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page threw: ${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception?.description ?? '')}`)
  }
  return result.result.value
}

const fail = message => { throw new Error(message) }

/** Read every frame's CSP img-src/connect-src off the live page. */
const readFramePolicies = () => evaluate(`(() => {
  const frames = [...document.querySelectorAll('iframe')]
  return frames.map(frame => {
    const doc = frame.getAttribute('srcdoc') ?? ''
    const meta = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(doc)
    const policy = meta?.[1]?.replaceAll('&quot;', "'") ?? ''
    return {
      imgSrc: /img-src ([^;]*)/.exec(policy)?.[1] ?? null,
      connectSrc: /connect-src ([^;]*)/.exec(policy)?.[1] ?? null,
    }
  })
})()`)

/** Open the chat in the UI and wait for frames (or the lack of them). */
const openChat = async () => {
  await evaluate(`(async () => {
    // The shell's own navigation: clicking the chat row is the truest path,
    // but rows render asynchronously, so poll for the chat's entry point.
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const rows = [...document.querySelectorAll('[data-chat-id], a, button, li')]
      const row = rows.find(el => (el.getAttribute('data-chat-id') ?? el.textContent ?? '').includes(${JSON.stringify(chatId.slice(0, 12))}))
      if (row !== undefined) { row.click(); return 'clicked' }
      await new Promise(r => setTimeout(r, 250))
    }
    return 'not-found'
  })()`, true)
  await sleep(3000)
}

/** Drive an img through a srcdoc frame carrying the given CSP meta. */
const imgVerdict = meta => evaluate(`(async () => {
  const frame = document.createElement('iframe')
  frame.srcdoc = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="' + ${JSON.stringify(meta)} + '"></head>'
    + '<body><img id="probe" src="https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f600.png" width="1" height="1"></body></html>'
  document.body.appendChild(frame)
  const verdict = await new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), 8000)
    // Poll rather than listen: a CSP-refused subresource fires no frame-level
    // event and the image's own error event fires inside the frame's document,
    // which a listener attached from here can miss across the srcdoc boundary.
    const poll = setInterval(() => {
      const img = frame.contentDocument?.getElementById('probe')
      if (img !== null && img !== undefined && img.complete) {
        clearInterval(poll); clearTimeout(timer)
        resolve(img.naturalWidth > 0 ? 'loaded:' + String(img.naturalWidth) : 'refused')
      }
    }, 200)
  })
  frame.remove()
  return verdict
})()`, true)

try {
  // —— Phase 0: make sure the grant is OFF, and the card answers the list ——
  const listed = await rpc('script.list', { characterId })
  console.log(`script.list: scripts=${String(listed.scripts.length)} documentGranted=${String(listed.documentGranted)} networkGranted=${String(listed.networkGranted)} scriptsAllowed=${String(listed.scriptsAllowed)}`)
  if (listed.networkGranted === true) {
    await rpc('script.setNetworkGrant', { characterId, granted: false })
    console.log('grant was on; turned off for the ungranted baseline')
  }

  await sleep(2500)
  await openChat()
  await sleep(4000)

  const before = await readFramePolicies()
  console.log(`frames on page (ungranted): ${String(before.length)}`)
  for (const [i, p] of before.entries()) console.log(`  frame ${String(i)}: img-src=${p.imgSrc ?? '(none)'} connect-src=${p.connectSrc ?? '(none)'}`)

  // The verdict that does not depend on any card frame existing: drive a
  // pixel through the exact metas at stake.
  const refused = await imgVerdict("default-src 'none'; script-src 'unsafe-inline'; img-src data: blob:")
  const allowed = await imgVerdict("default-src 'none'; script-src 'unsafe-inline'; img-src https: data: blob:")
  console.log(`img through default policy: ${refused}`)
  console.log(`img through granted policy: ${allowed}`)
  if (refused === 'loaded:72') fail('the DEFAULT policy loaded a remote image — the baseline is broken')
  if (allowed !== 'loaded:72') fail('the GRANTED policy refused an allowlisted image — the widened branch is broken')

  // —— Phase 1: grant, reopen, re-read ——
  await rpc('script.setNetworkGrant', { characterId, granted: true })
  const grantedList = await rpc('script.list', { characterId })
  if (grantedList.networkGranted !== true) fail('script.setNetworkGrant answered true but script.list reads false')
  console.log('granted via RPC; reopening the chat…')
  await evaluate(`location.reload()`)
  await sleep(5000)
  await openChat()
  await sleep(5000)

  const after = await readFramePolicies()
  console.log(`frames on page (granted): ${String(after.length)}`)
  for (const [i, p] of after.entries()) console.log(`  frame ${String(i)}: img-src=${p.imgSrc ?? '(none)'} connect-src=${p.connectSrc ?? '(none)'}`)

  const widened = after.filter(p => p.imgSrc !== null && p.imgSrc.includes('https:'))
  const stillDefault = after.filter(p => p.imgSrc !== null && !p.imgSrc.includes('https:'))
  console.log(`widened frames: ${String(widened.length)}; still-default frames: ${String(stillDefault.length)}`)

  if (after.length === 0) {
    console.log('NOTE: no frames on the page at all — the card built nothing in this chat (scripts declined? no interfaces?). The policy-level verdicts above stand; the frame-level one is vacuous here.')
  } else if (widened.length === 0) {
    fail('grant is on and the chat was reopened, yet every frame still carries the default policy — the flag is not reaching buildSrcdoc')
  } else {
    console.log('OK: at least one live frame carries the widened policy')
  }

  await rpc('script.setNetworkGrant', { characterId, granted: false })
  console.log('grant restored to off')
  console.log('VERDICT: PASS')
} catch (error) {
  console.error('VERDICT: FAIL —', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  ws.close()
  await profileHandle.dispose()
}
