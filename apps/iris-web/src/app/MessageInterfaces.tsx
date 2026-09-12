/**
 * A message's card interfaces, mounted inside the message itself.
 *
 * The counterpart to `CardScriptFrames`, and it differs in the one way that
 * matters: a script frame is hidden off-screen because nobody looks at it, while
 * a message frame **is** the thing being looked at, so it lives inside the row
 * and takes part in its layout.
 *
 * Written as a component used by `Message` rather than as props threaded down
 * from `ChatPane`, for the same reason `CardScriptFrames` is one: the supply —
 * grants, snapshot, this build's assets — is store state, and passing five props
 * through a list that re-renders on every token would be five more chances for a
 * stale closure to rebuild a 360 KiB interface.
 *
 * @module iris-web/app/MessageInterfaces
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'

import type { MessageView, ScriptContext } from '@iris/protocol'

import type { MessageStyle } from './html-regions.ts'

import { actionsOf, tapHostEvents } from '../client/store.ts'
import { describeRefusal } from './blocked-line.ts'
import { cardPopupBridge } from './card-popups.ts'
import { useIris, useIrisStore } from '../client/provider.tsx'
import {
  SANDBOX_MANIFEST_PATH,
  parseSandboxManifest,
  type SandboxAssets,
} from '../sandbox/asset-manifest.ts'
import { interfacesMayBuild } from '../sandbox/consent.ts'
import { MVU_UPDATE_ENDED_EVENT } from '../sandbox/tavern-helper.ts'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

import {
  claimMessageSurfaces,
  splitAroundInterfaces,
  unwrapUnknownTagsOutsideCode,
} from '../sandbox/frontend-blocks.ts'
import { describeInterface, type InterfaceState } from '../sandbox/message-frames.ts'
import { useFloorGate } from './FrameBudget.tsx'
import { runCard } from '../sandbox/runner.ts'
import { sandboxPluginRuntime, type SandboxPluginRuntime } from '@iris/plugin-web-api'
import { broadcastWindowEvent } from './window-events.ts'
import { useMessageInterfaces } from './useMessageInterfaces.tsx'
import { repairStrayFences } from './stray-fences.ts'
import { getBodyTag, splitBodyTag, subscribeBodyTag } from './body-tag.ts'
import { useLanguage, t } from './i18n/use-language.ts'
import { getLanguage } from './i18n/language.ts'

/**
 * This build's asset names, fetched at most once per page.
 *
 * Memoised at module scope deliberately. Every displayed message would otherwise
 * ask for the same manifest, and on a long conversation that is a request per
 * row for something that cannot have changed — the manifest names content-hashed
 * artifacts, so "the same build" is the only thing it can mean.
 *
 * The promise is cached rather than the value, so concurrent rows share one
 * in-flight fetch instead of racing.
 *
 * **It used to fetch the bootstrap's 53 KB of source too**, and validate it
 * before injection, because the frame carried that text inlined. The frame loads
 * it by URL now (§91), so what this resolves is names; the bytes are checked at
 * build time and, in the frame that actually loaded them, by the frame's own
 * guard.
 */
let supply: Promise<SandboxAssets> | undefined

/**
 * Resolve the asset names for this build.
 * @returns the shared supply.
 */
function sandboxSupply(): Promise<SandboxAssets> {
  supply ??= (async () => {
    const manifest = await fetch(SANDBOX_MANIFEST_PATH)
    if (!manifest.ok) throw new Error(`sandbox manifest: HTTP ${String(manifest.status)}`)
    const assets = parseSandboxManifest(await manifest.text())
    if (typeof assets === 'string') throw new Error(`sandbox manifest: ${assets}`)
    return assets
  })()
  return supply
}

/**
 * A message's body, with any card interface in place of its block — whatever
 * the row's role.
 *
 * Renders the **whole** body rather than an addition to it, because replacing a
 * block is not something that can be done from beside it: `MarkdownText` only
 * makes a `<pre>` if it is handed the text, so the only way to not show the source
 * is to not hand it over.
 *
 * The claim itself is role-blind — upstream renders message HTML wherever the
 * floor sits, and a console can write a floor of markup onto a user row. What
 * the role decides is the **prose between frames**: an assistant row's unclaimed
 * segments read as markdown, every other row's stay the raw text that row has
 * always shown. This is a routing component, not a policy one — the budget, the
 * consent gate and the sandbox wall are identical on both sides of that split.
 * @param props - the floor, its text after display regex, whether it is still
 *   arriving, and the row's role.
 * @returns the message body.
 */
