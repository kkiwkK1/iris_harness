/**
 * Where a chat's regex scripts run.
 *
 * Three directions, and they are mutually exclusive by design: a script marked
 * display-only rewrites what the reader sees, a prompt-only script rewrites what
 * the model sees, and a script marked neither rewrites the message as it is
 * stored — which is why the stored form is never rewritten again at render or
 * send time. Getting that wrong applies a script twice.
 *
 * This is not cosmetic. An MVU card ships exactly two scripts, and without them
 * the chat shows raw `<UpdateVariable>` blocks *and* the model reads back its
 * own command blocks from every earlier turn, which poisons the rest of the
 * conversation. The display direction in particular belongs to the host: the
 * browser receives a `ChatView` that is already clean, so the regex engine
 * exists in one place rather than two that can disagree.
 *
 * @module @iris/app-service/regex
 */

import { createHash } from 'node:crypto'

import type { CharacterCard } from '@iris/character'
import { createMacroContext, toRegexSubstitute, type MacroVariableStore } from '@iris/macro'
import type { TavernRegexSource, TavernRegexView, ViewRole } from '@iris/protocol'
import {
  applyRegexScripts,
  orderScripts,
  PLACEMENT,
  SCRIPT_TYPE,
  SUBSTITUTE,
  type MacroSubstitute,
  type OwnedScript,
  type Placement,
  type RegexScript,
} from '@iris/regex'

/**
 * Which placement a message's text belongs to.
 * @param role - the speaker.
 * @returns the placement scripts are matched against.
 */
export function placementFor(role: ViewRole): Placement {
  return role === 'user' ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT
}

/**
 * The user's decisions about one card's own regex tier.
 *
 * Two switches, for the same reason a card script has two: the card author's
 * `disabled` is a fact about the card and travels with it through export and
 * re-import, and the user's is a decision about this installation. Fusing them
 * would let a re-import quietly revive a rule the user had turned off.
 */
export interface ScopedRegexPolicy {
  /**
   * Whether the card's own tier may run at all — upstream's
   * `extension_settings.character_allowed_regex` (`engine.js:115,167`), a flat
   * list of avatar filenames there and a per-character record here.
   */
  allowed: boolean
  /**
   * The user's own per-script switches, by the script's `id`.
   *
   * A present key wins over the card's `disabled`, in both directions: `false`
   * switches off a rule the card shipped on, and `true` switches on one the
   * card shipped off. A missing key means the card decides, which is what
   * makes a fresh import behave as its author meant.
   */
  enabled: Readonly<Record<string, boolean>>
}

/**
 * The user's decisions about the **active preset's** own regex tier.
 *
 * The same two switches as {@link ScopedRegexPolicy} over a different subject,
 * and **the defaults are mirror images**: a card's tier is allowed until the
 * user refuses it, and a preset's is refused until the user allows it. That is
 * not an inconsistency to be tidied away — it is the whole ruling of
 * `notes/packages/iris-app-service/DEVIATIONS.md` §53. A card is a document
 * someone chose to play and its rules mostly hide the card's own bookkeeping
 * from the reader; a preset is a settings file people pass around by the
 * dozen, and the one measured here carries **eighteen live rules, six of them
 * rewriting the request**. Importing a preset must not silently acquire those.
 */
export interface PresetRegexPolicy {
  /**
   * Whether this preset's own tier may run at all — upstream's
   * `extension_settings.preset_allowed_regex[api]`, a list of preset **names**
   * (`extensions/regex/engine.js:126-128`, `getRegexedString` at `:346` being
   * the one caller that passes `allowedOnly: true`).
   *
   * Absent from the store means `false`, which **is** upstream's default here —
   * unlike the scoped tier, where this host deliberately diverges.
   */
  allowed: boolean
  /**
   * The user's own per-rule switches, by the rule's `id`.
   *
   * Read exactly as {@link ScopedRegexPolicy.enabled} is, including the
   * "unnamed rule keeps the file's word" rule — and it bites harder here,
   * because a preset's rules are written by a preset author with no importer
   * minting ids on the way in.
   */
  enabled: Readonly<Record<string, boolean>>
}

/**
 * The active preset's tier as the composer takes it: the rules and the gate.
 *
 * Kept as one object rather than two parameters because the gate is only
 * meaningful about *these* rules — a call site holding the rules of one preset
 * and the permission of another is the failure this shape refuses to spell.
 */
