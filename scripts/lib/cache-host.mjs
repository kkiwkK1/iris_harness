/**
 * The headless host, and the segment arithmetic, that the cache scripts share.
 *
 * `scripts/cache-prefix-probe.mjs` asked one question — where do the last two
 * requests of one conversation stop agreeing — and carried its own copy of this
 * standup. The census asks a different question of every conversation at once
 * and needs the same host, so the standup moved here rather than being pasted a
 * second time. **The probe still carries its own copy**: rewriting a working
 * instrument to import this one would have put a merge conflict in front of
 * three other people editing `scripts/` in parallel, for no new measurement.
 * If the two ever disagree about a number, this file is the newer one and the
 * probe is the one that produced the figures in `CACHE-PREFIX.md`; the census
 * report quotes one overlapping pair from both, on purpose, as the check.
 *
 * ## Nothing leaves this process, and nothing is written to the profile
 *
 * The operator's profile is **copied** into a scratch directory and the host
 * runs against the copy. The `stream` the service is built with records the
 * request and then throws, so no candidate is ever appended and no request is
 * ever sent. Every destructive step the callers take — peeling replies,
 * appending synthetic exchanges, registering injections — happens to the copy.
 *
 * ## What these bytes are not
 *
 * `ChatEntry.extensionPrompts` is an in-memory `Map` (`entry.ts:329`), so a
 * headless run sees no card-script injection unless the caller registers one
 * itself through `script.setExtensionPrompt`. Whatever a run reports about
 * churn is a floor, not a ceiling — except where the caller has put the
 * injection there deliberately, which is what makes the MVU experiment a
 * measurement of the real placement path rather than a guess about it.
 *
 * @module scripts/lib/cache-host
 */

