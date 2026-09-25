/**
 * The frame's half of the sandbox-plugin wiring: a tree, the two DOM sinks, and
 * the three inbound protocol arms.
 *
 * Its own module rather than more lines in `frame-entry.ts` for the reason that
 * file's other extractions have: everything here is a **binding** — the real
 * document, the real `new Function`, the real channel — and the decisions it
 * binds together are in `plugin-tree.ts`, where they can be driven by a test
 * with a fake clock and no browser.
 *
 * @module iris-web/sandbox/plugin-entry
 */
import { SANDBOX_PLUGIN_LIMITS } from '@iris/protocol'

import type { FromFrame, ToFrame } from './protocol.ts'
import { createPluginPanelSink, createPluginStyleSink } from './plugin-surface.ts'
import { createSandboxPluginTree, type SandboxPluginTree } from './plugin-tree.ts'
import type { OwnerScope } from './owner-scope.ts'

/** What the entry hands this module. */
export interface PluginEntryEnv {
  /** The run token every message carries. */
  token: string
  /** The frame's own document. */
  document: Document
  /** Send to the shell. */
  post: (message: FromFrame) => void
  /** Subscribe to already-token-checked messages from the shell. */
  onMessage: (listener: (message: ToFrame) => void) => void
  /**
   * The card surface, bound per owner — `FrameSandbox.cardSurface`.
   * @param owner - the plugin id.
   * @returns the bound members, and the owner scope their lasting effects
   *   registered their undo in.
   */
  cardSurface: (owner: string) => { members: Record<string, unknown>, scope: OwnerScope, ready: Promise<void> }
  /** The shell's origin, for the interface markup rewrite a panel string goes through. */
  origin: string
}

/**
 * Install the plugin tree into a live frame.
 * @param env - the frame's bindings.
 * @returns the tree, for the entry to dispose with the frame.
 */
export function installSandboxPluginTree(env: PluginEntryEnv): SandboxPluginTree {
  const styles = createPluginStyleSink(env.document)
  const panel = createPluginPanelSink(env.document, globalThis as never, env.origin)

  /**
   * Each plugin's surface and owner scope, built once and kept.
   *
   * Kept rather than rebuilt per call because the `identity` members carry
   * per-owner state — a listener registry keyed by owner, most of all — and a
   * second binding would be a second registry with a second scope, so teardown
   * would dispose effects the plugin never registered. Dropped at teardown, so
   * a remount of the same id starts from a fresh surface and a fresh scope.
   */
  const surfaces = new Map<string, { members: Record<string, unknown>, scope: OwnerScope, ready: Promise<void> }>()
  const bound = (pluginId: string): { members: Record<string, unknown>, scope: OwnerScope, ready: Promise<void> } => {
    const existing = surfaces.get(pluginId)
    if (existing !== undefined) return existing
    const built = env.cardSurface(pluginId)
    surfaces.set(pluginId, built)
    return built
  }
  const surfaceFor = (pluginId: string): Record<string, unknown> => bound(pluginId).members

  /**
   * Every inbound plugin message waits behind the frame's first context.
   *
   * A mount can arrive before the frame has any snapshot (`frame.ts`'s
   * `contextReady` has the measurement), and a plugin whose `apply` runs then
   * has no conversation and no card state to read. Held rather than refused:
   * the context is on its way, and the order of mounts and unmounts is kept,
   * because every message waits on the same promise and its callbacks run in
   * the order they were attached. Once the context is there this is a
   * resolved promise, one microtask.
   */
  let gate: Promise<void> | undefined
  const afterContext = (pluginId: string): Promise<void> => {
    gate ??= bound(pluginId).ready
    return gate
  }

  const tree = createSandboxPluginTree({
    /*
     * The one place `new Function` appears on this path, and it is handed the
     * parameter name and the body **exactly as the tree built them** — nothing
     * is re-assembled here. That is what makes the §6.1 byte-identity claim
     * checkable: a test reads back these two arguments and compares them with
     * what the host's precheck compiled.
     */
    compile: (param, body) => new Function(param, body),
    styles,
    panel,
    cardSurface: surfaceFor,
    /*
     * Teardown item 5 is the owner scope's disposal. Every trace-bearing
     * member (listeners, script buttons, injections, published globals)
     * registered its own undo in this scope when the plugin called it, so this
     * line does not need to know which members exist. It used to: three
     * hard-coded calls, which missed `initializeGlobal`.
     */
    clearMemberTraces: pluginId => {
      const surface = surfaces.get(pluginId)
      surfaces.delete(pluginId)
      return surface === undefined ? [] : surface.scope.dispose()
    },
    now: () => Date.now(),
    after: (ms, fire) => {
      const handle = setTimeout(fire, ms)
      return () => clearTimeout(handle)
    },
    report: outcome => {
      if (outcome.kind === 'mounted') {
        env.post({
          iris: env.token,
          type: 'plugin:mounted',
          pluginId: outcome.pluginId,
          version: outcome.version,
          ms: outcome.ms,
        })
        return
      }
      env.post({
        iris: env.token,
        type: 'plugin:failed',
        pluginId: outcome.pluginId,
        version: outcome.version,
        state: outcome.state,
        detail: outcome.detail,
      })
    },
    publishStyle: (pluginId, css) => {
      /*
       * Bounded here as well as in `parseFromFrame`, and not out of caution: a
       * sheet over the ceiling would be **dropped at the parser**, which from
       * the frame's side looks exactly like a message that was never sent. The
       * cut is made where the size is known so the note below can say so.
       */
      if (css.length > SANDBOX_PLUGIN_LIMITS.cssChars) {
        env.post({
          iris: env.token,
          type: 'note',
          scriptId: undefined,
          message:
            `sandbox plugin ${pluginId} injected ${css.length} characters of CSS, over the`
            + ` ${SANDBOX_PLUGIN_LIMITS.cssChars} the shell accepts — it is applied in this frame and`
            + ' will not reach the message frames',
        })
        return
      }
      env.post({ iris: env.token, type: 'plugin:style', pluginId, css })
    },
    retractStyles: pluginId => {
      env.post({ iris: env.token, type: 'plugin:style-clear', pluginId })
    },
    note: message => {
      env.post({ iris: env.token, type: 'note', scriptId: undefined, message })
    },
  })

  env.onMessage(message => {
    if (message.type === 'plugin:mount') {
      const request = { pluginId: message.pluginId, version: message.version, code: message.code }
      void afterContext(message.pluginId).then(() => tree.mount(request))
      return
    }
    if (message.type === 'plugin:unmount') {
      const pluginId = message.pluginId
      void (gate ?? Promise.resolve()).then(() => tree.unmount(pluginId))
      return
    }
    if (message.type === 'plugin:panel') tree.setPanelVisible(message.visible)
  })

  return tree
}
