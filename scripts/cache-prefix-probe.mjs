/**
 * Where a DeepSeek prefix cache stops matching, measured on real conversations.
 *
 * DeepSeek's context cache hits on the **request prefix** (64-token blocks;
 * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`). One changed byte
 * makes everything after it a miss, so a 15% hit rate is a statement about how
 * early two adjacent requests stop agreeing — not about how much text they
 * share.
 *
 * A script rather than a test, because it reads the operator's own profile
 * directory. Nothing is written there: the profile is **copied** into a scratch
 * directory first and the host runs against the copy, which is also what makes
 * the run repeatable while a live host keeps writing.
 *
 *   node scripts/cache-prefix-probe.mjs
 *   IRIS_PROBE_DATA=… IRIS_PROBE_CHATS='爱衣,…' node scripts/cache-prefix-probe.mjs
 *   IRIS_TEMPLATES=1 node scripts/cache-prefix-probe.mjs      # evaluate the cards' EJS
 *   IRIS_PROBE_MIN=6 node scripts/cache-prefix-probe.mjs      # also survey every chat
 *
 * ## What the bytes are
 *
 * The request is captured at the one seam that sees what is actually sent: the
 * `stream` function the service is constructed with, which `#stream` calls with
 * the assembled, template-evaluated `GenerateOptions`. `serializeRequest` from
 * `@iris/llm-openai-compat` then turns that into the object the adapter
 * `JSON.stringify`s onto the wire (`index.ts:282`). So the byte counts here are
 * the wire's own, not a re-derivation of it.
 *
 * No request leaves this process. The injected stream captures and then throws,
 * which is also what keeps the copy's log unchanged: a failed generation writes
 * no candidate, so the same state can be assembled twice — that is the control.
 *
 * ## The two states
 *
 * Round N+1 is the request that produced the newest reply: the log with that
 * reply removed, assembled by the real `#start` → `TurnDriver` → `assemble`
 * path. Round N is the same thing one exchange earlier. Removing the reply
 * matters — `historyFromSession` projects every derived message, so a
 * `chat.regenerate` on an intact log feeds the model the very reply it is
 * replacing, which is not the request that was originally sent.
 *
 * ## What the bytes are not
 *
 * `ChatEntry.extensionPrompts` — everything a card script injects at runtime
 * through `script.inject` — is an in-memory `Map` (`entry.ts:329`), never
 * persisted. A headless run has no browser, so no card script has injected
 * anything, and the probe therefore sees **none** of that traffic. Whatever it
 * reports about churn is a floor, not a ceiling.
 */

import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { serializeRequest } from '../packages/iris-llm-openai-compat/src/serialize.ts'
import { estimateTokens } from '../packages/iris-tokenizer/src/index.ts'

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
const WANTED = (process.env.IRIS_PROBE_CHATS
  ?? '爱衣,Sgw又看一集,灭仇家满门之后').split(',').map(part => part.trim()).filter(Boolean)
const SCRATCH = process.env.IRIS_PROBE_SCRATCH ?? join(tmpdir(), 'iris-cache-prefix')
/** Survey every conversation with at least this many messages; 0 means only the named ones. */
const MIN_MESSAGES = Number(process.env.IRIS_PROBE_MIN ?? 0)
/** How many exchanges to walk back, so the shape of the divergence has more than one sample. */
const ROUNDS = Number(process.env.IRIS_PROBE_ROUNDS ?? 8)
/** Literal strings to look for in the assembled request; absence is the answer, not silence. */
const NEEDLES = (process.env.IRIS_PROBE_NEEDLES ?? '').split(',').map(part => part.trim()).filter(Boolean)

/** Bytes of a string as UTF-8, which is what the wire counts. */
const bytes = text => Buffer.byteLength(text, 'utf8')

/** Length in bytes of the longest common prefix of two strings, UTF-8. */
function commonPrefixBytes(left, right) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  // Never split a surrogate pair: half a pair is not a prefix of either string.
  if (index > 0 && index < limit) {
    const code = left.charCodeAt(index - 1)
    if (code >= 0xd800 && code <= 0xdbff) index -= 1
  }
  return bytes(left.slice(0, index))
}

