/**
 * Headless CDP acceptance for the system-plugin install UI (PR-3 of
 * `docs/SYSTEM-PLUGIN-INSTALL.md`): a real Chrome, a real host, a real
 * package on disk. It opens the settings drawer, walks to 系统插件, stages a
 * `dev` package through the install form, checks the consent page renders
 * every preview field, confirms, enables the row, then uninstalls it and
 * asserts the row is gone and the dev directory untouched.
 *
 * This is a caliper, not a test: it needs a running host and a Chrome binary,
 * so it is not in `npm test`. `check:render` and the jsdom click-through in
 * `tests/plugin-center-install.test.ts` are the re-runnable gates; this script
 * is the once-per-release evidence that the two of them describe the page a
 * browser actually paints. Its output (`steps.json` plus screenshots) goes
 * into a dated `notes/PLUGIN-INSTALL-ACCEPTANCE-*.md`; the screenshots are
 * **not** committed, because the acceptance host runs on a copy of a real data
 * directory and the shell paints that directory's chats behind the drawer.
 *
 * Run: node tools/live-plugin-install-check.mjs <appPort> <devPackageDir> <outDir>
 *   - the host on <appPort> must be started from the build under acceptance,
 *     on a *copy* of a data directory (one host per data directory since #72);
 *   - <devPackageDir> is a directory with `package.json` (`iris.plugin` block,
 *     `id` `livedemo`), `host.js` and `client.js`;
 *   - CHROME_PATH overrides the binary lookup.
 * @module iris-web/tools/live-plugin-install-check
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The one temp-directory rule for everything that starts a browser.
import { chromeProfile } from '../../../qa/chrome-profile.mjs'

const [appPort, devDir, outDir] = process.argv.slice(2)
if (appPort === undefined || devDir === undefined || outDir === undefined) {
  console.error('usage: node tools/live-plugin-install-check.mjs <appPort> <devPackageDir> <outDir>')
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

const devFilesBefore = readdirSync(devDir).sort()
const profile = chromeProfile('iris-plugin-install-check-')
const cdpPort = 9333 + Math.floor(Math.random() * 500)
const chrome = profile.adopt(spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,1600',
  `--user-data-dir=${profile.dir}`, `--remote-debugging-port=${String(cdpPort)}`, 'about:blank',
], { stdio: 'ignore' }))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
for (let attempt = 0; attempt < 80; attempt++) {
  try {
    const probe = await fetch(`http://127.0.0.1:${String(cdpPort)}/json/version`)
    if (probe.ok) break
  } catch {
    // not up yet
  }
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
  if (frame.method === 'Runtime.exceptionThrown') exceptions.push(frame.params?.exceptionDetails?.text ?? '?')
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

// Helpers injected into the page. `setValue` goes through the native setter
// so React sees the change; a plain `.value =` assignment does not fire its
// tracker.
await evaluate(`window.__h = {
  byText(selector, re) { return [...document.querySelectorAll(selector)].find(el => re.test((el.textContent || '').trim())) },
  click(el) { el.click(); return true },
  setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  },
}; true`)

const ROW = `article.iris-plugin[data-plugin-id="livedemo"]`
const CONFIRM = /Install this package|安装这个包/
const CANCEL = /^(Cancel|取消)$/

await waitFor(`document.querySelector('button') !== null`, 'the shell to render')
await shot('00-shell.png')

// 1. Settings → 系统插件
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => /^(settings|设置)$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())); if (!b) throw new Error('no settings button'); return __h.click(b) })()`)
await waitFor(`document.querySelector('[data-settings-destination="plugins"]') !== null`, 'the settings navigation')
await evaluate(`__h.click(document.querySelector('[data-settings-destination="plugins"]'))`)
await waitFor(`document.querySelector('article.iris-plugin[data-plugin-id="tavern-helper"]') !== null`, 'the plugin list')
const builtins = await evaluate(`[...document.querySelectorAll('article.iris-plugin')].map(a => a.dataset.pluginId + ':' + a.dataset.pluginSource + ':' + a.dataset.pluginStatus)`)
step('list.builtins', builtins, builtins.some(row => row.startsWith('tavern-helper:builtin:')))
await shot('01-plugin-list.png')

// 2. Install form → dev → path → stage
await evaluate(`__h.click(__h.byText('button', /Install a package|安装插件包/))`)
await waitFor(`document.querySelector('input[name="iris-plugin-install-mode"]') !== null`, 'the install form')
await evaluate(`__h.click(document.querySelector('input[name="iris-plugin-install-mode"][value="dev"]'))`)
await sleep(100)
const textInputs = await evaluate(`[...document.querySelectorAll('form input[type="text"]')].length`)
step('form.devModeShowsOnePathInput', textInputs, textInputs === 1)
await evaluate(`__h.setValue(document.querySelector('form input[type="text"]'), ${JSON.stringify(devDir)})`)
await shot('02-install-form-dev.png')
await evaluate(`__h.click(__h.byText('form button[type="submit"]', /Stage and review|暂存/))`)
await waitFor(`document.querySelector('[data-consent-field]') !== null`, 'the consent page')

// 3. Consent page: every preview field except previewToken, and the standing sentences.
const fields = await evaluate(`[...document.querySelectorAll('[data-consent-field]')].map(el => el.dataset.consentField)`)
const expectedDevFields = ['id', 'displayName', 'description', 'version', 'apiVersion', 'supportedApiVersions', 'compatible', 'source', 'path', 'treeHash', 'fileCount', 'sizeBytes', 'capabilities', 'permissions', 'dependencies', 'hasClient', 'warnings']
const missing = expectedDevFields.filter(name => !fields.includes(name))
step('consent.fields', fields, missing.length === 0 && fields.length >= expectedDevFields.length)
if (missing.length > 0) step('consent.missingFields', missing, false)
const permissionsText = await evaluate(`(document.querySelector('[data-consent-field="permissions"]') || {}).textContent || ''`)
step('consent.permissionsListsDeclared', permissionsText.includes('provide-capability'), permissionsText.includes('provide-capability'))
step('consent.permissionsSaysNotABoundary', /不是 Iris 强制的边界|not a boundary/.test(permissionsText), /不是 Iris 强制的边界|not a boundary/.test(permissionsText))
const sourceText = await evaluate(`(document.querySelector('[data-consent-field="source"]') || {}).textContent || ''`)
step('consent.sourceMarkedDev', sourceText, /dev/.test(sourceText))
const confirmDisabled = await evaluate(`(__h.byText('button', ${CONFIRM.toString()}) || { disabled: 'absent' }).disabled`)
step('consent.confirmEnabledForCompatible', confirmDisabled, confirmDisabled === false)
step('consent.cancelPresent', await evaluate(`__h.byText('button', ${CANCEL.toString()}) !== undefined`), true)
await shot('03-consent-dev.png')

// 4. Confirm → row present, disabled, badged dev
await evaluate(`__h.click(__h.byText('button', ${CONFIRM.toString()}))`)
await waitFor(`document.querySelector('${ROW}') !== null`, 'the installed row')
const afterConfirm = await evaluate(`(a => ({ source: a.dataset.pluginSource, status: a.dataset.pluginStatus, badge: (a.querySelector('[data-plugin-source]') || a).textContent.slice(0, 80) }))(document.querySelector('${ROW}'))`)
step('row.afterConfirm', afterConfirm, afterConfirm.source === 'dev' && afterConfirm.status === 'disabled' && /dev/.test(afterConfirm.badge))
await shot('04-row-installed.png')

// 5. Enable from the row
await evaluate(`(() => { const a = document.querySelector('${ROW}'); const b = [...a.querySelectorAll('button')].find(b => /^(enable|启用)$/i.test((b.textContent || '').trim())); if (!b) throw new Error('no enable button: ' + [...a.querySelectorAll('button')].map(b => b.textContent.trim()).join('|')); return __h.click(b) })()`)
await waitFor(`(document.querySelector('${ROW}') || { dataset: {} }).dataset.pluginStatus === 'enabled'`, 'the row to become enabled')
step('row.enabled', await evaluate(`document.querySelector('${ROW}').dataset.pluginStatus`), true)
const rowText = await evaluate(`document.querySelector('${ROW}').textContent`)
step('row.showsProvenance', /树哈希|tree hash/i.test(rowText) && /目录|directory/i.test(rowText), /树哈希|tree hash/i.test(rowText) && /目录|directory/i.test(rowText))
await shot('05-row-enabled.png')

// 6. Disable → uninstall → row gone, dev directory untouched
await evaluate(`(() => { const a = document.querySelector('${ROW}'); const b = [...a.querySelectorAll('button')].find(b => /^(disable|停用)$/i.test((b.textContent || '').trim())); return b ? __h.click(b) : false })()`)
await waitFor(`(document.querySelector('${ROW}') || { dataset: {} }).dataset.pluginStatus !== 'enabled'`, 'the row to leave enabled')
await evaluate(`(() => { const a = document.querySelector('${ROW}'); const b = [...a.querySelectorAll('button')].find(b => /^(uninstall|卸载)$/i.test((b.textContent || '').trim())); if (!b) throw new Error('no uninstall button'); return __h.click(b) })()`)
await waitFor(`document.querySelector('${ROW}') === null`, 'the row to go')
step('list.afterUninstall', await evaluate(`[...document.querySelectorAll('article.iris-plugin')].map(a => a.dataset.pluginId)`), true)
const devFilesAfter = readdirSync(devDir).sort()
step('dev.directoryUntouched', devFilesAfter, JSON.stringify(devFilesAfter) === JSON.stringify(devFilesBefore))
await shot('06-after-uninstall.png')

step('page.exceptions', exceptions, exceptions.length === 0)
writeFileSync(join(outDir, 'steps.json'), JSON.stringify(steps, null, 2))
ws.close()
chrome.kill()
await profile.dispose()
console.log(failures === 0 ? 'live plugin install check: ok' : `live plugin install check: ${String(failures)} step(s) failed`)
process.exit(failures === 0 ? 0 : 1)
