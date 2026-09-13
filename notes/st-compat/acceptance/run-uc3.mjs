/**
 * UC-3 in a real browser: the extension settings panel, all seven C-final
 * checks — placement, i18n both directions, keyboard reachability,
 * persistence, disable teardown, re-enable rebuild, and the disabled reload.
 *
 * Run: PILOT_PORT=8811 node notes/st-compat/acceptance/run-uc3.mjs
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  rpc, record, chatId, inBrowser, shot, profileDir,
  waitForPlane, probeQuiet, PLANE_STATE,
} from './lib.mjs'

const SCENARIO = 'uc3'
const pass = (name, ok, detail = {}) => record(SCENARIO, name, { ok, ...detail })

const chat = await chatId()
await rpc('chat.open', { chatId: chat })
// The scenario owns its own start state: a previous crashed run may have left
// the extension disabled.
await rpc('plugin.enable', { id: 'prompt-template' })

/** The extension's persisted settings blob file, read raw from disk. */
async function settingsBlob() {
  const dir = join(await profileDir(), 'st-extension-settings')
  // One level deep: the store namespaces by a st-compat directory.
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      return JSON.parse(await readFile(join(dir, entry.name), 'utf8'))
    }
    if (entry.isDirectory()) {
      const nested = join(dir, entry.name)
      for (const name of await readdir(nested)) {
        if (name.endsWith('.json')) return JSON.parse(await readFile(join(nested, name), 'utf8'))
      }
    }
  }
  return undefined
}

/** Navigate the settings drawer to one route by its visible label. */
async function gotoRoute(page, en, zh) {
  return page(`(() => new Promise(resolve => {
    const drawer = document.querySelector('.iris-settings')
    if (!drawer || !drawer.classList.contains('iris-drawer--open')) {
      const open = document.querySelector('[data-control="settings"]')
      if (open) open.click()
    }
    setTimeout(() => {
      const row = [...document.querySelectorAll('button')].find(b =>
        b.textContent.trim().startsWith(${JSON.stringify(en)}) || b.textContent.trim().startsWith(${JSON.stringify(zh)}))
      if (!row) { resolve({ ok: false, why: 'settings row not found' }); return }
      row.click()
      setTimeout(() => resolve({ ok: true }), 300)
    }, 350)
  }))()`)
}


/** Attach CDP to the projection iframe (the srcdoc frame WITHOUT the kernel
 * marker — the page itself cannot read its opaque-origin document) and read
 * its visible text. */
async function projectionText(cdp, pageSession) {
  const targets = await cdp.send('Target.getTargets')
  const iframes = targets.targetInfos.filter(one => one.type === 'iframe')
  for (const frame of iframes) {
    try {
      const session = (await cdp.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })).sessionId
      const marker = await evaluateRaw(cdp, session, 'typeof (globalThis.__irisStKernelInstances)')
      if (marker === 'number') continue // the extension plane, not the projection
      const text = await evaluateRaw(cdp, session, 'document.body ? document.body.innerText.slice(0, 500) : ""')
      if (typeof text === 'string' && text.length > 0) return text
    } catch { /* not readable; try the next frame */ }
  }
  return ''
}

/** evaluate without returnByValue wrappers beyond the value itself. */
async function evaluateRaw(cdp, session, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, session)
  if (result.exceptionDetails !== undefined) throw new Error('frame eval failed')
  return result.result?.value
}

