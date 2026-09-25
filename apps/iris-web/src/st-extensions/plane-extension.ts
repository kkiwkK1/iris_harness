/**
 * Which system-plugin row the ST-compat plane belongs to.
 *
 * Pure, and separated from the component that consumes it, because the rule is
 * the one that decides whether a frame and its settings panel exist at all —
 * and because getting it wrong is silent. The pilot's first version asked "is
 * some plugin enabled", which is true on every profile the moment the bundled
 * plugins are on, so a DISABLED extension kept its panel and its frame on
 * screen; only the cold-mount path looked correct, since a disabled extension's
 * manifest 404s and no frame is built. Extracting the question makes the
 * difference testable without a DOM.
 *
 * **The row is chosen by `@iris/plugin-web-api`'s `servedStExtensionRow`**,
 * the same function the host's `extensionId()` calls when it resolves which
 * extension to bridge, whose settings to load and which revision to arm. The
 * page used to keep its own copy of the rule ("the first installed row that is
 * not a bundled plugin", with the bundled ids spelled here), and the frame took
 * its id from a third place, the asset listing's first row; an installed
 * git/dev package captured the first two, and two ST extensions with the first
 * one disabled split the frame from both. One selector, three readers.
 */

import { servedStExtensionRow, type StExtensionRowLike } from '@iris/plugin-web-api'

/** The minimum a snapshot row must carry for this rule. */
export type SystemPluginRow = StExtensionRowLike

/**
 * The ST extension the plane serves, if one is installed.
 * @param rows - the snapshot's plugin rows, or undefined before the first snapshot.
 * @returns the row the plane serves, or undefined when none is installed.
 */
export function servedExtensionRow<R extends SystemPluginRow>(rows: readonly R[] | undefined): R | undefined {
  return servedStExtensionRow(rows)
}

/** One entry of `/iris-st-ext/manifest.json`'s `extensions` listing, as read off the wire. */
export interface ListedExtension {
  id?: unknown
  rev?: unknown
  dirName?: unknown
  build?: unknown
}

/**
 * The listing entry the frame is built from: the one for the served row.
 *
 * Not the listing's first entry. The listing holds every *enabled* ST
 * extension in its own order, so its first entry is the served row only by
 * coincidence; the frame's extension id has to be the id the host bridges and
 * the plane gates on, or the frame attaches for an extension the host is not
 * arming.
 * @param listing - the parsed `extensions` array, or undefined.
 * @param servedId - the id {@link servedExtensionRow} answered.
 * @returns the matching entry, or undefined when the listing does not carry it.
 */
export function listedExtensionFor(
  listing: readonly ListedExtension[] | undefined,
  servedId: string | undefined,
): ListedExtension | undefined {
  if (servedId === undefined) return undefined
  return listing?.find(entry => entry.id === servedId)
}

/**
 * Whether the plane's extension is running right now.
 *
 * `status === 'enabled'` and not merely `enabled`: the snapshot's status is the
 * one field that also folds in the transition states (`enabling`/`disabling`),
 * so a panel is never built for an extension the host has not finished starting
 * or has already begun stopping.
 * @param row - the row from {@link servedExtensionRow}.
 * @returns true only for a row the host reports as fully enabled.
 */
export function servedExtensionEnabled(row: SystemPluginRow | undefined): boolean {
  return row?.status === 'enabled'
}

/**
 * Whether one window message is a card frame's member-proxy call.
 *
 * Pure, and extracted for the same reason as the rules above: the page's
 * `message` listener used to drop everything whose source was not the
 * extension frame BEFORE the plane ever saw it, which made the card-facing
 * member proxy unreachable — a card's `irisStMemberProxy` envelope arrived
 * from a card frame, the gate swallowed it, and no member ever answered. The
 * gate now hands these to the plane first, whose own guards (own-frame check,
 * extension id, reply targets) refuse what they do not recognise.
 * @param data - the message's data, as the listener read it.
 * @returns true when the message claims the member-proxy channel.
 */
export function isCardMemberProxyCall(data: unknown): boolean {
  return typeof data === 'object' && data !== null
    && (data as Record<string, unknown>)['irisStMemberProxy'] !== undefined
}