// --- the host, headless ----------------------------------------------------

/** The failure the capturing stream raises once it has the request. */
class Captured extends Error {}

/**
 * Stand up the application service over a profile directory, with a stream
 * that records the request and then refuses it.
 */
async function buildHost(dataDir) {
  const warn = message => {
    const text = message instanceof Error ? message.message : String(message)
    if (process.env.IRIS_PROBE_VERBOSE === '1') console.error(`  · ${text}`)
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
    const done = await materialiseEmbeddedBook(
      characterId, card, worldbooks, worldbookBindings, stInstall)
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
    // Refused, not answered: an appended candidate would change the log and the
    // next assembly of "the same state" would no longer be the same state.
    throw new Captured('cache-prefix probe: request captured, not sent')
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
    // The composition's own numbers (`apps/iris/cordis.yml`), so the budget the
    // probe assembles under is the budget the product assembles under.
    contextWindow: Number(process.env.IRIS_CONTEXT_WINDOW ?? 32_768),
    ...process.env.IRIS_TEMPLATES === '1' ? { templates: {} } : {},
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

  return { handlers, assembleOnce, library, worldbooks, settings }
}

// --- segmentation ----------------------------------------------------------

/**
 * Cut one captured request into labelled segments whose texts, concatenated in
 * order, reproduce the request exactly.
 *
 * The system prompt is `renderSystem`'s `\n\n`-joined blocks, so splitting on
 * the same separator can only ever be *finer* than the contribution boundaries
 * — never coarser, and never wrong about where a byte lands.
 */
function segmentsOf(options) {
  const segments = []
  const system = options.system ?? ''
  if (system.length > 0) {
    const blocks = system.split('\n\n')
    blocks.forEach((block, index) => {
      segments.push({
        where: `system[${String(index)}]`,
        role: 'system',
        text: index === blocks.length - 1 ? block : `${block}\n\n`,
      })
    })
  }
  options.messages.forEach((message, index) => {
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    segments.push({ where: `msg[${String(index)}]`, role: message.role, text })
  })
  return segments
}

/** The concatenated text of a request — system first, then every message. */
function textOf(options) {
  return segmentsOf(options).map(segment => segment.text).join('')
}

/**
 * Name what a segment is, by looking for it in a catalog of known sources.
 *
 * Macros are already expanded in a captured request, so an exact match is the
 * exception: the test is the longest literal run of the candidate (a stretch
 * with no `{{…}}` and no `<%…%>`) appearing in the segment. Catalog order is
 * the tie-break, so the most specific sources are listed first.
 *
 * **A label is a hint, not a finding.** Several cards in the corpus ship the
 * same copied MVU boilerplate, so a world-info block genuinely belonging to one
 * card can be named after another card's book — the literal run matches there
 * first. The authoritative name of a contribution is the itemization row the
 * host itself produced (`worldInfo.depth.0.0`, `charDescription`, …), printed
 * beside these labels for that reason.
 */
function labeller(catalog) {
  const prepared = catalog.map(item => {
    const runs = String(item.text ?? '')
      .split(/\{\{[^}]*\}\}|<%[\s\S]*?%>/u)
      .map(run => run.trim())
      .filter(run => run.length >= 24)
      .sort((left, right) => right.length - left.length)
    return { ...item, probe: runs[0] }
  }).filter(item => item.probe !== undefined)

  return text => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return 'empty'
    for (const item of prepared) {
      if (text.includes(item.probe)) return item.name
    }
    return 'unmatched'
  }
}

// --- comparing two requests ------------------------------------------------

/** How many UTF-16 units of `text` make up its first `count` UTF-8 bytes. */
function sliceForBytes(text, count) {
  let total = 0
  for (let index = 0; index < text.length; index += 1) {
    total += bytes(text[index])
    if (total > count) return index
  }
  return text.length
}