export function MessageInterfaces({
  floor,
  text,
  streaming,
  role,
}: {
  floor: number
  text: string
  streaming: boolean
  role: MessageView['role']
}): ReactElement {
  const markdownProse = role === 'assistant'
  const chatId = useIris(state => state.chatId)
  const characterId = useIris(state => state.view?.characterId)
  const consent = useIris(state => state.scriptsAllowed)
  const pluginSnapshot = useIris(state => state.systemPlugins)
  const pluginRuntime = sandboxPluginRuntime(pluginSnapshot)
  const pluginRevision = pluginRuntime?.revision
  const tavernHelperEnabled = pluginRuntime?.tavernHelper === true
  const mvuEnabled = pluginRuntime?.mvu === true
  const store = useIrisStore()

  /*
   * One slot per interface, keyed by instance.
   *
   * The frame is **moved into** its slot rather than created by it: the
   * controller owns construction and teardown, and a component that built its
   * own frame would be a second place deciding how a frame is made — the thing
   * the injected `start` exists to prevent.
   */
  const slots = useRef(new Map<number, HTMLDivElement | null>())
  const [ready, setReady] = useState<
    | {
        assets: SandboxAssets
        documentGranted: boolean
        context: ScriptContext
        systemPlugins: SandboxPluginRuntime
      }
    | undefined
  >(undefined)

  useEffect(() => {
    /*
     * `declined` and `unknown` leave before the round trip. `declined` is an
     * answer; `unknown` is still in flight, and building against it would race
     * the answer it is waiting for. `unasked` goes on deliberately: the scripts
     * list decides whether it is final, and only the round trip knows that.
     */
    if (
      characterId === undefined
      || pluginRuntime === undefined
      || consent === 'declined'
      || consent === 'unknown'
    ) {
      setReady(undefined)
      return undefined
    }

    let live = true
    void (async () => {
      try {
        if (chatId === undefined) return
        const [assets, grants, snapshot] = await Promise.all([
          sandboxSupply(),
          /*
           * Asked of the host, not read from `state.documentGranted`. The
           * store's copy is keyed on a character id, and a deleted card frees
           * its id for the next card of that name — so a cached grant can belong
           * to a card that no longer exists.
           */
          actionsOf(store).resolveScripts(characterId),
          actionsOf(store).scriptContext(chatId, characterId),
        ])
        /*
         * The consent gate, now that the round trip knows how big the question
         * is. An unasked card carrying scripts waits for `ConsentAsk`'s answer
         * — the state change re-runs this effect — but an unasked card with
         * **no** scripts is never asked, so waiting here would be a wait that
         * nothing can ever end; `interfacesMayBuild` is where that case is
         * named and decided.
         */
        if (!interfacesMayBuild(consent, grants.scripts.length)) return
        /*
         * No snapshot, no frames. A card interface reads its variables in the
         * first line it runs, and seeding it with an invented empty context
         * would have it draw a panel of zeroes that looks like real state.
         */
        if (snapshot === undefined) return
        if (live) {
          setReady({
            assets,
            documentGranted: grants.documentGranted,
            context: snapshot,
            systemPlugins: pluginRuntime,
          })
        }
      } catch {
        /*
         * Swallowed here on purpose: `useCardScripts` resolves the same manifest
         * and reports a failure to the panel already. Reporting it a second time
         * per displayed message would put the same sentence on screen once per
         * row.
         */
        if (live) setReady(undefined)
      }
    })()

    return () => {
      live = false
    }
  }, [
    characterId,
    consent,
    chatId,
    store,
    pluginRevision,
    tavernHelperEnabled,
    mvuEnabled,
  ])

  /*
   * How much of the budget this floor got.
   *
   * This replaced a depth-counting stopgap that stood in for a windowed reading
   * view. Both existed to answer "why has this floor no interface?" and two
   * answers to that is worse than either — the count is now layer ②'s job
   * (which floors are mounted at all) and the weight is this.
   */
  const { refusedInstances, gate, open } = useFloorGate(floor)

  /*
   * The settled body gets one repair before anything downstream reads it.
   *
   * A model reply can carry a code fence that never closes — the 政经博弈 card
   * pads its `<think_fox~>` thinking with a lone ` ``` ` — and CommonMark runs
   * an unclosed fence to the end of the document, so the renderer received the
   * remaining 310 lines as one code block and the reader scrolled headings and
   * bold as source. `repairStrayFences` turns such an opener into the literal
   * text upstream's showdown would have left, and the markdown below renders as
   * markdown. Behind the same streaming gate as the claim, for the same reason:
   * while a reply is still arriving, the unclosed fence is a code block in
   * flight and code-to-end-of-stream is its honest render.
   *
   * Everything below — the controller's claim, the row's splice and the
   * fallback — reads the one string this derives (the body when a body tag is
   * present, `display` itself when not), so no two of them derive surfaces
   * from different texts.
   */
  const display = streaming ? text : repairStrayFences(text)

  /*
   * The body tag: a preset may teach the model to wrap its prose in a wrapper
   * (`<content>` and siblings — see `notes/apps/iris-web/BODY-TAG.md`), and
   * everything the model writes outside it is scaffolding, not prose.
   *
   * The split runs here, on `display`, one seam later than the repair: the
   * scaffolding can carry an unclosed fence of its own, and repairing before
   * splitting keeps the fence ruling inside the text the fence is in. When the
   * wrapper is absent the split is the identity — `bodyText` is `display`,
   * every downstream read is unchanged, and a card that never heard of the
   * convention renders byte-for-byte as it always has. When it is present,
   * `bodyText` becomes the one string the claim, the controller, the splice
   * and the fallback read, and the scaffolding folds into the expandable
   * regions the return renders at the edges.
   */
  const bodyTag = useSyncExternalStore(subscribeBodyTag, getBodyTag, getBodyTag)
  const leak = splitBodyTag(display, bodyTag)
  const bodyText = leak.body ?? display
  const currentMvuEnabled =
    ready !== undefined
    && ready.systemPlugins.revision === pluginRevision
    && ready.systemPlugins.mvu

  const { states, swapping } = useMessageInterfaces({
    floor,
    text: bodyText,
    refusedInstances,
    gate,
    allowed:
      ready !== undefined
      && ready.systemPlugins.revision === pluginRevision
      && chatId !== undefined,
    start: input => {
      const current = ready
      if (current === undefined || chatId === undefined) {
        throw new Error('a message frame was started before its build assets resolved')
      }
      let painted = false
      /*
       * This interface's popup channel. Released with the frame below, because
       * a message frame is unmounted whenever the reading window scrolls past
       * it — far more often than a script host is — and a dialog outliving its
       * frame is a question with nobody left to hear the answer.
       */
      const popups = cardPopupBridge('interface')
      const card = runCard(
        {
          systemPlugins: current.systemPlugins,
          bootstrapUrl: `${window.location.origin}${current.assets.bootstrap}`,
          scripts: [],
          mode: 'module',
          libraries: [`${window.location.origin}${current.assets.messagePreset}`],
          members: `${window.location.origin}${current.assets.members}`,
          markup: input.markup,
          documentGranted: current.documentGranted,
          /*
           * Still false. Widening `connect-src` to the host origin is a separate,
           * ruled piece of work; until it lands a card's outbound fetches are
           * refused by CSP and reported by name, which is the intended behaviour
           * rather than a gap.
           */
          networkGranted: false,
          bundleOrigin: window.location.origin,
          context: current.context,
          // The floor this interface renders in — what `getCurrentMessageId()`
          // answers for a status console writing its MVU layer.
          currentMessageId: floor,
          viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
          fetch: async () => {
            throw new Error('a message frame fetches nothing on the shell’s behalf')
          },
          onSettings: () => undefined,
          onSlash: async (command, revision) => actionsOf(store).runSlash(command, revision),
          onCall: async (method, params) => actionsOf(store).runCardAction(method, params),
          /*
           * The dialog bridge, with the same wording and split the script
           * frame uses: the sandbox answers `alert` with silence, and a
           * console button that reports its own failure through `alert` was
           * invisible to the reader. An alert is a fault on both channels; a
           * confirm or a prompt is a note that names what was asked and that
           * it was answered "cancel"/"nothing".
           */
          onDialog: (kind, text) => {
            actionsOf(store).addCardReport(
              kind === 'alert'
                ? text
                : `a card asked ${kind}("${text}") — answered ${kind === 'confirm' ? '"cancel"' : 'nothing'}`,
              { channel: 'dialog', grade: kind === 'alert' ? 'fault' : 'note' },
            )
            actionsOf(store).notify(kind === 'alert' ? 'error' : 'info', text)
          },
          /*
           * SillyTavern's own popup, drawn by the shell. Asynchronous upstream
           * too, so unlike the three above the reader's real answer reaches the
           * card. An interface frame is clipped to this message's height, which
           * is the sharpest form of why the dialog cannot be drawn inside it.
           */
          onPopup: popups.onPopup,
          onPopupWithdrawn: popups.onPopupWithdrawn,
          /*
           * A fault: an interface frame reporting an error is the one channel
           * here that always describes something broken. The channel is a
           * **label**, not a prefix — see `CardReport.channel`.
           *
           * **Both channels, the same split the script frame uses.** The graded
           * report is the durable record; the notice is the immediate signal,
           * and it is how the fault reaches the drawer's notice log. This used
           * to stop at the report list — which left the whole class of
           * interface-frame failures (and on the interface-rendering cards,
           * that is where a card's generation-time code lives) absent from the
           * notice panel entirely: the one panel that answers "what did this
           * session say" stayed empty while the error was on record in a list
           * the reader has to know to look for. The store's dedup window
           * collapses a burst into a count.
           */
          onError: message => {
            actionsOf(store).addCardReport(message, {
              grade: 'fault',
              channel: 'interface',
            })
            actionsOf(store).notify('error', message)
          },
          onBlocked: (host, directive, detail, covered) => {
            const refusal = describeRefusal(host, directive, detail, covered)
            actionsOf(store).addCardReport(refusal.text, { grade: refusal.grade })
            if (refusal.notify) actionsOf(store).notify('info', refusal.text)
          },
          onNote: note => actionsOf(store).addCardReport(note),
          /*
           * A dispatch on the page window this interface sees, fanned out to the
           * card's other frames — a status bar that broadcasts on the page and a
           * projector that listens on it live in different frames, and only the
           * shell can stand between them.
           */
          onWindowEvent: (event, detail) => {
            broadcastWindowEvent(event, detail)
          },
          onReady: input.onReady,
          /*
           * The first real height is the frame saying "something is laid out on
           * screen" — the one honest reveal signal. `ready` cannot be it: an
           * interface frame announces ready when its bootstrap finishes, and
           * its markup parses after that, so revealing there trades one blank
           * for another. Once, because a card that relayouts keeps posting.
           */
          onHeight: () => {
            if (painted) return
            painted = true
            input.onPainted()
          },
          /*
           * The frame's own words for why it never came up, named the moment
           * they arrive. The bootstrap cannot report `ready` after a throw —
           * its channel exists to speak that error — so this is the only path
           * that turns "the handshake broke" from eight seconds of timed-out
           * silence into a reason a reader can act on. The row carries it as
           * the `never-started` detail; the report list keeps a copy, where
           * failures survive the message scrolling away.
           */
          onBootstrapError: message => {
            input.onBootstrapError(message)
            actionsOf(store).addCardReport(message, { grade: 'fault', channel: 'interface' })
          },
        },
        document,
      )
      /*
       * `refreshContext` is forwarded rather than dropped. An interface is a
       * status panel: it draws the variables, so a write from a later floor
       * leaves it showing a turn-old number while looking perfectly healthy.
       *
       * `emit` rides along: the panel's own redraw trigger is
       * `eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, …)`, a subscription on the
       * frame's own bus, and without a speaker on this side it would never fire
       * — the panel would keep its first frame's numbers for as long as it
       * lived. See the `watchContext` note below for when the shell speaks.
       */
      return {
        element: card.element,
        refreshContext: next => {
          card.refreshContext(next as ScriptContext)
        },
        emit: (event, args) => {
          card.emit(event, [...args])
        },
        dispose: () => {
          // The queue first: a dialog on screen for a disposed frame is one the
          // reader can still press.
          popups.release()
          card.dispose()
        },
      }
    },
    watchContext: (push, emit) =>
      tapHostEvents(store, event => {
        /*
         * Two events, not one. A reply that just finished generating settles
         * through `stream.end`; `chat.updated` covers edits, swipes and a
         * script’s own writes. Between them they are every event that assigns
         * `view` — which is the property that matters, rather than the names.
         *
         * Streaming deltas are deliberately absent: they move `stream`, not
         * `view`, and refreshing per token would put a host round trip between
         * every pair of characters.
         */
        if (event.type !== 'chat.updated' && event.type !== 'stream.end') return
        if (chatId === undefined || characterId === undefined) return
        if (event.chatId !== chatId) return
        /*
         * Every displayed row has its own subscription and the host hands the
         * same event to all of them, so this call is made N times per event —
         * and they all land in one flight, because `scriptContext` shares a
         * request in the air (`client/in-flight.ts`). That used to be a
         * separate, event-keyed helper here; the flight is a strictly wider
         * mechanism and covers the mount burst too, so there is one answer to
         * "how many round trips did that event cost" rather than two.
         */
        void actionsOf(store).scriptContext(chatId, characterId).then(next => {
          /*
           * No snapshot, no push — the rule the first one follows. A card handed
           * an invented empty context redraws its panel as zeroes, and zeroes
           * read as state rather than as an absence.
           */
          if (next !== undefined) push(next)
        })
        /*
         * And the redraw trigger, so the pushed snapshot is actually *read*.
         * The measured status bars draw once after `waitGlobalInitialized` and
         * then only inside an `eventOn(Mvu.events.VARIABLE_UPDATE_ENDED)`
         * listener; upstream that event is the MVU bundle's, heard through the
         * page's shared event source. Iris's bundle lives in the script frame,
         * so the shell says the name into the message frames on exactly the
         * events that carry a new view — the same rule the refresh above
         * follows, for the same reason. Script frames are deliberately not
         * spoken to: their bundle emits the event itself, and a shell copy
         * would deliver every update twice.
         */
        if (currentMvuEnabled) emit(MVU_UPDATE_ENDED_EVENT, [])
      }),

    attach: frame => {
      const slot = slots.current.get(frame.instance)
      /*
       * No slot means the row that should hold this frame is not on screen, so
       * the frame is left unattached — and `isConnected` then reports it, which is
       * the discriminator that exists for exactly this. Appending it somewhere
       * else to avoid the report would hide a real mismatch between what was
       * claimed and what was rendered.
       */
      if (slot === null || slot === undefined) return
      slot.append(frame.element as unknown as Node)
    },
  })

  /*
   * The message's own body, with each claimed block **replaced** by its
   * interface rather than followed by it.
   *
   * Upstream replaces — it hides the `<pre>` and puts the iframe where it was. The
   * first cut of this appended frames after the whole message, and on the sample
   * card that meant scrolling past 360 KiB of source to reach the interface that
   * replaced part of it. There is no `<pre>` to hide here, because `MarkdownText` only
   * makes one if we hand it the text — so the fix is to hand it the text without
   * the claimed spans.
   */
  /*
   * While a reply is still arriving, the body is just text.
   *
   * Upstream renders mid-stream with its predicate relaxed and — as measured —
   * no throttling on that path. This pipeline does not copy that: a 360 KiB
   * interface rebuilt per token is not a feature, and a half-arrived block shown
   * as source is honest about what has come so far.
   */
  const { blocks, refused, styles } = streaming
    ? { blocks: [], refused: [] as readonly string[], styles: [] as readonly MessageStyle[] }
    : claimMessageSurfaces(bodyText)

  /*
   * An unclosed region is reported, not swallowed.
   *
   * The split's fallback treats everything after a never-closed tag as HTML,
   * which is the rendering the card intended — but the card author whose
   * narrative vanished below the panel needs the cause on record, and a note
   * that exists only in a source file nobody reads is silence with extra steps.
   * This is the same durable channel the frames report through, and the store
   * keeps one entry per distinct fact, so a card with the flaw on many floors
   * is one line, not one per floor.
   *
   * Fired from an effect rather than during render — a report is a side effect
   * — and keyed on the joined text, so a re-render that did not re-derive the
   * claim does not re-report it. Deliberately independent of consent and of the
   * build assets: the note describes the message text, which is on screen either
   * way, so a declined card still gets its markup fault named.
   */
  const refusedNote = refused.join('\n')
  useEffect(() => {
    if (refusedNote === '') return
    for (const note of refusedNote.split('\n')) {
      actionsOf(store).addCardReport(note, { channel: 'interface' })
    }
  }, [refusedNote, store])

  /*
   * No claimed surface, no splice — the body is one piece of prose. Assistant
   * rows read it as markdown; every other row keeps the raw text it has always
   * shown, which is the one rendering this pipeline promises not to touch.
   *
   * Every string that reaches `MarkdownText` goes through the unknown-markup
   * rule first, and both call sites do it, because a message with no claimed
   * block is the commoner half of the population — the card that started this
   * has one claimed block and two stranded wrappers, but a card that writes
   * `<StatusPlaceHolderImpl/>` and nothing else has no block at all.
   *
   * Applied here rather than inside the claim pipeline: claims are offsets into
   * the message as stored (see `unwrapUnknownTagsOutsideCode`).
   */
  /*
   * `styles` as well as `blocks`, because a message can have nothing to frame
   * and still have characters that must not be rendered. A `<style>` element
   * reaching `MarkdownText` arrives as **text** — the renderer disables raw HTML
   * — so this fast path would print the stylesheet where the panel's CSS used to
   * be, which is a louder version of the fault this change is about. The
   * segmented path below removes those spans; this one is only for a message
   * with neither.
   *
   * The role gate is on the fast path's **rendering**, not on its condition: a
   * user row carrying only a `<style>` leaves this path exactly as an assistant
   * row does, because the reason to leave is that those characters have no
   * reader — which is true of the raw arm too, where the stylesheet would
   * simply be printed instead of escaped.
   */
  if (blocks.length === 0 && styles.length === 0) {
    return markdownProse ? <MarkdownText text={unwrapUnknownTagsOutsideCode(bodyText)} streaming={streaming} /> : <>{bodyText}</>
  }

  /*
   * The prose the renderer actually gets, and the reason the empties are
   * dropped: on the card that started this, one whole segment is the single
   * line `<Gui>` — once the wrapper is gone there is nothing left, and handing
   * `MarkdownText` an empty string would put a blank paragraph exactly where
   * the wrapper used to be. Same rule `splitAroundInterfaces` already applies
   * to whitespace between two interfaces, one transform later.
   */
  /*
   * The style spans go in as **dropped**: no frame, no prose, nothing in their
   * place. Their CSS has already gone into the region frames (through the same
   * claim, in `useMessageInterfaces`), and the characters themselves have no
   * reader left.
   *
   * The split reads `bodyText`, the one string the claim and the controller
   * already agreed on — a style span's offsets come from a claim over the
   * repaired, body-tag-split text, so splicing them out of anything else
   * would cut at the wrong characters on any message whose fence was repaired
   * or whose scaffolding was folded.
   */
  const segments = splitAroundInterfaces(bodyText, blocks, styles)
    .map(segment =>
      segment.kind === 'text'
        ? { ...segment, text: unwrapUnknownTagsOutsideCode(segment.text) }
        : segment,
    )
    .filter(segment => segment.kind !== 'text' || segment.text.trim() !== '')
  const byInstance = new Map(states.map(state => [state.instance, state]))

  return (
    /*
     * A fragment, not a wrapper element. The segments belong directly to the
     * message body's own layout, and an extra block box would be one more thing
     * between the prose and the interface that replaced part of it — plus a
     * class name with no rule behind it, which `interface-styles.test.ts` now
     * refuses on the grounds that a selector matching nothing is silent.
     *
     * The folded scaffolding sits at the fragment's edges, outside the prose:
     * it was written before and after the body, so it renders before and after
     * the body, folded. An empty region is not rendered — a whitespace-only
     * head or tail is layout noise, not scaffolding a reader could learn from.
     */
    <>
      {leak.tagged && leak.head.trim() !== '' && <BodyLeak text={leak.head} edge="head" />}
      {segments.map(segment =>
        segment.kind === 'text' ? (
          markdownProse ? (
            <MarkdownText key={`t-${segment.text.length}-${segment.text.slice(0, 16)}`} text={segment.text} />
          ) : (
            // A raw string is a valid list child — React asks keys of elements,
            // not of primitives — so the plain row needs no wrapper here.
            segment.text
          )
        ) : (
          <InterfaceSlot
            key={`i-${segment.instance}`}
            instance={segment.instance}
            state={byInstance.get(segment.instance)}
            pendingSwap={swapping}
            adopt={node => slots.current.set(segment.instance, node)}
            onOpen={() => {
              open(segment.instance)
            }}
          />
        ),
      )}
      {leak.tagged && leak.tail.trim() !== '' && <BodyLeak text={leak.tail} edge="tail" />}
    </>
  )
}

