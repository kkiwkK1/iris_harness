import type { ReactElement } from 'react'
import { useIris, useIrisActions } from '../client/provider.tsx'
import { NumberField, ToggleField } from './fields.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import { MAX_CONTEXT_WINDOW } from '@iris/protocol'

export function MemoryContextPanel(): ReactElement {
 const settings = useIris(state => state.settings)
 const actions = useIrisActions()
 useLanguage()
 const patch = (key: string, value: number | string | boolean | null | string[]): void => { void actions.patchSettings({ [key]: value }) }
 if (settings === undefined) return <p className="iris-list__empty">{t('settingsNotLoaded')}</p>
 return (<>
                  <NumberField
                    label={t('contextWindow')}
                    value={settings.contextWindow}
                    /*
                      4 000 000, which is `MAX_CONTEXT_WINDOW` — the ceiling the
                      settings store, the probe and the wire schema all check.
                      It was 2 000 000, which is upstream's `unlocked_max`
                      verbatim, and that made the unlock switch below argue
                      against a bound this control was still imposing: the
                      reason not to borrow upstream's 2M is that it would cap a
                      future 4M model at a 2026 constant, and the slider was
                      capping it anyway.
                    */
                    bounds={{ min: 512, max: MAX_CONTEXT_WINDOW, step: 512 }}
                    fallback={32_768}
                    decimals={0}
                    note={t('contextWindowNote')}
                    onCommit={value => patch('contextWindow', value)}
                  />
                  {/*
                    Beside the window and not elsewhere, because it is the other
                    half of one decision: the number above is capped at what the
                    model is known to accept until this is on. Upstream's
                    `max_context_unlocked` — where it lives beside the same
                    slider, for the same reason.
                  */}
                  <ToggleField
                    label={t('contextUnlocked')}
                    note={t('contextUnlockedNote')}
                    value={settings.contextUnlocked === true}
                    onToggle={next => patch('contextUnlocked', next)}
                  />

 </>)
}
