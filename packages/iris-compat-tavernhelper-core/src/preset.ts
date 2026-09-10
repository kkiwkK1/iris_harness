/**
 * Tavern Helper's `Preset` shape, and the two-way mapping to a preset **file**.
 *
 * Two trust domains need the same answer, which is why this is here rather than
 * in `@iris/preset`:
 *
 * - the **host**, which stores SillyTavern's own preset files and has to answer
 *   `getPreset` with Tavern Helper's shape, and write a card's edited `Preset`
 *   back into a file without losing a field;
 * - the **frame**, which publishes `isPresetNormalPrompt`,
 *   `isPresetSystemPrompt`, `isPresetPlaceholderPrompt` and `default_preset` to
 *   card scripts, and whose answers must agree with the host's classification
 *   letter for letter.
 *
 * A hand-copied second copy is the failure worth designing against, and it has
 * a specific shape here: the three type guards decide a prompt's class from its
 * `id`, and `fromTavernHelperPreset` writes `system_prompt` and `marker` from
 * the *same* classification. Two copies that disagree by one identifier give a
 * card a prompt that `isPresetNormalPrompt` calls normal and the file records
 * as a marker — internally consistent on both sides, wrong as a pair, and
 * silent.
 *
 * ## The shapes, and which one is which
 *
 * Upstream keeps two, and the names in this file follow upstream's own:
 *
 * | here | upstream | what it is |
 * | --- | --- | --- |
 * | {@link TavernHelperPreset} | `Preset` (`src/function/preset.ts:9`) | what a card sees |
 * | {@link PresetFile} | `_OriginalPreset` (`:229`) | what SillyTavern stores |
 *
 * The card-facing shape is **not** a subset: it renames every sampler field
 * (`openai_max_context` → `settings.max_context`), turns `injection_position:
 * 0 | 1` into `position: { type: 'relative' | 'in_chat' }`, folds
 * `prompt_order`'s enabled flags into each prompt, and **splits the prompt list
 * in two** — `prompts` is only what the ordering names, in the ordering's
 * order, and everything else is `prompts_unused` (`toPreset`, `:404-410`). A
 * mapping that skipped the split would hand a card its whole prompt list in
 * file order with the unused entries mixed in, which reads as a preset whose
 * ordering does nothing.
 *
 * @module @iris/compat-tavernhelper-core/preset
 */

/**
 * One prompt as a card sees it — upstream's `PresetPrompt`
 * (`src/function/preset.ts:54`).
 *
 * `content` is present for normal and system prompts and absent for
 * placeholders; `position` is present for normal and placeholder prompts and
 * absent for system ones. Both absences are upstream's (`toPresetPrompt`,
 * `:344-365`) and both are load-bearing: the corpus's one real consumer
 * branches on `prompt.content` being truthy to decide whether the entry carries
 * text at all.
 */
export interface TavernHelperPresetPrompt {
  id: string
  name: string
  enabled: boolean
  position?: { type: 'relative' } | { type: 'in_chat', depth: number, order: number }
  role: 'system' | 'user' | 'assistant'
  content?: string
  extra?: Record<string, unknown>
}

/** The sampler half of a preset, as a card sees it (`preset.ts:10-40`). */
export interface TavernHelperPresetSettings {
  max_context: number
  max_completion_tokens: number
  reply_count: number
  should_stream: boolean
  temperature: number
  frequency_penalty: number
  presence_penalty: number
  repetition_penalty: number
  top_p: number
  min_p: number
  top_k: number
  top_a: number
  seed: number
  squash_system_messages: boolean
  reasoning_effort: 'auto' | 'min' | 'low' | 'medium' | 'high' | 'max'
  request_thoughts: boolean
  request_images: boolean
  enable_function_calling: boolean
  enable_web_search: boolean
  allow_sending_images: 'disabled' | 'auto' | 'low' | 'high'
  allow_sending_videos: boolean
  character_name_prefix: 'none' | 'default' | 'content' | 'completion'
  wrap_user_messages_in_quotes: boolean
}

/** A whole preset as a card sees it — upstream's `Preset` (`preset.ts:9`). */
export interface TavernHelperPreset {
  settings: TavernHelperPresetSettings
  prompts: TavernHelperPresetPrompt[]
  prompts_unused: TavernHelperPresetPrompt[]
  extensions: Record<string, unknown>
}