export interface PresetRegexTier {
  /** The preset the rules came out of — the name the allow-list is keyed by. */
  presetName: string
  /** The rules, in the preset's own order, malformed ones already dropped. */
  scripts: readonly RegexScript[]
  /** The user's decisions about them. */
  policy: PresetRegexPolicy
  /** How many rows {@link readPresetRegex} refused; see it for why it is reported. */
  malformed: number
}

/**
 * Read a preset body's own regex tier.
 *
 * Upstream's third tier: `presetManager.readPresetExtensionField({ path:
 * 'regex_scripts' })` (`extensions/regex/engine.js:126`) — the active preset
 * file's `extensions.regex_scripts`. This host stores the switched-in preset
 * body whole, `extensions` included, so the field is simply there to read.
 *
 * **Malformed rows are dropped and counted, not repaired and not passed on.**
 * Two of the 40 rules in the measured preset are UI separators carrying an
 * empty `findRegex` with `disabled: false`, and an empty pattern is not a
 * harmless no-op: `new RegExp('')` matches at every position, so running one
 * would splice its `replaceString` between every character of every message.
 * The count is returned rather than logged here because a reader has to be able
 * to see it — a silent drop and a preset with two fewer rules look identical,
 * and the panel says the number beside the rules it did keep.
 * @param body - the preset body, or anything at all.
 * @returns the runnable rules in the preset's order, and how many were refused.
 */
export function readPresetRegex(body: unknown): { scripts: RegexScript[], malformed: number } {
  const listed = presetRegexField(body)
  const scripts: RegexScript[] = []
  let malformed = 0
  for (const row of listed) {
    if (runnableRule(row)) scripts.push(row)
    else malformed += 1
  }
  return { scripts, malformed }
}

/** A preset body's `extensions.regex_scripts`, as a list of unknowns. */
function presetRegexField(body: unknown): readonly unknown[] {
  if (typeof body !== 'object' || body === null) return []
  const extensions = (body as { extensions?: unknown }).extensions
  if (typeof extensions !== 'object' || extensions === null) return []
  const listed = (extensions as { regex_scripts?: unknown }).regex_scripts
  return Array.isArray(listed) ? listed : []
}

/**
 * Whether a row is a rule the engine can actually run.
 *
 * `findRegex` and `replaceString` are what every run reads, and an **empty**
 * pattern is refused as well as an absent one — see {@link readPresetRegex} for
 * what an empty one would do to a message.
 * @param row - one row of the stored list.
 * @returns whether it is a rule.
 */
function runnableRule(row: unknown): row is RegexScript {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false
  const candidate = row as { findRegex?: unknown, replaceString?: unknown }
  return typeof candidate.findRegex === 'string' && candidate.findRegex !== ''
    && typeof candidate.replaceString === 'string'
}

/**
 * Compose the active preset's tier, with the gate and the switches read.
 *
 * One function for both readers — the composer that hands the tier to a
 * conversation, and the panel that lists it — because the alternative is two
 * places deciding what "the active preset" is, and they would disagree the day
 * one of them was changed. Both are handed the *persisted* selection
 * (`settings.json`'s `preset` section), which every switch, save, delete and
 * manager edit writes through before it returns.
 *
 * **No name means no tier.** The allow-list is keyed by the preset's library
 * name, so a body that has none — a host still assembling with the file its
 * composition configured, which upstream cannot even represent — cannot be
 * allow-listed, and a tier that could never be permitted is not one this host
 * pretends to offer.
 * @param active - the persisted selection: its library name, if it has one, and
 *   its body.
 * @param policyOf - the user's decisions for a named preset.
 * @returns the tier, or undefined when there is no named active preset.
 */
export async function presetRegexTier(
  active: { name: string | undefined, body: unknown } | undefined,
  policyOf: (presetName: string) => Promise<PresetRegexPolicy>,
): Promise<PresetRegexTier | undefined> {
  const presetName = active?.name
  if (active === undefined || presetName === undefined) return undefined
  const read = readPresetRegex(active.body)
  return {
    presetName,
    scripts: read.scripts,
    malformed: read.malformed,
    policy: await policyOf(presetName),
  }
}

