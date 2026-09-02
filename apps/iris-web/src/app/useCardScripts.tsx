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
import { actionsOf, tapHostEvents } from '../client/store.ts'
import { startCardScripts } from '../sandbox/card-scripts.ts'
import { registerCardEmitter } from './card-bus.ts'
import { checkBootstrap } from '../sandbox/bootstrap-source.ts'
import { librariesFor } from '../sandbox/libraries.ts'
import {
  SANDBOX_MANIFEST_PATH,
  parseSandboxManifest,
  type SandboxAssets,
} from '../sandbox/asset-manifest.ts'
import { runCard } from '../sandbox/runner.ts'
import { settledEvents } from '../sandbox/tavern-helper.ts'
import { modeFor, remoteImports, stripCodeFence } from '../sandbox/script-source.ts'
import { bundleFailureReason } from '../sandbox/bundle-proxy.ts'
import { describeRun } from '../sandbox/script-run-state.ts'

/**
 * Resolve this build's sandbox artifacts, once per run.
 *
 * The names carry content hashes, so nothing may hardcode them. The manifest is
 * the one fixed path, and it is validated rather than trusted for the reason the
 * bootstrap already was: a dev server answers an unknown path with its index at
 * status 200, so `response.ok` is not evidence of anything.
 * @returns the asset URLs for this build.
 */
