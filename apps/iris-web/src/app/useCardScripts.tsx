/**
 * Card scripts, bound to the chat that is in front of the user.
 *
 * The lifetime is the point. A frame set belongs to "this chat is in the
 * foreground" — switching chats, switching cards, or closing the drawer on the
 * way out all tear it down completely, which is the same Cordis invariant the
 * rest of this project runs on and the same shape the future
 * card-UI-in-a-message pipeline will need for "this message is on screen".
 *
 * Three rules from `AUTORUN.md` are enforced here rather than downstream:
 *
 * - **Only an explicit yes runs anything.** `unasked` and `declined` both run
 *   nothing; they differ in what the panel shows, never in what executes.
 * - **Grants are re-resolved from the host** every time a set starts. Nothing
 *   here reads the store's cached `documentGranted`, because that cache is keyed
 *   on a character id and character ids are reused.
 * - **Failures land somewhere.** A script that fails on chat open has no panel
 *   in front of it, so the state goes to the store and the failure goes to the
 *   notice bar. Silence would be indistinguishable from a card with no scripts.
 *
 * @module iris-web/app/useCardScripts
 */
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'

import { useIris, useIrisActions, useIrisStore } from '../client/provider.tsx'
import { actionsOf } from '../client/store.ts'
import { startCardScripts } from '../sandbox/card-scripts.ts'
import { checkBootstrap } from '../sandbox/bootstrap-source.ts'
import { librariesFor } from '../sandbox/libraries.ts'
import { runCard } from '../sandbox/runner.ts'
import { modeFor, remoteImports, stripCodeFence } from '../sandbox/script-source.ts'
import { bundleFailureReason } from '../sandbox/bundle-proxy.ts'
import { describeRun } from '../sandbox/script-run-state.ts'

/**
 * Run the foreground chat's card scripts, and tear them down when it leaves.
 *
 * Returns the element the frames live in. They render nothing today — card UI
 * inside a message is a separate piece — so it is present in the layout but
 * carries no space.
 * @returns the mount point for this chat's frames.
 */
