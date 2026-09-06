/**
 * Task U verification: message-frame size + occlusion geometry over CDP.
 *
 * Opens real chats for the heavy cards, measures every message interface
 * frame's geometry against the visible reading band, checks text occlusion by
 * rect intersection plus elementFromPoint sampling, watches for height
 * oscillation by continuous sampling, and screenshots each state.
 *
 * Conversations are **resolved at run time** from a character-name prefix (see
 * `CARDS`), not read from a table of chat ids — those ids carried timestamps and
 * belonged to a single profile. The run then asserts how much it actually
 * measured and **exits non-zero** when it measured less than that floor, because
 * the alternative reading of a missing cell is "that cell is fine".
 *
 * Usage: node qa/measure-frame-fit.mjs <baseline|fixed> [chatKey ...]
 *   chatKey: shibian | zhengjing | hanren | shenyin | quanzhi
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// Every host, browser and path this script needs comes from the environment
// with a default, so a run on another machine is a variable away rather than an
// edit. Defaults are this script's own: the CDP port is unique per script so two
// QA runs can overlap (9341 used to be shared by three of them).
const CHROME = process.env.IRIS_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8821/'
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9342)
const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'results')

/**
 * The heavy cards this check measures, as **character-name prefixes**.
 *
 * This was a table of chat ids carrying timestamps
 * (`尸变纪元-v0-20260903-194944`). Those ids belong to **one** profile: on any
 * other profile every row missed, and a missed row was skipped with a
 * `console.error` and a `continue` — so the JSON report came out looking
 * complete while that card had been measured zero times. A missing cell and a
 * clean cell were the same reading.
 *
 * Names are stable where timestamps are not, so the conversation is resolved at
 * run time and the number of cards that resolved is **asserted**, not assumed.
 */
const CARDS = {
  shibian: '尸变纪元',
  zhengjing: '新·架空政治经济模拟器',
  hanren: '哈人冰恋世界',
  shenyin: '不要被神隐挑战',
  quanzhi: '全职高手',
}

/**
 * Explicit chat ids, for a run that must pin exactly which conversation it reads.
 *
 * Empty by default; a key here bypasses name resolution for that card. Filling
 * in **any** key also raises the floor of the first assertion from "at least one
 * card resolved" to "every requested card resolved", because writing this table
 * is a statement about what the profile in front of you holds.
 */
const EXPLICIT_CHATS = {}

/** The viewports every resolved card is measured at. Cell count depends on it. */
const VIEWPORTS = [[1920, 1080], [1366, 768]]

const wanted = process.argv.slice(2).filter(a => !['baseline', 'fixed'].includes(a))
const tag = process.argv[2] === 'fixed' || process.argv[3] === 'fixed' ? 'fixed' : 'baseline'
const keys = wanted.length > 0 ? wanted : ['shibian', 'zhengjing', 'hanren']

mkdirSync(OUT, { recursive: true })

// ws ships in the pnpm store; resolve it without adding a dependency.
const require = createRequire(import.meta.url)
const wsPath = new URL('../node_modules/.pnpm/ws@8.21.3/node_modules/ws/index.js', import.meta.url).href
const WebSocket = (await import(wsPath)).default ?? (await import(wsPath))

const profile = mkdtempSync(join(tmpdir(), 'iris-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1920,1080',
  'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))

let version = null
for (let i = 0; i < 50 && !version; i++) {
  await sleep(200)
  try {
    version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
  } catch { /* not up yet */ }
}
if (!version) { console.error('chrome debugger never came up'); process.exit(1) }

const browser = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((res, rej) => { browser.on('open', res); browser.on('error', rej) })

let seq = 0
const pending = new Map()
browser.on('message', raw => {
  const msg = JSON.parse(raw)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
function send(method, params = {}, sessionId) {
  const id = ++seq
  return new Promise((res, rej) => {
    pending.set(id, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
    browser.send(JSON.stringify({ id, method, params, sessionId }))
  })
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const cdp = (method, params) => send(method, params, sessionId)

await cdp('Page.enable')
await cdp('Runtime.enable')

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails))
  return r.result.value
}

async function setViewport(width, height) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false })
  await sleep(300)
}

async function shot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'))
  console.log('shot:', name)
}

let rpcSeq = 0
async function rpc(method, params) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `u-${++rpcSeq}`, method, params }),
  })
  return res.json()
}

