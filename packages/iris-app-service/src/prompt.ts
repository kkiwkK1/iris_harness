/**
 * Turning a character, a preset and a world book into prompt contributions.
 *
 * This is the assembly *policy*; `@iris/pipeline` is the assembly mechanism and
 * `@iris/preset` is the file format. Keeping the three apart is what lets a
 * preset be swapped without touching the pipeline, and the pipeline's budget
 * rules be changed without touching preset semantics.
 *
 * Rebuilt on every generation rather than cached, because world-info activation
 * depends on the conversation as it stands: a scan run before the user's last
 * message would inject the wrong entries.
 *
 * @module @iris/app-service/prompt
 */

import type { CharacterCard } from '@iris/character'
import {
  activateEntries,
  fromCharacterBook,
  promptRole,
  type ActivationSettings,
  type LorebookEntry,
  type PositionBuckets,
  type PreparedEntry,
  type ScanEntry,
  type TimedEffectState,
} from '@iris/lorebook'

import type { InsertionStrategy } from '@iris/protocol'
import { isEntropic } from './cache-friendly.ts'
import type { ResolvedWorldbook } from './worldbooks.ts'
import type { ActivePersona } from './persona.ts'
import { DEFAULT_WORLDBOOK_SETTINGS } from './worldbook-settings.ts'
import { createMacroContext, expandMacros, type MacroMessage } from '@iris/macro'
import type {
  Contribution,
  ContributionMember,
  HistoryEntry,
  Role,
  TokenCounter,
} from '@iris/pipeline'
import {
  HISTORY_IDENTIFIER,
  normalizeGenerationType,
  resolveOrder,
  resolvePreset,
  shouldTrigger,
  type ChatCompletionPreset,
  type MarkerSources,
  type PromptItem,
  type ResolveOptions,
} from '@iris/preset'

/**
 * One chat-bound book's entries, tagged with its name.
 *
 * Upstream's `chatLore` (`world-info.js:4430`): `chat_metadata.world_info`
 * holds a **book name**, and the book is loaded fresh at every scan — which is
 * the point of the source. A chat book is the one body of world info a card
 * writes *during play* (`getOrCreateChatWorldbook`), so a resolution taken when
 * the chat opened would miss every entry the card added since.
 */
export interface ChatLoreBook {
  /** The book's name, as `chat_metadata.world_info` spells it. */
  world: string
  /** Its entries, normalized. */
  entries: LorebookEntry[]
}

/**
 * The preset used when the composition names none.
 *
 * Deliberately thin: it is the marker skeleton every Chat Completion preset
 * shares, with no opinions of its own, so a card's own `system_prompt` and
 * `post_history_instructions` are what actually shape the reply. `prompt_order`
 * is omitted so the list order is the order.
 */
export const DEFAULT_PRESET: ChatCompletionPreset = {
  prompts: [
    {
      identifier: 'main',
      role: 'system',
      content: "Write {{char}}'s next reply in a fictional roleplay between {{char}} and {{user}}. Stay in character and never write {{user}}'s actions or dialogue.",
    },
    { identifier: 'worldInfoBefore', marker: true },
    { identifier: 'personaDescription', marker: true },
    { identifier: 'charDescription', marker: true },
    { identifier: 'charPersonality', marker: true },
    { identifier: 'scenario', marker: true },
    { identifier: 'worldInfoAfter', marker: true },
    { identifier: 'dialogueExamples', marker: true },
    { identifier: 'chatHistory', marker: true },
    // Empty by default; a card's post-history instructions land here, and
    // `resolvePreset` drops the item when there is nothing to put in it.
    { identifier: 'jailbreak', role: 'system', content: '' },
  ],
}

/**
 * The format strings a preset may carry, and what they default to.
 *
 * Upstream defaults (`openai.js:106-113`): `wi_format` is `'{0}'`, so world
 * info joins with no wrapper; `scenario_format` and `personality_format` are
 * the bare macros, so the Chat Completion path sends raw scenario and
 * personality text. Real presets do override them — measured on this machine's
 * install: `[Circumstances and context of the dialogue: {{scenario}}]` — and a
 * preset that does is sending the model a different prompt than the bare
 * fields would produce.
 */
const DEFAULT_WI_FORMAT = '{0}'
const DEFAULT_SCENARIO_FORMAT = '{{scenario}}'
const DEFAULT_PERSONALITY_FORMAT = '{{personality}}'

/**
 * Read one format string off a preset, falling back to upstream's default.
 * @param preset - the preset file.
 * @param key - the file's snake_case key.
 * @param fallback - the upstream default.
 * @returns the format string.
 */
