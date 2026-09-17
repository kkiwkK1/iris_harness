/**
 * REVIEW-6 instrument: two time-stamped curves for 创世回廊1's greeting frame.
 *
 * `notes/tasks/REVIEW-6-GREETING-FRAME-OSCILLATION.md` asks one question —
 * anomaly B's 874x513 -> 515 -> 503 came from the frame's own content
 * relaying out, or from the shell's height pipeline — and answers it by
 * recording, **with timestamps**, both quantities the old 5-samples-every-1.5s
 * ruler measured only as five independent points:
 *
 *   shell:  `.iris-interfaces__slot iframe`'s used height (ResizeObserver on the
 *           element, so a change is a change and not a guess), plus its inline
 *           `style.height`, its `data-iris-sizing` mark and the computed
 *           `max-height` (the visible band the frame is clamped to — the clamp
 *           is why the used box can be 503 while the inline height is 1105).
 *   frame→shell: every `MessageEvent` the frame posts up, filtered to the
 *           protocol's own shapes: `height` (the frame's content measurement),
 *           `sizing` (the frame saying it cannot be measured) and `note` (the
 *           `height sources: …` diagnostic line, which carries the reporter's
 *           own counter pairs).
 *   frame-internal: the same `height sources` line is the only view inside an
 *           opaque origin, so it is recorded as its own row kind rather than
 *           folded into the height curve.
 *
 * The *reply-side* frame is measured with the identical recorder, because the
 * manual's §2.5 control is what separates "this card oscillates" from "this
 * recorder makes every frame look like it oscillates".
 *
 * Nothing here is a pass/fail: REVIEW-6 is a record. The script exists because
 * a 20 s two-curve trace has to be reproducible by the next reader, and because
 * the browser console snippet in the manual cannot be run unattended.
 *
 * Usage:
 *   node qa/review6-frame-oscillation.mjs [--base http://127.0.0.1:8791]
 *        [--chat <chatId>] [--chat-swipe <chatId>] [--seconds 20] [--cdp 9355]
 * Reads/writes `qa/results/review6/` (gitignored). Not part of any build.
 *
 * @module qa/review6-frame-oscillation
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

import { cdpPort } from './cdp-port.mjs'

const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8791'
const CHROME = process.env.IRIS_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DEBUG_PORT = String(cdpPort(9355))

const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const FLAG = name => argv.includes(name)

/** The greeting side: the chat whose first-floor greeting builds the 封面 frame. */
const CHAT_GREETING = value('--chat', '创世回廊1-20260903-060012')
/** The reply side, the manual's control: two frames, stable in REVIEW-2. */
const CHAT_REPLY = value('--chat-reply', '创世回廊1-20260917-010155')
const SECONDS = Number(value('--seconds', '20'))
/**
 * How long the manual's 10 s wait lasts, in total, before the recorder stops.
 *
 * The manual says "等 10 s, then record for 20 s", i.e. the two windows are
 * sequential and the interesting one starts after the wait. This instrument
 * runs them the other way round on purpose: the recorder arms at the moment
 * frames appear and runs for `seconds`, and the wait is what remains of the
 * manual's 10 s. A window that starts 10 s late cannot see a change that
 * happened at second 6 of a card's own boot, and this measurement is precisely
 * about when things stop moving.
 */
const WAIT_MS = Number(value('--wait-ms', '10000'))
const waitMs = Math.max(0, WAIT_MS - SECONDS * 1000)
const SKIP_REPLY = FLAG('--greeting-only')
/**
 * Dismiss the transient notice banners before recording — §2.5's control.
 *
 * The manual asks for the reply-side frame as the baseline that proves the
 * recorder is not itself making frames look unstable. On this card the reply
 * side carries the same banners, so the sharper control is "the same frame with
 * the notice region empty": it holds the card, the document and the geometry
 * still and changes exactly one thing.
 */
const CLEAR_BANNERS = FLAG('--clear-banners')
/**
 * Measure a freshly created conversation — the manual's own recipe, and the
 * path REVIEW-2 saw anomaly B on.
 */
const NEW_CONVERSATION = !FLAG('--no-new-conversation')
/** Skip the existing-chat runs — used when the profile's chat ids are not known. */
const SKIP_EXISTING = FLAG('--new-only')
/** The card, for the new-conversation path. */
const CHARACTER = value('--character', '创世回廊1')
/** Its title as the library spells it (user data, so text is the handle). */
const DISPLAY_NAME = value('--display-name', '创世回廊1')
/**
 * Suppress the transient banners **for the whole recording window** — the
 * counterfactual run — rather than dismissing them once before it starts.
 */
const SUPPRESS_BANNERS = FLAG('--suppress-banners')

const OUT = new URL('./results/review6/', import.meta.url)
mkdirSync(OUT, { recursive: true })

const require = createRequire(import.meta.url)
const wsPath = new URL('../node_modules/.pnpm/ws@8.21.3/node_modules/ws/index.js', import.meta.url).href
const WebSocket = (await import(wsPath)).default ?? (await import(wsPath))

