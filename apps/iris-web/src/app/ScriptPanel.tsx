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
import { CollapsibleSection } from './fields.tsx'
import { consentFigures, describeConsentAsk } from '../sandbox/consent.ts'
import { reportRowClass } from './host-report-rows.ts'
import { useLanguage, t } from './i18n/use-language.ts'
import { getLanguage } from './i18n/language.ts'
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
  // Subscribed so a language switch re-renders the panel's words.
  useLanguage()

  useEffect(() => {
    if (characterId !== undefined) void actions.loadScripts(characterId)
  }, [characterId, actions])

  if (characterId === undefined) return null

  const loaded = scriptsFor === characterId

  const summary = !loaded
    ? undefined
    : scripts.length === 0 ? t('cardNoScripts') : t('scriptSummary', { count: scripts.length })

  return (
    <CollapsibleSection id="scripts" title={t('sectionCardScripts')} summary={summary}>
      {!loaded ? (
        <p className="iris-list__empty">{t('readingCard')}</p>
      ) : scripts.length === 0 ? (
        <p className="iris-list__empty">{t('cardNoScripts')}</p>
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
              {t('declinedSummary')}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void actions.answerScriptsAllowed(true)}
              >
                {t('allowScripts')}
              </Button>
            </p>
          ) : (
            <p className="iris-field__note iris-script__summary">
              {summariseRuns(runStates, getLanguage())}
            </p>
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
            /*
             * Graded by channel, with **neutral as the default**.
             *
             * Until recently every entry here carried `iris-script__failed`, a
             * class with no rule anywhere in the stylesheets — so a failure and
             * a harmless note rendered as the same plain paragraph, and no
             * wording could fix that. Giving *that* class the danger colour was
             * the wrong repair and made it visibly worse: the list is mostly not
             * failures — library cost, a card's own `toastr.info`, the overlay's
             * visibility summary — and all of it turned red at once. One class
             * cannot mean both "an item in this list" and "something is broken".
             */
            <p
              className={reportRowClass(report.grade === 'fault')}
              key={report.text}
            >
              {/*
                The channel as a **label**, the same element the pulled host
                view uses. Two sites used to concatenate it into the sentence
                (`interface: …`, `overlay: …`), which is the shape that produced
                `variables: variables: trimmed …` on the pushed path — and a
                channel inside the text cannot be styled or filtered, and
                doubles up the moment anything else adds a prefix.

                Absent for most reports, and that is correct rather than a gap:
                a frame's own whole sentence has no channel to name, and
                inventing one would be a label with nothing behind it.
              */}
              {report.channel === undefined
                ? null
                : <span className="iris-reports__area">{report.channel}</span>}
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
              {report.withdrawn === true ? (
                <span className="iris-script__stale"> · {t('withdrawn')}</span>
              ) : null}
              {report.generation === generation ? null : (
                <span className="iris-script__stale"> · {t('fromEarlierRun')}</span>
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
          <span className="iris-field__label">{t('pageAccess')}</span>
          <span className={`iris-grant__value${granted ? ' iris-grant__value--on' : ''}`}>
            {granted ? t('granted') : t('off')}
          </span>
        </div>
        <p className="iris-field__note">
          {granted ? t('grantedNote') : t('offNote')}
        </p>
        <p className="iris-field__note">
          {t('onlyYouNote')}
        </p>
        {granted ? (
          <Button variant="outline" size="sm" onClick={() => void actions.setDocumentGrant(false)}>
            {t('turnOffPageAccess')}
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
            {t('givePageAccess')}
          </Button>
        )}
      </div>

      <RiskConfirmation
        open={asking}
        title={t('grantDialogTitle')}
        description={t('grantDialogBody')}
        acknowledgeLabel={t('grantDialogAck')}
        cancelLabel={t('grantDialogCancel')}
        confirmLabel={t('grantDialogConfirm')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false)
          void actions.setDocumentGrant(true)
        }}
      />
    </CollapsibleSection>
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
          {describeRun(run, getLanguage())}
        </p>
      )}
      {cardOff ? (
        <p className="iris-field__note">
          {t('cardOffNote')}
        </p>
      ) : (
        <label className="iris-script__switch">
          <input
            type="checkbox"
            checked={script.enabled}
            onChange={event => onToggle(event.target.checked)}
          />
          <span>{script.enabled ? t('runsWithCard') : t('youTurnedThisOff')}</span>
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
  // Subscribed so a language switch re-renders the question.
  useLanguage()
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
        {describeConsentAsk(consentFigures(scripts), describeBytes, getLanguage()) ?? ''}
      </p>
      <div className="iris-grant__actions">
        <Button size="sm" onClick={() => onAnswer(true)}>
          {t('runThem')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onAnswer(false)}>
          {t('dontRunThem')}
        </Button>
      </div>
    </div>
  )
}

