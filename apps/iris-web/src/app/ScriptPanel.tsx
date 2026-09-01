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
import { consentFigures, describeConsentAsk } from '../sandbox/consent.ts'
import {
  describeRun,
  isFailure,
  summariseRuns,
  type ScriptRunState,
} from '../sandbox/script-run-state.ts'

/**
 * Render the card-script section.
 * @returns the section, or null when the open chat has no character.
 */
export function ScriptPanel(): ReactElement | null {
  const characterId = useIris(state => state.view?.characterId)
  const scripts = useIris(state => state.scripts)
  const scriptsFor = useIris(state => state.scriptsFor)
  const granted = useIris(state => state.documentGranted)
  const consent = useIris(state => state.scriptsAllowed)
  const runStates = useIris(state => state.runStates)
  const cardReports = useIris(state => state.cardReports)
  const generation = useIris(state => state.cardRunGeneration)
  const actions = useIrisActions()

  const [asking, setAsking] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    if (characterId !== undefined) void actions.loadScripts(characterId)
  }, [characterId, actions])

  if (characterId === undefined) return null

  const loaded = scriptsFor === characterId

  return (
    <Section title="Card scripts">
      {!loaded ? (
        <p className="iris-list__empty">Reading the card…</p>
      ) : scripts.length === 0 ? (
        <p className="iris-list__empty">This card ships no scripts.</p>
      ) : (
        <>
          {/*
            The heading answers what is happening, not what is configured.
            "2 of 2 enabled" and "2 of 2 running" are different answers, and the
            difference is the whole question this panel is opened to settle — so
            once scripts start on their own, a static count is the wrong sentence.

            Each of the three consent states says something different, and none of
            them is silence: a card whose scripts have never been offered must not
            look the same as one whose scripts were declined.
          */}
          {consent === 'unasked' ? (
            <ConsentGate
              scripts={scripts}
              onAnswer={allowed => void actions.answerScriptsAllowed(allowed)}
            />
          ) : consent === 'declined' ? (
            <p className="iris-field__note iris-script__summary">
              Not running. You declined this card&rsquo;s scripts — turn them on below if you
              change your mind.
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void actions.answerScriptsAllowed(true)}
              >
                Allow scripts
              </Button>
            </p>
          ) : (
            <p className="iris-field__note iris-script__summary">{summariseRuns(runStates)}</p>
          )}
          {/*
        What the frame said about itself, as opposed to about one script: a
        library it lacks, a name a card read that nobody published, a global it
        could not define. These have no script to belong to, and until they had
        somewhere durable to live they went to the notice bar — one slot, cleared
        after eight seconds — where a burst of them erased itself before anyone
        could read it.
      */}
      {cardReports.length === 0 ? null : (
        <div className="iris-field__note">
          {cardReports.map(report => (
            <p className="iris-script__failed" key={report.text}>
              {report.text}
              {/*
                Marked, not hidden, and not dropped.

                A finding from an earlier run is still evidence — it may be the
                only record of something that has since stopped reporting — but
                read in the present tense it misleads badly. One panel showed
                "the provider import timed out" beside an error that could only
                have come from a run where that import had succeeded, and
                separating them took a person who remembered the order of the
                afternoon.
              */}
              {report.generation === generation ? null : (
                <span className="iris-script__stale"> · from an earlier run</span>
              )}
            </p>
          ))}
        </div>
      )}

      {scripts.map(script => (
            <ScriptRow
              key={script.id}
              script={script}
              run={runStates.find(state => state.scriptId === script.id)}
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
  run,
  onToggle,
}: {
  script: ScriptView
  run?: ScriptRunState | undefined
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
      {/*
        What this script is actually doing. A refusal names the member it reached
        for, which is the reason refusals throw instead of returning undefined —
        the name is the only part that tells a card's author what to change.
      */}
      {run === undefined ? null : (
        <p className={isFailure(run.phase) ? 'iris-script__failed' : 'iris-field__note'}>
          {describeRun(run)}
        </p>
      )}
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

/**
 * The one-time question, asked when a card's scripts have never been offered.
 *
 * Worded by consequence, like the page grant beside it: what a user needs is
 * what running this costs them, not the name of the mechanism. The size is
 * included because it is the only proxy a reader has for how much code they are
 * agreeing to, and it counts every script rather than the enabled ones — the
 * answer covers scripts they may switch on later without being asked again.
 *
 * **A card cannot reach this.** It is not triggered, accelerated or pre-filled by
 * anything the card does, which is what makes an in-card plea to allow scripts
 * recognisable as a lie. Declining is recorded, so the question is asked once and
 * not on every chat the user opens.
 * @param props.count - how many scripts would run.
 * @param props.bytes - their total size.
 * @param props.onAnswer - called with the user's decision.
 * @returns the question.
 */
export function ConsentGate({
  scripts,
  onAnswer,
}: {
  scripts: readonly ScriptView[]
  onAnswer: (allowed: boolean) => void
}): ReactElement {
  return (
    <div className="iris-grant">
      <p className="iris-field__note">
        {/*
          One ruler per number, both stated, and the grammar agreeing with the
          number that is actually the subject.

          The first version said "ships 4 scripts (448 kB)": four counted the
          enabled ones, 448 kB measured all nine. Someone was told they were
          about to run 26x more code than they were. The second said "1 script …
          They run in", which no card with two scripts could reveal.

          The sentence lives in `consent.ts` so it can be tested against the
          shapes that expose those mistakes — a card whose counts diverge, and a
          card with exactly one script.
        */}
        {describeConsentAsk(consentFigures(scripts), describeBytes) ?? ''}
      </p>
      <div className="iris-grant__actions">
        <Button size="sm" onClick={() => onAnswer(true)}>
          Run them
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onAnswer(false)}>
          Don&rsquo;t run them
        </Button>
      </div>
    </div>
  )
}