function formatOf(preset: ChatCompletionPreset, key: string, fallback: string): string {
  const value = preset[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/**
 * Fill a preset's world-info wrapper, upstream's `formatWorldInfo`.
 *
 * The `{0}` placeholder is `stringFormat`, not a macro, and gets no expansion
 * pass of its own — macros in a `wi_format` ride through to the general
 * expansion below, exactly as they do upstream, where the world info block is
 * formatted before prompts are parameter-substituted.
 * @param value - the joined entries; empty stays empty.
 * @param format - the preset's `wi_format`.
 * @returns the wrapped block.
 */
function formatWorldInfo(value: string, format: string): string {
  if (value.length === 0) return ''
  if (format.trim().length === 0) return value
  return format.replace('{0}', value)
}

/** Everything one assembly needs that is not the conversation itself. */
export interface PromptInput {
  /** The character being played, or absent for a chat with no card. */
  card: CharacterCard | undefined
  /**
   * Which book the world info comes from, chosen by the caller.
   *
   * Passed in rather than derived here, because the choice between a card's
   * embedded book and its bound named book has to be the same one every
   * consumer makes — see `resolveCardWorldbook`. Absent falls back to the
   * embedded book, which is what a caller with no world book store can see.
   */
  worldbook?: ResolvedWorldbook
  preset: ChatCompletionPreset
  /** Name shown for the user, and what `{{user}}` expands to. */
  userName: string
  /** Name shown for the character, and what `{{char}}` expands to. */
  characterName: string
  /** The conversation so far, oldest first. */
  history: readonly HistoryEntry[]
  /** The same counter the budget uses, so world info is measured in real tokens. */
  count: TokenCounter
  /** Tokens world info may spend. */
  worldInfoBudget: number
  /** Sticky and cooldown windows carried from the previous turn. */
  timedEffects?: TimedEffectState
  /**
   * The chat-bound book's entries, read fresh per assembly by the caller.
   *
   * Upstream assembles `[...chatLore, ...personaLore, ...rest]` — chat lore
   * first, ahead of the strategy ordering — so these entries compete for budget
   * before everything else. Absent means the chat binds no book, which is the
   * normal state.
   */
  chatLore?: readonly ChatLoreBook[]
  /**
   * The scan knobs, from the stored world-info settings.
   *
   * Absent fields take the engine's defaults, which are ST's shipped values —
   * so an absent argument is the same answer a fresh installation gives, and a
   * caller that has settings passes them through untouched.
   */
  activationSettings?: Partial<ActivationSettings>
  /**
   * `world_info_include_names` — whether the scan buffer carries speaker names.
   *
   * Its own input rather than a field of {@link activationSettings}, because
   * it is not an engine knob: it shapes the buffer *before* the engine sees
   * it, exactly as upstream applies it while building `chatForWI` rather than
   * inside `getWorldInfoPrompt`. Absent takes ST's shipped `true`
   * (`world-info.js:74`).
   */
  includeNames?: boolean
  /**
   * How the global and character books interleave, from the same stored
   * settings. Defaults to `character_first`, which is both ST's shipped value
   * and the measured installation's.
   */
  insertionStrategy?: InsertionStrategy
  /**
   * The generation type this prompt is assembled for, in upstream's vocabulary
   * (`'normal'`, `'continue'`, `'impersonate'`, …). Passed to the preset
   * resolver, where it drives the `injection_trigger` filter and the rule that
   * a continue carries no post-history section. Absent means `'normal'`.
   */
  generationType?: string
  /**
   * The chat's own macro expander, replacing the one built here.
   *
   * Supplied so that Tavern Helper's `{{get_*_variable::}}` and
   * `{{format_*_variable::}}` reach world-info content and depth prompts, which
   * is where the corpus writes them — MVU's `[mvu_update]` entries show the
   * model its current state through exactly these. Expanding only
   * `@iris/macro`'s family here left the braces in the prompt, and a model asked
   * to patch a state it cannot see answers with no patch at all.
   *
   * Optional because it needs a chat: a caller with only a card (a preview, a
   * test) still gets `{{char}}` and `{{user}}`.
   */
  substitute?: (text: string) => string
  /**
   * The conversation as macros see it, oldest first: `{{lastMessage}}` and the
   * floor-addressing family read this when no chat expander was supplied.
   *
   * Optional, because the usual caller passes `substitute` — a live chat's
   * expander already sees the floors — and this keeps a card-only caller honest
   * rather than inventing an empty conversation for it.
   */
  chat?: readonly MacroMessage[]
  /**
   * Receives the world-info outlet buckets once the scan has filled them.
   *
   * Upstream parks the activated outlet entries in `extension_prompts` and every
   * later `{{outlet::key}}` reads them back from there; the sink is that store's
   * seam. Called after the scan and before the preset's own text is expanded, so
   * a preset prompt asking for an outlet sees this turn's buckets — which is
   * upstream's order too (`setExtensionPrompt` runs before the prompt is
   * rendered). World-info content expanding *during* the scan still sees the
   * previous buckets, which is also upstream's order.
   */
  outletSink?: (outlets: Record<string, string>) => void
  /**
   * The active user persona, resolved over upstream's defaults by the caller
   * (`PersonaStore.active`). Absent — no persona, or an empty description — is
   * the state every install starts in, and it assembles the identical prompt:
   * the marker stays empty, the scan data carries an empty persona description,
   * and `{{persona}}` expands to nothing, exactly as before a store existed.
   */
  persona?: ActivePersona
}

/** The assembled policy for one generation. */
export interface PromptResult {
  contributions: Contribution[]
  /** Windows to carry into the next turn. */
  timedEffects: TimedEffectState
  /** World-info entries that fired, for diagnostics. */
  activated: PreparedEntry[]
  /**
   * Contribution ids whose **pre-expansion** text carries a feature that makes
   * it render differently next turn — see `cache-friendly.ts`.
   *
   * Computed here because this is the last layer that still has the text as its
   * author wrote it. Everything in {@link PromptResult.contributions} is
   * already expanded, so a `{{roll}}` has become a number and no downstream
   * consumer can tell it from a constant.
   *
   * A **prediction**, and only used on a contribution's first sighting; from
   * the second turn the host compares content hashes instead. The set is
   * reported rather than applied so the two instruments stay separable —
   * "predicted" and "measured" are different claims about the same id.
   */
  entropic: string[]
}

/** Map a world-info injection role onto the pipeline's vocabulary. */
function roleOf(value: number): Role {
  if (value === promptRole.USER) return 'user'
  if (value === promptRole.ASSISTANT) return 'assistant'
  return 'system'
}

/**
 * Flatten every open book into the scan list, in upstream's order.
 *
 * A transcription of `getSortedEntries` (`world-info.js:4478`) rather than an
 * interpretation of it, because order is behaviour twice over: it breaks
 * activation ties, and it decides who reaches the budget first.
 *
 * The rules, in order:
 *
 * 1. **Chat lore first, unconditionally** — upstream's own comment says so
 *    (`world-info.js:4512`). A chat book's entries compete for budget ahead of
 *    every other source.
 * 2. Then the strategy result, and the strategy orders **only** the global and
 *    character books. `character_first` sorts each group separately and
 *    concatenates, so *every* character entry precedes *every* global one
 *    however their `order` fields compare; `evenly` and `global_first` sort the
 *    concatenation, where ties go to whichever source was concatenated first.
 * 3. Ties inside a sort keep insertion order — the sort is stable and upstream
 *    adds no tiebreak. The `uid` tiebreak an earlier version appended here was
 *    a tidiness the upstream does not have.
 *
 * The per-source dedup guards travel with their sources (`getChatLore` and
 * `getCharacterLore`, `world-info.js:4380-4449`): a chat book already globally
 * selected is skipped, and a character book is skipped when it is globally
 * selected **or** is the chat's book. The character guard is **per book**,
 * because upstream's `getCharacterLore` walks one `worldsToSearch` set — the
 * primary binding plus the host-stored extras — and tests each name against the
 * global and chat selections on its own turn through the loop. A host-stored
 * extra that names the chat's book loses; the primary's loss does not take the
 * extras down with it. Persona lore is absent — Iris has no persona store yet —
 * so its guard has nothing to guard.
 * @param card - the character whose book to read.
 * @param chosen - the resolved named/embedded book plus the global selection.
 * @param chatLore - the chat-bound book's entries, read fresh by the caller.
 * @param strategy - the stored insertion strategy.
 * @returns scan entries, or an empty list when nothing is open.
 */
export function scanEntriesOf(
  card: CharacterCard | undefined,
  chosen?: ResolvedWorldbook,
  chatLore: readonly ChatLoreBook[] = [],
  strategy: InsertionStrategy = 'character_first',
): ScanEntry[] {
  // Without a resolver this is the embedded book, which is what a caller with
  // no world book store can see. A host always passes `chosen`.
  const embedded = (): { entries: ScanEntry[], world: string } => {
    const book = card?.data.character_book
    if (book === undefined) return { entries: [], world: card?.data.name ?? 'character book' }
    try {
      const world = card?.data.name ?? 'character book'
      return { entries: Object.values(fromCharacterBook(book).entries).map(entry => ({ ...entry, world })) , world }
    } catch {
      // A book Iris cannot read is a reason to play the character without it,
      // not a reason to refuse the chat.
      return { entries: [], world: card?.data.name ?? 'character book' }
    }
  }

  const characterEntries: ScanEntry[] = chosen !== undefined
    ? chosen.entries.map(entry => ({ ...entry, world: chosen.world }))
    : embedded().entries
  const characterWorld = chosen !== undefined ? chosen.world : (card?.data.name ?? 'character book')
  const globalEntries: ScanEntry[] = chosen !== undefined
    ? chosen.global.flatMap(book => book.entries.map(entry => ({ ...entry, world: book.world })))
    : []

  // The dedup guards, each cutting its own source exactly as its upstream
  // getter does. A chat book already globally selected is skipped here — that
  // is `getChatLore`'s guard; a character book that is globally selected or *is*
  // the chat's book never reaches the sort at all, which is `getCharacterLore`'s
  // (`world-info.js:4387-4396`). The character guard is per book: the primary's
  // world is tested on its own, and each host-stored extra on its own, because
  // upstream walks one search set name by name. A source that loses its guard
  // contributes no entries, rather than contributing entries that lose their
  // `world` tag.
  const globalNames = new Set(chosen?.global.map(book => book.world) ?? [])
  const chatNames = new Set(chatLore.map(book => book.world))
  const chatBooks = chatLore.filter(book => !globalNames.has(book.world))
  const primaryAdmitted = !globalNames.has(characterWorld) && !chatNames.has(characterWorld)
  // The host-stored extras (`charLore.extraBooks`), after the primary, in the
  // order the user bound them — upstream's Set preserves insertion order, so
  // the extras follow the primary in the search and in the scan list.
  const additionalEntries: ScanEntry[] = (chosen?.additional ?? [])
    .filter(book => !globalNames.has(book.world) && !chatNames.has(book.world))
    .flatMap(book => book.entries.map(entry => ({ ...entry, world: book.world })))
  const characterEntriesAdmitted: ScanEntry[] = [
    ...(primaryAdmitted ? characterEntries : []),
    ...additionalEntries,
  ]

  // `sortFn` upstream: descending `order`, stable, no tiebreak. Array sort is
  // stable in every runtime this runs on.
  const byOrder = (a: ScanEntry, b: ScanEntry): number => b.order - a.order

  // The strategy switch, spelled exactly as upstream's (`world-info.js:4496`):
  // which arrays are sorted *before* concatenation is the whole difference
  // between the three values.
  let ordered: ScanEntry[]
  switch (strategy) {
    case 'character_first':
      ordered = [...characterEntriesAdmitted].sort(byOrder).concat([...globalEntries].sort(byOrder))
      break
    case 'global_first':
      ordered = [...globalEntries].sort(byOrder).concat([...characterEntriesAdmitted].sort(byOrder))
      break
    case 'evenly':
    default:
      // Upstream's default branch also logs an error and falls back here, for
      // any strategy value it does not know.
      ordered = [...globalEntries, ...characterEntriesAdmitted].sort(byOrder)
      break
  }

  // Chat lore always goes first, then persona lore, then the rest
  // (`world-info.js:4513`). Persona lore: no persona store yet.
  const chatEntries = chatBooks.flatMap(book => book.entries.map(entry => ({ ...entry, world: book.world })))
  return [...chatEntries.sort(byOrder), ...ordered]
}

/**
 * The entries of a bucket that put text in the prompt.
 *
 * The drop-empty rule {@link joinEntries} applies, lifted out so a caller that
 * needs the entries *and* the joined text works from one list rather than
 * filtering twice and hoping the two agree by index.
 * @param entries - a position bucket.
 * @returns the entries whose rendered content is not blank, in order.
 */
function contributingEntries(entries: readonly PreparedEntry[]): PreparedEntry[] {
  return entries.filter(entry => entry.content.trim().length > 0)
}

/** Join a bucket's entries into one block of prompt text. */
function joinEntries(entries: readonly PreparedEntry[]): string {
  return contributingEntries(entries).map(entry => entry.content).join('\n')
}

/**
 * One member per entry of a depth bucket.
 *
 * The join is upstream's and stays exactly as it is — a depth bucket reaches
 * the model as one newline-separated message whatever this
 * returns. What the members add is a **name and a hash per entry**, so the
 * cache classifier can ask "did this entry change" instead of "did this bucket
 * change", and the assembler can put the stable ones in the prefix. See
 * `ContributionMember`: on 爱衣 the bucket's three entries are byte-identical
 * between adjacent turns and the bucket's own hash still moves every turn,
 * because the *set* of them moves.
 *
 * The same filter as the join, in the same order, so
 * `members.map(m => m.text).join('\n')` is the bucket's text by construction —
 * which is the invariant the assembler re-checks before it splits anything.
 * The separator is written out on both sides rather than shared through one
 * constant, for the reason `SYSTEM_JOIN` and the squash separator are: they are
 * two independent upstream lines. What keeps them honest is that the assembler
 * refuses a member list that does not rejoin, and
 * `depth-bucket-entries.test.ts` fails if the two ever part company — so the
 * cost of the duplication is a red test, not a silently unsplit bucket.
 *
 * **Identity is `world` plus `uid`, prefixed by the bucket's id.** Uids collide
 * constantly across a global book, a character book and a chat book
 * (`PreparedEntry`'s own note), and the bucket prefix keeps one entry that sits
 * in two buckets — different depth, different role — from answering to one
 * name. The label is the entry's `comment`, which is what SillyTavern's own
 * editor shows, falling back to the book and uid rather than to nothing: this
 * is routinely the largest row in the itemization and `#13` alone names nothing.
 * @param bucketId - the contribution id the members belong to.
 * @param entries - the bucket's {@link contributingEntries}, in emission order.
 * @returns one member per entry.
 */
function bucketMembers(bucketId: string, entries: readonly PreparedEntry[]): ContributionMember[] {
  return entries.map(entry => ({
    id: `${bucketId}#${entry.world}.${String(entry.uid)}`,
    label: entry.comment.trim().length > 0
      ? entry.comment
      : `${entry.world} #${String(entry.uid)}`,
    text: entry.content,
  }))
}

/**
 * The same join taken over the entries **as authored**, for the cache classifier.
 *
 * {@link joinEntries} reads `content`, which the scan has already rewritten with
 * this turn's expansions; `source` is what the author wrote. Joined the same way
 * so a macro cannot fall in a seam between two entries.
 * @param entries - a position bucket.
 * @returns the bucket's pre-expansion text.
 */
function joinSources(entries: readonly PreparedEntry[]): string {
  return entries.map(entry => entry.source).filter(text => text.trim().length > 0).join('\n')
}

/**
 * One outlet bucket per key, joined as upstream joins them onto the prompt.
 *
 * `script.js` writes each outlet's activated entries with `value.join('\n')`;
 * {@link joinEntries} is that join, plus the drop-empty rule every other bucket
 * applies, so an entry that rendered to nothing leaves no blank line behind.
 * @param buckets - the scan's outlet buckets, keyed by `outletName`.
 * @returns the prompt-ready text per key.
 */
function outletPromptsOf(buckets: PositionBuckets['outlets']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(buckets).map(([key, entries]) => [key, joinEntries(entries)]),
  )
}

/**
 * Resolve `{{original}}` in an override against the text it replaced.
 *
 * The macro's whole job is *additive* overriding: a card writes
 * `{{original}}\n\n<its own rules>` to keep the preset's main prompt and append
 * to it. Upstream supplies the replaced text as the substitution's `original`
 * key — `preparePrompt(systemPrompt, mainOriginalContent)` at
 * `openai.js:1491-1492`, reaching `substituteParams(prompt.content, { original })`
 * at `PromptManager.js:1281-1284`.
 *
 * Resolved **here**, on the override itself, rather than by widening the macro
 * context: `original` is the only macro whose value differs per prompt item, and
 * the context that expands the preset is built once for the whole turn. Doing it
 * at the substitution site is also where upstream does it.
 *
 * One shot, as upstream's registry gives it: the first occurrence takes the
 * text, and any later one falls through to `@iris/macro`'s `original` builtin,
 * which yields `''` on a second read (`registry.ts:332`, `builtins.ts:140`).
 * @param override - the card's replacement text.
 * @param original - the preset item's own content, which it replaces.
 * @returns the override with its first `{{original}}` filled in.
 */
function substituteOriginal(override: string, original: string): string {
  const at = override.indexOf('{{original}}')
  if (at < 0) return override
  return override.slice(0, at) + original + override.slice(at + '{{original}}'.length)
}

/**
 * Apply a card's overrides to the preset it will be rendered with.
 *
 * SillyTavern lets a card replace the preset's main prompt and its post-history
 * instructions, unless the preset item forbids it. Cards rely on this heavily —
 * a card's whole voice is often in `system_prompt` — so a preset that silently
 * won a card's override would make most of the library play wrong.
 *
 * A replacement is not necessarily a deletion: see {@link substituteOriginal}
 * for `{{original}}`, which is how a card *extends* the preset's prompt instead
 * of discarding it. Measured over the 33 cards in the two local profiles, none
 * uses it and only one carries a non-empty `system_prompt` at all — so this is
 * a correctness fix with no measured effect on the present corpus, kept because
 * the failure mode is silent and total (the preset's main prompt vanishes).
 *
 * Not gated on upstream's `prefer_character_prompt` / `prefer_character_jailbreak`
 * (`power-user.js:203-204`), which decide whether the override is offered at
 * all; both ship `true` and neither rides in a preset file, so applying the
 * override unconditionally is upstream's default behaviour and the gate is a
 * settings surface this host does not have.
 * @param preset - the configured preset.
 * @param card - the character, or absent.
 * @returns a preset with the overrides applied; the input is not mutated.
 */
export function applyCardOverrides(
  preset: ChatCompletionPreset,
  card: CharacterCard | undefined,
): ChatCompletionPreset {
  if (card === undefined) return preset

  const overrides: [string, string][] = [
    ['main', card.data.system_prompt],
    ['jailbreak', card.data.post_history_instructions],
  ]

  let prompts: PromptItem[] = preset.prompts
  for (const [identifier, text] of overrides) {
    if (text.trim().length === 0) continue
    prompts = prompts.map(item =>
      item.identifier === identifier && item.forbid_overrides !== true
        ? { ...item, content: substituteOriginal(text, item.content ?? ''), marker: false }
        : item)
  }
  return { ...preset, prompts }
}

/**
 * The marker slots this generation had and could not fill, as zero-token rows.
 *
 * `itemize` promises this and cannot deliver it alone: "counted from the
 * contributions rather than from the rendered request, so a part that
 * contributed nothing still appears with a zero — a user looking for why a
 * section is missing is better served by a zero than by an absence"
 * (`@iris/pipeline`'s `assemble.ts`). But `resolvePreset` drops an item whose
 * text is empty before a contribution exists (`chat-completion.ts:247`,
 * `if (text.trim().length === 0) continue`), so the row it would have zeroed is
 * never offered. The panel then shows no `worldInfoBefore` line at all on a
 * turn where no world info fired — which is the exact question the panel is
 * opened to answer, and the absence reads as "Iris does not implement that
 * slot".
 *
 * **Markers only.** A marker is a slot the *host* fills — world info, the
 * character's description, the persona — so its emptiness is a fact about this
 * turn and worth a row. A preset item with empty `content` is a prompt its
 * author left blank; a row per blank would add dozens of them to a real preset
 * and say nothing about the turn.
 *
 * The natural home for this is `resolvePreset` itself, which is the function
 * that decides to drop them; it lives here because this round's write scope is
 * the app service. The consequence of the split is that the rows are appended
 * after the preset's own contributions rather than interleaved into it, so the
 * itemization lists them together after the sections that produced text —
 * `itemize` maps contributions in array order.
 * @param preset - the preset, card overrides already applied.
 * @param options - the same resolve options the contributions were built with.
 * @param resolved - what the preset actually contributed.
 * @returns one zero row per empty marker slot, in the preset's own order.
 */
function emptyMarkerRows(
  preset: ChatCompletionPreset,
  options: ResolveOptions,
  resolved: readonly Contribution[],
): Contribution[] {
  const contributed = new Set(resolved.map(item => item.id))
  const byIdentifier = new Map(preset.prompts.map(item => [item.identifier, item]))
  const generationType = normalizeGenerationType(options.generationType)
  const rows: Contribution[] = []
  let afterHistory = false

  for (const identifier of resolveOrder(preset, options)) {
    // The conversation's own row is `itemize`'s aggregate, not a marker slot.
    if (identifier === HISTORY_IDENTIFIER) {
      afterHistory = true
      continue
    }
    if (contributed.has(identifier)) continue
    const item = byIdentifier.get(identifier)
    if (item?.marker !== true) continue
    // The two reasons a slot can be absent that are NOT "it was empty": this
    // generation type drops the whole post-history section (a continue), or the
    // item's own `injection_trigger` excludes it. Zeroing those would claim the
    // slot was offered and came out empty, when it was never offered.
    if (afterHistory && generationType === 'continue') continue
    if (!shouldTrigger(item, generationType)) continue
    rows.push({
      id: identifier,
      ...item.name === undefined ? {} : { label: item.name },
      // `order` is unobservable for a row with no text — `renderSystem` drops
      // empty text before it sorts, and the itemization renders array order —
      // so this is a placement the type demands rather than a decision.
      placement: { kind: 'system', order: 0 },
      text: '',
    })
  }
  return rows
}

/**
 * Build one generation's contributions.
 * @param input - character, preset, conversation and budget.
 * @returns the contributions, the timed-effect state to carry forward, and what fired.
 */
export function buildPrompt(input: PromptInput): PromptResult {
  const data = input.card?.data
  // Rebound after the scan, because the outlets do not exist until it has run:
  // expansions before that (world-info content) read the previous buckets,
  // expansions after (the preset's own text) read this turn's. That is the same
  // order upstream's `extension_prompts` round-trip produces.
  let outlets: Record<string, string> = {}
  const macros = createMacroContext({
    char: input.characterName,
    user: input.userName,
    // The persona description, what upstream's `{{persona}}` expands to —
    // the *description*, never the name (`script.js:3352`, the persona row of
    // the macro environment, which trims: `persona_description?.trim()`). Empty
    // when no persona is active, which is also what the macro expanded to
    // before a persona store existed, so the default is unchanged. The slot and
    // the depth injection below keep the stored text verbatim — upstream only
    // trims the macro read.
    persona: input.persona?.description.trim() ?? '',
    // The card fields, so a preset's format strings can say `{{scenario}}` or
    // `{{personality}}` — which is what upstream's own defaults do, and what
    // real presets copy. Without them the format would degrade to its own
    // braces, a worse prompt than no format at all.
    character: {
      ...data?.description === undefined ? {} : { description: data.description },
      ...data?.personality === undefined ? {} : { personality: data.personality },
      ...data?.scenario === undefined ? {} : { scenario: data.scenario },
    },
    ...(input.chat === undefined ? {} : { chat: input.chat }),
    outlet: key => outlets[key] ?? '',
  })
  const expand = input.substitute ?? ((text: string): string => expandMacros(text, macros))

  const includeNames = input.includeNames ?? DEFAULT_WORLDBOOK_SETTINGS.includeNames
  const scan = activateEntries({
    entries: scanEntriesOf(input.card, input.worldbook, input.chatLore, input.insertionStrategy),
    // Upstream's own line, both branches of it (`script.js:4565`):
    //
    //   coreChat.map(x => world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse()
    //
    // Newest-first, the order ST scans in. The prefix goes only into the scan
    // buffer — the model never sees it — so this changes which entries fire,
    // not a single token of the request. An entry keyed on a character's name
    // fires on every line that character spoke when it is on, and only on
    // lines that say the name when it is off.
    //
    // **The name is derived from the role**, as `historyFromSession` derives
    // it, rather than read from the line's stored `name`. For a one-to-one
    // chat those agree; for a chat imported from an install whose lines carry
    // their own speakers they can differ, and upstream would use the stored
    // one. Named rather than fixed here because every other consumer of
    // `HistoryEntry.name` already has this shape, and changing it is a change
    // to the projection rather than to this line.
    chat: [...input.history].reverse().map(entry => (
      includeNames && entry.name !== undefined ? `${entry.name}: ${entry.text}` : entry.text
    )),
    budget: input.worldInfoBudget,
    countTokens: input.count,
    substituteMacros: expand,
    // The stored scan knobs, resolved over defaults by the caller. Absent
    // fields fall back to ST's shipped values inside the engine.
    ...input.activationSettings === undefined ? {} : { settings: input.activationSettings },
    ...input.timedEffects === undefined ? {} : { timedEffects: input.timedEffects },
    globalScanData: {
      // The persona description joins the scan **regardless of position** —
      // upstream fills `globalScanData.personaDescription` from the active
      // persona unconditionally (`script.js:4568`), so a `matchPersonaDescription`
      // entry fires on it even at `none`, where the prompt itself never shows it.
      personaDescription: input.persona?.description ?? '',
      characterDescription: data?.description ?? '',
      characterPersonality: data?.personality ?? '',
    },
  })
  outlets = outletPromptsOf(scan.buckets.outlets)
  input.outletSink?.(outlets)

  // The preset's own wrappers, applied the way upstream applies them
  // (`preparePromptsForChatCompletion` + `formatWorldInfo`): a format that
  // carries macros is expanded once, here. Expanded with the local context —
  // not the chat's — because a chat's expander carries no card fields, and the
  // whole point of these formats is naming them.
  const wiFormat = formatOf(input.preset, 'wi_format', DEFAULT_WI_FORMAT)
  const scenarioFormat = expandMacros(formatOf(input.preset, 'scenario_format', DEFAULT_SCENARIO_FORMAT), macros)
  const personalityFormat = expandMacros(formatOf(input.preset, 'personality_format', DEFAULT_PERSONALITY_FORMAT), macros)
  const scenario = data?.scenario ?? ''
  const personality = data?.personality ?? ''

  const markers: MarkerSources = {
    worldInfoBefore: formatWorldInfo(joinEntries(scan.buckets.before), wiFormat),
    worldInfoAfter: formatWorldInfo(joinEntries(scan.buckets.after), wiFormat),
    // The persona's IN_PROMPT position is exactly upstream's Chat Completion
    // rule (`openai.js:1424`): a system prompt at the `personaDescription`
    // slot, only when the description exists **and** the position is IN_PROMPT.
    // Every other position leaves the marker empty here — `atdepth` injects
    // below, `none` keeps the text out of the prompt entirely.
    personaDescription: input.persona?.position === 'inprompt' ? input.persona.description : '',
    charDescription: data?.description ?? '',
    // Empty fields stay empty whatever the format says: upstream's `scenario
    // &&` guard means a format string never manufactures content from nothing.
    charPersonality: personality === '' ? '' : personalityFormat,
    scenario: scenario === '' ? '' : scenarioFormat,
    dialogueExamples: [
      joinEntries(scan.buckets.emTop),
      data?.mes_example ?? '',
      joinEntries(scan.buckets.emBottom),
    ].filter(text => text.trim().length > 0).join('\n'),
  }

  // The same table taken over the text **as authored**, for the cache
  // classifier. A marker's contribution carries the marker's *filled* value, so
  // by the time `resolvePreset` has run the world info in `worldInfoAfter` is
  // already expanded and its `{{roll}}` is a number. This is the only place
  // both halves exist, which is why the parallel table is built rather than
  // recovered later. Keys must match `markers` exactly: a marker present here
  // and absent there would be classified against nothing.
  const markerSources: MarkerSources = {
    worldInfoBefore: joinSources(scan.buckets.before),
    worldInfoAfter: joinSources(scan.buckets.after),
    personaDescription: input.persona?.position === 'inprompt' ? input.persona.description : '',
    charDescription: data?.description ?? '',
    // The **unexpanded** formats, unlike `markers`: a `scenario_format` that
    // reads `{{time}}` makes the section volatile, and the expanded copy has
    // already lost the evidence.
    charPersonality: personality === ''
      ? ''
      : `${formatOf(input.preset, 'personality_format', DEFAULT_PERSONALITY_FORMAT)}\n${personality}`,
    scenario: scenario === ''
      ? ''
      : `${formatOf(input.preset, 'scenario_format', DEFAULT_SCENARIO_FORMAT)}\n${scenario}`,
    dialogueExamples: [
      joinSources(scan.buckets.emTop),
      data?.mes_example ?? '',
      joinSources(scan.buckets.emBottom),
    ].filter(text => text.trim().length > 0).join('\n'),
  }

  // Expanded once, here, over everything the preset produced. A preset's own
  // prompt text uses `{{char}}` as freely as a card's description does, so
  // expanding only the marker sources would leave the instruction that actually
  // shapes the reply talking about a character named "{{char}}".
  //
  // The preset and the options are named rather than inlined because the zero
  // rows below walk the same order with the same options: two calls that
  // resolved a *different* order would put a row on a slot this generation
  // never had.
  const preset = applyCardOverrides(input.preset, input.card)
  const resolveOptions: ResolveOptions = {
    markers,
    ...input.generationType === undefined ? {} : { generationType: input.generationType },
  }
  // Predicted-volatile ids, collected as each contribution is built, because
  // that is the only moment its authored text is in scope. See
  // `PromptResult.entropic`.
  const entropic = new Set<string>()
  const noteEntropic = (id: string, ...sources: (string | undefined)[]): void => {
    if (sources.some(text => text !== undefined && isEntropic(text))) entropic.add(id)
  }

  const contributions = resolvePreset(preset, resolveOptions)
    .map((contribution) => {
      // Two sources per row, and both are needed. A **marker**'s own text is
      // already the filled value (world info, expanded during the scan), so
      // `markerSources` is the authored half; a plain prompt's text is the
      // preset's `content`, still unexpanded at this point. Passing both means
      // one call covers markers and prompts without asking which this is.
      noteEntropic(contribution.id, contribution.text, markerSources[contribution.id])
      return { ...contribution, text: expand(contribution.text) }
    })

  // The slots that were there and had nothing to put in them, as zeroes.
  contributions.push(...emptyMarkerRows(preset, resolveOptions, contributions))

  // The author's-note buckets have no note of their own to sit around yet, so
  // they land as system sections after everything the preset ordered. Their
  // relative order is still honoured, which is what the two positions mean.
  const authorNote = [...scan.buckets.anTop, ...scan.buckets.anBottom]
  if (authorNote.length > 0) {
    noteEntropic('worldInfo.authorNote', joinSources(authorNote))
    contributions.push({
      id: 'worldInfo.authorNote',
      label: 'World Info (author’s note)',
      placement: { kind: 'system', order: 900 },
      text: joinEntries(authorNote),
    })
  }

  // Depth injections are the reason Iris assembles messages itself: they have
  // to sit a fixed number of turns from the END of the conversation, which a
  // system-prompt registry cannot express.
  for (const bucket of scan.buckets.atDepth) {
    const text = joinEntries(bucket.entries)
    if (text.trim().length === 0) continue
    const bucketId = `worldInfo.depth.${String(bucket.depth)}.${String(bucket.role)}`
    // Noted even though a depth placement is never *moved*: the mark is what
    // makes `stablePrefixTokens` stop at a volatile injection sitting **inside**
    // the conversation (depth ≥ 1), which is a loss the reorder cannot repair
    // and the reading has to be honest about.
    noteEntropic(bucketId, joinSources(bucket.entries))
    const present = contributingEntries(bucket.entries)
    const members = bucketMembers(bucketId, present)
    // **Per member, over the member's own pre-expansion text.** The bucket-wide
    // note above marks the whole bucket the moment *any* entry in it carries a
    // `{{roll}}`, which is the right answer for the bucket and the wrong one for
    // its neighbours: predicting them volatile too would hold every entry in
    // the bucket out of the prefix for the full 20-generation hold on the
    // strength of a die roll in one of them.
    present.forEach((entry, index) => {
      const member = members[index]
      if (member !== undefined) noteEntropic(member.id, entry.source)
    })
    contributions.push({
      id: bucketId,
      // Labelled because the itemization view renders labels, and a row reading
      // `worldInfo.depth.0.0` tells a user nothing about what is in it — this is
      // routinely the largest single part of the prompt.
      label: `World Info (depth ${String(bucket.depth)})`,
      placement: { kind: 'depth', depth: bucket.depth, role: roleOf(bucket.role), order: 0 },
      text,
      // The entries this text is the join of. The contribution stays one row
      // and one message; the members are what let the classifier and the
      // reorder work at the granularity the loss actually has. Nothing reads
      // them with cache-friendly assembly off.
      members,
    })
  }

  // The persona's AT_DEPTH position — upstream's `addPersonaDescriptionExtensionPrompt`
  // (`script.js:3163`): the description as an IN_CHAT extension prompt at
  // `persona_description_depth` (default 2) and `persona_description_role`
  // (default system). Same shape as the card's note below, which is why it
  // rides the same depth placement.
  if (input.persona?.position === 'atdepth') {
    noteEntropic('persona.depthPrompt', input.persona.description)
    contributions.push({
      id: 'persona.depthPrompt',
      label: 'Persona Description',
      placement: { kind: 'depth', depth: input.persona.depth, role: input.persona.role, order: 1 },
      text: expand(input.persona.description),
    })
  }

  // The character's note, ST's per-card depth prompt.
  const depthPrompt = data?.extensions.depth_prompt
  if (depthPrompt !== undefined && depthPrompt.prompt.trim().length > 0) {
    noteEntropic('card.depthPrompt', depthPrompt.prompt)
    contributions.push({
      id: 'card.depthPrompt',
      label: 'Character’s Note',
      // A card's depth prompt names its role in words, unlike a world-info
      // entry, which uses the numeric `promptRole` enum.
      placement: { kind: 'depth', depth: depthPrompt.depth, role: depthPrompt.role, order: 1 },
      text: expand(depthPrompt.prompt),
    })
  }

  return {
    contributions,
    timedEffects: scan.timedEffects,
    activated: scan.activated,
    entropic: [...entropic],
  }
}

/**
 * Macro-shaped tokens still present in a finished prompt.
 *
 * A macro that nothing expanded reaches the model as its own braces, and the
 * whole failure is silent: MVU's `{{format_message_variable::stat_data}}` went
 * out verbatim for a release, so the model was asked to patch a state it could
 * not see and answered with no patch — indistinguishable, from the outside, from
 * a model that will not follow the format.
 *
 * **No whitelist**, and that is a decision the corpus settled rather than a
 * default. Measured over the 19 cards on this machine — every field, every
 * greeting, every world-book entry — `{{name…}}` occurs under exactly **28
 * distinct heads and produces no false positives**: card prose and embedded JSON
 * do not trip it. A whitelist would need maintaining, and it would hide the one
 * case that matters, which is a macro nobody here has heard of. Among the 28 are
 * several a card's own script registers through Tavern Helper's
 * `registerMacroLike`, and one plain typo (`{{usre}}`) that upstream would not
 * have expanded either — both worth seeing.
 *
 * Only the head is returned, never the body: this feeds a log line, and a card's
 * text is not something to copy there.
 * @param text - the assembled prompt, after every expansion.
 * @returns each distinct macro head still present, in first-seen order.
 */
export function residualMacros(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(/\{\{\s*([A-Za-z_][\w.-]*)/g)) {
    const head = match[1]
    if (head !== undefined) seen.add(head.toLowerCase())
  }
  return [...seen]
}

/**
 * Split residual macros by which side the gap is on.
 *
 * A report that only lists names points at nobody, and a reader fills that in
 * with the nearest suspect — which for a prompt defect is always the card. The
 * split matters because the two cases need opposite responses: a macro this host
 * **implements** that survived to the provider is a bug here (the expansion did
 * not reach that text), while a name nothing implements is the card's own — a
 * typo like the corpus's `{{usre}}`, or a macro one of its scripts registers
 * through Tavern Helper, neither of which anyone here should go looking for.
 *
 * This is the same shape as an unattributed `ReferenceError`: the message is
 * accurate and still sends the reader to the wrong place.
 * @param names - the residual macro heads, from {@link residualMacros}.
 * @param implemented - whether this host has a macro by that name.
 * @returns the two groups.
 */
export function attributeResidualMacros(
  names: readonly string[],
  implemented: (name: string) => boolean,
): { ours: string[], theirs: string[] } {
  const ours: string[] = []
  const theirs: string[] = []
  for (const name of names) (implemented(name) ? ours : theirs).push(name)
  return { ours, theirs }
}