/** One prompt as SillyTavern stores it — upstream's `_OriginalPrompt` (`:255`). */
export interface PresetFilePrompt {
  identifier?: string
  name?: string
  enabled?: boolean
  role?: string
  content?: string
  system_prompt?: boolean
  marker?: boolean
  /**
   * `0` relative, `1` at a depth in the chat.
   *
   * Iris's own manager spells the same two states `'relative'` and
   * `'absolute'` (`@iris/preset`'s `PromptItem`), because Iris's assembler was
   * written against the word rather than the number. Both spellings are read
   * here — a preset that came through Iris's manager and one that came off
   * SillyTavern's disk must classify identically, and they are the same file
   * field.
   */
  injection_position?: 0 | 1 | 'relative' | 'absolute' | number
  injection_depth?: number
  injection_order?: number
  extra?: Record<string, unknown>
  forbid_overrides?: boolean
  [key: string]: unknown
}

/** One character's ordering — upstream's `prompt_order` entry (`:307`). */
export interface PresetFileOrder {
  character_id: number
  order: { identifier: string, enabled: boolean }[]
}

/** A preset file, structurally what `@iris/preset`'s `ChatCompletionPreset` is. */
export interface PresetFile {
  prompts: PresetFilePrompt[]
  prompt_order?: PresetFileOrder[]
  [key: string]: unknown
}

/**
 * The four ids upstream calls system prompts (`preset.ts:110-112`).
 *
 * Read by {@link isPresetSystemPrompt} **and** by
 * {@link fromTavernHelperPreset} when it writes `system_prompt`, so the guard a
 * card calls and the flag the file records can never disagree.
 */
export const SYSTEM_PROMPT_IDS: readonly string[] = ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions']

/**
 * The eight ids upstream calls placeholder prompts (`preset.ts:113-123`).
 *
 * **camelCase**, and this is the one place the documentation misleads:
 * upstream's own JSDoc (`@types/function/preset.d.ts:81`) lists them in
 * snake_case — `world_info_before`, `persona_description`,
 * `enhance_definitions` — while the type union at `:83`, this array's source at
 * `preset.ts:115` and the default preset's literals at `:161`/`:190` all say
 * `worldInfoBefore`. Three runtime sources against one comment. A card whose
 * `prompt.id === 'worldInfoBefore'` is never true loses its world info and
 * still produces well-formed output.
 */
export const PLACEHOLDER_PROMPT_IDS: readonly string[] = [
  'worldInfoBefore',
  'personaDescription',
  'charDescription',
  'charPersonality',
  'scenario',
  'worldInfoAfter',
  'dialogueExamples',
  'chatHistory',
]

/**
 * Whether this prompt is one SillyTavern's own settings supply
 * (`preset.ts:110`).
 * @param prompt - the prompt as a card sees it.
 * @returns true for `main`, `nsfw`, `jailbreak` and `enhanceDefinitions`.
 */
export function isPresetSystemPrompt(prompt: { id: string }): boolean {
  return SYSTEM_PROMPT_IDS.includes(prompt.id)
}

/**
 * Whether this prompt names an insertion point rather than carrying text
 * (`preset.ts:113`).
 * @param prompt - the prompt as a card sees it.
 * @returns true for the eight placeholder ids.
 */
export function isPresetPlaceholderPrompt(prompt: { id: string }): boolean {
  return PLACEHOLDER_PROMPT_IDS.includes(prompt.id)
}

/**
 * Whether this prompt is one a person added by hand (`preset.ts:107`).
 *
 * Defined as "neither of the other two", exactly as upstream defines it, rather
 * than by any positive test: an id nobody recognises is a normal prompt, which
 * is what makes a card's own `id: 'new_prompt'` behave.
 * @param prompt - the prompt as a card sees it.
 * @returns true when it is neither a system nor a placeholder prompt.
 */
export function isPresetNormalPrompt(prompt: { id: string }): boolean {
  return !isPresetSystemPrompt(prompt) && !isPresetPlaceholderPrompt(prompt)
}

/**
 * The default order upstream gives the built-in prompts
 * (`src/function/generate/types.ts:172`).
 *
 * snake_case here, and camelCase in {@link PLACEHOLDER_PROMPT_IDS}, because
 * these are **two different vocabularies** in upstream and not a typo in
 * either: this array names `generateRaw`'s `ordered_prompts` entries
 * (`PlaceholderPrompt`, `generate.d.ts:328`) while the other names preset
 * prompt ids. It also carries a ninth entry, `user_input`, which is not a
 * preset prompt at all. Folding them into one list would give a card a preset
 * id no preset has, or a `generateRaw` order the host cannot resolve.
 */
