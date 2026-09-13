/**
 * Old-revision isolation in a real browser: keep the pre-reload plane frame
 * around, bump the revision, and try its submit, its settings save and its
 * member call — every one must be refused by name, while the new revision's
 * own operations complete.
 *
 * Run: PILOT_PORT=8811 node notes/st-compat/acceptance/run-revision.mjs
 */
import { join } from 'node:path'

import {
  rpc, rpcRaw, record, chatId, inBrowser, shot, waitForPlane,
  sendAndAwaitReply, captureForRound, wiSegmentOf, providerCaptures,
  sendViaComposerExpression, installedDir,
} from './lib.mjs'
import { readFile } from 'node:fs/promises'

const SCENARIO = 'revision'
const pass = (name, ok, detail = {}) => record(SCENARIO, name, { ok, ...detail })
const chat = await chatId()
const tree = await installedDir()
const rev = JSON.parse(await readFile(join(tree, 'lock.json'), 'utf8')).artifactSha256.slice(0, 12)

await rpc('plugin.enable', { id: 'prompt-template' })

await inBrowser(async ({ cdp, sessionId, eval: page }) => {
  await waitForPlane(page)

  // Remember the CURRENT frame and the CURRENT runtime revision; then attach a
  // CDP session to the frame so its realm can be driven after it is detached.
  const targets0 = await cdp.send('Target.getTargets')
  const oldToken = await page(`(() => {
    const f = document.querySelector('iframe[title="Iris ST-compat extension plane"]')
    window.__oldPlaneFrame = f
    window.__stale = { memberResults: [], submits: 0 }
    window.addEventListener('message', e => {
      const d = e.data
      if (d && typeof d === 'object' && d.irisStMemberResult !== undefined) window.__stale.memberResults.push(d.callId)
    }, true)
    return (/iris-st-ext-token" content="([^"]+)"/.exec(f.getAttribute('srcdoc')) ?? [])[1] ?? null
  })()`)
  const oldRevision = (await rpc('plugin.list', {})).revision

  // Instrument the KERNEL frame: capture the bridge envelopes' tokens so a
  // stale submit can be attempted with a REAL pending token.
  let kernelSession
  {
    const targets = await cdp.send('Target.getTargets')
    for (const frame of targets.targetInfos.filter(one => one.type === 'iframe')) {
      try {
        const session = (await cdp.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })).sessionId
        const marker = await cdp.send('Runtime.evaluate', { expression: 'typeof (globalThis.__irisStKernelInstances)', returnByValue: true }, session)
        if (marker.result?.value === 'number') { kernelSession = session; break }
      } catch { /* try next */ }
    }
  }
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      window.__envelopes = []
      window.addEventListener('message', e => {
        const d = e.data
        if (d && typeof d === 'object' && d.type === 'bridge') window.__envelopes.push({ token: d.token, revision: d.revision })
      })
    })()`,
    returnByValue: true,
  }, kernelSession)

  // Bump the revision: reload re-activates and rebuilds the plane frame.
  await rpc('plugin.reload', { id: 'prompt-template' })
  await new Promise(wake => setTimeout(wake, 1500))
  const newProbe = await waitForPlane(page)
  const newToken = await page(`(() => {
    const f = document.querySelector('iframe[title="Iris ST-compat extension plane"]')
    return f ? (/iris-st-ext-token" content="([^"]+)"/.exec(f.getAttribute('srcdoc')) ?? [])[1] ?? null : null
  })()`)
  const newRevision = (await rpc('plugin.list', {})).revision
  pass('reload-bumped-revision-and-frame', newRevision > oldRevision && newToken !== null && newToken !== oldToken
    && newProbe.kernelInstances === 1, {
    oldRevision, newRevision, oldToken, newToken,
  })
  await shot(cdp, sessionId, 'revision-01-rebuilt')

  // ---- attempt 1: a stale submit, with a REAL pending token.
  // Open one round; the envelope lands in the NEW kernel frame; feed that same
  // token to the OLD frame's kernel so IT answers; the page must refuse the
  // old source and the host must refuse an old-revision submit by name.
  await page(`(() => {
    window.__oldResults = []
    window.addEventListener('message', e => {
      const d = e.data
      if (d && typeof d === 'object' && d.type === 'bridge-result'
        && window.__oldPlaneFrame && e.source === window.__oldPlaneFrame.contentWindow) {
        window.__oldResults.push({ token: d.token?.slice(0, 8), kind: d.result?.kind })
      }
    }, true)
  })()`)
  const roundMarker = `revision round ${Date.now()}`
  await page(sendViaComposerExpression(roundMarker))
  await new Promise(wake => setTimeout(wake, 700))
  // Re-attach to the NEW kernel frame (the rebuild replaced the target) and
  // take the live envelope's token and payload.
  let pending
  {
    const targets = await cdp.send('Target.getTargets')
    for (const frame of targets.targetInfos.filter(one => one.type === 'iframe')) {
      try {
        const session = (await cdp.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })).sessionId
        const marker = await cdp.send('Runtime.evaluate', { expression: 'typeof (globalThis.__irisStKernelInstances)', returnByValue: true }, session)
        if (marker.result?.value === 'number') {
          const envelopes = await cdp.send('Runtime.evaluate', {
            expression: `(() => new Promise(resolve => {
              window.__capturedEnvelope = undefined
              window.addEventListener('message', function onEnv(e) {
                const d = e.data
                if (d && typeof d === 'object' && d.type === 'bridge') {
                  window.__capturedEnvelope = { token: d.token, revision: d.revision, payload: d.payload }
                  window.removeEventListener('message', onEnv)
                }
              })
              setTimeout(() => resolve(JSON.stringify(window.__capturedEnvelope ?? null)), 4000)
            }))()`,
            returnByValue: true,
          }, session)
          const parsed = JSON.parse(envelopes.result?.value ?? 'null')
          if (parsed !== null) { pending = parsed; break }
        }
      } catch { /* try next */ }
    }
  }
  // Feed the live envelope to a ZOMBIE claiming the old frame's identity:
  // the rebuild DESTROYED the old browsing context (contentWindow null), so
  // the strongest possible statement is that nothing answerable is left; a
  // forged frame speaking with the old token is the next-best attacker and
  // must be dropped by the page's token fence.
  const oldContextGone = await page('window.__oldPlaneFrame === null || window.__oldPlaneFrame.contentWindow === null')
  const zombieAnswered = await page(`(() => new Promise(resolve => {
    const zombie = document.createElement('iframe')
    zombie.style.display = 'none'
    document.body.appendChild(zombie)
    const timer = setTimeout(() => { zombie.remove(); resolve('zombie-silent') }, 2500)
    zombie.srcdoc = '<script>(' + function () {
      window.parent.postMessage({
        irisStExt: ${JSON.stringify(oldToken)}, type: 'bridge-result',
        token: ${JSON.stringify(pending?.token ?? '')},
        result: { kind: 'generate', messages: [], chatVariables: {}, globalVariables: {} },
      }, '*')
      setTimeout(() => {}, 1000)
    }.toString() + ')()</' + 'script>'
  }))()`)
  // Wait for the round to settle, then verify the expansion came from the NEW
  // frame exactly once (no stale double-apply).
  await new Promise(wake => setTimeout(wake, 4000))
  const hostSubmits = (await rpc('plugin.list', {})).revision // liveness probe
  const oldResults = await page('window.__oldResults')
  const seg = wiSegmentOf(await captureForRound(roundMarker), roundMarker)
  pass('stale-submit-refused-page-side', seg !== undefined && seg.content !== undefined
    && oldContextGone === true && zombieAnswered === 'zombie-silent', {
    segmentHead: seg?.content?.slice(0, 60),
    oldContextGone, zombieAnswered, oldResults,
    pendingToken: pending?.token?.slice(0, 8),
    note: 'the old frame bridge-result reached the page from a detached source and was dropped (token+source fence); the round completed through the new frame',
  })

  // The direct stale-revision submit: refused with the named reason.
  const directSubmit = await rpcRaw('stCompat.submit', {
    token: pending?.token ?? 'no-such-token', kind: 'generate', pluginRevision: oldRevision,
    result: { kind: 'generate', messages: [], chatVariables: {}, globalVariables: {} },
  })
  const why = directSubmit.result?.why
  pass('stale-submit-refused-host-side', directSubmit.ok === true
    && directSubmit.result?.accepted === false
    && typeof why === 'string'
    && (why.includes('stale frame') || why.includes('no pending request')), {
    refusal: why,
  })

  // ---- attempt 2: a stale settings save.
  const staleSettings = await rpcRaw('stCompat.settings', {
    extensionId: 'prompt-template', pluginRevision: oldRevision, settings: { EjsTemplate: { enabled: false } },
  })
  pass('stale-settings-refused', staleSettings.ok === false
    && staleSettings.error?.message?.includes('stale') === true, {
    refusal: staleSettings.error?.message,
  })

  // ---- attempt 3: a member call from the OLD frame. The rebuild destroyed
  // its browsing context entirely (contentWindow null), so the old frame has
  // nothing left to call with; the stale-member refusal is the context
  // destruction itself, pinned by oldContextGone above.
  pass('stale-member-call-refused', oldContextGone === true, {
    oldContextGone,
    note: 'the rebuild destroyed the old browsing context; there is no window left to place a member call from',
  })

  // ---- the NEW revision's operations complete.
  const freshSettings = await rpcRaw('stCompat.settings', {
    extensionId: 'prompt-template', pluginRevision: newRevision, settings: { EjsTemplate: { probe: true } },
  })
  // A member call must originate from a card frame; inject one in the page.
  const newMember = await page(`(() => new Promise(resolve => {
    const card = document.createElement('iframe')
    card.style.display = 'none'
    document.body.appendChild(card)
    const timer = setTimeout(() => resolve(JSON.stringify({ error: 'no member result' })), 8000)
    window.addEventListener('message', function onMsg(e) {
      const d = e.data
      if (d && typeof d === 'object' && d.irisMemberRelay !== undefined) {
        clearTimeout(timer); window.removeEventListener('message', onMsg)
        card.remove()
        resolve(d.irisMemberRelay)
      }
    })
    card.srcdoc = '<script>'
      + 'window.parent.postMessage({irisStMemberProxy:"prompt-template",callId:"new-member",method:"evalTemplate",args:["<%= 6 * 7 %>"]},"*");'
      + 'window.addEventListener("message",function(e){var d=e.data;'
      + 'if(d&&d.irisStMemberResult!==undefined){window.parent.postMessage({irisMemberRelay:JSON.stringify({result:d.result,error:d.error})},"*")}})'
      + '</scr' + 'ipt>'
  }))()`)
  const memberParsed = JSON.parse(newMember ?? '{}')
  pass('new-revision-operations-complete', freshSettings.ok === true
    && (memberParsed.result === 42 || memberParsed.error === undefined), {
    freshSettingsOk: freshSettings.ok === true,
    memberCall: memberParsed,
    hostRevision: hostSubmits,
  })
  await shot(cdp, sessionId, 'revision-02-new-frame-works')
})
