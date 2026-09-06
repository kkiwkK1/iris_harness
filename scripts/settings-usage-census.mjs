/**
 * How much of SillyTavern's settings surface does a real user actually use?
 *
 *   node scripts/settings-usage-census.mjs
 *   node scripts/settings-usage-census.mjs --verbose   # every changed leaf
 *
 * Skips when the corpus is absent. Always exits 0: a caliper, not a test.
 * The findings this produced, and the design decisions they support, are in
 * `docs/SETTINGS.md`.
 *
 * ## THIS CALIPER IS BRITTLE, AND THE OTHERS ARE NOT
 *
 * Every other census in this directory reads a **data format** — card PNGs, chat
 * JSONL, world books. Those formats are the thing upstream must keep stable for
 * its own users, so a caliper built on them keeps working.
 *
 * This one reads **source structure**: it locates two object literals by their
 * declaration text in `public/scripts/openai.js` and `public/scripts/power-user.js`
 * and evaluates them. A refactor upstream — renaming `default_settings`, splitting
 * the literal, moving it to another module — breaks it. It will say so rather
 * than produce a wrong number (the marker lookup throws), but it will stop
 * answering.
 *
 * **When it breaks:** the conclusions already recorded in `docs/SETTINGS.md` do not
 * expire — they were true of the version measured. But **no new number may be
 * quoted from this script until the extraction has been repaired and re-run.**
 * A half-working extractor is the one outcome to refuse: it would silently
 * baseline against fewer keys and report everything else as user-changed.
 *
 * ## Why the shipped default file is not the baseline
 *
 * `default/content/settings.json` has 347 leaves; a profile that has been saved
 * once has 865, because SillyTavern persists its in-memory defaults on first
 * save. Diffing against the file reports ~233 "user-created" keys the user never
 * touched. The real defaults are the two source literals above.
 *
 * Those literals reference constants (`max_4k`, `tokenizers.BEST_MATCH`, a
 * `getComputedStyle` call). They are evaluated in a `vm` whose global is a Proxy
 * returning a chainable sentinel for any free identifier; a value that resolves
 * to a sentinel is reported **unadjudicable** — never changed, never unchanged.
 *
 * ## Scope
 *
 * Provider namespaces for APIs the profile does not use are excluded: there is
 * no source baseline for them here, and with `main_api` set elsewhere every
 * difference in them is a persisted default rather than a user act. Session
 * state is excluded because it is not a setting. `secrets.json` is never read.
 *
 * @module scripts/settings-usage-census
 */
import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'

const ST = process.env.IRIS_CORPUS ?? 'E:/sillyTavern/SillyTavern'
if (!existsSync(`${ST}/data/default-user/settings.json`)) {
  console.log('settings-usage-census: skipped — no local SillyTavern profile at')
  console.log(`  ${ST}/data/default-user/settings.json`)
  console.log('Expected on any machine but the operator machine. Set IRIS_CORPUS to point elsewhere.')
  process.exit(0)
}

const live = JSON.parse(readFileSync(`${ST}/data/default-user/settings.json`, 'utf8'))
const shipped = JSON.parse(readFileSync(`${ST}/default/content/settings.json`, 'utf8'))

const SENTINEL = '\u0000UNRESOLVED\u0000'

/** Pull one object literal out of a source file by matching braces. */
function literalAfter(source, marker) {
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`marker not found: ${marker}`)
  const open = source.indexOf('{', start)
  let depth = 0, inString = null, escaped = false
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inString = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return source.slice(open, i + 1) }
  }
  throw new Error('unbalanced literal')
}

/** Evaluate a literal with every free identifier resolving to a sentinel. */
function evaluateLiteral(literal) {
  const handler = {
    has: () => true,
    get: (_t, key) => {
      if (key === Symbol.unscopables) return undefined
      // Any referenced constant becomes a sentinel object that survives member access.
      // Stays chainable: property access and calls both yield another sentinel,
      // and it only collapses to a string at primitive conversion. Collapsing
      // earlier makes `a(b).c()` throw instead of resolving.
      const make = () => new Proxy(function () {}, {
        get: (_t2, k2) => (
          k2 === Symbol.toPrimitive || k2 === 'toString' || k2 === 'valueOf'
            ? () => SENTINEL
            : make()
        ),
        apply: () => make(),
      })
      return key === 'String' || key === 'Number' || key === 'Boolean' ? globalThis[key] : make()
    },
  }
  const context = vm.createContext(new Proxy({}, handler))
  return vm.runInContext(`(${literal})`, context)
}

