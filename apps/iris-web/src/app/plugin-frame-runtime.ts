/**
 * The system-plugin runtime a card frame is built with, and the one key its
 * run is fenced on.
 *
 * Two frame hosts build frames from this runtime — the script frame
 * (`useCardScripts`) and each floor's interface frames (`MessageInterfaces`) —
 * and both used to key their run on pieces of it: the revision, the two
 * capability booleans, and (in one of the two) the manifest object's identity.
 * That had two faults, and a reconnect exposed both. The pieces moved when
 * nothing a frame can see had changed — the store cleared the snapshot for the
 * gap, so the revision went `N → undefined → N` and every frame on the page
 * was torn down and rebuilt — and they did **not** move for one thing a frame
 * can see: a plugin row (its `rev` or `client`) changing at the same revision,
 * which only a restarted host can do.
 *
 * So the key is the runtime itself, encoded: exactly the value the frame is
 * given (`encodeSandboxPluginRuntime` is how it reaches the frame's meta). A
 * string compares by value, so an unchanged runtime keeps every run, and any
 * change a frame could observe — revision, TavernHelper, MVU, a plugin's
 * bundle — rebuilds.
 *
 * @module iris-web/app/plugin-frame-runtime
 */
import { encodeSandboxPluginRuntime, sandboxPluginRuntime, type SandboxPluginRuntime } from '@iris/plugin-web-api'

import { useIris } from '../client/provider.tsx'
import { usePluginAssetManifest } from './use-plugin-manifest.ts'

/** The runtime for frames built now, and the string their run is keyed on. */
export interface PluginFrameRuntime {
  /** `undefined` while the host's catalog is not known — no frames then. */
  runtime: SandboxPluginRuntime | undefined
  /** `encodeSandboxPluginRuntime(runtime)`, or `undefined` with it. */
  key: string | undefined
}

/**
 * Read the runtime and its key from the store and the asset manifest.
 * @returns the runtime and the run key.
 */
export function usePluginFrameRuntime(): PluginFrameRuntime {
  const snapshot = useIris(state => state.systemPlugins)
  const session = useIris(state => state.systemPluginSession)
  const manifest = usePluginAssetManifest(snapshot?.revision, session)
  /*
   * The manifest only when it answers for this revision: rows feed the
   * reduction (the manifest says where a plugin's bytes live; the snapshot
   * says whether it runs at all), and last revision's rows are not this one's.
   */
  const runtime = sandboxPluginRuntime(
    snapshot,
    manifest?.revision === snapshot?.revision ? manifest : undefined,
  )
  return { runtime, key: runtime === undefined ? undefined : encodeSandboxPluginRuntime(runtime) }
}