/**
 * The closure a chat store reads its preset tier through.
 *
 * A factory rather than two lines at the composition, because those two lines
 * are the whole wiring of this feature: *which* reading of "the active preset"
 * the runner uses, and what happens to the rows it had to refuse. Left inline,
 * a test would have to hand-copy them — and a hand-copied seam is where the
 * production wiring can be wrong with every test green.
 * @param active - the persisted selection, read at call time. A function, not a
 *   value: which preset is active is runtime state.
 * @param policyOf - the user's decisions for a named preset.
 * @param onMalformed - told about a tier that carried rows the reader refused.
 *   Optional, and the count is on the returned tier either way — the panel is
 *   the durable channel for it, and this is for whoever reads the log.
 * @returns the closure.
 */
export function presetRegexSource(
  active: () => { name: string | undefined, body: unknown },
  policyOf: (presetName: string) => Promise<PresetRegexPolicy>,
  onMalformed?: (tier: PresetRegexTier) => void,
): () => Promise<PresetRegexTier | undefined> {
  return async () => {
    const tier = await presetRegexTier(active(), policyOf)
    // Reported whether or not the tier is allowed to run: a preset carrying two
    // rules nobody can run is a fact about the file, not about the permission,
    // and finding out about it only after switching the tier on would be
    // finding out at the worst moment.
    if (tier !== undefined && tier.malformed > 0) onMalformed?.(tier)
    return tier
  }
}

/**
 * The scripts one chat runs, in upstream's order.
 *
 * **All three tiers, since 2026-09-09.** The profile's global scripts
 * (`extension_settings.regex` upstream — the user's own, run before anything
 * else), then the active preset's own `extensions.regex_scripts`, then the
 * character's. That is upstream's iteration order and not its numbering; see
 * `@iris/regex`'s `TIER_ORDER` and §35 of the host ledger for the correction
 * that got it right *before* there was a preset tier to observe it with.
 *
 * Stable within a tier, so a card's own scripts keep the order it listed them
 * in — they are often written to run in sequence.
 *
 * **Two tiers are gated, in opposite directions, and both spellings are here
 * on purpose.** Upstream runs the card's tier only for a character on
 * `character_allowed_regex` and the preset's only for a preset named in
 * `preset_allowed_regex[api]` (`engine.js:115`, `:126-128`; `getRegexedString`
 * is the one caller that asks for `allowedOnly: true`, `:346`). Here:
 *
 * - `policy` absent leaves the **card's** tier allowed (`!== false`), which is
 *   the behaviour this host already had and is not upstream's default — §30;
 * - `preset` absent, or carrying a policy that is not `allowed`, runs **none**
 *   of the preset's rules (`=== true`), which is upstream's default and is the
 *   ruling in §53.
 * @param card - the character being played, if any.
 * @param global - the profile's global scripts, in stored order.
 * @param policy - the user's decisions about the card's tier. Absent leaves the
 *   tier allowed and every rule at whatever the card said.
 * @param preset - the active preset's tier and the user's decisions about it.
 *   Absent means there is none to run, which is also what a refused one means.
 * @returns the ordered scripts, empty when no tier has any.
 */
export function scriptsOf(
  card: CharacterCard | undefined,
  global: readonly RegexScript[] = [],
  policy?: ScopedRegexPolicy,
  preset?: PresetRegexTier,
): RegexScript[] {
  const owned: OwnedScript[] = global.map(script => ({ script, type: SCRIPT_TYPE.GLOBAL }))
  // `=== true`, the opposite reading of the line below it. A preset arrives
  // refused: see the docblock, and §53 for the reasoning the two defaults
  // deliberately disagree.
  if (preset !== undefined && preset.policy.allowed === true) {
    owned.push(...preset.scripts.map(script => ({
      script: withUserSwitch(script, preset.policy.enabled),
      type: SCRIPT_TYPE.PRESET,
    })))
  }
  const scoped = card?.data.extensions.regex_scripts
  if (Array.isArray(scoped) && policy?.allowed !== false) {
    owned.push(...(scoped as RegexScript[]).map(script => ({
      script: withUserSwitch(script, policy?.enabled),
      type: SCRIPT_TYPE.SCOPED,
    })))
  }
  return orderScripts(owned)
}

