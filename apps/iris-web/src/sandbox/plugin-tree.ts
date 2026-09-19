/**
 * The mini tree a card's sandbox plugins live in, inside the card-script frame.
 *
 * A **sandbox plugin** is code a model wrote for one conversation, mounted into
 * the frame that conversation's card scripts already run in
 * ([SANDBOX-PLUGINS](../../../../docs/SANDBOX-PLUGINS.md) §5). It is the third
 * class of code in this frame, after the card's own scripts and the system
 * plugins' member bundles, and it is the only one that can be added and removed
 * while the frame keeps running.
 *
 * This module is the tree and nothing else: no DOM, no `new Function`, no member
 * table. All three arrive as injected seams, for the reason `card-scripts.ts`
 * gives for the same shape — the interesting parts here are **ordering, failure
 * isolation and teardown**, which are decisions, and deciding correctly is what
 * needs testing. Two of them cannot be tested any other way:
 *
 * - the deadline that separates `mount-failed` from `mount-timeout` needs a
 *   clock a test can move;
 * - the byte-identity of the compiled wrapper (§6.1) needs the compiler to be
 *   observable, because the claim is about the bytes handed over, not about two
 *   calls to the same helper agreeing with each other.
 *
 * **Why a second registration surface rather than the member table.** The frame
 * already has `registerPluginMembers`, and it cannot be used: it has no revoke,
 * and it throws on a second registration rather than replacing (§2.2). A hot
 * mount needs both. The tree sits beside the member table and does not touch it.
 *
 * @module iris-web/sandbox/plugin-tree
 */
import {
  SANDBOX_PLUGIN_FACADE_PARAM,
  SANDBOX_PLUGIN_LIMITS,
  sandboxPluginBody,
  type SandboxPluginFailureState,
} from '@iris/protocol'

/**
 * What a plugin's factory is handed. Three capabilities and its own id.
 *
 * **Exactly this, and nothing else.** There is no `fetch`, no `window`, no
 * `document`, no `parent`, no `import` — and the facade is not claimed to be a
 * boundary: a plugin reaching `Function('return this')()` gets the frame's own
 * globals, which are the ones a card script already has, inside an opaque-origin
 * iframe. The wall is the iframe; this is a surface (§7).
 */
export interface SandboxPluginFacade {
  /** This plugin's id. */
  readonly id: string
  /** Style injection into the frame's head, per plugin and revocable. */
  readonly styles: {
    /**
     * Add a stylesheet.
     * @param css - the stylesheet text.
     * @returns a function that removes just this sheet.
     */
    insert: (css: string) => () => void
    /** Remove every sheet this plugin added. */
    clear: () => void
  }
  /** This plugin's one cell in the frame's panel container. */
  readonly panel: {
    /**
     * Put something in this plugin's cell, replacing what was there.
     * @param node - an element, or a string of HTML.
     * @returns a function that empties the cell.
     */
    mount: (node: unknown) => () => void
    /** Empty this plugin's cell. */
    clear: () => void
  }
  /**
   * The member surface a card script gets, bound to this plugin.
   *
   * Not a new surface: it is the 124 members of `MEMBER_KINDS`, with the
   * `identity` ones bound to this plugin's id the way they are bound per script
   * today. That binding is what makes teardown item 5 possible at all — a
   * shared surface cannot take back what it cannot attribute.
   */
  readonly card: Readonly<Record<string, unknown>>
}

/** What a plugin's factory returns. Both members optional; neither is required. */
export interface SandboxPluginInstance {
  /** Start doing whatever this plugin does. Awaited under a deadline. */
  apply?: () => unknown
  /** Undo it. Awaited under a shorter deadline; see teardown item 1. */
  dispose?: () => unknown
}

/** One plugin the shell wants mounted. */
export interface SandboxPluginRequest {
  readonly pluginId: string
  readonly version: number
  readonly code: string
}

/** What the tree says back to the shell. */
export type SandboxPluginOutcome =
  | { readonly kind: 'mounted', readonly pluginId: string, readonly version: number, readonly ms: number }
  | {
    readonly kind: 'failed'
    readonly pluginId: string
    readonly version: number
    readonly state: SandboxPluginFailureState
    readonly detail: string
  }

