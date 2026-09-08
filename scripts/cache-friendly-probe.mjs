/**
 * What the cache-friendly order buys, measured on real conversations.
 *
 * A companion to `cache-prefix-probe.mjs`, which measured the ceiling as it
 * stood. This one measures the same conversations **twice** — with the reorder
 * off and with it on — so the difference is a controlled reading rather than a
 * before-and-after taken against a moving corpus.
 *
 * ## What these numbers are not
 *
 * **Ceilings, not acceptance.** The acceptance protocol (the cache-target note
 * in `notes/packages/iris-app-service/`, §2) rules that 达标 is the
 * *provider's* own `prompt_cache_hit_tokens / prompt_tokens` over ten
 * consecutive included turns, per turn and in aggregate, excluding each
 * session's first two generations — because a ceiling and a report have been
 * measured 73 points apart on the same turn, and a gate reading ceilings alone
 * would pass while the hit rate never moved. This script sends nothing, so it
 * can only ever say "the target is unreachable" (ceiling below 95%) or "the
 * assembly is not what is stopping you". Both are diagnoses.
 *
 *   node scripts/cache-friendly-probe.mjs
 *   IRIS_PROBE_CHATS='爱衣,OVERLORD' node scripts/cache-friendly-probe.mjs
 *   IRIS_PROBE_MVU=1 node scripts/cache-friendly-probe.mjs   # also the injected head
 *   IRIS_PROBE_ROUNDS=8 node scripts/cache-friendly-probe.mjs
 *
 * The profile is **copied** to a scratch directory and the host runs against the
 * copy; nothing is written to the operator's own data, and no request leaves the
 * process (the injected `stream` captures the assembled `GenerateOptions` and
 * then throws, so no candidate is ever appended and "the same state" stays the
 * same state).
 *
 * ## The three passes, and why there are three
 *
 * The classifier learns. Its first sighting of a contribution has only the
 * static prediction to go on; from the second it compares content hashes. So a
 * single walk would report a mixture of "cold" and "warm" readings and call it
 * one number.
 *
 * - **off** — `cacheFriendly: false`. The control, and it must reproduce
 *   `CACHE-PREFIX.md`'s figures, because with the flag off the assembly is
 *   byte-for-byte what it always was.
 * - **on, cold** — the reorder on, the chat's classifier memory empty. What a
 *   brand-new conversation gets on its first turns.
 * - **on, primed** — the reorder on, seeded with **the record the cold pass
 *   itself learned**, its generation counter rewound so nothing has lapsed.
 *   This is the steady state: what a conversation looks like once it has run a
 *   few turns. The seed is the product's own record written through the
 *   product's own writer — only the clock is moved — so the primed pass is not
 *   a hand-built hypothesis about what the classifier would decide.
 *
 * The reorder runs in **both** directions, so each pass reports both: `moved
 * back` are the volatile parts sent after the conversation, `moved forward` the
 * depth-anchored parts observed unchanged and pulled into the prefix. The
 * second is the larger lever — depth content is re-sent in full every turn even
 * when it never changes — and it is the one that needs the priming, because it
 * only fires once the classifier has watched a part hold still.
 *
 * ## The injected head
 *
 * `IRIS_PROBE_MVU=1` adds a fourth and fifth pass that model what a headless
 * probe cannot see: a card script calling `setExtensionPrompt` every turn with a
 * value that differs every turn. `ChatEntry.extensionPrompts` is in-memory and
 * never persisted, so the corpus carries no trace of it. Shape taken from
 * `.reference/MagVarUpdate` (`invoke_extra_model.ts:513`, an `in_chat`
 * depth-0/1/2 trio) and from the relative positions the host's own
 * `placementFor` implements: `position: 'before'` lands at `main.order - 1`,
 * i.e. ahead of the whole preset, which is the worst place a per-turn value can
 * sit.
 *
 * **This is a controlled stand-in, not an observation.** The cause census
 * searched MagVarUpdate's source tree *and* the deployed bundles for
 * `setExtensionPrompt` / `injectPrompts` and found **zero hits**, so
 * `CACHE-PREFIX.md` §2.1's suspicion about MVU specifically is refuted — MVU's
 * `injects` reach only its own side request, and Tavern Helper's `injects` API
 * admits only `in_chat` and `none`, so it cannot produce a `'before'`
 * placement at all. What these two passes measure is the *shape*: what happens
 * to a request when something at the head changes every turn, whoever put it
 * there.
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
import { writeVolatility } from '../packages/iris-app-service/src/entry.ts'

const DATA = process.env.IRIS_PROBE_DATA
  ?? 'D:/workspace/小项目/iris_cordis_traven/apps/iris/data'
const PROFILE = process.env.IRIS_PROFILE ?? DEFAULT_PROFILE
const WANTED = (process.env.IRIS_PROBE_CHATS
  ?? '爱衣,OVERLORD不死者之王,Sgw又看一集').split(',').map(part => part.trim()).filter(Boolean)
const SCRATCH = process.env.IRIS_PROBE_SCRATCH ?? join(tmpdir(), 'iris-cache-friendly')
/** How many exchanges to walk back, so one tidy pair cannot stand for the shape. */
const ROUNDS = Number(process.env.IRIS_PROBE_ROUNDS ?? 8)
/** Also run the two passes that simulate a per-turn `setExtensionPrompt`. */
const MVU = process.env.IRIS_PROBE_MVU === '1'
/** Match every conversation whose id or title contains a wanted string, not just the first. */
const ALL_MATCHES = process.env.IRIS_PROBE_ALL !== '0'

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
 * Stand up the application service over a profile directory.
 *
 * @param dataDir - the copied data root.
 * @param options - `cacheFriendly` writes the global setting; `seed` writes one
 *   chat's classifier memory before anything assembles.
 * @returns handlers plus the two probes the walk needs.
 */
