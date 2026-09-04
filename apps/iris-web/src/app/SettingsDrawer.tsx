/**
 * Settings, ordered rather than pruned.
 *
 * The loudest complaint about SillyTavern is that every knob is on screen at
 * once and a newcomer cannot tell which four matter. So: the parameters that
 * change a scene are at the top, the ones tuned once per model are behind one
 * disclosure, and reading preferences — which are not model settings at all and
 * live on the device — are their own section at the bottom. Nothing was removed.
 *
 * The drawer overlays the page instead of resizing it, because reflowing a page
 * of prose while a slider is being dragged is disorienting.
 *
 * @module iris-web/app/SettingsDrawer
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Slot } from '../slots/Slot.tsx'
import { ChoiceField, NumberField, Section, TextField } from './fields.tsx'
import { ConnectionPanel } from './ConnectionPanel.tsx'
import { HostReports } from './HostReports.tsx'
import { NoticeLog } from './NoticeLog.tsx'
import { ScriptPanel } from './ScriptPanel.tsx'
import { WorldbookPanel } from './WorldbookPanel.tsx'
import { SandboxProbe } from '../dev/SandboxProbe.tsx'
import { RailPreview } from '../dev/RailPreview.tsx'
import { READING_LIMITS, type ReadingPrefs, type ThemeChoice } from '../theme/theme.ts'
import { useLanguage, t } from './i18n/use-language.ts'
import type { Language } from './i18n/strings.ts'

/** Reading preferences and their setter, owned by the shell because they are per-device. */
export interface ReadingControl {
  theme: ThemeChoice
  reading: ReadingPrefs
  setTheme: (choice: ThemeChoice) => void
  setReading: (prefs: ReadingPrefs) => void
}

/**
 * Render the settings drawer.
 * @param props.open - whether it is showing.
 * @param props.onClose - called on the close button or Escape.
 * @param props.control - reading preferences, which do not go to the host.
 * @returns the drawer.
 */
export function SettingsDrawer({
  open,
  onClose,
  control,
}: {
  open: boolean
  onClose: () => void
  control: ReadingControl
}): ReactElement {
  const settings = useIris(state => state.settings)
  const chatId = useIris(state => state.chatId)
  const actions = useIrisActions()
  const [expanded, setExpanded] = useState(false)
  // The language control, and the subscription that makes a switch repaint this
  // drawer without a reload.
  const { lang, setLang } = useLanguage()

  const patch = (key: string, value: number | string | null | string[]): void => {
    void actions.patchSettings({ [key]: value })
  }

  return (
    <aside
      className={`iris-drawer${open ? ' iris-drawer--open' : ''}`}
      aria-label={t('drawerAria')}
      aria-hidden={!open}
      onKeyDown={event => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="iris-drawer__head">
        <h2 className="iris-label iris-drawer__title">
          {chatId === undefined ? t('defaultsForNew') : t('thisConversation')}
        </h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('close')}
        </Button>
      </div>

      <div className="iris-drawer__body">
        {settings === undefined ? (
          <p className="iris-list__empty">{t('settingsNotLoaded')}</p>
        ) : (
          <>
            <ConnectionPanel />

            <Section title={t('sectionRoute')}>
              <TextField
                label={t('provider')}
                value={settings.provider}
                onCommit={value => patch('provider', value)}
              />
              <TextField
                label={t('model')}
                value={settings.model}
                placeholder={t('modelPlaceholder')}
                onCommit={value => patch('model', value)}
              />
            </Section>

            <Section title={t('sectionSampling')}>
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
            </Section>
          </>
        )}

        <Section title={t('sectionReading')}>
          <ChoiceField
            label={t('theme')}
            value={control.theme}
            options={[
              { id: 'system', label: t('themeSystem') },
              { id: 'light', label: t('themeLight') },
              { id: 'dark', label: t('themeDark') },
            ]}
            onSelect={control.setTheme}
          />
          <NumberField
            label={t('proseSize')}
            value={control.reading.size}
            bounds={READING_LIMITS.size}
            fallback={17}
            decimals={0}
            onCommit={value => {
              if (value !== null) control.setReading({ ...control.reading, size: value })
            }}
          />
          <NumberField
            label={t('lineLength')}
            value={control.reading.measure}
            bounds={READING_LIMITS.measure}
            fallback={68}
            decimals={0}
            note={t('lineLengthNote')}
            onCommit={value => {
              if (value !== null) control.setReading({ ...control.reading, measure: value })
            }}
          />
          {/*
            The interface language. Lives beside the theme because it is the same
            kind of thing — a per-device choice about the shell's own surface
            (SETTINGS-IA.md 意图 #4, 界面本地) — and takes effect on the spot,
            like the theme does.
          */}
          <ChoiceField
            label={t('sectionLanguage')}
            value={lang}
            options={[
              // Each option is shown in its own language, always: a reader who
              // has switched to a language they cannot yet read has to be able
              // to find their way back by shape.
              { id: 'en', label: t('langEn') },
              { id: 'zh', label: t('langZh') },
            ]}
            onSelect={(id: Language) => setLang(id)}
          />
        </Section>

        <ScriptPanel />

        {/*
          The world books panel, beside the script panel because it answers the
          same kind of question from the other side: what shapes the model's
          view of this scene. Its data is installation-wide rather than per
          chat, which is why it sits outside the `settings === undefined`
          branch — like the host reports below, it is meaningful with no
          conversation open at all.
        */}
        <WorldbookPanel />

        {/*
          The host's own reports, **outside** the `settings === undefined`
          branch above and after the card panel.

          Outside, because a failed settings load makes these *more* worth
          reading, not less — a drawer that hides its diagnostics exactly when
          something is wrong is the shape this whole view exists to end. After
          the card panel, because it answers a different question: `ScriptPanel`
          is about the card in front of you and is empty in a chat with no
          scripts, while the host trims variables and materialises books
          regardless of whether any card is running.
        */}
        <HostReports />

        {/*
          The notice history, beside the host's reports because they answer the
          same question from two sides: what did this session say, and is it
          still sayable. The bar itself is gone in three seconds.
        */}
        <NoticeLog />

        {/*
          Dev only, and written so the branch is statically dead in a production
          build: `import.meta.env.DEV` is replaced with `false`, so the whole
          harness — and the runner it pulls in — drops out of the bundle.
        */}
        {import.meta.env.DEV ? <SandboxProbe /> : null}
        {import.meta.env.DEV ? <RailPreview /> : null}

        <Slot name="iris.settings.sections" owner={{}} />
      </div>
    </aside>
  )
}