import { cp, mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { serializeRequest } from '../../packages/iris-llm-openai-compat/src/serialize.ts'
import { estimateTokens } from '../../packages/iris-tokenizer/src/index.ts'

import { BackupStore, DEFAULT_BACKUP_KEEP } from '../../packages/iris-app-service/src/backups.ts'
import { ChatStore } from '../../packages/iris-app-service/src/chats.ts'
import { ConnectionStore } from '../../packages/iris-app-service/src/connections.ts'
import { DiagnosticBuffer } from '../../packages/iris-app-service/src/diagnostics.ts'
import { ExtensionSettingsStore, openGlobalScope } from '../../packages/iris-app-service/src/context.ts'
import { FavoriteStore } from '../../packages/iris-app-service/src/favorites.ts'
import { CharacterLibrary } from '../../packages/iris-app-service/src/library.ts'
import { materialiseEmbeddedBook, WorldbookBindingStore } from '../../packages/iris-app-service/src/materialise.ts'
import { DEFAULT_PROFILE, profilePaths } from '../../packages/iris-app-service/src/paths.ts'
import { PersonaStore } from '../../packages/iris-app-service/src/persona.ts'
import { PresetStore } from '../../packages/iris-app-service/src/presets.ts'
import { DEFAULT_PRESET } from '../../packages/iris-app-service/src/prompt.ts'
import { ScriptButtonStore } from '../../packages/iris-app-service/src/script-buttons.ts'
import { ScriptPolicyStore } from '../../packages/iris-app-service/src/scripts.ts'
import { ScriptVariableStore } from '../../packages/iris-app-service/src/script-variables.ts'
import { SettingsStore } from '../../packages/iris-app-service/src/settings.ts'
import { StInstall } from '../../packages/iris-app-service/src/st-install.ts'
import { IrisAppService } from '../../packages/iris-app-service/src/service.ts'
import { WorldbookStore } from '../../packages/iris-app-service/src/worldbooks.ts'

export { serializeRequest, estimateTokens }
export { DEFAULT_PROFILE, profilePaths }

/** DeepSeek reports its cache in blocks of this many tokens. */
export const BLOCK_TOKENS = 64

/** Bytes of a string as UTF-8, which is what the wire counts. */
export const bytes = text => Buffer.byteLength(text, 'utf8')

/** Length in bytes of the longest common prefix of two strings, UTF-8. */
export function commonPrefixBytes(left, right) {
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

/** How many UTF-16 units of `text` make up its first `count` UTF-8 bytes. */
export function sliceForBytes(text, count) {
  let total = 0
  for (let index = 0; index < text.length; index += 1) {
    total += bytes(text[index])
    if (total > count) return index
  }
  return text.length
}

/** The failure the capturing stream raises once it has the request. */
export class Captured extends Error {}

/**
 * Copy the operator's profile into a fresh scratch directory.
 *
 * One copy per host, because every caller mutates its copy.
 * @param source - the profile root to copy (`…/data/default-user`).
 * @param profile - the profile name the copy is filed under.
 * @param scratchRoot - where the copies live.
 * @returns the `data` directory a host should be built over.
 */
export async function copyProfile(source, profile, scratchRoot) {
  await mkdir(scratchRoot, { recursive: true })
  const scratch = await mkdtemp(join(scratchRoot, 'run-'))
  const dataDir = join(scratch, 'data')
  await cp(source, join(dataDir, profile), { recursive: true })
  return { dataDir, scratch }
}

/** Where scratch copies go unless the caller says otherwise. */
export const SCRATCH_ROOT = process.env.IRIS_PROBE_SCRATCH ?? join(tmpdir(), 'iris-cache-prefix')

/**
 * Stand up the application service over a profile directory, with a stream
 * that records the request and then refuses it.
 *
 * Verbatim from `cache-prefix-probe.mjs` apart from the profile argument and
 * the extra `service` handle; the composition's numbers come from
 * `apps/iris/cordis.yml`, so the budget measured under is the budget the
 * product assembles under.
 * @param dataDir - the `data` directory holding the profile copy.
 * @param profile - the profile name inside it.
 * @returns the handlers, a one-shot assembler, and the stores.
 */
export async function buildHost(dataDir, profile = DEFAULT_PROFILE) {
  const warn = message => {
    const text = message instanceof Error ? message.message : String(message)
    if (process.env.IRIS_PROBE_VERBOSE === '1') console.error(`  · ${text}`)
  }
  const paths = profilePaths(dataDir, profile)

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
    throw new Captured('cache census: request captured, not sent')
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

  return { handlers, assembleOnce, library, worldbooks, settings, service, personas }
}

// --- segmentation ----------------------------------------------------------

/**
 * Cut one captured request into labelled segments whose texts, concatenated in
 * order, reproduce the request exactly.
 *
 * The system prompt is `renderSystem`'s `\n\n`-joined blocks, so splitting on
 * the same separator can only ever be *finer* than the contribution boundaries
 * — never coarser, and never wrong about where a byte lands.
 * @param options - a captured `GenerateOptions`.
 * @returns the segments, in wire order.
 */
export function segmentsOf(options) {
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
export function textOf(options) {
  return segmentsOf(options).map(segment => segment.text).join('')
}

// --- macros ----------------------------------------------------------------

/**
 * Macros whose value is expected to differ between two adjacent turns, by kind.
 *
 * Split by *why* they move, because the three kinds have different fixes: an
 * entropy macro can only be moved (or the author can drop it), a
 * history-reading macro is stable once the entry sits behind the growth point,
 * and a state-reading macro moves exactly when the card's variables move, which
 * is every turn for a card running MVU.
 */
export const VOLATILE_MACROS = {
  entropy: ['random', 'roll'],
  clock: [
    'time', 'date', 'weekday', 'isotime', 'isodate', 'datetimeformat',
    'time_UTC', 'timeDiff', 'idle_duration',
  ],
  history: ['lastMessage', 'lastUserMessage', 'lastCharMessage', 'input', 'lastSwipeId'],
  state: [
    'format_message_variable', 'getvar', 'getglobalvar', 'get_message_variable',
    'setvar', 'setglobalvar', 'addvar', 'incvar', 'decvar', 'var',
  ],
}

/** Every macro name appearing in a raw (unexpanded) text, in order of appearance. */
export function macrosIn(text) {
  const found = []
  const pattern = /\{\{\s*([#/]?[A-Za-z_][\w-]*)/gu
  let match = pattern.exec(text)
  while (match !== null) {
    if (!found.includes(match[1])) found.push(match[1])
    match = pattern.exec(text)
  }
  return found
}

/** The volatile macros in a raw text, tagged by kind. */
export function volatileMacrosIn(text) {
  const names = macrosIn(text)
  const out = []
  for (const [kind, list] of Object.entries(VOLATILE_MACROS)) {
    for (const name of names) if (list.includes(name)) out.push({ kind, name })
  }
  return out
}

// --- the catalog: what a segment is, and which cause bucket it belongs to ---

/**
 * Cause buckets, in the vocabulary the fix is written in.
 *
 * `depth<n>` is left as a family rather than one bucket because the depths do
 * not share a fix: depth 0 sits after the newest reply and can never be in a
 * prefix, while depth 8 in a long conversation is behind the growth point and
 * therefore already stable.
 */
export const CAUSES = [
  'preset', 'card', 'persona',
  'worldInfoBefore', 'worldInfoAfter', 'authorNote', 'exampleMessages', 'outlet',
  'depth', 'scriptInject', 'history', 'unmatched',
]

/** The cause bucket a world-info entry's numeric `position` belongs to. */
export function causeOfWorldPosition(position, depth) {
  switch (position) {
    case 0: return { cause: 'worldInfoBefore', detail: 'position 0 (before character)' }
    case 1: return { cause: 'worldInfoAfter', detail: 'position 1 (after character)' }
    case 2: return { cause: 'authorNote', detail: 'position 2 (before author note)' }
    case 3: return { cause: 'authorNote', detail: 'position 3 (after author note)' }
    case 5: return { cause: 'exampleMessages', detail: 'position 5 (before examples)' }
    case 6: return { cause: 'exampleMessages', detail: 'position 6 (after examples)' }
    case 7: return { cause: 'outlet', detail: 'position 7 (outlet)' }
    default: return { cause: 'depth', detail: `position 4, depth ${String(depth ?? '?')}` }
  }
}

/**
 * Build the catalog that names a segment and puts it in a cause bucket.
 *
 * The character's own book is listed **first**, because several cards in this
 * corpus ship the same copied MVU boilerplate and a longest-literal match would
 * otherwise name a world block after whichever book the scan reached first —
 * the label hazard `cache-prefix-probe.mjs` already documents. Ordering by
 * ownership does not remove the hazard; it makes the wrong answer rarer and
 * always in the direction of this card.
 * @param host - a built host.
 * @param handlers - its handlers.
 * @param view - the opened chat view.
 * @returns catalog items, most specific first.
 */
export async function catalogFor(host, handlers, view) {
  const catalog = []
  if (view.characterId !== undefined) {
    try {
      const card = await host.library.load(view.characterId)
      const data = card.data ?? card
      for (const field of [
        'system_prompt', 'post_history_instructions',
        'description', 'personality', 'scenario', 'mes_example', 'first_mes',
      ]) {
        if (typeof data[field] === 'string') {
          catalog.push({ name: `card.${field}`, cause: 'card', detail: field, text: data[field] })
        }
      }
    } catch { /* a card the library cannot read labels nothing */ }
  }
  for (const persona of (await handlers['persona.list']()).personas ?? []) {
    catalog.push({
      name: `persona "${persona.name}"`, cause: 'persona', detail: persona.name,
      text: persona.description ?? '',
    })
  }
  const manager = (await handlers['preset.view']()).manager
  for (const prompt of manager.prompts ?? []) {
    const name = prompt.name ?? prompt.identifier ?? prompt.id
    catalog.push({ name: `preset "${name}"`, cause: 'preset', detail: name, text: prompt.content ?? '' })
  }
  view.messages.forEach(message => {
    catalog.push({
      name: `history(id=${String(message.id)},${message.role})`,
      cause: 'history', detail: `id ${String(message.id)}`, text: message.text,
    })
  })

  // This card's own books first, then everything else. `worldbook.charNames`
  // is the host's own answer to "which books play for this card", so the order
  // is not a guess about naming conventions.
  const names = await host.worldbooks.names()
  const own = new Set()
  if (view.characterId !== undefined) {
    try {
      const answer = await handlers['worldbook.charNames']({ characterId: view.characterId, withCard: true })
      for (const value of [answer.primary, answer.card?.name, ...answer.additional ?? []]) {
        if (typeof value === 'string' && value !== '') own.add(value)
      }
    } catch { /* a card whose books cannot be listed just loses the ordering */ }
  }
  const ordered = [
    ...names.filter(name => own.has(name)),
    ...names.filter(name => !own.has(name)),
  ]
  for (const name of ordered) {
    try {
      for (const entry of await host.worldbooks.get(name)) {
        const tag = entry.comment !== undefined && entry.comment !== ''
          ? entry.comment
          : `#${String(entry.uid ?? '?')}`
        const { cause, detail } = causeOfWorldPosition(entry.position, entry.depth)
        catalog.push({
          name: `world "${name}" ${tag}`,
          cause,
          detail: `${detail}, order ${String(entry.order ?? '?')}`,
          book: name,
          text: entry.content ?? '',
        })
      }
    } catch { /* skip an unreadable book */ }
  }
  return catalog
}

/**
 * A function naming a segment's source, its cause bucket and its macros.
 *
 * Macros are already expanded in a captured request, so an exact match is the
 * exception: the test is the longest literal run of the candidate (a stretch
 * with no `{{…}}` and no `<%…%>`) appearing in the segment.
 *
 * **A label is a hint, not a finding.** The authoritative name of a
 * contribution is the itemization row the host itself produced
 * (`worldInfo.depth.0.0`, `charDescription`, …), which the callers print beside
 * these labels for that reason.
 * @param catalog - items from {@link catalogFor}.
 * @returns a function from segment text to `{name, cause, detail, macros}`.
 */
export function labeller(catalog) {
  // **Two thresholds, tried in order.** A 24-character literal run is specific
  // enough that a match is almost certainly the right source, but an entry that
  // is mostly macros has no run that long — and the first census run charged
  // four conversations' entire same-state jitter to `unmatched` for exactly
  // that reason, which reads as "no cause found" when the cause was a world
  // entry made of `{{roll}}` calls. The short pass is tried only after every
  // long probe has failed, so a specific match always wins over a vague one.
  const prepare = minimum => catalog.map(item => {
    const runs = String(item.text ?? '')
      .split(/\{\{[^}]*\}\}|<%[\s\S]*?%>/u)
      .map(run => run.trim())
      .filter(run => run.length >= minimum)
      .sort((left, right) => right.length - left.length)
    return { ...item, probe: runs[0], macros: volatileMacrosIn(String(item.text ?? '')) }
  }).filter(item => item.probe !== undefined)
  const specific = prepare(24)
  const vague = prepare(8)

  return (text, where = '') => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return { name: 'empty', cause: 'unmatched', detail: 'empty block', macros: [] }
    for (const item of specific) {
      if (text.includes(item.probe)) {
        return { name: item.name, cause: item.cause, detail: item.detail, macros: item.macros }
      }
    }
    for (const item of vague) {
      if (text.includes(item.probe)) {
        return {
          name: item.name, cause: item.cause,
          detail: `${item.detail} (matched on a short literal run — weaker evidence)`,
          macros: item.macros,
        }
      }
    }
    // Nothing in the catalog claimed it. The slot still says something: a
    // system block nobody owns is a preset section whose literal run is too
    // short to probe with, and a message slot is either history or a depth
    // injection — reported as unmatched rather than guessed into a bucket.
    return {
      name: 'unmatched',
      cause: 'unmatched',
      detail: where.startsWith('system') ? 'system block, no catalog match' : 'message slot, no catalog match',
      macros: [],
    }
  }
}

// --- comparing two requests ------------------------------------------------

/**
 * Resolve an unnamed **message** slot by where it sits, not by what it says.
 *
 * A message slot the catalog cannot claim is one of two things, and its
 * position decides which. Iris's message list is the history projection with
 * depth-placed contributions spliced in (`injectAtDepth`), so:
 *
 * - **In the shared tail** — byte-identical between the two requests *and* at
 *   the same index counted from the end — it is anchored to the conversation's
 *   end, which is exactly what depth placement means. It cannot be new history,
 *   because new history is at the growth point by construction; and it cannot
 *   be old history, because appending an exchange shifts old history relative
 *   to the end while leaving depth content aligned.
 * - **At the growth point** it is history: everything else in the message list
 *   comes from a catalog source (a world entry, a card note, a script
 *   injection), matched by a literal run of the source text, while a history
 *   message reaches the wire after global regex and the prompt scripts have
 *   rewritten it — which is why the catalog's copy of it does not match.
 *
 * Both are eliminations rather than identifications, and both say so in
 * `detail`. The alternative was one `unmatched` bucket holding 75% of the rent
 * ledger, which named no cause at all.
 * @param named - what the labeller returned.
 * @param region - `'tail'` or `'boundary'`.
 * @returns the named result, with the fallback applied when it was unmatched.
 */
function resolveMessageFallback(named, region) {
  if (named.cause !== 'unmatched') return named
  if (region === 'tail') {
    return {
      ...named,
      cause: 'depth',
      name: 'depth-anchored content (unnamed)',
      detail: 'by elimination: byte-identical and aligned to the conversation end',
    }
  }
  return {
    ...named,
    cause: 'history',
    name: 'history message (unnamed)',
    detail: 'by elimination: at the growth point, and regex/prompt scripts rewrote it before the wire',
  }
}

/** Whether two segments are the same piece of request. */
const sameSegment = (left, right) =>
  left !== undefined && right !== undefined && left.role === right.role && left.text === right.text

/** Ceiling figures for one prefix length. */
function ceiling(prefixBytes, textBefore, textAfter) {
  const prefixText = textBefore.slice(0, sliceForBytes(textBefore, prefixBytes))
  const prefixTokens = estimateTokens(prefixText)
  const totalTokens = estimateTokens(textAfter)
  // The provider serves whole 64-token blocks, so a prefix of 100 shared tokens
  // buys 64 — the remainder is charged. Reporting the unrounded share would
  // overstate every small prefix, and a 63-token prefix is worth nothing.
  const blocks = Math.floor(prefixTokens / BLOCK_TOKENS) * BLOCK_TOKENS
  return {
    prefixBytes,
    totalBytes: bytes(textAfter),
    byteShare: bytes(textAfter) === 0 ? 0 : prefixBytes / bytes(textAfter),
    prefixTokens,
    totalTokens,
    blockTokens: blocks,
    blockShare: totalTokens === 0 ? 0 : blocks / totalTokens,
    lostTokens: Math.max(0, totalTokens - blocks),
  }
}

/**
 * Compare two captured requests: the wire bytes, then the segments, then the
 * counterfactual ceilings.
 *
 * Segments are aligned from both ends rather than by index. History grows at
 * the tail and depth injections slide forward as it does, so an index-aligned
 * diff past the growth point reports every later message as changed when the
 * text is the same message one slot along.
 * @param before - the earlier request.
 * @param after - the later request.
 * @param label - a {@link labeller}.
 * @returns the comparison.
 */
/**
 * Name the system section a byte offset falls in, using the host's own rows.
 *
 * **Why this exists.** The catalog matches a segment by finding a literal run
 * of a known source inside it, and a whole family of sources is invisible to
 * it: a card's *embedded* world book lives base64-encoded inside the card PNG,
 * so it is in no file the worldbook store lists and in no string a grep of the
 * profile can find. Four conversations' entire divergence was charged to
 * `unmatched` for that reason, and the block in question was a `{{roll}}` dice
 * table at `worldInfoBefore` — a cause with a name, an owner and a fix.
 *
 * The itemization *is* the host's own answer to "which section is this", so
 * this walks its system rows in wire order and returns the row whose cumulative
 * token span contains the offset. **It is approximate**: the rows carry token
 * counts, not texts, and `estimateTokens` is not exactly additive across a
 * concatenation, so a boundary can be off by a few tokens. Reported as
 * `approximate` for that reason — it is strong enough to name a 4 500-token
 * section and too weak to split two adjacent 5-token ones.
 * @param itemization - the host's itemization for the newer request.
 * @param tokenOffset - estimated tokens before the divergence, within `system`.
 * @returns the row's id and label, or undefined.
 */
export function systemSectionAt(itemization, tokenOffset) {
  if (itemization === undefined) return undefined
  let running = 0
  for (const entry of itemization.entries) {
    if (entry.kind !== 'system') continue
    const next = running + entry.tokens
    // `<=` on the running total would put a boundary offset in the previous
    // row; a zero-token row can never claim an offset, which is right — it
    // contributed no bytes for the offset to be inside.
    if (tokenOffset < next) {
      return { id: entry.id, label: entry.label, tokens: entry.tokens, approximate: true }
    }
    running = next
  }
  return undefined
}

/**
 * The cause bucket an itemization row id belongs to.
 *
 * The ids are the host's own (`worldInfoBefore`, `worldInfo.depth.0.0`, `main`,
 * `charDescription`, …); anything else is a preset section, because that is
 * what `resolvePreset` names by identifier.
 * @param id - the itemization row's id.
 * @returns a cause from {@link CAUSES}.
 */
export function causeOfItemId(id) {
  if (id === undefined) return undefined
  if (id === 'worldInfoBefore') return 'worldInfoBefore'
  if (id === 'worldInfoAfter') return 'worldInfoAfter'
  if (id.startsWith('worldInfo.depth')) return 'depth'
  if (id.startsWith('script.')) return 'scriptInject'
  if (id.startsWith('char') || id === 'personality' || id === 'scenario') return 'card'
  if (id.startsWith('persona')) return 'persona'
  return 'preset'
}

export function compare(before, after, label, itemization) {
  const bodyBefore = JSON.stringify(serializeRequest(before))
  const bodyAfter = JSON.stringify(serializeRequest(after))
  const textBefore = textOf(before)
  const textAfter = textOf(after)

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

  /**
   * One resolver, used by every consumer.
   *
   * **This was three resolvers and the numbers disagreed.** The catalog label
   * alone cannot see a card's embedded book or a rewritten history message, so
   * `firstDiff` and `wasted` each grew their own fallback while the
   * counterfactual closures kept calling the plain labeller — which meant
   * `ceilingWithout(cause === 'worldInfoBefore')` removed **nothing** on the
   * four conversations whose divergence *is* `worldInfoBefore`, and reported
   * the unchanged ceiling as the counterfactual. A number that answers "what if
   * we moved this" by moving nothing is worse than no number: it reads as "the
   * fix would not help".
   *
   * Resolution order, most direct evidence first: the catalog's literal-run
   * match, then the host's itemization for a `system` slot, then position for a
   * message slot.
   * @param side - the side the segment belongs to (`left` or `right`).
   * @param index - its index within that side.
   * @returns the resolved `{name, cause, detail, macros, section?}`.
   */
  const resolve = (side, index) => {
    const segment = side[index]
    const plain = label(segment.text, segment.where)
    if (segment.where.startsWith('system')) {
      const ahead = side.slice(0, index).map(item => item.text).join('')
      const section = systemSectionAt(itemization, estimateTokens(ahead))
      if (section === undefined) return plain
      if (plain.cause !== 'unmatched') return { ...plain, section }
      return {
        ...plain,
        section,
        cause: causeOfItemId(section.id) ?? 'unmatched',
        name: `itemization row ${section.id}${section.label === undefined ? '' : ` (${section.label})`}`,
        detail: 'named by the host\'s itemization, by cumulative token offset — approximate',
      }
    }
    // A message slot: the shared tail is depth-anchored, the rest is at the
    // growth point. `resolveMessageFallback` explains why that is an
    // elimination rather than a guess.
    const inTail = index >= side.length - tail
    return resolveMessageFallback(plain, inTail ? 'tail' : 'boundary')
  }

  /** Resolved causes for both sides, computed once. */
  const resolvedLeft = left.map((_segment, index) => resolve(left, index))
  const resolvedRight = right.map((_segment, index) => resolve(right, index))
  const resolvedFor = (side, index) => (side === left ? resolvedLeft : resolvedRight)[index]

  const textsBefore = new Set(left.map(segment => segment.text))
  const textsAfter = new Set(right.map(segment => segment.text))
  const kindOf = (segment, side) => {
    const elsewhere = side === 'before' ? textsAfter.has(segment.text) : textsBefore.has(segment.text)
    // `moved` is the one that matters for a prefix cache: the text is
    // byte-identical and sits at a different index, so it is re-sent in full
    // and charged in full, every turn, for nothing.
    if (elsewhere) return 'moved'
    return side === 'before' ? 'gone' : 'new'
  }

  const row = (segment, side) => {
    const list = side === 'before' ? left : right
    const named = resolvedFor(list, list.indexOf(segment))
    return {
      side,
      kind: kindOf(segment, side),
      where: segment.where,
      role: segment.role,
      bytes: bytes(segment.text),
      ...named,
    }
  }

  // **The NEWER request's segment at the boundary, not the older one's.**
  // The bill is for the newer request, so the cause of its miss is whatever it
  // has at the byte where agreement stops. Reading the older side instead —
  // which the first version did — mis-attributed every one of 爱衣's pairs to
  // `depth`: at that index the older request holds its depth-0 world block
  // while the newer one holds the reply that has just been appended, and the
  // block is not the cause, it is the content the growth *displaced*. How much
  // that displacement costs is `wasted` below, which is a different question
  // with a different answer.
  const firstDiff = middleBefore.length + middleAfter.length === 0
    ? null
    : row(middleAfter[0] ?? middleBefore[0], middleAfter.length > 0 ? 'after' : 'before')
  /** What the older request held at the same boundary, for the two-sided story. */
  const displaced = middleBefore.length === 0 ? null : row(middleBefore[0], 'before')
  // **The text itself, both sides, around the first character that differs.**
  // A label can fail; this cannot. It is the only part of the report that
  // survives a catalog with no entry for the source, and it is what turns "the
  // depth block changed" into "the depth block's timestamp changed".
  if (firstDiff !== null) {
    const a = (middleBefore[0] ?? { text: '' }).text
    const b = (middleAfter[0] ?? { text: '' }).text
    let cut = 0
    while (cut < Math.min(a.length, b.length) && a[cut] === b[cut]) cut += 1
    firstDiff.sample = {
      char: cut,
      before: a.slice(Math.max(0, cut - 70), cut + 70),
      after: b.slice(Math.max(0, cut - 70), cut + 70),
    }
  }

  return {
    bodyBytes: {
      before: bytes(bodyBefore), after: bytes(bodyAfter),
      prefix: commonPrefixBytes(bodyBefore, bodyAfter),
    },
    identicalBody: bodyBefore === bodyAfter,
    ceiling: ceiling(commonPrefixBytes(textBefore, textAfter), textBefore, textAfter),
    segments: { before: left.length, after: right.length, sharedHead: head, sharedTail: tail },
    /** Byte offset, in the text stream, where the shared head stops. */
    divergeAt: offsetOfHead,
    firstDiff,
    displaced,
    /**
     * **Rent paid for nothing**, folded by cause.
     *
     * The shared tail: segments the newer request repeats **byte for byte** and
     * that nevertheless sit behind the divergence, so every one of their tokens
     * is charged at the miss price on every turn. This is the quantity a
     * placement fix moves, and it is not the same as the pair's total loss —
     * the rest of the loss is text that is genuinely new and could not have
     * been cached by anyone.
     *
     * Tokens are estimated per segment and summed, which slightly overcounts
     * against estimating the concatenation, so it is an upper bound on the rent
     * and is named as one.
     */
    wasted: (() => {
      const folded = new Map()
      for (let index = right.length - tail; index < right.length; index += 1) {
        const segment = right[index]
        const named = resolvedFor(right, index)
        const entry = folded.get(named.cause)
          ?? { cause: named.cause, segments: 0, bytes: 0, tokens: 0, names: new Set() }
        entry.segments += 1
        entry.bytes += bytes(segment.text)
        entry.tokens += estimateTokens(segment.text)
        entry.names.add(named.name)
        folded.set(named.cause, entry)
      }
      return [...folded.values()]
        .map(entry => ({ ...entry, names: [...entry.names].slice(0, 4) }))
        .sort((first, second) => second.tokens - first.tokens)
    })(),
    changed: [
      ...middleBefore.map(segment => row(segment, 'before')),
      ...middleAfter.map(segment => row(segment, 'after')),
    ],
    /**
     * Everything the cache cannot serve, split by whether it is new text or
     * text the newer request repeats verbatim behind the divergence point. The
     * second number is the interesting one: it is charged in full every turn
     * and buys nothing, and it exists only because content is anchored to the
     * END of the conversation, so growth pushes it past the prefix.
     */
    lossAfterPrefix: {
      newText: middleAfter.reduce((total, segment) => total + bytes(segment.text), 0),
      repeatedVerbatim: right.slice(right.length - tail)
        .reduce((total, segment) => total + bytes(segment.text), 0),
    },
    /**
     * The ceiling this pair would have if every segment the predicate accepts
     * were moved to the very end of the request (or deleted).
     *
     * This is the shape of the counterfactual C's work has to hit: "if the
     * volatile depth bucket were behind the growth point, how much would the
     * cache serve?" Computed on the text stream rather than the JSON body,
     * because a segment cannot be spliced out of a body without also inventing
     * what the surrounding JSON would look like.
     * @param accepts - `(segment, named) => boolean`, the segments to remove.
     * @returns ceiling figures for the reduced pair.
     */
    ceilingWithout: accepts => {
      const keep = side => side
        .filter((segment, index) => !accepts(segment, resolvedFor(side, index)))
        .map(segment => segment.text)
        .join('')
      const reducedBefore = keep(left)
      const reducedAfter = keep(right)
      return {
        ...ceiling(commonPrefixBytes(reducedBefore, reducedAfter), reducedBefore, reducedAfter),
        // **How many segments the predicate actually touched.** A predicate that
        // matches nothing returns the unchanged ceiling, which reads as "moving
        // this would not help" — the exact false negative that shipped in the
        // first run of this census. Zero here means the number below is not a
        // counterfactual at all.
        touched: right.filter((segment, index) => accepts(segment, resolvedFor(right, index))).length,
      }
    },
    /**
     * The ceiling this pair would have if every segment the predicate accepts
     * were **hoisted to the front** of the request, keeping its relative order.
     *
     * This is the counterfactual for the other half of the advice. Content
     * anchored to the end of the conversation is re-sent in full every turn
     * *even when it never changes*, because growth pushes it past the prefix;
     * hoisting byte-identical content into the head puts it inside the prefix
     * and the whole block becomes free. It only helps when the content really
     * is identical between the two rounds — hoist something that changes every
     * turn and the divergence moves to byte 0, which the same number reports as
     * a collapse rather than a gain.
     *
     * Positions are not preserved for the model: hoisting changes what the
     * model reads and in what order. The number is a bound on what a placement
     * change could buy, not a claim that the change is free.
     * @param accepts - `(segment, named) => boolean`, the segments to hoist.
     * @returns ceiling figures for the rearranged pair.
     */
    ceilingHoisting: accepts => {
      const rearrange = side => {
        const hoisted = []
        const rest = []
        side.forEach((segment, index) => {
          if (accepts(segment, resolvedFor(side, index))) hoisted.push(segment.text)
          else rest.push(segment.text)
        })
        return [...hoisted, ...rest].join('')
      }
      const movedBefore = rearrange(left)
      const movedAfter = rearrange(right)
      return {
        ...ceiling(commonPrefixBytes(movedBefore, movedAfter), movedBefore, movedAfter),
        touched: right.filter((segment, index) => accepts(segment, resolvedFor(right, index))).length,
      }
    },
  }
}

/** Percent, or an em dash when the denominator is zero. */
export function percent(part, whole) {
  return whole === 0 ? '—' : `${(part / whole * 100).toFixed(1)}%`
}
