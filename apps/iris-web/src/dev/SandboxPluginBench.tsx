/**
 * A dev-only bench for mounting a sandbox plugin by hand.
 *
 * PR-A is the tree with **no model** (`docs/SANDBOX-PLUGINS.md` §15): the source
 * of a plugin here is a person pasting code into a box. That is the whole point
 * of putting this PR first — the technical risk of the feature is "does it mount
 * and does it come away cleanly", and a version with nobody spending money on a
 * completion can be verified one line at a time.
 *
 * What it shows is deliberately the **shell's** view: the frame answers
 * `plugin:mounted` or `plugin:failed`, and this panel renders what arrived on
 * that channel. Reading the frame's console instead would be reading a different
 * instrument — one that cannot tell "the mount failed" from "the frame is fine
 * and the message never came back", which is the distinction the whole protocol
 * exists to make.
 *
 * Gated on `import.meta.env.DEV` at its render site, so this module drops out of
 * a production build. The little store behind it (`plugin-bench.ts`) does not,
 * and says so.
 *
 * @module iris-web/dev/SandboxPluginBench
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { precheckSandboxPluginSyntax, SANDBOX_PLUGIN_LIMITS } from '@iris/protocol'

import { useIris } from '../client/provider.tsx'
import { Section } from '../app/fields.tsx'
import {
  clearStatuses,
  mountIntoCard,
  pluginsFor,
  recordStatus,
  setPlugins,
  statusesFor,
  subscribeBench,
  unmountFromCard,
  type BenchStatus,
} from './plugin-bench.ts'

/**
 * A plugin that changes something visible, as a starting point.
 *
 * The acceptance script's first scenario, in the box, because a bench whose
 * first use requires writing a plugin is a bench nobody checks the easy case
 * with.
 */
const STARTER = `return {
  apply() {
    iris.styles.insert('body { background: #101418 !important; color: #e6edf3 !important; }')
    const box = document.createElement('div')
    box.textContent = 'mounted: ' + iris.id
    iris.panel.mount(box)
  },
  dispose() {
    // styles and the panel cell are taken away by the checklist either way;
    // this is where a plugin undoes what only it knows about.
  },
}`

/**
 * One status row, in words a reader can act on.
 * @param status - what the shell heard.
 * @returns the sentence.
 */
function describeStatus(status: BenchStatus): string {
  if (status.state === 'pending') return 'sent to the frame, no answer yet'
  if (status.state === 'mounted') return `mounted in ${status.ms ?? 0}ms`
  return `${status.state}: ${status.detail ?? ''}`
}

/**
 * Render the bench.
 * @returns the section.
 */
export function SandboxPluginBench(): ReactElement {
  const chatId = useIris(state => state.chatId)
  const [pluginId, setPluginId] = useState('1-bench')
  const [code, setCode] = useState(STARTER)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)

  const observed = useSyncExternalStore(
    subscribeBench,
    () => statusesFor(chatId),
    () => statusesFor(chatId),
  )
  const wanted = useSyncExternalStore(
    subscribeBench,
    () => pluginsFor(chatId),
    () => pluginsFor(chatId),
  )

  const version = (wanted.find(row => row.pluginId === pluginId)?.version ?? 0) + 1

  const mount = useCallback(() => {
    if (chatId === undefined) return
    /*
     * **The precheck runs before anything is sent**, and it compiles the exact
     * wrapper the frame will compile — that byte-identity is what stops
     * "the precheck passed and the mount failed on syntax" from being reachable
     * (§6.1). Here it stands in for the definition-time check PR-B runs on the
     * host: the state is the same one, and having it on this path means
     * `syntax-failed` is a state PR-A can actually produce and test.
     */
    const bad = precheckSandboxPluginSyntax(code)
    if (bad !== undefined) {
      setRefusal(bad.detail)
      recordStatus(chatId, { pluginId, version, state: bad.state, detail: bad.detail, at: Date.now() })
      return
    }
    setRefusal(undefined)
    // The list first, so a frame built later (a chat re-opened, a card with no
    // scripts) mounts it at `ready` without anybody pressing anything again.
    const next = [...wanted.filter(row => row.pluginId !== pluginId), { pluginId, version, code }]
    setPlugins(chatId, next)
    if (!mountIntoCard(pluginId, version, code)) {
      recordStatus(chatId, {
        pluginId,
        version,
        state: 'orphaned',
        // Named rather than silent: on a card with no scripts there is no frame
        // until the set is rebuilt, and "nothing happened" is the one answer a
        // bench must never give.
        detail: 'no card frame is running — re-open this chat to build one',
        at: Date.now(),
      })
    }
  }, [chatId, code, pluginId, version, wanted])

  const unmount = useCallback(() => {
    if (chatId === undefined) return
    setPlugins(chatId, wanted.filter(row => row.pluginId !== pluginId))
    unmountFromCard(pluginId)
  }, [chatId, pluginId, wanted])

  return (
    <Section title="Sandbox plugin bench (dev)">
      <p className="iris-field__note">
        Mounts a sandbox plugin into the open chat&rsquo;s card-script frame, with no model in the
        loop. The factory is called with one argument, <code>iris</code>, carrying{' '}
        <code>id</code>, <code>styles</code>, <code>panel</code> and <code>card</code>; it returns an
        object with optional <code>apply</code> and <code>dispose</code>. <code>apply</code> has{' '}
        {SANDBOX_PLUGIN_LIMITS.applyMs / 1000}s.
      </p>

      {chatId === undefined ? (
        <p className="iris-field__note">No chat is open, so there is no frame to mount into.</p>
      ) : null}

      <label className="iris-probe__source">
        <span className="iris-probe__source-name">plugin id</span>
        <input value={pluginId} onChange={event => setPluginId(event.target.value)} />
      </label>

      <textarea
        aria-label="plugin source"
        rows={12}
        value={code}
        onChange={event => setCode(event.target.value)}
        style={{ width: '100%', fontFamily: 'monospace' }}
      />

      <div className="iris-probe__actions">
        <Button variant="outline" size="sm" onClick={mount} disabled={chatId === undefined}>
          Mount / replace (v{version})
        </Button>
        <Button variant="ghost" size="sm" onClick={unmount} disabled={chatId === undefined}>
          Unmount
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (chatId !== undefined) clearStatuses(chatId)
          }}
          disabled={chatId === undefined}
        >
          Clear the readings
        </Button>
      </div>

      {refusal === undefined ? null : (
        <p className="iris-probe__outcome">
          Refused before it was sent — <strong>syntax-failed</strong>: {refusal}
        </p>
      )}

      <dl className="iris-var">
        {observed.length === 0 ? (
          <p className="iris-field__note">Nothing heard back yet.</p>
        ) : (
          observed.map(status => (
            <div className="iris-var__row" key={status.pluginId}>
              <dt className="iris-var__key">{status.pluginId}</dt>
              <dd className="iris-var__value">
                {describeStatus(status)} · heard at {new Date(status.at).toLocaleTimeString()}
              </dd>
            </div>
          ))
        )}
      </dl>
    </Section>
  )
}
