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
import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { ScriptContext } from '@iris/protocol'

import { actionsOf, tapHostEvents } from '../client/store.ts'
import { snapshotFor } from './shared-snapshot.ts'
import { describeRefusal } from './blocked-line.ts'
import { useIris, useIrisStore } from '../client/provider.tsx'
import {
  SANDBOX_MANIFEST_PATH,
  parseSandboxManifest,
  type SandboxAssets,
} from '../sandbox/asset-manifest.ts'
import { checkBootstrap } from '../sandbox/bootstrap-source.ts'
import { MVU_UPDATE_ENDED_EVENT } from '../sandbox/tavern-helper.ts'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

import { claimFrontendBlocks, splitAroundInterfaces } from '../sandbox/frontend-blocks.ts'
import { describeInterface, type InterfaceState } from '../sandbox/message-frames.ts'
import { useFloorGate } from './FrameBudget.tsx'
import { runCard } from '../sandbox/runner.ts'
import { useMessageInterfaces } from './useMessageInterfaces.tsx'

/**
 * This build's bootstrap and asset URLs, fetched at most once per page.
 *
 * Memoised at module scope deliberately. Every displayed message would otherwise
 * ask for the same two immutable files, and on a long conversation that is a
 * request per row for something that cannot have changed — the manifest names
 * content-hashed artifacts, so "the same build" is the only thing it can mean.
 *
 * The promise is cached rather than the value, so concurrent rows share one
 * in-flight fetch instead of racing.
 */
let supply: Promise<{ assets: SandboxAssets, bootstrap: string }> | undefined

/**
 * Resolve the bootstrap and the asset names for this build.
 * @returns the shared supply.
 */
function sandboxSupply(): Promise<{ assets: SandboxAssets, bootstrap: string }> {
  supply ??= (async () => {
    const manifest = await fetch(SANDBOX_MANIFEST_PATH)
    if (!manifest.ok) throw new Error(`sandbox manifest: HTTP ${String(manifest.status)}`)
    const assets = parseSandboxManifest(await manifest.text())
    if (typeof assets === 'string') throw new Error(`sandbox manifest: ${assets}`)

    const response = await fetch(assets.bootstrap)
    if (!response.ok) throw new Error(`bootstrap: HTTP ${String(response.status)}`)
    const bootstrap = await response.text()
    /*
     * Checked before it is ever injected, for the reason `bootstrap-source.ts`
     * records: a dev server once returned it transformed into an ES module, and
     * that is a **parse-time** error inside a classic `srcdoc` script — so the
     * frame's own reporter cannot exist yet to report it, and the frame simply
     * says nothing.
     */
    const unusable = checkBootstrap(bootstrap)
    if (unusable !== undefined) throw new Error(`bootstrap: ${unusable}`)

    return { assets, bootstrap }
  })()
  return supply
}

/**
 * An assistant message's body, with any card interface in place of its block.
 *
 * Renders the **whole** body rather than an addition to it, because replacing a
 * block is not something that can be done from beside it: `MarkdownText` only
 * makes a `<pre>` if it is handed the text, so the only way to not show the source
 * is to not hand it over.
 * @param props - the floor, its text after display regex, and whether it is still arriving.
 * @returns the message body.
 */
