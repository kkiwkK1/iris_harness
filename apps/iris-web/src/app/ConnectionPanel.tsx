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
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Render the connection section.
 * @returns the section.
 */
export function ConnectionPanel(): ReactElement {
  const profiles = useIris(state => state.connections)
  const activeId = useIris(state => state.activeConnectionId)
  const settings = useIris(state => state.settings)
  const chatId = useIris(state => state.chatId)
  const origin = useIris(state => state.dataOrigin)
  const transport = useIris(state => state.transport)
  const actions = useIrisActions()

  const [naming, setNaming] = useState(false)
  const [label, setLabel] = useState('')
  // Subscribed so a language switch re-renders the panel's words.
  useLanguage()

  useEffect(() => {
    void actions.loadConnections()
  }, [actions])

  return (
    <Section title={t('sectionConnection')}>
      {/*
        **Which host this page is actually talking to**, said before anything
        about providers.

        "Connection" already meant the provider profile — the model behind the
        conversation — and left the other connection unstated: the host serving
        this app and holding its chats. With more than one host in play (a dev
        instance and a probe instance), "is this page on 8787 or 8789?" is a
        question that has to be re-derived from the address bar every time, and
        an answer derived from somewhere else is an answer that can disagree.

        `dataOrigin` is where the store already keeps it, and it was written and
        **never read** until now — the field's own doc says it exists "because
        the interface has to be able to say it", and only its sibling
        (`transport`) had ever been rendered. No new protocol: the value is what
        the page was built against.
      */}
      <p className="iris-field__note">
        {t('host')} <code>{origin}</code>
        {transport === 'fake' ? ` ${t('seededNotReal')}` : null}
      </p>
      {profiles.length === 0 ? (
        <p className="iris-list__empty">{t('noSavedConnections')}</p>
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
              aria-label={t('deleteNamed', { name: profile.label ?? profile.summary })}
              onClick={() => void actions.deleteConnection(profile.id)}
            >
              {t('delete')}
            </button>
          </div>
        ))
      )}

      <p className="iris-field__note">
        {chatId === undefined ? t('activateForDefaults') : t('activateForThisChat')}
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
            placeholder={t('nameThisConnection')}
            aria-label={t('connectionName')}
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
            {t('save')}
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setNaming(true)}>
          {t('saveConnection')}
        </Button>
      )}
    </Section>
  )
}
