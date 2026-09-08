/**
 * Why the DeepSeek prefix cache misses, across every conversation in a profile,
 * ranked by the tokens each cause costs.
 *
 * `cache-prefix-probe.mjs` answered "where do the last two requests of ONE
 * conversation stop agreeing". This answers the next two questions: **which
 * causes** are in play across the whole corpus, and **how much** each one costs
 * — in tokens, in 64-token blocks, because that is the unit DeepSeek bills and
 * the unit a fix has to move.
 *
 *   node scripts/cache-cause-census.mjs
 *   IRIS_CENSUS_JSON=out.json node scripts/cache-cause-census.mjs
 *   IRIS_CENSUS_CHATS='爱衣' node scripts/cache-cause-census.mjs
 *   IRIS_CENSUS_INJECT=0 node scripts/cache-cause-census.mjs    # skip §4
 *
 * Nothing is sent and nothing is written to the operator's profile: the profile
 * is copied per conversation and the injected `stream` captures the request and
 * throws. See `scripts/lib/cache-host.mjs`.
 *
 * ## The four measurements, and what each one can and cannot see
 *
 * 1. **Same state, assembled twice.** Every conversation, including the ones
 *    with no history. A pair that differs here has a ceiling *regardless of
 *    history growth* — the cause is inside one turn, and the usual culprit is a
 *    card author's `{{random}}` / `{{roll}}`. This is the only measurement that
 *    covers the whole corpus, because it needs no second round.
 *
 * 2. **Real adjacent rounds.** Only two conversations in this corpus have more
 *    than one generated reply, so this is a small sample and says so. The
 *    trailing reply is peeled first, because `historyFromSession` projects every
 *    derived message and a regenerate on an intact log would assemble a state
 *    that was never sent.
 *
 * 3. **One synthetic round.** Uniform across the corpus: take the stored log,
 *    and compare "the request that produced the last stored reply" against "the
 *    request one exchange later". Only the *next user line* is invented — the
 *    assistant turn between them is the card's own real reply. For a
 *    conversation holding nothing but its greeting both lines are invented, and
 *    the row is marked so. This is what makes a census possible at all: it asks
 *    every card the same question, "where does one exchange of growth put your
 *    first divergence".
 *
 * 4. **A card-script injection, placed by the real code.** `placementFor`
 *    (`service.ts:4273`) decides where `script.setExtensionPrompt` lands, and
 *    since `ecc0b3e` that is *beside the preset's `main` prompt* rather than
 *    after every preset section. The experiment registers an injection through
 *    the real RPC and measures the ceiling for each position, twice: with the
 *    content changing between the two rounds and with it held constant. The
 *    content's shape is MVU's, the placement is the product's own.
 *
 * ## What none of them can see
 *
 * A real card script's injections. `ChatEntry.extensionPrompts` is an in-memory
 * `Map` (`entry.ts:329`) that never reaches disk, so measurement 4 is the only
 * way that traffic appears here at all — as a controlled stand-in, never as the
 * card's own bytes.
 *
 * @module scripts/cache-cause-census
 */

import { readdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  BLOCK_TOKENS, DEFAULT_PROFILE, SCRATCH_ROOT,
  buildHost, bytes, catalogFor, compare, copyProfile, estimateTokens,
  labeller, percent, profilePaths, segmentsOf, serializeRequest, textOf, volatileMacrosIn,
} from './lib/cache-host.mjs'

const DATA = process.env.IRIS_PROBE_DATA
  ?? 'D:/workspace/小项目/iris_cordis_traven/apps/iris/data'
const PROFILE = process.env.IRIS_PROFILE ?? DEFAULT_PROFILE
/** Restrict the census to conversations whose id contains one of these. */
const ONLY = (process.env.IRIS_CENSUS_CHATS ?? '').split(',').map(part => part.trim()).filter(Boolean)
/** How many real adjacent pairs to walk back per conversation. */
const ROUNDS = Number(process.env.IRIS_CENSUS_ROUNDS ?? 12)
/** Run the injection experiment (§4). */
const INJECT = process.env.IRIS_CENSUS_INJECT !== '0'
/** Conversations the injection experiment runs on; empty means every one with history. */
const INJECT_CHATS = (process.env.IRIS_CENSUS_INJECT_CHATS ?? '').split(',').map(p => p.trim()).filter(Boolean)

/** The synthetic lines, fixed so two runs of this script are comparable. */
const SYNTH = {
  user: '（缓存普查占位：这是探针写入的下一轮用户发言，内容固定。）',
  reply: '（缓存普查占位：这是探针写入的一条回复，内容固定。）',
}

