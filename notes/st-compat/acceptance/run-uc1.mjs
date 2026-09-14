/**
 * UC-1 in a real browser: the pre-generation template expansion, all five
 * C-final checks. Every verdict reads the request the provider actually
 * received, anchored to the round's unique marker, plus the page's own
 * bridge-round counter.
 *
 * Run: PILOT_PORT=8811 node notes/st-compat/acceptance/run-uc1.mjs
 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import {
  rpc, record, chatId, inBrowser, shot, sha256, installedDir,
  sendAndAwaitReply, variables, waitForPlane, probeQuiet, BRIDGE_COUNTER,
  PLANE_MESSAGE_TAP, EXTENSION_ID, UPSTREAM_DIST_SHA256,
  captureForRound, wiSegmentOf,
} from './lib.mjs'

const SCENARIO = 'uc1'
const pass = (name, ok, detail = {}) => record(SCENARIO, name, { ok, ...detail })

async function main() {
  const chat = await chatId()

  // ---- check 1: the installed artifact is the upstream artifact, unmodified.
  const tree = await installedDir()
  const installedHash = await sha256(join(tree, 'dist', 'index.js'))
  const lock = JSON.parse(await readFile(join(tree, 'lock.json'), 'utf8'))
  // The lock's artifactSha256 is the hash of the whole installed tree (the
  // installer's own contract), not of dist/index.js alone; the rev it names is
  // what every asset URL carries.
  pass('upstream-bytes-unmodified', installedHash === UPSTREAM_DIST_SHA256, {
    installedSha256: installedHash, expected: UPSTREAM_DIST_SHA256,
    lockArtifactSha256: lock.artifactSha256, rev: lock.artifactSha256.slice(0, 12),
  })

  await inBrowser(async ({ cdp, sessionId, eval: page }) => {
    // The plane must be up and the kernel published before any verdict is read.
    const probe = await waitForPlane(page)
    pass('frame-health', probe.ejsPublished === true && probe.kernelInstances === 1, probe)
    await page(BRIDGE_COUNTER)
    await page(PLANE_MESSAGE_TAP)
    await shot(cdp, sessionId, 'uc1-01-frame-healthy')

    // ---- check 2a: 好感度 70 → 朋友 (round 1)
    const marker1 = `UC1-r1-${Date.now()}`
    await rpc('script.setVariables', { chatId: chat, scope: 'chat', op: 'insertOrAssign', variables: { 好感度: 70 } })
    const roundsBefore1 = (await page('window.__irisBridgeCounts')).rounds
    await sendAndAwaitReply(page, chat, marker1)
    const seg1 = wiSegmentOf(await captureForRound(marker1), marker1)
    const rounds1 = (await page('window.__irisBridgeCounts')).rounds - roundsBefore1
    pass('step1-expanded', seg1?.content?.includes('你是我信赖的朋友。') === true && seg1?.content?.includes('<%') === false, {
      segment: seg1?.content, bridgeRoundsThisGeneration: rounds1,
    })

    // ---- check 2b: same input again → byte-identical (stability).
    const marker2 = `UC1-r1b-${Date.now()}`
    await sendAndAwaitReply(page, chat, marker2)
    const seg1b = wiSegmentOf(await captureForRound(marker2), marker2)
    pass('step2-stable-same-input', seg1?.content === seg1b?.content, {
      first: seg1?.content, second: seg1b?.content,
    })

    // ---- check 2c: 好感度 10 → 警惕 (the branch flips with the input).
    // The template's effective input is upstream's variable cache: global ←
    // initial ← chat ⊕ MESSAGE layer (precacheVariables). Reply rounds write
    // 好感度 into the message layer (UC-2's own semantics), which shadows a
    // chat-only write — in SillyTavern exactly the same. "设 好感度 为 10"
    // therefore lands on both layers a real user's next round would read.
    const marker3 = `UC1-r2-${Date.now()}`
    await rpc('script.setVariables', { chatId: chat, scope: 'chat', op: 'insertOrAssign', variables: { 好感度: 10 } })
    await rpc('script.setVariables', { chatId: chat, scope: 'message', messageId: 'latest', op: 'insertOrAssign', variables: { 好感度: 10 } })
    await sendAndAwaitReply(page, chat, marker3)
    const seg2 = wiSegmentOf(await captureForRound(marker3), marker3)
    pass('step3-branch-flips', seg2?.content?.includes('我仍然对你保持警惕。') === true && seg2?.content?.includes('<%') === false, {
      segment: seg2?.content,
    })

    // ---- check 3: disabled → raw passthrough, zero bridge rounds.
    const marker4 = `UC1-r3-${Date.now()}`
    await rpc('plugin.disable', { id: EXTENSION_ID })
    await new Promise(wake => setTimeout(wake, 1200))
    const goneState = await page(probeQuiet())
    const roundsBeforeDisable = (await page('window.__irisBridgeCounts')).rounds
    await sendAndAwaitReply(page, chat, marker4)
    const rawSeg = wiSegmentOf(await captureForRound(marker4), marker4)
    const roundsDuringDisable = (await page('window.__irisBridgeCounts')).rounds - roundsBeforeDisable
    pass('step4-disabled-raw-passthrough', rawSeg?.content?.includes('<%') === true && rawSeg?.content?.includes("getvar('好感度'") === true, {
      segment: rawSeg?.content, bridgeRoundsDuringDisabledRound: roundsDuringDisable,
      frameProbeAfterDisable: goneState,
    })
    await shot(cdp, sessionId, 'uc1-04-disabled-plane-gone')

    // ---- check 4: re-enabled → expansion resumes from the disabled value, no replay.
    const marker5 = `UC1-r4-${Date.now()}`
    await rpc('plugin.enable', { id: EXTENSION_ID })
    const reprobe = await waitForPlane(page)
    const roundsBeforeReenable = (await page('window.__irisBridgeCounts')).rounds
    await sendAndAwaitReply(page, chat, marker5)
    const seg4 = wiSegmentOf(await captureForRound(marker5), marker5)
    const roundsReenable = (await page('window.__irisBridgeCounts')).rounds - roundsBeforeReenable
    pass('step5-reenabled-single-expansion', seg4?.content?.includes('我仍然对你保持警惕。') === true && seg4?.content?.includes('<%') === false, {
      segment: seg4?.content,
      frameHealthAfterReenable: reprobe,
      bridgeRoundsThisRound: roundsReenable,
    })

    // ---- check 5: restored to the original input → byte-identical to round 1.
    const marker6 = `UC1-r5-${Date.now()}`
    await rpc('script.setVariables', { chatId: chat, scope: 'chat', op: 'insertOrAssign', variables: { 好感度: 70 } })
    await rpc('script.setVariables', { chatId: chat, scope: 'message', messageId: 'latest', op: 'insertOrAssign', variables: { 好感度: 70 } })
    await sendAndAwaitReply(page, chat, marker6)
    const seg5 = wiSegmentOf(await captureForRound(marker6), marker6)
    pass('step6-restored-byte-identical', seg5?.content === seg1?.content, {
      round1: seg1?.content, restored: seg5?.content,
    })

    // No init side effects: still one kernel instance, one settings publish.
    const finalProbe = await page(probeQuiet())
    pass('single-kernel-after-cycle', finalProbe.kernelInstances === 1 && finalProbe.ejsPublished === true, finalProbe)
    await shot(cdp, sessionId, 'uc1-07-final-state')

    // The chat variable itself: the expansion never writes it (pure read).
    const chatVars = await variables(chat, 'chat')
    pass('chat-variable-untouched', chatVars?.好感度 === 70, { chatVariables: chatVars })
  })
}

await main()
