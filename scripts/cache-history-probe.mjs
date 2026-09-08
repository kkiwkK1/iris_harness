/**
 * The history side of the prefix cache, measured on real conversations.
 *
 * `scripts/cache-prefix-probe.mjs` answers "where do two adjacent requests stop
 * agreeing". This one answers three narrower questions about the part of the
 * request between the system prompt and the newest exchange — the conversation
 * itself:
 *
 * 1. **Does `squash_system_messages` move a boundary across text that was
 *    already sent?** Same conversation, same rounds, squash off and on; if the
 *    merge only ever happens at fixed distances from the END of the
 *    conversation then the ceiling is the same either way and the answer is no.
 * 2. **Do two swipes of one reply produce the same conversation bytes?** The
 *    control for the user's report that two swipes of the same floor arrived
 *    with different prefix hashes: if the host's own history bytes are
 *    identical, whatever moved was not on this side.
 * 3. **What does the budget trimmer cost once it starts firing?** No real
 *    conversation reaches the 32 768-token window (measured: `droppedHistory`
 *    is 0 on all 15), so the window is *narrowed* here until the trim engages,
 *    and the same rounds are then walked with `trimBlockFloors` at 0
 *    (upstream's per-floor trim) and at its default. The pair of numbers is the
 *    cost of upstream's shape and what the block buys.
 *
 *   node scripts/cache-history-probe.mjs
 *   IRIS_PROBE_CHATS='爱衣' IRIS_HISTORY_WINDOW=12000 node scripts/cache-history-probe.mjs
 *
 * Same discipline as the other probe, for the same reasons: the operator's
 * profile is **copied** to a scratch directory and the host runs against the
 * copy, the injected `stream` captures the request and then throws so no
 * candidate is written and no byte leaves the process, and every number is read
 * off the request the wire would have carried (`serializeRequest`) rather than
 * re-derived. What it cannot see is unchanged too: `script.inject` traffic lives
 * in a browser process that a headless run does not have, so these figures are
 * a floor.
 */

import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { serializeRequest } from '../packages/iris-llm-openai-compat/src/serialize.ts'

import { BackupStore, DEFAULT_BACKUP_KEEP } from '../packages/iris-app-service/src/backups.ts'
import { ChatStore } from '../packages/iris-app-service/src/chats.ts'
import { ConnectionStore } from '../packages/iris-app-service/src/connections.ts'
import { DiagnosticBuffer } from '../packages/iris-app-service/src/diagnostics.ts'
import { ExtensionSettingsStore, openGlobalScope } from '../packages/iris-app-service/src/context.ts'
import { FavoriteStore } from '../packages/iris-app-service/src/favorites.ts'
import { CharacterLibrary } from '../packages/iris-app-service/src/library.ts'
import { materialiseEmbeddedBook, WorldbookBindingStore } from '../packages/iris-app-service/src/materialise.ts'
import { DEFAULT_PROFILE, profilePaths } from '../packages/iris-app-service/src/paths.ts'
import { PersonaStore } from '../packages/iris-app-service/src/persona.ts'
import { PresetStore } from '../packages/iris-app-service/src/presets.ts'
import { DEFAULT_PRESET } from '../packages/iris-app-service/src/prompt.ts'
import { ScriptButtonStore } from '../packages/iris-app-service/src/script-buttons.ts'
import { ScriptPolicyStore } from '../packages/iris-app-service/src/scripts.ts'
import { ScriptVariableStore } from '../packages/iris-app-service/src/script-variables.ts'
import { SettingsStore } from '../packages/iris-app-service/src/settings.ts'
import { StInstall } from '../packages/iris-app-service/src/st-install.ts'
import { IrisAppService } from '../packages/iris-app-service/src/service.ts'
import { WorldbookStore } from '../packages/iris-app-service/src/worldbooks.ts'

const DATA = process.env.IRIS_PROBE_DATA
  ?? 'D:/workspace/小项目/iris_cordis_traven/apps/iris/data'
const PROFILE = process.env.IRIS_PROFILE ?? DEFAULT_PROFILE
const WANTED = (process.env.IRIS_PROBE_CHATS ?? '爱衣').split(',').map(part => part.trim()).filter(Boolean)
const SCRATCH = process.env.IRIS_PROBE_SCRATCH ?? join(tmpdir(), 'iris-cache-history')
/** How many adjacent-round pairs to walk. */
const ROUNDS = Number(process.env.IRIS_PROBE_ROUNDS ?? 6)
/**
 * The narrowed window the trim experiment runs under.
 *
 * Chosen per conversation when absent: small enough that the trimmer fires,
 * large enough that a few exchanges still survive. Named as a knob because the
 * number is an experimental condition, not a product setting.
 */
