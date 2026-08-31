/**
 * A dev-only harness for running something in a real card frame.
 *
 * It exists because 41 tests cover the sandbox's decisions and none of them has
 * ever run inside an actual `<iframe>`. Three things cannot be checked any other
 * way: whether an opaque-origin frame with `unsafe-eval` really runs the shapes
 * webpack emits, whether the height report sizes the frame, and whether a card's
 * viewport read returns the host's numbers instead of zero.
 *
 * Not a feature. Gated on `import.meta.env.DEV` so the branch is dead in a
 * production build and the module drops out of the bundle.
 *
 * @module iris-web/dev/SandboxProbe
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScriptContext } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { describeBytes } from '../app/format.ts'
import { runCard, type RunningCard } from '../sandbox/runner.ts'
import { Section } from '../app/fields.tsx'
import { PROBE_SCRIPT } from './probe-script.ts'

/** What the shell saw, as opposed to what the frame drew. */
interface Observed {
  height?: number
  settings?: string
  errors: string[]
  /** Hosts the frame's own policy refused, in arrival order. */
  blocked: { host: string, directive: string }[]
}

/**
 * A context to run against when the host will not supply one.
 *
 * The fake client refuses `script.context` on purpose — it will not invent a
 * context, because a card reading a fabricated one fails in ways that say
 * nothing about the real thing. For a probe that is measuring the *frame*, a
 * clearly-labelled stand-in is the right answer; it is never used for a card.
 */
function standInContext(): ScriptContext {
  return {
    chat: [],
    chatMetadata: {},
    name1: 'You',
    name2: 'probe stand-in',
    characters: [],
    extensionSettings: {},
    variables: {},
  } as ScriptContext
}

/**
 * Render the probe harness.
 * @returns the section, or null outside a dev build.
 */