// ------------------------------------------------------------------ RPC
let seq = 0
async function rpc(method, params = {}) {
  const res = await fetch(`${BASE}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `r6-${++seq}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${String(res.status)}`)
  const frame = await res.json()
  if (frame.ok === false) throw new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
  return frame.result
}

// ------------------------------------------------------------------ CDP
function socket(url) {
  const ws = new WebSocket(url)
  const opened = new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error(`socket failed: ${url}`))
  })
  let id = 0
  const pending = new Map()
  const consoleLines = []
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ')
      consoleLines.push({ level: msg.params.type, text: String(text).slice(0, 400) })
    }
    if (msg.method === 'Log.entryAdded') {
      consoleLines.push({ level: msg.params.entry?.level ?? 'log', text: String(msg.params.entry?.text ?? '').slice(0, 400) })
    }
  }
  const send = (method, params = {}) => new Promise(async res => {
    await opened
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const evaluate = async (expression, timeoutMs = 120_000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      delay(timeoutMs, () => ({ timeout: true })),
    ])
    if (r.timeout === true) return { error: `evaluate timed out after ${String(timeoutMs)}ms` }
    if (r.result?.exceptionDetails !== undefined) {
      return { error: String(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text ?? '?').slice(0, 300) }
    }
    return r.result?.result?.value
  }
  return { ws, opened, send, evaluate, consoleLines }
}

/**
 * The recorder, installed in the shell's page context.
 *
 * `performance.now()` is the single clock on both curves, so the two rows for
 * one event can be compared without wall-clock alignment. The frame's own
 * console output is not reachable from here (opaque origin), so the frame's
 * internal counters arrive only through the `height sources` note the reporter
 * posts — recorded as its own kind so a reader can see whether the frame's
 * `fired resize N mutation M` pair is climbing while the height is standing
 * still.
 *
 * The `MessageEvent` filter is the protocol's own: the frame posts
 * `{iris: <run>, type, …}` and nothing else crosses that channel.
 */
const recorderExpr = (seconds, suppress) => `(async () => {
  /*
   * Wait for the frame, do not assume it.
   *
   * The recorder is armed the moment the chat row is clicked — deliberately, so
   * the band's life is on one clock with the frame's — and the slot exists only
   * after the message's interfaces have been claimed and mounted, which is
   * hundreds of milliseconds later and on a slow card can be seconds. Refusing
   * here measured nothing at all on the first run; polling makes the arming
   * time a fact (the sinceArmMs field on the armed row) instead of a race.
   */
  const armedAt = performance.now()
  let slot = null
  for (let at = 0; at < 600 && slot === null; at += 1) {
    slot = document.querySelector('.iris-interfaces__slot iframe')
    if (slot === null) await new Promise(r => setTimeout(r, 50))
  }
  if (slot === null) return { error: 'no .iris-interfaces__slot iframe within 30s of arming' }
  const scroller = document.querySelector('.iris-scroll')
  const key = '--iris-app-frame-height'
  const rows = []
  const t0 = performance.now()
  const at = () => Math.round(performance.now() - t0)
  rows.push({ t: 0, kind: 'observe:armed', sinceArmMs: Math.round(t0 - armedAt) })
  /*
   * The band's own neighbourhood, read on every sample.
   *
   * The used height is the smaller of the content and the band, so a band that moves moves the
   * used height with nothing said by the frame. Measuring the band alone names
   * the layer but not the cause; these are the boxes above and below the
   * reading scroller, in one reading, so "the band shrank" and "a notice region
   * grew" can be stated as one fact instead of guessed at. The layout field is a
   * compact list because the interesting question is which of them moved.
   */
  const layout = () => {
    const box = sel => {
      const el = document.querySelector(sel)
      return el === null ? null : Math.round(el.getBoundingClientRect().height * 100) / 100
    }
    return {
      scrollerClient: scroller === null ? -1 : scroller.clientHeight,
      scrollerRect: box('.iris-scroll'),
      shellTop: box('.iris-masthead'),
      composer: box('.iris-composer'),
      composerBar: box('.iris-composer__bar'),
      notices: box('.iris-notices'),
      noticesRows: document.querySelectorAll('.iris-notices__list li').length,
      column: box('.iris-column'),
      docClient: document.documentElement.clientHeight,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      /*
       * The transient banner, by name. The shell renders an iris-notice element
       * above the stage inside the flex column, and the stage is flex:1 — so a
       * banner that appears takes its height out of the stage, which takes it
       * out of the reading scroller, which is the box the band is measured from.
       * It is therefore a candidate cause of a band change that has nothing to
       * do with any card, and it is measured with its text because "which notice
       * was it" is the next question after "was there one". The singular class
       * is the banner; the plural one is the drawer's log, a different element.
       */
      banners: [...document.querySelectorAll('.iris-notice')].map(el => ({
        h: Math.round(el.getBoundingClientRect().height * 100) / 100,
        cls: String(el.className),
        text: (el.textContent ?? '').trim().replaceAll(String.fromCharCode(10), ' ').slice(0, 80),
      })),
      /* The scrollbar, named: a stable gutter reserves the space whether or not
         a thumb is drawn, and this is the only way to see it from outside. */
      scrollbar: scroller === null ? -1 : Math.round((scroller.offsetWidth - scroller.clientWidth) * 100) / 100,
      /* Whether the column overflows the scroller at all — the fact that decides
         whether a scrollbar exists, rather than the width it would take. */
      columnOverflowPx: scroller === null ? -1 : Math.round((scroller.scrollHeight - scroller.clientHeight) * 100) / 100,
      /* The scroller's ancestry, so a band change is attributed to the box that
         actually changed rather than to whichever neighbour was nameable. A
         flex/grid chain of five boxes all report the same number until one of
         them does not, and that one is the cause. */
      chain: (() => {
        const out = []
        let el = scroller
        for (let at = 0; at < 6 && el !== null && el !== undefined; at += 1) {
          const cls = String(el.className ?? '').split(' ')[0]
          out.push(cls + '=' + String(Math.round(el.clientHeight)) + '/' + String(Math.round(el.getBoundingClientRect().height)))
          el = el.parentElement
        }
        return out.join(' ')
      })(),
    }
  }
  const sample = source => {
    const box = slot.getBoundingClientRect()
    rows.push({
      t: at(),
      kind: source,
      h: Math.round(box.height * 100) / 100,
      w: Math.round(box.width * 100) / 100,
      inline: slot.style.height || '',
      mark: slot.dataset.irisSizing || '',
      band: getComputedStyle(slot).maxHeight,
      scrollerBand: scroller === null ? '' : getComputedStyle(scroller).getPropertyValue(key).trim(),
      layout: layout(),
    })
  }
  sample('observe:start')
  const ro = new ResizeObserver(() => { sample('shell') })
  ro.observe(slot)
  /*
   * And the scroller itself, so a band change that happens to leave the frame's
   * used box the same size (a frame shorter than the band that shrank) is still
   * on the timeline.
   */
  if (scroller !== null) ro.observe(scroller)
  const onMessage = event => {
    const data = event.data
    if (data === null || typeof data !== 'object') return
    if (typeof data.iris !== 'string') return
    if (event.source !== slot.contentWindow) rows.push({ t: at(), kind: 'other-source', type: String(data.type) })
    if (data.type === 'height') rows.push({ t: at(), kind: 'frame→shell:height', pixels: data.pixels })
    else if (data.type === 'sizing') rows.push({ t: at(), kind: 'frame→shell:sizing', mode: String(data.mode) })
    else if (data.type === 'note') rows.push({ t: at(), kind: 'frame:note', message: String(data.message).slice(0, 300) })
    else if (data.type === 'ready') rows.push({ t: at(), kind: 'frame→shell:ready' })
  }
  window.addEventListener('message', onMessage)
  /*
   * The counterfactual, when asked for: keep the notice region empty for the
   * whole window.
   *
   * Dismissing once before arming is not enough on this card — its own scripts
   * keep producing refusals and errors while it boots, and a *new* banner is
   * what moved the band in the pre-armed control run. Suppressing for the whole
   * window is the only form of this that can answer "would the band have moved
   * with no banner at all", and each suppression is a row so the record shows
   * the intervention instead of hiding it.
   */
  let suppressor = null
  if (${suppress === true ? 'true' : 'false'}) {
    const dismiss = () => {
      const buttons = [...document.querySelectorAll('.iris-notice__dismiss')]
      if (buttons.length === 0) return
      const texts = [...document.querySelectorAll('.iris-notice')].map(el => (el.textContent ?? '').trim().slice(0, 60))
      for (const button of buttons) button.click()
      rows.push({ t: at(), kind: 'control:dismissed', count: buttons.length, texts })
    }
    dismiss()
    suppressor = new MutationObserver(dismiss)
    suppressor.observe(document.body, { childList: true, subtree: true })
  }
  return new Promise(resolve => {
    setTimeout(() => {
      ro.disconnect()
      window.removeEventListener('message', onMessage)
      if (suppressor !== null) suppressor.disconnect()
      sample('observe:end')
      resolve({ rows, t0: Math.round(t0 * 100) / 100, wall0: Date.now(), armedAtMs: Math.round(armedAt * 100) / 100 })
    }, ${String(seconds * 1000)})
  })
})()`

/**
 * The shell's own watchdog for the same window: not part of the two curves, but
 * it answers "was the frame repainting at all", which is the confound §54 is
 * about (a never-painted frame's rAF never fires).
 */
const paintProbeExpr = `(async () => {
  const frames = []
  await new Promise(resolve => {
    let n = 0
    const tick = () => { n += 1; frames.push(Math.round(performance.now())); if (n < 30) requestAnimationFrame(tick); else resolve() }
    requestAnimationFrame(tick)
  })
  const gaps = frames.slice(1).map((t, i) => t - frames[i])
  return { shellFrames: frames.length, spanMs: frames.at(-1) - frames[0], maxGapMs: Math.max(...gaps), minGapMs: Math.min(...gaps) }
})()`

/** Frames present, with what the shell knows about each. */
const framesExpr = `(() => {
  const scroller = document.querySelector('.iris-scroll')
  const key = '--iris-app-frame-height'
  const onFrames = [...document.querySelectorAll('.iris-interfaces__slot')]
    .map(s => getComputedStyle(s).getPropertyValue(key).trim())
  const band = {
    scrollerInline: scroller === null ? '' : scroller.style.getPropertyValue(key).trim(),
    atFrames: [...new Set(onFrames)],
    scrollerClientHeight: scroller === null ? -1 : scroller.clientHeight,
  }
  return { pageNow: Math.round(performance.now() * 100) / 100, band, frames: [...document.querySelectorAll('.iris-interfaces__slot iframe')].map(f => {
  const box = f.getBoundingClientRect()
  return {
    w: Math.round(box.width), h: Math.round(box.height),
    inline: f.style.height || '', mark: f.dataset.irisSizing || '',
    band: getComputedStyle(f).maxHeight,
    sandbox: f.getAttribute('sandbox') ?? '',
    srcdocLen: (f.getAttribute('srcdoc') ?? '').length,
    title: (() => { const m = /<title[^>]*>([^<]*)<\\/title>/i.exec(f.getAttribute('srcdoc') ?? ''); return m === null ? '' : m[1].slice(0, 60) })(),
  }
}) }
})()`

/**
 * Turn the raw rows into the three readings the manual asks for: does it settle,
 * what is the period and amplitude if it does not, and which curve moves first.
 *
 * The lead/lag check is the whole point: for every shell-height change, the
 * nearest preceding frame report is found, and the tally of
 * "frame-report precedes shell-change" versus the reverse is what names the
 * layer. Both counts are reported even when one is zero, so "no frame reports at
 * all in the window" is visible rather than inferred.
 */
function analyze(rows, wall0, settle) {
  const shell = rows.filter(r => r.kind === 'shell')
  const reports = rows.filter(r => r.kind === 'frame→shell:height')
  const heights = shell.map(r => r.h)
  const distinct = [...new Set(heights.map(h => String(h)))]
  const lastThird = heights.slice(Math.floor(heights.length * 2 / 3))
  const settled = new Set(lastThird).size === 1
  const changes = []
  for (let i = 1; i < shell.length; i += 1) {
    if (shell[i].h !== shell[i - 1].h) changes.push({ t: shell[i].t, from: shell[i - 1].h, to: shell[i].h })
  }
  const periods = changes.slice(1).map((c, i) => c.t - changes[i].t)
  let frameFirst = 0
  let shellFirst = 0
  for (const change of changes) {
    const before = [...reports].reverse().find(r => r.t <= change.t)
    const after = reports.find(r => r.t > change.t)
    const gapBefore = before === undefined ? Infinity : change.t - before.t
    const gapAfter = after === undefined ? Infinity : after.t - change.t
    if (gapBefore < gapAfter) frameFirst += 1
    else if (gapAfter < gapBefore) shellFirst += 1
  }
  const dismissals = rows.filter(r => r.kind === 'control:dismissed')
  const notes = rows.filter(r => r.kind === 'frame:note')
  const firstNote = notes[0]?.message ?? ''
  const lastNote = notes.at(-1)?.message ?? ''

  /*
   * **The band.** The frame's used height is `min(content, band)`, so a band
   * that moves moves the used height with no report from the frame at all and
   * no content change whatever. It is therefore not a fourth curiosity: on this
   * corpus it is the *cause*, and the two curves the manual asks for only make
   * sense beside it.
   *
   * `scrollerBand` is the custom property the shell publishes (`frame-fit.ts`);
   * `band` is the computed `max-height` the frame actually obeys. They are
   * recorded separately because a stale published value and an unapplied one
   * are different faults, and only their disagreement tells them apart.
   */
  const bandSamples = rows.filter(r => r.kind === 'shell' || r.kind === 'observe:start' || r.kind === 'observe:end')
  const bandValues = bandSamples.map(r => r.band)
  const bandChanges = []
  for (let i = 1; i < bandValues.length; i += 1) {
    if (bandValues[i] !== bandValues[i - 1]) bandChanges.push({ t: bandSamples[i].t, from: bandValues[i - 1], to: bandValues[i] })
  }
  const scrollerBands = [...new Set(bandSamples.map(r => r.scrollerBand))]
  const firstBand = bandValues[0]
  const lastBand = bandValues.at(-1)

  /*
   * Did the used height change **without** the band changing? That is the only
   * reading on which the frame's own content is implicated, and it is the
   * distinction the whole measurement exists to draw.
   */
  const usedHeightOnly = changes.filter(change => {
    const bandAt = bandSamples.find(r => r.t >= change.t)?.band
    const bandBefore = [...bandSamples].reverse().find(r => r.t <= change.t)?.band
    return bandAt !== undefined && bandAt === bandBefore
  })

  /*
   * And the reverse: did the band move while the frame reported nothing at all?
   * A band change with `frameReports === 0` in the window is the shell moving a
   * frame that never spoke — content-independent by construction.
   */
  const bandMovedWithoutFrame = bandChanges.length > 0 && reports.length === 0

  /*
   * The page-clock timeline, for the settle window's own samples: the band's
   * whole life in this run, on one clock with the recorder's rows, so "the band
   * changed at 3.0s and the recorder opened at 10s" is a fact rather than an
   * inference from two different time bases.
   */
  const timeline = []
  for (const sample of settle ?? []) {
    timeline.push({ source: 'wait', wall: sample.wall, band: sample.band, heights: sample.heights })
  }
  for (const row of bandSamples) {
    timeline.push({ source: 'record', wall: wall0 === undefined ? null : wall0 + row.t, band: row.band, heights: [row.h] })
  }
  timeline.sort((a, b) => (a.wall ?? 0) - (b.wall ?? 0))
  let phase = 'before-frames'
  for (const row of timeline) {
    if (row.heights.length > 0 && row.heights[0] !== undefined && row.heights[0] !== '') phase = 'band-settled'
    row.phase = phase
  }

  /*
   * Which of the band's neighbours moved, and by how much — the cause line.
   */
  const layouts = bandSamples.map(r => r.layout).filter(l => l !== undefined)
  const neighbourValues = {}
  for (const field of ['scrollerClient', 'shellTop', 'composer', 'composerBar', 'notices', 'noticesRows', 'docClient', 'viewport', 'scrollbar', 'columnOverflowPx', 'chain']) {
    const seen = [...new Set(layouts.map(l => String(l[field])))]
    if (seen.length > 1) neighbourValues[field] = seen
  }
  const bannerStates = [...new Set(layouts.map(l => JSON.stringify(l.banners)))]

  /*
   * **The arithmetic that names the cause.**
   *
   * The reading scroller is a flex child (`iris-sheet`, inside `iris-stage`,
   * inside `iris-main`) and the transient notice banner is its sibling *above*
   * the stage. So the two are complementary within `iris-main`: whatever height
   * a banner takes, the scroller loses. If `band + banner` is one number across
   * every sample, then nothing about the frame or the conversation is in the
   * band's movement at all — the band is a function of the notice region, and
   * the frame is a passenger whose used height is `min(content, band)`.
   *
   * Stated as a tally rather than as prose because it is a claim about every
   * sample in the window, including the ones that did not change: a
   * complementarity that holds only at the changes would also hold trivially.
   */
  const bandPlusBanner = bandSamples.map(r => {
    const banner = (r.layout?.banners ?? []).reduce((sum, b) => sum + b.h, 0)
    return { t: r.t, band: r.band, banner: Math.round(banner * 100) / 100, sum: Math.round((Number.parseFloat(r.band) + banner) * 100) / 100 }
  })
  const complementSums = [...new Set(bandPlusBanner.map(row => String(row.sum)))]

  /*
   * And the frame's own content, over the same window, from the reporter's own
   * diagnostic lines — the frame-side curve the manual asks for, as far as an
   * opaque origin allows. Every `body.scrollHeight` the frame ever posted.
   */
  const bodyScrolls = notes
    .map(note => /body\.scrollHeight (\d+)/.exec(note.message))
    .filter(m => m !== null)
    .map(m => Number(m[1]))

  return {
    band: {
      first: firstBand,
      last: lastBand,
      values: [...new Set(bandValues)],
      publishedValues: scrollerBands,
      changeCount: bandChanges.length,
      changes: bandChanges,
      movedWithoutFrameReport: bandMovedWithoutFrame,
    },
    changedWithBandHeld: usedHeightOnly.length,
    neighboursThatMoved: neighbourValues,
    banners: bannerStates,
    bandPlusBanner: bandPlusBanner,
    complementSums: complementSums,
    complementHolds: complementSums.length === 1,
    frameBodyScrollHeights: [...new Set(bodyScrolls)].sort((a, b) => a - b),
    timeline,
    samples: shell.length,
    distinctShellHeights: distinct,
    settled,
    lastThirdDistinct: [...new Set(lastThird.map(h => String(h)))],
    changeCount: changes.length,
    firstChangeAtMs: changes[0]?.t ?? null,
    lastChangeAtMs: changes.at(-1)?.t ?? null,
    periodsMs: periods,
    amplitudePx: changes.length === 0 ? 0 : Math.max(...changes.map(c => Math.abs(c.to - c.from))),
    frameReports: reports.length,
    frameReportPixels: [...new Set(reports.map(r => r.pixels))],
    frameFirst,
    shellFirst,
    firstNote,
    lastNote,
    noteCount: notes.length,
    dismissals: dismissals.map(row => ({ t: row.t, count: row.count, texts: row.texts })),
  }
}

/**
 * Create a **new** conversation for a card, through the shell's own controls.
 *
 * The manual's recipe is "创世回廊1 → 开始新对话 → 同意脚本 → 等 10 s", and
 * REVIEW-2 measured the anomaly on a conversation created that way. It is not
 * the same measurement as opening an existing chat: a fresh conversation boots
 * the card's scripts cold, so its notices — and therefore anything that depends
 * on the notice region — arrive on a different schedule. Reproducing the
 * anomaly means reproducing the path it was seen on.
 *
 * The card is found on the characters tab by its display name (user data, so
 * text is the honest handle, per `qa/locators.mjs`), the conversation is created
 * by the face's own action, and the new chat id is *discovered* from the host's
 * own list rather than assumed.
 * @param session - the CDP session.
 * @param character - the character id.
 * @param displayName - the card's title, as the row spells it.
 * @returns the new chat id, or an error string.
 */
async function createConversation(session, character, displayName) {
  const { evaluate } = session
  const before = new Set((await rpc('chat.list', {})).chats.map(c => c.chatId))
  const face = await evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const tab = document.querySelector('[data-tab=characters]')
    if (tab !== null && tab.getAttribute('aria-selected') !== 'true') { tab.click(); await sleep(1200) }
    const wanted = ${JSON.stringify(displayName)}
    const rows = [...document.querySelectorAll('.iris-list .iris-row')]
    const hit = rows.find(el => (el.querySelector('.iris-row__title')?.textContent ?? '').includes(wanted))
    if (hit === undefined) {
      return { error: 'no card row named ' + wanted, titles: rows.map(r => (r.querySelector('.iris-row__title')?.textContent ?? '').trim()).slice(0, 30) }
    }
    hit.click()
    await sleep(2500)
    const actions = [...document.querySelectorAll('.iris-face__actions button')]
    const start = actions.find(b => /开始新对话|New conversation|Start/.test(b.textContent ?? '')) ?? actions[0]
    if (start === undefined) return { error: 'the card page has no action buttons' }
    start.click()
    return { clicked: true, action: (start.textContent ?? '').trim() }
  })()`)
  if (face?.error !== undefined) return { error: face.error, titles: face.titles }
  for (let at = 0; at < 60; at += 1) {
    await delay(500)
    const now = (await rpc('chat.list', {})).chats
    const created = now.find(c => c.characterId === character && !before.has(c.chatId))
    if (created !== undefined) return { chatId: created.chatId, face }
  }
  return { error: 'the shell never created a conversation for ' + character }
}