/**
 * One script with the user's switch folded into `disabled`.
 *
 * Used by both gated tiers — the card's and the preset's — because the switch
 * means the same thing over either: the file's author said `disabled`, the user
 * says this, and the user wins where they have spoken.
 *
 * Returned **by identity** when the user has expressed nothing about it, which
 * is the common case: the storage contract for a card's own scripts is verbatim,
 * and a copy made on every read is a copy that can lose a key. A rewrite happens
 * only where there is a decision to fold in, and then only `disabled` moves.
 * @param script - the card's or the preset's script.
 * @param enabled - the user's switches, by script id.
 * @returns the script the engine should see.
 */
function withUserSwitch(
  script: RegexScript,
  enabled: Readonly<Record<string, boolean>> | undefined,
): RegexScript {
  if (enabled === undefined) return script
  const id = script.id
  // An unnamed script cannot be addressed by a switch, so it keeps the card's
  // word. Upstream assigns ids lazily (on render, on save, on migration), which
  // means a card can genuinely arrive without them — measured over the local
  // corpus, all 173 scoped scripts carry one, but that is the corpus's fact and
  // not the format's.
  if (id === undefined) return script
  const decision = enabled[id]
  if (decision === undefined) return script
  return { ...script, disabled: !decision }
}

/**
 * The macro expander a chat's regex scripts should use.
 *
 * Needed for `SUBSTITUTE.ESCAPED`, where a pattern's macros expand and the
 * expanded values are escaped before they are read as regex syntax — so a
 * character named `A.B` matches itself and not `AxB`. `@iris/regex` stays
 * dependency-free and `@iris/macro` supplies the adapter, so the two packages
 * meet by shape rather than by import.
 * @param names - what `{{char}}` and `{{user}}` expand to.
 * @returns the substitute to hand the regex engine.
 */
export function substituteFor(
  names: { user: string, character: string },
  variables?: MacroVariableStore,
): MacroSubstitute {
  return toRegexSubstitute(createMacroContext({
    char: names.character,
    user: names.user,
    // Optional, and unused today: a caller that supplies one binds the macro
    // tier to a store of its choosing. `entry.substitute` deliberately does not
    // — see the note there for what binding it to the chat's persistent scopes
    // cost when it was tried.
    ...variables === undefined ? {} : { variables },
  }))
}


/**
 * Run the scripts for one direction.
 *
 * A thin wrapper, but it is the only place the role-to-placement mapping and
 * the depth convention live, and both are easy to get subtly wrong at a call
 * site.
 * @param text - the message text.
 * @param role - the speaker.
 * @param scripts - the chat's ordered scripts.
 * @param params - which direction, and how far from the end of the chat this
 *   message sits (`0` is the last message).
 * @returns the rewritten text.
 */
export function runScripts(
  text: string,
  role: ViewRole,
  scripts: readonly RegexScript[],
  params: {
    isMarkdown?: boolean
    isPrompt?: boolean
    depth?: number
    substitute?: MacroSubstitute | undefined
  } = {},
): string {
  if (scripts.length === 0) return text
  const { substitute, ...rest } = params
  return applyRegexScripts(text, placementFor(role), scripts, {
    ...rest,
    ...substitute === undefined ? {} : { substitute },
  })
}

// —— family②: regex ——

/**
 * Which placement a card's `source` argument names.
 *
 * Upstream's own table, transcribed from `formatAsTavernRegexedString`
 * (`src/function/tavern_regex.ts:36-42`), whose values are
 * `extensions/regex/engine.js:281-292`'s `regex_placement`. Kept beside
 * {@link placementFor} because those two are the only two mappings from a
 * caller's vocabulary into a placement number, and a third one written at a
 * call site is how they would come to disagree.
 *
 * Five sources, and `MD_DISPLAY` (`0`) is deliberately unreachable: upstream
 * retired it and its member offers no word for it.
 */
export const SOURCE_PLACEMENT: Readonly<Record<TavernRegexSource, Placement>> = {
  user_input: PLACEMENT.USER_INPUT,
  ai_output: PLACEMENT.AI_OUTPUT,
  slash_command: PLACEMENT.SLASH_COMMAND,
  world_info: PLACEMENT.WORLD_INFO,
  reasoning: PLACEMENT.REASONING,
}

