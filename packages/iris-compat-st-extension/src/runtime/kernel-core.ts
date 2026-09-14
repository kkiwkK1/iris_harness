/**
 * The extension-frame kernel's pure half: the facade state objects, the
 * hydrate/collect pair that carries them across the iframe edge, and the
 * errors and string helpers the facades share.
 *
 * **Stable identities are the contract.** The upstream bundle imports `chat`,
 * `chat_metadata` and `extension_settings` once and mutates them in place for
 * the lifetime of the page, so hydration must mutate the same objects rather
 * than replace them — a replaced object would leave every live import pointing
 * at state nobody writes to. Floor objects are reused across rounds when their
 * content is unchanged, so handlers that captured a `message` between rounds
 * still read current values.
 */

import type { StBridgeContext, StFloorSnapshot } from './protocol.ts'

/** Thrown by every facade member the pilot deliberately does not implement. */
export class UnsupportedStCompatApiError extends Error {
  readonly member: string

  constructor(member: string) {
    super(
      `${member} is not implemented by the Iris ST-compat layer (pilot scope). `
      + 'The extension called a SillyTavern API outside the mapped pilot surface; '
      + 'the mapped surface is listed in notes/st-compat/PILOT-DESIGN.md §4 and the acceptance report records every refusal.',
    )
    this.name = 'UnsupportedStCompatApiError'
    this.member = member
  }
}

/** Escape a string for safe inclusion in HTML text/attribute context. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/**
 * The pilot's `substituteParams`: a minimal, synchronous macro set, because the
 * upstream call sites run inside template helpers that must not await. Unknown
 * macros are passed through untouched — deleting them would hide a macro the
 * host was supposed to expand, and the host has already expanded everything it
 * knows by the time assembled text reaches the bridge.
 */
export function substituteMacrosMinimal(
  input: string,
  names: { userName: string, characterName: string },
  now: Date = new Date(),
): string {
  const resolved: Record<string, string> = {
    user: names.userName,
    char: names.characterName,
    persona: '',
    time: now.toTimeString().slice(0, 8),
    date: now.toISOString().slice(0, 10),
    weekday: WEEKDAYS[now.getDay()] ?? 'Sunday',
  }
  return input.replace(/\{\{(\w+)\}\}/gu, (match, name: string) => {
    const value = resolved[name]
    return value === undefined ? match : value
  })
}

/** Upstream `Message` shape, narrowed to the members the pilot's paths read. */
export interface StFacadeMessage {
  name: string
  is_user: boolean
  is_system: boolean
  mes: string
  swipe_id: number
  swipes?: string[]
  /** Message-scope variables keyed by swipe index — `chat[i].variables[swipe_id]` upstream. */
  variables: Record<string, Record<string, unknown>>
  is_ejs_processed: boolean[]
  [key: string]: unknown
}

function sameFloor(a: StFacadeMessage, floor: StFloorSnapshot): boolean {
  const vars = floor.variables ?? {}
  const existing = a.variables[0] ?? {}
  return a.mes === floor.mes
    && a.name === floor.name
    && a.is_user === floor.is_user
    && a.is_system === floor.is_system
    && a.swipe_id === floor.swipe_id
    && JSON.stringify(existing) === JSON.stringify(vars)
    && JSON.stringify(a.is_ejs_processed) === JSON.stringify(floor.is_ejs_processed ?? [])
}

function floorToMessage(floor: StFloorSnapshot): StFacadeMessage {
  const message: StFacadeMessage = {
    name: floor.name,
    is_user: floor.is_user,
    is_system: floor.is_system,
    mes: floor.mes,
    swipe_id: floor.swipe_id,
    variables: { [String(floor.swipe_id)]: { ...(floor.variables ?? {}) } },
    is_ejs_processed: [...(floor.is_ejs_processed ?? [false])],
  }
  return message
}

/**
 * The facade state. One instance per extension frame; the facades export its
 * members and the bridge applies each round's context onto it.
 */
export class StCompatState {
  readonly chat: StFacadeMessage[] = []
  readonly chatMetadata: Record<string, unknown> = {}
  readonly extensionSettings: Record<string, unknown> = {}
  readonly characters: Array<Record<string, unknown>> = []

  chatId = ''
  language = 'en'
  userName = 'User'
  characterName = 'Assistant'
  characterId = -1
  /** The bound world book, hydrated when the host supplies one; empty otherwise. */
  readonly worldbooks = new Map<string, { entries: Record<string, unknown> }>()