/**
 * Open an **existing** conversation by id, or refuse by name.
 *
 * A chat is opened through the shell's own list, never by host RPC: an RPC
 * `chat.open` registers a second session on a chat the page already has open.
 *
 * **Refusing is the point.** Two conversations of one card carry the same title
 * (`创世回廊1.3` twice on this profile), so a title match is ambiguous exactly
 * when a card has more than one chat — and then the reading is pinned to *a*
 * conversation of that card while being reported under the name of the other,
 * which is worse than no reading because the record cannot show it (the same
 * argument `qa/README.md` makes about asserting how much was measured). So: an
 * exact `data-chat` match wins; a title match is accepted only when exactly one
 * row has it; otherwise this returns an error naming the ambiguity, and the
 * caller records it. The unambiguous path is `--new-conversation`, which is
 * also the manual's own recipe.
 */
async function openExisting(session, chatId) {
  const { evaluate } = session
  return await evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const tab = document.querySelector('[data-tab=chats]')
    if (tab !== null && tab.getAttribute('aria-selected') !== 'true') { tab.click(); await sleep(900) }
    const wanted = ${JSON.stringify(chatId)}
    const rows = [...document.querySelectorAll('.iris-list .iris-row')]
    const titleOf = el => (el.querySelector('.iris-row__title')?.textContent ?? '').trim()
    const byId = rows.filter(el => (el.getAttribute('data-chat') ?? '') === wanted)
    const byTitle = rows.filter(el => titleOf(el) === wanted)
    const hit = byId[0] ?? byTitle[0]
    if (hit === undefined) {
      return { error: 'no row for ' + wanted, titles: rows.map(titleOf).slice(0, 30) }
    }
    if (byId.length === 0 && byTitle.length > 1) {
      return {
        error: 'ambiguous: ' + String(byTitle.length) + ' rows are titled ' + wanted
          + ' and no row carries a data-chat attribute to tell them apart',
        titles: rows.map(titleOf).slice(0, 30),
      }
    }
    hit.click()
    return { clicked: true, title: titleOf(hit), matchedBy: byId.length > 0 ? 'data-chat' : 'title(unique)' }
  })()`)
}

/**
 * Record one conversation.
 *
 * `target` is either a chat id **string** (an existing conversation: this opens
 * its row first) or `{ chatId, alreadyOpen: true }` for the conversation the
 * shell has just created and is already showing. The distinction is load
 * bearing rather than cosmetic: the new-conversation path must **not** go
 * looking for a row, both because there is nothing to click and because on this
 * profile the rows cannot be told apart anyway (they carry no conversation id,
 * and every conversation of the card is titled `创世回廊1.3`).
 */
async function drive(session, target, label, seconds) {
  const { evaluate, send } = session
  const alreadyOpen = typeof target === 'object' && target !== null && target.alreadyOpen === true
  const chatId = alreadyOpen ? target.chatId : target
  const opened = alreadyOpen ? { clicked: false, alreadyOpen: true } : await openExisting(session, chatId)
  if (opened?.error !== undefined) return { label, chatId: chatId ?? null, error: opened.error, titles: opened.titles }

  // Script consent may or may not be asked on this profile; answer it the way
  // `qa/locators.mjs` does (first button runs them) and record which happened.
  const consent = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.iris-grant__actions button')]
    if (buttons.length === 0) return { asked: false }
    buttons[0].click()
    return { asked: true, label: (buttons[0].textContent ?? '').trim() }
  })()`)

  /*
   * The settle window, and why it is a curve rather than a wait.
   *
   * The manual's own recipe is "同意脚本 → 等 10 s", and REVIEW-2's ruler took
   * its five samples *after* that wait. Both are windows that can be entered
   * after the thing being measured has stopped moving, which would make an
   * oscillation look like a settled frame. So the wait is spent **inside the
   * frame**: the recorder below arms at t=0 and runs for `seconds`, and this
   * loop's only job is to hold the browser at that state until then, sampling
   * once a second so a band that moves while the reader is waiting is on
   * record. `waitMs` is the manual's 10 s minus the recorder's own window.
   */
  /*
   * The control: no banner.
   *
   * `--clear-banners` dismisses every transient notice and waits for the region
   * to be empty before the recorder is armed. It is §2.5's control *and* the
   * falsification of the banner reading above in one run: if the band still
   * moves with no banner in the flex column, the complementarity is not the
   * cause and the record has to say so.
   */
  let clearedBanners = null
  if (CLEAR_BANNERS) {
    const before = await evaluate(`document.querySelectorAll('.iris-notice').length`)
    await evaluate(`(() => {
      for (const el of document.querySelectorAll('.iris-notice__dismiss')) el.click()
      return true
    })()`)
    for (let at = 0; at < 40; at += 1) {
      const left = await evaluate(`document.querySelectorAll('.iris-notice').length`)
      if (left === 0) break
      await delay(250)
    }
    clearedBanners = { before, after: await evaluate(`document.querySelectorAll('.iris-notice').length`) }
  }

  // Armed **first**, before any waiting: the band is published by the shell
  // while the greeting's document is still parsing, so a recorder that starts
  // after the manual's 10 s wait would open on a picture that has already
  // changed and call it still.
  const tracePromise = evaluate(recorderExpr(seconds, SUPPRESS_BANNERS), (seconds + 45) * 1000)
  const settle = []
  let mounted = null
  const settleStarted = Date.now()
  while (Date.now() - settleStarted < waitMs) {
    const seen = await evaluate(framesExpr)
    if (seen?.error !== undefined) return { label, chatId, error: seen.error }
    if (mounted === null && Array.isArray(seen?.frames) && seen.frames.length > 0) mounted = seen
    if (seen?.band !== undefined) {
      settle.push({
        pageNow: seen.pageNow,
        wall: Date.now(),
        band: seen.band.atFrames.join('|'),
        scrollerInline: seen.band.scrollerInline,
        scrollerClientHeight: seen.band.scrollerClientHeight,
        heights: seen.frames.map(f => f.h),
        inline: seen.frames.map(f => f.inline),
      })
    }
    await delay(1000)
  }
  /*
   * Which conversation is actually on screen, said with the evidence available.
   *
   * The manual's own recipe creates a conversation and measures *that* one, and
   * the shell opens it as soon as the card page's action is pressed — so there
   * is nothing to click. But "the reader is looking at the conversation I just
   * created" has to be a reading rather than an assumption, and the surfaces
   * that could prove it are thin: chat rows carry no conversation id (only
   * `aria-current`, which says *that one is open*, not *which* one), and every
   * conversation of this card is titled `创世回廊1.3`. What is checkable:
   *
   *  - the sidebar's current row is the chats list's **first** row, and the host
   *    lists chats newest-first, so the open conversation is the newest one;
   *  - the open conversation is the one whose id the host reported as new;
   *  - the page shows exactly as many message floors as that conversation has
   *    messages.
   *
   * All three are recorded. If they disagree this returns an error rather than a
   * measurement, because a reading pinned to the wrong conversation under the
   * right conversation's name is worse than no reading (`qa/README.md`).
   */
  let identity = null
  if (alreadyOpen) {
    const view = await rpc('chat.open', { chatId }).then(r => r.view).catch(() => null)
    const evidence = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.iris-list .iris-row--chat')]
      const currentAt = rows.findIndex(el => el.getAttribute('aria-current') === 'true')
      return {
        rows: rows.length,
        currentAt,
        currentTitle: currentAt < 0 ? null : (rows[currentAt].querySelector('.iris-row__title')?.textContent ?? '').trim(),
        floors: document.querySelectorAll('.iris-msg').length,
      }
    })()`)
    const listed = (await rpc('chat.list', {})).chats.filter(c => c.characterId === CHARACTER)
    identity = {
      expected: { chatId, messageCount: listed.find(c => c.chatId === chatId)?.messageCount ?? null },
      newestId: listed[0]?.chatId ?? null,
      viewMessages: view?.messages?.length ?? null,
      page: evidence,
    }
    identity.currentRowIsNewest = evidence.currentAt === 0 && identity.newestId === chatId
    identity.floorsMatch = evidence.floors === identity.expected.messageCount
    if (!identity.currentRowIsNewest || !identity.floorsMatch) {
      return { label, chatId, error: 'could not confirm the open conversation is the one just created', identity }
    }
  }

  const showing = await evaluate(`(() => ({ title: (document.querySelector('.iris-masthead__title')?.textContent ?? '').trim() }))()`)
  const before = await evaluate(framesExpr)
  const paint = await evaluate(paintProbeExpr)
  const trace = await tracePromise
  const after = await evaluate(framesExpr)
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })
  const name = `${label}-${chatId.replace(/[^\p{L}\p{N}-]+/gu, '-')}`
  writeFileSync(new URL(`./results/review6/${name}.jpeg`, import.meta.url), Buffer.from(shot.result?.data ?? '', 'base64'))
  const result = {
    label, chatId, opened, showing, identity, mountFrames: mounted, consent, clearedBanners,
    suppressed: SUPPRESS_BANNERS,
    settle: {
      windowMs: waitMs,
      samples: settle,
      distinctBands: [...new Set(settle.map(s => s.band))],
      distinctHeights: [...new Set(settle.map(s => s.heights.join(',')))],
    },
    framesBefore: before, framesAfter: after, paint,
    seconds,
    trace: trace?.error !== undefined ? trace : { t0: trace.t0, wall0: trace.wall0, armedAtMs: trace.armedAtMs, rows: trace.rows },
    reading: trace?.error !== undefined ? null : analyze(trace.rows, trace.wall0, settle),
  }
  writeFileSync(new URL(`./results/review6/${name}.json`, import.meta.url), JSON.stringify(result, null, 2))
  return result
}

// ------------------------------------------------------------------ run
const userDataDir = `${process.env.TEMP ?? '/tmp'}/iris-r6-${DEBUG_PORT}-${String(Date.now())}`
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run', '--no-default-browser-check', '--headless=new',
  '--window-size=1500,950', 'about:blank',
], { stdio: 'ignore' })

const report = { base: BASE, at: new Date().toISOString(), seconds: SECONDS, debugPort: DEBUG_PORT, runs: [] }
try {
  let page
  for (let at = 0; at < 30 && page === undefined; at += 1) {
    await delay(1000)
    try {
      const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`).then(r => r.json())
      page = targets.find(x => x.type === 'page' && x.url.startsWith('about:blank'))
    } catch { /* not up yet */ }
  }
  if (page === undefined) throw new Error('chrome never came up')
  const session = socket(page.webSocketDebuggerUrl)
  await session.opened
  await send0(session)
  await session.send('Page.navigate', { url: BASE })
  await delay(8000)
  report.boot = await session.evaluate(`(() => ({ title: document.title, composer: document.querySelector('.iris-composer') !== null }))()`)

  /*
   * The manual's own path first: a **new** conversation, created through the
   * shell, exactly as REVIEW-2 measured the anomaly.
   */
  if (NEW_CONVERSATION) {
    const created = await createConversation(session, CHARACTER, DISPLAY_NAME)
    if (created.error !== undefined) {
      report.runs.push({ label: 'new-conversation', error: created.error, titles: created.titles })
    } else {
      report.runs.push(await drive(session, { chatId: created.chatId, alreadyOpen: true }, 'new-conversation', SECONDS))
    }
  }
  /*
   * The existing-chat runs, when they are unambiguous on this profile. They are
   * named `existing-*` rather than `greeting`/`reply-control` because a
   * one-message conversation is a *greeting* and a three-message one is a
   * *reply* floor — which conversation is which is a property of the profile,
   * not of this script, and the record should not imply otherwise.
   */
  if (!SKIP_EXISTING) {
    report.runs.push(await drive(session, CHAT_GREETING, 'existing-greeting-chat', SECONDS))
    if (!SKIP_REPLY) report.runs.push(await drive(session, CHAT_REPLY, 'existing-reply-chat', SECONDS))
  }

  report.console = session.consoleLines.slice(0, 200)
} finally {
  /*
   * One report per invocation, named for the switches that made it. A single
   * `report.json` overwritten by each run of the three-run wrapper leaves the
   * evidence set with only the last run's report, which is how a control run
   * silently becomes the only reading.
   */
  const suffix = [
    NEW_CONVERSATION ? 'new' : 'existing',
    CLEAR_BANNERS ? 'cleared' : null,
    SUPPRESS_BANNERS ? 'suppressed' : null,
  ].filter(part => part !== null).join('-')
  writeFileSync(new URL(`./results/review6/report-${suffix}.json`, import.meta.url), JSON.stringify(report, null, 2))
  chrome.kill()
  await delay(500)
}