/**
 * How a rule the document did not name is addressed.
 *
 * Upstream mints ids lazily — on render, on save, on migration — so a document
 * can genuinely arrive with rules that have none, and `to_tavern_regex` passes
 * `undefined` straight through into a field its own type declares as `string`.
 * A card that read such a rule, toggled it and wrote the tier back would send a
 * rule with no handle, and nothing could match it to what was stored.
 *
 * So an unnamed rule is reported under a **content-derived** id rather than a
 * fresh one: derived, so two reads of an unchanged document agree and a card
 * can round-trip; content rather than position, so reordering the list — which
 * is upstream's own stated reason for offering a whole-tier write — does not
 * make every rule a stranger. Two byte-identical rules collide, which is
 * correct: nothing distinguishes them.
 *
 * Measured over the ST corpus, **all 251 stored rules carry an id** (173 in 15
 * cards, 78 in 4 presets), so this path is the format's possibility rather than
 * the corpus's habit. It is not a write: an id minted here becomes real only if
 * a card writes the tier back, which is exactly when upstream's own lazy mint
 * would have happened.
 * @param script - the rule as its document stores it.
 * @returns the document's id, or a stable derived one.
 */
export function tavernRegexId(script: RegexScript): string {
  const stored = script.id
  if (typeof stored === 'string' && stored.length > 0) return stored
  const digest = createHash('sha256')
    .update([
      typeof script.scriptName === 'string' ? script.scriptName : '',
      script.findRegex,
      script.replaceString,
    ].join(String.fromCharCode(0)))
    .digest('hex')
    .slice(0, 12)
  // Prefixed, so a reader looking at a card file can tell a derived handle from
  // one an install wrote.
  return `iris-derived-${digest}`
}

/**
 * One stored rule in Tavern Helper's vocabulary.
 *
 * Upstream's `to_tavern_regex` (`src/function/tavern_regex.ts:136-163`), field
 * for field. Three of the translations are worth naming because getting one
 * backwards is silent:
 *
 * - `enabled` is `!disabled`, the **file author's** switch. The user's own
 *   override is a separate record and is deliberately not folded in here —
 *   upstream has only the one switch, so a card reading two would be reading a
 *   surface no other host has, and a card *writing* the folded value back would
 *   burn the user's decision into the document.
 * - `destination` is the two `…Only` flags, **not** a partition: a rule with
 *   neither is the permanent kind and answers `false` to both, which is how
 *   upstream reports it too.
 * - `min_depth`/`max_depth` become `null` for anything that is not a number, so
 *   a card can test one field instead of three states.
 * @param script - the rule as its document stores it.
 * @returns the rule in the shape a card reads.
 */
export function toTavernRegex(script: RegexScript): TavernRegexView {
  const placement = Array.isArray(script.placement) ? script.placement : []
  return {
    id: tavernRegexId(script),
    script_name: typeof script.scriptName === 'string' ? script.scriptName : '',
    enabled: script.disabled !== true,
    find_regex: script.findRegex,
    replace_string: script.replaceString,
    trim_strings: Array.isArray(script.trimStrings) ? [...script.trimStrings] : [],
    source: {
      user_input: placement.includes(PLACEMENT.USER_INPUT),
      ai_output: placement.includes(PLACEMENT.AI_OUTPUT),
      slash_command: placement.includes(PLACEMENT.SLASH_COMMAND),
      world_info: placement.includes(PLACEMENT.WORLD_INFO),
      reasoning: placement.includes(PLACEMENT.REASONING),
    },
    destination: {
      display: script.markdownOnly === true,
      prompt: script.promptOnly === true,
    },
    run_on_edit: script.runOnEdit === true,
    min_depth: typeof script.minDepth === 'number' ? script.minDepth : null,
    max_depth: typeof script.maxDepth === 'number' ? script.maxDepth : null,
  }
}

/**
 * One card-written rule in the shape its document stores.
 *
 * Upstream's `from_tavern_regex` (`src/function/tavern_regex.ts:165-194`) with
 * **one deliberate departure**: upstream writes `substituteRegex: 0` with the
 * comment `// TODO: handle this?`, so a rule whose pattern expands macros in
 * escaped mode silently becomes one that does not the first time any card
 * writes the tier back — and `getTavernRegexes` never showed the field, so no
 * card could have preserved it. Here the rule's previous stored form is passed
 * in and everything this vocabulary has no word for is carried across from it:
 * `substituteRegex` and any key the file arrived with. A card that means to
 * change a field changes it; a card that means to reorder or toggle keeps the
 * rest of the document intact.
 * @param regex - the rule as the card wrote it.
 * @param previous - the stored rule of the same id, when there is one.
 * @returns the rule in its document's shape.
 */
