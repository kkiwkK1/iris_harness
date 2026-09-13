/**
 * Facade for `script.js` — the pilot's largest host module. Served at
 * `<rev>/script.js`, which is what the upstream bundle's
 * `../../../../../script.js` resolves to under the mirrored URL layout.
 *
 * The object exports (`chat`, `chat_metadata`, `characters`) are the kernel's
 * stable state objects; the scalar exports (`this_chid`, `name1`, `name2`, …)
 * are `let` bindings the kernel updates per bridge round, re-exported so the
 * live binding propagates to the upstream import sites.
 */

import * as kernelEntry from '../kernel-entry.ts'
import { escapeHtml, substituteMacrosMinimal } from '../../../../../packages/iris-compat-st-extension/src/runtime/kernel-core.ts'
import { state } from '../kernel-entry.ts'
import { UnsupportedStCompatApiError } from '../../../../../packages/iris-compat-st-extension/src/runtime/kernel-core.ts'

export { event_types, eventSource } from '../kernel-entry.ts'
export { this_chid, name1, name2, main_api, user_avatar, online_status } from '../kernel-entry.ts'

export const chat = state.chat
export const chat_metadata = state.chatMetadata
export const characters = state.characters

export function getCurrentChatId(): string {
  return state.chatId
}

export function substituteParams(content: string): string {
  return substituteMacrosMinimal(String(content), { userName: state.userName, characterName: state.characterName })
}

/**
 * The pilot's `messageFormatting`: HTML escaping. Upstream renders full
 * markdown here; the pilot's floors are an evaluation surface, and the only
 * consumer on the UC paths is the `<%= %>` escaper, whose contract is "safe
 * HTML", not "beautiful markdown". Recorded as a deviation in the report.
 */
export function messageFormatting(markup: string): string {
  return escapeHtml(String(markup))
}

export function updateMessageBlock(messageId: number, message: { mes?: string }): void {
  kernelEntry.updateMessageBlockDom(Number(messageId), String(message?.mes ?? ''))
}

/** Upstream appends the message's media to the rendered block; the pilot floors carry none. */
export function appendMediaToMessage(): void {}

/** Upstream decorates code blocks with copy buttons; the projection floor is a scratch surface. */
export function addCopyToCodeBlocks(): void {}

/** Persist the extension's settings blob via the shell → host profile store. */
export function saveSettingsDebounced(): void {
  kernelEntry.persistSettings()
}

/**
 * Upstream's chat saver. The pilot persists variables through the bridge's
 * writeback instead; `checkAndSave` only calls this when autosave is enabled
 * (off by default), and a forced save lands as a no-op with the deviation
 * recorded in the report.
 */
export async function saveChatConditional(): Promise<void> {}

export function getThumbnailUrl(): string {
  return ''
}

export function getUserAvatar(): string {
  return ''
}

export function unimplemented(member: string): never {
  throw new UnsupportedStCompatApiError(member)
}
