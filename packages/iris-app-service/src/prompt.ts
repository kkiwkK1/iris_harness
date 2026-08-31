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
  type PreparedEntry,
  type ScanEntry,
  type TimedEffectState,
} from '@iris/lorebook'
import { createMacroContext, expandMacros } from '@iris/macro'
import type { Contribution, HistoryEntry, Role, TokenCounter } from '@iris/pipeline'
import { resolvePreset, type ChatCompletionPreset, type MarkerSources, type PromptItem } from '@iris/preset'

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

/** Everything one assembly needs that is not the conversation itself. */
export interface PromptInput {
  /** The character being played, or absent for a chat with no card. */
  card: CharacterCard | undefined
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
}

/** The assembled policy for one generation. */
export interface PromptResult {
  contributions: Contribution[]
  /** Windows to carry into the next turn. */
  timedEffects: TimedEffectState
  /** World-info entries that fired, for diagnostics. */
  activated: PreparedEntry[]
}

/** Map a world-info injection role onto the pipeline's vocabulary. */
function roleOf(value: number): Role {
  if (value === promptRole.USER) return 'user'
  if (value === promptRole.ASSISTANT) return 'assistant'
  return 'system'
}

/**
 * Flatten a card's book into the scan list.
 *
 * The engine takes the order as given and only re-sorts by `order` when it
 * buckets the winners, so the caller's ordering is what breaks activation ties.
 * Descending `order` puts the entries an author weighted highest in front,
 * which is the behaviour an author expects from the field they set.
 * @param card - the character whose book to read.
 * @returns scan entries, or an empty list when the card ships no book.
 */
export function scanEntriesOf(card: CharacterCard | undefined): ScanEntry[] {
  const book = card?.data.character_book
  if (book === undefined) return []

  let entries: ScanEntry[]
  try {
    const parsed = fromCharacterBook(book)
    const world = card?.data.name ?? 'character book'
    entries = Object.values(parsed.entries).map(entry => ({ ...entry, world }))
  } catch {
    // A book Iris cannot read is a reason to play the character without it, not
    // a reason to refuse the chat.
    return []
  }
  return entries.sort((a, b) => b.order - a.order || a.uid - b.uid)
}

/** Join a bucket's entries into one block of prompt text. */
function joinEntries(entries: readonly PreparedEntry[]): string {
  return entries.map(entry => entry.content).filter(text => text.trim().length > 0).join('\n')
}

/**
 * Apply a card's overrides to the preset it will be rendered with.
 *
 * SillyTavern lets a card replace the preset's main prompt and its post-history
 * instructions, unless the preset item forbids it. Cards rely on this heavily —
 * a card's whole voice is often in `system_prompt` — so a preset that silently
 * won a card's override would make most of the library play wrong.
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
        ? { ...item, content: text, marker: false }
        : item)
  }
  return { ...preset, prompts }
}

/**
 * Build one generation's contributions.
 * @param input - character, preset, conversation and budget.
 * @returns the contributions, the timed-effect state to carry forward, and what fired.
 */
export function buildPrompt(input: PromptInput): PromptResult {
  const macros = createMacroContext({ char: input.characterName, user: input.userName })
  const expand = (text: string): string => expandMacros(text, macros)

  const scan = activateEntries({
    entries: scanEntriesOf(input.card),
    // The engine wants the conversation newest-first, the order ST scans in.
    chat: [...input.history].reverse().map(entry => entry.text),
    budget: input.worldInfoBudget,
    countTokens: input.count,
    substituteMacros: expand,
    ...input.timedEffects === undefined ? {} : { timedEffects: input.timedEffects },
    globalScanData: {
      characterDescription: input.card?.data.description ?? '',
      characterPersonality: input.card?.data.personality ?? '',
    },
  })

  const data = input.card?.data
  const markers: MarkerSources = {
    // `wi_format` defaults to a bare `{0}` upstream, so activated entries are
    // concatenated with no wrapper. Verified against ST 1.18.0's openai.js.
    worldInfoBefore: joinEntries(scan.buckets.before),
    worldInfoAfter: joinEntries(scan.buckets.after),
    charDescription: data?.description ?? '',
    // `personality_format` and `scenario_format` also default to bare
    // substitutions on the Chat Completion path — the "{{char}}'s personality:"
    // prefixes belong to the text-completion story string, not here.
    charPersonality: data?.personality ?? '',
    scenario: data?.scenario ?? '',
    dialogueExamples: [
      joinEntries(scan.buckets.emTop),
      data?.mes_example ?? '',
      joinEntries(scan.buckets.emBottom),
    ].filter(text => text.trim().length > 0).join('\n'),
  }

  // Expanded once, here, over everything the preset produced. A preset's own
  // prompt text uses `{{char}}` as freely as a card's description does, so
  // expanding only the marker sources would leave the instruction that actually
  // shapes the reply talking about a character named "{{char}}".
  const contributions = resolvePreset(applyCardOverrides(input.preset, input.card), { markers })
    .map(contribution => ({ ...contribution, text: expand(contribution.text) }))

  // The author's-note buckets have no note of their own to sit around yet, so
  // they land as system sections after everything the preset ordered. Their
  // relative order is still honoured, which is what the two positions mean.
  const authorNote = [...scan.buckets.anTop, ...scan.buckets.anBottom]
  if (authorNote.length > 0) {
    contributions.push({
      id: 'worldInfo.authorNote',
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
    contributions.push({
      id: `worldInfo.depth.${String(bucket.depth)}.${String(bucket.role)}`,
      placement: { kind: 'depth', depth: bucket.depth, role: roleOf(bucket.role), order: 0 },
      text,
    })
  }

  // The character's note, ST's per-card depth prompt.
  const depthPrompt = data?.extensions.depth_prompt
  if (depthPrompt !== undefined && depthPrompt.prompt.trim().length > 0) {
    contributions.push({
      id: 'card.depthPrompt',
      // A card's depth prompt names its role in words, unlike a world-info
      // entry, which uses the numeric `promptRole` enum.
      placement: { kind: 'depth', depth: depthPrompt.depth, role: depthPrompt.role, order: 1 },
      text: expand(depthPrompt.prompt),
    })
  }

  return { contributions, timedEffects: scan.timedEffects, activated: scan.activated }
}