/**
 * The six things a teardown has to take away, in reverse of the order they
 * were put there (§5.7).
 *
 * **A declared list rather than a sequence of statements**, because the way this
 * goes wrong is that one of them stops being done and nothing says so. The test
 * asserts the number of items it compared is six; a loop that `continue`s past
 * five of them and stays green is a shape this project has already shipped once.
 *
 * Item 4 is the one PR-A only half-does: the shell's copy of a plugin's CSS and
 * the message-frame rebuild that goes with it are PR-C. What is here is the
 * frame's own half — forgetting what this plugin published, so a later census
 * cannot attribute a removed plugin's stylesheet to anything.
 */
export const SANDBOX_PLUGIN_TEARDOWN_ITEMS = [
  'dispose',
  'panel',
  'styles-frame',
  'styles-published',
  'member-traces',
  'tree-row',
] as const

/** One item of the teardown checklist. */
export type SandboxPluginTeardownItem = (typeof SANDBOX_PLUGIN_TEARDOWN_ITEMS)[number]

/** What one teardown item did. */
export interface SandboxPluginTeardownStep {
  readonly item: SandboxPluginTeardownItem
  readonly ok: boolean
  /** Present only when `ok` is false. The item's own words. */
  readonly detail?: string
}

/** Where a plugin's stylesheets go. Separated so the tree needs no DOM. */
export interface SandboxPluginStyleSink {
  /**
   * Add a stylesheet owned by a plugin.
   * @param pluginId - the owner.
   * @param css - the stylesheet text.
   * @returns a function removing just this sheet.
   */
  insert: (pluginId: string, css: string) => () => void
  /**
   * Remove every sheet a plugin owns.
   * @param pluginId - the owner.
   * @returns how many sheets came away.
   */
  clear: (pluginId: string) => number
}

/** Where a plugin's panel content goes. */
export interface SandboxPluginPanelSink {
  /**
   * Fill a plugin's cell.
   * @param pluginId - the owner.
   * @param node - an element or a string of HTML.
   * @returns a function emptying the cell.
   */
  mount: (pluginId: string, node: unknown) => () => void
  /**
   * Remove a plugin's cell entirely. The container stays; it belongs to the frame.
   * @param pluginId - the owner.
   */
  remove: (pluginId: string) => void
  /**
   * Show or hide the container.
   * @param visible - whether the container is shown.
   */
  setVisible: (visible: boolean) => void
}

/** The frame's half of the world, injected. */
export interface SandboxPluginTreeEnv {
  /**
   * Compile a plugin's body into its factory.
   *
   * Takes the parameter name and the body **separately and verbatim**, so a test
   * can read back exactly what was compiled. That is the whole of the §6.1
   * check: the host's precheck and this call must have handed their compilers
   * the same two strings.
   */
  compile: (param: string, body: string) => unknown
  styles: SandboxPluginStyleSink
  panel: SandboxPluginPanelSink
  /**
   * The per-plugin member surface.
   * @param pluginId - who is asking.
   * @returns the bound members.
   */
  cardSurface: (pluginId: string) => Record<string, unknown>
  /**
   * Teardown item 5: take back what the member surface let this plugin register.
   *
   * Event listeners, script buttons and injected prompts, each by the binding
   * this plugin's id owns. Injected because every one of them is a member call,
   * and the tree has no business knowing which members exist.
   * @param pluginId - the owner.
   */
  clearMemberTraces: (pluginId: string) => void
  /** The frame's clock. */
  now: () => number
  /**
   * Arm a deadline.
   * @param ms - how long.
   * @param fire - what to do when it expires.
   * @returns a function cancelling it.
   */
  after: (ms: number, fire: () => void) => () => void
  /** Report an outcome to the shell. */
  report: (outcome: SandboxPluginOutcome) => void
  /**
   * Report a stylesheet a plugin injected, for the shell's fan-out.
   * @param pluginId - the owner.
   * @param css - the stylesheet text.
   */
  publishStyle: (pluginId: string, css: string) => void
  /**
   * Tell the shell a plugin's published stylesheets are gone.
   *
   * The other half of {@link SandboxPluginTreeEnv.publishStyle}, and it is its
   * own call rather than `publishStyle(id, '')` because an empty sheet and no
   * sheet are different facts: the shell keeps a list per plugin, and appending
   * an empty string to that list is not the same request as emptying it.
   * @param pluginId - the owner.
   */
  retractStyles: (pluginId: string) => void
  /**
   * Say something that is not a plugin's failure — a late rejection arriving
   * after its deadline, most of all.
   *
   * Its own channel because the plugin's row is already settled by then: a
   * second `plugin:failed` for a plugin the shell has written off would look
   * like a new fault rather than the tail of an old one.
   * @param message - what happened.
   */
  note: (message: string) => void
}