export const PLACEHOLDER_PROMPT_DEFAULT_ORDER: readonly string[] = [
  'world_info_before',
  'persona_description',
  'char_description',
  'char_personality',
  'scenario',
  'world_info_after',
  'dialogue_examples',
  'chat_history',
  'user_input',
]

/**
 * The preset upstream creates a new one from — `default_preset`
 * (`preset.ts:126-218`), transcribed field for field.
 *
 * Frozen, and handed out as a copy by every caller: upstream's is `as const`
 * and `createPreset(name)` passes it straight through, so a card that mutated
 * the object it was given would change what the *next* `createPreset` writes.
 */
export const TH_DEFAULT_PRESET: TavernHelperPreset = Object.freeze({
  settings: Object.freeze({
    max_context: 2000000,
    max_completion_tokens: 300,
    reply_count: 1,
    should_stream: false,
    temperature: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    repetition_penalty: 1,
    top_p: 1,
    min_p: 0,
    top_k: 0,
    top_a: 0,
    seed: -1,
    squash_system_messages: false,
    reasoning_effort: 'auto',
    request_thoughts: false,
    request_images: false,
    enable_function_calling: false,
    enable_web_search: false,
    allow_sending_images: 'disabled',
    allow_sending_videos: false,
    character_name_prefix: 'none',
    wrap_user_messages_in_quotes: false,
  }) as TavernHelperPresetSettings,
  prompts: Object.freeze([
    { id: 'worldInfoBefore', name: 'World Info (before) - 角色定义之前', enabled: true, position: { type: 'relative' }, role: 'system' },
    { id: 'personaDescription', name: 'Persona Description - 玩家描述', enabled: true, position: { type: 'relative' }, role: 'system' },
    { id: 'charDescription', name: 'Char Description - 角色描述', enabled: true, position: { type: 'relative' }, role: 'system' },
    { id: 'charPersonality', name: 'Char Personality - 角色性格', enabled: true, position: { type: 'relative' }, role: 'system' },
    { id: 'scenario', name: 'Scenario - 情景', enabled: true, position: { type: 'relative' }, role: 'system' },
    { id: 'worldInfoAfter', name: 'World Info (after) - 角色定义之后', enabled: true, position: { type: 'relative' }, role: 'system' },
    { id: 'dialogueExamples', name: 'Chat Examples - 对话示例', enabled: true, position: { type: 'relative' }, role: 'system' },
    { id: 'chatHistory', name: 'Chat History - 聊天记录', enabled: true, position: { type: 'relative' }, role: 'system' },
  ]) as unknown as TavernHelperPresetPrompt[],
  prompts_unused: Object.freeze([]) as unknown as TavernHelperPresetPrompt[],
  extensions: Object.freeze({ tavern_helper: Object.freeze({ scripts: Object.freeze([]), variables: Object.freeze({}) }) }) as Record<string, unknown>,
}) as TavernHelperPreset

/** The sampler names a preset file spells differently in use and on disk. */
const IN_USE_SAMPLERS: readonly [keyof TavernHelperPresetSettings, string, string][] = [
  ['temperature', 'temp_openai', 'temperature'],
  ['frequency_penalty', 'freq_pen_openai', 'frequency_penalty'],
  ['presence_penalty', 'pres_pen_openai', 'presence_penalty'],
  ['top_p', 'top_p_openai', 'top_p'],
  ['repetition_penalty', 'repetition_penalty_openai', 'repetition_penalty'],
  ['min_p', 'min_p_openai', 'min_p'],
  ['top_k', 'top_k_openai', 'top_k'],
  ['top_a', 'top_a_openai', 'top_a'],
]

/** Read a number out of a file field, falling back to the default preset's. */
function num(file: PresetFile, key: string, fallback: number): number {
  const value = file[key]
  const parsed = Number(value)
  return value === undefined || value === null || Number.isNaN(parsed) ? fallback : parsed
}

/** Read a boolean out of a file field, falling back to the default preset's. */
function bool(file: PresetFile, key: string, fallback: boolean): boolean {
  const value = file[key]
  return value === undefined ? fallback : Boolean(value)
}

/** Which of the three classes a stored prompt belongs to (`preset.ts:339-341`). */
function classOf(prompt: PresetFilePrompt): 'normal' | 'system' | 'placeholder' {
  if (prompt.marker === true) return 'placeholder'
  return prompt.system_prompt === true ? 'system' : 'normal'
}

/** Whether a stored prompt sits at a depth rather than in list order. */
function atDepth(prompt: PresetFilePrompt): boolean {
  return prompt.injection_position === 1 || prompt.injection_position === 'absolute'
}

