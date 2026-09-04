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
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { useIris, useIrisActions, useIrisStore } from '../client/provider.tsx'
import { actionsOf, tapHostEvents } from '../client/store.ts'
import { startCardScripts } from '../sandbox/card-scripts.ts'
import { registerCardEmitter } from './card-bus.ts'
import { broadcastWindowEvent, registerWindowEventSink } from './window-events.ts'
import { checkBootstrap } from '../sandbox/bootstrap-source.ts'
import { librariesFor } from '../sandbox/libraries.ts'
import {
  SANDBOX_MANIFEST_PATH,
  parseSandboxManifest,
  type SandboxAssets,
} from '../sandbox/asset-manifest.ts'
import { runCard } from '../sandbox/runner.ts'
import type { RunningCard } from '../sandbox/runner.ts'
import { overlayViewport } from './overlay-surface.ts'
import { STARTED_EVENTS, settledEvents } from '../sandbox/tavern-helper.ts'
import { modeFor, remoteImports, stripCodeFence } from '../sandbox/script-source.ts'
import { bundleFailureReason } from '../sandbox/bundle-proxy.ts'
import { describeRun, isFailure } from '../sandbox/script-run-state.ts'
import { describeRefusal } from './blocked-line.ts'
import { useLanguage, t } from './i18n/use-language.ts'
import { getLanguage } from './i18n/language.ts'

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
   * Whether a card's frame is on the surface right now.
   *
   * The collapse control below is an escape hatch **for a frame**, so it exists
   * exactly while a frame does: set when `attach` puts one on the surface,
   * cleared when the run's teardown empties it. Derived from the element rather
   * than from script states, because the thing being escaped is geometry — a
   * card whose scripts report fine but whose interface ate the screen — and a
   * frame with no reported states yet is precisely the case that needs the
   * hatch most.
   */
  const [occupied, setOccupied] = useState(false)

  /*
   * Whether the reader has collapsed the card's interface back into Iris.
   *
   * Deliberately **not** keyed to the chat: it is reset in the run's teardown
   * below, which is the one point every way a surface changes passes through —
   * a new chat, a new card, a re-answered consent — so the next interface always
   * arrives shown, and a collapse never silently outlives the frame it hid.
   */
  const [collapsed, setCollapsed] = useState(false)

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

    /*
     * **Read the consent fresh, and check it belongs to this card.**
     *
     * `consent` here is the render's snapshot, and by the time this effect body
     * runs another effect in this same component has already called
     * `loadScripts` — which sets `scriptsAllowed: 'unknown'` before its round
     * trip and `consentState(listed)` after. So on every card change the value
     * goes `allowed → unknown → allowed`, and the snapshot still says
     * `allowed` at the first of those three.
     *
     * Measured on 8787: that started **a whole extra run per chat open** — a
     * sandbox frame built, its bootstrap and member table fetched, its scripts
     * begun, and the lot disposed a moment later when consent settled. Six
     * opens produced seven runs, and the host recorded five ends with "no
     * injection on this chat ever named it".
     *
     * `scriptsFor` is what makes the check possible: `loadScripts` sets it
     * synchronously, before awaiting, so a consent value can be tested against
     * the card it describes rather than trusted because it is the right string.
     *
     * The host's note is deliberately **not** suppressed for empty runs. It is
     * the instrument that caught this, and a shell that stopped reporting runs
     * which injected nothing would have hidden it.
     */
    const settled = store.getState()
    if (settled.scriptsFor !== characterId) return
    if (settled.scriptsAllowed !== 'allowed') return

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
              /*
               * **The surface's box, not the window's.**
               *
               * This frame's viewport *is* the overlay surface — the frame
               * fills it with `width:100%; height:100%` — so the number a card
               * hears here has to be the surface's own content box. It used to
               * be `window.innerWidth/innerHeight`, which was correct only for
               * as long as the surface was the whole window, and became the
               * two-sources failure a user measured: a frame laying out at
               * 1449px against a viewport the shell believed was 1218px, both
               * numbers plausible, neither tied to the element the frame
               * actually fills. One element now decides, so they cannot
               * disagree (`overlay-surface.ts`).
               */
              viewport: () =>
                overlayViewport(mount.current, {
                  width: window.innerWidth,
                  height: window.innerHeight,
                }),
              /*
               * This frame's box is `attach`'s below, not a measurement's: it is
               * the card's overlay surface — the reading column's box, laid out
               * by the shell — and the clip decides what it catches. Without
               * this the frame's own `sizing` report stripped that height back
               * off again.
               */
              sizedByHost: true,
              fetch: async url => actionsOf(store).fetchScriptDependency(url),
              onCall: async (method, params) => actionsOf(store).runCardAction(method, params),
              onSlash: async command => actionsOf(store).runSlash(command),
              /*
               * A settings report is the card's extension settings partition —
               * the whole object, posted on every proxied write and on
               * `SillyTavern.saveSettings[Debounced]`. Dropped here, every
               * write-after-read loop a card runs (`if
               * (!extensionSettings.key) { …; extensionSettings.key = … }`)
               * recomputes forever and a settings key it probes for never
               * reads back — upstream's `saveSettingsDebounced` persists, and
               * this is the one road to that same answer.
               */
              onSettings: settings => {
                void actionsOf(store).saveCardExtensionSettings(settings)
              },
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
                  actionsOf(store).addCardReport(detail, { channel: 'overlay' })
                }
              },
              /*
               * A dispatch on the page window this frame sees. Handed to the
               * fan-out rather than emitted straight back into this frame, so a
               * listener in the message frames hears a dispatch made here — the
               * page-wide reach `parent.dispatchEvent` promises upstream.
               */
              onWindowEvent: (event, detail) => {
                broadcastWindowEvent(event, detail)
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
                actionsOf(store).addCardReport(refusal.text, { grade: refusal.grade })
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
          // The surface has a frame on it, so the collapse control exists.
          setOccupied(true)
        },
        onState: states => actionsOf(store).setRunStates(states),
        onFailure: state => {
          /*
           * One notice per failure, naming the script and what it reached for.
           * A card that fails must not take the conversation with it, so this is
           * a notice rather than anything that interrupts reading.
           */
          const text = `${state.name}: ${describeRun(state, getLanguage())}`
          /*
           * Both, and for different reasons. The notice is the immediate signal;
           * the card's report list is the record. The notice bar holds one entry
           * and clears itself after eight seconds, so a burst of startup reports
           * destroys itself — which once read, from outside, as the reports never
           * having been sent.
           */
          /*
           * Graded by the phase, not by the channel. This callback fires for
           * every phase change, and only some of them describe something
           * broken — `isFailure` is the same predicate the panel uses to colour
           * a run, so the report list and the run list cannot disagree about
           * whether a script failed.
           *
           * Measured: the storage probe's over-quota write produced
           * `failed: probe.big … was not written` as a **neutral** row, because
           * this site passed no grade at all. A line that says "failed" and
           * renders like routine traffic is the failure the grade exists for.
           */
          actionsOf(store).addCardReport(text, {
            ...(state.scriptId === undefined ? {} : { scriptId: state.scriptId }),
            ...(isFailure(state.phase) ? { grade: 'fault' as const } : {}),
          })
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

    /*
     * This card's frames are one half of the page window's audience. A window
     * event dispatched anywhere — here or in a message frame — comes back
     * through the fan-out and is emitted into the script frames exactly as a
     * host event would be, so a listener registered through
     * `parent.addEventListener` and one through `eventOn` hear the same bus.
     */
    const unregisterWindowEvents = registerWindowEventSink((event, args) => {
      running.emit(event, args)
    })

    /*
     * The surface's own box, watched directly.
     *
     * A window `resize` is one way the box changes, and the runner already
     * listens for it — but the surface is laid out inside the reading column,
     * so a layout change above it reshapes the frame with **no window event at
     * all**: a notice appearing, a panel opening, a pane toggling. Each of
     * those changes what the card was told its viewport is, and a stale
     * viewport is the mismatch class this whole arrangement exists to kill.
     *
     * The push is cheap by construction: `applyViewport` deduplicates by value,
     * so a change that does not alter the numbers costs one message and
     * nothing else, and the runner's own resize listener covers the window
     * case whatever this observer does.
     */
    let surfaceWatcher: ResizeObserver | undefined
    if (typeof ResizeObserver === 'function') {
      surfaceWatcher = new ResizeObserver(() => running.resize())
      surfaceWatcher.observe(host)
    }

    return () => {
      unregister()
      unregisterWindowEvents()
      surfaceWatcher?.disconnect()
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
      // No frame on the surface, so no collapse control and no collapse: the
      // next interface arrives shown, whichever way this run ended.
      setOccupied(false)
      setCollapsed(false)

      /*
       * And tell the host the run is over, so the injections it is holding for
       * this run go with the frame.
       *
       * **The frame cannot do this itself.** Its teardown is the removal of the
       * frame, so by the time anything would notice, the channel to it is gone
       * — which is exactly how "6 script injections are still live on this chat
       * from an earlier session" came to be a standing report rather than an
       * event.
       *
       * Not awaited: this is a React cleanup and cannot be async, and the host
       * needs no answer from us. If the call never lands, the host keeps the
       * injections and reports them as an orphan run — which is the case it
       * chose to report rather than guess about, since it cannot tell an orphan
       * from another page's live run.
       */
      void actionsOf(store).endCardRun()
    }
  }, [chatId, characterId, consent, store, actions])

  /*
   * A best-effort `runEnded` when the page itself goes.
   *
   * `pagehide` rather than `beforeunload` or `unload`: it is the one that fires
   * on mobile and on a back-forward-cache navigation, where the other two are
   * unreliable or skipped entirely. Nothing is awaited — a handler cannot hold
   * the page open, and the whole value here is the *chance* that the call
   * leaves before the tab does.
   *
   * A failure is not a defect: the host keeps injections it was not told about
   * and reports them, which is why the orphan report exists at all. This
   * listener only reduces how often a reader sees one.
   */
  useEffect(() => {
    const onHide = (): void => {
      void actionsOf(store).endCardRun()
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
    }
  }, [store])

  /*
   * **The reading column, not the window.**
   *
   * This used to be `position:fixed; inset:0` — the whole viewport, sidebar
   * and masthead included. That is upstream's own arrangement (a card appends
   * to the page's body and may own the window), and it is exactly the property
   * a user ruled out: a card whose interface fills the screen left no way back
   * to Iris's own navigation, because the surface covered it. Iris's product
   * requirement is that **the shell's navigation is always reachable**, so the
   * surface is `position:absolute; inset:0` inside the reading column's
   * container (`.iris-card-stage` in `App.tsx`) — the browser computes the
   * rectangle from the layout, there is no second copy of the geometry to
   * drift, and a window resize keeps it correct with no code at all.
   *
   * The cost is recorded in `DEVIATIONS.md` §25: a card designed against the
   * whole window now lays out against the column, which is narrower. That is
   * the product decision; the mechanism below is what makes it real:
   *
   * - the frame fills this box, so the card's `100dvh` / `position:fixed`
   *   ladder resolves against the column (`OVERLAY-HOST.md` §一);
   * - the viewport metrics published to the card are read off this same box
   *   (`overlayViewport` above), so geometry and numbers are one source;
   * - a `ResizeObserver` re-publishes them whenever the box changes for any
   *   reason, not only on a window resize.
   *
   * `pointer-events` stays `auto` on the frames and the **clip** decides what
   * catches clicks (`onRegions` above). The two alternatives were measured and
   * both fail: `auto` with no clip swallows the shell, and `none` makes the
   * card's own interface unclickable because content inside a frame cannot
   * re-enable hit-testing the frame element switched off.
   *
   * **Collapse is `visibility`, never `hidden`.** The reader's escape hatch
   * below toggles this element's visibility. `display:none` is observable from
   * inside a frame — a card measuring itself gets zeros, and the published
   * viewport stops describing anything real. `visibility:hidden` keeps the
   * box laid out and the numbers true: the card neither knows nor cares, its
   * animations keep their geometry, and showing it again is a style write, not
   * a reload.
   */
  return (
    <>
      {/*
       * `iris-overlay-surface` is a **marker class with no stylesheet rule, and
       * deliberately so.** Every geometric decision about this element is inline
       * below, because its size and layering are load-bearing and a stylesheet
       * rule could be overridden by a card's own CSS. The class exists so a
       * reader — or a CDP probe — can find the element by name.
       *
       * Said here because an audit of applied-versus-defined classes flags it,
       * and a finding with no answer beside it gets rediscovered every time.
       */}
      <div
        ref={mount}
        className="iris-overlay-surface"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          // Above the shell's own layers, whose highest is 30.
          zIndex: 'var(--iris-overlay-z, 40)' as unknown as number,
          // The container never catches anything; each frame's clip decides.
          pointerEvents: 'none',
          // The reader's collapse toggle: hidden to the eye and to the pointer,
          // while every measurement inside the frame stays real.
          visibility: collapsed ? 'hidden' : 'visible',
        }}
      />
      {/*
       * Iris's own way back.
       *
       * A card that breaks its own interface — or simply takes the whole
       * column — used to leave the reader with nothing of theirs on screen.
       * Upstream's answer is the card's own escape (V1.5.4's page declares ESC
       * exits its fullscreen); that is the card's key, and Iris binding a
       * competing one would make the two fight over every keystroke. So the
       * guaranteed exit is a **click**: a small Iris-owned control above the
       * surface (`z` = the surface's layer + 5, so it follows that variable),
       * positioned inside the reading column's container — it never strays
       * over the sidebar or the masthead, and it needs no geometry of its own.
       *
       * It exists exactly while a frame does (`occupied`), and its label names
       * the state it will produce rather than the one it is in, which is the
       * reading a control hiding an interface needs.
       */}
      {occupied ? (
        <CollapseToggle collapsed={collapsed} onToggle={() => setCollapsed(current => !current)} />
      ) : null}
    </>
  )
}

/**
 * The collapse control's own component, so it can subscribe to the language.
 *
 * A hook cannot be called conditionally, and this button exists only while a
 * frame occupies the surface — so the subscription lives here rather than in
 * `CardScriptFrames`'s body.
 */
function CollapseToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}): ReactElement {
  // Subscribed so a language switch re-renders the control's label.
  useLanguage()
  return (
    <button
      type="button"
      className="iris-overlay-toggle"
      aria-pressed={collapsed}
      title={collapsed ? t('showCardUiTitle') : t('hideCardUiTitle')}
      onClick={onToggle}
    >
      {collapsed ? t('showCardUi') : t('hideCardUi')}
    </button>
  )
}
