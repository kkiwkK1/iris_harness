/**
 * A dev-only harness for running something in a real card frame.
 *
 * It exists because the sandbox's decisions are covered by tests that have never
 * run inside an actual `<iframe>`. Three things cannot be checked any other way:
 * whether an opaque-origin frame with `unsafe-eval` really runs the shapes
 * webpack emits, whether the height report sizes the frame, and whether a card's
 * viewport read returns the host's numbers instead of zero.
 *
 * Two things here were learned from watching someone use it:
 *
 * **The observations live outside React** (`harness-state.ts`). An observer
 * running a real card lost the entire state view on their next interaction, three
 * times running. I guessed twice at what was unmounting and was wrong twice, so
 * the record stopped depending on the answer.
 *
 * **The frame lives until Stop**, not until the panel unmounts. The product rule
 * — a frame must not outlive its owner — is right for the product and wrong here:
 * "leaving the panel" turned out to be trivially easy to trigger by accident, and
 * a frame that vanishes mid-observation destroys the observation.
 *
 * Not a feature. Gated on `import.meta.env.DEV`, so the branch is dead in a
 * production build and this module drops out of the bundle.
 *
 * @module iris-web/dev/SandboxProbe
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScriptContext } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { describeBytes } from '../app/format.ts'
import { Section } from '../app/fields.tsx'
import { runCard } from '../sandbox/runner.ts'
import { PROBE_SCRIPT } from './probe-script.ts'
import { modeFor, stripCodeFence } from '../sandbox/script-source.ts'
import { librariesFor } from '../sandbox/libraries.ts'
import { checkBootstrap } from '../sandbox/bootstrap-source.ts'
import {
  getHarness,
  resetObservations,
  runningCard,
  setHarness,
  setRunningCard,
  subscribeHarness,
} from './harness-state.ts'

/**
 * A context to run against when the host will not supply one.
 *
 * The fake client refuses `script.context` on purpose — it will not invent a
 * context, because a card reading a fabricated one fails in ways that say nothing
 * about the real thing. For a probe measuring the *frame*, a clearly-labelled
 * stand-in is the right answer; it is never used for a real card without the
 * panel saying which one is in play.
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
  const scripts = useIris(state => state.scripts)
  const actions = useIrisActions()

  const observed = useSyncExternalStore(subscribeHarness, getHarness, getHarness)
  const mount = useRef<HTMLDivElement>(null)
  const silence = useRef<number | undefined>(undefined)
  // Dev-only until `networkGranted` reaches the contract. Here so the granted
  // policy can be exercised in a browser now: the policy is what is worth
  // checking, not the plumbing that will eventually carry the flag.
  const [networkGranted, setNetworkGranted] = useState(false)

  // Only what would actually run: the card's switch and the user's, combined.
  const runnable = scripts.filter(script => script.enabled)

  // Re-attach the surviving frame after a remount. Without this the record would
  // outlive the thing it describes, which is its own kind of confusing.
  useEffect(() => {
    const card = runningCard()
    if (card !== undefined) mount.current?.replaceChildren(card.element)
  }, [])

  const stop = useCallback((reason: string) => {
    if (runningCard() === undefined) return
    setRunningCard(undefined)
    mount.current?.replaceChildren()
    setHarness(before => ({
      status: `stopped (${reason})`,
      lastRun:
        before.lastRun === undefined ? { label: 'run', result: 'killed' } : { ...before.lastRun, result: 'killed' },
    }))
  }, [])

  const start = useCallback(
    async (code: string, label: string, kind: 'card-script' | 'probe') => {
      // A second Run while the first is still in flight used to start a frame
      // beside the one already posting into the same shell listener. Stopping the
      // old one first is what makes the second run mean something.
      setRunningCard(undefined)
      mount.current?.replaceChildren()
      window.clearTimeout(silence.current)
      resetObservations('loading bootstrap…')
      // "dispatched", not "started": this is set before the frame exists, so
      // calling it started would claim the body had begun when nothing had.
      setHarness({ lastRun: { label, result: 'dispatched' } })

      let bootstrap: string
      try {
        // `/sandbox/` — under `public/`, the one directory Vite serves verbatim.
        // Fetched from anywhere else in the project root it comes back rewritten
        // as an ES module, and the `import` that adds is a parse error in the
        // classic script it ends up inside.
        const response = await fetch('/sandbox/bootstrap.js')
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        bootstrap = await response.text()
      } catch (error: unknown) {
        const why = error instanceof Error ? error.message : String(error)
        setHarness({ status: `no bootstrap: ${why} — run "npm run build:sandbox"` })
        return
      }

      // Checked before injection, because after it there is nobody left to check.
      // A transformed bootstrap fails at PARSE time, so the frame's own reporter —
      // which is runtime — never exists, and the frame goes silent instead of
      // saying what went wrong.
      const unusable = checkBootstrap(bootstrap)
      if (unusable !== undefined) {
        setHarness({
          status: 'the bootstrap is not usable',
          lastRun: { label, result: 'bad bootstrap', detail: unusable },
        })
        return
      }

      // The real snapshot when the host will give one, a labelled stand-in when
      // it will not. Against the fake it will not, and for a probe measuring the
      // frame that is fine as long as the panel says which is in use.
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
          code: stripCodeFence(code),
          mode: modeFor(kind),
          libraries: librariesFor(kind, window.location.origin),
          documentGranted: granted,
          networkGranted,
          context,
          viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
          fetch: async url => {
            throw new Error(`the probe does not fetch (${url})`)
          },
          onCall: async (method, params) => actions.runCardAction(method, params),
          onSlash: async command => {
            setHarness(before => ({ slash: [...before.slash, command] }))
            // Rethrown, not swallowed: the card is awaiting this, and a resolved
            // promise would tell it the command ran.
            return actions.runSlash(command)
          },
          onSettings: settings => {
            setHarness({ settings: JSON.stringify(settings) })
          },
          onHeight: pixels => {
            setHarness({ height: pixels })
          },
          onReady: () => {
            window.clearTimeout(silence.current)
            setHarness({ status: `running ${label} · frame ready` })
          },
          onBootstrapError: message => {
            window.clearTimeout(silence.current)
            setHarness({
              status: 'the frame never started',
              lastRun: { label, result: 'bootstrap failed', detail: message },
            })
          },
          onGlobals: (published, refused) => {
            setHarness({
              globals:
                refused.length === 0
                  ? `all published: ${published.join(', ')}`
                  : `refused: ${refused.join(', ')} · published: ${published.join(', ')}`,
            })
          },
          onRan: () => {
            setHarness({ lastRun: { label, result: 'ran to completion' } })
          },
          onBlocked: (host, directive) => {
            setHarness(before =>
              // Deduplicated: a card pulling twenty images from a refused host
              // produces twenty violations, and twenty identical lines say
              // nothing the first one did not.
              before.blocked.some(row => row.host === host && row.directive === directive)
                ? {}
                : { blocked: [...before.blocked, { host, directive }] },
            )
          },
          onError: (message, member) => {
            setHarness(before => ({
              errors: [...before.errors, member === undefined ? message : `${member}: ${message}`],
              lastRun: { label, result: member === undefined ? 'threw' : 'refused', detail: message },
            }))
          },
        },
        document,
      )

      setRunningCard(card)
      mount.current?.replaceChildren(card.element)
      setHarness({ status: `running ${label} · ${source}` })

      // "Stuck at running" was the one state that could not explain itself, and
      // it is exactly the state a torn hot-reload or a dead bootstrap produces.
      // A frame that has not even said `ready` in eight seconds is not slow.
      window.clearTimeout(silence.current)
      silence.current = window.setTimeout(() => {
        setHarness(before =>
          before.status.includes('frame ready') || before.lastRun?.label !== label
            ? {}
            : {
                status: 'no frames received',
                lastRun: {
                  label,
                  result: 'silent',
                  detail: 'the frame sent nothing within 8s — bootstrap missing, stale, or torn by a reload',
                },
              },
        )
      }, 8000)
    },
    [actions, chatId, characterId, granted, networkGranted],
  )

  return (
    <Section title="Sandbox probe (dev)">
      <p className="iris-field__note">
        Runs a body in a real card frame. It answers the three questions the unit
        tests cannot: whether <code>eval</code> survives the opaque origin, whether the height report
        sizes the frame, and whether a viewport read returns the host&rsquo;s numbers.
      </p>
      <div className="iris-probe__actions">
        <Button variant="outline" size="sm" onClick={() => void start(PROBE_SCRIPT, 'the probe', 'probe')}>
          Run the probe
        </Button>
        <Button variant="ghost" size="sm" onClick={() => stop('asked')}>
          Stop
        </Button>
        <span className="iris-meta">{observed.status}</span>
      </div>

      {/*
        The last run's ending, kept after the run. An observation that exists only
        while a panel happens to be open is an observation you get one chance at.
      */}
      {observed.lastRun === undefined ? null : (
        <p className="iris-probe__outcome">
          Last run: <strong>{observed.lastRun.label}</strong> — {observed.lastRun.result}
          {observed.lastRun.detail === undefined ? null : `: ${observed.lastRun.detail}`}
        </p>
      )}

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
                    setHarness({ status: `fetching ${script.name}…` })
                    const body = await actions.scriptBody(characterId, script.id)
                    if (!body.ok) {
                      // The host's own words and its own code. A fixed sentence
                      // here once sent someone to debug a working transport.
                      setHarness({
                        status: `no body for ${script.name} — ${body.error.code}: ${body.error.message}`,
                      })
                      return
                    }
                    await start(body.content, script.name, 'card-script')
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
                await start(await file.text(), file.name, 'card-script')
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
        <div className="iris-state__row">
          <dt className="iris-state__key">globals published</dt>
          <dd className="iris-state__value">{observed.globals ?? 'not reported'}</dd>
        </div>
        <div className="iris-state__row">
          <dt className="iris-state__key">slash commands</dt>
          <dd className="iris-state__value">
            {observed.slash.length === 0 ? 'none' : observed.slash.join(' / ')}
          </dd>
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
