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
import { ScriptPanel } from './ScriptPanel.tsx'
import { SandboxProbe } from '../dev/SandboxProbe.tsx'
import { READING_LIMITS, type ReadingPrefs, type ThemeChoice } from '../theme/theme.ts'

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

  const patch = (key: string, value: number | string | null | string[]): void => {
    void actions.patchSettings({ [key]: value })
  }

  return (
    <aside
      className={`iris-drawer${open ? ' iris-drawer--open' : ''}`}
      aria-label="Settings"
      aria-hidden={!open}
      onKeyDown={event => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="iris-drawer__head">
        <h2 className="iris-label iris-drawer__title">
          {chatId === undefined ? 'Defaults for new conversations' : 'This conversation'}
        </h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="iris-drawer__body">
        {settings === undefined ? (
          <p className="iris-list__empty">Settings have not loaded.</p>
        ) : (
          <>
            <Section title="Route">
              <TextField
                label="Provider"
                value={settings.provider}
                onCommit={value => patch('provider', value)}
              />
              <TextField
                label="Model"
                value={settings.model}
                placeholder="e.g. local/qwen3-8b"
                onCommit={value => patch('model', value)}
              />
            </Section>

            <Section title="Sampling">
              <NumberField
                label="Temperature"
                value={settings.temperature}
                bounds={{ min: 0, max: 2, step: 0.01 }}
                fallback={1}
                note="How far the model strays from its likeliest next word."
                onCommit={value => patch('temperature', value)}
              />
              <NumberField
                label="Reply length cap"
                value={settings.maxTokens}
                bounds={{ min: 128, max: 8192, step: 64 }}
                fallback={1024}
                decimals={0}
                note="Tokens, not words. A long scene needs a high cap."
                onCommit={value => patch('maxTokens', value)}
              />
              <NumberField
                label="Top-p"
                value={settings.topP}
                bounds={{ min: 0, max: 1, step: 0.01 }}
                fallback={0.95}
                note="Keeps only the likeliest words that add up to this much probability."
                onCommit={value => patch('topP', value)}
              />
              <NumberField
                label="Repetition penalty"
                value={settings.repetitionPenalty}
                bounds={{ min: 1, max: 1.5, step: 0.01 }}
                fallback={1.05}
                note="Raise it when the model starts repeating a phrase."
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
                  {expanded ? 'Fewer parameters' : 'More parameters'}
                </button>
              </div>

              {expanded ? (
                <>
                  <NumberField
                    label="Top-k"
                    value={settings.topK}
                    bounds={{ min: 0, max: 200, step: 1 }}
                    fallback={40}
                    decimals={0}
                    onCommit={value => patch('topK', value)}
                  />
                  <NumberField
                    label="Min-p"
                    value={settings.minP}
                    bounds={{ min: 0, max: 0.5, step: 0.005 }}
                    fallback={0.05}
                    decimals={3}
                    onCommit={value => patch('minP', value)}
                  />
                  <NumberField
                    label="Frequency penalty"
                    value={settings.frequencyPenalty}
                    bounds={{ min: -2, max: 2, step: 0.01 }}
                    fallback={0}
                    onCommit={value => patch('frequencyPenalty', value)}
                  />
                  <NumberField
                    label="Presence penalty"
                    value={settings.presencePenalty}
                    bounds={{ min: -2, max: 2, step: 0.01 }}
                    fallback={0}
                    onCommit={value => patch('presencePenalty', value)}
                  />
                  <NumberField
                    label="Seed"
                    value={settings.seed}
                    bounds={{ min: 0, max: 1000000, step: 1 }}
                    fallback={0}
                    decimals={0}
                    note="Fix it to make a regenerate reproducible."
                    onCommit={value => patch('seed', value)}
                  />
                  <TextField
                    label="Stop at"
                    value={(settings.stop ?? []).join(' | ')}
                    placeholder="separate with |"
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

        <Section title="Reading">
          <ChoiceField
            label="Theme"
            value={control.theme}
            options={[
              { id: 'system', label: 'System' },
              { id: 'light', label: 'Light' },
              { id: 'dark', label: 'Dark' },
            ]}
            onSelect={control.setTheme}
          />
          <NumberField
            label="Prose size"
            value={control.reading.size}
            bounds={READING_LIMITS.size}
            fallback={17}
            decimals={0}
            onCommit={value => {
              if (value !== null) control.setReading({ ...control.reading, size: value })
            }}
          />
          <NumberField
            label="Line length"
            value={control.reading.measure}
            bounds={READING_LIMITS.measure}
            fallback={68}
            decimals={0}
            note="Characters per line. Around 66 is what a book uses."
            onCommit={value => {
              if (value !== null) control.setReading({ ...control.reading, measure: value })
            }}
          />
        </Section>

        <ScriptPanel />

        {/*
          Dev only, and written so the branch is statically dead in a production
          build: `import.meta.env.DEV` is replaced with `false`, so the whole
          harness — and the runner it pulls in — drops out of the bundle.
        */}
        {import.meta.env.DEV ? <SandboxProbe /> : null}

        <Slot name="iris.settings.sections" owner={{}} />
      </div>
    </aside>
  )
}