/** Whether two segments are the same piece of request. */
const sameSegment = (left, right) =>
  left !== undefined && right !== undefined && left.role === right.role && left.text === right.text

/**
 * Compare two captured requests: the wire bytes, and then the segments.
 *
 * Segments are aligned from both ends rather than by index. History grows at
 * the tail and depth injections slide forward as it does, so an index-aligned
 * diff past the growth point reports every later message as changed when the
 * text is the same message one slot along.
 */
function compare(before, after, label) {
  const bodyBefore = JSON.stringify(serializeRequest(before))
  const bodyAfter = JSON.stringify(serializeRequest(after))
  const textBefore = textOf(before)
  const textAfter = textOf(after)
  const prefixBytes = commonPrefixBytes(bodyBefore, bodyAfter)
  const prefixTextBytes = commonPrefixBytes(textBefore, textAfter)

  const left = segmentsOf(before)
  const right = segmentsOf(after)

  let head = 0
  while (sameSegment(left[head], right[head])) head += 1
  let tail = 0
  while (tail < Math.min(left.length, right.length) - head
    && sameSegment(left[left.length - 1 - tail], right[right.length - 1 - tail])) tail += 1

  const middleBefore = left.slice(head, left.length - tail)
  const middleAfter = right.slice(head, right.length - tail)
  const offsetOfHead = left.slice(0, head).reduce((total, segment) => total + bytes(segment.text), 0)

  // What kind of change each segment is. `moved` is the one that matters for a
  // prefix cache: the text is byte-identical and sits at a different index, so
  // it is re-sent in full and charged in full, every turn, for nothing.
  const textsBefore = new Set(left.map(segment => segment.text))
  const textsAfter = new Set(right.map(segment => segment.text))
  const kindOf = (segment, side) => {
    const elsewhere = side === 'before' ? textsAfter.has(segment.text) : textsBefore.has(segment.text)
    if (elsewhere) return 'moved'
    return side === 'before' ? 'gone' : 'new'
  }

  const row = (segment, side) => ({
    side,
    kind: kindOf(segment, side),
    where: segment.where,
    role: segment.role,
    bytes: bytes(segment.text),
    label: label(segment.text),
  })

  return {
    bodyBytes: { before: bytes(bodyBefore), after: bytes(bodyAfter), prefix: prefixBytes },
    textBytes: { before: bytes(textBefore), after: bytes(textAfter), prefix: prefixTextBytes },
    tokens: {
      before: estimateTokens(textBefore),
      after: estimateTokens(textAfter),
      prefix: estimateTokens(textBefore.slice(0, sliceForBytes(textBefore, prefixTextBytes))),
    },
    identicalBody: bodyBefore === bodyAfter,
    segments: { before: left.length, after: right.length, sharedHead: head, sharedTail: tail },
    /** Byte offset, in the text stream, where the shared head stops. */
    divergeAt: offsetOfHead,
    firstDiff: middleBefore.length + middleAfter.length === 0
      ? null
      : row(middleBefore[0] ?? middleAfter[0], middleBefore.length > 0 ? 'before' : 'after'),
    changed: [
      ...middleBefore.map(segment => row(segment, 'before')),
      ...middleAfter.map(segment => row(segment, 'after')),
    ],
    changedBytes: {
      before: middleBefore.reduce((total, segment) => total + bytes(segment.text), 0),
      after: middleAfter.reduce((total, segment) => total + bytes(segment.text), 0),
    },
    /**
     * Everything the cache cannot serve, split by whether it is new text or
     * text the newer request repeats verbatim behind the divergence point.
     *
     * The second number is the interesting one: it is charged in full every
     * turn and buys nothing, and it exists only because content is anchored to
     * the END of the conversation, so growth pushes it past the prefix.
     */
    lossAfterPrefix: {
      newText: middleAfter.reduce((total, segment) => total + bytes(segment.text), 0),
      repeatedVerbatim: right.slice(right.length - tail)
        .reduce((total, segment) => total + bytes(segment.text), 0),
    },
  }
}

