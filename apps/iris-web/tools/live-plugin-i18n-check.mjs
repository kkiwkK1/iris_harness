/**
 * Headless CDP acceptance for plugins' bundled interface copy (U5), modelled
 * line-for-line on `live-plugin-install-check.mjs`: a real Chrome, a real
 * host, a real dev package with `iris.plugin.i18n` on disk. It walks the
 * install form, checks the consent page states the copy (the `i18n` field and
 * the count sentence), confirms, checks the row speaks the bundle's
 * `displayName` and follows the interface language, exercises the served copy
 * URLs over HTTP (rev → `immutable`, no rev → `no-cache`, disable → 404),
 * then uninstalls and asserts the dev directory is untouched.
 *
 * This is a caliper, not a test: it needs a running host and a Chrome binary,
 * so it is not in `npm test`. Screenshots are **not** committed — the
 * acceptance host runs on a copy of a real data directory.
 *
 * Run: node tools/live-plugin-i18n-check.mjs <appPort> <devPackageDir> <outDir>
 *   - the host on <appPort> must run on a *copy* of a data directory
 *     (`host.lock` removed from the copy);
 *   - <devPackageDir> is a directory with `package.json` (`iris.plugin` block,
 *     `id` `demo-copy`), `host.js`, `i18n/en.json`, `i18n/zh.json`;
 *   - CHROME_PATH overrides the binary lookup.
 * @module iris-web/tools/live-plugin-i18n-check
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [appPort, devDir, outDir] = process.argv.slice(2)
if (appPort === undefined || devDir === undefined || outDir === undefined) {
  console.error('usage: node tools/live-plugin-i18n-check.mjs <appPort> <devPackageDir> <outDir>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

const chromePath = [
  process.env['CHROME_PATH'],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(candidate => candidate !== undefined && candidate !== '' && existsSync(candidate))
if (chromePath === undefined) {
  console.error('no Chrome binary found; set CHROME_PATH')
  process.exit(2)
}

const PLUGIN_ID = 'demo-copy'
const devFilesBefore = readdirSync(devDir).sort()
const profile = mkdtempSync(join(tmpdir(), 'iris-plugin-i18n-check-'))
const cdpPort = 9833 + Math.floor(Math.random() * 100)
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,1600',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${String(cdpPort)}`, 'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
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
const exceptions = []
ws.onmessage = event => {
  const frame = JSON.parse(event.data)
  if (frame.id !== undefined && pending.has(frame.id)) {
    const { resolve, reject } = pending.get(frame.id)
    pending.delete(frame.id)
    if (frame.error !== undefined) reject(new Error(frame.error.message))
    else resolve(frame.result)
    return
  }
  if (frame.method === 'Runtime.exceptionThrown') {
    exceptions.push(frame.params?.exceptionDetails?.exception?.description ?? frame.params?.exceptionDetails?.text ?? '?')
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
await send('Runtime.enable')
await send('Page.enable')

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page eval failed: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)}`)
  }
  return result.result.value
}
async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(outDir, name), Buffer.from(result.data, 'base64'))
}
async function waitFor(expression, label, ms = 20000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (await evaluate(expression)) return
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}
const steps = []
let failures = 0
function step(name, value, ok = true) {
  steps.push({ name, value, ok })
  if (!ok) failures++
  console.log(ok ? '[step]' : '[FAIL]', name, JSON.stringify(value))
}

const HELPERS = `window.__h = {
  byText(selector, re) { return [...document.querySelectorAll(selector)].find(el => re.test((el.textContent || '').trim())) },
  click(el) { el.click(); return true },
  setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  },
}; true`
await evaluate(HELPERS)

const ROW = `article.iris-plugin[data-plugin-id="${PLUGIN_ID}"]`
const CONFIRM = /Install this package|安装这个包/

const openPluginsPage = async () => {
  await waitFor(`document.querySelector('button') !== null`, 'the shell to render')
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => /^(settings|设置)$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())); if (!b) throw new Error('no settings button'); return __h.click(b) })()`)
  await waitFor(`document.querySelector('[data-settings-destination="plugins"]') !== null`, 'the settings navigation')
  await evaluate(`__h.click(document.querySelector('[data-settings-destination="plugins"]'))`)
  await waitFor(`document.querySelector('article.iris-plugin[data-plugin-id="tavern-helper"]') !== null`, 'the plugin list')
}

try {
  // ---- 0. pin the interface language so the step expectations are stable --
  await waitFor(`document.querySelector('button') !== null`, 'the shell to render')
  await evaluate(`localStorage.setItem('iris.language', 'en'); true`)
  await send('Page.reload')
  await sleep(1500)
  await evaluate(HELPERS)

  // ---- 1. install form → dev → path → stage -------------------------------
  await openPluginsPage()
  await evaluate(`__h.click(__h.byText('button', /Install a package|安装插件包/))`)
  await waitFor(`document.querySelector('input[name="iris-plugin-install-mode"]') !== null`, 'the install form')
  await evaluate(`__h.click(document.querySelector('input[name="iris-plugin-install-mode"][value="dev"]'))`)
  await sleep(100)
  await evaluate(`__h.setValue(document.querySelector('form input[type="text"]'), ${JSON.stringify(devDir)})`)
  await evaluate(`__h.click(__h.byText('form button[type="submit"]', /Stage and review|暂存/))`)
  await waitFor(`document.querySelector('[data-consent-field]') !== null`, 'the consent page')

  // ---- 2. the consent page states the copy --------------------------------
  const fields = await evaluate(`[...document.querySelectorAll('[data-consent-field]')].map(el => el.dataset.consentField)`)
  step('consent.i18nFieldOnPage', fields, fields.includes('i18n'))
  const copyText = await evaluate(`(document.querySelector('[data-consent-field="i18n"]') || {}).textContent || ''`)
  step('consent.copySentence', copyText, /4 条 · en\/zh|4 strings · en\/zh/.test(copyText))
  await shot('02-consent-i18n.png')

  // ---- 3. confirm → row present, dev --------------------------------------
  await evaluate(`__h.click(__h.byText('button', ${CONFIRM.toString()}))`)
  await waitFor(`document.querySelector('${ROW}') !== null`, 'the installed row')
  const afterConfirm = await evaluate(`(a => ({ source: a.dataset.pluginSource, status: a.dataset.pluginStatus }))(document.querySelector('${ROW}'))`)
  step('row.afterConfirm', afterConfirm, afterConfirm.source === 'dev' && afterConfirm.status === 'disabled')
  await evaluate(`(() => { const a = document.querySelector('${ROW}'); const b = [...a.querySelectorAll('button')].find(b => /^(enable|启用)$/i.test((b.textContent || '').trim())); if (!b) throw new Error('no enable button'); return __h.click(b) })()`)
  await waitFor(`(document.querySelector('${ROW}') || { dataset: {} }).dataset.pluginStatus === 'enabled'`, 'the row to become enabled')
  step('row.enabled', true, true)

  // ---- 4. the row speaks the bundle's displayName, per language -----------
  // The copy arrives one manifest fetch after the row first renders, so the
  // wait IS the assertion: the overlay must land without a reload.
  await waitFor(`(document.querySelector('${ROW}') || { textContent: '' }).textContent.includes('Demo Panel (Live)')`, 'the bundled displayName to reach the row')
  const rowEn = await evaluate(`document.querySelector('${ROW}').querySelector('h4').textContent.trim()`)
  step('row.displayNameEn', rowEn, rowEn.startsWith('Demo Panel (Live)'))

  // Switch the interface language the way a reader does: the stored choice,
  // then a reload — the same path `setLanguage` writes. (A zh machine would
  // already be here; the store above pinned en so both steps are exercised.)
  await evaluate(`localStorage.setItem('iris.language', 'zh'); true`)
  await send('Page.reload')
  await sleep(1500)
  await evaluate(HELPERS)
  await openPluginsPage()
  await waitFor(`(document.querySelector('${ROW}') || { textContent: '' }).textContent.includes('演示面板')`, 'the zh displayName to reach the row')
  const rowZh = await evaluate(`document.querySelector('${ROW}').querySelector('h4').textContent.trim()`)
  step('row.displayNameZh', rowZh, rowZh.startsWith('演示面板'))
  await shot('04-row-zh.png')

  // ---- 5-7. the wire half: rev cache, disable 404, uninstall --------------
  const manifest = await (await fetch(`http://127.0.0.1:${appPort}/plugins/manifest.json`)).json()
  const entry = manifest.plugins[PLUGIN_ID]
  step('manifest.rowHasCopy', entry, entry !== undefined && /^\/plugins\/demo-copy\/i18n\/zh\.json\?rev=[0-9a-f]{12}$/.test(entry.i18n?.zh ?? ''))
  const zhUrl = entry?.i18n?.zh
  if (typeof zhUrl === 'string') {
    const revved = await fetch(`http://127.0.0.1:${appPort}${zhUrl}`)
    step('http.revvedImmutable', { status: revved.status, cache: revved.headers.get('cache-control') }, revved.status === 200 && (revved.headers.get('cache-control') ?? '').includes('immutable'))
    const path = new URL(zhUrl, 'http://127.0.0.1:' + appPort).pathname
    const unrevved = await fetch(`http://127.0.0.1:${appPort}${path}`)
    step('http.unrevvedRevalidates', { status: unrevved.status, cache: unrevved.headers.get('cache-control') }, unrevved.status === 200 && (unrevved.headers.get('cache-control') ?? '').includes('no-cache'))
  }

  // Disable through the row; the copy URL must stop answering.
  await evaluate(`(() => { const a = document.querySelector('${ROW}'); const b = [...a.querySelectorAll('button')].find(b => /^(disable|停用)$/i.test((b.textContent || '').trim())); return b ? __h.click(b) : false })()`)
  await waitFor(`(document.querySelector('${ROW}') || { dataset: {} }).dataset.pluginStatus !== 'enabled'`, 'the row to leave enabled')
  await sleep(500)
  const afterDisable = await (await fetch(`http://127.0.0.1:${appPort}/plugins/manifest.json`)).json()
  step('manifest.rowGoneWhenDisabled', afterDisable.plugins[PLUGIN_ID] ?? null, afterDisable.plugins[PLUGIN_ID] === undefined)
  const disabledStatus = typeof zhUrl === 'string'
    ? await fetch(`http://127.0.0.1:${appPort}${new URL(zhUrl, 'http://127.0.0.1:' + appPort).pathname}`)
    : { status: -1 }
  step('http.copy404WhenDisabled', disabledStatus.status, disabledStatus.status === 404)
  // And the row's own words fall back to the snapshot's name: the manifest
  // dropped the id, the next sync drops the overlay entry.
  await waitFor(`(document.querySelector('${ROW}') || { textContent: '' }).textContent.includes('Demo Copy')`, 'the row to fall back to the snapshot name')

  // Uninstall: row gone, served directory gone, dev tree untouched.
  await evaluate(`(() => { const a = document.querySelector('${ROW}'); const b = [...a.querySelectorAll('button')].find(b => /^(uninstall|卸载)$/i.test((b.textContent || '').trim())); return b ? __h.click(b) : false })()`)
  await waitFor(`document.querySelector('${ROW}') === null`, 'the row to disappear', 30000)
  step('row.goneAfterUninstall', true, true)
  const devFilesAfter = readdirSync(devDir).sort()
  step('dev.dirUntouched', devFilesAfter, JSON.stringify(devFilesAfter) === JSON.stringify(devFilesBefore))
  step('page.noExceptions', exceptions.length, exceptions.length === 0)
  await shot('07-after-uninstall.png')
} catch (error) {
  failures++
  console.error('[fatal]', error instanceof Error ? error.message : String(error))
  await shot('99-fatal.png').catch(() => {})
} finally {
  writeFileSync(join(outDir, 'steps.json'), JSON.stringify(steps, null, 2))
  chrome.kill()
  ws.close()
}
process.exit(failures === 0 ? 0 : 1)
