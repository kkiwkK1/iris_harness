/**
 * SillyTavern's Chat Completion preset — the "prompt manager" — translated into
 * pipeline contributions.
 *
 * A preset is an ordered, toggleable list of prompt items plus a per-character
 * ordering. Two details in it are load-bearing and easy to get wrong:
 *
 *  - **`chatHistory` is a position, not content.** Items listed before it belong
 *    to the system prompt; items after it are what SillyTavern calls
 *    post-history instructions, and they have to land *after* the conversation
 *    — which is why they become depth-0 injections rather than more system text.
 *  - **`prompt_order` is keyed by character id with two magic values**:
 *    `100000` is the global default and `100001` the group default. A preset
 *    imported without them silently loses its ordering for every character.
 *
 * @module @iris/preset/chat-completion
 */

import type { Contribution, Role } from '@iris/pipeline'

/** Character-id sentinel for the ordering every character inherits. */
export const GLOBAL_ORDER_ID = 100000

/** Character-id sentinel for the ordering group chats inherit. */
export const GROUP_ORDER_ID = 100001

/**
 * The built-in prompt identifiers, in SillyTavern's own order.
 *
 * `marker` items carry no text of their own — they name a slot the frontend
 * fills with live data (the character's description, the activated world info,
 * the conversation itself).
 */
export const BUILTIN_IDENTIFIERS = [
  'main',
  'nsfw',
  'worldInfoBefore',
  'personaDescription',
  'charDescription',
  'charPersonality',
  'scenario',
  'enhanceDefinitions',
  'worldInfoAfter',
  'dialogueExamples',
  'chatHistory',
  'jailbreak',
] as const

/** One built-in identifier. */
export type BuiltinIdentifier = (typeof BUILTIN_IDENTIFIERS)[number]

/** The identifier marking where the conversation itself goes. */
export const HISTORY_IDENTIFIER = 'chatHistory'

/** One prompt item in a preset. */
export interface PromptItem {
  identifier: string
  name?: string
  role?: Role
  content?: string
  system_prompt?: boolean
  /** A slot filled with live data rather than literal text. */
  marker?: boolean
  /** `'relative'` follows the list order; `'absolute'` pins the item to a depth. */
  injection_position?: 'relative' | 'absolute' | number
  injection_depth?: number
  injection_order?: number
  forbid_overrides?: boolean
  [key: string]: unknown
}

/** One character's ordering of the prompt list. */
export interface PromptOrder {
  character_id: number
  order: { identifier: string, enabled: boolean }[]
}

/** A Chat Completion preset file. */
export interface ChatCompletionPreset {
  prompts: PromptItem[]
  prompt_order?: PromptOrder[]
  [key: string]: unknown
}

/** Live text for the marker slots, supplied per turn. */
export type MarkerSources = Partial<Record<string, string>>

/** How to resolve a preset into contributions. */
export interface ResolveOptions {
  /** Whose ordering to use; falls back to the global sentinel. */
  characterId?: number
  /** Text for `marker` items, keyed by identifier. */
  markers?: MarkerSources
  /** Treat the chat as a group, preferring the group ordering sentinel. */
  group?: boolean
}

/**
 * Pick the ordering that applies to one character.
 *
 * Falls back through the character's own entry, then the group or global
 * sentinel, then — for a preset that shipped without `prompt_order` at all —
 * the declared prompt list in file order.
 * @param preset - the preset file.
 * @param options - character identity and group flag.
 * @returns identifiers in the order they should be rendered.
 */
export function resolveOrder(preset: ChatCompletionPreset, options: ResolveOptions = {}): string[] {
  const orders = preset.prompt_order ?? []
  const fallbackId = options.group === true ? GROUP_ORDER_ID : GLOBAL_ORDER_ID
  const chosen = orders.find(entry => entry.character_id === options.characterId)
    ?? orders.find(entry => entry.character_id === fallbackId)
    ?? orders.find(entry => entry.character_id === GLOBAL_ORDER_ID)

  if (chosen === undefined) return preset.prompts.map(prompt => prompt.identifier)
  return chosen.order.filter(entry => entry.enabled).map(entry => entry.identifier)
}

/** Text an item contributes: live data for a marker, literal content otherwise. */
function textFor(item: PromptItem, markers: MarkerSources): string {
  if (item.marker === true) return markers[item.identifier] ?? ''
  return item.content ?? ''
}

/**
 * Translate a preset into pipeline contributions.
 *
 * Ordering is spaced by ten so a caller can interleave its own contributions
 * without renumbering the preset's.
 * @param preset - the preset file.
 * @param options - character identity, group flag, and marker text.
 * @returns contributions ready for `assemble`, excluding the conversation itself.
 */
export function resolvePreset(
  preset: ChatCompletionPreset,
  options: ResolveOptions = {},
): Contribution[] {
  const markers = options.markers ?? {}
  const byIdentifier = new Map(preset.prompts.map(prompt => [prompt.identifier, prompt]))
  const contributions: Contribution[] = []

  let afterHistory = false
  let order = 0

  for (const identifier of resolveOrder(preset, options)) {
    if (identifier === HISTORY_IDENTIFIER) {
      // Everything from here on is a post-history instruction.
      afterHistory = true
      order = 0
      continue
    }

    const item = byIdentifier.get(identifier)
    if (item === undefined) continue

    const text = textFor(item, markers)
    if (text.trim().length === 0) continue

    order += 10

    // An absolute injection ignores the list order entirely and pins itself a
    // fixed number of turns from the end of the conversation.
    const absolute = item.injection_position === 'absolute' || item.injection_position === 1
    if (absolute) {
      contributions.push({
        id: identifier,
        placement: {
          kind: 'depth',
          depth: item.injection_depth ?? 0,
          role: item.role ?? 'system',
          order: item.injection_order ?? order,
        },
        text,
      })
      continue
    }

    contributions.push({
      id: identifier,
      placement: afterHistory
        ? { kind: 'depth', depth: 0, role: item.role ?? 'system', order }
        : { kind: 'system', order },
      text,
    })
  }

  return contributions
}