export function CardScriptFrames(): ReactElement {
  const chatId = useIris(state => state.chatId)
  const characterId = useIris(state => state.view?.characterId)
  const consent = useIris(state => state.scriptsAllowed)
  const store = useIrisStore()
  const actions = useIrisActions()
  const mount = useRef<HTMLDivElement>(null)

  /*
   * Load the card's script list here, not only in the settings panel.
   *
   * The panel used to be the only caller, which made the whole consent flow
   * depend on a drawer being mounted: no list meant no counts, no question and
   * no run. It happens to mount today because the drawer renders while closed,
   * but that is a layout detail holding up a permission decision. This component
   * is always mounted and already owns "this chat's scripts", so it owns
   * knowing what they are.
   *
   * `loadScripts` returns early when it already holds this card, so the panel
   * asking as well costs nothing.
   */
  useEffect(() => {
    if (characterId === undefined) return
    void actions.loadScripts(characterId)
  }, [characterId, actions])

  useEffect(() => {
    if (chatId === undefined || characterId === undefined) return
    if (consent !== 'allowed') return

    const host = mount.current
    if (host === null) return

    const running = startCardScripts(
      {
        /*
         * Asked of the host now, not read from `state.documentGranted`. The
         * store's copy is keyed on a character id, and a deleted card frees its
         * id for the next card of that name — so a cached grant can belong to a
         * card that no longer exists, and nobody is watching this path.
         */
        resolve: async id => actionsOf(store).resolveScripts(id),
        context: async (chat, character) => actionsOf(store).scriptContext(chat, character),
        body: async (character, scriptId) => actionsOf(store).scriptBody(character, scriptId),
        bootstrap: async () => {
          // `/sandbox/` is the one directory served verbatim. A stale path here
          // returns the SPA fallback at status 200, so `response.ok` proves
          // nothing and the source is checked before it is injected.
          const response = await fetch('/sandbox/bootstrap.js')
          if (!response.ok) throw new Error(`bootstrap: HTTP ${String(response.status)}`)
          const source = await response.text()
          const unusable = checkBootstrap(source)
          if (unusable !== undefined) throw new Error(`bootstrap: ${unusable}`)
          return source
        },
        start: input =>
          runCard(
            {
              bootstrap: input.bootstrap,
              // One frame for the card's whole set. Each script still evaluates
              // as its own module, so their top-level bindings stay separate;
              // what they share is `window`, which is what lets a provider hand
              // a live interface to its siblings.
              scripts: input.scripts.map(script => ({
                id: script.id,
                code: stripCodeFence(script.code),
              })),
              mode: modeFor('card-script'),
              libraries: librariesFor('card-script', window.location.origin),
              documentGranted: input.documentGranted,
              // Same origin as the page: the host serves both the interface and the proxy.
              bundleOrigin: window.location.origin,
              // Not in the contract yet, and not defaulted to `true` on the way
              // there: a grant nobody has been asked for is not a grant.
              networkGranted: false,
              context: input.context,
              viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
              fetch: async url => actionsOf(store).fetchScriptDependency(url),
              onCall: async (method, params) => actionsOf(store).runCardAction(method, params),
              onSlash: async command => actionsOf(store).runSlash(command),
              onSettings: () => undefined,
              // Reported, not swallowed: a blocked subresource is the policy
              // doing its job, and the card author needs the host and directive
              // to know what they reached for.
              onBlocked: (blocked, directive) =>
                actionsOf(store).notify('info', `blocked ${blocked} (${directive})`),
              /*
               * Readiness belongs to the frame, so it is reported for every
               * script in it — they all started when it did.
               */
              onReady: () => {
                for (const script of input.scripts) input.onPhase(script.id, { phase: 'running' })
              },
              onRan: scriptId => input.onPhase(scriptId, { phase: 'ran' }),
              /*
               * A wait shows as its own phase and names what it is blocked on.
               * When it ends the script goes back to `ran` — the body did finish
               * evaluating; it was its continuation that was parked.
               */
              onWaiting: (scriptId, global, state, elapsedMs) =>
                input.onPhase(
                  scriptId,
                  state === 'waiting'
                    ? { phase: 'waiting', waitingFor: global, waitingMs: elapsedMs }
                    : { phase: 'ran' },
                ),
              onBootstrapError: message => {
                for (const script of input.scripts) {
                  input.onPhase(script.id, { phase: 'bootstrap-failed', detail: message })
                }
              },
              onError: (message, member, scriptId) => {
                input.onPhase(
                  scriptId,
                  member === undefined
                    ? { phase: 'threw', detail: message }
                    : // The message travels too. It carries the refusal's own
                      // explanation — whether this is policy or a gap in Iris —
                      // and dropping it left the panel asserting a reason it did
                      // not have.
                      { phase: 'refused', member, detail: message },
                )
                if (member !== undefined) return
                /*
                 * Then ask the host why, if this was a bundle it fetched.
                 *
                 * Reported first and enriched after: the reader gets the failure
                 * immediately, and the reason replaces the browser's
                 * "failed to fetch dynamically imported module" — a sentence that
                 * names nothing — as soon as the host answers. The frame cannot
                 * make this request itself; from an opaque origin the header is
                 * not on the CORS safelist even when the response is readable.
                 */
                void (async () => {
                  for (const url of remoteImports(input.scripts.find(s => s.id === scriptId)?.code ?? '')) {
                    const reason = await bundleFailureReason(url, window.location.origin, target =>
                      fetch(target),
                    )
                    if (reason === undefined) continue
                    input.onPhase(scriptId, { phase: 'threw', detail: `${message} — ${reason}` })
                    return
                  }
                })()
              },
            },
            host.ownerDocument,
          ),
        /*
         * Into the document, which is what makes it run at all.
         *
         * `runCard` builds the iframe and stops there; an iframe that is never
         * inserted never loads, so the bootstrap never parses and the frame never
         * says anything. This was missing on the first pass and produced a
         * perfectly quiet failure: two scripts stuck on `starting…`, no frames,
         * no console errors, no notices — nothing had failed, because nothing had
         * begun.
         */
        attach: card => host.append(card.element),
        onState: states => actionsOf(store).setRunStates(states),
        onFailure: state => {
          /*
           * One notice per failure, naming the script and what it reached for.
           * A card that fails must not take the conversation with it, so this is
           * a notice rather than anything that interrupts reading.
           */
          actionsOf(store).notify('error', `${state.name}: ${describeRun(state)}`)
        },
      },
      chatId,
      characterId,
    )

    return () => {
      running.dispose()
      actionsOf(store).setRunStates([])
    }
  }, [chatId, characterId, consent, store, actions])

  /*
   * Off-screen, not `hidden`.
   *
   * `hidden` is `display: none`, and that is observable from inside a frame: a
   * card measuring itself gets zeros, and the viewport height the bootstrap
   * publishes as `--TH-viewport-height` stops describing anything real. These
   * scripts render nothing today, so it would not bite yet — but "it does not
   * matter yet" is how a frame ends up behaving differently here than in the
   * message pipeline that will reuse this shape.
   */
  return (
    <div
      ref={mount}
      aria-hidden="true"
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', left: '-9999px' }}
    />
  )
}
