/**
 * UC-2 in a real browser: the reply-driven variable update, all four C-final
 * checks. The variable verdicts read the host's own variable store (the
 * authority), the floor verdicts read the provider capture and the page.
 *
 * Run: PILOT_PORT=8811 node notes/st-compat/acceptance/run-uc2.mjs
 * (run run-uc1.mjs first? no — this file creates its own chat; the seed host
 * must be up, and no newer chat may exist so the page auto-opens this one)
 */
import {
  rpc, record, chatId, inBrowser, shot,
  sendAndAwaitReply, variables, waitForPlane, probeQuiet,
  captureForRound, providerCaptures, wiSegmentOf,
} from './lib.mjs'

const SCENARIO = 'uc2'
const pass = (name, ok, detail = {}) => record(SCENARIO, name, { ok, ...detail })

const chat = await rpc('chat.create', { characterId: 'Pilot卡' })
const chatId2 = chat.view?.id ?? chat.view?.chatId ?? chat.chatId
await rpc('worldbook.bindChat', { chatId: chatId2, name: 'pilot-book' })
await rpc('chat.open', { chatId: chatId2 })
await rpc('script.setVariables', { chatId: chatId2, scope: 'chat', op: 'replace', variables: { 好感度: 0 } })
await rpc('script.setVariables', { chatId: chatId2, scope: 'message', messageId: 'latest', op: 'replace', variables: { 好感度: 0 } })