const WINDOW = process.env.IRIS_HISTORY_WINDOW === undefined ? undefined : Number(process.env.IRIS_HISTORY_WINDOW)
/**
 * Which sections to run: `squash`, `swipe`, `trim`, comma-separated.
 *
 * Each one rebuilds the profile copy from scratch several times, so running one
 * question at a time is the difference between a minute and ten.
 */
const SECTIONS = new Set((process.env.IRIS_HISTORY_SECTIONS ?? 'squash,swipe,trim,floors')
  .split(',').map(part => part.trim()).filter(Boolean))

const bytes = text => Buffer.byteLength(text, 'utf8')

/** Length in bytes of the longest common prefix of two strings, UTF-8. */
function commonPrefixBytes(left, right) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  if (index > 0 && index < limit) {
    const code = left.charCodeAt(index - 1)
    if (code >= 0xd800 && code <= 0xdbff) index -= 1
  }
  return bytes(left.slice(0, index))
}

/** The text of one captured request's message list, system prompt excluded. */
function conversationText(options) {
  return options.messages
    .map(message => `${message.role}\u0000${message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')}`)
    .join('\u0001')
}

/** The whole wire body, which is what the provider actually hashes a prefix of. */
const bodyText = options => JSON.stringify(serializeRequest(options))

class Captured extends Error {}

