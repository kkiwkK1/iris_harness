/**
 * Choosing where a conversation is sent.
 *
 * One rule shapes every line of this file: **a name is not evidence of where a
 * profile goes.** Measured on a real SillyTavern install, the profile the user
 * had selected was called `deepseek deepseek-chat` and actually pointed at
 * Gemini, through a different endpoint, with a different preset. Upstream stores
 * the display name as a snapshot taken at creation, so it was true for a moment
 * and wrong from then on.
 *
 * The contract's answer is that `summary` is derived on every read and never
 * stored. The interface's answer is that **the summary is always on screen** —
 * beside a user's own label, not instead of it. A label the user wrote can also
 * go stale; the difference is that going stale is then their own doing, and they
 * can still see the truth next to it.
 *
 * @module iris-web/app/ConnectionPanel
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Section } from './fields.tsx'

/**
 * Render the connection section.
 * @returns the section.
 */
export function ConnectionPanel(): ReactElement {
  const profiles = useIris(state => state.connections)
  const activeId = useIris(state => state.activeConnectionId)
  const settings = useIris(state => state.settings)
  const chatId = useIris(state => state.chatId)
  const actions = useIrisActions()

  const [naming, setNaming] = useState(false)
  const [label, setLabel] = useState('')

  useEffect(() => {
    void actions.loadConnections()
  }, [actions])

  return (
    <Section title="Connection">
      {profiles.length === 0 ? (
        <p className="iris-list__empty">No saved connections.</p>
      ) : (
        profiles.map(profile => (
          <div className="iris-conn" key={profile.id} aria-current={profile.id === activeId}>
            <button
              type="button"
              className="iris-conn__pick"
              onClick={() => void actions.activateConnection(profile.id)}
            >
              {/*
                The label when there is one, the summary when there is not — and
                the summary regardless. A profile named after a model it no longer
                uses is the exact failure this panel exists to prevent, and the
                only defence is showing the derived truth every time.
              */}
              <span className="iris-conn__name">{profile.label ?? profile.summary}</span>
              <span className="iris-conn__summary">{profile.summary}</span>
            </button>
            <button
              type="button"
              className="iris-act iris-act--danger"
              aria-label={`Delete ${profile.label ?? profile.summary}`}
              onClick={() => void actions.deleteConnection(profile.id)}
            >
              Delete
            </button>
          </div>
        ))
      )}

      <p className="iris-field__note">
        {chatId === undefined
          ? 'Activating a connection sets the defaults for new conversations.'
          : 'Activating a connection applies it to this conversation.'}
      </p>

      {/*
        Saving captures what is in force right now rather than opening an editor:
        the Route and Sampling fields below already are that editor, and a second
        one would be two places to change the same thing.
      */}
      {settings === undefined ? null : naming ? (
        <div className="iris-conn__save">
          <input
            className="iris-text"
            autoFocus
            value={label}
            placeholder="Name this connection"
            aria-label="Connection name"
            onChange={event => setLabel(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') setNaming(false)
            }}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              const named = label.trim()
              setNaming(false)
              setLabel('')
              void actions.saveConnection({
                provider: settings.provider,
                model: settings.model,
                ...(named === '' ? {} : { label: named }),
                sampling: { ...settings },
              })
            }}
          >
            Save
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setNaming(true)}>
          Save the current settings as a connection
        </Button>
      )}
    </Section>
  )
}
