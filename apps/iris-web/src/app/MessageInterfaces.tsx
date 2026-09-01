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

import { actionsOf } from '../client/store.ts'
import { useIris, useIrisStore } from '../client/provider.tsx'
import {
  SANDBOX_MANIFEST_PATH,
  parseSandboxManifest,
  type SandboxAssets,
} from '../sandbox/asset-manifest.ts'
import { checkBootstrap } from '../sandbox/bootstrap-source.ts'
import { describeInterface } from '../sandbox/message-frames.ts'
import { floorsToRender } from '../sandbox/render-window.ts'
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

/** One message's interfaces. */
export function MessageInterfaces({
  floor,
  text,
}: {
  floor: number
  text: string
}): ReactElement | null {
  const chatId = useIris(state => state.chatId)
  const characterId = useIris(state => state.view?.characterId)
  const consent = useIris(state => state.scriptsAllowed)
  const messageCount = useIris(state => state.view?.messages.length ?? 0)
  const store = useIrisStore()

  const mount = useRef<HTMLDivElement>(null)
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
   * The interim window, until the reading view is windowed. Every message is
   * mounted today, so without this a long conversation would build a frame for
   * every floor that has one.
   */
  const allowed = floorsToRender(
    Array.from({ length: messageCount }, (_unused, id) => ({ id })),
    { depth: 0 },
  ).has(floor)

  const states = useMessageInterfaces({
    floor,
    text,
    allowed: allowed && ready !== undefined && chatId !== undefined,
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
          onError: message => actionsOf(store).addCardReport(`interface: ${message}`),
          onBlocked: (host, directive) => {
            const line = `blocked ${host} (${directive})`
            actionsOf(store).addCardReport(line)
            actionsOf(store).notify('info', line)
          },
          onNote: note => actionsOf(store).addCardReport(note),
          onReady: input.onReady,
        },
        document,
      )
      return { element: card.element, dispose: card.dispose }
    },
    attach: frame => {
      const host = mount.current
      if (host === null) return
      host.append(frame.element as unknown as Node)
    },
  })

  if (states.length === 0 && mount.current === null) return null

  return (
    <div className="iris-interfaces">
      <div ref={mount} className="iris-interfaces__frames" />
      {states
        .filter(state => state.phase !== 'live')
        .map(state => (
          /*
           * Only the rows that are *not* live. A working interface is its own
           * evidence — it is on screen — and a permanent caption under every one
           * would be noise. A frame that never started has nothing to show, so
           * the line is the only thing a reader gets.
           */
          <p className="iris-interfaces__state" key={state.instance}>
            {describeInterface(state)}
          </p>
        ))}
    </div>
  )

}