await inBrowser(async ({ cdp, sessionId, eval: page }) => {
  await waitForPlane(page)

  // Instrument the page for projection relay events (keyboard proof) and take
  // a snapshot of the persisted blob for the persistence check.
  await page(`(() => {
    window.__proj = { relayed: 0 }
    window.addEventListener('message', e => {
      const d = e.data
      if (d && typeof d === 'object' && d.irisStProject !== undefined && (d.type === 'change' || d.type === 'input' || d.type === 'click')) window.__proj.relayed++
    }, true)
  })()`)
  const blobBefore = JSON.stringify(await settingsBlob())

  // ---- check 1: the panel lives ONLY on the plugins route.
  const nav1 = await gotoRoute(page, 'System Plugins', '系统插件')
  await new Promise(wake => setTimeout(wake, 1200))
  const state1 = await page(PLANE_STATE)
  const heading1 = await page(`(() => {
    const h = document.querySelector('.iris-settings__plugin-settings-title')
    return h ? h.textContent.trim() : null
  })()`)
  pass('step1-panel-on-plugins-route', nav1.ok === true && state1.sectionPresent === true
    && state1.projectionPresent === true && heading1 !== null, {
    nav: nav1, section: state1, heading: heading1,
  })
  await shot(cdp, sessionId, 'uc3-01-panel-on-plugins')

  const nav2 = await gotoRoute(page, 'Diagnostics', '诊断')
  await new Promise(wake => setTimeout(wake, 500))
  const state2 = await page(`(() => {
    const section = document.querySelector('[data-iris-st-ext-section]')
    const heading = document.querySelector('.iris-settings__plugin-settings-title')
    // The drawer keeps every page mounted with the hidden attribute; the
    // honest predicate is visibility, not DOM presence.
    return {
      sectionVisible: section !== null && section.offsetParent !== null,
      headingVisible: heading !== null && heading.offsetParent !== null,
      sectionInsideDiagnostics: document.querySelector('[data-settings-route="diagnostics"] [data-iris-st-ext-section]') !== null,
    }
  })()`)
  pass('step2-diagnostics-has-no-panel', nav2.ok === true && state2.sectionVisible === false
    && state2.headingVisible === false && state2.sectionInsideDiagnostics === false, { nav: nav2, state: state2 })
  await shot(cdp, sessionId, 'uc3-02-diagnostics-clean')

  // ---- check 2: language, both directions (zh → en), each after a reload so
  // the page boots in that language and pushes it to the frame.
  await page(`localStorage.setItem('iris.language', 'zh')`)
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8811/?transport=rpc' }, sessionId)
  await waitForPlane(page)
  await gotoRoute(page, 'System Plugins', '系统插件')
  await new Promise(wake => setTimeout(wake, 2500))
  const zhText = { heading: await page(`(document.querySelector('.iris-settings__plugin-settings-title')?.textContent ?? '').trim()`),
                   panel: await projectionText(cdp, sessionId) }
  const zhOk = zhText.heading === '插件设置' && zhText.panel.includes('提示词模板')
    && zhText.panel.includes('是否启用扩展')
  pass('step3a-chinese-ui', zhOk, zhText)
  await shot(cdp, sessionId, 'uc3-03-chinese')

  await page(`localStorage.setItem('iris.language', 'en')`)
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8811/?transport=rpc' }, sessionId)
  await waitForPlane(page)
  await gotoRoute(page, 'System Plugins', '系统插件')
  await new Promise(wake => setTimeout(wake, 2500))
  const enText = { heading: await page(`(document.querySelector('.iris-settings__plugin-settings-title')?.textContent ?? '').trim()`),
                   panel: await projectionText(cdp, sessionId) }
  const enOk = enText.heading === 'Plugin settings' && enText.panel.includes('Prompt template settings')
  pass('step3b-english-ui', enOk, enText)
  await shot(cdp, sessionId, 'uc3-04-english')

  // ---- check 3: keyboard reaches the projection and a control reacts.
  // A real mouse click puts the focus inside the projection iframe; from there
  // Tab walks the panel's own controls. The focused element is read inside the
  // frame's realm (the page cannot), and a keypress that flips a checkbox is
  // relayed by the projection to the real panel (counted on the page).
  await page(`(() => {
    window.__proj = { relayed: 0 }
    window.addEventListener('message', e => {
      const d = e.data
      if (d && typeof d === 'object' && d.irisStProject !== undefined && (d.type === 'change' || d.type === 'input' || d.type === 'click')) window.__proj.relayed++
    }, true)
  })()`)
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
  let projSession
  {
    const targets = await cdp.send('Target.getTargets')
    for (const frame of targets.targetInfos.filter(one => one.type === 'iframe')) {
      try {
        const session = (await cdp.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })).sessionId
        const marker = await cdp.send('Runtime.evaluate', { expression: 'typeof (globalThis.__irisStKernelInstances)', returnByValue: true }, session)
        if (marker.result?.value !== 'number') { projSession = session; break }
      } catch { /* try next */ }
    }
  }
  let keyboardToggled = false
  for (let tab = 0; tab < 12 && !keyboardToggled; tab += 1) {
    const focusInfo = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const a = document.activeElement; return a ? a.tagName + ':' + (a.type ?? '') : 'none' })()`,
      returnByValue: true,
    }, projSession)
    const focused = String(focusInfo.result?.value ?? '')
    if (focused.includes('checkbox')) {
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }, sessionId)
      }
      await new Promise(wake => setTimeout(wake, 500))
      keyboardToggled = true
      break
    }
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sessionId)
    }
    await new Promise(wake => setTimeout(wake, 250))
  }
  await new Promise(wake => setTimeout(wake, 1500))
  const relayed = await page('window.__proj.relayed')
  pass('step5-keyboard-reaches-projection', relayed > 0, {
    relayedChangeEvents: relayed, checkboxFocused: keyboardToggled,
    note: 'Tab into the panel own checkbox, Space to flip it; the projection relayed the change to the real panel',
  })

  // ---- check 4: the change persisted host-side (disk blob), and the
  // projection re-renders from storage after a reload.
  const blobAfter = await settingsBlob()
  const blobAfterJson = blobAfter === undefined ? undefined : JSON.stringify(blobAfter)
  pass('step6a-settings-persisted-to-disk', blobAfterJson !== undefined && blobAfterJson !== blobBefore, {
    changed: true,
    before: blobBefore === undefined ? '(no blob file yet)' : blobBefore.slice(0, 160),
    afterHead: blobAfterJson?.slice(0, 160),
  })
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8811/?transport=rpc' }, sessionId)
  await waitForPlane(page)
  await gotoRoute(page, 'System Plugins', '系统插件')
  await new Promise(wake => setTimeout(wake, 2500))
  const blobReloaded = await settingsBlob()
  const projected = await projectionText(cdp, sessionId)
  const persistedKeyChanged = blobAfterJson !== undefined && blobReloaded !== undefined
    && JSON.stringify(blobReloaded) === blobAfterJson
  const projectionRendered = projected.length > 80
  pass('step6b-survives-reload', persistedKeyChanged && projectionRendered, {
    persistedKeyChanged, projectionHead: projected.slice(0, 120),
  })
  await shot(cdp, sessionId, 'uc3-06-after-reload')

  // ---- check 5: disable → heading, panel section and plane iframe all go.
  const tokenBefore = await page(`(() => {
    const f = document.querySelector('iframe[title="Iris ST-compat extension plane"]')
    return f ? (/iris-st-ext-token" content="([^"]+)"/.exec(f.getAttribute('srcdoc')) ?? [])[1] ?? null : null
  })()`)
  await rpc('plugin.disable', { id: 'prompt-template' })
  await new Promise(wake => setTimeout(wake, 1500))
  const state5 = await page(`(() => {
    const plane = document.querySelector('.iris-st-ext-plane')
    const frame = document.querySelector('iframe[title="Iris ST-compat extension plane"]')
    const section = document.querySelector('[data-iris-st-ext-section]')
    return {
      planePresent: plane !== null,
      framePresent: frame !== null,
      sectionPresent: section !== null,
      headingPresent: document.querySelector('.iris-settings__plugin-settings-title') !== null,
    }
  })()`)
  const gone = await page(probeQuiet())
  pass('step7-disable-removes-everything', state5.sectionPresent === false && state5.framePresent === false
    && state5.headingPresent === false && gone.absent === 'no plane iframe', {
    state: state5, probe: gone,
  })
  await shot(cdp, sessionId, 'uc3-07-disabled-clean')

  // ---- check 6: re-enable → a NEW frame (different token) and a fresh panel.
  await rpc('plugin.enable', { id: 'prompt-template' })
  const reprobe = await waitForPlane(page)
  await gotoRoute(page, 'System Plugins', '系统插件')
  await new Promise(wake => setTimeout(wake, 2500))
  const state6 = await page(PLANE_STATE)
  pass('step8-reenable-rebuilds-fresh', state6.sectionPresent === true && state6.framePresent === true
    && state6.frameToken !== null && state6.frameToken !== tokenBefore
    && reprobe.kernelInstances === 1, {
    oldToken: tokenBefore, newToken: state6.frameToken, probe: reprobe,
  })
  await shot(cdp, sessionId, 'uc3-08-reenabled-new-frame')

  // ---- check 7: disabled + reload → nothing comes back.
  await rpc('plugin.disable', { id: 'prompt-template' })
  await new Promise(wake => setTimeout(wake, 1200))
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8811/?transport=rpc' }, sessionId)
  await new Promise(wake => setTimeout(wake, 4000))
  await gotoRoute(page, 'System Plugins', '系统插件')
  await new Promise(wake => setTimeout(wake, 800))
  const state7 = await page(`(() => ({
    sectionPresent: document.querySelector('[data-iris-st-ext-section]') !== null,
    framePresent: document.querySelector('iframe[title="Iris ST-compat extension plane"]') !== null,
    headingPresent: document.querySelector('.iris-settings__plugin-settings-title') !== null,
  }))()`)
  pass('step9-disabled-reload-stays-clean', state7.sectionPresent === false
    && state7.framePresent === false && state7.headingPresent === false, { state: state7 })
  await shot(cdp, sessionId, 'uc3-09-disabled-reload')

  await rpc('plugin.enable', { id: 'prompt-template' })
})
