/**
 * The card-facing member table, as a script the frame fetches once per page.
 *
 * **Split out of the bootstrap for the reason the preset was**: the bootstrap is
 * inlined into every frame's `srcdoc`, where nothing is cached and each frame
 * re-parses the whole thing. At twelve live frames the fixed cost had grown to
 * about 780 KiB of a 2 MiB budget, and the count gate had been forced down twice
 * in one day — 20 → 16 → 12 — because every new member is paid twelve times.
 *
 * The line between this and the core is **policy versus surface**:
 *
 * - The **core** stays inlined: the channel to the shell, the proxies that
 *   refuse, `UNBRIDGED_GLOBALS`, the evaluator, and the order things are
 *   installed in. Nothing that decides what a card *may* reach can be
 *   substitutable by anything that answers a path.
 * - This table is what a card reaches *with*: the Tavern Helper members, the
 *   storage façade, the SillyTavern anchors, the overlay geometry. Replacing it
 *   changes what a card can call, not what the sandbox permits.
 *
 * **The security argument is that the marginal exposure is zero**, and it is
 * worth stating precisely rather than by analogy: the preset (`preset-*.js`,
 * 834 KB of libraries) is already fetched from this origin by content-hashed URL
 * under the same `script-src`, and it executes arbitrary code in the same realm.
 * An attacker who could substitute this table could substitute that one, and
 * substituting the preset already gives them everything in the realm. If that
 * ever stops being acceptable, the thing to tighten is the preset's line —
 * hardening one of the two alone is self-reassurance.
 *
 * @module iris-web/sandbox/members-entry
 */

import { MEMBERS_GLOBAL, MEMBERS_MARKER } from './members-contract.ts'
import { createCardStorage } from './card-storage.ts'
import { KNOWN_ST_IDS, createStAnchors } from './st-anchors.ts'
import {
  clipPathFor,
  collectRegions,
  describeEmptySurface,
  describeFrameViewport,
  describeVisibility,
  regionsKey,
} from './overlay-regions.ts'
import { createNestedFrame, virtualiseNestedFrames } from './nested-frame.ts'
import { createReportingToastr } from './toastr-report.ts'
import { createPopupApi } from './popup-api.ts'
import { createParentMessages } from './parent-messages.ts'
import { UPSTREAM_CONTEXT_MEMBERS } from './upstream-surface.ts'
import {
  SETTLED_EVENT_NAMES,
  STARTED_EVENTS,
  createEventSource,
  createFrameTavernHelper,
  restoreFloorTables,
  sealLegacyCleanup,
  settledEvents,
} from './tavern-helper.ts'

const host = globalThis as unknown as Record<string, unknown>

host[MEMBERS_GLOBAL] = {
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
}

/*
 * Last statement in the file, and that position is the whole point — the same
 * reasoning as `PRESET_MARKER`, which this is modelled on.
 *
 * Present means every assignment above it completed. Absent means the script was
 * blocked, failed to parse, or threw partway — and the core's response to that
 * is to **refuse to run card bodies** rather than run them against an empty
 * table. Forty `ReferenceError`s attributed to the card is a worse diagnosis
 * than one named refusal, and the named one is actionable.
 */
host[MEMBERS_MARKER] = true