const openaiSource = readFileSync(`${ST}/public/scripts/openai.js`, 'utf8')
const powerSource = readFileSync(`${ST}/public/scripts/power-user.js`, 'utf8')
const oaiDefaults = evaluateLiteral(literalAfter(openaiSource, 'const default_settings = {'))
const powerDefaults = evaluateLiteral(literalAfter(powerSource, 'export const power_user = {'))

/** The baseline: shipped file, overlaid with the two source namespaces. */
const baseline = {
  ...shipped,
  oai_settings: { ...(shipped.oai_settings ?? {}), ...oaiDefaults },
  power_user: { ...(shipped.power_user ?? {}), ...powerDefaults },
}

const isObject = v =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isSentinel = v => {
  if (typeof v === 'function') return true
  try { return String(v) === SENTINEL } catch { return false }
}

/** @typedef {{path: string, live: unknown, base: unknown, kind: 'changed'|'only-live'|'unadjudicable'}} Leaf */
/** @type {Leaf[]} */
const leaves = []

function walk(a, b, path) {
  if (isObject(a) && isObject(b) && !isSentinel(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      walk(key in a ? a[key] : undefined, key in b ? b[key] : undefined, path ? `${path}.${key}` : key)
    }
    return
  }
  if (a === undefined) return                       // only in the baseline: not a user act
  if (isSentinel(b)) { leaves.push({ path, live: a, base: b, kind: 'unadjudicable' }); return }
  if (b === undefined) { leaves.push({ path, live: a, base: b, kind: 'only-live' }); return }
  if (JSON.stringify(a) !== JSON.stringify(b)) leaves.push({ path, live: a, base: b, kind: 'changed' })
}
walk(live, baseline, '')

/**
 * Namespaces excluded from the "did the user change this" question, and why.
 *
 * Provider namespaces for APIs this profile does not use have no source
 * baseline here, and `main_api` is `openai`, so every difference in them is a
 * persisted in-memory default rather than a user act. Session state is not a
 * setting at all.
 */
const OUT_OF_SCOPE = new Set([
  'extension_settings', 'textgenerationwebui_settings', 'nai_settings', 'kai_settings',
  'horde_settings', 'accountStorage', 'tag_map', 'tags', 'background', 'active_character',
  'active_group', 'selected_proxy', 'proxies', 'currentVersion', 'firstRun',
])
const core = leaves.filter(l => !OUT_OF_SCOPE.has(l.path.split('.')[0] ?? l.path))
const changed = core.filter(l => l.kind === 'changed')
const onlyLive = core.filter(l => l.kind === 'only-live')
const unadjudicable = core.filter(l => l.kind === 'unadjudicable')

function countLeaves(value) {
  if (isSentinel(value)) return 1
  if (isObject(value)) return Object.values(value).reduce((s, v) => s + countLeaves(v), 0)
  return 1
}
const exposed = countLeaves(Object.fromEntries(Object.entries(baseline).filter(([k]) => k !== 'extension_settings')))

console.log('## baseline check')
console.log(`  shipped default file leaves     ${countLeaves(shipped)}`)
console.log(`  + source defaults overlaid      oai_settings ${Object.keys(oaiDefaults).length} keys, power_user ${Object.keys(powerDefaults).length} keys`)
console.log(`  baseline leaves (core)          ${exposed}`)
console.log(`  live file leaves                ${countLeaves(live)}`)

console.log('\n## exposed vs actually changed')
console.log(`  changed from a known default    ${changed.length}`)
console.log(`  present live, absent in baseline ${onlyLive.length}`)
console.log(`  default is a source constant — cannot adjudicate ${unadjudicable.length}`)
console.log(`  → deliberately-changed share of the adjudicable core surface: ` +
  `${(changed.length / Math.max(1, exposed - unadjudicable.length) * 100).toFixed(1)}%`)

