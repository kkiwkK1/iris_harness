/**
 * Uninstall and data rules: uninstalling removes the extension's iframe, its
 * settings section, its manifest row and its asset routes — while the plugin's
 * stored settings survive per the platform rule, come back on reinstall of the
 * same extension id, and no card, chat, variable or character data is touched.
 *
 * Run: PILOT_PORT=8811 node notes/st-compat/acceptance/run-uninstall.mjs
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  rpc, record, chatId, inBrowser, shot, waitForPlane, probeQuiet,
  installedDir, profileDir,
} from './lib.mjs'

const SCENARIO = 'uninstall'
const pass = (name, ok, detail = {}) => record(SCENARIO, name, { ok, ...detail })
const chat = await chatId()
const PORT = process.env.PILOT_PORT ?? '8811'
const EXT = 'prompt-template'

const tree = await installedDir()
const profile = await profileDir()
const rev = JSON.parse(await readFile(join(tree, 'lock.json'), 'utf8')).artifactSha256.slice(0, 12)
const settingsFile = join(profile, 'st-extension-settings', 'st-compat', `${EXT}.json`)

/** The extension's footprint, read fresh. */
async function footprint() {
  const view = await rpc('chat.open', { chatId: chat })
  const vars = await rpc('script.getVariables', { chatId: chat, scope: 'chat' })
  const chars = await rpc('character.list', {})
  const book = await rpc('worldbook.get', { name: 'pilot-book' })
  let settings
  try { settings = await readFile(settingsFile, 'utf8') } catch { settings = undefined }
  return {
    floorCount: (view.view?.messages ?? []).length,
    lastFloor: String(view.view?.messages?.at(-1)?.text ?? '').slice(0, 60),
    variables: vars.variables,
    characters: (chars.characters ?? []).map(one => one.characterId ?? one.name).sort(),
    bookEntries: (book.entries ?? []).length,
    bookContentHead: String(book.entries?.[0]?.content ?? '').slice(0, 40),
    settings: settings === undefined ? undefined : settings.length,
  }
}

let settingsAfterUninstall
let storedBeforeUninstall
const before = await footprint()
const listBefore = await rpc('plugin.list', {})

await inBrowser(async ({ cdp, sessionId, eval: page }) => {
  await waitForPlane(page)

  // ---- first, produce one real settings save, so "settings survive" has a
  // stored blob to survive with (a fresh profile has none yet).
  await page(`document.querySelector('[data-control="settings"]')?.click()`)
  await new Promise(wake => setTimeout(wake, 500))
  await page(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('System Plugins') || b.textContent.trim().startsWith('系统插件'))?.click()`)
  await new Promise(wake => setTimeout(wake, 4500))
  await page(`document.querySelector('[data-iris-st-ext-section]')?.scrollIntoView({ block: 'center' })`)
  await new Promise(wake => setTimeout(wake, 600))
  const rect = await page(`(() => {
    const frame = document.querySelector('[data-iris-st-ext-section] iframe')
    if (!frame) return null
    const r = frame.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId)
  await new Promise(wake => setTimeout(wake, 400))
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sessionId)
  }
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }, sessionId)
  }
  await new Promise(wake => setTimeout(wake, 1500))
  storedBeforeUninstall = await readFile(settingsFile, 'utf8').catch(() => undefined)
  if (storedBeforeUninstall === undefined) {
    pass('settings-survive-uninstall', false, { why: 'the toggle never persisted; cannot test survival' })
  }

  // ---- uninstall while the page is live: frame, section and manifest row go.
  await rpc('plugin.uninstall', { id: EXT })
  await new Promise(wake => setTimeout(wake, 1500))
  const state = await page(`(() => ({
    framePresent: document.querySelector('iframe[title="Iris ST-compat extension plane"]') !== null,
    sectionPresent: document.querySelector('[data-iris-st-ext-section]') !== null,
  }))()`)
  const gone = await page(probeQuiet())
  const list = await rpc('plugin.list', {})
  const row = list.plugins.find(one => one.id === EXT)
  const topManifest = await (await fetch(`http://127.0.0.1:${PORT}/iris-st-ext/manifest.json`)).json()
  const upstreamAsset = await fetch(`http://127.0.0.1:${PORT}/iris-st-ext/${EXT}/${rev}/scripts/extensions/third-party/ST-Prompt-Template/dist/index.js`)
  const entryAsset = await fetch(`http://127.0.0.1:${PORT}/iris-st-ext/${EXT}/${rev}/script.js`)

  pass('uninstall-removes-frame-section-and-routes', state.framePresent === false && state.sectionPresent === false
    && gone.absent === 'no plane iframe'
    && (row === undefined || row.installed === false)
    && (topManifest.extensions ?? []).length === 0
    && upstreamAsset.status === 404 && entryAsset.status === 404, {
    state, probe: gone, rowAfter: row ?? null,
    topManifestExtensions: topManifest.extensions ?? [],
    upstreamAssetStatus: upstreamAsset.status, entryAssetStatus: entryAsset.status,
    revUrl: `/iris-st-ext/${EXT}/${rev}/...`,
  })
  await shot(cdp, sessionId, 'uninstall-01-gone')

  // ---- the stored settings survive the uninstall (platform rule).
  settingsAfterUninstall = await readFile(settingsFile, 'utf8').catch(() => undefined)
  pass('settings-survive-uninstall', typeof storedBeforeUninstall === 'string'
    && settingsAfterUninstall === storedBeforeUninstall, {
    bytesBefore: storedBeforeUninstall?.length ?? 0,
    bytesAfter: settingsAfterUninstall?.length ?? 0,
  })
})

// ---- nothing else was touched.
const afterUninstall = await footprint()
pass('data-untouched-after-uninstall', JSON.stringify({
  floorCount: afterUninstall.floorCount, variables: afterUninstall.variables,
  characters: afterUninstall.characters, bookEntries: afterUninstall.bookEntries,
  bookContentHead: afterUninstall.bookContentHead,
}) === JSON.stringify({
  floorCount: before.floorCount, variables: before.variables,
  characters: before.characters, bookEntries: before.bookEntries,
  bookContentHead: before.bookContentHead,
}), { before: { ...before, settings: undefined }, after: { ...afterUninstall, settings: undefined } })

// ---- reinstall the same extension id: the stored settings come back.
await rpc('stExtension.install', { path: 'E:/sillyTavern/SillyTavern/public/scripts/extensions/third-party/ST-Prompt-Template' })
await rpc('plugin.enable', { id: EXT })
const listAfter = await rpc('plugin.list', {})
const afterSettings2 = await readFile(settingsFile, 'utf8').catch(() => undefined)

await inBrowser(async ({ cdp, sessionId, eval: page }) => {
  const probe = await waitForPlane(page)
  pass('reinstall-restores-settings-and-plane', probe.ejsPublished === true && probe.kernelInstances === 1
    && storedBeforeUninstall !== undefined && afterSettings2 === storedBeforeUninstall
    && listAfter.plugins.find(one => one.id === EXT)?.status === 'enabled', {
    settingsRestored: storedBeforeUninstall !== undefined && afterSettings2 === storedBeforeUninstall,
    frameHealth: probe,
    rows: listAfter.plugins.map(p => `${p.id}:${p.status}`),
  })
  await shot(cdp, sessionId, 'uninstall-02-reinstalled')
})
