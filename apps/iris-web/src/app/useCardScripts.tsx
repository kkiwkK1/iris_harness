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
import type { RunningCard } from '../sandbox/runner.ts'
import { STARTED_EVENTS, settledEvents } from '../sandbox/tavern-helper.ts'
import { modeFor, remoteImports, stripCodeFence } from '../sandbox/script-source.ts'
import { bundleFailureReason } from '../sandbox/bundle-proxy.ts'
import { describeRun } from '../sandbox/script-run-state.ts'
import { describeRefusal } from './blocked-line.ts'

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
     * The preset a card's script frame loads — the **message** preset.
     *
     * **Not the script preset, and the reason is that this frame is now the
     * overlay surface.** Upstream injects two libraries into a script frame and
     * eight into a message frame, and the message preset is a strict superset of
     * the script one [44] — it carries Font Awesome and Tailwind, which the
     * script preset does not. A card that draws its interface here (the third
     * class of card, the one option C exists for) styles it with exactly those.
     *
     * The symptom of getting this wrong is the one that cost a round: 银麒赎世's
     * floating button reported a **61×61 box** through `regions`, the clip was
     * correct, hit-testing was correct, and **nothing was drawn** — a box with
     * no icon font and no utility classes behind it. "Box present, screen empty"
     * has several possible causes and this was the cheapest to check, because
     * the ruling that the surface's realm needs the superset had already been
     * made; it simply was not carried through when option C moved the surface
     * onto this frame.
     *
     * **It costs nothing on any page that renders an interface, and saves.** The
     * message preset is content-hashed and cached, and interface frames already
     * load it — so a chat with any rendered panel now fetches **one** preset
     * where it used to fetch two, 1.66 MB instead of 1.66 + 0.83. Only a chat
     * with scripts and no interfaces pays more, and it pays once per page.
     * `FRAME_OVERHEAD_BYTES` is untouched either way: presets are not inlined.
     * @returns the URL to put in the frame's library tag.
     */
    const presetUrl = (): string => {
      if (resolvedAssets === undefined) {
        throw new Error('the sandbox manifest was not resolved before the frame was built')
      }
      return `${window.location.origin}${resolvedAssets.messagePreset}`
    }

    /**
     * The member table's absolute URL for this build.
     *
     * Same shape as `presetUrl`, and it throws for the same reason: a frame
     * built before the manifest resolved would carry a wrong path, and a wrong
     * path here means a frame that comes up and refuses to run anything.
     * @returns the URL to put in the frame's members tag.
     */
    const membersUrl = (): string => {
      if (resolvedAssets === undefined) {
        throw new Error('the sandbox manifest was not resolved before the frame was built')
      }
      return `${window.location.origin}${resolvedAssets.members}`
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
        start: input => {
          /*
           * The frame the call below returns, so `onRegions` can reach it.
           *
           * The clip belongs on the frame element, and the callback that
           * receives it is built *before* the element exists — they are made by
           * the same call. A box assigned on the way out is the smallest honest
           * shape for that; the alternative is holding the clip in React state,
           * which re-renders this hook's whole tree at animation rate for a
           * value exactly one element reads.
           */
          let frame: RunningCard | undefined
          frame = runCard(
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
              members: membersUrl(),
              documentGranted: input.documentGranted,
              // Same origin as the page: the host serves both the interface and the proxy.
              bundleOrigin: window.location.origin,
              // Not in the contract yet, and not defaulted to `true` on the way
              // there: a grant nobody has been asked for is not a grant.
              networkGranted: false,
              context: input.context,
              viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
              /*
               * This frame's box is `attach`'s below, not a measurement's: it is
               * the card's overlay surface, so it is always the whole viewport
               * and the clip decides what it catches. Without this the frame's
               * own `sizing` report stripped that height back off again.
               */
              sizedByHost: true,
              fetch: async url => actionsOf(store).fetchScriptDependency(url),
              onCall: async (method, params) => actionsOf(store).runCardAction(method, params),
              onSlash: async command => actionsOf(store).runSlash(command),
              onSettings: () => undefined,
              // Reported, not swallowed: a blocked subresource is the policy
              // doing its job, and the card author needs the host and directive
              // to know what they reached for.
              /*
               * The card's overlay surface is this frame, so the clip decides
               * which parts of the viewport it may catch a click on.
               *
               * Measured in a real opaque-origin frame: with no clip the frame
               * catches every click everywhere (the shell becomes unusable),
               * and with `pointer-events:none` the card's own nodes **cannot**
               * re-enable themselves. A clip is the only mechanism that gives
               * per-node hit-testing across a frame boundary.
               *
               * Written to the frame element rather than held in state: it
               * changes at animation rate while a card animates, and a state
               * write would re-render the whole hook's tree for a value only
               * one element reads. The frame already deduplicates by string, so
               * this runs only when the clip really changed.
               */
              onRegions: (clip, detail) => {
                frame?.element.style.setProperty('clip-path', clip)
                /*
                 * Reported, not only applied. "The clip is right and the screen
                 * is empty" is a failure class the shell cannot see into, and
                 * this line is the only thing that can say why — so it goes to
                 * the panel rather than staying a style write.
                 */
                if (detail !== undefined) {
                  actionsOf(store).addCardReport(`overlay: ${detail}`)
                }
              },
              onBlocked: (blocked, directive, detail, covered) => {
                const refusal = describeRefusal(blocked, directive, detail, covered)
                /*
                 * The durable channel always, the notice bar only when it is
                 * worth interrupting for.
                 *
                 * The report list exists because this used to be the notice bar
                 * alone — one slot that clears itself after eight seconds, so a
                 * card making five refused requests overwrote its own evidence
                 * four times and then erased the survivor. A refusal is the
                 * sandbox working, and the author still needs to find out which
                 * host and which directive.
                 */
                actionsOf(store).addCardReport(refusal.text, undefined, refusal.grade)
                if (refusal.notify) actionsOf(store).notify('info', refusal.text)
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
          )
          return frame
        },
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
        attach: card => {
          /*
           * **Explicit `width`/`height`, because `inset:0` does not size an
           * iframe.** It is a replaced element, so `width:auto` resolves to its
           * intrinsic 300x150 no matter what the insets say — measured, after a
           * probe whose frame was silently 300x150 and which therefore looked
           * like it disproved this whole approach.
           *
           * The frame fills the surface and `clip-path` decides what it catches.
           * `pointer-events` is left `auto` here and the clip starts as nothing:
           * the frame sends its first `regions` before any card code paints, so
           * there is no window in which an unclipped frame swallows the shell.
           */
          const style = card.element.style
          style.setProperty('position', 'absolute')
          style.setProperty('inset', '0')
          style.setProperty('width', '100%')
          style.setProperty('height', '100%')
          style.setProperty('border', '0')
          style.setProperty('background', 'transparent')
          /*
           * **`pointer-events` is inherited**, and the surface sets `none`.
           *
           * Without this line the frame inherits `none` from its container, so
           * the clip catches nothing and the whole mechanism is inert — the
           * measurement it rests on has the frame at `auto`, and shipping the
           * container's `none` without restating it on the frame quietly broke
           * that premise. The symptom is exactly what a missing clip looks like
           * from outside: the card's own button is not clickable, and it is
           * indistinguishable from "regions never arrived" without reading the
           * computed style.
           *
           * The container stays `none` so that the gaps *between* frames pass
           * through; each frame re-enables itself and its clip decides where.
           */
          style.setProperty('pointer-events', 'auto')
          style.setProperty('clip-path', 'path("M0 0Z")')
          host.append(card.element)
        },
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
      /*
       * A generation starting is announced to the frames and nothing else here.
       *
       * It carries no view, so it is not part of the snapshot refresh above —
       * but a card has to hear it: upstream's `#send_but` disables, `#mes_stop`
       * appears and `is_send_press` goes true at this moment, and a card that
       * hears only the *end* would spend the whole generation believing it was
       * idle. Handled before the filter, since that filter is about views.
       */
      if (event.type === 'stream.start' && event.chatId === chatId) {
        for (const name of STARTED_EVENTS) running.emit(name, [])
        return
      }
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
      /*
       * Empty the surface, and this is **one more cleanup point than upstream
       * has**.
       *
       * `clearChat()` upstream touches only `#chat`'s children and the zoomed
       * avatar — it does not go near the body layer [3c, `script.js:1584-1603`]
       * — and none of the five measured overlay components uninstalls itself.
       * So switching chats upstream leaves the previous card's panel on screen
       * until the page goes.
       *
       * Iris zeroes it, which is a deliberate divergence in the upgrade
       * direction: cards do not clean up, and a reader should not be shown the
       * last conversation's phone UI over this one. Recorded in the ledger as
       * "upstream leaves it, Iris clears it" rather than as a fix.
       *
       * `dispose()` removes the frame it owns; this removes anything else that
       * ended up on the surface, so the invariant is the surface's rather than
       * the frame's.
       */
      const surface = mount.current
      if (surface !== null) surface.replaceChildren()
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
  /*
   * The card's overlay surface: the viewport, above the shell.
   *
   * This used to be a 0×0 box parked off-screen, on the premise that a card's
   * scripts render nothing. [OVERLAY-CARDS.md] found the third class of card
   * that does: it builds its whole interface with `.appendTo('body')`, and
   * upstream's `parent_jquery.js` makes that the host page's body. Here `$` is
   * the frame's own, so the interface was built in a frame nobody could see —
   * "3 of 3 loaded and listening" over a blank screen.
   *
   * **Full viewport, and the frame element needs explicit `width`/`height`.**
   * An iframe is a replaced element, so `position:fixed; inset:0` alone leaves
   * it at its intrinsic 300×150 — measured, after a probe that looked like it
   * disproved this whole approach.
   *
   * `pointer-events` stays `auto` and the **clip** decides what catches
   * clicks (`onRegions` above). The two alternatives were measured and both
   * fail: `auto` with no clip swallows the shell, and `none` makes the card's
   * own interface unclickable because content inside a frame cannot re-enable
   * hit-testing the frame element switched off.
   *
   * `aria-hidden` is gone with the invisibility: this is now real interface, and
   * hiding it from assistive technology would be hiding the card's UI.
   */
  return (
    <div
      ref={mount}
      className="iris-overlay-surface"
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        // Above the shell's own layers, whose highest is 30.
        zIndex: 'var(--iris-overlay-z, 40)' as unknown as number,
        // The container never catches anything; each frame's clip decides.
        pointerEvents: 'none',
      }}
    />
  )
}
