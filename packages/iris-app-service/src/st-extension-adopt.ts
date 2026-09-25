import { join } from 'node:path'

import { buildStExtensionDefinition } from '@iris/compat-st-extension'
import type { NormalizedManifest } from '@iris/compat-st-extension'

import type { SystemPluginRuntime } from './system-plugins.ts'

/**
 * Adopt one installed SillyTavern extension as a catalog row.
 *
 * The composition's two adoption sites (the boot scan and
 * `stExtension.install`) go through this one function, so the row they add
 * is the same row, and so a test can add it exactly the way the host does.
 * @param runtime - the profile's system-plugin catalog.
 * @param input.id - the extension id (its installed directory name).
 * @param input.manifest - the normalized upstream manifest.
 * @param input.dataDir - the data directory the member bundle is written under.
 * @returns true when the row was added, false when the id was already there.
 */
export function adoptStExtension(
  runtime: SystemPluginRuntime,
  input: { id: string, manifest: NormalizedManifest, dataDir: string },
): boolean {
  return runtime.adoptDefinition(buildStExtensionDefinition({
    id: input.id,
    manifest: input.manifest,
    memberBundlePath: join(input.dataDir, 'system-plugins', input.id, 'client', 'client.js'),
  }), { installed: true, origin: 'st-extension' })
}