for (const run of report.runs) {
  console.log(`\n=== ${run.label} (${run.chatId}) ===`)
  if (run.error !== undefined) { console.log(`  ERROR: ${run.error}`); continue }
  if (run.reading === null) {
    console.log(`  TRACE FAILED: ${JSON.stringify(run.trace)}`)
    console.log(`  settle: ${JSON.stringify(run.settle)}`)
    continue
  }
  console.log(`  consent: ${JSON.stringify(run.consent)}  showing: ${JSON.stringify(run.showing)}  clearedBanners: ${JSON.stringify(run.clearedBanners)}`)
  if (run.identity !== undefined && run.identity !== null) console.log(`  identity: ${JSON.stringify(run.identity)}`)
  console.log(`  settle window ${String(run.settle?.windowMs)}ms: bands ${JSON.stringify(run.settle?.distinctBands)} heights ${JSON.stringify(run.settle?.distinctHeights)}`)
  console.log(`  frames before: ${JSON.stringify(run.framesBefore)}`)
  console.log(`  frames after:  ${JSON.stringify(run.framesAfter)}`)
  console.log(`  shell paint: ${JSON.stringify(run.paint)}`)
  const r = run.reading
  console.log(`  band ${r.band.first} -> ${r.band.last} values ${JSON.stringify(r.band.values)} published ${JSON.stringify(r.band.publishedValues)} changes=${r.band.changeCount} ${JSON.stringify(r.band.changes)} movedWithNoFrameReport=${String(r.band.movedWithoutFrameReport)}`)
  console.log(`  used-height changes with the band held: ${r.changedWithBandHeld}`)
  console.log(`  neighbours that moved: ${JSON.stringify(r.neighboursThatMoved)}`)
  console.log(`  band + banner = ${JSON.stringify(r.complementSums)} (holds: ${String(r.complementHolds)}) — samples: ${JSON.stringify(r.bandPlusBanner.map(row => `${String(row.t)}:${String(row.band)}+${String(row.banner)}=${String(row.sum)}`))}`)
  console.log(`  banners seen: ${JSON.stringify(r.banners)}`)
  console.log(`  controls: dismissed ${String(r.dismissals.length)} time(s) — ${JSON.stringify(r.dismissals.map(row => `${String(row.t)}ms x${String(row.count)}`))}`)
  console.log(`  frame body.scrollHeight values reported: ${JSON.stringify(r.frameBodyScrollHeights)}`)
  console.log(`  timeline (wall-clock, both windows on one clock):`)
  for (const row of r.timeline) console.log(`    ${new Date(row.wall).toISOString().slice(11, 23)} ${row.source.padEnd(7)} band ${String(row.band).padEnd(7)} heights ${JSON.stringify(row.heights)}`)
  console.log(`  shell samples ${r.samples}, distinct heights ${JSON.stringify(r.distinctShellHeights)}`)
  console.log(`  settled=${String(r.settled)} lastThird=${JSON.stringify(r.lastThirdDistinct)} changes=${r.changeCount} amplitude=${r.amplitudePx}px periods=${JSON.stringify(r.periodsMs)} lastChangeAt=${String(r.lastChangeAtMs)}ms`)
  console.log(`  frame reports=${r.frameReports} pixels=${JSON.stringify(r.frameReportPixels)} frameFirst=${r.frameFirst} shellFirst=${r.shellFirst}`)
  console.log(`  notes=${r.noteCount}`)
  console.log(`    first: ${r.firstNote}`)
  console.log(`    last:  ${r.lastNote}`)
}
console.log('\nresults -> qa/results/review6/')

async function send0(session) {
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Log.enable')
}