export function SandboxProbe(): ReactElement | null {
  const characterId = useIris(state => state.view?.characterId)
  const chatId = useIris(state => state.chatId)
  const granted = useIris(state => state.documentGranted)
  const actions = useIrisActions()

  const mount = useRef<HTMLDivElement>(null)
  const running = useRef<RunningCard | undefined>(undefined)
  const scripts = useIris(state => state.scripts)
  const [observed, setObserved] = useState<Observed>({ errors: [], blocked: [] })
  // Dev-only, until `networkGranted` exists in the contract. It is here so the
  // granted policy can be exercised in a browser now rather than after the field
  // lands — the policy is the thing worth checking, not the plumbing that carries
  // the flag.
  const [networkGranted, setNetworkGranted] = useState(false)
  const [status, setStatus] = useState('idle')

  // Only what would actually run: the card's switch and the user's, combined.
  const runnable = scripts.filter(script => script.enabled)

  /**
   * Tear the frame down, recording why.
   *
   * The reason is displayed because of something seen in the browser and not yet
   * explained: a run reported `stopped` and an emptied frame after the observer
   * scrolled away and back. `stop` is the only thing that sets that status and
   * the only caller besides the button is the unmount cleanup, so either this
   * panel is unmounting when it should not or something else is calling this.
   * Rather than guess from here, the status now says which — the next run reads
   * `stopped (unmounted)` or `stopped (asked)` and settles it.
   */
  const stop = useCallback((reason: string) => {
    // Nothing running is not an event. React's StrictMode mounts, tears down and
    // remounts every effect in development, so the unmount cleanup fires once
    // before anything has been started — which is what put a permanent
    // `stopped (unmounted)` in the status line and made the instrument report a
    // teardown that never happened. Now the line only appears when a frame was
    // genuinely disposed, which is the signal it was added for.
    if (running.current === undefined) return
    running.current.dispose()
    running.current = undefined
    setStatus(`stopped (${reason})`)
  }, [])

  // A frame that outlives its panel is exactly the leak the whole reversible
  // design exists to prevent, so the harness holds itself to the same rule.
  useEffect(() => () => stop('unmounted'), [stop])

  const start = useCallback(async (code: string, label: string) => {
    stop('restarting')
    setObserved({ errors: [], blocked: [] })
    setStatus('loading bootstrap…')

    let bootstrap: string
    try {
      // In dev Vite serves the project root, so the built bootstrap is reachable
      // at its own path. Production inlines it host-side instead.
      const response = await fetch('/dist-sandbox/bootstrap.js')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      bootstrap = await response.text()
    } catch (error: unknown) {
      setStatus(
        `no bootstrap: ${error instanceof Error ? error.message : String(error)} — run "npm run build:sandbox"`,
      )
      return
    }

    // The real snapshot when the host will give one, a labelled stand-in when it
    // will not. Against the fake client it will not — it refuses rather than
    // inventing a context — and for a probe measuring the frame that is fine, as
    // long as the panel says which one is in use.
    let context = standInContext()
    let source = 'stand-in context'
    if (chatId !== undefined && characterId !== undefined) {
      const real = await actions.scriptContext(chatId, characterId)
      if (real !== undefined) {
        context = real
        source = 'host context'
      }
    }

    const card = runCard(
      {
        bootstrap,
        code,
        documentGranted: granted,
        networkGranted,
        context,
        viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
        fetch: async url => {
          throw new Error(`the probe does not fetch (${url})`)
        },
        onSettings: settings => {
          setObserved(before => ({ ...before, settings: JSON.stringify(settings) }))
        },
        onHeight: pixels => {
          setObserved(before => ({ ...before, height: pixels }))
        },
        onBlocked: (host, directive) => {
          setObserved(before =>
            // Deduplicated: a card that pulls twenty images from a refused host
            // produces twenty violations, and twenty identical lines say nothing
            // the first one did not.
            before.blocked.some(row => row.host === host && row.directive === directive)
              ? before
              : { ...before, blocked: [...before.blocked, { host, directive }] },
          )
        },
        onError: (message, member) => {
          setObserved(before => ({
            ...before,
            errors: [...before.errors, member === undefined ? message : `${member}: ${message}`],
          }))
        },
      },
      document,
    )

    running.current = card
    mount.current?.replaceChildren(card.element)
    setStatus(`running ${label} · ${source}`)
  }, [actions, chatId, characterId, granted, networkGranted, stop])

  return (
    <Section title="Sandbox probe (dev)">
      <p className="iris-field__note">
        Runs a probe body in a real card frame. It answers the three questions the
        unit tests cannot: whether <code>eval</code> survives the opaque origin,
        whether the height report sizes the frame, and whether a viewport read
        returns the host&rsquo;s numbers.
      </p>
      <div className="iris-probe__actions">
        <Button variant="outline" size="sm" onClick={() => void start(PROBE_SCRIPT, 'the probe')}>
          Run the probe
        </Button>
        <Button variant="ghost" size="sm" onClick={() => stop('asked')}>
          Stop
        </Button>
        <span className="iris-meta">{status}</span>
      </div>
      <label className="iris-probe__source">
        <input
          type="checkbox"
          checked={networkGranted}
          onChange={event => setNetworkGranted(event.target.checked)}
        />
        <span className="iris-probe__source-name">
          Grant this run the network (widens images, fetch and styles to https)
        </span>
      </label>

      {/*
        Real card code, from the two places it can come from.
        
        The card's own scripts are the real path and go through `script.body`,
        which only a real host answers — the fake refuses rather than inventing a
        body. The file input exists because that refusal would otherwise block
        the question worth answering: whether actual webpack output runs in the
        frame. A dropped file answers it today, against the same runner.
      */}
      <div className="iris-probe__sources">
        <span className="iris-label">Run real card code</span>
        {runnable.length === 0 ? (
          <p className="iris-field__note">
            No enabled scripts on this card{characterId === undefined ? ' (no card open)' : ''}.
          </p>
        ) : (
          runnable.map(script => (
            <div className="iris-probe__source" key={script.id}>
              <span className="iris-probe__source-name">{script.name}</span>
              <span className="iris-meta">{describeBytes(script.bytes)}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    if (characterId === undefined) return
                    setStatus(`fetching ${script.name}…`)
                    const body = await actions.scriptBody(characterId, script.id)
                    if (!body.ok) {
                      // The host's own words, and its code. The first version of
                      // this line said "the fake client refuses bodies" whatever
                      // the cause, which sent someone to debug a transport that
                      // was already working.
                      setStatus(`no body for ${script.name} — ${body.error.code}: ${body.error.message}`)
                      return
                    }
                    await start(body.content, script.name)
                  })()
                }}
              >
                Run
              </Button>
            </div>
          ))
        )}
        <label className="iris-probe__source">
          <span className="iris-probe__source-name">…or a script file from disk</span>
          <input
            type="file"
            accept=".js,.txt"
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file === undefined) return
              void (async () => {
                await start(await file.text(), file.name)
              })()
            }}
          />
        </label>
      </div>
      <dl className="iris-state">
        <div className="iris-state__row">
          <dt className="iris-state__key">height reported</dt>
          <dd className="iris-state__value">{observed.height ?? 'none yet'}</dd>
        </div>
        <div className="iris-state__row">
          <dt className="iris-state__key">settings write seen</dt>
          <dd className="iris-state__value">{observed.settings ?? 'none'}</dd>
        </div>
      </dl>
      {observed.blocked.length === 0 ? null : (
        <ul className="iris-probe__blocked">
          {observed.blocked.map(row => (
            <li key={`${row.directive}:${row.host}`}>
              Iris refused <strong>{row.host}</strong> ({row.directive}). Network access for this card
              would allow it.
            </li>
          ))}
        </ul>
      )}
      {observed.errors.length === 0 ? null : (
        <ul className="iris-probe__errors">
          {observed.errors.map((message, at) => (
            <li key={at}>{message}</li>
          ))}
        </ul>
      )}
      <div className="iris-probe__frame" ref={mount} />
    </Section>
  )
}