// --- one conversation ------------------------------------------------------

/** Build the label catalog for one conversation. */
async function catalogFor(host, handlers, view) {
  const catalog = []
  if (view.characterId !== undefined) {
    try {
      const card = await host.library.load(view.characterId)
      const data = card.data ?? card
      for (const field of [
        'system_prompt', 'post_history_instructions',
        'description', 'personality', 'scenario', 'mes_example', 'first_mes',
      ]) {
        if (typeof data[field] === 'string') catalog.push({ name: `card.${field}`, text: data[field] })
      }
    } catch { /* a card the library cannot read labels nothing */ }
  }
  for (const persona of (await handlers['persona.list']()).personas ?? []) {
    catalog.push({ name: `persona "${persona.name}"`, text: persona.description ?? '' })
  }
  const manager = (await handlers['preset.view']()).manager
  for (const prompt of manager.prompts ?? []) {
    catalog.push({ name: `preset "${prompt.name ?? prompt.identifier ?? prompt.id}"`, text: prompt.content ?? '' })
  }
  view.messages.forEach(message => {
    catalog.push({ name: `history(id=${String(message.id)},${message.role})`, text: message.text })
  })
  for (const name of await host.worldbooks.names()) {
    try {
      for (const entry of await host.worldbooks.get(name)) {
        const tag = entry.comment !== undefined && entry.comment !== ''
          ? entry.comment
          : `#${String(entry.uid ?? '?')}`
        catalog.push({ name: `world "${name}" ${tag}`, text: entry.content ?? '' })
      }
    } catch { /* skip an unreadable book */ }
  }
  return catalog
}

/**
 * Compare the last two assemblies of one conversation.
 *
 * The trailing reply is deleted first, so the state assembled is the state the
 * reply was generated from rather than the state after it landed.
 */
async function probeChat(host, chatId, wanted) {
  const { handlers, assembleOnce } = host
  const view = (await handlers['chat.open']({ chatId })).view
  const label = labeller(await catalogFor(host, handlers, view))

  const usage = {
    conversation: view.usage ?? null,
    perTurn: view.messages
      .filter(message => message.usage !== undefined)
      .map(message => ({ id: message.id, ...message.usage })),
  }

  // Peel the trailing reply, so the newest state is the one that produced it.
  const trailing = []
  let messages = view.messages
  if (messages.at(-1)?.role === 'assistant') {
    await handlers['chat.deleteMessage']({ chatId, id: messages.at(-1).id })
    trailing.push('assistant')
    messages = (await handlers['chat.open']({ chatId })).view.messages
  }
  if (messages.length < 3) {
    return { chatId, wanted, usage, skipped: `${String(messages.length)} messages after peeling the reply` }
  }

  // Walk backwards, capturing every round: state as it is, then one exchange
  // earlier, and so on. `ROUNDS` pairs are enough to see whether the shape of
  // the divergence is stable or the last pair happened to be tidy.
  const rounds = []
  for (let step = 0; step <= ROUNDS; step += 1) {
    const current = (await handlers['chat.open']({ chatId })).view.messages
    if (current.length < 2) break
    rounds.push({ messages: current.length, ...await assembleOnce(chatId) })
    if (step === 0) rounds[0].again = (await assembleOnce(chatId)).options
    // Drop the user line just assembled for and the reply before it.
    for (let peel = 0; peel < 2; peel += 1) {
      const now = (await handlers['chat.open']({ chatId })).view.messages
      if (now.length <= 1) break
      await handlers['chat.deleteMessage']({ chatId, id: now.at(-1).id })
    }
  }
  if (rounds.length < 2) {
    return { chatId, wanted, usage, skipped: `only ${String(rounds.length)} assemblable round(s)` }
  }

  const newest = rounds[0]
  const serialA = JSON.stringify(serializeRequest(newest.options))
  const serialB = JSON.stringify(serializeRequest(newest.options))

  return {
    chatId,
    wanted,
    usage,
    peeled: trailing,
    messageCount: view.messages.length,
    depthEntries: newest.itemization.entries
      .filter(entry => entry.kind === 'depth')
      .map(entry => ({ id: entry.id, label: entry.label, depth: entry.depth, role: entry.role, tokens: entry.tokens })),
    // Zero rows kept: "worldInfoBefore, 0 tokens" is the answer to "why is my
    // lore missing", and an absent row is not.
    systemEntries: newest.itemization.entries
      .filter(entry => entry.kind === 'system')
      .map(entry => ({ id: entry.id, label: entry.label, tokens: entry.tokens })),
    historyEntry: newest.itemization.entries.find(entry => entry.kind === 'history') ?? null,
    // Literal strings the caller wants located in the assembled request, so
    // "this contribution has 0 tokens" can be told apart from "this
    // contribution never activated". `IRIS_PROBE_NEEDLES` is a comma list.
    ...NEEDLES.length === 0 ? {} : {
      needles: NEEDLES.map(needle => ({ needle, present: textOf(newest.options).includes(needle) })),
    },
    itemization: {
      tokens: newest.itemization.tokens,
      droppedHistory: newest.itemization.droppedHistory,
      overBudget: newest.itemization.overBudget,
      budget: newest.itemization.budget,
    },
    controls: {
      /** The same options serialized twice: pure serializer determinism. */
      serializeStable: serialA === serialB,
      /** The same chat state assembled twice: assembly determinism. */
      assembly: compare(newest.options, newest.again, label),
    },
    // Oldest pair first, so the table reads in conversation order.
    pairs: rounds.slice(0, -1).map((_unused, index) => {
      const older = rounds[rounds.length - 1 - index]
      const newer = rounds[rounds.length - 2 - index]
      return {
        from: older.messages,
        to: newer.messages,
        ...compare(older.options, newer.options, label),
      }
    }),
  }
}