/**
 * One stored prompt as a card sees it — upstream's `toPresetPrompt`
 * (`preset.ts:338-370`).
 * @param prompt - the stored prompt.
 * @param order - the ordering group, for the enabled flag it overrides with.
 * @returns the card-facing prompt.
 */
function toPresetPrompt(
  prompt: PresetFilePrompt,
  order: readonly { identifier: string, enabled: boolean }[],
): TavernHelperPresetPrompt {
  const kind = classOf(prompt)
  const id = prompt.identifier ?? randomId()
  const result: TavernHelperPresetPrompt = {
    id,
    name: prompt.name ?? 'unnamed',
    /*
     * The ordering wins over the prompt's own flag, then the flag, then `true`
     * — upstream's exact chain (`preset.ts:349-352`). Note what it does *not*
     * do: a prompt missing from the ordering keeps its own `enabled`, so a
     * card's `prompts_unused` entry does not read as disabled just for being
     * unused.
     */
    enabled: order.find(entry => entry.identifier === prompt.identifier)?.enabled ?? prompt.enabled ?? true,
    role: (prompt.role ?? 'system') as 'system' | 'user' | 'assistant',
  }
  if (kind !== 'system') {
    result.position = atDepth(prompt)
      ? { type: 'in_chat', depth: prompt.injection_depth ?? 4, order: prompt.injection_order ?? 100 }
      : { type: 'relative' }
  }
  if (kind !== 'placeholder') result.content = prompt.content ?? ''
  if (prompt.extra !== undefined) result.extra = prompt.extra
  return result
}

/**
 * One card-facing prompt as a file stores it — upstream's `fromPresetPrompt`
 * (`preset.ts:372-398`).
 *
 * Classification comes from the **id**, through the same three guards a card
 * calls, which is what makes a card's `push({ id: 'new_prompt', … })` land as a
 * normal prompt and its edited `chatHistory` land as a marker.
 * @param prompt - the card-facing prompt.
 * @returns the stored prompt.
 */
function fromPresetPrompt(prompt: TavernHelperPresetPrompt): PresetFilePrompt {
  const placeholder = isPresetPlaceholderPrompt(prompt)
  const system = isPresetSystemPrompt(prompt)
  const normal = !placeholder && !system
  const stored: PresetFilePrompt = {
    identifier: prompt.id,
    name: prompt.name,
    enabled: prompt.enabled,
  }
  /*
   * `dialogueExamples` and `chatHistory` carry no injection fields at all —
   * upstream excludes exactly those two (`preset.ts:381`). They are the two
   * markers whose position is the *list*, and writing an `injection_position`
   * onto them makes SillyTavern's own manager render them as depth injections.
   */
  if ((normal || placeholder) && !['dialogueExamples', 'chatHistory'].includes(prompt.id)) {
    stored.injection_position = prompt.position?.type === 'in_chat' ? 1 : 0
    stored.injection_depth = prompt.position?.type === 'in_chat' ? prompt.position.depth : 4
    stored.injection_order = prompt.position?.type === 'in_chat' ? prompt.position.order : 100
  }
  stored.role = prompt.role
  /*
   * `?? ''`, not the bare value. Upstream writes `prompt.content` straight
   * through, so a normal prompt a card built without a `content` key stores as
   * `content: undefined` — which `JSON.stringify` then drops from the file, and
   * the prompt reads back as a marker-less entry with no text at all. An empty
   * string is what `toPresetPrompt` would have handed the card for that prompt
   * in the first place (`preset.ts:364`), so the round trip closes.
   */
  if (normal || system) stored.content = prompt.content ?? ''
  stored.system_prompt = system || placeholder
  stored.marker = placeholder
  if (prompt.extra !== undefined) stored.extra = prompt.extra
  stored.forbid_overrides = false
  return stored
}

/**
 * The ordering group upstream reads — the group default, 100001
 * (`preset.ts:402`).
 *
 * Not 100000, which is the class default `PromptManager` declares and
 * `openai.js:689` overrides for this path; `@iris/preset`'s `GLOBAL_ORDER_ID`
 * carries the same reading and the same reason. Written here as a literal
 * rather than imported because this package has no dependencies by contract,
 * and pinned equal to it by test.
 */
export const TH_ORDER_CHARACTER_ID = 100001