  /**
   * Apply one bridge context onto the stable objects. Floors whose content is
   * unchanged keep their object identity; changed floors are mutated in place;
   * new floors append; removals truncate.
   */
  applyContext(context: StBridgeContext): void {
    this.chatId = context.chatId
    this.language = context.language
    this.userName = context.userName
    this.characterName = context.characterName
    this.characterId = context.characterId ?? -1

    this.chat.length = Math.min(this.chat.length, context.chat.length)
    for (const [index, floor] of context.chat.entries()) {
      const existing = this.chat[index]
      if (existing === undefined) {
        this.chat.push(floorToMessage(floor))
      } else if (sameFloor(existing, floor)) {
        // Identity preserved on purpose: handlers may hold this object.
      } else {
        const fresh = floorToMessage(floor)
        // Mutate the existing object's own fields so captured references see
        // the new values, then swap the variable layers wholesale.
        existing.name = fresh.name
        existing.is_user = fresh.is_user
        existing.is_system = fresh.is_system
        existing.mes = fresh.mes
        existing.swipe_id = fresh.swipe_id
        existing.variables = fresh.variables
        existing.is_ejs_processed = fresh.is_ejs_processed
      }
    }
    if (this.chat.length > context.chat.length) this.chat.length = context.chat.length

    replaceInPlace(this.chatMetadata, { variables: context.chatVariables })
    const globalVariables
      = (context.extensionSettings as { variables?: { global?: Record<string, unknown> } })?.variables?.global ?? {}
    replaceInPlace(this.extensionSettings, { ...context.extensionSettings, variables: { global: globalVariables } })
    replaceArrayInPlace(this.characters, this.characterId >= 0
      ? [{ name: context.characterName, description: '', data: {}, avatar: 'none' }]
      : [])
  }

  /** The local (chat) variable layer as the upstream code leaves it. */
  collectChatVariables(): Record<string, unknown> {
    const variables = this.chatMetadata['variables']
    return typeof variables === 'object' && variables !== null ? { ...(variables as Record<string, unknown>) } : {}
  }

  /** The extension's global variable layer (`extension_settings.variables.global`). */
  collectGlobalVariables(): Record<string, unknown> {
    const variables = this.extensionSettings['variables'] as { global?: Record<string, unknown> } | undefined
    const global = variables?.global
    return typeof global === 'object' && global !== null ? { ...global } : {}
  }
}

/** Delete every element and append the next contents, keeping the array identity. */
function replaceArrayInPlace<T>(target: T[], next: readonly T[]): void {
  target.length = 0
  target.push(...next)
}

/** Delete every key and assign the next shape, keeping the object identity. */
function replaceInPlace(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, next)
}

/**
 * The settings projection's translation pass, decoupled from the DOM: given
 * the upstream locale table, produce the attribute-level edits a renderer
 * applies to elements carrying `data-i18n`. Kept pure so the applier's rules
 * are testable without a document; the entry binds it to real elements.
 *
 * Upstream's rule (`extensions.js applyTranslations`): `data-i18n` holds
 * either a key (replaces textContent) or `[attribute]Key` (replaces that
 * attribute). Keys missing from the table are left untouched — upstream
 * behaves the same, and the English source text is the fallback.
 */
export function translationsFor(element: {
  textContent: string | null
  attributes: Map<string, string>
}, table: Record<string, string>): Array<{ kind: 'text', value: string } | { kind: 'attribute', attribute: string, value: string }> {
  const edits: Array<{ kind: 'text', value: string } | { kind: 'attribute', attribute: string, value: string }> = []
  const spec = element.attributes.get('data-i18n')
  if (typeof spec !== 'string' || spec === '') return edits
  for (const part of spec.split(';').map(part => part.trim()).filter(Boolean)) {
    const attributeForm = /^\[([^\]]+)\](.+)$/u.exec(part)
    if (attributeForm !== null) {
      const attribute = attributeForm[1]
      const key = attributeForm[2]
      if (attribute !== undefined && key !== undefined) {
        const value = table[key]
        if (typeof value === 'string') edits.push({ kind: 'attribute', attribute, value })
      }
    } else {
      const value = table[part]
      if (typeof value === 'string') edits.push({ kind: 'text', value })
    }
  }
  return edits
}
