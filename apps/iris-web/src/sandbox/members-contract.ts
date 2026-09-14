/**
 * The two names the inlined core and the fetched member table agree on.
 *
 * Their own module so that **neither side can drift**: the core reads these to
 * find the table, the table writes them, and a rename that touched only one of
 * them would produce a frame that reports "the member table did not arrive"
 * while the table sits in the document having arrived. That failure would be
 * indistinguishable from a genuine fetch failure, which is the one thing the
 * marker exists to tell apart.
 *
 * @module iris-web/sandbox/members-contract
 */

/**
 * Where the table publishes itself.
 *
 * Not concealed, for the same reason `SCRIPT_REGISTRY` is not: a card's scripts
 * share this realm and can already reach anything in it, so hiding the name buys
 * no isolation the realm has not already given away — it only makes the
 * mechanism harder to recognise in a stack trace.
 */
export const MEMBERS_GLOBAL = '__iris_members__'

/**
 * The name the table sets as its **last** statement.
 *
 * Modelled on `PRESET_MARKER`, and the reasoning transfers exactly: a frame can
 * see that a member is missing but not *why*, and the two causes need opposite
 * responses. A table this build does not carry is a gap to fill; a table that
 * never ran is a request to go and look at the fetch. Reading one from the other
 * is guesswork — and this project has already shipped a frame that reported nine
 * missing names when the truth was one blocked script.
 */
export const MEMBERS_MARKER = '__iris_members_ready__'

/**
 * The three names the third-party member merge agrees on
 * (`notes/PLUGIN-CONTRACT-LANDING-SITES.md` §3, 落点 3).
 *
 * A plugin's browser script registers its members through the core table's
 * `registerPluginMembers`, then proves it ran to completion the same way the
 * core table does — a marker as its **last** statement. The bootstrap publishes
 * which plugins this frame admits, so a script whose tag outlived its
 * snapshot (stale shell cache, a disabled plugin's cached bundle) is refused
 * at registration instead of being admitted because it executed.
 */

/** The global under which one plugin's registered members are stored. */
export function pluginMembersGlobal(pluginId: string): string {
  return `__iris_plugin_members__${pluginId}`
}

/** The marker a plugin's script sets as its last statement. */
export function pluginReadyMarker(pluginId: string): string {
  return `__iris_plugin_ready__${pluginId}`
}

/**
 * Where the bootstrap publishes the frame's admitted plugin rows
 * (`SandboxPluginRuntime.plugins`), keyed by plugin id.
 *
 * Registration reads this as its admission gate. It is a **record, not a
 * set**, on purpose: the values are the rows the snapshot carries, and a
 * future check that needs the rev (a report naming which version's members
 * ran) reads it here rather than from a second channel.
 */
export const PLUGIN_ADMITTED_GLOBAL = '__iris_plugins_admitted__'
/**
 * What the table carries, as the core sees it.
 *
 * Written with `typeof import(...)` so every reference is **erased**: the core
 * gets the types without the modules, which is the entire point of the split. A
 * plain `import { X }` here would put the table back in the bootstrap and leave
 * the two builds looking correct while the bytes had not moved.
 */
export interface MemberTable {
  createFrameTavernHelper: typeof import('./tavern-helper.ts').createFrameTavernHelper
  createEventSource: typeof import('./tavern-helper.ts').createEventSource
  restoreFloorTables: typeof import('./tavern-helper.ts').restoreFloorTables
  sealLegacyCleanup: typeof import('./tavern-helper.ts').sealLegacyCleanup
  createPopupApi: typeof import('./popup-api.ts').createPopupApi
  settledEvents: typeof import('./tavern-helper.ts').settledEvents
  STARTED_EVENTS: readonly string[]
  SETTLED_EVENT_NAMES: readonly string[]
  createCardStorage: typeof import('./card-storage.ts').createCardStorage
  createStAnchors: typeof import('./st-anchors.ts').createStAnchors
  KNOWN_ST_IDS: readonly string[]
  clipPathFor: typeof import('./overlay-regions.ts').clipPathFor
  collectRegions: typeof import('./overlay-regions.ts').collectRegions
  describeVisibility: typeof import('./overlay-regions.ts').describeVisibility
  describeEmptySurface: typeof import('./overlay-regions.ts').describeEmptySurface
  describeFrameViewport: typeof import('./overlay-regions.ts').describeFrameViewport
  regionsKey: typeof import('./overlay-regions.ts').regionsKey
  createNestedFrame: typeof import('./nested-frame.ts').createNestedFrame
  virtualiseNestedFrames: typeof import('./nested-frame.ts').virtualiseNestedFrames
  createReportingToastr: typeof import('./toastr-report.ts').createReportingToastr
  createParentMessages: typeof import('./parent-messages.ts').createParentMessages
  /**
   * The 145 keys upstream's `getContext()` returns, so the facade's report for a
   * member it has not built can say which kind of absence it is.
   *
   * **A name list, carried in the table, for the reason the popup API is.** The
   * core composes the sentence — that is policy and stays inlined — but the 145
   * strings are data, about 2.4 KiB of it, and the bootstrap had roughly 1.8 KiB
   * of headroom under `FRAME_OVERHEAD_BYTES` when this landed. Inlining them
   * would have moved the frame gate to buy a diagnostic, which is the trade the
   * inline/fetch seam exists to stop anyone making by accident.
   */
  UPSTREAM_CONTEXT_MEMBERS: readonly string[]
  recordChatEdits: typeof import('./chat-journal.ts').recordChatEdits
  replayChatEdits: typeof import('./chat-journal.ts').replayChatEdits
  /**
   * Register one plugin's card-facing members.
   *
   * The merge gate lives here rather than in the plugin: a name that would
   * collide with the core table or with another plugin's member is refused
   * **at registration, by throw** — the same rule `IrisRpcHost.register`
   * holds, because which member a name resolves to is a composition-level
   * fact, and letting load order decide it would make script order a
   * contract. The throw fails the plugin's own script, so its ready marker
   * never arrives and the frame reports that plugin's members as absent —
   * named, while every other plugin's members still flow.
   */
  registerPluginMembers: (pluginId: string, members: Record<string, unknown>) => void
}
