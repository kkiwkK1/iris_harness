/**
 * What a sandbox plugin leaves in per-card stores, and when it is taken away.
 *
 * A plugin's card surface reaches the host's per-card stores under an owner id
 * that names its conversation, `sp:<chatId>:<pluginId>` (`@iris/protocol`'s
 * `sandboxPluginOwnerId`). The frame binds it in `frame.ts`'s `cardSurface`.
 * These three functions are the host half: the plugin's state lives exactly as
 * long as the plugin does in that conversation.
 *
 * | event | what happens to the owner's script-variable table |
 * | --- | --- |
 * | plugin removed (`sandboxPlugin.decide` remove, or a discard that drops the row) | forgotten |
 * | chat deleted | every owner of that chat forgotten, by prefix |
 * | chat branched | copied to the branch's owner id, beside the plugin row and its authorisations |
 *
 * **Script buttons are not in this table, and that is measured rather than
 * forgotten.** `script.replaceScriptButtons` refuses any script id the card
 * does not declare (`character "…" declares no script "…"`), so a plugin owner
 * can never have a stored button table. There is nothing to forget or copy.
 * `sandbox-plugin-owner-state.test.ts` pins the refusal, so the day that check
 * is relaxed, this module's omission goes red rather than silently leaking.
 *
 * @module @iris/app-service/sandbox-plugins/owner-state
 */
import { sandboxPluginOwnerId, sandboxPluginOwnerPrefix } from '@iris/protocol'

import type { ScriptVariableStore } from '../script-variables.ts'

/**
 * Forget every plugin owner of one conversation, because it was deleted.
 *
 * By prefix rather than by the sidecar's list: the sidecar is forgotten in the
 * same handler, and a table written by a plugin that had already been removed
 * from the sidecar through some other path would otherwise outlive the chat.
 * @param store - the script-variable store, when the host has one.
 * @param chatId - the deleted conversation.
 * @returns how many tables went.
 */
export async function forgetChatPluginState(store: ScriptVariableStore | undefined, chatId: string): Promise<number> {
  if (store === undefined) return 0
  const prefix = sandboxPluginOwnerPrefix(chatId)
  return store.forgetScripts(scriptId => scriptId.startsWith(prefix))
}

/**
 * Forget the owners of the plugins that are no longer in a conversation.
 * @param store - the script-variable store, when the host has one.
 * @param chatId - the conversation.
 * @param pluginIds - the plugins whose rows went.
 * @returns how many tables went.
 */
export async function forgetPluginState(
  store: ScriptVariableStore | undefined,
  chatId: string,
  pluginIds: readonly string[],
): Promise<number> {
  if (store === undefined || pluginIds.length === 0) return 0
  const owners = new Set(pluginIds.map(pluginId => sandboxPluginOwnerId(chatId, pluginId)))
  return store.forgetScripts(scriptId => owners.has(scriptId))
}

/**
 * Copy each branched plugin's table onto the branch's owner id.
 *
 * A copy, not a reference: the branch rule copies the rows with their
 * authorisations, so the state goes with them. Each road then writes its own
 * table, and deleting the parent leaves the branch's state in place.
 * @param store - the script-variable store, when the host has one.
 * @param characterId - whose card; both conversations share it.
 * @param fromChatId - the parent.
 * @param toChatId - the branch.
 * @param pluginIds - the plugins the branch received.
 */
export async function copyBranchPluginState(
  store: ScriptVariableStore | undefined,
  characterId: string,
  fromChatId: string,
  toChatId: string,
  pluginIds: readonly string[],
): Promise<void> {
  if (store === undefined || characterId === '') return
  for (const pluginId of pluginIds) {
    await store.copyScript(
      characterId,
      sandboxPluginOwnerId(fromChatId, pluginId),
      sandboxPluginOwnerId(toChatId, pluginId),
    )
  }
}