export function MessageInterfaces({
  floor,
  text,
  streaming,
}: {
  floor: number
  text: string
  streaming: boolean
}): ReactElement {
  const chatId = useIris(state => state.chatId)
  const characterId = useIris(state => state.view?.characterId)
  const consent = useIris(state => state.scriptsAllowed)
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
        bootstrap: string
        documentGranted: boolean
        context: ScriptContext
      }
    | undefined
  >(undefined)

  useEffect(() => {
    if (characterId === undefined || consent !== 'allowed') {
      setReady(undefined)
      return undefined
    }

    let live = true
    void (async () => {
      try {
        if (chatId === undefined) return
        const [{ assets, bootstrap }, grants, snapshot] = await Promise.all([
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
         * No snapshot, no frames. A card interface reads its variables in the
         * first line it runs, and seeding it with an invented empty context
         * would have it draw a panel of zeroes that looks like real state.
         */
        if (snapshot === undefined) return
        if (live) {
          setReady({ assets, bootstrap, documentGranted: grants.documentGranted, context: snapshot })
        }
      } catch {
        /*
         * Swallowed here on purpose: `useCardScripts` fetches the same two files
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
  }, [characterId, consent, chatId, store])

  /*
   * How much of the budget this floor got.
   *
   * This replaced a depth-counting stopgap that stood in for a windowed reading
   * view. Both existed to answer "why has this floor no interface?" and two
   * answers to that is worse than either — the count is now layer ②'s job
   * (which floors are mounted at all) and the weight is this.
   */
  const { refusedInstances, gate, open } = useFloorGate(floor)

  const states = useMessageInterfaces({
    floor,
    text,
    refusedInstances,
    gate,
    allowed: ready !== undefined && chatId !== undefined,
    start: input => {
      const current = ready
      if (current === undefined || chatId === undefined) {
        throw new Error('a message frame was started before its build assets resolved')
      }
      const card = runCard(
        {
          bootstrap: current.bootstrap,
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
          viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
          fetch: async () => {
            throw new Error('a message frame fetches nothing on the shell’s behalf')
          },
          onSettings: () => undefined,
          onSlash: async command => actionsOf(store).runSlash(command),
          onCall: async (method, params) => actionsOf(store).runCardAction(method, params),
          /*
           * A fault: an interface frame reporting an error is the one channel
           * here that always describes something broken. The channel is a
           * **label**, not a prefix — see `CardReport.channel`.
           */
          onError: message => actionsOf(store).addCardReport(message, {
            grade: 'fault',
            channel: 'interface',
          }),
          onBlocked: (host, directive, detail, covered) => {
            const refusal = describeRefusal(host, directive, detail, covered)
            actionsOf(store).addCardReport(refusal.text, { grade: refusal.grade })
            if (refusal.notify) actionsOf(store).notify('info', refusal.text)
          },
          onNote: note => actionsOf(store).addCardReport(note),
          onReady: input.onReady,
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
        dispose: card.dispose,
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
        void snapshotFor(event, async () =>
          actionsOf(store).scriptContext(chatId, characterId),
        ).then(next => {
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
        emit(MVU_UPDATE_ENDED_EVENT, [])
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
   * source describes. There is no `<pre>` to hide here, because `MarkdownText` only
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
  const blocks = streaming ? [] : claimFrontendBlocks(text)
  if (blocks.length === 0) return <MarkdownText text={text} streaming={streaming} />

  const segments = splitAroundInterfaces(text, blocks)
  const byInstance = new Map(states.map(state => [state.instance, state]))

  return (
    /*
     * A fragment, not a wrapper element. The segments belong directly to the
     * message body's own layout, and an extra block box would be one more thing
     * between the prose and the interface that replaced part of it — plus a
     * class name with no rule behind it, which `interface-styles.test.ts` now
     * refuses on the grounds that a selector matching nothing is silent.
     */
    <>
      {segments.map(segment =>
        segment.kind === 'text' ? (
          <MarkdownText key={`t-${segment.text.length}-${segment.text.slice(0, 16)}`} text={segment.text} />
        ) : (
          <InterfaceSlot
            key={`i-${segment.instance}`}
            instance={segment.instance}
            state={byInstance.get(segment.instance)}
            adopt={node => slots.current.set(segment.instance, node)}
            onOpen={() => {
              open(segment.instance)
            }}
          />
        ),
      )}
    </>
  )
}

/**
 * Where one interface's frame goes, and what is said when it is not there.
 *
 * The frame is moved into this slot rather than created by it: the controller
 * owns construction and teardown, and a component that built its own frame would
 * be a second place deciding how a frame is made.
 * @param props - the instance, its state, and how to register the slot.
 * @returns the slot element.
 */
function InterfaceSlot({
  instance,
  state,
  adopt,
  onOpen,
}: {
  instance: number
  state: InterfaceState | undefined
  adopt: (node: HTMLDivElement | null) => void
  onOpen: () => void
}): ReactElement {
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
          <span className="iris-interfaces__state">{describeInterface(state)}</span>
          <button type="button" className="iris-interfaces__open" onClick={onOpen}>
            Render this one
          </button>
        </p>
      ) : state === undefined || state.phase === 'live' ? null : (
        /*
         * Only when it is not live. A working interface is its own evidence — it
         * is on screen — and a caption under every one would be noise. A frame
         * that never started has nothing to show, so this line is all a reader
         * gets.
         */
        <p className="iris-interfaces__state">{describeInterface(state)}</p>
      )}
    </div>
  )
}
