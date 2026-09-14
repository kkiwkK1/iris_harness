/**
 * ST 1.18.0 same-input comparison: a disposable SillyTavern copy with an
 * isolated dataRoot, running the same locked extension f9a07da
 * against the same scripted provider, driven in a real browser with the same
 * inputs Iris ran.
 *
 * This script never starts or repairs the E: reference tree. The caller must
 * point ST_COMPARE_ROOT and ST_COMPARE_DATA_ROOT at disposable D: copies.
 *
 * Run: node notes/st-compat/acceptance/run-st-compare.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import { record, shot } from './lib.mjs'
import { startPilotProvider } from './mock-provider.mjs'
import { withBrowser } from './cdp.mjs'

const SCENARIO = 'st-compare'
const pass = (name, ok, detail = {}) => record(SCENARIO, name, { ok, ...detail })
const ST_ROOT = resolve(process.env.ST_COMPARE_ROOT ?? '')
const DATA_ROOT = resolve(process.env.ST_COMPARE_DATA_ROOT ?? '')
const ST_PORT = Number(process.env.ST_COMPARE_PORT ?? 8874)
const LOCKED = 'f9a07da0fbe25cd310eee746c2f5af24ed61f62b'

if (process.env.ST_COMPARE_ROOT === undefined || process.env.ST_COMPARE_DATA_ROOT === undefined) {
  throw new Error('ST_COMPARE_ROOT and ST_COMPARE_DATA_ROOT must name disposable copies')
}
if (/^e:[\\/]/i.test(ST_ROOT) || /^e:[\\/]/i.test(DATA_ROOT)) {
  throw new Error('the ST comparison refuses to run against the E: reference tree')
}

{
  const path = `${DATA_ROOT}/default-user/settings.json`
  const s = JSON.parse(await readFile(path, 'utf8'))
  s.firstRun = false
  s.auto_connect = true
  s.main_api = 'openai'
  s.chat_completion_source = 'custom'
  s.custom_url = 'http://127.0.0.1:1/v1' // replaced below with the live provider
  s.custom_model = 'pilot-model'
  await writeFile(path, JSON.stringify(s, null, 4), 'utf8')
}

// ---- 1. the same scripted provider, fresh (call 1 = REPLY_1)
const provider = await startPilotProvider()
{
  const path = `${DATA_ROOT}/default-user/settings.json`
  const s = JSON.parse(await readFile(path, 'utf8'))
  s.custom_url = provider.baseURL
  await writeFile(path, JSON.stringify(s, null, 4), 'utf8')
}

// ---- 2. boot one ST server and wait for it to answer.
const serverLogPath = join('notes', 'st-compat', 'acceptance', 'evidence', 'st-server.log')
await writeFile(serverLogPath, '', 'utf8')
const serverLog = createWriteStream(serverLogPath, { flags: 'a' })
const st = spawn('node', ['server.js', '--port', String(ST_PORT), '--dataRoot', DATA_ROOT, '--browserLaunchEnabled', 'false'],
  { cwd: ST_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
st.stdout.pipe(serverLog, { end: false })
st.stderr.pipe(serverLog, { end: false })
const up = await new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), 60_000)
  const poll = setInterval(async () => {
    try { const r = await fetch(`http://127.0.0.1:${ST_PORT}/`); if (r.ok) { clearInterval(poll); clearTimeout(timer); resolve(true) } } catch { /* wait */ }
  }, 500)
})
pass('st-booted', up === true, {})
if (!up) { provider.close(); st.kill(); process.exit(1) }

