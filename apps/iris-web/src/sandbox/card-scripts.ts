/**
 * A card's scripts, started because a chat opened rather than because a panel did.
 *
 * The difference from the probe is who is present. The probe runs a card because
 * someone pressed a button and is watching the result; this runs a card because a
 * chat came to the foreground, with nobody looking. Every rule below follows from
 * that, and the reasoning is in `GRANTS.md` and `AUTORUN.md`.
 *
 * Three of them are load-bearing:
 *
 * - **Grants are re-resolved from the host at the moment of running**, never read
 *   from anything keyed on `characterId`. Character ids are reused: deleting a
 *   card frees its id for the next card of that name, so a cache under that key
 *   can answer for a card that no longer exists. That cost this project a real
 *   defect in each half, and the two halves' test suites both stayed green.
 * - **One script's failure does not stop the next**, and no script's failure
 *   touches the conversation. Scripts are an enhancement to a chat, not a
 *   precondition for one.
 * - **Nothing here prompts.** A missing grant is a line in the panel, not a modal
 *   in front of a conversation the reader came for.
 *
 * Dependency-injected, because the interesting parts — ordering, failure
 * isolation, teardown — are decisions rather than DOM, and deciding correctly is
 * what needs testing.
 *
 * @module iris-web/sandbox/card-scripts
 */
import type { ScriptContext, ScriptView } from '@iris/protocol'

import type { RunningCard } from './runner.ts'
import { isFailure, type ScriptRunState } from './script-run-state.ts'

/** What the shell supplies to start a card's scripts. */
export interface CardScriptsEnv {
  /**
   * The card's scripts and grants, asked of the host now.
   *
   * Typed as a call rather than a value so it cannot be satisfied with cached
   * state: the whole point is that this is answered at run time.
   */
  resolve: (characterId: string) => Promise<{
    scripts: readonly ScriptView[]
    documentGranted: boolean
  }>
  /** The host's snapshot for this chat. */
  context: (chatId: string, characterId: string) => Promise<ScriptContext | undefined>
  /** One script's body. */
  body: (
    characterId: string,
    scriptId: string,
  ) => Promise<{ ok: true, content: string } | { ok: false, error: { code: string, message: string } }>
  /** The bootstrap source, fetched once for the whole set. */
  bootstrap: () => Promise<string>
  /**
   * Start the card's frame. Injected so the sequencing is testable without a DOM.
   *
   * One frame for the whole set, not one per script: a provider publishes a live
   * interface for its siblings to use, and a live object cannot cross an opaque
   * origin. Sharing a realm is what makes `waitGlobalInitialized` expressible.
   */
  start: (input: {
    scripts: readonly { id: string | undefined, code: string }[]
    context: ScriptContext
    bootstrap: string
    documentGranted: boolean
    /** Reports against a script by id, since one frame now speaks for several. */
    onPhase: (scriptId: string | undefined, state: Omit<ScriptRunState, 'scriptId' | 'name'>) => void
  }) => RunningCard
  /**
   * Put a started frame into the document.
   *
   * Part of the contract rather than the caller's business, because forgetting
   * it fails **silently in every direction**: `runCard` builds the iframe but
   * does not insert it, and an iframe outside the document never loads. No
   * parse, no bootstrap, no `ready` — so no frame, no error, no notice, and every
   * script sitting on `dispatched` forever. That is exactly what shipped.
   */
  attach: (frame: RunningCard) => void
  /**
   * How long a frame may take to report `ready` before that silence is a finding.
   *
   * Anchored at *dispatch*, not at the end of the body. Quiet after `ran` is
   * normal here — a card that registers listeners and returns is working
   * correctly — but quiet before `ready` means the frame never started, and that
   * is the one silence with no innocent reading.
   */
  readyTimeoutMs?: number
  /** Called whenever any script's state changes. */
  onState: (states: readonly ScriptRunState[]) => void
  /** Called once per failure, for the notice bar. */
  onFailure: (state: ScriptRunState) => void
}

/** A running set of card scripts. */
export interface RunningCardScripts {
  /** Tear every frame down. Idempotent. */
  dispose: () => void
}

/**
 * Start every enabled script for a card, in card order.
 * @param env - what the shell supplies.
 * @param chatId - the chat that came to the foreground.
 * @param characterId - the card it belongs to.
 * @returns a handle that tears the whole set down.
 */