// --- main ------------------------------------------------------------------

function percent(part, whole) {
  return whole === 0 ? '—' : `${(part / whole * 100).toFixed(1)}%`
}

function report(result) {
  console.log(`\n### ${result.wanted} -> ${result.chatId}`)
  if (result.usage.conversation !== null) {
    const u = result.usage.conversation
    const billed = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0)
    console.log(`  recorded usage: input ${String(u.inputTokens ?? 0)}, cacheRead ${String(u.cacheReadTokens ?? 0)}`
      + `  -> the UI's cache-hit line = ${percent(u.cacheReadTokens ?? 0, billed)}`)
  }
  for (const turn of result.usage.perTurn) {
    const billed = (turn.inputTokens ?? 0) + (turn.cacheReadTokens ?? 0)
    console.log(`    msg ${String(turn.id)}: billed ${String(billed)}, hit ${String(turn.cacheReadTokens ?? 0)}`
      + ` (${percent(turn.cacheReadTokens ?? 0, billed)})`)
  }
  if (result.skipped !== undefined) {
    console.log(`  skipped: ${result.skipped}`)
    return
  }
  console.log(`  messages ${String(result.messageCount)}; assembled tokens ~${String(result.itemization.tokens)}`
    + `; history dropped by budget: ${String(result.itemization.droppedHistory)}`
    + `; budget ${JSON.stringify(result.itemization.budget)}`)
  console.log(`  depth-placed contributions: ${result.depthEntries.length === 0 ? 'none' : ''}`)
  for (const entry of result.depthEntries) {
    console.log(`    depth ${String(entry.depth)} ${String(entry.role)} ~${String(entry.tokens)} tok  ${entry.id}  ${entry.label ?? ''}`)
  }
  console.log(`  system sections: ${String(result.systemEntries.length)}`
    + `, ~${String(result.systemEntries.reduce((total, entry) => total + entry.tokens, 0))} tok`
    + `; history ~${String(result.historyEntry?.tokens ?? 0)} tok`)
  for (const entry of result.systemEntries) {
    console.log(`    ~${String(entry.tokens).padStart(6)} tok  ${entry.id}  ${entry.label ?? ''}`)
  }
  if (result.needles !== undefined) {
    console.log(`  needles: ${result.needles.map(row => `${row.needle}=${row.present ? 'in' : 'MISSING'}`).join(' ')}`)
  }
  console.log(`  serializer determinism: ${result.controls.serializeStable ? 'identical' : 'DIFFERS'}`)
  const named = [['control: same state, assembled twice', result.controls.assembly]]
  result.pairs.forEach((pair, index) => {
    named.push([`round ${String(index + 1)}/${String(result.pairs.length)}:`
      + ` ${String(pair.from)} -> ${String(pair.to)} messages`, pair])
  })
  for (const [name, run] of named) {
    console.log(`  ${name}`)
    console.log(`    body     ${String(run.bodyBytes.before)} -> ${String(run.bodyBytes.after)} B`
      + `; common prefix ${String(run.bodyBytes.prefix)} B = ${percent(run.bodyBytes.prefix, run.bodyBytes.after)} ceiling`)
    console.log(`    text     ${String(run.textBytes.before)} -> ${String(run.textBytes.after)} B`
      + `; prefix ${String(run.textBytes.prefix)} B; tokens ~${String(run.tokens.prefix)} / ~${String(run.tokens.after)}`)
    console.log(`    segments ${String(run.segments.before)} -> ${String(run.segments.after)}`
      + `; shared head ${String(run.segments.sharedHead)}, shared tail ${String(run.segments.sharedTail)}`
      + `; diverge at text byte ${String(run.divergeAt)}`)
    if (run.firstDiff === null) { console.log('    identical'); continue }
    console.log(`    first diff (${run.firstDiff.side}) ${run.firstDiff.where} ${run.firstDiff.role}`
      + ` ${String(run.firstDiff.bytes)} B [${run.firstDiff.kind}] = ${run.firstDiff.label}`)
    const loss = run.bodyBytes.after - run.bodyBytes.prefix
    console.log(`    unhittable ${String(loss)} B = new text ${String(run.lossAfterPrefix.newText)} B`
      + ` + repeated verbatim behind the prefix ${String(run.lossAfterPrefix.repeatedVerbatim)} B`
      + ` (${percent(run.lossAfterPrefix.repeatedVerbatim, loss)} of the loss)`)
    for (const change of run.changed.slice(0, 16)) {
      console.log(`      · ${change.side} ${change.where} ${change.role} ${String(change.bytes)} B`
        + ` [${change.kind}]  ${change.label}`)
    }
    if (run.changed.length > 16) console.log(`      · … ${String(run.changed.length - 16)} more`)
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
  const scratch = await mkdtemp(join(SCRATCH, 'run-'))
  const dataDir = join(scratch, 'data')
  console.log(`profile   ${source}`)
  console.log(`copy      ${join(dataDir, PROFILE)}`)
  await cp(source, join(dataDir, PROFILE), { recursive: true })

  try {
    const host = await buildHost(dataDir)
    const listed = (await host.handlers['chat.list']()).chats
    console.log(`templates ${process.env.IRIS_TEMPLATES === '1' ? 'on' : 'off'}`)
    console.log(`\n${String(listed.length)} conversations in the copy:`)
    const sizes = []
    const jitters = []
    for (const chat of listed) {
      const view = (await host.handlers['chat.open']({ chatId: chat.chatId })).view
      // The preview path, which writes nothing: how the NEXT request assembles.
      let itemization
      try {
        itemization = (await host.handlers['prompt.itemize']({ chatId: chat.chatId })).itemization
      } catch { /* a chat with nothing to assemble reports nothing */ }
      // Two assemblies of one unchanged state — the determinism control, run on
      // every card rather than only the one with a long conversation, because
      // `{{time}}` / `{{roll}}` / a sticky world-info window would show up here
      // and nowhere else.
      let stable = 'n/a'
      try {
        const one = await host.assembleOnce(chat.chatId)
        const two = await host.assembleOnce(chat.chatId)
        stable = JSON.stringify(serializeRequest(one.options)) === JSON.stringify(serializeRequest(two.options))
          ? 'stable'
          : 'JITTERS'
        if (stable === 'JITTERS') {
          const run = compare(one.options, two.options, () => '?')
          jitters.push({ chatId: chat.chatId, run, one, two })
        }
      } catch (error) {
        stable = `n/a (${error instanceof Error ? error.message.slice(0, 40) : '?'})`
      }
      sizes.push({ chatId: chat.chatId, messages: view.messages.length, stable })
      console.log(`  ${String(view.messages.length).padStart(3)} msg`
        + `  ~${String(itemization?.tokens ?? 0).padStart(6)} tok`
        + `  dropped ${String(itemization?.droppedHistory ?? 0).padStart(3)}`
        + `  over=${String(itemization?.overBudget ?? false).padEnd(5)}`
        + `  ${stable.padEnd(10)}  ${chat.chatId}`)
    }

    if (jitters.length > 0) {
      console.log(`\n${String(jitters.length)} conversation(s) assemble differently from the SAME state:`)
      for (const jitter of jitters) {
        console.log(`  ${jitter.chatId}`)
        console.log(`    body ${String(jitter.run.bodyBytes.before)} vs ${String(jitter.run.bodyBytes.after)} B`
          + `; common prefix ${String(jitter.run.bodyBytes.prefix)} B`
          + `; diverge at text byte ${String(jitter.run.divergeAt)}`)
        for (const change of jitter.run.changed.slice(0, 6)) {
          console.log(`    · ${change.side} ${change.where} ${change.role} ${String(change.bytes)} B [${change.kind}]`)
        }
        // The differing text itself, trimmed hard: the point is which macro or
        // which value moved, not the card's prose.
        const left = segmentsOf(jitter.one.options)
        const right = segmentsOf(jitter.two.options)
        const at = jitter.run.segments.sharedHead
        const a = left[at]?.text ?? ''
        const b = right[at]?.text ?? ''
        let cut = 0
        while (cut < Math.min(a.length, b.length) && a[cut] === b[cut]) cut += 1
        console.log(`    at segment ${String(at)}, char ${String(cut)}:`)
        console.log(`      A …${JSON.stringify(a.slice(Math.max(0, cut - 40), cut + 40))}`)
        console.log(`      B …${JSON.stringify(b.slice(Math.max(0, cut - 40), cut + 40))}`)
      }
    }

    const targets = []
    for (const wanted of WANTED) {
      const hit = listed.find(chat => chat.chatId.includes(wanted) || (chat.title ?? '').includes(wanted))
      if (hit === undefined) console.log(`\n### ${wanted}: no such conversation`)
      else targets.push({ chatId: hit.chatId, wanted })
    }
    if (MIN_MESSAGES > 0) {
      for (const row of sizes) {
        if (row.messages < MIN_MESSAGES) continue
        if (targets.some(target => target.chatId === row.chatId)) continue
        targets.push({ chatId: row.chatId, wanted: `(survey) ${row.chatId}` })
      }
    }

    const results = []
    for (const target of targets) {
      // A fresh copy per conversation: the peeling is destructive, and a chat
      // probed after another must not inherit the other's deleted messages.
      const perChat = await mkdtemp(join(SCRATCH, 'chat-'))
      await cp(source, join(perChat, 'data', PROFILE), { recursive: true })
      const isolated = await buildHost(join(perChat, 'data'))
      try {
        const result = await probeChat(isolated, target.chatId, target.wanted)
        results.push(result)
        report(result)
      } catch (error) {
        console.log(`\n### ${target.wanted}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        await rm(perChat, { recursive: true, force: true })
      }
    }
    if (process.env.IRIS_PROBE_JSON === '1') console.log(`\n${JSON.stringify(results, null, 2)}`)
  } finally {
    if (process.env.IRIS_PROBE_KEEP === '1') console.log(`\nkept ${scratch}`)
    else await rm(scratch, { recursive: true, force: true })
  }
}

await main()
