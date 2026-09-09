/**
 * Who reaches for SillyTavern's getContext() surface, the host page's globals,
 * and the bare library globals — and what of each Iris actually answers?
 *
 *   node scripts/st-context-audit.mjs
 *   node scripts/st-context-audit.mjs --verbose          # evidence lines per member
 *   node scripts/st-context-audit.mjs --surface          # print the extracted surfaces and exit
 *
 * Companion to `th-member-census.mjs`, which answers the same question for
 * Tavern Helper's 171-member surface. This one covers the other two faces a
 * card script can reach:
 *
 *   1. the `SillyTavern.getContext()` object — upstream `st-context.js` returns
 *      145 keys; Iris's facade answers a measured subset;
 *   2. the host page's globals, reached as `window.parent.X` / `top.X` —
 *      upstream that is the whole SillyTavern page; here it is the virtual
 *      parent proxy in `frame.ts`;
 *   3. the bare library globals (`$`, `_`, `toastr`, …) upstream seeds into every
 *      script frame and Iris bundles into `preset.js`.
 *
 * ## BRITTLE, against two sources
 *
 * Like `settings-usage-census.mjs` (upstream's layout) and
 * `th-member-census.mjs` (ours), this extractor reads source that either side
 * can rearrange:
 *
 * - the 145 keys are parsed out of the installed SillyTavern's
 *   `public/scripts/st-context.js` by brace-matching the returned object
 *   literal — an upstream refactor that reformats that literal stops this;
 * - Iris's side reads `CARD_METHODS` / `OFF_ST_SURFACE` out of
 *   `apps/iris-web/src/sandbox/card-api.ts` by declaration text, and the
 *   proxy-answered names and snapshot fields are **hand-listed** with their
 *   file:line in the constants below — a refactor that renames either constant,
 *   or a new `ScriptContext` field, must be mirrored here.
 *
 * Same failure discipline as the other two calipers: conclusions already
 * recorded do not expire, but no new number may be quoted until the extraction
 * is repaired and re-run.
 *
 * ## 口径
 *
 * - **The unit is the card**, keyed by the decoded card's `data.name` (two
 *   corpora carry overlapping libraries; identical script bodies deduplicate by
 *   content hash, so a card shipped twice counts once).
 * - **Three code populations**, as `th-member-census.mjs`: card script bodies;
 *   deduplicated rendered interfaces from the chats; sample cards.
 * - **`getContext()` members** are matched through their real routes:
 *   `SillyTavern.getContext().X`, a destructuring or alias assignment from the
 *   call (`const ctx = SillyTavern.getContext()` then `ctx.X`), and bare
 *   `ctx.X` where the assignment was seen in the same body.
 * - **Parent reads** match `(window.)?(parent|top).X` chains; a bare
 *   `parent.X` whose `parent` is a local DOM node is the known false-positive
 *   shape and is flagged, not silently counted (TEST-CARDS §J names the two).
 * - **Bare globals** are counted only when the name appears unqualified and
 *   unshadowed-looking (`$(`, `_.map`, `toastr.success`); template-literal
 *   `${` is excluded, and every hit class is printed so a human can audit.
 *
 * Skips when neither corpus is present. Always exits 0: a caliper, not a test.
 *
 * @module scripts/st-context-audit
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const UPSTREAM = process.env.IRIS_UPSTREAM ?? 'E:/sillyTavern/SillyTavern'
const ST_CONTEXT_JS = `${UPSTREAM}/public/scripts/st-context.js`
const E_CORPUS = `${UPSTREAM}/data/default-user/characters`
const E_CHATS = `${UPSTREAM}/data/default-user/chats`
const REPO_CORPUS = `${ROOT}apps/iris/data/default-user/characters`
const SAMPLE = 'D:/workspace/小项目/iris_分支/测试用卡'

const verbose = process.argv.includes('--verbose')
const surfaceOnly = process.argv.includes('--surface')

if (!existsSync(E_CORPUS) && !existsSync(REPO_CORPUS)) {
  console.log('st-context-audit: skipped — no card corpus at')
  console.log(`  ${E_CORPUS}`)
  console.log(`  ${REPO_CORPUS}`)
  console.log('Set IRIS_UPSTREAM to point at an install.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 1. The upstream 145, extracted from st-context.js with line numbers
// ---------------------------------------------------------------------------

/**
 * Top-level keys of the object literal `getContext()` returns.
 *
 * Char-scanner, not a line regex: keys sit at brace depth 1, either
 * `key:` or shorthand `key,`. Strings, template literals and both comment
 * forms are skipped; the file carries `/** @deprecated *​/` blocks between
 * keys. A regex literal would confuse the scanner — st-context.js carries
 * none; if upstream adds one this answers with a wrong count, which is why
 * the count is printed rather than assumed.
 * @param {string} source - st-context.js's text.
 * @returns {{name: string, line: number}[]}
 */
