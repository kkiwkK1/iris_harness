/**
 * The reinstall seam of the ST-compat pilot's install handshake.
 *
 * The uninstall rule keeps an extension's installed tree on disk — the
 * artifact and the stored settings are the user's data, and the preference row
 * is the only thing the uninstall clears. A directory install of the SAME
 * extension id therefore meets an existing lock, and the installer refuses it
 * (`already-installed`: updates go through the update transaction). The
 * reinstall the platform promises is the re-adoption of that tree, which this
 * predicate decides: a lock present under the extensions root means the tree
 * is here and the handshake re-adopts instead of copying.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The installer layout's own lock location, for one extension id. */
export function installedTreePresent(extensionsRoot: string, extensionId: string): boolean {
  return existsSync(join(extensionsRoot, 'installed', extensionId, 'lock.json'))
}