// The geometry probe. Everything read off the live layout.
const MEASURE = `(() => {
  const rect = el => el ? el.getBoundingClientRect().toJSON() : null
  const scroller = document.querySelector('.iris-scroll')
  const band = scroller ? { top: scroller.getBoundingClientRect().top, height: scroller.clientHeight } : null
  const slots = [...document.querySelectorAll('.iris-interfaces__slot')].map(slot => {
    const frame = slot.querySelector('iframe')
    return {
      instance: slot.dataset.instance,
      slotRect: rect(slot),
      hasFrame: !!frame,
      frameRect: rect(frame),
      inlineHeight: frame ? frame.style.height || null : null,
      cssHeight: frame ? getComputedStyle(frame).height : null,
      sizing: frame ? (frame.dataset.irisSizing ?? null) : null,
    }
  })
  // Text segments: the prose blocks the reading view renders (each segment of
  // each assistant row, plus user rows' text wrappers).
  const textRects = []
  for (const el of document.querySelectorAll('.iris-msg__text')) {
    for (const child of el.children) {
      if (child.classList.contains('iris-interfaces__slot')) continue
      const r = child.getBoundingClientRect()
      if (r.height > 0) textRects.push({ tag: child.tagName, rect: r.toJSON() })
    }
  }
  const overlay = document.querySelector('.iris-overlay-surface')
  const overlayVisible = overlay ? getComputedStyle(overlay).visibility !== 'hidden' : false
  // The surface div itself paints nothing (transparent, pointer-events:none);
  // only its child frames paint. Intersect text with those, not with the box.
  const overlayFrames = overlay
    ? [...overlay.querySelectorAll('iframe')].map(f => f.getBoundingClientRect().toJSON())
    : []
  // Midline: prose column vs composer field.
  const prose = document.querySelector('.iris-column')
  const field = document.querySelector('.iris-composer__field')
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scroller: scroller ? { clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight, scrollTop: scroller.scrollTop } : null,
    band,
    slots,
    textRects: textRects.slice(0, 60),
    overlayRect: rect(overlay),
    overlayFrames,
    overlayVisible,
    proseRect: rect(prose),
    fieldRect: rect(field),
  }
})()`

const OSCILLATE_SAMPLE = `(() => {
  const frames = [...document.querySelectorAll('.iris-interfaces__slot iframe')]
  return frames.map(f => f.getBoundingClientRect().height + '|' + (f.style.height || 'css'))
})()`

await cdp('Page.navigate', { url: BASE })
for (let i = 0; i < 60; i++) {
  await sleep(500)
  const ready = await evaluate(`!!document.querySelector('.iris-stage') && !!document.querySelector('.iris-list')`).catch(() => false)
  if (ready) break
}