/**
 * The catalog, plus the lines this script wrote itself.
 *
 * Without these two rows a synthetic line is the one thing in the request no
 * catalog can name, so eleven conversations charged their whole synthetic-pair
 * loss to `unmatched` — a bucket that reads as "no cause found" when the cause
 * was the growth this script deliberately introduced.
 * @param host - a built host.
 * @param handlers - its handlers.
 * @param view - the opened chat view.
 * @param extra - further items to list first.
 * @returns the catalog.
 */
async function censusCatalog(host, handlers, view, extra = []) {
  return [
    ...extra,
    { name: 'synthetic user line (this script)', cause: 'history', detail: 'probe filler', text: SYNTH.user },
    { name: 'synthetic reply (this script)', cause: 'history', detail: 'probe filler', text: SYNTH.reply },
    ...await catalogFor(host, handlers, view),
  ]
}

// --- §4's stand-in content -------------------------------------------------

/**
 * An injection shaped like MagVarUpdate's, in two versions.
 *
 * The volatile part is one line naming the turn — the smallest change a real
 * per-turn injection can make, and therefore the *kindest* case: anything a
 * real card script varies (a variable diff, a timestamp, an observation log)
 * changes at least this much. The stable part is padded to a realistic size so
 * the two versions differ in one line out of many, which is exactly the shape
 * that makes a prefix cache collapse: the size of the change is irrelevant, its
 * position is everything.
 * @param round - which round's version to build.
 * @returns the injection text.
 */
function mvuShapedInjection(round) {
  const stable = [
    '<variable_rules>',
    '你必须在回复末尾输出 <UpdateVariable> 块，列出本轮变化的变量。',
    '规则：只写变化的键；数值用 _.set 语义；不要重复未变化的键。',
    '</variable_rules>',
  ].join('\n')
  const volatile = `<current_state>回合 ${String(round)}：好感度 ${String(40 + round)}，时间 08:${String(10 + round).padStart(2, '0')}</current_state>`
  return `${stable}\n${volatile}`
}

// --- the log, read straight off the copy -----------------------------------

/** The header of one chat file, for the names a created message needs. */
async function namesOf(chatsDir, chatId) {
  try {
    const text = await readFile(join(chatsDir, `${chatId}.jsonl`), 'utf8')
    const header = JSON.parse(text.slice(0, text.indexOf('\n')))
    return {
      user: typeof header.user_name === 'string' ? header.user_name : 'User',
      character: typeof header.character_name === 'string' ? header.character_name : 'Assistant',
    }
  } catch {
    return { user: 'User', character: 'Assistant' }
  }
}

/** Provider-reported usage per generation, read from the stored file. */
async function usageOf(chatsDir, chatId) {
  const rows = []
  let text
  try { text = await readFile(join(chatsDir, `${chatId}.jsonl`), 'utf8') } catch { return rows }
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (!line.includes('iris_usage')) return
    let parsed
    try { parsed = JSON.parse(line) } catch { return }
    const list = parsed.extra?.iris_usage ?? parsed.iris_usage
    if (!Array.isArray(list)) return
    list.forEach((usage, swipe) => {
      if (usage === null || typeof usage !== 'object') return
      const hit = Number(usage.cacheReadTokens ?? 0)
      const miss = Number(usage.inputTokens ?? 0)
      rows.push({
        line: index + 1,
        swipe,
        billed: miss + hit,
        miss,
        hit,
        share: miss + hit === 0 ? null : hit / (miss + hit),
        output: Number(usage.outputTokens ?? 0),
        ...usage.promptHash === undefined ? {} : { promptHash: usage.promptHash },
        ...usage.prefixHash === undefined ? {} : { prefixHash: usage.prefixHash },
        ...usage.model === undefined ? {} : { model: usage.model },
        ...usage.at === undefined ? {} : { at: usage.at },
      })
    })
  })
  return rows
}

// --- state shaping ---------------------------------------------------------

/** Append messages through the real RPC, retrying while the chat is still busy. */
async function append(handlers, chatId, messages) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await handlers['script.createChatMessages']({ chatId, messages })
      return
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (!/busy|idle|generat/iu.test(text)) throw error
      await new Promise(done => { setTimeout(done, 25) })
    }
  }
  throw new Error(`could not append to ${chatId}: still busy`)
}

/**
 * Shape a conversation into "round N" and record how.
 *
 * `real-tail` is the honest case: the stored log's last reply is peeled, so
 * round N is the state that produced it and round N+1 is the stored log with
 * one synthetic user line. `synthetic-both` is a conversation holding only its
 * greeting, where both lines of the exchange have to be invented.
 * @param handlers - the host's handlers.
 * @param chatId - the conversation.
 * @param names - the file's own speaker names.
 * @returns how it was shaped, or a reason it could not be.
 */
