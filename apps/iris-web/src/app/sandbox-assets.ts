/**
 * This build's sandbox artifact names, resolved from the manifest.
 *
 * The names carry content hashes, so nothing may hardcode them. The manifest is
 * the one fixed path, and it is validated rather than trusted: a dev server
 * answers an unknown path with its index at status 200, so `response.ok` is not
 * evidence of anything.
 *
 * One resolver for both frame hosts. They used to carry two copies with two
 * policies: the script host fetched per run, the interface host memoised the
 * promise at module scope **including a rejection**, so one transient failure
 * left every message frame dead until a reload while the script frame
 * recovered on its next run.
 *
 * @module iris-web/app/sandbox-assets
 */
import {
  SANDBOX_MANIFEST_PATH,
  parseSandboxManifest,
  type SandboxAssets,
} from '../sandbox/asset-manifest.ts'

/**
 * Fetch and validate the manifest, fresh.
 * @param fetchImpl - the fetch to use; injectable for tests.
 * @returns the asset URLs for this build.
 */
export async function sandboxAssets(fetchImpl: typeof fetch = fetch): Promise<SandboxAssets> {
  const response = await fetchImpl(SANDBOX_MANIFEST_PATH)
  if (!response.ok) throw new Error(`sandbox manifest: HTTP ${String(response.status)}`)
  const parsed = parseSandboxManifest(await response.text())
  if (typeof parsed === 'string') throw new Error(`sandbox manifest: ${parsed}`)
  return parsed
}

/**
 * The shared, in-flight-and-settled promise for the interface host.
 *
 * Memoised at module scope deliberately: every displayed message would
 * otherwise ask for the same manifest, and on a long conversation that is a
 * request per row for something that cannot have changed within one build.
 * The promise is cached rather than the value, so concurrent rows share one
 * flight.
 */
let shared: Promise<SandboxAssets> | undefined

/**
 * The asset names, shared across every message frame on the page.
 *
 * **A rejection is dropped, not cached.** The next caller starts a fresh
 * fetch, so a manifest that failed once (a dev server restarting, a dropped
 * connection) is asked again instead of failing every interface frame for the
 * rest of the page's life.
 * @param fetchImpl - the fetch to use; injectable for tests.
 * @returns the shared supply.
 */
export function sharedSandboxAssets(fetchImpl: typeof fetch = fetch): Promise<SandboxAssets> {
  if (shared !== undefined) return shared
  const attempt = sandboxAssets(fetchImpl)
  shared = attempt
  attempt.catch(() => {
    // Only this attempt's own slot: a later, successful attempt is kept.
    if (shared === attempt) shared = undefined
  })
  return attempt
}