/** One RPC call that throws on a named error frame and unwraps the result. */
async function callRpc(method, params = {}) {
  const frame = await rpc(method, params)
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

/**
 * Resolve each requested card to the one conversation this run will measure.
 *
 * Newest wins (`updatedAt`), so a profile used more than once still names a
 * conversation deterministically. The chosen `chatId` rides every reading:
 * two runs that happened to measure different conversations of the same card
 * must not look identical in the report.
 *
 * A card that cannot be resolved lands in `missing` **with the reason**, and the
 * caller turns that into a hard failure. It is deliberately not skipped here:
 * skipping is what made the old report unreadable.
 * @param requested - card keys, from argv or the default three.
 * @returns the resolved conversations and, separately, what did not resolve.
 */
async function resolveChats(requested) {
  const { characters } = await callRpc('character.list')
  const { chats } = await callRpc('chat.list')
  /*
   * Enough of the profile to tell two runs apart in the file.
   *
   * Two reports with the same name can come from different profiles — the host
   * is a variable and the ids carry timestamps — and nothing inside the old
   * report said which one it read. Cheap to record, impossible to reconstruct
   * afterwards.
   */
  const fingerprint = {
    base: BASE,
    characters: characters.length,
    chats: chats.length,
    characterIds: characters.map(character => character.characterId).slice(0, 20),
    firstChatId: chats[0]?.chatId ?? null,
  }
  const resolved = []
  const missing = []

  for (const key of requested) {
    const prefix = CARDS[key]
    if (prefix === undefined) {
      missing.push({ key, why: `no such card key; known keys are ${Object.keys(CARDS).join(', ')}` })
      continue
    }

    const explicitId = EXPLICIT_CHATS[key]
    if (explicitId !== undefined) {
      const pinned = chats.find(chat => chat.chatId === explicitId)
      if (pinned === undefined) {
        missing.push({ key, why: `EXPLICIT_CHATS names ${explicitId}, which this profile does not hold` })
        continue
      }
      resolved.push({ key, prefix, chatId: pinned.chatId, title: pinned.title, source: 'explicit', titleAmbiguous: false })
      continue
    }

    /*
     * More than one character can carry the same name.
     *
     * `character.import` neither overwrites nor refuses: it derives the id from
     * the card's *name* and de-duplicates it (`library.ts` `uniqueId(toId(…))`),
     * so importing a card the profile already holds leaves two characters with
     * one name under different ids. Measured, not predicted: importing three
     * cards into a six-card profile produced `1_5` beside `哈人冰恋世界`,
     * `v0.5NSFW` beside `尸变纪元-v0`, `Lights_ON` beside `人偶演出Lights-ON`.
     *
     * Recorded, not resolved — the same treatment as an ambiguous chat title one
     * level down. Picking silently would make two runs that measured different
     * cards produce indistinguishable reports, and there is no honest rule for
     * which of two identically named cards was meant.
     */
    const matches = characters.filter(character => (character.name ?? '').startsWith(prefix))
    const card = matches[0]
    if (card === undefined) {
      missing.push({ key, why: `no character whose name starts with ${JSON.stringify(prefix)}` })
      continue
    }
    const mine = chats.filter(chat => chat.characterId === card.characterId)
    if (mine.length === 0) {
      missing.push({ key, why: `character ${JSON.stringify(card.name)} has no conversation in this profile` })
      continue
    }

    const newest = [...mine].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    /*
     * Two conversations of one card can carry the same title, and the row is
     * clicked **by title** — so the click cannot tell them apart. Recorded
     * rather than resolved: the reading says which chatId was aimed at and
     * whether the aim was ambiguous, which is the honest answer. Silently
     * picking one would make two different measurements look like one.
     */
    const sameTitle = mine.filter(chat => chat.title === newest.title).length
    resolved.push({
      key,
      prefix,
      chatId: newest.chatId,
      title: newest.title,
      character: card.name,
      characterId: card.characterId,
      source: 'newest',
      titleAmbiguous: sameTitle > 1,
      ...(sameTitle > 1 ? { sharingThisTitle: sameTitle } : {}),
      // The character-level twin of `titleAmbiguous`. Both ids are listed
      // because "it picked one of these two" is the honest reading, and the
      // next run may pick the other one.
      characterAmbiguous: matches.length > 1,
      ...(matches.length > 1 ? { charactersSharingThisName: matches.map(match => match.characterId) } : {}),
    })
  }

  return { resolved, missing, fingerprint }
}

async function openChat(spec) {
  // Row buttons carry the chat title inside a .iris-row__title span. The list
  // loads asynchronously, so retry until the row exists.
  const start = Date.now()
  while (Date.now() - start < 20_000) {
    const clicked = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.iris-list .iris-row')]
      const row = rows.find(r => (r.querySelector('.iris-row__title')?.textContent ?? '').trim() === ${JSON.stringify(spec.title)})
      if (row) { row.click(); return true }
      return false
    })()`)
    if (clicked) return true
    await sleep(500)
  }
  return false
}

async function waitForFrames(timeoutMs = 45_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const n = await evaluate(`document.querySelectorAll('.iris-interfaces__slot iframe').length`).catch(() => 0)
    if (n > 0) {
      // Give the frame's own height report a moment to land and settle.
      await sleep(4_000)
      return true
    }
    await sleep(500)
  }
  return false
}

function intersect(a, b) {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > left && bottom > top ? (right - left) * (bottom - top) : 0
}

function analyse(m) {
  const findings = { frames: [], occlusions: [], midline: null }
  for (const slot of m.slots) {
    if (!slot.frameRect) continue
    const frame = slot.frameRect
    const bandBottom = m.band ? m.band.top + m.band.height : m.innerHeight
    findings.frames.push({
      instance: slot.instance,
      frameHeight: Math.round(frame.height),
      inlineHeight: slot.inlineHeight,
      cssHeight: slot.cssHeight,
      sizing: slot.sizing,
      bandHeight: m.band ? Math.round(m.band.height) : null,
      tallerThanBand: m.band ? frame.height > m.band.height + 1 : frame.height > m.innerHeight + 1,
    })
    // Occlusion: frame rect vs every prose text rect.
    for (const t of m.textRects) {
      const area = intersect(frame, t.rect)
      if (area > 40) {
        findings.occlusions.push({
          kind: 'frame-over-text',
          instance: slot.instance,
          textTag: t.tag,
          area: Math.round(area),
          textRect: t.rect,
        })
      }
    }
  }
  // Overlay-card family: the card's own frame paints over the column by
  // design (the collapse toggle is the escape). Report it as its own kind so
  // it can be told from a message-frame fault.
  if (m.overlayVisible) {
    for (const of_ of m.overlayFrames) {
      for (const t of m.textRects) {
        const area = intersect(of_, t.rect)
        if (area > 400) {
          findings.occlusions.push({
            kind: 'overlay-frame-over-text',
            area: Math.round(area),
            overlayRect: of_,
            textRect: t.rect,
          })
        }
      }
    }
  }
  if (m.proseRect && m.fieldRect) {
    findings.midline = {
      proseCentre: Math.round(m.proseRect.x + m.proseRect.width / 2),
      fieldCentre: Math.round(m.fieldRect.x + m.fieldRect.width / 2),
    }
  }
  return findings
}

// Resolution talks to the host, so it can fail on its own. Named and killed
// cleanly rather than left as an unhandled rejection with a live Chrome behind
// it: "the host never answered" and "no card resolved" are different findings.
let resolution
try {
  resolution = await resolveChats(keys)
} catch (error) {
  chrome.kill()
  console.error(`measure-frame-fit: could not resolve any conversation — ${String(error.message ?? error)}`)
  console.error(`Is a host answering on ${BASE}? Nothing was measured, so this run says nothing about the frames.`)
  process.exit(2)
}
const { resolved, missing, fingerprint } = resolution
console.log(`resolved ${resolved.length} of ${keys.length} requested card(s) on ${fingerprint.base} (${String(fingerprint.characters)} character(s), ${String(fingerprint.chats)} chat(s))`)
for (const spec of resolved) {
  const flags = [
    spec.characterAmbiguous ? `CHARACTER AMBIGUOUS: ${spec.charactersSharingThisName.join(' / ')}` : '',
    spec.titleAmbiguous ? 'TITLE AMBIGUOUS' : '',
  ].filter(flag => flag !== '')
  console.log(`  ${spec.key} -> ${spec.chatId} (char ${spec.characterId}, ${spec.source}${flags.length === 0 ? '' : `, ${flags.join(', ')}`})`)
}
for (const miss of missing) console.log(`  ${miss.key} -> UNRESOLVED: ${miss.why}`)

/** Cells actually measured, per card key. The floor assertions read this. */
const measured = new Map(resolved.map(spec => [spec.key, 0]))

const startedAt = new Date()
const report = {
  // The header says which host and which profile this run read. Without it two
  // reports are distinguishable only by their contents, which is exactly what
  // is in question when two runs disagree.
  run: { tag, at: startedAt.toISOString(), viewports: VIEWPORTS, profile: fingerprint },
  resolution: { requested: keys, resolved, missing },
  cells: {},
}

for (const [W, H] of VIEWPORTS) {
  await setViewport(W, H)
  for (const spec of resolved) {
    const key = spec.key
    const opened = await openChat(spec)
    if (!opened) { console.error(`row titled ${JSON.stringify(spec.title)} (${spec.chatId}) never appeared`); continue }
    // Wait until the row actually switched.
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      const up = await evaluate(`!!document.querySelector('.iris-composer__field')`).catch(() => false)
      if (up) break
    }
    await waitForFrames()
    const m = await evaluate(MEASURE)
    const a = analyse(m)

    // Oscillation: sample frame heights every 250ms for 3s.
    const samples = []
    for (let i = 0; i < 12; i++) {
      samples.push(await evaluate(OSCILLATE_SAMPLE))
      await sleep(250)
    }
    const flat = samples.map(s => s.join(','))
    const distinct = [...new Set(flat)]

    // Scroll the first frame's row into view at the top of the band, then screenshot.
    await evaluate(`(() => {
      const slot = document.querySelector('.iris-interfaces__slot')
      if (slot) slot.scrollIntoView({ block: 'start' })
    })()`)
    await sleep(400)
    await shot(`u-${tag}-${key}-${W}x${H}.png`)

    report.cells[`${key}@${W}x${H}`] = {
      // Which conversation this cell read. Without it two runs that opened
      // different chats of the same card produce indistinguishable reports.
      chatId: spec.chatId,
      title: spec.title,
      ...(spec.titleAmbiguous ? { titleAmbiguous: true } : {}),
      measure: m,
      findings: a,
      oscillation: { distinctStates: distinct.length, states: distinct.slice(0, 4) },
    }
    measured.set(key, (measured.get(key) ?? 0) + 1)
    console.log(`measured ${key}@${W}x${H} (${spec.chatId}): frames=${a.frames.length} occlusions=${a.occlusions.length} oscStates=${distinct.length}`)
  }
}

/*
 * Two assertions, and both are needed.
 *
 * The second one alone is a **universal quantifier over a possibly empty set**:
 * "every resolved card was measured" is vacuously true when nothing resolved, so
 * an empty profile, a mistyped prefix, or an `rpc` that answered nothing would
 * all pass the very check written to catch a missing cell.
 *
 * The first one alone cannot see "resolved five, measured two".
 *
 *   1. how many cards resolved  — the positive control: **0 is also what a
 *      completely blind resolver returns**, so a floor above 0 is what proves
 *      the calliper sees anything at all;
 *   2. every resolved card measured at least one cell — the original floor.
 *
 * Frame count is deliberately NOT asserted: whether a cell contains frames is a
 * reading, not a gate. This script's job is "was this cell measured", and a card
 * whose conversation happens to carry no interface block is not a defect.
 */
const explicitGiven = Object.keys(EXPLICIT_CHATS).length > 0
const floor = explicitGiven ? keys.length : 1
const cellsMeasured = [...measured.values()].reduce((sum, n) => sum + n, 0)
const expectedCells = resolved.length * VIEWPORTS.length
const unmeasured = resolved.filter(spec => (measured.get(spec.key) ?? 0) === 0)

report.floors = {
  requested: keys.length,
  resolved: resolved.length,
  floorForResolved: floor,
  explicitTableGiven: explicitGiven,
  cellsMeasured,
  expectedCells,
  unmeasured: unmeasured.map(spec => spec.key),
}

/*
 * One file per run, never overwritten.
 *
 * The name used to be `u-frame-fit-<tag>-report.json` and nothing else, so the
 * next run replaced the last one — including a *failing* run replacing a good
 * one, which is how a teeth check erased a first run's geometry. A reading is
 * history, not a snapshot; a failing run's report is kept too, because its
 * `resolution.missing` is the diagnosis.
 */
const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outName = `u-frame-fit-${tag}-${stamp}-report.json`
writeFileSync(join(OUT, outName), JSON.stringify(report, null, 2))
console.log('report:', join(OUT, outName))

const failures = []
// A typo'd key is operator error, not a profile fact, so it fails on its own
// rather than riding on the floor: with two good keys beside it the floor is
// met and the typo would otherwise pass as "that card just isn't here".
for (const key of keys.filter(name => CARDS[name] === undefined)) {
  failures.push(`${key} is not a card key; known keys are ${Object.keys(CARDS).join(', ')}`)
}
if (resolved.length < floor) {
  failures.push(
    `resolved ${resolved.length} of ${keys.length} requested card(s), floor is ${floor}`
    + (explicitGiven ? ' (EXPLICIT_CHATS is filled in, so every requested card must resolve)' : ''),
  )
}
for (const spec of unmeasured) {
  failures.push(`${spec.key} resolved to ${spec.chatId} but no cell was ever measured for it`)
}

chrome.kill()

if (failures.length > 0) {
  console.error(
    `\nmeasure-frame-fit: resolved ${resolved.length} of ${keys.length} card(s), `
    + `measured ${cellsMeasured} of ${expectedCells} cell(s).\n`
    + failures.map(line => `  - ${line}`).join('\n') + '\n\n'
    + 'A card that did not resolve, or resolved but was never measured, is NOT a clean cell:\n'
    + 'it is a card this profile does not hold, or a row the page never showed. Cards resolve by\n'
    + 'character-name prefix at run time (CARDS); the chat ids this file used to carry were\n'
    + 'timestamped and belonged to one profile.\n'
    + 'This is a one-off acceptance instrument (METHODS §二十七), not a CI gate, so it fails hard\n'
    + 'rather than warning: its old failure mode — console.error then continue — is\n'
    + 'indistinguishable in the report from "that cell is fine".',
  )
  process.exit(1)
}

console.log(`\nmeasure-frame-fit: resolved ${resolved.length} of ${keys.length} card(s), measured ${cellsMeasured} of ${expectedCells} cell(s).`)
process.exit(0)