export function fromTavernRegex(
  regex: TavernRegexView,
  previous?: RegexScript,
  // `id` and `scriptName` are narrowed to required, because this always writes
  // both: the global store's own row type (`RegexScriptView`) insists on a
  // name, and a `RegexScript`'s optional one would not satisfy it even though
  // every value produced here has it.
): RegexScript & { id: string, scriptName: string } {
  const source = regex.source
  return {
    // Unnamed fields first, so every field this vocabulary *does* carry
    // overwrites them rather than the other way round.
    ...previous ?? {},
    id: regex.id,
    scriptName: regex.script_name,
    disabled: !regex.enabled,
    runOnEdit: regex.run_on_edit,
    findRegex: regex.find_regex,
    replaceString: regex.replace_string,
    trimStrings: [...regex.trim_strings],
    placement: [
      ...source.user_input ? [PLACEMENT.USER_INPUT] : [],
      ...source.ai_output ? [PLACEMENT.AI_OUTPUT] : [],
      ...source.slash_command ? [PLACEMENT.SLASH_COMMAND] : [],
      ...source.world_info ? [PLACEMENT.WORLD_INFO] : [],
      ...source.reasoning ? [PLACEMENT.REASONING] : [],
    ],
    markdownOnly: regex.destination.display,
    promptOnly: regex.destination.prompt,
    minDepth: regex.min_depth,
    maxDepth: regex.max_depth,
    // Kept last so an absent previous rule still gets upstream's own default
    // rather than `undefined`, which the engine's `Number(…)` would read as NaN
    // and fall through to the unescaped branch on.
    substituteRegex: typeof previous?.substituteRegex === 'number' ? previous.substituteRegex : SUBSTITUTE.NONE,
  }
}

/**
 * Run one chat's regex chain over a string a card handed in.
 *
 * Upstream's `formatAsTavernRegexedString` (`src/function/tavern_regex.ts:27-73`)
 * has three steps and two of them are here:
 *
 * 1. `getRegexedString` over the whole allowed chain, with `isMarkdown` /
 *    `isPrompt` set from `destination` and the depth window honoured only when
 *    a `depth` was given. That is {@link applyRegexScripts} with the same
 *    scripts the reader's page and the outgoing prompt use.
 * 2. `substituteParams` over the **result**, so `{{char}}` in text no rule
 *    touched still expands — which is why this is not simply `runScripts`. The
 *    `character_name` argument overrides `{{char}}` for this call, upstream's
 *    `name2Override`.
 * 3. `macros.forEach` — the `registerMacroLike` family. This host has no such
 *    member, so there is nothing registered and the step is a no-op; a card
 *    that registered one upstream and formats here gets its text back with that
 *    one macro unexpanded (ledger §64).
 * @param text - the string to rewrite.
 * @param source - what kind of text it is.
 * @param destination - what it is about to be used as.
 * @param scripts - the chat's ordered chain (`entry.scripts`).
 * @param options - the depth, the character-name override, and the expander.
 * @returns the rewritten string.
 */
export function formatAsTavernRegexed(
  text: string,
  source: TavernRegexSource,
  destination: 'display' | 'prompt',
  scripts: readonly RegexScript[],
  options: {
    depth?: number
    characterName?: string
    substitute?: MacroSubstitute | undefined
  } = {},
): string {
  const { substitute, characterName, depth } = options
  const stage = destination === 'display' ? { isMarkdown: true } : { isPrompt: true }
  const override = characterName === undefined ? {} : { characterOverride: characterName }
  const rewritten = applyRegexScripts(text, SOURCE_PLACEMENT[source], scripts, {
    ...stage,
    ...depth === undefined ? {} : { depth },
    ...override,
    ...substitute === undefined ? {} : { substitute },
  })
  // Step 2. Skipped entirely when there is no expander, rather than reported:
  // this is the same silence `runScripts` keeps, and the member's own gap note
  // belongs to the frame that answered the card.
  if (substitute === undefined) return rewritten
  return substitute(rewritten, override)
}