async function shapeRoundN(handlers, chatId, names) {
  const messages = (await handlers['chat.open']({ chatId })).view.messages
  if (messages.length === 0) return { kind: 'empty', reason: 'no messages' }
  const last = messages.at(-1)
  if (last.role !== 'assistant') {
    // Already ends with a user line: round N is the log as stored.
    return { kind: 'tail-user', peeled: 0 }
  }
  if (messages.length === 1) {
    // Nothing but the greeting. Both halves of the exchange are invented.
    await append(handlers, chatId, [{ name: names.user, is_user: true, mes: SYNTH.user }])
    return { kind: 'synthetic-both', peeled: 0 }
  }
  await handlers['chat.deleteMessage']({ chatId, id: last.id })
  return { kind: 'real-tail', peeled: 1, peeledText: last.text }
}

/**
 * Grow a shaped conversation by one exchange, into "round N+1".
 * @param handlers - the host's handlers.
 * @param chatId - the conversation.
 * @param names - the file's own speaker names.
 * @param shape - what {@link shapeRoundN} did.
 */
async function growOneExchange(handlers, chatId, names, shape) {
  const reply = shape.kind === 'real-tail' ? shape.peeledText : SYNTH.reply
  await append(handlers, chatId, [
    { name: names.character, is_user: false, mes: reply },
    { name: names.user, is_user: true, mes: SYNTH.user },
  ])
}

// --- cause bookkeeping -----------------------------------------------------

/** The bucket a pair's loss is charged to, and the macros implicated. */
function causeOf(pair) {
  if (pair.firstDiff === null) return { cause: 'identical', macros: [] }
  const macros = pair.firstDiff.macros ?? []
  return {
    cause: pair.firstDiff.cause,
    kind: pair.firstDiff.kind,
    name: pair.firstDiff.name,
    detail: pair.firstDiff.detail,
    where: pair.firstDiff.where,
    ...pair.firstDiff.sample === undefined ? {} : { sample: pair.firstDiff.sample },
    ...pair.firstDiff.section === undefined ? {} : { section: pair.firstDiff.section },
    macros,
  }
}

/** Everything that changed after the divergence, folded by cause. */
function changedByCause(pair) {
  const folded = new Map()
  for (const change of pair.changed) {
    const key = change.cause
    const row = folded.get(key) ?? { cause: key, segments: 0, bytes: 0, kinds: new Set(), macros: new Set() }
    row.segments += 1
    row.bytes += change.bytes
    row.kinds.add(change.kind)
    for (const macro of change.macros ?? []) row.macros.add(`${macro.kind}:${macro.name}`)
    folded.set(key, row)
  }
  return [...folded.values()]
    .sort((left, right) => right.bytes - left.bytes)
    .map(row => ({ ...row, kinds: [...row.kinds], macros: [...row.macros] }))
}

/**
 * Counterfactual ceilings, in two directions, because the advice has two halves.
 *
 * `without` deletes the content: what the ceiling would be if the card author
 * dropped it. `hoisted` moves it into the head: what the ceiling would be if it
 * sat in the stable prefix instead of behind the growth point. For content that
 * is byte-identical between the two rounds `hoisted` is the gain a placement
 * change buys; for content that changes every turn it is the collapse the same
 * change causes, and the same number says which.
 * @param pair - a comparison from `compare`.
 * @returns both families, keyed by cause.
 */
function counterfactuals(pair) {
  const volatile = (_segment, named) =>
    (named.macros ?? []).some(macro => macro.kind === 'entropy' || macro.kind === 'clock')
  const out = { without: {}, hoisted: {} }
  for (const cause of ['depth', 'worldInfoAfter', 'worldInfoBefore', 'scriptInject']) {
    const accepts = (_segment, named) => named.cause === cause
    out.without[cause] = pair.ceilingWithout(accepts)
    out.hoisted[cause] = pair.ceilingHoisting(accepts)
  }
  // Every entry that reads an entropy or clock macro, wherever it sits: the one
  // change a card author can make without moving anything.
  out.without.volatileMacros = pair.ceilingWithout(volatile)
  // Both at once — the best a placement-only fix can do: static depth content
  // hoisted into the prefix, volatile macros gone.
  out.hoisted.depthMinusVolatile = pair.ceilingHoisting((segment, named) =>
    named.cause === 'depth' && !volatile(segment, named))
  return out
}

/** A pair, reduced to the row the report prints and the ledger sums. */
function rowOf(label, pair) {
  return {
    label,
    bodyBytes: pair.bodyBytes,
    ceiling: pair.ceiling,
    divergeAt: pair.divergeAt,
    segments: pair.segments,
    cause: causeOf(pair),
    ...pair.displaced === null || pair.displaced === undefined ? {} : {
      displaced: {
        cause: pair.displaced.cause, where: pair.displaced.where,
        kind: pair.displaced.kind, name: pair.displaced.name, bytes: pair.displaced.bytes,
      },
    },
    changed: changedByCause(pair),
    wasted: pair.wasted,
    lossAfterPrefix: pair.lossAfterPrefix,
    counterfactuals: counterfactuals(pair),
  }
}