/**
 * Where one interface's frame goes, and what is said when it is not there.
 *
 * The frame is moved into this slot rather than created by it: the controller
 * owns construction and teardown, and a component that built its own frame would
 * be a second place deciding how a frame is made.
 * @param props - the instance, its state, how to register the slot, and
 *   whether a parked predecessor is on screen while this frame boots.
 * @returns the slot element.
 */
function InterfaceSlot({
  instance,
  state,
  pendingSwap,
  adopt,
  onOpen,
}: {
  instance: number
  state: InterfaceState | undefined
  pendingSwap: boolean
  adopt: (node: HTMLDivElement | null) => void
  onOpen: () => void
}): ReactElement {
  // Subscribed so a language switch re-renders the slot's words.
  useLanguage()
  return (
    <div className="iris-interfaces__slot" data-instance={instance}>
      <div ref={adopt} />
      {state?.phase === 'over-budget' ? (
        /*
         * The placeholder, and the button is the part that matters. Without it
         * the budget would be a ceiling; with it the budget is a default and the
         * reader can always reach the one interface they actually want, paying
         * for that one only.
         *
         * Deliberately not a fallback to the raw code block. That is what
         * upstream does with rendering off, and it pours a screen of HTML into
         * the prose — noise that also reads as the card having broken.
         */
        <p className="iris-interfaces__over">
          <span className="iris-interfaces__state">{describeInterface(state, getLanguage())}</span>
          <button type="button" className="iris-interfaces__open" onClick={onOpen}>
            {t('renderThisOne')}
          </button>
        </p>
      ) : state === undefined || state.phase === 'live' ? null : pendingSwap && state.phase === 'claimed' ? null : (
        /*
         * Only when it is not live. A working interface is its own evidence — it
         * is on screen — and a caption under every one would be noise. A frame
         * that never started has nothing to show, so this line is all a reader
         * gets.
         */
        <p className="iris-interfaces__state">{describeInterface(state, getLanguage())}</p>
      )}
    </div>
  )
}

/**
 * One folded region of body-tag scaffolding.
 *
 * The model's director notes and planning are not prose, but they are also not
 * garbage — a reader debugging a scene, or a card author tuning a preset, may
 * want exactly these words. So they render **folded**: a `details` element the
 * reader expands on purpose, with the text verbatim — raw, not markdown,
 * because scaffolding is markup-adjacent and the honest rendering of markup is
 * its characters. The stored message is untouched either way; this is the
 * display layer deciding what a reading surface puts between the reader and
 * the story (see `notes/apps/iris-web/BODY-TAG.md`).
 * @param props - the scaffolding text, and which side of the body it came from.
 * @returns the folded region.
 */
function BodyLeak({ text, edge }: { text: string, edge: 'head' | 'tail' }): ReactElement {
  useLanguage()
  return (
    <details className={`iris-bodyleak iris-bodyleak--${edge}`}>
      <summary className="iris-bodyleak__summary">{t('bodyLeakSummary')}</summary>
      <div className="iris-bodyleak__text">{text}</div>
    </details>
  )
}