/**
 * A preset file as a card sees it — upstream's `toPreset` (`preset.ts:399-471`).
 *
 * @param file - the stored preset.
 * @param options - `live` is a patch of file-shaped fields to read *instead of*
 *   the file's own, for the `'in_use'` preset: upstream reads the sampler values
 *   out of the running settings rather than the file (`in_use ? preset.temp_openai
 *   : preset.temperature`), and this host keeps that half of a preset in its
 *   settings layer. Absent means read the file alone, which is what a request
 *   for a *named* library preset means.
 * @returns the card-facing preset.
 */
export function toTavernHelperPreset(
  file: PresetFile,
  options: { live?: Record<string, unknown> } = {},
): TavernHelperPreset {
  const source: PresetFile = options.live === undefined ? file : { ...file, ...options.live }
  const inUse = options.live !== undefined
  const order = (source.prompt_order ?? []).find(entry => entry.character_id === TH_ORDER_CHARACTER_ID)?.order ?? []
  const all = (source.prompts ?? []).map(prompt => toPresetPrompt(prompt, order))

  /*
   * The split, and the ordering. `prompts` is what the ordering names, **in the
   * ordering's order**; everything else is `prompts_unused` (`preset.ts:404-410`).
   * An identifier the ordering names but no prompt carries is dropped rather
   * than left as a hole — upstream's `.find(...)!` would put `undefined` in the
   * array and the first `prompt.enabled` read would throw inside the card.
   */
  const named = new Set(order.map(entry => entry.identifier))
  const used = all.filter(prompt => named.has(prompt.id))
  const byId = new Map(used.map(prompt => [prompt.id, prompt]))
  const prompts = order
    .map(entry => byId.get(entry.identifier))
    .filter((prompt): prompt is TavernHelperPresetPrompt => prompt !== undefined)
  const prompts_unused = all.filter(prompt => !named.has(prompt.id))

  const extensions: Record<string, unknown> = {
    ...(typeof source.extensions === 'object' && source.extensions !== null
      ? source.extensions as Record<string, unknown>
      : {}),
  }
  /*
   * `tavern_helper` is declared non-optional on upstream's `Preset`
   * (`preset.ts:46`) while a real preset file may simply not have it — five of
   * the eight presets measured here do not. Seeded rather than left absent, so
   * `preset.extensions.tavern_helper.scripts.length` in a card does not throw
   * on a preset that predates the extension.
   */
  if (typeof extensions['tavern_helper'] !== 'object' || extensions['tavern_helper'] === null) {
    extensions['tavern_helper'] = { scripts: [], variables: {} }
  }
  /*
   * `regex_scripts` is left in the file's own shape rather than converted to
   * Tavern Helper's `TavernRegex`.
   *
   * Upstream converts (`preset.ts:414`, `to_tavern_regex`), and that conversion
   * is the regex family's — `getTavernRegexes` and its siblings are being built
   * on `dev/th-regex-api`. Writing a second copy of it here is the seam this
   * module exists to avoid: two conversions of one shape drift, and then a card
   * reading a rule through `getPreset` and the same rule through
   * `getTavernRegexes` sees two different objects. Recorded as the one
   * `getPreset` field that is not upstream's shape; see DEVIATIONS 89.
   */

  const settings: TavernHelperPresetSettings = {
    max_context: num(source, 'openai_max_context', TH_DEFAULT_PRESET.settings.max_context),
    max_completion_tokens: num(source, 'openai_max_tokens', TH_DEFAULT_PRESET.settings.max_completion_tokens),
    reply_count: num(source, 'n', TH_DEFAULT_PRESET.settings.reply_count),
    should_stream: bool(source, 'stream_openai', TH_DEFAULT_PRESET.settings.should_stream),
    ...Object.fromEntries(IN_USE_SAMPLERS.map(([field, inUseKey, fileKey]) => [
      field,
      num(source, inUse ? inUseKey : fileKey, TH_DEFAULT_PRESET.settings[field] as number),
    ])) as Pick<TavernHelperPresetSettings, 'temperature' | 'frequency_penalty' | 'presence_penalty' | 'top_p' | 'repetition_penalty' | 'min_p' | 'top_k' | 'top_a'>,
    seed: num(source, 'seed', TH_DEFAULT_PRESET.settings.seed),
    squash_system_messages: bool(source, 'squash_system_messages', TH_DEFAULT_PRESET.settings.squash_system_messages),
    reasoning_effort: REASONING_EFFORTS.has(String(source['reasoning_effort']))
      ? String(source['reasoning_effort']) as TavernHelperPresetSettings['reasoning_effort']
      : TH_DEFAULT_PRESET.settings.reasoning_effort,
    request_thoughts: bool(source, 'show_thoughts', TH_DEFAULT_PRESET.settings.request_thoughts),
    request_images: bool(source, 'request_images', TH_DEFAULT_PRESET.settings.request_images),
    enable_function_calling: bool(source, 'function_calling', TH_DEFAULT_PRESET.settings.enable_function_calling),
    enable_web_search: bool(source, 'enable_web_search', TH_DEFAULT_PRESET.settings.enable_web_search),
    /*
     * Two file fields, one card field. Upstream reads `image_inlining === false`
     * as `'disabled'` and otherwise reports `inline_image_quality`
     * (`preset.ts:454-457`), so the *quality* a preset stores while inlining is
     * off is unreachable from the card side — as it is upstream.
     */
    allow_sending_images: bool(source, 'image_inlining', false)
      ? (IMAGE_QUALITIES.has(String(source['inline_image_quality'])) ? String(source['inline_image_quality']) as 'auto' | 'low' | 'high' : 'auto')
      : 'disabled',
    allow_sending_videos: bool(source, 'video_inlining', TH_DEFAULT_PRESET.settings.allow_sending_videos),
    character_name_prefix: NAMES_BEHAVIOR[num(source, 'names_behavior', -1)] ?? 'none',
    wrap_user_messages_in_quotes: bool(source, 'wrap_in_quotes', TH_DEFAULT_PRESET.settings.wrap_user_messages_in_quotes),
  }

  return { settings, prompts, prompts_unused, extensions }
}

