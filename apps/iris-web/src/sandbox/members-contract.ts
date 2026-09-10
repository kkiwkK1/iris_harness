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
}