// --- §4 -------------------------------------------------------------------

const INJECTION_KEY = 'census_mvu_stand_in'
const VARIANTS = [
  { name: "position 'before'", position: 'before', depth: 0 },
  { name: "position 'after'", position: 'after', depth: 0 },
  { name: "at-depth 0", position: 'at-depth', depth: 0 },
  { name: "at-depth 2", position: 'at-depth', depth: 2 },
]

/**
 * Measure what one per-turn injection does to the ceiling, per position.
 *
 * Run on one host: assembling is non-destructive (the generation is refused),
 * so round N can be assembled once per variant, the log grown by one exchange,
 * and round N+1 assembled once per variant against the same copy.
 * @param host - the built host.
 * @param chatId - the conversation.
 * @param names - the file's speaker names.
 * @param label - the labeller for this conversation.
 * @returns one row per variant, plus the no-injection baseline.
 */
async function injectionExperiment(host, chatId, names, label) {
  const { handlers, assembleOnce } = host
  const shape = await shapeRoundN(handlers, chatId, names)
  if (shape.kind === 'empty') return { skipped: shape.reason }

  const set = async (variant, value) => {
    await handlers['script.setExtensionPrompt']({
      chatId, key: INJECTION_KEY, value, position: variant.position, depth: variant.depth,
      role: 'system', scan: false, runId: 'census',
    })
  }
  const clear = async () => {
    // `position: 'none'` is registered and never assembled — the one position
    // that yields no placement (`service.ts:4345`). Cleaner than deleting,
    // because it exercises the same registration path as the variants.
    await handlers['script.setExtensionPrompt']({
      chatId, key: INJECTION_KEY, value: '', position: 'none', depth: 0, runId: 'census',
    })
  }

  const roundA = {}
  await clear()
  roundA.baseline = await assembleOnce(chatId)
  for (const variant of VARIANTS) {
    await set(variant, mvuShapedInjection(1))
    roundA[variant.name] = await assembleOnce(chatId)
  }

  await clear()
  await growOneExchange(handlers, chatId, names, shape)

  const roundB = { volatile: {}, stable: {} }
  await clear()
  roundB.baseline = await assembleOnce(chatId)
  for (const variant of VARIANTS) {
    await set(variant, mvuShapedInjection(2))
    roundB.volatile[variant.name] = await assembleOnce(chatId)
    await set(variant, mvuShapedInjection(1))
    roundB.stable[variant.name] = await assembleOnce(chatId)
  }

  const pair = (a, b) => compare(a.options, b.options, label, b.itemization)
  const rows = [rowOf('no injection (baseline)', pair(roundA.baseline, roundB.baseline))]
  for (const variant of VARIANTS) {
    rows.push(rowOf(`${variant.name}, content CHANGES between rounds`,
      pair(roundA[variant.name], roundB.volatile[variant.name])))
    rows.push(rowOf(`${variant.name}, content HELD CONSTANT`,
      pair(roundA[variant.name], roundB.stable[variant.name])))
  }
  return { shape: shape.kind, rows }
}

// --- one conversation ------------------------------------------------------

/**
 * Everything measured for one conversation.
 * @param source - the profile root to copy.
 * @param chatId - the conversation.
 * @param chatsDir - the source chats directory, for the raw file.
 * @param wantInjection - whether to run §4 here.
 * @returns the conversation's rows.
 */