function extractContextKeys(source) {
  const start = source.indexOf('export function getContext()')
  if (start === -1) return []
  const open = source.indexOf('return {', start)
  if (open === -1) return []
  const keys = []
  let depth = 0 // 0 = top level of the returned object literal
  let i = open + 'return {'.length // just past the `{`
  let line = source.slice(0, i).split('\n').length
  let atKey = true
  while (i < source.length) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i++; continue }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      line += source.slice(i, end === -1 ? source.length : end + 2).split('\n').length - 1
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== ch) { if (source[j] === '\\') j++; if (source[j] === '\n') line++; j++ }
      i = j + 1
      continue
    }
    if (ch === '\n') { line++; i++; continue }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; atKey = false; i++; continue }
    if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0) break // closed the returned object
      depth--
      i++
      continue
    }
    if (ch === ',' && depth === 0) { atKey = true; i++; continue }
    if (ch === ':' && depth === 0) { atKey = false; i++; continue }
    if (atKey && depth === 0 && /[A-Za-z_$]/.test(ch)) {
      const rest = source.slice(i)
      const name = rest.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)[0]
      // A key is followed by `:`, `,` (shorthand) or `}` (last, shorthand);
      // anything else is an expression in a value (`? groups.find…`).
      const followedBy = rest.slice(name.length).match(/^\s*(.)/s)
      if (followedBy && [',', '}', ':'].includes(followedBy[1])) keys.push({ name, line })
      atKey = false
      i += name.length
      continue
    }
    i++
  }
  return keys
}

const upstreamSource = readFileSync(ST_CONTEXT_JS, 'utf8')
const CONTEXT_KEYS = extractContextKeys(upstreamSource)
const upstreamNames = CONTEXT_KEYS.map(k => k.name)