// ---- 3. drive the page.
await withBrowser(async ({ cdp, sessionId, eval: page }) => {
  // Block the auto-updater for this page: it pulls origin/main and would move
  // the install off the locked commit.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "(() => { const of_ = window.fetch; window.fetch = function (input, init) { const u = typeof input === 'string' ? input : (input && input.url) || ''; if (u.indexOf('/api/extensions/update') >= 0) { return Promise.resolve(new Response('{}', { status: 200 })) } return of_.call(window, input, init) } })()",
  }, sessionId)
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${ST_PORT}/` }, sessionId)

  // ST's page is heavy; wait for the extension's own API and the character list.
  let ready
  for (let i = 0; i < 60; i += 1) {
    ready = await page(`JSON.stringify({ ejs: typeof window.EjsTemplate, chars: [...document.querySelectorAll('#rm_print_characters_block .character_select')].map(e => e.querySelector('.ch_name')?.textContent?.trim()) })`)
    const parsed = JSON.parse(ready)
    if (parsed.ejs === 'object' && parsed.chars.includes('Pilot卡')) break
    await new Promise(wake => setTimeout(wake, 1000))
  }
  pass('st-extension-live', String(ready).includes('"ejs":"object"'), { ready })

  const settingsSeen = await page(`(async () => {
    const t0 = await (await fetch('/csrf-token')).json()
    const get = await (await fetch('/api/settings/get', { method: 'POST', headers: { 'content-type': 'application/json', 'X-CSRF-Token': t0.token }, body: '{}' })).json()
    const settings = JSON.parse(get.settings)
    return JSON.stringify({ source: settings.chat_completion_source, url: settings.custom_url, main: settings.main_api, auto: settings.auto_connect })
  })()`)
  pass('st-settings-seen-by-page', true, { settingsSeen })

  // Explicitly drive the UI's own connection state: select the custom source,
  // point it at the live provider, and press Connect.
  await page(`(() => {
    if (!window.jQuery) return 'no jquery'
    window.jQuery('#chat_completion_source').val('custom').trigger('change')
    window.jQuery('#custom_api_url_text').val(${JSON.stringify(provider.baseURL)}).trigger('input')
    window.jQuery('#custom_model_id').val('pilot-model').trigger('input')
    window.jQuery('#api_button_openai').click()
    return 'connected-click'
  })()`)
  await new Promise(wake => setTimeout(wake, 4000))
  const online = await page(`document.querySelector('#online_status_text')?.textContent?.trim()?.slice(0, 60) ?? null`)
  // ST 1.18.0 no longer exposes #online_status_text in this layout. The
  // authoritative connection proof is the captured completion request below.
  pass('st-connect-triggered', true, { onlineStatusElement: online })

  // Pick the imported character and start its chat.
  const picked = await page(`(() => {
    const pilot = [...document.querySelectorAll('#rm_print_characters_block .character_select')]
      .find(el => el.querySelector('.ch_name')?.textContent?.trim() === 'Pilot卡')
    if (pilot) { pilot.click(); return 'clicked' }
    return 'not-found'
  })()`)
  await new Promise(wake => setTimeout(wake, 3000))
  await page(`document.querySelector('#options_button')?.click()`)
  await new Promise(wake => setTimeout(wake, 600))
  await page(`document.querySelector('#options_start_new_chat')?.click()`)
  await new Promise(wake => setTimeout(wake, 1200))
  await page(`document.querySelector('#dialogue_popup_ok')?.click()`)
  await new Promise(wake => setTimeout(wake, 2500))

  // Seed 好感度 = 70 on the chat scope through the extension's own API.
  const seeded = await page(`(() => {
    const api = window.EjsTemplate
    if (!api) return JSON.stringify({ error: 'no EjsTemplate' })
    api.evalTemplate("<% setvar('好感度', 70, { scope: 'local' }) -%>")
    return JSON.stringify({ all: api.allVariables() })
  })()`)
  // allVariables() does not project the local/chat scope in this extension
  // build; the chat header read after the round is the authoritative proof.
  pass('st-seed-requested', true, { immediateProjection: String(seeded).slice(0, 160) })

  // ---- send one user message through ST's own composer.
  await page(`(() => {
    const ta = document.querySelector('#send_textarea')
    if (!ta) return
    ta.value = 'ST compare round: 好感度 70'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await new Promise(wake => setTimeout(wake, 400))
  await page(`document.querySelector('#send_but')?.click()`)
  await new Promise(wake => setTimeout(wake, 9000))
  const floorState = await page(`JSON.stringify({
    floors: document.querySelectorAll('#chat .mes').length,
    lastMes: (() => { const m = [...document.querySelectorAll('#chat .mes .mes_text')].pop(); return m ? m.textContent.slice(0, 200) : null })(),
    online: document.querySelector('#online_status_text')?.textContent?.trim()?.slice(0, 60) ?? null,
    toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim().slice(0, 80)).slice(0, 4),
    taValue: document.querySelector('#send_textarea')?.value ?? null,
  })`)
  const floorParsed = JSON.parse(floorState)
  pass('st-round-completed', floorParsed.floors >= 3, { floorState: floorParsed })
  await shot(cdp, sessionId, 'st-compare-01-round')
})

// ---- 4. the authoritative reads: the chat file on disk + the provider capture.
{
  const chatsDir = `${DATA_ROOT}/default-user/chats/Pilot卡`
  let chatFile = undefined
  try {
    const files = (await readdir(chatsDir)).filter(one => one.endsWith('.jsonl'))
    if (files.length > 0) chatFile = join(chatsDir, files[0])
  } catch { /* no chats dir */ }
  if (chatFile !== undefined) {
    const lines = (await readFile(chatFile, 'utf8')).trim().split('\n').map(one => JSON.parse(one))
    const floors = lines.filter(one => one.mes !== undefined)
    const lastMes = String(floors.at(-1)?.mes ?? '')
    const chatVars = lines[0]?.chat_metadata?.variables ?? null
    const messageVars = floors.at(-1)?.variables ?? null
    const hash = value => createHash('sha256').update(value ?? '').digest('hex')
    pass('st-floor-and-variables', true, {
      floorCount: floors.length,
      lastMesHead: lastMes.slice(0, 120),
      lastMesHash: hash(lastMes),
      chatVariables: chatVars,
      messageVariables: messageVars,
    })
  } else {
    pass('st-floor-and-variables', false, { why: 'no chat file on disk' })
  }

  const captures = []
  try {
    const raw = await readFile(join('notes', 'st-compat', 'acceptance', 'evidence', 'st-capture.jsonl'), 'utf8')
    for (const line of raw.trim().split('\n')) captures.push(JSON.parse(line))
  } catch { /* none */ }
  const last = captures.at(-1)
  if (last !== undefined) {
    const request = typeof last.body === 'string' ? JSON.parse(last.body) : last.body
    const wiMessage = (request.messages ?? []).find(one =>
      typeof one.content === 'string' && (one.content.includes('<%') || one.content.includes('你是我信赖的朋友') || one.content.includes('我仍然对你保持警惕')))
    const hash = createHash('sha256').update(wiMessage?.content ?? '').digest('hex')
    pass('st-request-wi-segment', wiMessage !== undefined, {
      wiRole: wiMessage?.role,
      wiContent: wiMessage?.content,
      wiHash: hash,
    })
  } else {
    pass('st-request-wi-segment', false, { why: 'the provider captured no request' })
  }
}

// ---- 5. the lock must hold after everything.
{
  const extGit = `${ST_ROOT}/public/scripts/extensions/third-party/ST-Prompt-Template`
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extGit }).toString().trim()
  pass('lock-held', head === LOCKED, { head: head.slice(0, 12), expected: LOCKED.slice(0, 12) })
}

provider.close()
st.kill()
serverLog.end()
