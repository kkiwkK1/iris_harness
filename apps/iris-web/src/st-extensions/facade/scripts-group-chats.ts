/**
 * Facade for `scripts/group-chats.js`, served at `<rev>/scripts/group-chats.js`.
 * Iris has no group-chat surface in the pilot; the context fields read empty
 * and the member lookup returns none, which is exactly what a non-group chat
 * looks like upstream.
 */

export const groups: Array<Record<string, unknown>> = []
export let selected_group: string | null = null

/** Upstream iterates the return value SYNCHRONOUSLY (for…of over the array),
 *  so this must not be async — a Promise is not iterable. */
export function getGroupMembers(): Array<Record<string, unknown>> {
  return []
}