async function sandboxAssets(): Promise<SandboxAssets> {
  const response = await fetch(SANDBOX_MANIFEST_PATH)
  if (!response.ok) throw new Error(`sandbox manifest: HTTP ${String(response.status)}`)
  const parsed = parseSandboxManifest(await response.text())
  if (typeof parsed === 'string') throw new Error(`sandbox manifest: ${parsed}`)
  return parsed
}

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

    /*
     * A new run starts here, and the panel's reports are dated from it.
     *
     * This effect re-runs for a new chat, a new card, or a fresh consent answer
     * — which is exactly the set of things that make earlier findings historical
     * rather than current. Without a mark at this point, a re-run of the same
     * card left the previous attempt's reports sitting in the present tense.
     */
    actionsOf(store).beginCardRun()

    /** This build's artifacts, resolved by `bootstrap` before `start` needs them. */
    let resolvedAssets: SandboxAssets | undefined

    /**
     * The preset's absolute URL for this build.
     * @returns the URL to put in the frame's library tag.
     */
    const presetUrl = (): string => {
      if (resolvedAssets === undefined) {
        throw new Error('the sandbox manifest was not resolved before the frame was built')
      }
      return `${window.location.origin}${resolvedAssets.preset}`
    }

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
        /*
         * Resolved once by `bootstrap` and read by `start`.
         *
         * The two callbacks need the same build's artifacts and the controller
         * runs them in that order, so fetching the manifest twice would be a
         * second chance to disagree with itself rather than a safety net. It is
         * asserted rather than defaulted below: a missing value here would mean
         * the contract's ordering had changed, and quietly falling back to an
         * unhashed guess is how a stale asset gets served again.
         */
        bootstrap: async () => {
          /*
           * Both the name and the bytes are checked, and they catch different
           * things. The manifest guards against fetching a file this build did
           * not produce; `checkBootstrap` guards against the right file arriving
           * transformed — a dev server once returned it as an ES module, which is
           * a parse error inside a classic `srcdoc` script and therefore silent.
           */
          resolvedAssets = await sandboxAssets()
          const response = await fetch(resolvedAssets.bootstrap)
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
              libraries: librariesFor('card-script', presetUrl()),
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
              onBlocked: (blocked, directive, detail) => {
                const text = detail === undefined
                  ? `blocked ${blocked} (${directive})`
                  : `blocked ${blocked}${detail} (${directive})`
                /*
                 * Both channels, and the durable one is the point.
                 *
                 * This used to be the notice bar alone — one slot that clears
                 * itself after eight seconds. A card whose interface makes five
                 * refused requests would overwrite its own evidence four times
                 * and then erase the survivor, which is the exact failure the
                 * card report list was introduced to end. A refusal is the
                 * sandbox working, and the author still needs to find out which
                 * host and which directive.
                 */
                actionsOf(store).addCardReport(text)
                actionsOf(store).notify('info', text)
              },
              /*
               * What the frame paid for its libraries. Durable, because it is a
               * standing fact about cost rather than a passing event, and because
               * the experiment it exists for compares two frames opened minutes
               * apart.
               */
              onNote: text => actionsOf(store).addCardReport(text),
              /*
               * Readiness belongs to the frame, so it is reported for every
               * script in it — they all started when it did.
               */
              onReady: () => {
                for (const script of input.scripts) input.onPhase(script.id, { phase: 'running' })
              },
              onRan: (scriptId, lateMs) => {
                input.onPhase(scriptId, {
                  phase: 'ran',
                  ...(lateMs === undefined ? {} : { lateMs }),
                })
                /*
                 * A late arrival refutes the verdict the deadline already
                 * published. The row fixes itself, but the report list is
                 * durable by design, so without this the panel keeps mourning a
                 * script that is up and working — which is exactly what a real
                 * card did while all three of its consumers ran fine.
                 */
                if (lateMs !== undefined && scriptId !== undefined) {
                  actionsOf(store).withdrawReportsFor(scriptId)
                }
              },
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
          const text = `${state.name}: ${describeRun(state)}`
          /*
           * Both, and for different reasons. The notice is the immediate signal;
           * the card's report list is the record. The notice bar holds one entry
           * and clears itself after eight seconds, so a burst of startup reports
           * destroys itself — which once read, from outside, as the reports never
           * having been sent.
           */
          actionsOf(store).addCardReport(text, state.scriptId)
          actionsOf(store).notify('error', text)
        },
      },
      chatId,
      characterId,
    )

    /*
     * Keep the frames’ snapshot current while the chat moves under them.
     *
     * A card's `getChatMessages` answers from the snapshot its frame holds, and
     * without this that snapshot is frozen at the moment the frame was built.
     * MVU's generation-time chain reads the floor that just arrived and writes
     * a rewritten version back (`on_message_received.ts:54-56`) — against a
     * frozen snapshot it reads the *previous* floor and rewrites the wrong one.
     *
     * **Two events, not one.** The ruling named `chat.updated`, and that alone
     * would have missed the case the whole change exists for: a reply that just
     * finished generating settles through `stream.end`, which carries its own
     * view and is the only notice that floor exists. `chat.updated` covers
     * edits, swipes and script writes. Between them they are every event in
     * `applyEvent` that assigns `view`, which is the property that matters here
     * rather than the names.
     *
     * Streaming deltas are deliberately not in that set: they move `stream`,
     * not `view`, and refreshing per token would put a host round trip between
     * every pair of characters.
     */
    const untap = tapHostEvents(store, event => {
      if (event.type !== 'chat.updated' && event.type !== 'stream.end') return
      if (event.chatId !== chatId) return
      /*
       * A settled generation is announced into the frames under upstream's own
       * names, not only used here.
       *
       * Nothing in this app emitted `generation_ended` or `generation_stopped`
       * for most of its life, so every card subscribing to them — and
       * `injectPrompts({once:true})`, which revokes on them — waited forever and
       * was never told. Silently: no error, no report, the injected text simply
       * kept appearing in every later prompt.
       *
       * Which names go out is decided by `settledEvents` from `reason`, so a
       * completion and an abort are distinguishable the way they are upstream.
       * That field arrived after this call site did; before it, one Iris-only
       * name was the honest answer, because emitting either upstream name off an
       * undifferentiated event would have made completions look like aborts or
       * hidden aborts entirely.
       *
       * `stream.end` only. `chat.updated` covers edits, swipes and script
       * writes, none of which is a generation settling, and revoking a `once`
       * injection on a swipe would take it away mid-conversation.
       */
      if (event.type === 'stream.end') {
        for (const name of settledEvents(event.reason)) running.emit(name, [])
      }
      /*
       * Not awaited, and failures are the controller’s to report: a refresh
       * that loses a race with teardown is already guarded inside `refresh`,
       * and there is nothing for a listener to do about a host that did not
       * answer except try again on the next event.
       */
      void running.refresh()
    })

    /*
     * Publish the way in, so the interface can reach this card.
     * `registerCardEmitter` returns a disposer that only clears the slot if it
     * is still holding *this* emitter — a late teardown from a previous card
     * would otherwise silence the one that replaced it.
     */
    const unregister = registerCardEmitter((event, args) => {
      running.emit(event, args)
    })

    return () => {
      unregister()
      untap()
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