async function buildHost(dataDir, options = {}) {
  const warn = (message) => {
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
  const stream = async function* (generateOptions) {
    captured.push(generateOptions)
    throw new Captured('cache-friendly probe: request captured, not sent')
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
    onError: warn,
  })

  const handlers = service.handlers()

  // The setting, written through the product's own patch path, on the global
  // layer so every chat in this host assembles the same way.
  if (options.cacheFriendly !== undefined) {
    await handlers['settings.set']({ settings: { cacheFriendly: options.cacheFriendly } })
  }

  /**
   * Seed one chat's classifier memory.
   *
   * The record goes in through `writeVolatility` — the same writer the service
   * uses — and is read back by `ChatEntry`'s own reader when the entry is next
   * constructed. Only the *clock* is the probe's: `generation: 0` puts every
   * mark inside its hold window again, which is what "steady state" means here.
   */
  const seedVolatility = async (chatId, options = {}) => {
    const entry = await chats.open(chatId)
    const until = {}
    for (const id of options.volatile ?? []) until[id] = Number.MAX_SAFE_INTEGER
    // `since` in the far past is how "already observed holding still" is
    // expressed in the product's own vocabulary — the classifier reads
    // `generation - since[id]`, so a large gap settles the id on sight. Nothing
    // about the shape is the probe's invention; only the clock is.
    const since = {}
    for (const id of options.settled ?? []) since[id] = -1_000_000
    const record = { generation: 0, seen: {}, until, since }
    writeVolatility(entry.header.chat_metadata, record)
    entry.volatility = record
  }

  /** The classifier memory one chat has learned so far. */
  const learntVolatility = async (chatId) => {
    const entry = await chats.open(chatId)
    return entry.volatility
  }

  /** Assemble one request for the newest turn and hand back what would be sent. */
  const assembleOnce = async (chatId) => {
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

  return { handlers, assembleOnce, seedVolatility, learntVolatility, library, worldbooks, settings }
}

// --- segmentation ----------------------------------------------------------

/**
 * Cut one captured request into labelled segments whose texts, concatenated in
 * order, reproduce the request exactly.
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
 * **A label is a hint, not a finding** — several corpus cards ship the same
 * copied MVU boilerplate, so a block can be named after another card's book.
 * The authoritative name is the itemization row the host produced.
 */
function labeller(catalog) {
  const prepared = catalog.map((item) => {
    const runs = String(item.text ?? '')
      .split(/\{\{[^}]*\}\}|<%[\s\S]*?%>/u)
      .map(run => run.trim())
      .filter(run => run.length >= 24)
      .sort((left, right) => right.length - left.length)
    return { ...item, probe: runs[0] }
  }).filter(item => item.probe !== undefined)

  return (text) => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return 'empty'
    for (const item of prepared) {
      if (text.includes(item.probe)) return item.name
    }
    return 'unmatched'
  }
}