if (surfaceOnly) {
  console.log(`upstream keys extracted: ${CONTEXT_KEYS.length}`)
  for (const key of CONTEXT_KEYS) console.log(`  ${String(key.line).padStart(4)}  ${key.name}`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 2. The domains the report groups the 145 into
// ---------------------------------------------------------------------------

/** member → domain. Unlisted members land in `杂项`. */
const DOMAINS = [
  ['聊天与消息', ['chat', 'chatMetadata', 'chatId', 'updateChatMetadata', 'saveChat', 'saveMetadata',
    'saveMetadataDebounced', 'addOneMessage', 'deleteLastMessage', 'deleteMessage', 'updateMessageBlock',
    'printMessages', 'clearChat', 'saveReply', 'extractMessageFromData', 'ensureMessageMediaIsArray',
    'getMediaDisplay', 'getMediaIndex', 'appendMediaToMessage', 'scrollChatToBottom', 'scrollOnMediaLoad',
    'streamingProcessor', 'sendSystemMessage', 'swipe']],
  ['角色与群组', ['characters', 'characterId', 'getCharacters', 'getOneCharacter', 'getCharacterCardFields',
    'getCharacterSource', 'selectCharacterById', 'openCharacterChat', 'createCharacterData', 'unshallowCharacter',
    'getThumbnailUrl', 'groups', 'groupId', 'openGroupChat', 'unshallowGroupMembers']],
  ['生成控制', ['generate', 'generateRaw', 'generateRawData', 'generateQuietPrompt', 'sendGenerationRequest',
    'sendStreamingRequest', 'stopGeneration', 'ChatCompletionService', 'TextCompletionService',
    'ConnectionManagerRequestService', 'getRequestHeaders', 'CONNECT_API_MAP', 'getTextGenServer',
    'getChatCompletionModel', 'chatCompletionSettings', 'textCompletionSettings', 'mainApi', 'onlineStatus',
    'maxContext', 'shouldSendOnEnter', 'isMobile', 'ToolManager', 'registerFunctionTool', 'unregisterFunctionTool',
    'isToolCallingSupported', 'canPerformToolCalls']],
  ['预设与注入', ['getPresetManager', 'extensionPrompts', 'setExtensionPrompt']],
  ['斜杠与宏', ['SlashCommandParser', 'SlashCommand', 'SlashCommandArgument', 'SlashCommandNamedArgument',
    'SlashCommandEnumValue', 'ARGUMENT_TYPE', 'executeSlashCommandsWithOptions', 'registerSlashCommand',
    'executeSlashCommands', 'substituteParams', 'substituteParamsExtended', 'macros', 'registerMacro',
    'unregisterMacro', 'registerHelper']],
  ['世界书', ['loadWorldInfo', 'saveWorldInfo', 'reloadWorldInfoEditor', 'updateWorldInfoList',
    'convertCharacterBook', 'getWorldInfoPrompt', 'getWorldInfoNames']],
  ['变量', ['variables']],
  ['事件', ['eventSource', 'eventTypes', 'event_types']],
  ['弹窗与界面', ['callPopup', 'callGenericPopup', 'Popup', 'POPUP_TYPE', 'POPUP_RESULT', 'showLoader',
    'hideLoader', 'loader', 'messageFormatting', 'activateSendButtons', 'deactivateSendButtons']],
  ['扩展与设置', ['extensionSettings', 'ModuleWorkerWrapper', 'writeExtensionField', 'writeExtensionFieldBulk',
    'renderExtensionTemplate', 'renderExtensionTemplateAsync', 'registerDataBankScraper', 'getExtensionManifest',
    'openThirdPartyExtensionMenu', 'powerUserSettings', 'accountStorage']],
  ['分词', ['tokenizers', 'getTextTokens', 'getTokenCount', 'getTokenCountAsync', 'getTokenizerModel']],
]
const domainOf = new Map(DOMAINS.flatMap(([domain, names]) => names.map(name => [name, domain])))

// ---------------------------------------------------------------------------
// 3. Iris's side of each face
// ---------------------------------------------------------------------------

/**
 * Names Iris's `SillyTavern` facade answers that the proxy builds itself —
 * the branches in `frame.ts`'s `sillyTavern` proxy, cited to the line each
 * branch sits on. Extracting these from the source would mean parsing a
 * 400-line `get` trap; they change rarely and the pinned test
 * (`tests/sandbox-frame.test.ts` 'the SillyTavern surface carries exactly
 * these members') fails when the reachable set moves, which is the signal to
 * update this list.
 */
const IRIS_PROXY_NAMES = [
  ['getContext', 'frame.ts:620'],
  ['extensionSettings', 'frame.ts:621'],
  ['saveSettings', 'frame.ts:647'],
  ['saveSettingsDebounced', 'frame.ts:648'],
  ['POPUP_TYPE', 'frame.ts:664'],
  ['POPUP_RESULT', 'frame.ts:665'],
  ['callGenericPopup', 'frame.ts:666'],
  ['callPopup', 'frame.ts:667'],
  ['Popup', 'frame.ts:668'],
  ['eventSource', 'frame.ts:684'],
  ['event_types', 'frame.ts:685'],
  ['characterId', 'frame.ts:730'],
  ['getCurrentChatId', 'frame.ts:732'],
  ['updateChatMetadata', 'frame.ts:760'],
]

/**
 * Every field `ScriptContext` carries — the snapshot's own properties are all
 * reachable through the facade's final `Object.hasOwn` branch
 * (`frame.ts:944-945`). `views.ts:753-938` is the authority; a field added
 * there without adding it here silently shrinks this audit.
 */
const IRIS_SNAPSHOT_FIELDS = [
  ['chat', 'views.ts:753'], ['chatMetadata', 'views.ts:758'], ['name1', 'views.ts:760'],
  ['name2', 'views.ts:761'], ['characterId', 'views.ts:763'], ['chatId', 'views.ts:764'],
  ['characters', 'views.ts:774'], ['extensionSettings', 'views.ts:807'], ['variables', 'views.ts:809'],
  ['charWorldbooks', 'views.ts:828'], ['worldbookNames', 'views.ts:844'], ['scriptButtons', 'views.ts:874'],
  ['lorebookSettings', 'views.ts:888'], ['storage', 'views.ts:897'], ['floor', 'views.ts:925'],
  ['variableLayers', 'views.ts:931'],
]

/** Iris-own names on the facade that no upstream context carries (DEVIATIONS §9). */
const IRIS_OWN = new Set(['setVariables', 'swipeTo', 'charWorldbooks', 'worldbookNames', 'scriptButtons',
  'lorebookSettings', 'storage', 'floor', 'variableLayers'])

/** CARD_METHODS minus OFF_ST_SURFACE, read out of card-api.ts by declaration text. */
function extractCardApi() {
  const source = readFileSync(`${ROOT}apps/iris-web/src/sandbox/card-api.ts`, 'utf8')
  const block = (marker) => {
    const at = source.indexOf(marker)
    const end = source.indexOf('\n}', at)
    return source.slice(at, end)
  }
  const methods = [...block('export const CARD_METHODS').matchAll(/^  ([A-Za-z][\w]*):/gm)].map(m => m[1])
  const off = [...block('export const OFF_ST_SURFACE').matchAll(/'([A-Za-z][\w]*)',/g)].map(m => m[1])
  return { methods, off }
}
const { methods: CARD_METHOD_KEYS, off: OFF_ST_SURFACE } = extractCardApi()
const ST_SURFACE_ACTIONS = CARD_METHOD_KEYS.filter(name => !OFF_ST_SURFACE.includes(name))

/** The effective set of names `SillyTavern.getContext()` answers in Iris. */
const IRIS_PRESENT = new Set([
  ...IRIS_PROXY_NAMES.map(([name]) => name),
  ...ST_SURFACE_ACTIONS,
  ...IRIS_SNAPSHOT_FIELDS.map(([name]) => name),
])

// --- the parent face ---------------------------------------------------------

/**
 * What the virtual parent answers (`frame.ts` virtualParent `get` trap), by
 * branch. `published` names — `Mvu` and friends — are per-card runtime
 * publishes, not a fixed surface, so they are not listed here.
 */
const PARENT_BRIDGED = new Set([
  'document',            // frame.ts:1101 → virtual-document.ts
  'innerWidth', 'innerHeight',          // frame.ts:1102-1103
  'SillyTavern',         // frame.ts:1107
  'extension_settings',  // frame.ts:1108
  'TavernHelper',        // frame.ts:1116
  'eventSource', 'event_types',        // frame.ts:1117-1118
  'addEventListener', 'removeEventListener', 'dispatchEvent', // frame.ts:1126-1128
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', // frame.ts:64-71
  'requestAnimationFrame', 'cancelAnimationFrame',
  'EjsTemplate',         // frame.ts:1158
  'is_send_press',       // frame.ts:1186
  '$', 'jQuery',         // frame.ts:1188
  'postMessage',         // frame.ts:1167 (parent-messages.ts)
  // Not a proxy branch, but present on the virtual parent all the same: the
  // frame's MVU boot publishes `Mvu` into the shared bag (frame.ts:2766) and
  // the parent proxy hands published names back (frame.ts:1193).
  'Mvu',
])

/**
 * What `parent.document` — the virtual document — answers (`virtual-document.ts`).
 * A second-hop read (`parent.document.body`, or `_pd.body` where `_pd` is a
 * local alias for `parent.document`) lands here, not on the parent proxy, so
 * these names are bridged too even though the first-hop table above lacks them.
 */
const DOCUMENT_PROVIDED = new Set([
  'body', 'head', 'documentElement', 'getElementById', 'querySelector', 'querySelectorAll',
  'getElementsByTagName', 'createElement', 'createTextNode', 'createDocumentFragment',
  'addEventListener', 'removeEventListener', 'dispatchEvent',   // virtual-document.ts:301-311
  'readyState', 'visibilityState', 'hidden', 'title', 'URL', 'documentURI',  // :334-369
  'characterSet', 'charset', 'compatMode', 'nodeType', 'referrer',           // :371-389
])

// --- the bare-globals face ---------------------------------------------------

/** Upstream seeds these into every script frame (`preset-globals.ts:71-104`). */
const EXPECTED_GLOBALS = ['$', 'jQuery', '_', 'z', 'YAML', 'showdown', 'toastr', 'EjsTemplate', 'Vue', 'VueRouter']

/**
 * Library names the wider card ecosystem reaches for, whether or not either
 * side provides them. `EXPECTED_GLOBALS` is what upstream's Tavern Helper
 * seeds into every script frame (`preset-globals.ts:71-104`,
 * `predefine.js:1-11`); `PAGE_SHIMS` is what SillyTavern itself shims onto the
 * host page for "old extensions" (`public/lib.js:29-88`, `initLibraryShims`),
 * which is exactly the pool a `window.parent.X` walk lands in. Candidates
 * beyond both are names the ecosystem is known to reach for.
 */
const PAGE_SHIMS = ['Fuse', 'DOMPurify', 'hljs', 'localforage', 'Handlebars', 'diff_match_patch',
  'SVGInject', 'showdown', 'moment', 'Popper', 'droll']

const BARE_CANDIDATES = [
  ...EXPECTED_GLOBALS, 'Mvu', ...PAGE_SHIMS,
  'Split', 'SplitType', 'd3', 'dayjs', 'Chart', 'ChartJs',
  'marked', 'Ace', 'CodeMirror',
  'nunjucks', 'swal', 'iziToast', 'bootstrap', 'gsap', 'anime',
  'THREE', 'PIXI', 'Tone', 'Howl', 'Select2', 'Pace',
]

// ---------------------------------------------------------------------------
// 4. The corpus — three populations, as th-member-census.mjs
// ---------------------------------------------------------------------------

const { decodeCardPng } = await import('../packages/iris-character/src/index.ts')
const { extractScripts } = await import('../packages/iris-script/src/index.ts')
const { parseChatFile } = await import('../packages/iris-persistence/src/index.ts')
const { PLACEMENT, applyRegexScripts, orderScripts } = await import('../packages/iris-regex/src/index.ts')

/** @type {{card: string, origin: string, code: string}[]} */
const sources = []
const seenHash = new Set()

function addSource(card, origin, code) {
  const key = createHash('sha1').update(card).update('\u0000').update(code).digest('hex')
  if (seenHash.has(key)) return
  seenHash.add(key)
  sources.push({ card, origin, code })
}

function scanCardFile(path, cardLabel) {
  let card
  try { card = decodeCardPng(readFileSync(path)) } catch { return false }
  const name = String(card?.data?.name ?? cardLabel)
  for (const script of extractScripts(card).scripts) {
    addSource(name, `script:${script.name}`, script.content)
  }
  // The interface text the card ships, whether or not a corpus chat happened
  // to render it: `th-member-census.mjs` reads only *rendered* interfaces
  // because it asks what ran; this audit asks what a card *reaches for*, and
  // the 魔法少女的扣扣审判1.0 family (`top.saveChat`, `top.reloadCurrentChat`,
  // …) lives in a display regex whose chat is not in the corpus. Counting
  // only rendered interfaces would report the family as absent.
  for (const regex of (card?.data?.extensions?.regex_scripts ?? [])) {
    const text = String(regex?.replaceString ?? '')
    if (text.length === 0) continue
    addSource(name, `regex:${String(regex?.scriptName ?? regex?.name ?? '?')}`, text)
  }
  return true
}

function scanCardDir(dir) {
  let scanned = 0
  if (!existsSync(dir)) return scanned
  for (const file of readdirSync(dir).filter(f => f.toLowerCase().endsWith('.png'))) {
    if (scanCardFile(join(dir, file), file)) scanned++
  }
  return scanned
}

const eCards = scanCardDir(E_CORPUS)
const repoCards = scanCardDir(REPO_CORPUS)

// rendered interfaces, deduplicated per card, from the E: chats
let interfaceCount = 0
const seenRendered = new Set()
if (existsSync(E_CHATS)) {
  const cardFor = dir => {
    for (const base of [E_CORPUS, REPO_CORPUS]) {
      for (const candidate of [dir, dir.replace(/\d+$/, '')]) {
        const path = join(base, `${candidate}.png`)
        if (existsSync(path)) {
          try { return { card: decodeCardPng(readFileSync(path)), file: `${candidate}.png` } } catch { return undefined }
        }
      }
    }
    return undefined
  }
  for (const dir of readdirSync(E_CHATS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const resolved = cardFor(dir.name)
    if (!resolved) continue
    const cardFile = resolved.file
    const scripts = orderScripts((resolved.card?.data?.extensions?.regex_scripts ?? []).map(script => ({ script, type: 'character' })))
    if (scripts.length === 0) continue
    for (const file of readdirSync(join(E_CHATS, dir.name))) {
      if (!file.endsWith('.jsonl')) continue
      let chat
      try { chat = parseChatFile(readFileSync(join(E_CHATS, dir.name, file), 'utf8')) } catch { continue }
      chat.messages.forEach((message, index) => {
        const depth = chat.messages.length - 1 - index
        const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0
        const raw = Array.isArray(message.swipes) && message.swipes.length > 0
          ? String(message.swipes[swipeId] ?? message.mes ?? '')
          : String(message.mes ?? '')
        const rendered = applyRegexScripts(raw, message.is_user ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT, scripts, { isMarkdown: true, depth })
        for (const match of rendered.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
          const code = match[1] ?? ''
          if (code.trim().length === 0) continue
          const key = `${cardFile}\u0000${code}`
          if (seenRendered.has(key)) continue
          seenRendered.add(key)
          interfaceCount++
          addSource(String(resolved.card?.data?.name ?? cardFile), 'rendered-interface', code)
        }
      })
    }
  }
}

// sample cards
let sampleCards = 0
if (existsSync(SAMPLE)) {
  for (const file of readdirSync(SAMPLE).filter(f => f.toLowerCase().endsWith('.png'))) {
    if (scanCardFile(join(SAMPLE, file), file)) sampleCards++
  }
  for (const file of readdirSync(SAMPLE).filter(f => f.toLowerCase().endsWith('.json'))) {
    try {
      const card = (await import('../packages/iris-character/src/index.ts')).normalizeCard(
        JSON.parse(readFileSync(join(SAMPLE, file), 'utf8')),
      )
      const name = String(card?.data?.name ?? file)
      for (const script of extractScripts(card).scripts) addSource(name, `script:${script.name}`, script.content)
      for (const regex of (card?.data?.extensions?.regex_scripts ?? [])) {
        const text = String(regex?.replaceString ?? '')
        for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
          addSource(name, 'rendered-interface', match[1] ?? '')
        }
      }
      sampleCards++
    } catch { /* not a card json */ }
  }
}

// ---------------------------------------------------------------------------
// 5. Detectors
// ---------------------------------------------------------------------------

/** Cards whose name repeats across corpora are one card; the map keys on name. */

/**
 * The window hops a card takes out of its frame — `th-member-census.mjs`'s
 * chain, reused so the two calipers agree on what a "route out" is.
 */
const WINDOW_CHAIN = '((?:window|parent|top|self|globalThis)\\s*(?:\\?\\s*\\.\\s*)?\\.)'

/**
 * getContext() member reads.
 *
 * Matches three shapes:
 *   a. `<chain>SillyTavern.getContext()<anything>.X`   — direct chained read
 *   b. `<alias> = <chain>(SillyTavern.)?getContext()`  — alias, remembered
 *   c. `<alias>.X` / `<alias>?.X` / `<alias>['X']`     — a use of a seen alias
 * plus the bare-call variant of (a)/(b) with no `SillyTavern.` prefix.
 */
const ALIAS_DECL = new RegExp(
  `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::\\s*[\\w<>[\\]|.\\s]+)?=\\s*[^;\\n]*?${WINDOW_CHAIN}?\\s*(?:SillyTavern\\s*\\.\\s*)?getContext\\s*\\(\\s*\\)`,
  'g',
)
const CHAINED_READ = new RegExp(
  `${WINDOW_CHAIN}?\\s*(?:SillyTavern\\s*\\.\\s*)?getContext\\s*\\(\\s*\\)\\s*(?:\\?\\.)?\\.\\s*([A-Za-z_$][\\w$]*)`,
  'g',
)
const ALIAS_USE = alias => new RegExp(
  `(^|[^A-Za-z0-9_$.'"])${alias.replace(/\$/g, '\\$')}\\s*(?:\\?\\.)?(?:\\.\\s*([A-Za-z_$][\\w$]*)|\\[\\s*['"]([A-Za-z_$][\\w$]*)['"]\\s*\\])`,
  'g',
)

/**
 * Direct member reads off the `SillyTavern` global — the same 145-key surface
 * by another route (`card-api.ts`: "Two shapes the corpus uses: getContext()
 * and direct member reads off the global"). Counted per member so a face-1
 * member can show both routes.
 */
const GLOBAL_MEMBER_READ = new RegExp(
  `${WINDOW_CHAIN}?\\s*SillyTavern\\s*(?:\\?\\.)?\\.\\s*([A-Za-z_$][\\w$]*)`,
  'g',
)

/**
 * Parent-face reads: `(window.)?(parent|top).X`, and the two known local-alias
 * shapes flagged rather than silently counted (`_pw.`/`_pd.` are 银麒赎世's own
 * spellings of parent/parent.document).
 */
const PARENT_READ = /(^|[^\w$.'"])(?:window\s*\.\s*)?(parent|top)\s*(?:\?\.)?\.\s*([A-Za-z_$][\w$]*)/g
const PARENT_ALIAS_DECL = /(?:const|let|var)\s+(_pw|_pd|pw|pd|parentWindow|hostWindow|hostDoc)\s*=\s*[^;\n]*(?:parent|top)(?:\s*\.\s*(?:document))?\b/g

/**
 * Bare-global use of `name`: unqualified, not a property read (`foo.NAME`),
 * not inside an identifier, and not a template-literal `${`.
 * @param {string} name
 */
function bareUsePattern(name) {
  const escaped = name.replace(/\$/g, '\\$')
  return new RegExp(`(^|[^\\w$.'])${escaped}(?!\\s*\\w)(?!\\{)`, 'g')
}

/** A property read `X.NAME` off the bare global (e.g. `_.map`, `toastr.success`). */
function memberUsePattern(name) {
  const escaped = name.replace(/\$/g, '\\$')
  return new RegExp(`(^|[^\\w$])${escaped}\\s*\\.\\s*[A-Za-z_$][\\w$]*`, 'g')
}

/** First line number + trimmed line of the nth match, for the evidence column. */
function evidenceOf(code, pattern) {
  /*
   * `exec` on a g-flagged regex advances lastIndex, and `matchAll` starts from
   * the original's lastIndex — so sharing one global regex between the count
   * loop and this evidence read let a stale index silently swallow the next
   * source's matches (the 魔法少女的扣扣审判 family vanished exactly this way).
   * Always scan from 0.
   */
  pattern.lastIndex = 0
  const m = pattern.exec(code)
  pattern.lastIndex = 0
  if (m === null) return ''
  const before = code.slice(0, m.index)
  const line = before.split('\n').length
  const text = code.split('\n')[line - 1]?.trim() ?? ''
  return `L${line}: ${text.slice(0, 110)}`
}

// ---------------------------------------------------------------------------
// 6. Scan every source against every face
// ---------------------------------------------------------------------------

/** face → member → {cards:Set, sites:number, origins:Set, evidence:Map<card,string>} */
function newUsage() { return new Map() }
const ctxUsage = newUsage()
const parentUsage = newUsage()
const bareUsage = newUsage()

const bump = (usage, name, source, evidence) => {
  let entry = usage.get(name)
  if (entry === undefined) { entry = { cards: new Set(), sites: 0, origins: new Set(), evidence: new Map() }; usage.set(name, entry) }
  entry.sites++
  entry.cards.add(source.card)
  entry.origins.add(source.origin.split(':')[0])
  if (!entry.evidence.has(source.card)) entry.evidence.set(source.card, evidence)
}

// parent aliases seen per source, so `_pw.$` counts as a parent read
const parentAliasNames = ['_pw', '_pd', 'pw', 'pd', 'parentWindow', 'hostWindow', 'hostDoc']

for (const source of sources) {
  const code = source.code

  // (b) remember the aliases this body declares — an alias is counted only
  // when its declaration reads a **zero-argument** getContext(); a canvas's
  // `ctx = canvas.getContext('2d')` takes an argument and is not this face.
  const aliases = new Set()
  for (const m of code.matchAll(ALIAS_DECL)) aliases.add(m[1])

  // (a) chained reads
  for (const m of code.matchAll(CHAINED_READ)) {
    bump(ctxUsage, m[2], source, evidenceOf(code, new RegExp(`${WINDOW_CHAIN}?\\s*(?:SillyTavern\\s*\\.\\s*)?getContext\\s*\\(\\s*\\)\\s*(?:\\?\\.)?\\.\\s*${m[2]}\\b`)))
  }
  // (c) alias uses — count every distinct member each alias touches, with
  // evidence line taken from the member's own match, not the alias's first use
  for (const alias of aliases) {
    const seen = new Set()
    for (const m of code.matchAll(ALIAS_USE(alias))) {
      const name = m[2] ?? m[3]
      if (name === undefined || seen.has(name)) continue
      seen.add(name)
      const memberPattern = new RegExp(
        `(^|[^A-Za-z0-9_$.'"])${alias.replace(/\$/g, '\\$')}\\s*(?:\\?\\.)?(?:\\.\\s*${name}\\b|\\[\\s*['"]${name}\\b)`,
      )
      bump(ctxUsage, name, source, evidenceOf(code, memberPattern))
    }
  }

  // (d) direct reads off the SillyTavern global — only the names that are
  // context members; anything else is another face's business.
  const globalSeen = new Set()
  for (const m of code.matchAll(GLOBAL_MEMBER_READ)) {
    // The window-hop group is group 1 whether it participates or not, so the
    // member is always m[2].
    const name = m[2]
    if (!upstreamNames.includes(name) || globalSeen.has(name)) continue
    globalSeen.add(name)
    bump(ctxUsage, name, source, evidenceOf(code, new RegExp(`${WINDOW_CHAIN}?\\s*SillyTavern\\s*(?:\\?\\.)?\\.\\s*${name}\\b`)))
  }

  // parent face
  for (const m of code.matchAll(PARENT_READ)) {
    const name = m[3]
    // the two known false-positive shapes from TEST-CARDS §J: a local DOM node
    // or plain object named `parent` — counted, but only via their method names
    // (replaceChild etc.), which the report flags.
    bump(parentUsage, name, source, evidenceOf(code, new RegExp(`(^|[^\\w$.'"])(?:window\\s*\\.\\s*)?(?:parent|top)\\s*(?:\\?\\.)?\\.\\s*${name}\\b`)))
  }
  for (const alias of parentAliasNames) {
    if (!new RegExp(`(?:^|[^\\w$])${alias}\\s*\\.`).test(code)) continue
    const seen = new Set()
    for (const m of code.matchAll(new RegExp(`(?:^|[^\\w$.'"])${alias}\\s*(?:\\?\\.)?\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))) {
      const name = m[1]
      if (seen.has(name)) continue
      seen.add(name)
      bump(parentUsage, name, source, evidenceOf(code, new RegExp(`${alias}\\s*\\.\\s*${name}\\b`)))
    }
  }

  // bare globals
  for (const name of BARE_CANDIDATES) {
    const bare = bareUsePattern(name)
    const member = memberUsePattern(name)
    const bareHits = [...code.matchAll(bare)].length
    const memberHits = [...code.matchAll(member)].length
    const hits = bareHits + memberHits
    if (hits === 0) continue
    // `Split`/`top`-style common words need a library-shaped use to count:
    // a call `X(…)` or a property read `X.y`. Bare mentions in comments and
    // strings are not uses. The call-shape check keeps `moment` in
    // "at the moment" from counting.
    const callOrMember = new RegExp(`(^|[^\\w$.'"])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g')
    const shaped = memberHits > 0 || [...code.matchAll(callOrMember)].length > 0
    // Applied uniformly, $ and _ included: a `$` inside a regex literal
    // (`/^\s*\d+/`) or an underscore inside a stylised name is not library use.
    if (!shaped) continue
    const pattern = memberHits > 0 ? member : bare
    bump(bareUsage, name, source, evidenceOf(code, pattern))
  }
}

// ---------------------------------------------------------------------------
// 7. Report
// ---------------------------------------------------------------------------

const cardCount = new Set(sources.map(s => s.card)).size

console.log('## corpus scanned')
console.log(`  cards decoded         ${eCards} (E:) + ${repoCards} (repo) + ${sampleCards} (sample dir)`)
console.log(`  distinct cards        ${cardCount} (keyed by card data.name, content-deduplicated)`)
console.log(`  code bodies           ${sources.length}  (scripts + ${interfaceCount} distinct rendered interfaces)`)
console.log(`  upstream context keys ${CONTEXT_KEYS.length}`)
console.log(`  Iris facade answers   ${IRIS_PRESENT.size} names (${[...IRIS_PRESENT].filter(n => CONTEXT_KEYS.some(k => k.name === n)).length} of them among the 145; ${[...IRIS_PRESENT].filter(n => IRIS_OWN.has(n)).length} Iris-own)`)
console.log('')

const sortByCards = (a, b, usage) => {
  const d = usage.get(b).cards.size - usage.get(a).cards.size
  return d !== 0 ? d : usage.get(b).sites - usage.get(a).sites
}

// --- face 1: getContext ------------------------------------------------------

console.log('\n## FACE 1 — SillyTavern.getContext() members')
const ctxNames = new Set([...ctxUsage.keys()])
const ctxUsedMissing = upstreamNames.filter(n => ctxNames.has(n) && !IRIS_PRESENT.has(n))
const ctxUsedPresent = upstreamNames.filter(n => ctxNames.has(n) && IRIS_PRESENT.has(n))
const ctxUsedNonContext = [...ctxNames].filter(n => !upstreamNames.includes(n))
const ctxPresentUnused = upstreamNames.filter(n => !ctxNames.has(n) && IRIS_PRESENT.has(n))

console.log(`  used and present : ${ctxUsedPresent.length}  — ${ctxUsedPresent.join(', ')}`)
console.log(`  used but MISSING : ${ctxUsedMissing.length}  — ${ctxUsedMissing.join(', ')}`)
console.log(`  used, not a 145-member (alias noise / host globals): ${ctxUsedNonContext.length}`)
console.log(`  present but unused in this corpus: ${ctxPresentUnused.length}`)
console.log('')

console.log('  per-member (cards / sites):')
for (const name of [...ctxNames].sort((a, b) => sortByCards(a, b, ctxUsage))) {
  const u = ctxUsage.get(name)
  const in145 = upstreamNames.includes(name)
  const state = in145 ? (IRIS_PRESENT.has(name) ? 'present' : 'MISSING') : IRIS_PRESENT.has(name) ? 'present(iris-own or host)' : 'not-a-context-member'
  const line = upstreamNames.includes(name) ? `st-context.js:${CONTEXT_KEYS[upstreamNames.indexOf(name)].line}` : ''
  console.log(`    ${String(u.cards.size).padStart(3)}  ${String(u.sites).padStart(4)}  ${name.padEnd(28)} ${state.padEnd(24)} ${line}`)
  if (verbose) for (const [card, ev] of u.evidence) console.log(`        [${card}] ${ev.replace(/\n/g, ' ')}`)
}

// per-domain rollup over the 145
console.log('\n  per-domain rollup over the 145:')
for (const [domain, names] of DOMAINS) {
  const present = names.filter(n => IRIS_PRESENT.has(n)).length
  const used = names.filter(n => ctxNames.has(n)).length
  console.log(`    ${domain.padEnd(10)} upstream ${String(names.length).padStart(3)}   iris ${String(present).padStart(3)}   used ${String(used).padStart(3)}`)
}
const misc = upstreamNames.filter(n => !domainOf.has(n))
console.log(`    ${'杂项'.padEnd(10)} upstream ${String(misc.length).padStart(3)}   iris ${String(misc.filter(n => IRIS_PRESENT.has(n)).length).padStart(3)}   used ${String(misc.filter(n => ctxNames.has(n)).length).padStart(3)}  (${misc.join(', ')})`)

// --- face 2: the host page via parent ----------------------------------------

console.log('\n## FACE 2 — host-page reads: (window.)parent.X / top.X')
const parentNames = [...parentUsage.keys()].sort((a, b) => sortByCards(a, b, parentUsage))
for (const name of parentNames) {
  const u = parentUsage.get(name)
  const state = PARENT_BRIDGED.has(name) ? 'bridged'
    : DOCUMENT_PROVIDED.has(name) ? 'bridged (via parent.document)'
    : 'NOT bridged'
  console.log(`    ${String(u.cards.size).padStart(3)}  ${String(u.sites).padStart(4)}  ${name.padEnd(28)} ${state}`)
  if (verbose) for (const [card, ev] of u.evidence) console.log(`        [${card}] ${ev.replace(/\n/g, ' ')}`)
}
// the alias declarations, so the reader knows which names are `_pw`-shaped
const aliasDecls = sources.flatMap(s => [...s.code.matchAll(PARENT_ALIAS_DECL)].map(m => `${s.card}: ${m[0].slice(0, 90)}`))
console.log(`  parent alias declarations: ${aliasDecls.length}`)
for (const line of [...new Set(aliasDecls)]) console.log(`    ${line}`)

// --- face 3: bare globals ------------------------------------------------------

console.log('\n## FACE 3 — bare library globals')
const bareNames = [...bareUsage.keys()].sort((a, b) => sortByCards(a, b, bareUsage))
for (const name of bareNames) {
  const u = bareUsage.get(name)
  const provided = EXPECTED_GLOBALS.includes(name)
    ? (name === 'toastr' ? 'provided (reporting adapter)' : 'provided')
    : 'NOT provided'
  console.log(`    ${String(u.cards.size).padStart(3)}  ${String(u.sites).padStart(4)}  ${name.padEnd(16)} ${provided}`)
  if (verbose) for (const [card, ev] of u.evidence) console.log(`        [${card}] ${ev.replace(/\n/g, ' ')}`)
}

// --- gap summary ---------------------------------------------------------------

console.log('\n## GAP SUMMARY')
console.log(`  getContext face: used-but-missing ${ctxUsedMissing.length}, used-and-present ${ctxUsedPresent.length}, present-but-unused ${ctxPresentUnused.length}`)
/*
 * `replaceChild` (【Sgw】又看一集) and `__list` (萧谴写卡助手版) are the two
 * measured LOCAL-variable false positives — a DOM node and a plain object that
 * happen to be named `parent` (TEST-CARDS §J). They are excluded from the gap
 * summary but stay in the table, flagged.
 */
const PARENT_FALSE_POSITIVES = ['replaceChild', '__list']
const parentMissing = parentNames.filter(n => !PARENT_BRIDGED.has(n) && !DOCUMENT_PROVIDED.has(n)
  && !PARENT_FALSE_POSITIVES.includes(n))
console.log(`  parent face: names read ${parentNames.length}, not bridged ${parentMissing.length} — ${parentMissing.join(', ')}`)
const bareMissing = bareNames.filter(n => !EXPECTED_GLOBALS.includes(n) && n !== 'Mvu')
console.log(`  bare face: names used ${bareNames.length}, not provided ${bareMissing.length} — ${bareMissing.join(', ')}`)