/** A plugin the tree currently holds. */
interface MountedPlugin {
  readonly version: number
  readonly instance: SandboxPluginInstance
  readonly facade: SandboxPluginFacade
}

/** The tree the shell drives. */
export interface SandboxPluginTree {
  /**
   * Mount one plugin, replacing any version of it already up.
   * @param request - which plugin, which version, what code.
   * @returns when the mount has settled one way or the other.
   */
  mount: (request: SandboxPluginRequest) => Promise<void>
  /**
   * Mount a batch, in id order, under one budget.
   * @param requests - the plugins to mount.
   * @returns when the batch has settled.
   */
  mountAll: (requests: readonly SandboxPluginRequest[]) => Promise<void>
  /**
   * Take one plugin down.
   * @param pluginId - which one.
   * @returns the checklist, one row per item, always six long.
   */
  unmount: (pluginId: string) => Promise<readonly SandboxPluginTeardownStep[]>
  /** Which plugins are up, in mount order. */
  mounted: () => readonly { pluginId: string, version: number }[]
  /**
   * Show or hide the panel container.
   * @param visible - whether it is shown.
   */
  setPanelVisible: (visible: boolean) => void
  /** Take everything down. For the frame's own teardown. */
  disposeAll: () => Promise<void>
}

/**
 * Resolve a value under a deadline, telling the two outcomes apart.
 *
 * Not `Promise.race` with a rejecting timer, because that loses the distinction
 * the two failure states are built on: a race reports one error object and the
 * caller has to sniff it. This answers `'value' | 'threw' | 'expired'`, so
 * `mount-failed` and `mount-timeout` are decided by the shape of the answer
 * rather than by parsing a message.
 *
 * **The work is not cancelled**, because it cannot be. A late resolve is
 * dropped (nobody is consuming it any more) and a late rejection is caught and
 * handed to `onLate` — an unhandled rejection from an abandoned plugin would
 * otherwise surface as a frame-wide fault with no owner (§6.3, copied from
 * GENERATION-HOOKS §5.2).
 * @param work - the value or promise to wait on.
 * @param ms - the deadline.
 * @param after - the timer seam.
 * @param onLate - what to do with an answer that arrives after the deadline.
 * @returns which of the three happened.
 */
async function withDeadline(
  work: unknown,
  ms: number,
  after: SandboxPluginTreeEnv['after'],
  onLate: (outcome: { late: 'resolved' | 'rejected', error?: unknown }) => void,
): Promise<{ kind: 'value' } | { kind: 'threw', error: unknown } | { kind: 'expired' }> {
  if (work === null || typeof work !== 'object' || typeof (work as PromiseLike<unknown>).then !== 'function') {
    return { kind: 'value' }
  }
  let settled = false
  const promise = work as PromiseLike<unknown>
  return new Promise(resolve => {
    const cancel = after(ms, () => {
      if (settled) return
      settled = true
      resolve({ kind: 'expired' })
    })
    promise.then(
      () => {
        if (settled) {
          onLate({ late: 'resolved' })
          return
        }
        settled = true
        cancel()
        resolve({ kind: 'value' })
      },
      (error: unknown) => {
        if (settled) {
          onLate({ late: 'rejected', error })
          return
        }
        settled = true
        cancel()
        resolve({ kind: 'threw', error })
      },
    )
  })
}