async function censusChat(source, chatId, chatsDir, wantInjection) {
  const names = await namesOf(chatsDir, chatId)
  const usage = await usageOf(chatsDir, chatId)
  const result = { chatId, names, usage, notes: [] }

  // --- one host for the inventory, the same-state control and the real pairs
  const first = await copyProfile(source, PROFILE, SCRATCH_ROOT)
  try {
    const host = await buildHost(first.dataDir, PROFILE)
    const view = (await host.handlers['chat.open']({ chatId })).view
    result.messages = view.messages.length
    result.characterId = view.characterId
    result.assistantMessages = view.messages.filter(message => message.role === 'assistant').length
    const label = labeller(await censusCatalog(host, host.handlers, view))

    try {
      const itemization = (await host.handlers['prompt.itemize']({ chatId })).itemization
      result.itemization = {
        tokens: itemization.tokens,
        droppedHistory: itemization.droppedHistory,
        overBudget: itemization.overBudget,
        budget: itemization.budget,
        entries: itemization.entries.map(entry => ({
          id: entry.id, label: entry.label, kind: entry.kind,
          ...entry.depth === undefined ? {} : { depth: entry.depth },
          tokens: entry.tokens,
        })),
      }
    } catch (error) {
      result.notes.push(`itemize refused: ${error instanceof Error ? error.message : String(error)}`)
    }

    // (1) same state, assembled twice
    try {
      const one = await host.assembleOnce(chatId)
      const two = await host.assembleOnce(chatId)
      const control = compare(one.options, two.options, label, two.itemization)
      result.sameState = rowOf('same state, assembled twice', control)
      result.sameState.identical = control.identicalBody
      if (!control.identicalBody) {
        // Which characters moved, so the macro can be named rather than guessed.
        const left = segmentsOf(one.options)
        const right = segmentsOf(two.options)
        const at = control.segments.sharedHead
        const a = left[at]?.text ?? ''
        const b = right[at]?.text ?? ''
        let cut = 0
        while (cut < Math.min(a.length, b.length) && a[cut] === b[cut]) cut += 1
        result.sameState.jitter = {
          segment: at,
          char: cut,
          a: a.slice(Math.max(0, cut - 60), cut + 60),
          b: b.slice(Math.max(0, cut - 60), cut + 60),
        }
      }
      result.serializeStable = JSON.stringify(serializeRequest(one.options))
        === JSON.stringify(serializeRequest(one.options))
    } catch (error) {
      result.notes.push(`same-state control unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }

    // (2) real adjacent rounds, walking backwards
    const rounds = []
    for (let step = 0; step <= ROUNDS; step += 1) {
      const current = (await host.handlers['chat.open']({ chatId })).view.messages
      if (current.length < 2) break
      if (current.at(-1)?.role === 'assistant') {
        await host.handlers['chat.deleteMessage']({ chatId, id: current.at(-1).id })
        continue
      }
      try {
        rounds.push({ messages: current.length, ...await host.assembleOnce(chatId) })
      } catch (error) {
        result.notes.push(`round at ${String(current.length)} messages did not assemble: `
          + `${error instanceof Error ? error.message : String(error)}`)
        break
      }
      for (let peel = 0; peel < 2; peel += 1) {
        const now = (await host.handlers['chat.open']({ chatId })).view.messages
        if (now.length <= 1) break
        await host.handlers['chat.deleteMessage']({ chatId, id: now.at(-1).id })
      }
    }
    result.realPairs = rounds.slice(0, -1).map((_unused, index) => {
      const older = rounds[rounds.length - 1 - index]
      const newer = rounds[rounds.length - 2 - index]
      return {
        ...rowOf(`real ${String(older.messages)} -> ${String(newer.messages)} messages`,
          compare(older.options, newer.options, label, newer.itemization)),
        from: older.messages,
        to: newer.messages,
      }
    })
  } finally {
    await rm(first.scratch, { recursive: true, force: true })
  }

  // --- (3) the synthetic pair, on a fresh copy
  const second = await copyProfile(source, PROFILE, SCRATCH_ROOT)
  try {
    const host = await buildHost(second.dataDir, PROFILE)
    const view = (await host.handlers['chat.open']({ chatId })).view
    const label = labeller(await censusCatalog(host, host.handlers, view))
    const shape = await shapeRoundN(host.handlers, chatId, names)
    if (shape.kind === 'empty') {
      result.notes.push(`no synthetic pair: ${shape.reason}`)
    } else {
      const roundA = await host.assembleOnce(chatId)
      await growOneExchange(host.handlers, chatId, names, shape)
      const roundB = await host.assembleOnce(chatId)
      result.syntheticPair = rowOf(`synthetic +1 exchange (${shape.kind})`,
        compare(roundA.options, roundB.options, label, roundB.itemization))
      result.syntheticPair.shape = shape.kind
      result.syntheticTokens = {
        roundA: estimateTokens(textOf(roundA.options)),
        roundB: estimateTokens(textOf(roundB.options)),
      }
    }
  } catch (error) {
    result.notes.push(`synthetic pair failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(second.scratch, { recursive: true, force: true })
  }

  // --- (4) the injection experiment, on a fresh copy
  if (wantInjection) {
    const third = await copyProfile(source, PROFILE, SCRATCH_ROOT)
    try {
      const host = await buildHost(third.dataDir, PROFILE)
      const view = (await host.handlers['chat.open']({ chatId })).view
      // The stand-in goes into the catalog, or the divergence it causes is
      // reported as `unmatched` and the ranking charges §4's whole loss to a
      // bucket named "we could not tell".
      const label = labeller(await censusCatalog(host, host.handlers, view, [
        { name: 'script injection (census stand-in)', cause: 'scriptInject', detail: INJECTION_KEY, text: mvuShapedInjection(1) },
        { name: 'script injection (census stand-in)', cause: 'scriptInject', detail: INJECTION_KEY, text: mvuShapedInjection(2) },
      ]))
      result.injection = await injectionExperiment(host, chatId, names, label)
    } catch (error) {
      result.notes.push(`injection experiment failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await rm(third.scratch, { recursive: true, force: true })
    }
  }

  return result
}

// --- reporting -------------------------------------------------------------

function ceilingLine(row) {
  const c = row.ceiling
  return `bytes ${String(c.prefixBytes)}/${String(c.totalBytes)} = ${percent(c.prefixBytes, c.totalBytes)}`
    + `; tokens ~${String(c.prefixTokens)}/${String(c.totalTokens)}`
    + `; ${String(BLOCK_TOKENS)}-token blocks ${String(c.blockTokens)} = ${percent(c.blockTokens, c.totalTokens)} ceiling`
    + `; lost ~${String(c.lostTokens)} tok`
}

function printRow(row, indent = '    ') {
  console.log(`${indent}${row.label}`)
  console.log(`${indent}  ${ceilingLine(row)}`)
  if (row.cause.cause === 'identical') {
    console.log(`${indent}  identical requests`)
    return
  }
  const macros = row.cause.macros.length === 0
    ? ''
    : `  macros ${row.cause.macros.map(macro => `{{${macro.name}}}(${macro.kind})`).join(' ')}`
  console.log(`${indent}  first divergence: [${row.cause.cause}] ${row.cause.where} ${row.cause.kind}`
    + ` — ${row.cause.name} (${row.cause.detail})${macros}`)
  if (row.cause.section !== undefined) {
    console.log(`${indent}  host's itemization row for that offset: ${row.cause.section.id}`
      + ` ${row.cause.section.label ?? ''} (~${String(row.cause.section.tokens)} tok, approximate)`)
  }
  if (row.displaced !== undefined) {
    console.log(`${indent}  the older request held there: [${row.displaced.cause}] ${row.displaced.where}`
      + ` ${row.displaced.kind} ${String(row.displaced.bytes)} B — ${row.displaced.name}`)
  }
  console.log(`${indent}  after it: ${row.changed.map(change =>
    `${change.cause} ${String(change.segments)} seg ${String(change.bytes)} B`).join('; ')}`)
  console.log(`${indent}  rent (byte-identical yet behind the prefix): ${row.wasted.length === 0 ? 'none' : ''}`
    + row.wasted.map(entry => `${entry.cause} ~${String(entry.tokens)} tok / ${String(entry.bytes)} B`
      + ` [${entry.names.join(', ')}]`).join('; '))
  if (row.cause.sample !== undefined) {
    console.log(`${indent}  at char ${String(row.cause.sample.char)} of that block:`)
    console.log(`${indent}    before ${JSON.stringify(row.cause.sample.before)}`)
    console.log(`${indent}    after  ${JSON.stringify(row.cause.sample.after)}`)
  }
  // `n=` is the segment count the predicate touched. `n=0` means the figure
  // beside it is the unchanged ceiling and answers nothing.
  const share = figures => `${percent(figures.blockTokens, figures.totalTokens)}(n=${String(figures.touched)})`
  const cf = row.counterfactuals
  console.log(`${indent}  if the content were GONE — depth ${share(cf.without.depth)}`
    + `, worldInfoBefore ${share(cf.without.worldInfoBefore)}`
    + `, worldInfoAfter ${share(cf.without.worldInfoAfter)}`
    + `, entropy/clock macros ${share(cf.without.volatileMacros)}`)
  console.log(`${indent}  if HOISTED into the head — depth ${share(cf.hoisted.depth)}`
    + `, worldInfoBefore ${share(cf.hoisted.worldInfoBefore)}`
    + `, static depth only ${share(cf.hoisted.depthMinusVolatile)}`)
}

function report(result) {
  console.log(`\n### ${result.chatId}`)
  console.log(`  card ${result.characterId ?? '?'}; ${String(result.messages)} messages`
    + ` (${String(result.assistantMessages)} assistant); assembled ~${String(result.itemization?.tokens ?? 0)} tok`
    + `; dropped ${String(result.itemization?.droppedHistory ?? 0)}`
    + `; overBudget ${String(result.itemization?.overBudget ?? false)}`)
  if (result.usage.length > 0) {
    console.log(`  provider-reported usage (${String(result.usage.length)} generations):`)
    for (const row of result.usage) {
      console.log(`    line ${String(row.line)} swipe ${String(row.swipe)}: billed ${String(row.billed)}`
        + ` = miss ${String(row.miss)} + hit ${String(row.hit)} (${percent(row.hit, row.billed)})`
        + `${row.prefixHash === undefined ? '  [no fingerprint]' : `  prefix ${row.prefixHash} prompt ${row.promptHash}`}`
        + `${row.at === undefined ? '' : `  at ${new Date(row.at).toISOString()}`}`)
    }
  } else {
    console.log('  provider-reported usage: none recorded')
  }
  for (const note of result.notes) console.log(`  note: ${note}`)
  if (result.sameState !== undefined) {
    console.log(`  (1) same state twice: ${result.sameState.identical ? 'byte-identical' : 'JITTERS'}`)
    if (!result.sameState.identical) {
      printRow(result.sameState)
      console.log(`      A …${JSON.stringify(result.sameState.jitter.a)}`)
      console.log(`      B …${JSON.stringify(result.sameState.jitter.b)}`)
    }
  }
  if ((result.realPairs ?? []).length > 0) {
    console.log(`  (2) real adjacent rounds: ${String(result.realPairs.length)}`)
    for (const row of result.realPairs) printRow(row)
  } else {
    console.log('  (2) real adjacent rounds: none (fewer than two assemblable states)')
  }
  if (result.syntheticPair !== undefined) {
    console.log('  (3) synthetic +1 exchange')
    printRow(result.syntheticPair)
  }
  if (result.injection !== undefined) {
    if (result.injection.skipped !== undefined) {
      console.log(`  (4) injection experiment skipped: ${result.injection.skipped}`)
    } else {
      console.log(`  (4) injection experiment (shape ${result.injection.shape})`)
      for (const row of result.injection.rows) printRow(row, '      ')
    }
  }
}

/** Fold every pair into a ranking by cause. */
function ranking(results, pick) {
  const ledger = new Map()
  for (const result of results) {
    for (const row of pick(result)) {
      if (row.cause.cause === 'identical') continue
      const key = row.cause.cause
      const entry = ledger.get(key) ?? {
        cause: key, pairs: 0, lostTokens: 0, chats: new Set(),
        macros: new Map(), examples: [],
      }
      entry.pairs += 1
      entry.lostTokens += row.ceiling.lostTokens
      entry.chats.add(result.chatId)
      for (const macro of row.cause.macros) {
        entry.macros.set(`${macro.kind}:{{${macro.name}}}`, (entry.macros.get(`${macro.kind}:{{${macro.name}}}`) ?? 0) + 1)
      }
      if (entry.examples.length < 3) entry.examples.push(`${result.chatId} ${row.label}`)
      ledger.set(key, entry)
    }
  }
  const rows = [...ledger.values()].sort((left, right) => right.lostTokens - left.lostTokens)
  const total = rows.reduce((sum, row) => sum + row.lostTokens, 0)
  return rows.map(row => ({
    ...row,
    chats: [...row.chats],
    macros: [...row.macros.entries()].sort((left, right) => right[1] - left[1]),
    share: total === 0 ? 0 : row.lostTokens / total,
    total,
  }))
}

function printRanking(title, rows) {
  console.log(`\n## ${title}`)
  if (rows.length === 0) { console.log('  (no pairs)'); return }
  console.log('  cause | pairs | lost tokens | share | chats | macros implicated')
  for (const row of rows) {
    console.log(`  ${row.cause} | ${String(row.pairs)} | ${String(row.lostTokens)}`
      + ` | ${percent(row.lostTokens, row.total)} | ${String(row.chats.length)}`
      + ` | ${row.macros.map(([name, count]) => `${name}×${String(count)}`).join(' ') || '—'}`)
  }
  for (const row of rows) {
    console.log(`  · ${row.cause}: ${row.examples.join(' | ')}`)
  }
}

// --- main ------------------------------------------------------------------

async function main() {
  const source = profilePaths(resolve(DATA), PROFILE).root
  if (!existsSync(source)) {
    console.error(`no profile at ${source}; set IRIS_PROBE_DATA`)
    process.exitCode = 1
    return
  }
  const chatsDir = join(source, 'chats')
  const files = (await readdir(chatsDir)).filter(name => name.endsWith('.jsonl'))
  const ids = files.map(name => name.replace(/\.jsonl$/u, ''))
    .filter(id => ONLY.length === 0 || ONLY.some(part => id.includes(part)))

  console.log(`profile   ${source}`)
  console.log(`templates ${process.env.IRIS_TEMPLATES === '1' ? 'on' : 'off'}`)
  console.log(`chats     ${String(ids.length)} of ${String(files.length)}`)
  console.log(`injection experiment: ${INJECT ? 'on' : 'off'}`)

  const results = []
  for (const chatId of ids) {
    const raw = await readFile(join(chatsDir, `${chatId}.jsonl`), 'utf8')
    const lines = raw.split('\n').filter(line => line.trim().length > 0).length - 1
    const wantInjection = INJECT
      && (INJECT_CHATS.length === 0 ? lines >= 1 : INJECT_CHATS.some(part => chatId.includes(part)))
    process.stderr.write(`… ${chatId}\n`)
    try {
      const result = await censusChat(source, chatId, chatsDir, wantInjection)
      results.push(result)
      report(result)
    } catch (error) {
      console.log(`\n### ${chatId}: FAILED ${error instanceof Error ? error.stack : String(error)}`)
    }
  }

  printRanking('ranking over REAL adjacent pairs', ranking(results, result => result.realPairs ?? []))
  printRanking('ranking over SYNTHETIC pairs (one per conversation)',
    ranking(results, result => result.syntheticPair === undefined ? [] : [result.syntheticPair]))
  printRanking('ranking over the same-state control (volatility inside one turn)',
    ranking(results, result =>
      result.sameState === undefined || result.sameState.identical === true ? [] : [result.sameState]))

  // **The second ledger, and the one a placement fix moves.** The ranking above
  // charges a pair's whole loss to whatever sits at the boundary, which answers
  // "why did the prefix stop here". This answers "what are we paying for
  // twice": content the newer request repeats byte for byte from behind the
  // boundary. A cause can be large in one ledger and absent from the other —
  // new history is the whole of the first and none of the second — and reading
  // either one alone picks the wrong target.
  for (const [title, pick] of [
    ['rent by cause, over REAL adjacent pairs', result => result.realPairs ?? []],
    ['rent by cause, over SYNTHETIC pairs', result =>
      result.syntheticPair === undefined ? [] : [result.syntheticPair]],
  ]) {
    const ledger = new Map()
    for (const result of results) {
      for (const row of pick(result)) {
        for (const entry of row.wasted) {
          const held = ledger.get(entry.cause)
            ?? { cause: entry.cause, tokens: 0, bytes: 0, pairs: 0, chats: new Set(), names: new Set() }
          held.tokens += entry.tokens
          held.bytes += entry.bytes
          held.pairs += 1
          held.chats.add(result.chatId)
          for (const name of entry.names) held.names.add(name)
          ledger.set(entry.cause, held)
        }
      }
    }
    const rows = [...ledger.values()].sort((left, right) => right.tokens - left.tokens)
    const total = rows.reduce((sum, row) => sum + row.tokens, 0)
    console.log(`\n## ${title}`)
    if (rows.length === 0) { console.log('  (no pairs)'); continue }
    console.log('  cause | rent tokens | share | pairs | chats | who')
    for (const row of rows) {
      console.log(`  ${row.cause} | ${String(row.tokens)} | ${percent(row.tokens, total)}`
        + ` | ${String(row.pairs)} | ${String(row.chats.size)} | ${[...row.names].slice(0, 3).join(', ')}`)
    }
  }

  // **Each generation against the ceiling of its OWN round**, not against the
  // conversation's newest pair. A usage record on file line L was produced by a
  // request holding L-2 messages (line 1 is the header, so the reply at line L
  // is message L-1 and the prompt held everything before it), so the pair whose
  // newer side has L-2 messages is the one that bounds it. Comparing every
  // generation against the newest pair — the first version of this table —
  // charged 爱衣's early rounds against a ceiling measured on a conversation
  // twice as long, and the gap column was then a statement about two different
  // requests.
  console.log('\n## provider-reported vs the ceiling of the same round')
  console.log('  chat | line.swipe | messages | reported | ceiling of that round | gap | prefixHash')
  for (const result of results) {
    for (const row of result.usage) {
      const messages = row.line - 2
      const pair = (result.realPairs ?? []).find(candidate => candidate.to === messages)
      const ceiling = pair === undefined || pair.ceiling.totalTokens === 0
        ? null
        : pair.ceiling.blockTokens / pair.ceiling.totalTokens
      console.log(`  ${result.chatId} | ${String(row.line)}.${String(row.swipe)} | ${String(messages)}`
        + ` | ${percent(row.hit, row.billed)}`
        + ` | ${ceiling === null ? 'no pair measured' : `${(ceiling * 100).toFixed(1)}% (${pair.label})`}`
        + ` | ${ceiling === null ? '—' : `${((ceiling - (row.share ?? 0)) * 100).toFixed(1)} pp`}`
        + ` | ${row.prefixHash ?? '—'}`)
    }
  }

  if (process.env.IRIS_CENSUS_JSON !== undefined) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(process.env.IRIS_CENSUS_JSON, JSON.stringify(results, (_key, value) =>
      typeof value === 'function' ? undefined : value, 2), 'utf8')
    console.log(`\nwrote ${process.env.IRIS_CENSUS_JSON}`)
  }
}

await main()

// Referenced so a reader grepping for the byte helper finds it used here too.
void bytes
void volatileMacrosIn
