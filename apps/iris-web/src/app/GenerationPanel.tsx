import { useState } from 'react'
import type { ReactElement } from 'react'
import { useIris, useIrisActions } from '../client/provider.tsx'
import { ChoiceField, NumberField, TextField } from './fields.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import type { ReasoningEffort } from '@iris/protocol'
import { effortInForce, effortPatch, REASONING_EFFORTS } from './composer-bar.ts'

export function GenerationPanel(): ReactElement {
 const settings = useIris(state => state.settings)
 const actions = useIrisActions()
 useLanguage()
 const [expanded, setExpanded] = useState(false)
 const patch = (key: string, value: number | string | boolean | null | string[]): void => { void actions.patchSettings({ [key]: value }) }
 if (settings === undefined) return <p className="iris-list__empty">{t('settingsNotLoaded')}</p>
 return (<>
              <NumberField
                label={t('temperature')}
                value={settings.temperature}
                bounds={{ min: 0, max: 2, step: 0.01 }}
                fallback={1}
                note={t('temperatureNote')}
                onCommit={value => patch('temperature', value)}
              />
              <NumberField
                label={t('replyLengthCap')}
                value={settings.maxTokens}
                bounds={{ min: 128, max: 8192, step: 64 }}
                fallback={1024}
                decimals={0}
                note={t('replyLengthCapNote')}
                onCommit={value => patch('maxTokens', value)}
              />
              <NumberField
                label={t('topP')}
                value={settings.topP}
                bounds={{ min: 0, max: 1, step: 0.01 }}
                fallback={0.95}
                note={t('topPNote')}
                onCommit={value => patch('topP', value)}
              />
              <NumberField
                label={t('repetitionPenalty')}
                value={settings.repetitionPenalty}
                bounds={{ min: 1, max: 1.5, step: 0.01 }}
                fallback={1.05}
                note={t('repetitionPenaltyNote')}
                onCommit={value => patch('repetitionPenalty', value)}
              />

              <div className="iris-field">
                <button
                  type="button"
                  className="iris-reason__toggle iris-field__control"
                  aria-expanded={expanded}
                  onClick={() => setExpanded(!expanded)}
                >
                  <span
                    className={`iris-reason__chevron${expanded ? ' iris-reason__chevron--open' : ''}`}
                    aria-hidden="true"
                  >
                    ▸
                  </span>
                  {expanded ? t('fewerParameters') : t('moreParameters')}
                </button>
              </div>

              {expanded ? (
                <>
                  <NumberField
                    label={t('topK')}
                    value={settings.topK}
                    bounds={{ min: 0, max: 200, step: 1 }}
                    fallback={40}
                    decimals={0}
                    onCommit={value => patch('topK', value)}
                  />
                  <NumberField
                    label={t('minP')}
                    value={settings.minP}
                    bounds={{ min: 0, max: 0.5, step: 0.005 }}
                    fallback={0.05}
                    decimals={3}
                    onCommit={value => patch('minP', value)}
                  />
                  <NumberField
                    label={t('frequencyPenalty')}
                    value={settings.frequencyPenalty}
                    bounds={{ min: -2, max: 2, step: 0.01 }}
                    fallback={0}
                    onCommit={value => patch('frequencyPenalty', value)}
                  />
                  <NumberField
                    label={t('presencePenalty')}
                    value={settings.presencePenalty}
                    bounds={{ min: -2, max: 2, step: 0.01 }}
                    fallback={0}
                    onCommit={value => patch('presencePenalty', value)}
                  />
                  <ChoiceField
                    label={t('reasoningEffort')}
                    value={effortInForce(settings.reasoningEffort)}
                    /*
                      Upstream's own value words (`reasoning_effort_types`); they
                      name provider request fields and stay as written. The list
                      is `composer-bar.ts`'s, because the composer's bar offers
                      the same ladder (web §80) and two copies of six words is
                      how one surface comes to offer five.
                    */
                    options={REASONING_EFFORTS.map(effort => ({ id: effort, label: effort }))}
                    onSelect={id => patch('reasoningEffort', effortPatch(id as ReasoningEffort))}
                  />
                  <p className="iris-field__note">{t('reasoningEffortNote')}</p>
                  <NumberField
                    label={t('seed')}
                    value={settings.seed}
                    bounds={{ min: 0, max: 1000000, step: 1 }}
                    fallback={0}
                    decimals={0}
                    note={t('seedNote')}
                    onCommit={value => patch('seed', value)}
                  />
                  <TextField
                    label={t('stopAt')}
                    value={(settings.stop ?? []).join(' | ')}
                    placeholder={t('stopPlaceholder')}
                    onCommit={value =>
                      patch(
                        'stop',
                        value
                          .split('|')
                          .map(row => row.trim())
                          .filter(row => row !== ''),
                      )
                    }
                  />
                </>
              ) : null}

 </>)
}