// --- comparing two requests ------------------------------------------------

/**
 * Every id the reorder moved in one direction, rows and members alike.
 *
 * **Members have to be counted, or the reading is wrong in the direction that
 * matters.** A world-info depth bucket the split decomposed carries the mark on
 * its `members`, not on the row: the row keeps it only when every entry in the
 * bucket went the same way. A collector that read rows alone would report
 * "moved forward: nothing" for the exact case this measurement exists to show —
 * two entries of a bucket in the prefix and a third still at depth 0.
 * @param itemization - one assembly's breakdown.
 * @param mark - `deferred` or `promoted`.
 * @returns the ids carrying that mark, rows named plainly and members by their
 *   own id.
 */
function movedIds(itemization, mark) {
  const ids = []
  for (const entry of itemization.entries) {
    if (entry[mark] === true) ids.push(entry.id)
    for (const member of entry.members ?? []) {
      if (member[mark] === true) ids.push(member.id)
    }
  }
  return ids
}

/** Whether two segments are the same piece of request. */
const sameSegment = (left, right) =>
  left !== undefined && right !== undefined && left.role === right.role && left.text === right.text

/**
 * Compare two captured requests: the wire bytes, then the segments.
 *
 * Segments are aligned from both ends rather than by index, because history
 * grows at the tail and everything anchored there slides forward with it.
 */
function compare(before, after, label) {
  const bodyBefore = JSON.stringify(serializeRequest(before))
  const bodyAfter = JSON.stringify(serializeRequest(after))
  const prefixBytes = commonPrefixBytes(bodyBefore, bodyAfter)

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

  const row = (segment, side) => ({
    side,
    where: segment.where,
    role: segment.role,
    bytes: bytes(segment.text),
    label: label(segment.text),
  })

  return {
    bodyBytes: { before: bytes(bodyBefore), after: bytes(bodyAfter), prefix: prefixBytes },
    identicalBody: bodyBefore === bodyAfter,
    divergeAt: offsetOfHead,
    firstDiff: middleBefore.length + middleAfter.length === 0
      ? null
      : row(middleBefore[0] ?? middleAfter[0], middleBefore.length > 0 ? 'before' : 'after'),
    /** New text after the divergence point, and text repeated verbatim behind it. */
    lossAfterPrefix: {
      newText: middleAfter.reduce((total, segment) => total + bytes(segment.text), 0),
      repeatedVerbatim: right.slice(right.length - tail)
        .reduce((total, segment) => total + bytes(segment.text), 0),
    },
  }
}