/** The six words upstream accepts for reasoning effort (`preset.d.ts:31`). */
const REASONING_EFFORTS: ReadonlySet<string> = new Set(['auto', 'min', 'low', 'medium', 'high', 'max'])
/** The three inline-image qualities (`preset.d.ts:43`). */
const IMAGE_QUALITIES: ReadonlySet<string> = new Set(['auto', 'low', 'high'])
/** SillyTavern's `names_behavior` numbers, as words (`preset.ts:459-466`). */
const NAMES_BEHAVIOR: Record<number, TavernHelperPresetSettings['character_name_prefix']> = {
  [-1]: 'none',
  0: 'default',
  2: 'content',
  1: 'completion',
}
/** The inverse, for the write direction (`preset.ts:552-559`). */
const NAMES_BEHAVIOR_NUMBER: Record<string, number> = { none: -1, default: 0, content: 2, completion: 1 }

/**
 * Raised when a card's preset carries the same system or placeholder id twice.
 *
 * Upstream throws a bare `Error` with this sentence (`preset.ts:481`); the class
 * exists so the host can answer `invalid-request` rather than a 500, and the
 * message is upstream's so a card that matches on it still matches.
 */
export class DuplicatePresetPromptError extends Error {
  constructor(id: string) {
    super(`修改的预设中存在重复的系统/占位提示词 '${id}'`)
    this.name = 'DuplicatePresetPromptError'
  }
}

/**
 * A card-facing preset as a file stores it — upstream's `fromPreset`
 * (`preset.ts:472-568`).
 *
 * @param preset - the preset as the card left it.
 * @returns the file body, `prompt_order` rebuilt from the used list.
 * @throws {DuplicatePresetPromptError} when a system or placeholder id repeats.
 */