export function startCardScripts(
  env: CardScriptsEnv,
  chatId: string,
  characterId: string,
): RunningCardScripts {
  const cards: RunningCard[] = []
  const timers: { unref?: () => void }[] = []
  const states = new Map<string, ScriptRunState>()
  let disposed = false

  const publish = (): void => {
    if (disposed) return
    env.onState([...states.values()])
  }

  const move = (script: ScriptView, next: Omit<ScriptRunState, 'scriptId' | 'name'>): void => {
    if (disposed) return
    const state: ScriptRunState = { scriptId: script.id, name: script.name, ...next }
    states.set(script.id, state)
    // Reported once, on the transition. A phase that re-announced itself would
    // put the same failure in the notice bar every time anything else changed.
    if (isFailure(state.phase)) env.onFailure(state)
    publish()
  }

  /**
   * Report a frame that never became ready.
   *
   * The failure this catches has no other symptom. A frame that was never
   * inserted, or whose bootstrap died before it could speak, produces silence
   * that is indistinguishable from "still starting" — and `starting…` is not
   * allowed to be a state something can rest in forever.
   * @param script - the script whose frame to watch.
   */
  const watchForReady = (script: ScriptView): void => {
    const timer = setTimeout(() => {
      const current = states.get(script.id)
      if (current === undefined || current.phase !== 'dispatched') return
      move(script, {
        phase: 'silent',
        detail: 'never became ready — the frame was never created, or setup was torn down',
      })
    }, env.readyTimeoutMs ?? 8_000)
    // Never keeps a process alive on its own; the chat closing must not be held
    // open by a timer waiting to report on a frame that has gone.
    timer.unref?.()
    timers.push(timer)
  }

  void (async () => {
    /*
     * Everything before the first frame is awaited here rather than in the
     * caller, so a chat that closes mid-setup finds `disposed` already true and
     * starts nothing. Without the checks a user who opened and left a chat
     * quickly would end up with frames belonging to a chat they are no longer in.
     */
    let resolved: Awaited<ReturnType<CardScriptsEnv['resolve']>>
    let context: ScriptContext | undefined
    let bootstrap: string
    try {
      resolved = await env.resolve(characterId)
      if (disposed) return
      context = await env.context(chatId, characterId)
      if (disposed) return
      bootstrap = await env.bootstrap()
    } catch (error: unknown) {
      /*
       * The set could not be prepared. Reported against the card rather than
       * against any one script, because none of them got far enough to be the
       * one at fault — and reported at all because silence here would look
       * exactly like a card that ships no scripts.
       */
      if (disposed) return
      env.onFailure({
        scriptId: '',
        name: 'card scripts',
        phase: 'bootstrap-failed',
        detail: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (disposed) return

    if (context === undefined) {
      env.onFailure({
        scriptId: '',
        name: 'card scripts',
        phase: 'bootstrap-failed',
        detail: 'the host did not supply a context for this chat',
      })
      return
    }

    // Card order, not enabled-order or list order: a card's scripts are written
    // expecting to load in the order the card lists them.
    const runnable = resolved.scripts.filter(script => script.enabled)
    const loaded: { script: ScriptView, code: string }[] = []

    for (const script of runnable) {
      if (disposed) return
      move(script, { phase: 'dispatched' })

      const source = await env.body(characterId, script.id)
      if (disposed) return
      if (!source.ok) {
        // The host's own code and message, not a sentence invented here. A
        // hardcoded explanation once sent a reader to debug a transport that was
        // working perfectly.
        move(script, {
          phase: 'bootstrap-failed',
          detail: `${source.error.code}: ${source.error.message}`,
        })
        continue
      }
      loaded.push({ script, code: source.content })
    }

    if (disposed) return
    // A card whose every script failed to load has nothing to run, and starting
    // an empty frame would report a readiness that means nothing.
    if (loaded.length === 0) return

    const byId = new Map(loaded.map(entry => [entry.script.id, entry.script]))

    {
      try {
        const card = env.start({
          scripts: loaded.map(entry => ({ id: entry.script.id, code: entry.code })),
          context,
          bootstrap,
          documentGranted: resolved.documentGranted,
          onPhase: (scriptId, next) => {
            /*
             * Naming no script and naming an unknown one are different, and
             * conflating them lost a whole class of report.
             *
             * The frame speaks for itself as well as for its scripts: the
             * missing-libraries banner, a bootstrap failure before any token
             * exists, a global that could not be defined. Those carry no script
             * id because none of them belongs to one — and this callback used to
             * drop them alongside genuinely misattributed outcomes, so the
             * instrument that warned about `YAML` and `$` three runs before a
             * card reached them stopped arriving at all.
             *
             * An outcome naming a script this set does not contain is still
             * dropped: attributing it to a neighbour would read as a working
             * script failing, which is worse than losing it.
             */
            if (scriptId === undefined) {
              env.onFailure({ scriptId: '', name: 'card scripts', ...next })
              return
            }
            const script = byId.get(scriptId)
            if (script !== undefined) move(script, next)
          },
        })
        cards.push(card)
        env.attach(card)
        /*
         * Verify the outcome, not the call.
         *
         * Requiring `attach` in the contract makes a caller supply one; it does
         * not make the one they supplied work. A no-op satisfies the compiler and
         * reproduces the original failure exactly — an iframe that never enters
         * the document, never loads, and never says anything.
         *
         * `isConnected` is the DOM answering whether the thing actually happened,
         * which is a source independent of the code that claimed to do it.
         */
        const connected = (card.element as { isConnected?: unknown }).isConnected
        if (connected === false) {
          // One frame now, so this is the whole card's failure rather than one
          // script's — reported against each, because each of them is the thing
          // the reader is looking at in the panel.
          for (const entry of loaded) {
            move(entry.script, {
              phase: 'bootstrap-failed',
              detail: 'the frame was never put into the document, so it will never load',
            })
          }
          return
        }
        for (const entry of loaded) watchForReady(entry.script)
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error)
        for (const entry of loaded) move(entry.script, { phase: 'bootstrap-failed', detail })
      }
    }
  })()

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const timer of timers) clearTimeout(timer as Parameters<typeof clearTimeout>[0])
      timers.length = 0
      for (const card of cards) card.dispose()
      cards.length = 0
    },
  }
}