// --- one walk --------------------------------------------------------------

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
  const manager = (await handlers['preset.view']()).manager
  for (const prompt of manager.prompts ?? []) {
    catalog.push({ name: `preset "${prompt.name ?? prompt.id}"`, text: prompt.content ?? '' })
  }
  view.messages.forEach((message) => {
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

/** The key a simulated card-script injection is registered under. */
const MVU_KEY = 'probe_mvu_status'
const MVU_RUN = 'probe-run'

/**
 * Register the simulated per-turn injection, with a value that differs each call.
 *
 * `'before'` is upstream's `BEFORE_PROMPT`, which `placementFor` puts at
 * `main.order - 1` — ahead of the entire preset, which is the worst place a
 * per-turn value can sit and therefore the case worth measuring.
 * @param handlers - the host's handlers.
 * @param chatId - the conversation.
 * @param turn - a counter, so no two calls inject the same string.
 */
async function registerInjection(handlers, chatId, turn) {
  await handlers['script.setExtensionPrompt']({
    chatId,
    key: MVU_KEY,
    value: `<status>turn=${String(turn)} hp=${String(60 + turn % 7)} `
      + `time=${String(turn * 37 % 24)}:00 mood=${String(turn % 5)}</status>`,
    position: 'before',
    depth: 0,
    role: 'system',
    runId: MVU_RUN,
  })
}

/**
 * Walk one conversation backwards, capturing every round.
 *
 * The trailing reply is peeled first so the newest state assembled is the state
 * that produced it, not the state after it landed.
 * @param host - the built host.
 * @param chatId - the conversation.
 * @param options - `mvu` re-registers a per-turn injection before each capture.
 * @returns the rounds, newest first, and the label function.
 */
async function walk(host, chatId, options = {}) {
  const { handlers, assembleOnce } = host
  const view = (await handlers['chat.open']({ chatId })).view
  const label = labeller(await catalogFor(host, handlers, view))

  // **The same state, assembled twice.** This is the reading that matters for
  // most of the corpus: `CACHE-PREFIX.md` §1.3's 21.9% for the three OVERLORD
  // conversations and 97.7% for Sgw are *this* control, not adjacent turns —
  // those chats have 1 and 3 messages, so they have no adjacent turns at all.
  // A ceiling below 100% here means the request cannot even repeat itself: a
  // `{{roll}}` or `{{random}}` fires somewhere, and everything behind it is a
  // miss on every single turn forever. It is also the only control that reaches
  // a one-message conversation, so it runs before the peeling.
  let control = null
  try {
    if (options.mvu === true) await registerInjection(handlers, chatId, 1)
    const first = await assembleOnce(chatId)
    if (options.mvu === true) await registerInjection(handlers, chatId, 2)
    const second = await assembleOnce(chatId)
    control = {
      ...compare(first.options, second.options, label),
      // The host's own account of both assemblies, so a control below 100% can
      // be read as "which part" rather than only "how much": a row that is
      // `deferred` in one and not the other is the layout flipping, which is a
      // different defect from a value changing in place.
      itemized: [first, second].map(run => ({
        stable: run.itemization.stablePrefixTokens ?? null,
        tokens: run.itemization.tokens,
        deferred: movedIds(run.itemization, 'deferred'),
        // A split row is written with how many of its members went each way, so
        // a control below 100% can be read as "this bucket's split flipped"
        // rather than only "a depth row moved".
        depths: run.itemization.entries
          .filter(entry => entry.kind === 'depth')
          .map((entry) => {
            const members = entry.members ?? []
            const tally = members.length === 0
              ? entry.deferred === true ? '*' : entry.promoted === true ? '^' : ''
              : `[${String(members.filter(one => one.promoted === true).length)}^`
                + `/${String(members.filter(one => one.deferred === true).length)}*`
                + `/${String(members.length)}]`
            return `${entry.id}@${String(entry.depth)}${tally}`
          }),
      })),
    }
  } catch (error) {
    control = { failed: error instanceof Error ? error.message.slice(0, 60) : '?' }
  }

  let messages = view.messages
  if (messages.at(-1)?.role === 'assistant') {
    await handlers['chat.deleteMessage']({ chatId, id: messages.at(-1).id })
    messages = (await handlers['chat.open']({ chatId })).view.messages
  }
  if (messages.length < 3) {
    return { skipped: `${String(messages.length)} messages after peeling the reply`, label, control }
  }

  let injection = 0
  const rounds = []
  for (let step = 0; step <= ROUNDS; step += 1) {
    const current = (await handlers['chat.open']({ chatId })).view.messages
    if (current.length < 2) break
    // A different value every assembly, which is the whole point: a card script
    // computes this while the turn is being prepared.
    if (options.mvu === true) { injection += 1; await registerInjection(handlers, chatId, 10 + injection) }
    rounds.push({ messages: current.length, ...await assembleOnce(chatId) })
    for (let peel = 0; peel < 2; peel += 1) {
      const now = (await handlers['chat.open']({ chatId })).view.messages
      if (now.length <= 1) break
      await handlers['chat.deleteMessage']({ chatId, id: now.at(-1).id })
    }
  }
  if (rounds.length < 2) {
    return { skipped: `only ${String(rounds.length)} assemblable round(s)`, label, control }
  }

  return {
    label,
    control,
    rounds,
    // Oldest pair first, so the table reads in conversation order.
    pairs: rounds.slice(0, -1).map((_unused, index) => {
      const older = rounds[rounds.length - 1 - index]
      const newer = rounds[rounds.length - 2 - index]
      return { from: older.messages, to: newer.messages, ...compare(older.options, newer.options, label) }
    }),
    deferred: [...new Set(rounds.flatMap(round => movedIds(round.itemization, 'deferred')))],
    promoted: [...new Set(rounds.flatMap(round => movedIds(round.itemization, 'promoted')))],
    // Which rows the host split into members, and into how many. A row that is
    // split but has nothing in `promoted` is the case worth seeing: the bucket
    // was decomposed and no entry in it has settled yet.
    split: [...new Set(rounds.flatMap(round => round.itemization.entries
      .filter(entry => (entry.members ?? []).length > 0)
      .map(entry => `${entry.id}(${String(entry.members.length)})`)))],
    stable: rounds.map(round => ({
      messages: round.messages,
      prefix: round.itemization.stablePrefixTokens ?? null,
      tokens: round.itemization.tokens,
    })),
  }
}

// --- main ------------------------------------------------------------------

function percent(part, whole) {
  return whole === 0 ? '—' : `${(part / whole * 100).toFixed(1)}%`
}

/**
 * Restore the mutable half of a profile copy from the pristine source.
 *
 * The walk is destructive (it deletes messages) and each pass has to start from
 * the same conversation. Only `chats/` and `settings.json` are rewritten: the
 * cards, books and presets are 120 MB and are never written to, so re-copying
 * them per pass would make the probe cost minutes for nothing.
 */
async function resetMutable(source, target) {
  for (const name of ['chats', 'settings.json']) {
    await rm(join(target, name), { recursive: true, force: true })
    if (existsSync(join(source, name))) {
      await cp(join(source, name), join(target, name), { recursive: true })
    }
  }
}

/** One pass's readings, printed as a table. */
function reportPass(name, result) {
  console.log(`  ${name}`)
  const control = result.control
  if (control === null || control === undefined) {
    console.log('    control (same state twice): not measurable')
  } else if (control.failed !== undefined) {
    console.log(`    control (same state twice): n/a — ${control.failed}`)
  } else {
    console.log(`    control (same state twice)  body ${String(control.bodyBytes.after).padStart(6)} B`
      + `  prefix ${String(control.bodyBytes.prefix).padStart(6)} B`
      + `  = ${percent(control.bodyBytes.prefix, control.bodyBytes.after).padStart(6)} ceiling`
      + `  ${control.identicalBody
        ? 'identical'
        : `first diff ${control.firstDiff.where} ${control.firstDiff.label}`}`)
    control.itemized?.forEach((run, index) => {
      console.log(`      assembly ${String(index + 1)}: stable ${String(run.stable)}/${String(run.tokens)} tok`
        + `; moved ${String(run.deferred.length)}`
        + `; depth rows ${run.depths.length === 0 ? 'none' : run.depths.join(' ')}`)
    })
  }
  if (result.skipped !== undefined) {
    console.log(`    adjacent rounds: skipped — ${result.skipped}`)
    return
  }
  for (const pair of result.pairs) {
    const run = pair
    const loss = run.bodyBytes.after - run.bodyBytes.prefix
    console.log(`    ${String(pair.from).padStart(3)} -> ${String(pair.to).padStart(3)} msg`
      + `  body ${String(run.bodyBytes.after).padStart(6)} B`
      + `  prefix ${String(run.bodyBytes.prefix).padStart(6)} B`
      + `  = ${percent(run.bodyBytes.prefix, run.bodyBytes.after).padStart(6)} ceiling`
      + `  loss ${String(loss).padStart(6)} B = new ${String(run.lossAfterPrefix.newText).padStart(6)}`
      + ` + repeated ${String(run.lossAfterPrefix.repeatedVerbatim).padStart(6)}`
      + `  first diff ${run.firstDiff === null ? 'identical' : `${run.firstDiff.where} ${run.firstDiff.label}`}`)
  }
  const ceilings = result.pairs.map(pair => pair.bodyBytes.prefix / pair.bodyBytes.after)
  const mean = ceilings.reduce((total, value) => total + value, 0) / ceilings.length
  console.log(`    mean ceiling ${(mean * 100).toFixed(1)}%`
    + `; min ${(Math.min(...ceilings) * 100).toFixed(1)}%`
    + `; max ${(Math.max(...ceilings) * 100).toFixed(1)}%`)
  const newest = result.stable[0]
  console.log(`    host's own reading, newest round: stable prefix `
    + `${String(newest.prefix)} / ${String(newest.tokens)} tok = ${percent(newest.prefix, newest.tokens)}`)
  for (const [word, ids] of [
    ['moved back', result.deferred],
    ['moved forward', result.promoted],
    ['split into members', result.split ?? []],
  ]) {
    console.log(`    ${word}: ${ids.length === 0
      ? 'nothing'
      : `${String(ids.length)} — ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', …' : ''}`}`)
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
  const copy = join(dataDir, PROFILE)
  console.log(`profile   ${source}`)
  console.log(`copy      ${copy}`)
  console.log(`rounds    ${String(ROUNDS)}; mvu simulation ${MVU ? 'on' : 'off'}`)
  await cp(source, copy, { recursive: true })

  try {
    const listing = await buildHost(dataDir)
    const listed = (await listing.handlers['chat.list']()).chats
    const targets = []
    for (const wanted of WANTED) {
      const hits = listed.filter(chat =>
        chat.chatId.includes(wanted) || (chat.title ?? '').includes(wanted))
      if (hits.length === 0) { console.log(`\n### ${wanted}: no such conversation`); continue }
      for (const hit of ALL_MATCHES ? hits : hits.slice(0, 1)) {
        targets.push({ chatId: hit.chatId, wanted })
      }
    }

    for (const target of targets) {
      console.log(`\n### ${target.wanted} -> ${target.chatId}`)

      // Pass 1: the control. With the flag off the assembly is byte-for-byte
      // what it always was, so this must reproduce CACHE-PREFIX.md.
      await resetMutable(source, copy)
      const off = await walk(await buildHost(dataDir, { cacheFriendly: false }), target.chatId)
      reportPass('off (SillyTavern order)', off)

      // Pass 2: on, with nothing learned. A brand-new conversation's first turns.
      await resetMutable(source, copy)
      const coldHost = await buildHost(dataDir, { cacheFriendly: true })
      const cold = await walk(coldHost, target.chatId)
      reportPass('on, cold classifier', cold)
      const learnt = await coldHost.learntVolatility(target.chatId)
      const learntIds = Object.keys(learnt?.until ?? {})
      // Every id the cold walk ever saw that it did NOT mark volatile is one the
      // steady state would have settled, so the seed for pass 3 is derived from
      // the product's own record rather than from a guess about which ids matter.
      const settledIds = Object.keys(learnt?.seen ?? {}).filter(id => !learntIds.includes(id))
      console.log(`    the classifier learned ${String(learntIds.length)} volatile`
        + ` and ${String(settledIds.length)} settled id(s) over ${String(learnt?.generation ?? 0)} generations`)

      // Pass 3: on, seeded with what pass 2 learned — the steady state.
      await resetMutable(source, copy)
      const primedHost = await buildHost(dataDir, { cacheFriendly: true })
      await primedHost.seedVolatility(target.chatId, { volatile: learntIds, settled: settledIds })
      reportPass('on, primed (steady state)', await walk(primedHost, target.chatId))

      if (!MVU) continue

      // Passes 4 and 5: the same two, with a per-turn head injection.
      await resetMutable(source, copy)
      reportPass('off + per-turn head injection',
        await walk(await buildHost(dataDir, { cacheFriendly: false }), target.chatId, { mvu: true }))

      await resetMutable(source, copy)
      const mvuHost = await buildHost(dataDir, { cacheFriendly: true })
      // The injection's id is known without having to discover it: it is one
      // `setExtensionPrompt` key, and the classifier predicts every live one
      // volatile on sight (`entropicIds`). Seeded anyway, together with what the
      // no-injection pass learned, so this pass is the steady state too.
      await mvuHost.seedVolatility(target.chatId, {
        volatile: [...learntIds, `script.${MVU_KEY}`],
        settled: settledIds,
      })
      reportPass('on, primed + per-turn head injection',
        await walk(mvuHost, target.chatId, { mvu: true }))
    }
  } finally {
    if (process.env.IRIS_PROBE_KEEP === '1') console.log(`\nkept ${scratch}`)
    else await rm(scratch, { recursive: true, force: true })
  }
}

await main()