/**
 * Say what went wrong in one line.
 * @param error - whatever was thrown.
 * @returns a bounded sentence.
 */
function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.slice(0, SANDBOX_PLUGIN_LIMITS.detailChars)
}

/**
 * Build the tree.
 * @param env - the frame's half, injected.
 * @returns the tree.
 */
export function createSandboxPluginTree(env: SandboxPluginTreeEnv): SandboxPluginTree {
  const mounted = new Map<string, MountedPlugin>()
  /**
   * **One** chain, not one per plugin id.
   *
   * The design asks for a serial queue per plugin (§5.3 step 0) — dsh converges
   * the same way on a `pluginRunId` — and a single chain gives that and two more
   * things the per-id version cannot:
   *
   * - **the batch budget is measurable.** 3 s each and a 10 s ceiling for the
   *   set (§6.3) is a statement about a sequence; with sixteen independent
   *   queues there is no sequence to hold a budget against.
   * - **the mount order is the order** (§9). Ids are sorted before they are
   *   sent, and a single chain is what makes that sorting survive as far as the
   *   `apply` calls — with per-id queues every plugin starts at once and the
   *   order decides nothing, which would make the "later CSS wins" rule the
   *   design writes into the author documentation simply untrue.
   *
   * The per-plugin guarantee the design asks for is implied by the stronger one:
   * a mount arriving while that plugin's teardown is still running waits for it,
   * so a teardown cannot reach past its own mount and strip the new version's
   * style tags.
   */
  let chain: Promise<unknown> = Promise.resolve()
  /** How deep the chain is, so "the batch drained" is a fact rather than a guess. */
  let queued = 0
  /**
   * When the current batch started, or undefined between batches.
   *
   * Armed as work is put onto an **idle** chain and disarmed when it drains, so
   * a set mounted at chat-open shares one budget while a plugin the reader adds
   * an hour later starts its own.
   *
   * That rule has one consequence worth writing down rather than discovering: a
   * burst of single `mount` calls whose plugins each finish instantly lets the
   * chain drain between them, so each gets a fresh window. It is the harmless
   * direction — the budget exists for plugins that are slow, and a slow one
   * holds the chain busy for everything queued behind it, which is exactly when
   * the ceiling has to bite. `mountAll` does not rely on it at all: it puts the
   * whole set in the queue before the first one starts.
   */
  let batchBegan: number | undefined
  /** What each plugin has published, so item 4 has something to forget. */
  const published = new Map<string, string[]>()

  const serial = async <T>(work: () => Promise<T>): Promise<T> => {
    if (queued === 0) batchBegan = env.now()
    queued += 1
    const next = chain.then(work, work)
    // Kept so the chain never rejects into the next link; the outcome travels
    // through the returned promise instead.
    chain = next.then(
      () => {
        queued -= 1
        if (queued === 0) batchBegan = undefined
      },
      () => {
        queued -= 1
        if (queued === 0) batchBegan = undefined
      },
    )
    return next
  }

  /**
   * Whether the batch budget is already spent.
   *
   * Asked when a plugin's turn comes, not when it was queued: the question is
   * whether there is time left to start this one, and a plugin queued inside the
   * window whose predecessors ate the whole of it must not start.
   * @returns whether this plugin has missed the batch.
   */
  const batchSpent = (): boolean =>
    batchBegan !== undefined && env.now() - batchBegan >= SANDBOX_PLUGIN_LIMITS.batchMs

  const facadeFor = (pluginId: string): SandboxPluginFacade => ({
    id: pluginId,
    styles: {
      insert: css => {
        const remove = env.styles.insert(pluginId, css)
        const list = published.get(pluginId) ?? []
        list.push(css)
        published.set(pluginId, list)
        env.publishStyle(pluginId, css)
        return remove
      },
      clear: () => {
        env.styles.clear(pluginId)
        published.delete(pluginId)
        /*
         * And the shell's copies with them. A plugin that clears its sheets and
         * goes on running is the one case the shell cannot infer: it sees no
         * `plugin:unmount`, so without this message the message frames would go
         * on painting a stylesheet that no longer exists in the realm that wrote
         * it — the card's own frame and its message frames disagreeing about
         * what the card looks like.
         */
        env.retractStyles(pluginId)
      },
    },
    panel: {
      mount: node => env.panel.mount(pluginId, node),
      clear: () => env.panel.remove(pluginId),
    },
    card: env.cardSurface(pluginId),
  })

  /**
   * Run the checklist for one plugin.
   *
   * **Every item is attempted, whatever the ones before it did.** A `dispose`
   * that throws must not leave the style tags in the head — that is the whole
   * reason this is a list rather than a sequence of statements, and why a failed
   * item records `dispose-failed` and the loop goes on (§5.7).
   * @param pluginId - which plugin.
   * @param entry - what the tree holds for it, when it holds anything.
   * @returns one row per checklist item, always six.
   */
  const teardown = async (
    pluginId: string,
    entry: MountedPlugin | undefined,
  ): Promise<SandboxPluginTeardownStep[]> => {
    const steps: SandboxPluginTeardownStep[] = []
    const record = (item: SandboxPluginTeardownItem, run: () => Promise<string | undefined>): Promise<void> =>
      run().then(
        detail => {
          steps.push(detail === undefined ? { item, ok: true } : { item, ok: false, detail })
        },
        (error: unknown) => {
          // An item that threw is a failed item, not a missing one: the row is
          // still pushed, so the compared count stays six and the checklist
          // cannot come away looking shorter than it is.
          steps.push({ item, ok: false, detail: describe(error) })
        },
      )

    // 1 — the plugin's own dispose, under its own shorter deadline.
    await record('dispose', async () => {
      if (entry?.instance.dispose === undefined) return undefined
      let thrown: unknown
      let raised = false
      let value: unknown
      try {
        value = entry.instance.dispose()
      } catch (error: unknown) {
        raised = true
        thrown = error
      }
      if (raised) return `dispose threw: ${describe(thrown)}`
      const outcome = await withDeadline(
        value,
        SANDBOX_PLUGIN_LIMITS.disposeMs,
        env.after,
        late => {
          if (late.late === 'rejected') {
            env.note(`${pluginId}: dispose rejected after its ${SANDBOX_PLUGIN_LIMITS.disposeMs}ms deadline — ${describe(late.error)}`)
          }
        },
      )
      if (outcome.kind === 'threw') return `dispose threw: ${describe(outcome.error)}`
      if (outcome.kind === 'expired') return `dispose did not settle within ${SANDBOX_PLUGIN_LIMITS.disposeMs}ms`
      return undefined
    })

    // 2 — the panel cell, whole. The container stays; it belongs to the frame.
    await record('panel', async () => {
      env.panel.remove(pluginId)
      return undefined
    })

    // 3 — every `[data-iris-plugin-style]` tag this plugin owns, in this frame.
    await record('styles-frame', async () => {
      env.styles.clear(pluginId)
      return undefined
    })

    /*
     * 4 — the published copies, **both halves**.
     *
     * PR-A could only do the frame's: forgetting here is what stops a later
     * census attributing a removed plugin's stylesheet to a plugin that no
     * longer exists. PR-C adds the other half — the shell drops its `(chatId,
     * pluginId)` CSS and the message frames of this conversation are rebuilt
     * without it. The rebuild is visible (the frames blink); that cost is the
     * design's own choice and is recorded rather than worked around, because the
     * alternative is a live-injection channel into frames the shell would then
     * have to keep in step with their srcdoc.
     */
    await record('styles-published', async () => {
      published.delete(pluginId)
      env.retractStyles(pluginId)
      return undefined
    })

    // 5 — what the member surface let it register: listeners, script buttons,
    // injected prompts. The item the design calls the easiest to miss, and the
    // only reason the `card` surface is bound per plugin at all.
    await record('member-traces', async () => {
      env.clearMemberTraces(pluginId)
      return undefined
    })

    // 6 — the row itself. Same id may be mounted again afterwards.
    await record('tree-row', async () => {
      mounted.delete(pluginId)
      return undefined
    })

    return steps
  }

  const mountOne = async (request: SandboxPluginRequest): Promise<void> => {
    const { pluginId, version, code } = request

    const existing = mounted.get(pluginId)
    if (existing !== undefined) {
      const steps = await teardown(pluginId, existing)
      const failed = steps.filter(step => !step.ok)
      if (failed.length > 0) {
        env.report({
          kind: 'failed',
          pluginId,
          version: existing.version,
          state: 'dispose-failed',
          detail: failed.map(step => `${step.item}: ${step.detail ?? 'did not come away'}`).join('; '),
        })
      }
    }

    const facade = facadeFor(pluginId)
    let factory: unknown
    try {
      // The one construction. `new Function` rather than a `blob:` module
      // because it is **synchronous** — which is what lets the evaluation's
      // throw and `apply`'s throw be two different states (§5.3).
      factory = env.compile(SANDBOX_PLUGIN_FACADE_PARAM, sandboxPluginBody(code))
    } catch (error: unknown) {
      env.report({ kind: 'failed', pluginId, version, state: 'mount-failed', detail: describe(error) })
      return
    }
    if (typeof factory !== 'function') {
      env.report({
        kind: 'failed',
        pluginId,
        version,
        state: 'mount-failed',
        detail: 'the compiled body is not callable',
      })
      return
    }

    let instance: unknown
    try {
      instance = (factory as (facade: SandboxPluginFacade) => unknown)(facade)
    } catch (error: unknown) {
      // The factory threw. Nothing is mounted, so nothing is torn down — but
      // whatever it managed to put in the head before throwing is ours now.
      env.styles.clear(pluginId)
      env.panel.remove(pluginId)
      env.report({ kind: 'failed', pluginId, version, state: 'mount-failed', detail: describe(error) })
      return
    }

    const plugin: SandboxPluginInstance =
      instance !== null && typeof instance === 'object' ? (instance as SandboxPluginInstance) : {}

    const started = env.now()
    let applied: unknown
    if (typeof plugin.apply === 'function') {
      try {
        applied = plugin.apply()
      } catch (error: unknown) {
        env.styles.clear(pluginId)
        env.panel.remove(pluginId)
        env.report({ kind: 'failed', pluginId, version, state: 'mount-failed', detail: describe(error) })
        return
      }
    }

    /*
     * **A synchronous `apply` that blew the budget is a timeout too**, and this
     * line exists because the acceptance run found the gap: a plugin whose
     * `apply` spins for six seconds and then returns had already finished by the
     * time a deadline could be armed, so the tree reported it `mounted` — a
     * plugin that froze the frame for twice its budget, filed as healthy.
     *
     * The deadline below cannot help: a promise race does not preempt
     * synchronous code and neither does the browser, so the only honest thing
     * available is to ask, afterwards, how long it actually took. A truly
     * infinite `while(true)` never even reaches this line — nothing is reported,
     * the frame is dead, and that is the fact the design's own acceptance check
     * exists to record rather than to pass.
     */
    const spentSync = env.now() - started
    if (spentSync >= SANDBOX_PLUGIN_LIMITS.applyMs) {
      mounted.set(pluginId, { version, instance: plugin, facade })
      env.report({
        kind: 'failed',
        pluginId,
        version,
        state: 'mount-timeout',
        detail:
          `apply blocked the frame for ${String(spentSync)}ms, over its`
          + ` ${String(SANDBOX_PLUGIN_LIMITS.applyMs)}ms budget — synchronous work cannot be interrupted,`
          + ' so the budget was exceeded rather than enforced',
      })
      return
    }

    const outcome = await withDeadline(applied, SANDBOX_PLUGIN_LIMITS.applyMs, env.after, late => {
      if (late.late === 'rejected') {
        // Caught rather than left to become an unhandled rejection with no
        // owner. The row is already written; this is the tail of it.
        env.note(
          `${pluginId} v${version}: apply rejected after its ${SANDBOX_PLUGIN_LIMITS.applyMs}ms deadline`
          + ` — ${describe(late.error)}`,
        )
      }
    })

    if (outcome.kind === 'threw') {
      env.styles.clear(pluginId)
      env.panel.remove(pluginId)
      env.report({ kind: 'failed', pluginId, version, state: 'mount-failed', detail: describe(outcome.error) })
      return
    }
    if (outcome.kind === 'expired') {
      /*
       * **Kept on the tree.** The plugin is running — it simply has not
       * finished starting, and the promise cannot be cancelled. Removing its
       * row would leave whatever it already put in the document with no owner
       * to take it away, which is worse than a row that says it timed out.
       */
      mounted.set(pluginId, { version, instance: plugin, facade })
      env.report({
        kind: 'failed',
        pluginId,
        version,
        state: 'mount-timeout',
        detail: `apply did not settle within ${SANDBOX_PLUGIN_LIMITS.applyMs}ms`,
      })
      return
    }

    mounted.set(pluginId, { version, instance: plugin, facade })
    env.report({ kind: 'mounted', pluginId, version, ms: env.now() - started })
  }

  return {
    mount: async request =>
      serial(async () => {
        if (batchSpent()) {
          /*
           * Named rather than skipped in silence. The design stops the batch
           * here ("later ones are not started"); it does not say they vanish,
           * and afterwards a plugin that never got a turn and one that was never
           * asked for are indistinguishable unless this row exists — which is
           * the same reason `unparseable` has to carry the model's actual reply.
           */
          env.report({
            kind: 'failed',
            pluginId: request.pluginId,
            version: request.version,
            state: 'mount-timeout',
            detail: `the batch budget of ${SANDBOX_PLUGIN_LIMITS.batchMs}ms was spent before this plugin's turn`,
          })
          return
        }
        await mountOne(request)
      }),

    mountAll: async requests => {
      /*
       * **Lexicographic by id, recomputed every time (§9).**
       *
       * Not creation order, which would need a counter whose holes get reused;
       * not a plugin-declared priority, which a model-written plugin can set to
       * the top for free. The order is visible in two places — whose CSS wins a
       * tie, and how the panel cells sit — so it has to be a fact about the ids
       * rather than about anything a plugin says about itself.
       */
      const ordered = [...requests].sort((left, right) =>
        left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0,
      )
      /*
       * **Enqueued all at once, then awaited** — not awaited one at a time.
       *
       * Awaiting inside the loop lets the chain drain between plugins, which
       * closes the batch window and gives every plugin its own fresh 10 s. The
       * set is the unit the budget is defined on (§6.3: 3 s × 16 is 48 s of an
       * opening chat, which is what the ceiling exists to refuse), so the set
       * has to be in the queue before the first one starts. `serial` preserves
       * enqueue order, so the sort above still decides the order they apply in.
       */
      await Promise.all(
        ordered.map(async request =>
          serial(async () => {
            if (batchSpent()) {
              env.report({
                kind: 'failed',
                pluginId: request.pluginId,
                version: request.version,
                state: 'mount-timeout',
                detail: `the batch budget of ${SANDBOX_PLUGIN_LIMITS.batchMs}ms was spent before this plugin's turn`,
              })
              return
            }
            await mountOne(request)
          }),
        ),
      )
    },

    unmount: async pluginId =>
      serial(async () => {
        const entry = mounted.get(pluginId)
        const steps = await teardown(pluginId, entry)
        const failed = steps.filter(step => !step.ok)
        if (failed.length > 0) {
          env.report({
            kind: 'failed',
            pluginId,
            version: entry?.version ?? 0,
            state: 'dispose-failed',
            detail: failed.map(step => `${step.item}: ${step.detail ?? 'did not come away'}`).join('; '),
          })
        }
        return steps
      }),

    mounted: () => [...mounted.entries()].map(([pluginId, entry]) => ({ pluginId, version: entry.version })),

    setPanelVisible: visible => {
      env.panel.setVisible(visible)
    },

    disposeAll: async () => {
      for (const pluginId of [...mounted.keys()]) {
        await serial(async () => {
          await teardown(pluginId, mounted.get(pluginId))
        })
      }
    },
  }
}