export function fromTavernHelperPreset(preset: TavernHelperPreset): PresetFile {
  const seen = new Set<string>()
  /*
   * Upstream's collision policy, and the asymmetry is deliberate on its side:
   * a repeated **normal** id is renamed to a fresh uuid, while a repeated
   * system or placeholder id throws (`preset.ts:474-484`). Renaming a marker
   * would produce a preset whose `chatHistory` slot is called something the
   * assembler has never heard of, and the prompt would silently stop being the
   * conversation's position.
   */
  const uncollide = (prompts: readonly TavernHelperPresetPrompt[]): TavernHelperPresetPrompt[] =>
    prompts.map(prompt => {
      if (!seen.has(prompt.id)) {
        seen.add(prompt.id)
        return prompt
      }
      if (!isPresetNormalPrompt(prompt)) throw new DuplicatePresetPromptError(prompt.id)
      const id = randomId()
      seen.add(id)
      return { ...prompt, id }
    })

  const used = uncollide(preset.prompts ?? []).map(fromPresetPrompt)
  const unused = uncollide(preset.prompts_unused ?? []).map(fromPresetPrompt)
  const settings = { ...TH_DEFAULT_PRESET.settings, ...preset.settings }

  return {
    max_context_unlocked: true,
    openai_max_context: settings.max_context,
    openai_max_tokens: settings.max_completion_tokens,
    n: settings.reply_count,
    stream_openai: settings.should_stream,
    // Both spellings, because a preset file carries both and which one is read
    // depends on whether it is the one in use (`preset.ts:513-529`). Writing
    // only one leaves the other at whatever the previous body said.
    ...Object.fromEntries(IN_USE_SAMPLERS.flatMap(([field, inUseKey, fileKey]) => [
      [inUseKey, settings[field]],
      [fileKey, settings[field]],
    ])),
    seed: settings.seed,
    squash_system_messages: settings.squash_system_messages,
    reasoning_effort: settings.reasoning_effort,
    show_thoughts: settings.request_thoughts,
    request_images: settings.request_images,
    function_calling: settings.enable_function_calling,
    enable_web_search: settings.enable_web_search,
    image_inlining: settings.allow_sending_images !== 'disabled',
    inline_image_quality: settings.allow_sending_images === 'disabled' ? 'auto' : settings.allow_sending_images,
    video_inlining: settings.allow_sending_videos,
    names_behavior: NAMES_BEHAVIOR_NUMBER[settings.character_name_prefix] ?? -1,
    wrap_in_quotes: settings.wrap_user_messages_in_quotes,
    prompts: [...used, ...unused],
    prompt_order: [
      {
        character_id: TH_ORDER_CHARACTER_ID,
        order: used.map(prompt => ({ identifier: prompt.identifier ?? '', enabled: prompt.enabled ?? true })),
      },
    ],
    extensions: preset.extensions ?? {},
  }
}

/**
 * Upstream's `setPreset` merge — a partial over what is already stored
 * (`preset.ts:731-748`).
 *
 * Three different rules in four fields, and none of them is the obvious one:
 *
 * - `settings` and `extensions` go through `_.defaultsDeep`, which fills in
 *   only what the partial does **not** carry;
 * - `prompts` and `prompts_unused` are `??`, so a partial that names either
 *   replaces the whole array and one that omits it keeps the old array intact.
 *   Deep-merging the prompt lists would be the plausible reading and it is
 *   wrong: `setPreset('P', { prompts: [one] })` is how a card says "this
 *   preset's list is now this one prompt".
 *
 * `defaultsDeep` on **arrays** is the trap worth naming: lodash fills them by
 * index, so a partial `extensions.regex_scripts` of one rule over a stored two
 * leaves the stored *second* rule in place at index 1. Reproduced here rather
 * than corrected, because a card written against upstream gets that result and
 * `extensions` is where third-party state lives.
 * @param partial - what the card supplied.
 * @param old - the preset as stored.
 * @returns the preset to write.
 */
export function mergePresetDefaults(
  partial: {
    settings?: Record<string, unknown>
    prompts?: TavernHelperPresetPrompt[]
    prompts_unused?: TavernHelperPresetPrompt[]
    extensions?: Record<string, unknown>
  },
  old: TavernHelperPreset,
): TavernHelperPreset {
  return {
    settings: defaultsDeep(partial.settings ?? {}, old.settings as unknown as Record<string, unknown>) as unknown as TavernHelperPresetSettings,
    prompts: partial.prompts ?? old.prompts,
    prompts_unused: partial.prompts_unused ?? old.prompts_unused,
    extensions: defaultsDeep(partial.extensions ?? {}, old.extensions) as Record<string, unknown>,
  }
}

/**
 * `_.defaultsDeep` for the two shapes a preset merge meets.
 *
 * Fills a key only when the target does not have it — `undefined` counts as not
 * having it, which is lodash's rule and the one that makes
 * `setPreset('P', { settings: { temperature: undefined } })` keep the stored
 * temperature rather than clear it. Recurses into plain objects and into arrays
 * by index; anything else (a string, a number, a `Date`) is taken whole.
 * @param target - the partial, which wins wherever it has a value.
 * @param source - the stored value, which fills the gaps.
 * @returns a new value; neither argument is mutated.
 */
function defaultsDeep(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    const out = [...target]
    for (let index = 0; index < source.length; index += 1) {
      out[index] = index < target.length ? defaultsDeep(target[index], source[index]) : source[index]
    }
    return out
  }
  if (!isPlainRecord(target) || !isPlainRecord(source)) return target === undefined ? source : target
  const out: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(source)) {
    out[key] = Object.hasOwn(out, key) && out[key] !== undefined ? defaultsDeep(out[key], value) : value
  }
  return out
}