/** Stand up the service over a profile copy, with a capturing stream. */
async function buildHost(dataDir) {
  const warn = message => {
    if (process.env.IRIS_PROBE_VERBOSE === '1') {
      console.error(`  · ${message instanceof Error ? message.message : String(message)}`)
    }
  }
  const paths = profilePaths(dataDir, PROFILE)

  const library = new CharacterLibrary(paths.characters, '/iris/avatar')
  const scriptVariables = new ScriptVariableStore(paths.scriptVariables, warn)
  const extensionSettings = new ExtensionSettingsStore(paths.extensionSettings)
  const globalScope = await openGlobalScope(extensionSettings, warn)
  const worldbooks = new WorldbookStore(paths.worlds)
  const settings = new SettingsStore(paths.settings, { provider: 'default', model: 'local-model' })
  const worldbookBindings = new WorldbookBindingStore(paths.worldbookBindings, warn)
  const stInstall = new StInstall(undefined)
  const personas = new PersonaStore(paths.personas)
  const backups = new BackupStore(paths.chats, { keep: DEFAULT_BACKUP_KEEP, onError: warn })

  const bookFor = async (characterId, card) => {
    if (characterId === undefined) return undefined
    const done = await materialiseEmbeddedBook(characterId, card, worldbooks, worldbookBindings, stInstall)
    for (const line of done?.reports ?? []) warn(line)
    return done?.name
  }

  const chats = new ChatStore(
    paths.chats, library, scriptVariables, globalScope, worldbooks,
    () => settings.globalSelect(),
    bookFor,
    () => personas.activeSync() ?? '',
    () => extensionSettings.globalRegex(),
    characterId => settings.charBooks(characterId),
    backups,
  )

  await settings.load()
  await personas.prime()

  const captured = []
  const events = []
  const stream = async function* (options) {
    captured.push(options)
    throw new Captured('cache-history probe: request captured, not sent')
    // eslint-disable-next-line no-unreachable
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const service = new IrisAppService({
    stream,
    library,
    chats,
    settings,
    scripts: new ScriptPolicyStore(paths.scriptPolicy),
    extensionSettings,
    scriptButtons: new ScriptButtonStore(paths.scriptButtons, warn),
    worldbooks,
    connections: new ConnectionStore(paths.connections),
    personas,
    favorites: new FavoriteStore(paths.favorites),
    worldbookBindings,
    installConnection: () => {},
    scriptVariables,
    backups,
    preset: settings.presetBody() ?? DEFAULT_PRESET,
    ...settings.presetName() === undefined ? {} : { presetName: settings.presetName() },
    presets: new PresetStore(paths.presets),
    broadcast: event => { events.push(event) },
    diagnostics: new DiagnosticBuffer(),
    userName: process.env.IRIS_USER_NAME ?? 'User',
    contextWindow: Number(process.env.IRIS_CONTEXT_WINDOW ?? 32_768),
    ...process.env.IRIS_TRIM_BLOCK === undefined
      ? {}
      : { trimBlockFloors: Number(process.env.IRIS_TRIM_BLOCK) },
    onError: warn,
  })

  const handlers = service.handlers()

  /** Assemble one request for the newest turn and hand back what would be sent. */
  const assembleOnce = async chatId => {
    captured.length = 0
    events.length = 0
    const { turn } = await handlers['chat.regenerate']({ chatId })
    for (let tick = 0; tick < 4_000; tick += 1) {
      if (events.some(event => event.type === 'stream.error' || event.type === 'stream.end')) break
      await new Promise(done => { setTimeout(done, 5) })
    }
    if (captured.length !== 1) {
      throw new Error(`captured ${String(captured.length)} requests for turn ${String(turn)}`)
    }
    const { itemization } = await handlers['prompt.itemize']({ chatId, turn })
    return { options: captured[0], turn, itemization }
  }

  return { handlers, assembleOnce, settings }
}

/**
 * Walk one conversation backwards, capturing the request of each round.
 *
 * The trailing reply is peeled first: `historyFromSession` projects every
 * derived message, so assembling an intact log measures a request nobody sent.
 * @returns rounds newest-first, each with its captured request.
 */
async function walk(host, chatId, rounds) {
  const { handlers, assembleOnce } = host
  const view = (await handlers['chat.open']({ chatId })).view
  if (view.messages.at(-1)?.role === 'assistant') {
    await handlers['chat.deleteMessage']({ chatId, id: view.messages.at(-1).id })
  }

  const walked = []
  for (let step = 0; step <= rounds; step += 1) {
    const current = (await handlers['chat.open']({ chatId })).view.messages
    if (current.length < 2) break
    walked.push({ messages: current.length, ...await assembleOnce(chatId) })
    for (let peel = 0; peel < 2; peel += 1) {
      const now = (await handlers['chat.open']({ chatId })).view.messages
      if (now.length <= 1) break
      await handlers['chat.deleteMessage']({ chatId, id: now.at(-1).id })
    }
  }
  return walked
}

/** A fresh, isolated copy of the profile with a host over it. */
async function isolate(source) {
  const dir = await mkdtemp(join(SCRATCH, 'run-'))
  await cp(source, join(dir, 'data', PROFILE), { recursive: true })
  return { dir, host: await buildHost(join(dir, 'data')) }
}

const percent = (part, whole) => whole === 0 ? '—' : `${(part / whole * 100).toFixed(1)}%`

/**
 * Adjacent-round ceilings for one walk.
 *
 * Two ceilings per pair: the whole wire body (what the provider caches on) and
 * the conversation alone (what this audit is responsible for). They differ
 * whenever the divergence is in the system prompt, which is the other half of
 * this investigation.
 */
function ceilings(walked) {
  const pairs = []
  for (let index = walked.length - 1; index >= 1; index -= 1) {
    const older = walked[index]
    const newer = walked[index - 1]
    const bodyOld = bodyText(older.options)
    const bodyNew = bodyText(newer.options)
    const convOld = conversationText(older.options)
    const convNew = conversationText(newer.options)
    pairs.push({
      from: older.messages,
      to: newer.messages,
      body: { before: bytes(bodyOld), after: bytes(bodyNew), prefix: commonPrefixBytes(bodyOld, bodyNew) },
      conversation: {
        before: bytes(convOld),
        after: bytes(convNew),
        prefix: commonPrefixBytes(convOld, convNew),
      },
      droppedOld: older.itemization.droppedHistory,
      droppedNew: newer.itemization.droppedHistory,
      firstFloorMoved: older.itemization.droppedHistory !== newer.itemization.droppedHistory,
    })
  }
  return pairs
}

function reportCeilings(title, pairs, walked) {
  console.log(`  ${title}`)
  if (walked !== undefined) {
    const newest = walked[0]
    console.log(`    newest round: ~${String(newest.itemization.tokens)} tok assembled`
      + `, budget ${JSON.stringify(newest.itemization.budget)}`
      + `, history row ~${String(newest.itemization.entries.find(row => row.kind === 'history')?.tokens ?? 0)} tok`
      + `, dropped ${String(newest.itemization.droppedHistory)}`
      + `, overBudget ${String(newest.itemization.overBudget)}`)
  }
  console.log('    from→to   body prefix / after        conversation prefix / after      dropped')
  for (const pair of pairs) {
    console.log(`    ${String(pair.from).padStart(3)}→${String(pair.to).padStart(3)}`
      + `   ${String(pair.body.prefix).padStart(6)} / ${String(pair.body.after).padStart(6)} B`
      + ` = ${percent(pair.body.prefix, pair.body.after).padStart(6)}`
      + `   ${String(pair.conversation.prefix).padStart(6)} / ${String(pair.conversation.after).padStart(6)} B`
      + ` = ${percent(pair.conversation.prefix, pair.conversation.after).padStart(6)}`
      + `   ${String(pair.droppedOld)}→${String(pair.droppedNew)}${pair.firstFloorMoved ? '  MOVED' : ''}`)
  }
  const mean = list => list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length
  console.log(`    mean body ceiling ${(mean(pairs.map(p => p.body.prefix / p.body.after)) * 100).toFixed(1)}%`
    + `; mean conversation ceiling ${(mean(pairs.map(p => p.conversation.prefix / p.conversation.after)) * 100).toFixed(1)}%`
    + `; rounds whose first sent floor moved: ${String(pairs.filter(p => p.firstFloorMoved).length)}/${String(pairs.length)}`)
}

/**
 * Which message of an older round stopped being byte-identical, and why.
 *
 * The adjacent-round ceiling says *where* two requests diverge; it does not say
 * whether the divergence is the tail growing (expected, unavoidable) or an
 * older floor being rendered differently on the newer turn (a defect, and the
 * one this audit owns). So the two message lists are aligned from the front and
 * every floor of the older request is looked for in the newer one:
 *
 * - `grew`  — the older request's messages are all still there, byte-identical,
 *   and the newer one only added to the end. This is the healthy shape.
 * - `rewritten` — a message at the same index carries different text, and the
 *   older text appears nowhere in the newer request. Something re-rendered a
 *   floor that had already been sent.
 * - `moved` — the older text is still present, at a different index. A depth
 *   injection sliding as the conversation grows does this.
 */
function floorDiff(older, newer) {
  const left = older.messages.map(message => message.content
    .filter(block => block.type === 'text').map(block => block.text).join(''))
  const right = newer.messages.map(message => message.content
    .filter(block => block.type === 'text').map(block => block.text).join(''))
  const rightSet = new Set(right)

  let head = 0
  while (head < Math.min(left.length, right.length) && left[head] === right[head]) head += 1
  if (head === left.length) return { kind: 'grew', head, left: left.length, right: right.length }

  const stale = left[head]
  const elsewhere = right.indexOf(stale)
  return {
    kind: rightSet.has(stale) ? 'moved' : 'rewritten',
    head,
    left: left.length,
    right: right.length,
    at: elsewhere,
    older: stale,
    newer: right[head] ?? '',
  }
}

/** The first character where two strings part company, with context on both sides. */
function firstCharDiff(older, newer) {
  let cut = 0
  while (cut < Math.min(older.length, newer.length) && older[cut] === newer[cut]) cut += 1
  return {
    cut,
    before: older.slice(Math.max(0, cut - 60), cut),
    olderAfter: older.slice(cut, cut + 60),
    newerAfter: newer.slice(cut, cut + 60),
  }
}

async function main() {
  const source = profilePaths(resolve(DATA), PROFILE).root
  if (!existsSync(source)) {
    console.error(`no profile at ${source}; set IRIS_PROBE_DATA`)
    process.exitCode = 1
    return
  }
  await mkdir(SCRATCH, { recursive: true })

  const scan = await isolate(source)
  const listed = (await scan.host.handlers['chat.list']()).chats
  await rm(scan.dir, { recursive: true, force: true })

  for (const wanted of WANTED) {
    const hit = listed.find(chat => chat.chatId.includes(wanted) || (chat.title ?? '').includes(wanted))
    if (hit === undefined) {
      console.log(`\n### ${wanted}: no such conversation`)
      continue
    }
    const chatId = hit.chatId
    console.log(`\n### ${wanted} -> ${chatId}`)

    // --- 1. squash off vs on -------------------------------------------------
    for (const squash of SECTIONS.has('squash') ? [false, true] : []) {
      const run = await isolate(source)
      try {
        await run.host.handlers['settings.set']({ chatId, settings: { squashSystemMessages: squash } })
        const walked = await walk(run.host, chatId, ROUNDS)
        if (walked.length < 2) { console.log(`  squash=${String(squash)}: not enough rounds`); continue }
        reportCeilings(`squashSystemMessages=${String(squash)}`, ceilings(walked), walked)
      } finally {
        await rm(run.dir, { recursive: true, force: true })
      }
    }

    // --- 2. two swipes of one reply -----------------------------------------
    if (SECTIONS.has('swipe')) {
      const run = await isolate(source)
      try {
        const view = (await run.host.handlers['chat.open']({ chatId })).view
        if (view.messages.at(-1)?.role === 'assistant') {
          await run.host.handlers['chat.deleteMessage']({ chatId, id: view.messages.at(-1).id })
        }
        // A swipe in Iris IS another generation for the same turn, so two
        // swipes are two assemblies of one unchanged state.
        const one = await run.host.assembleOnce(chatId)
        const two = await run.host.assembleOnce(chatId)
        const convOne = conversationText(one.options)
        const convTwo = conversationText(two.options)
        console.log('  two swipes of the same reply')
        console.log(`    conversation ${String(bytes(convOne))} vs ${String(bytes(convTwo))} B`
          + `; identical: ${convOne === convTwo ? 'yes' : 'NO'}`)
        console.log(`    whole body   ${String(bytes(bodyText(one.options)))} vs ${String(bytes(bodyText(two.options)))} B`
          + `; identical: ${bodyText(one.options) === bodyText(two.options) ? 'yes' : 'NO'}`)
        if (convOne !== convTwo) {
          const at = commonPrefixBytes(convOne, convTwo)
          console.log(`    conversation diverges at byte ${String(at)} of ${String(bytes(convTwo))}`)
        }
      } finally {
        await rm(run.dir, { recursive: true, force: true })
      }
    }

    // --- 2b. which floor stopped being byte-identical -----------------------
    if (SECTIONS.has('floors')) {
      const run = await isolate(source)
      try {
        const walked = await walk(run.host, chatId, ROUNDS)
        console.log('  floor-by-floor, older round -> newer round')
        for (let index = walked.length - 1; index >= 1; index -= 1) {
          const older = walked[index]
          const newer = walked[index - 1]
          const diff = floorDiff(older.options, newer.options)
          const head = `    ${String(older.messages).padStart(3)}->${String(newer.messages).padStart(3)}`
            + `  ${String(diff.left)}->${String(diff.right)} msgs`
            + `  shared head ${String(diff.head)}  ${diff.kind}`
          if (diff.kind === 'grew') { console.log(head); continue }
          console.log(`${head}${diff.kind === 'moved' ? ` (older text now at ${String(diff.at)})` : ''}`)
          const chars = firstCharDiff(diff.older, diff.newer)
          console.log(`      msg ${String(diff.head)} parts at char ${String(chars.cut)}`
            + ` of ${String(diff.older.length)}/${String(diff.newer.length)}`)
          console.log(`      before: ${JSON.stringify(chars.before)}`)
          console.log(`      older : ${JSON.stringify(chars.olderAfter)}`)
          console.log(`      newer : ${JSON.stringify(chars.newerAfter)}`)
        }
      } finally {
        await rm(run.dir, { recursive: true, force: true })
      }
    }

    // --- 3. the trim, at block 0 and at the default -------------------------
    if (!SECTIONS.has('trim')) continue
    // The window is narrowed until the trimmer engages: at 32 768 no real
    // conversation is trimmed at all, so upstream's per-entry trim has never
    // been exercised on this corpus and its cost has never been paid — or seen.
    const window = WINDOW ?? await (async () => {
      const run = await isolate(source)
      try {
        const walked = await walk(run.host, chatId, 0)
        const tokens = walked[0]?.itemization.tokens ?? 0
        // Just under what the newest round needs, so the oldest floors have to
        // go and the newest exchange still fits.
        return Math.max(2_048, Math.floor(tokens * 0.85))
      } finally {
        await rm(run.dir, { recursive: true, force: true })
      }
    })()
    console.log(`  trim experiment: contextWindow narrowed to ${String(window)} tokens`)
    for (const block of [0, undefined]) {
      const previous = process.env.IRIS_TRIM_BLOCK
      if (block === undefined) delete process.env.IRIS_TRIM_BLOCK
      else process.env.IRIS_TRIM_BLOCK = String(block)
      const run = await isolate(source)
      try {
        await run.host.handlers['settings.set']({ chatId, settings: { contextWindow: window } })
        const walked = await walk(run.host, chatId, ROUNDS)
        if (walked.length < 2) { console.log(`  block=${String(block)}: not enough rounds`); continue }
        reportCeilings(`trimBlockFloors=${block === undefined ? 'default' : String(block)}`, ceilings(walked), walked)
      } finally {
        await rm(run.dir, { recursive: true, force: true })
        if (previous === undefined) delete process.env.IRIS_TRIM_BLOCK
        else process.env.IRIS_TRIM_BLOCK = previous
      }
    }
  }
}

await main()