/** Group a path by the question a user would be asking. */
function group(path) {
  const p = path.replace(/^oai_settings\.|^power_user\./, '')
  if (/^(allow_name|mesIDDisplay|fuzzy_search|charListGrid|show_|hide|sort|zoomed|hotswap|timestamp|timer|compact|click_to_edit|noShadows|fast_ui|blur|shadow|font|chat_width|avatar_style|theme|background|movingUI|custom_css|toastr|waifu|expand|message_token|markdown|render|smooth_streaming|streaming_fps|swipe|gestures|auto_scroll|chat_truncation|reduced_motion|visual_novel|main_text|italics|quote|bold|underline|user_name_color|bogus_folders|aux_field|lorebook_preview|enableZenSliders|enableLabMode)/.test(p)) return 'appearance / reading'
  if (/^(reasoning|experimental_macro|auto_|token_padding|tokenizer|continue_|trim_spaces|regex|stscript|quick_reply|hotkey|confirm_|spoiler|restore_user_input|forbid_external|encode_tags|disable_|never_resize|max_context_unlocked|console_log|request_token_probabilities)/.test(p)) return 'behaviour / automation'
  if (/^(temp|top_p|top_k|top_a|min_p|rep_pen|repetition|typical|tfs|freq_pen|pres_pen|frequency|presence|mirostat|dynatemp|smoothing|epsilon|eta|penalty|seed|n_|nsigma|xtc_|dry_|sampler|banned|logit)/.test(p)) return 'sampling / randomness'
  if (/^(prompts|prompt_order|impersonation_prompt|new_chat|new_group|new_example|continue_nudge|group_nudge|wi_format|scenario_format|personality_format|send_if_empty|bias_preset|main_prompt|nsfw|jailbreak|assistant_|human_|claude_|squash|names_behavior|character_names)/.test(p)) return 'prompt assembly'
  if (/^(context|instruct|sysprompt|custom_stopping|collapse_newlines|trim_sentences|pin_examples|strip_examples|always_force|single_line|example_messages)/.test(p)) return 'formatting templates'
  if (/^(openai_max|max_context|max_tokens|chat_completion_source|reverse_proxy|proxy|custom_url|api|model|stream|preset_settings|show_external|use_|windowai|openrouter|claude_model|mistral|cohere|google|vertexai|groq|deepseek|xai|pollinations|electronhub|moonshot|fireworks|cometapi|azure|custom_include|custom_exclude|custom_prompt_post)/.test(p)) return 'connection / model'
  if (/^(world_info|wi_)/.test(p)) return 'world info'
  if (/^(persona|user_avatar|username|personas|default_persona)/.test(p)) return 'persona'
  if (/^(theme|background|font|blur|chat_width|avatar_style|noShadows|fast_ui|shadow|main_text|italics|quote|bold|underline|waifu|expand|zoomed|hotswap|timestamp|timer|compact|click_to_edit|charListGrid|movingUI|custom_css|toastr|ui_|message_token|markdown|render|smooth_streaming|streaming_fps|swipe|gestures|auto_scroll|chat_truncation|reduced_motion|visual_novel)/.test(p)) return 'appearance / reading'
  if (/^(auto_|token_padding|tokenizer|continue_|trim_spaces|regex|stscript|quick_reply|hotkey|confirm_|spoiler)/.test(p)) return 'behaviour / automation'
  return 'other'
}

/** @type {Map<string, Leaf[]>} */
const byGroup = new Map()
for (const leaf of [...changed, ...onlyLive]) {
  const g = group(leaf.path)
  byGroup.set(g, [...(byGroup.get(g) ?? []), leaf])
}

console.log('\n## grouped by "what did you want to change"')
for (const [name, list] of [...byGroup].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(list.length).padStart(3)}  ${name}`)
}

console.log('\n## the actual changes, by group')
for (const [name, list] of [...byGroup].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n  ── ${name} (${list.length})`)
  for (const leaf of list.slice(0, 12)) {
    const show = v => {
      if (v === undefined) return '(absent)'
      const s = JSON.stringify(v) ?? String(v)
      return s.length > 40 ? `${s.slice(0, 40)}…` : s
    }
    console.log(`     ${leaf.path.padEnd(46)} ${show(leaf.base)} → ${show(leaf.live)}`)
  }
  if (list.length > 12) console.log(`     … ${list.length - 12} more`)
}