/** Whether this is an object a merge should walk into rather than take whole. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Where a trimmed preset says what was left out.
 *
 * A key **inside** `extensions`, not beside it, for two reasons: upstream's
 * `extensions` is declared open (`[other: string]: any`), so a card that walks
 * it is already prepared for keys it does not know; and the write direction has
 * to find it on a body a card hands back, which it can only do if it travels
 * with the body.
 */
export const OMITTED_EXTENSIONS_KEY = 'iris_omitted'

/**
 * Extension sub-trees the frame's copy leaves out, and why there is a list at
 * all.
 *
 * `getPreset` is **synchronous** upstream, so a faithful answer has to be in
 * the frame's hands before a card asks — which means it rides the pushed
 * snapshot and is structured-cloned once per live frame. Measured over the
 * eight real presets in the two corpora (2026-09-10), the whole `Preset` for
 * the heaviest is 5,961 KiB, of which **5,040 KiB is
 * `extensions.tavern_helper`** (that preset's own script library) and 202 KiB
 * `extensions.regex_scripts`; at `FRAME_COUNT_LIMIT` 18 that is 105 MiB of
 * clone per reading window. Without these two keys the same preset is 719 KiB
 * and the whole corpus fits in 8.8 MiB — and neither key is read by any of the
 * 1,694 corpus bodies.
 *
 * They are **named in the body** rather than silently dropped, and the write
 * arm restores them from the stored preset when the marker is present, so
 * upstream's own documented round trip — `const p = getPreset('in_use'); …;
 * await replacePreset('in_use', p)` — cannot delete a preset's script library
 * as a side effect. A trim that did not say so would do exactly that, and the
 * preset would still load.
 */
export const FRAME_OMITTED_EXTENSIONS: readonly string[] = ['tavern_helper', 'regex_scripts']

/**
 * The copy that rides the snapshot: the same preset, minus the heavy extensions.
 * @param preset - the faithful preset.
 * @returns a preset whose `extensions` names what it left out.
 */
export function trimPresetForFrame(preset: TavernHelperPreset): TavernHelperPreset {
  const omitted = FRAME_OMITTED_EXTENSIONS.filter(key => key in preset.extensions)
  const extensions: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(preset.extensions)) {
    if (!FRAME_OMITTED_EXTENSIONS.includes(key)) extensions[key] = value
  }
  /*
   * Always present, even when nothing was dropped, and always an array. A
   * marker that appears only when it fires makes "this build does not trim" and
   * "this preset had nothing to trim" the same reading — and the write arm
   * would then have to guess which it was looking at.
   */
  extensions[OMITTED_EXTENSIONS_KEY] = omitted
  return { ...preset, extensions }
}

/**
 * Put back what {@link trimPresetForFrame} left out, before a write.
 *
 * @param incoming - the preset a card handed back.
 * @param stored - the preset as it is on disk, for the keys to restore from.
 * @returns the preset to write, and which keys were restored.
 */
export function restoreOmittedExtensions(
  incoming: TavernHelperPreset,
  stored: TavernHelperPreset | undefined,
): { preset: TavernHelperPreset, restored: string[] } {
  const marker = incoming.extensions?.[OMITTED_EXTENSIONS_KEY]
  if (!Array.isArray(marker)) return { preset: incoming, restored: [] }
  const extensions: Record<string, unknown> = { ...incoming.extensions }
  delete extensions[OMITTED_EXTENSIONS_KEY]
  const restored: string[] = []
  for (const key of marker) {
    if (typeof key !== 'string') continue
    /*
     * Only when the card did not supply the key itself. A card that built
     * `extensions.tavern_helper` deliberately is replacing it, and restoring
     * over that would make the write silently not happen — the mirror image of
     * the loss this function exists to prevent.
     */
    if (key in extensions) continue
    const value = stored?.extensions?.[key]
    if (value === undefined) continue
    extensions[key] = value
    restored.push(key)
  }
  return { preset: { ...incoming, extensions }, restored }
}

/**
 * A fresh identifier for a prompt that has none, or whose id collided.
 *
 * Upstream calls SillyTavern's `uuidv4`. `crypto.randomUUID` is the same shape
 * in both trust domains this module serves and keeps the package's
 * no-dependency contract; the fallback is for a host started under an older
 * runtime, where a colliding id must still get *some* fresh name rather than
 * take the write down.
 * @returns a v4-shaped identifier.
 */
function randomId(): string {
  const source = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof source?.randomUUID === 'function') return source.randomUUID()
  return `iris-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
