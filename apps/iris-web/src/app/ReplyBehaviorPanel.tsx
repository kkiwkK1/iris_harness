import type { ReactElement } from 'react'
import { useIris, useIrisActions } from '../client/provider.tsx'
import { ChoiceField, ToggleField } from './fields.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import type { ContinuePostfix } from '@iris/protocol'

export function ReplyBehaviorPanel(): ReactElement {
 const settings = useIris(state => state.settings)
 const actions = useIrisActions()
 useLanguage()
 const patch = (key: string, value: number | string | boolean | null | string[]): void => { void actions.patchSettings({ [key]: value }) }
 if (settings === undefined) return <p className="iris-list__empty">{t('settingsNotLoaded')}</p>
 return (<>
              <ToggleField
                label={t('trimSentences')}
                note={t('trimSentencesNote')}
                value={settings.trimSentences === true}
                onToggle={next => patch('trimSentences', next)}
              />
              <ChoiceField<ContinuePostfix>
                label={t('continuePostfix')}
                value={settings.continuePostfix ?? 'space'}
                options={[
                  { id: 'none', label: t('postfixNone') },
                  { id: 'space', label: t('postfixSpace') },
                  { id: 'newline', label: t('postfixNewline') },
                  { id: 'double', label: t('postfixDouble') },
                ]}
                onSelect={id => patch('continuePostfix', id)}
              />
              <p className="iris-field__note">{t('continuePostfixNote')}</p>
              <ToggleField
                label={t('squashSystemMessages')}
                note={t('squashSystemMessagesNote')}
                value={settings.squashSystemMessages === true}
                onToggle={next => patch('squashSystemMessages', next)}
              />
              {/*
                The one switch on this card whose **absence means on**, so the
                value reads `!== false` rather than `=== true`. Spelled out here
                rather than folded into a helper: the asymmetry is the fact a
                reader of this line needs, and a helper would hide it.
              */}
              <ToggleField
                label={t('cacheFriendly')}
                note={t('cacheFriendlyNote')}
                value={settings.cacheFriendly !== false}
                onToggle={next => patch('cacheFriendly', next)}
              />

 </>)
}
