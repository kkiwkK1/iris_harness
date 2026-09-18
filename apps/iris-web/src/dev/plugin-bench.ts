/**
 * Where PR-A's sandbox plugins come from: a person typing them.
 *
 * The finished feature has a model write a plugin, a confirmation card
 * authorise it and a sidecar keep it (PR-B). None of that exists yet, and that
 * is deliberate: the technical risk of this whole feature is "does it mount, and
 * does it come away cleanly", and a version with no model can be verified a line
 * at a time and costs nothing when it fails
 * (`docs/SANDBOX-PLUGINS.md` §15 PR-A).
 *
 * **Outside React**, like `harness-state.ts` beside it and for the reason
 * recorded there: an observer watching a card lost the whole state view on their
 * next interaction, three times running, and guessing at what was unmounting was
 * wrong twice. The record stopped depending on the answer.
 *
 * **Not dev-gated at the module level, and the cost is stated rather than
 * hidden.** `useCardScripts` reads this store on every frame build, so it is in
 * the production bundle: two empty maps and a dead subscriber list, a few hundred
 * bytes. What is dev-gated is the panel that writes to it, so in a production
 * build `pluginsFor` answers the empty array for every chat and the frame
 * behaves exactly as it did before this feature — which is the compatibility
 * floor this PR is held to, and is what the ST-compat test pins.
 *
 * @module iris-web/dev/plugin-bench
 */
import type { SandboxPluginFailureState } from '@iris/protocol'

/** One plugin a person has typed in, as the shell sends it to a frame. */
export interface BenchPlugin {
  readonly pluginId: string
  readonly version: number
  readonly code: string
}

/** What the shell has heard back about one plugin. */
export interface BenchStatus {
  readonly pluginId: string
  /** `pending` until the frame answers; then `mounted` or the named failure. */
  readonly state: 'pending' | 'mounted' | SandboxPluginFailureState
  readonly version: number
  /** How long `apply` took, on a mount. */
  readonly ms?: number
  /** The frame's own words, on a failure. */
  readonly detail?: string
  /** When the shell heard it, so a reader has an observation window. */
  readonly at: number
}

/** Plugins per chat id. */
const wanted = new Map<string, readonly BenchPlugin[]>()
/** Statuses per chat id, keyed by plugin id inside. */
const heard = new Map<string, Map<string, BenchStatus>>()
const subscribers = new Set<() => void>()

/** Tell everyone watching that something moved. */
function announce(): void {
  for (const subscriber of subscribers) subscriber()
}

/**
 * Which plugins a conversation wants mounted.
 *
 * Read by `useCardScripts` on every frame build, which is what makes an empty
 * answer indistinguishable from this module not existing.
 * @param chatId - the conversation, or undefined before one is open.
 * @returns the plugins, newest state of the list.
 */
export function pluginsFor(chatId: string | undefined): readonly BenchPlugin[] {
  return chatId === undefined ? [] : wanted.get(chatId) ?? []
}

/**
 * Replace a conversation's plugin list.
 * @param chatId - the conversation.
 * @param plugins - the whole list.
 */
export function setPlugins(chatId: string, plugins: readonly BenchPlugin[]): void {
  wanted.set(chatId, plugins)
  announce()
}

/**
 * Record what the shell heard about a plugin.
 *
 * Called from the production path (`useCardScripts`) rather than from the panel,
 * because the panel is not the thing that hears it: the outcome arrives as a
 * frame message on a channel the panel has no handle on. A status written by the
 * panel would be the panel's belief about a message it never saw.
 * @param chatId - the conversation.
 * @param status - what was heard.
 */
export function recordStatus(chatId: string | undefined, status: BenchStatus): void {
  if (chatId === undefined) return
  const table = heard.get(chatId) ?? new Map<string, BenchStatus>()
  table.set(status.pluginId, status)
  heard.set(chatId, table)
  announce()
}

/**
 * What the shell has heard for a conversation.
 * @param chatId - the conversation.
 * @returns one row per plugin the shell has heard about, in id order.
 */
export function statusesFor(chatId: string | undefined): readonly BenchStatus[] {
  if (chatId === undefined) return []
  return [...(heard.get(chatId)?.values() ?? [])].sort((left, right) =>
    left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0,
  )
}

/**
 * Forget a conversation's statuses, without touching what it wants mounted.
 *
 * Its own call rather than a side effect of setting the list: **the statuses are
 * the evidence**, and clearing them when the list changes would delete the
 * reading that says what the last attempt did. A reader asks for this when they
 * want a fresh baseline.
 * @param chatId - the conversation.
 */
export function clearStatuses(chatId: string): void {
  heard.delete(chatId)
  announce()
}

/** How the bench reaches the frame of the card that is running now. */
export interface PluginControl {
  mount: (pluginId: string, version: number, code: string) => void
  unmount: (pluginId: string) => void
}

/**
 * The running card's plugin doors, or nothing when no card is running.
 *
 * A module-scope holder, exactly as `card-bus.ts` holds the emitter and for the
 * same two reasons written down there: threading a live handle through a
 * component that re-renders on every keystroke is how a stale closure reaches a
 * torn-down frame, and this is not state — it is an object whose lifetime is one
 * run of one card's scripts.
 */
let control: PluginControl | undefined

/**
 * Register the running card's plugin doors.
 * @param next - the doors.
 * @returns a disposer that clears the slot **only if it is still holding this
 * one**, so a late teardown from a previous card cannot silence its successor.
 */
export function registerPluginControl(next: PluginControl): () => void {
  control = next
  return () => {
    if (control === next) control = undefined
  }
}

/**
 * Mount a plugin into the running card without rebuilding its frame.
 *
 * Rebuilding would be the lazy answer and it is the wrong one twice over: the
 * card's scripts would lose their state, which is one of the three reasons the
 * code travels over the channel in the first place, and the thing being
 * exercised — a hot mount into a live tree — would never actually happen.
 * @param pluginId - the plugin's id.
 * @param version - which version of it.
 * @param code - the body, as typed.
 * @returns whether a card was running to receive it.
 */
export function mountIntoCard(pluginId: string, version: number, code: string): boolean {
  if (control === undefined) return false
  control.mount(pluginId, version, code)
  return true
}

/**
 * Take a plugin out of the running card.
 * @param pluginId - the plugin's id.
 * @returns whether a card was running to hear it.
 */
export function unmountFromCard(pluginId: string): boolean {
  if (control === undefined) return false
  control.unmount(pluginId)
  return true
}

/**
 * Watch the bench.
 * @param subscriber - called whenever anything changes.
 * @returns the unsubscribe.
 */
export function subscribeBench(subscriber: () => void): () => void {
  subscribers.add(subscriber)
  return () => {
    subscribers.delete(subscriber)
  }
}
