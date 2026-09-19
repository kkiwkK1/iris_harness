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
   * @returns the bound members.
   */
  cardSurface: (owner: string) => Record<string, unknown>
  /** The shell's origin, for the interface markup rewrite a panel string goes through. */
  origin: string
}

/**
 * Call a member off a bound surface without letting its failure end the sweep.
 *
 * Teardown item 5 is three member calls, and a member that refuses — the surface
 * answers `undefined` for anything this build does not carry — must not stop the
 * other two. The thrown reason is passed on so the checklist row can say which
 * one it was.
 * @param surface - the plugin's bound members.
 * @param name - the member to call.
 * @param args - its arguments.
 * @returns what went wrong, or undefined.
 */
function callMember(surface: Record<string, unknown>, name: string, args: readonly unknown[]): string | undefined {
  const member = surface[name]
  if (typeof member !== 'function') return undefined
  try {
    ;(member as (...rest: unknown[]) => unknown)(...args)
    return undefined
  } catch (error: unknown) {
    return `${name}: ${error instanceof Error ? error.message : String(error)}`
  }
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
   * Each plugin's surface, built once and kept.
   *
   * Kept rather than rebuilt per call because the `identity` members carry
   * per-owner state — a listener registry keyed by owner, most of all — and a
   * second binding would be a second registry, so `eventClearAll` at teardown
   * would clear a table the plugin never wrote to. Dropped at teardown, so a
   * remount of the same id starts from a fresh one.
   */
  const surfaces = new Map<string, Record<string, unknown>>()
  /** The `uninject` handles each plugin has taken out; teardown item 5 calls them. */
  const injections = new Map<string, (() => void)[]>()
  const surfaceFor = (pluginId: string): Record<string, unknown> => {
    const existing = surfaces.get(pluginId)
    if (existing !== undefined) return existing
    const built = env.cardSurface(pluginId)
    /*
     * `injectPrompts` is wrapped so its handles can be collected.
     *
     * The member is `shared` and upstream's removal is **by id**, so nothing on
     * the surface knows which injections belong to which owner — which would
     * leave teardown item 5 unable to do a third of its job. The handle the
     * member already returns is the attribution, so it is kept rather than a
     * parallel id list being invented. The wrapper changes nothing a plugin can
     * observe: it returns the same handle object.
     */
    const inject = built['injectPrompts']
    if (typeof inject === 'function') {
      built['injectPrompts'] = (...args: unknown[]): unknown => {
        const handle = (inject as (...rest: unknown[]) => unknown)(...args)
        if (handle !== null && typeof handle === 'object' && typeof (handle as { uninject?: unknown }).uninject === 'function') {
          const list = injections.get(pluginId) ?? []
          list.push((handle as { uninject: () => void }).uninject)
          injections.set(pluginId, list)
        }
        return handle
      }
    }
    surfaces.set(pluginId, built)
    return built
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
    clearMemberTraces: pluginId => {
      const surface = surfaces.get(pluginId)
      const reasons: string[] = []
      if (surface !== undefined) {
        // Listeners this owner registered. The bound copy clears only its own,
        // which is upstream's per-frame semantics carried to a per-plugin owner.
        const cleared = callMember(surface, 'eventClearAll', [])
        if (cleared !== undefined) reasons.push(cleared)
        // The owner's button table, emptied. Two arguments, as upstream's own
        // signature requires.
        const buttons = callMember(surface, 'replaceScriptButtons', [pluginId, []])
        if (buttons !== undefined) reasons.push(buttons)
      }
      for (const uninject of injections.get(pluginId) ?? []) {
        try {
          uninject()
        } catch (error: unknown) {
          reasons.push(`uninjectPrompts: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      injections.delete(pluginId)
      surfaces.delete(pluginId)
      if (reasons.length > 0) throw new Error(reasons.join('; '))
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
      void tree.mount({ pluginId: message.pluginId, version: message.version, code: message.code })
      return
    }
    if (message.type === 'plugin:unmount') {
      void tree.unmount(message.pluginId)
      return
    }
    if (message.type === 'plugin:panel') tree.setPanelVisible(message.visible)
  })

  return tree
}