await inBrowser(async ({ cdp, sessionId, eval: page }) => {
  const probe = await waitForPlane(page)
  pass('frame-health', probe.ejsPublished === true && probe.kernelInstances === 1, probe)
  await page(`(() => {
    window.__c = { rounds: 0 }
    window.addEventListener('message', e => {
      const f = document.querySelector("iframe[title='Iris ST-compat extension plane']")
      if (f && e.source === f.contentWindow && e.data && e.data.type === 'bridge-result') window.__c.rounds++
    }, true)
  })()`)

  // ---- check 1: setvar lands on the message layer, chat scope untouched.
  const m1 = `UC2-r1-${Date.now()}`
  await sendAndAwaitReply(page, chatId2, m1)
  await captureForRound(m1)
  const msg1 = await variables(chatId2, 'message')
  const chat1 = await variables(chatId2, 'chat')
  const floors1 = await rpc('chat.open', { chatId: chatId2 })
  const floorText1 = String(floors1.view?.messages?.at(-1)?.text ?? '')
  pass('step1-message-layer-write', msg1?.好感度 === 10 && chat1?.好感度 === 0
    && floorText1.includes('新的好感度：10') && !floorText1.includes('<%'), {
    messageScope: msg1, chatScope: chat1, floorTail: floorText1.slice(-80),
  })
  await shot(cdp, sessionId, 'uc2-01-message-layer')

  // ---- check 2a: accumulation across rounds (10 → 20).
  const m2 = `UC2-r2-${Date.now()}`
  await sendAndAwaitReply(page, chatId2, m2)
  await captureForRound(m2)
  const msg2 = await variables(chatId2, 'message')
  pass('step2-accumulates-across-rounds', msg2?.好感度 === 20, { messageScope: msg2 })

  // ---- check 2b: a page reload (frame rebuild) keeps the chain.
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8811/?transport=rpc' }, sessionId)
  const reprobe = await waitForPlane(page)
  const m3 = `UC2-r3-${Date.now()}`
  await sendAndAwaitReply(page, chatId2, m3)
  await captureForRound(m3)
  const msg3 = await variables(chatId2, 'message')
  pass('step3-continues-after-reload', msg3?.好感度 === 30, {
    messageScope: msg3, frameHealthAfterReload: reprobe,
  })

  // ---- check 2c: a chat switch and back keeps the chain.
  const seedChat = await chatId()
  await rpc('chat.open', { chatId: seedChat })
  await new Promise(wake => setTimeout(wake, 800))
  await rpc('chat.open', { chatId: chatId2 })
  await new Promise(wake => setTimeout(wake, 800))
  const m4 = `UC2-r4-${Date.now()}`
  await sendAndAwaitReply(page, chatId2, m4)
  await captureForRound(m4)
  const msg4 = await variables(chatId2, 'message')
  pass('step4-continues-after-chat-switch', msg4?.好感度 === 40, { messageScope: msg4 })

  // ---- check 3a: disabled → raw reply, variables frozen.
  await rpc('plugin.disable', { id: 'prompt-template' })
  await new Promise(wake => setTimeout(wake, 1200))
  const gone = await page(probeQuiet())
  const m5 = `UC2-r5-${Date.now()}`
  await sendAndAwaitReply(page, chatId2, m5)
  await captureForRound(m5)
  const msg5 = await variables(chatId2, 'message')
  const floors5 = await rpc('chat.open', { chatId: chatId2 })
  const rawFloor = String(floors5.view?.messages?.at(-1)?.text ?? '')
  pass('step5-disabled-frozen-raw', msg5?.好感度 === 40 && rawFloor.includes('<%'), {
    messageScope: msg5, frameProbeAfterDisable: gone, rawFloorTail: rawFloor.slice(-90),
  })
  await shot(cdp, sessionId, 'uc2-05-disabled-raw-floor')

  // ---- check 3b: re-enabled → continues from the frozen value, no replay.
  await rpc('plugin.enable', { id: 'prompt-template' })
  const backProbe = await waitForPlane(page)
  const m6 = `UC2-r6-${Date.now()}`
  await sendAndAwaitReply(page, chatId2, m6)
  await captureForRound(m6)
  const msg6 = await variables(chatId2, 'message')
  const floors6 = await rpc('chat.open', { chatId: chatId2 })
  const allFloors = floors6.view?.messages ?? []
  // Locate the disabled round's reply floor by its unique user marker (+1),
  // not by a fixed offset from the end.
  const r5Index = allFloors.findIndex(one => String(one.text ?? '').includes(m5))
  const disabledFloorStillRaw = r5Index >= 0
    && String(allFloors[r5Index + 1]?.text ?? '').includes('<%')
  const newFloorProcessed = String(allFloors.at(-1)?.text ?? '').includes('新的好感度：50')
  pass('step6-reenabled-continues-no-replay', msg6?.好感度 === 50 && disabledFloorStillRaw && newFloorProcessed, {
    messageScope: msg6, disabledFloorStillRaw, newFloorProcessed, frameHealth: backProbe,
  })

  // ---- check 4: both processors compute; the host arbitrates one commit.
  const m7 = `UC2-MUTEX-${Date.now()}`
  await rpc('plugin.enable', { id: 'mvu' })
  await new Promise(wake => setTimeout(wake, 1200))
  await sendAndAwaitReply(page, chatId2, m7 + ' mutex probe')
  await captureForRound(m7)
  const msg7 = await variables(chatId2, 'message')
  // The scripted reply carries BOTH the template setvar (好感度 50 → 60 on the
  // message layer) and MVU's `_.set('好感度', 99)`. This card has no MVU schema
  // for that path, so MVU reports the refused write but still contributes its
  // own envelope. The host's transaction must preserve Prompt Template's
  // disjoint key rather than replacing the whole table with MVU's snapshot.
  const reports7 = await rpc('debug.reports', {})
  const mvuFault = (reports7.reports ?? []).filter(one => one.kind === 'mvu').at(-1)
  const stResultSurvives = msg7?.好感度 === 60
  const namedRefusal = typeof mvuFault?.message === 'string' && mvuFault.message.includes('好感度')
  pass('step7-dual-plugin-single-host-commit', stResultSurvives && namedRefusal, {
    messageScope: msg7, mvuFault: mvuFault?.message,
    note: 'Prompt Template committed 60 and MVU independently reported its rejected unknown path. The exact one-commit count, disjoint-key merge and same-key winner are pinned by variable-arbitration.test.ts.',
  })
  await rpc('plugin.disable', { id: 'mvu' })
  await shot(cdp, sessionId, 'uc2-07-variable-arbitration')
})

// The chat variable must never have been written by any of it (message layer
// only): read back once more outside the browser.
const finalChat = await variables(chatId2, 'chat')
pass('chat-scope-never-written', finalChat?.好感度 === 0, { chatScope: finalChat })
