/**
 * The member table, assembled directly for tests.
 *
 * In a real frame this arrives as a separate script and the core reads it off a
 * global; a test has no document to load one into, so it imports the modules and
 * hands the table over. **That is not a shortcut around the split** — it is what
 * the split makes possible: the core takes the table as a parameter, so a test
 * can supply the real one without a fetch, and could supply a stubbed one to
 * exercise a member in isolation.
 *
 * A shared helper rather than a literal in each harness, because the table's
 * shape is a contract between two builds: a member added to `members-entry.ts`
 * and not here would leave the tests exercising a surface the frame does not
 * have, which is the drift the split could otherwise introduce.
 *
 * @module iris-web/tests/members-table
 */

import type { MemberTable } from '../src/sandbox/members-contract.ts'
import { createCardStorage } from '../src/sandbox/card-storage.ts'
import { KNOWN_ST_IDS, createStAnchors } from '../src/sandbox/st-anchors.ts'
import {
  clipPathFor,
  collectRegions,
  describeEmptySurface,
  describeFrameViewport,
  describeVisibility,
  regionsKey,
} from '../src/sandbox/overlay-regions.ts'
import { createNestedFrame, virtualiseNestedFrames } from '../src/sandbox/nested-frame.ts'
import { createReportingToastr } from '../src/sandbox/toastr-report.ts'
import { createPopupApi } from '../src/sandbox/popup-api.ts'
import { createParentMessages } from '../src/sandbox/parent-messages.ts'
import { UPSTREAM_CONTEXT_MEMBERS } from '../src/sandbox/upstream-surface.ts'
import { recordChatEdits, replayChatEdits } from '../src/sandbox/chat-journal.ts'
import {
  SETTLED_EVENT_NAMES,
  STARTED_EVENTS,
  createEventSource,
  createFrameTavernHelper,
  restoreFloorTables,
  sealLegacyCleanup,
  settledEvents,
} from '../src/sandbox/tavern-helper.ts'
import { registerPluginMembers } from '../src/sandbox/members-entry.ts'

/** The same members `members-entry.ts` publishes, for a test's `FrameEnv`. */
export const MEMBERS: MemberTable = {
  createFrameTavernHelper,
  createEventSource,
  restoreFloorTables,
  sealLegacyCleanup,
  settledEvents,
  STARTED_EVENTS,
  SETTLED_EVENT_NAMES,
  createCardStorage,
  createStAnchors,
  KNOWN_ST_IDS,
  clipPathFor,
  collectRegions,
  describeVisibility,
  describeEmptySurface,
  describeFrameViewport,
  regionsKey,
  createNestedFrame,
  virtualiseNestedFrames,
  createReportingToastr,
  createPopupApi,
  createParentMessages,
  UPSTREAM_CONTEXT_MEMBERS,
  recordChatEdits,
  replayChatEdits,
  registerPluginMembers,
}
