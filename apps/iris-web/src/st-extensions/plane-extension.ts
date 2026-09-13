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
 * The host applies the same rule in `extensionId()` when it resolves which
 * extension to bridge, whose settings to load, and which revision to arm — so
 * this is the page's copy of one contract, not a second opinion.
 */

/** The minimum a snapshot row must carry for this rule. */
export interface SystemPluginRow {
  id: string
  installed: boolean
  status: string
}

/**
 * The installed row that is not a bundled plugin, if there is one.
 *
 * `bundled` is passed in rather than imported so the ids stay declared once, at
 * the composition site that also mirrors the host's list.
 * @param rows - the snapshot's plugin rows, or undefined before the first snapshot.
 * @param bundled - the host's bundled plugin ids.
 * @returns the row the plane serves, or undefined when none is installed.
 */
export function servedExtensionRow(
  rows: readonly SystemPluginRow[] | undefined,
  bundled: ReadonlySet<string>,
): SystemPluginRow | undefined {
  return rows?.find(row => row.installed && !bundled.has(row.id))
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
