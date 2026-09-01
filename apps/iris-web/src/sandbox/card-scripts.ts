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
  /** Start one frame. Injected so the sequencing can be tested without a DOM. */
  start: (input: {
    script: ScriptView
    code: string
    context: ScriptContext
    /** Fetched once for the set; every frame in it is built from this text. */
    bootstrap: string
    documentGranted: boolean
    onPhase: (state: Omit<ScriptRunState, 'scriptId' | 'name'>) => void
  }) => RunningCard
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

      try {
        cards.push(
          env.start({
            script,
            code: source.content,
            context,
            bootstrap,
            documentGranted: resolved.documentGranted,
            onPhase: next => move(script, next),
          }),
        )
      } catch (error: unknown) {
        // `continue`, not `return`: one script that cannot be started must not
        // decide the fate of the ones after it.
        move(script, {
          phase: 'bootstrap-failed',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
  })()

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const card of cards) card.dispose()
      cards.length = 0
    },
  }
}
