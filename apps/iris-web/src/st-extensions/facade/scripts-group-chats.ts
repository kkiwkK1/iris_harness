/**
 * Facade for `scripts/group-chats.js`, served at `<rev>/scripts/group-chats.js`.
 * Iris has no group-chat surface in the pilot; the context fields read empty
 * and the member lookup returns none, which is exactly what a non-group chat
 * looks like upstream.
 */

export const groups: Array<Record<string, unknown>> = []
export let selected_group: string | null = null

export async function getGroupMembers(): Promise<Array<Record<string, unknown>>> {
  return []
}
