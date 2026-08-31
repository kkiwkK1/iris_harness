/**
 * Card scripts, and the one decision the user owns about them.
 *
 * Two things this panel is careful about.
 *
 * It reports **both** switches. A card author ships scripts with their own
 * `enabled` flag, and the user has a separate one. Showing only the combined
 * result leaves "why is this off" unanswerable, and the two answers call for
 * different actions — one is the card's choice and not the user's to reverse.
 *
 * And the grant is worded by **consequence, not API**. "Grant document access"
 * describes the mechanism to someone who already knows it; the person deciding
 * needs to know that a granted card can read their other conversations. The
 * panel also says plainly that a card cannot ask for this, because that sentence
 * is what makes any in-card plea to enable something recognisable as a lie.
 *
 * @module iris-web/app/ScriptPanel
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScriptView } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { describeBytes } from './format.ts'
import { Section } from './fields.tsx'

/**
 * Render the card-script section.
 * @returns the section, or null when the open chat has no character.
 */
export function ScriptPanel(): ReactElement | null {
  const characterId = useIris(state => state.view?.characterId)
  const scripts = useIris(state => state.scripts)
  const scriptsFor = useIris(state => state.scriptsFor)
  const granted = useIris(state => state.documentGranted)
  const actions = useIrisActions()

  const [asking, setAsking] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    if (characterId !== undefined) void actions.loadScripts(characterId)
  }, [characterId, actions])

  if (characterId === undefined) return null

  const loaded = scriptsFor === characterId
  const runnable = scripts.filter(script => script.enabled).length

  return (
    <Section title="Card scripts">
      {!loaded ? (
        <p className="iris-list__empty">Reading the card…</p>
      ) : scripts.length === 0 ? (
        <p className="iris-list__empty">This card ships no scripts.</p>
      ) : (
        <>
          <p className="iris-field__note iris-script__summary">
            {runnable} of {scripts.length} will run when you open a chat with this card.
          </p>
          {scripts.map(script => (
            <ScriptRow
              key={script.id}
              script={script}
              onToggle={enabled => void actions.setScriptEnabled(script.id, enabled)}
            />
          ))}
        </>
      )}

      <div className="iris-grant">
        <div className="iris-grant__state">
          <span className="iris-field__label">Page access</span>
          <span className={`iris-grant__value${granted ? ' iris-grant__value--on' : ''}`}>
            {granted ? 'granted' : 'off'}
          </span>
        </div>
        <p className="iris-field__note">
          {granted
            ? 'This card can read and change anything on screen, including your other conversations. It stays this way until you turn it off.'
            : 'This card’s scripts can only touch their own panel. They cannot read your other conversations.'}
        </p>
        <p className="iris-field__note">
          Only you can turn this on. A card has no way to ask — if one tells you to enable something, that
          text came from the card.
        </p>
        {granted ? (
          <Button variant="outline" size="sm" onClick={() => void actions.setDocumentGrant(false)}>
            Turn off page access
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAcknowledged(false)
              setAsking(true)
            }}
          >
            Give this card page access…
          </Button>
        )}
      </div>

      <RiskConfirmation
        open={asking}
        title="Let this card read and change the whole page?"
        description="Its scripts will be able to read and alter anything on screen — your other conversations, the text you are typing, your settings. Iris cannot limit what it does once this is on, and it stays on until you turn it off. Turn it on only for a card you trust and have a reason to."
        acknowledgeLabel="I understand this card will be able to read my other conversations"
        cancelLabel="Keep it off"
        confirmLabel="Grant page access"
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false)
          void actions.setDocumentGrant(true)
        }}
      />
    </Section>
  )
}

/**
 * One script row.
 *
 * A card-disabled script gets no toggle. The card's author switched it off, and
 * the policy honours that — a control that looks available but is refused would
 * be worse than one that explains itself.
 * @param props.script - the script as the host reports it.
 * @param props.onToggle - the user's own switch.
 * @returns the row.
 */
function ScriptRow({
  script,
  onToggle,
}: {
  script: ScriptView
  onToggle: (enabled: boolean) => void
}): ReactElement {
  const cardOff = !script.enabledByCard

  return (
    <div className="iris-script">
      <div className="iris-script__head">
        <span className="iris-script__name">{script.name}</span>
        <span className="iris-meta">{describeBytes(script.bytes)}</span>
      </div>
      {script.info !== undefined && script.info.trim() !== '' ? (
        <p className="iris-script__info">{script.info}</p>
      ) : null}
      {cardOff ? (
        <p className="iris-field__note">
          Off in the card. Its author shipped it switched off, so Iris does not run it.
        </p>
      ) : (
        <label className="iris-script__switch">
          <input
            type="checkbox"
            checked={script.enabled}
            onChange={event => onToggle(event.target.checked)}
          />
          <span>{script.enabled ? 'Runs with this card' : 'You turned this off'}</span>
        </label>
      )}
    </div>
  )
}
