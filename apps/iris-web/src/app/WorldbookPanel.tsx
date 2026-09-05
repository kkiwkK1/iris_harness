/**
 * The world books panel: the global selection and the scan settings.
 *
 * This is the mechanism-grade half of a world-info UI — the two things that
 * change what every prompt contains — and deliberately not the entry editor:
 * viewing and editing entries is upstream's largest single panel and is queued
 * on its own. What is here was chosen because each control backs a stored
 * setting the host actually runs a scan with; before this panel existed those
 * settings existed only as defaults, and the only way to change them was to
 * edit the settings file by hand.
 *
 * @module iris-web/app/WorldbookPanel
 */

import { useEffect } from 'react'
import type { ReactElement } from 'react'

import type { InsertionStrategy, WorldbookSettingsView } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { ChoiceField, CollapsibleSection, ToggleField } from './fields.tsx'
import { useLanguage, t } from './i18n/use-language.ts'

/** Range of one numeric scan setting, with its step. */
const SLIDERS = {
  scanDepth: { min: 0, max: 20, step: 1 },
  budgetPercent: { min: 0, max: 100, step: 1 },
  budgetCap: { min: 0, max: 50_000, step: 100 },
  minActivations: { min: 0, max: 20, step: 1 },
  minActivationsDepthMax: { min: 0, max: 100, step: 1 },
  maxRecursionSteps: { min: 0, max: 20, step: 1 },
} as const

/**
 * Render one labelled numeric setting.
 *
 * A local slider rather than the shared `NumberField`, for one reason: these
 * settings have no "unset" layer to fall back to — the stored value merged over
 * defaults IS what the scan runs — so the field must not offer the
 * "use host default" button that `NumberField` shows, which would send a null
 * this endpoint refuses.
 */
function Slider({ label, note, value, bounds, onCommit }: {
  label: string
  note?: string
  value: number
  bounds: { min: number, max: number, step: number }
  onCommit: (value: number) => void
}): ReactElement {
  useLanguage()
  return (
    <div className="iris-field">
      <span className="iris-field__label">{label}</span>
      <span className="iris-field__value">{String(value)}</span>
      <input
        className="iris-range iris-field__control"
        type="range"
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        value={value}
        aria-label={label}
        onChange={event => onCommit(Number(event.target.value))}
      />
      <span className="iris-field__note">{note}</span>
    </div>
  )
}

/**
 * Render the world books panel.
 *
 * Data is fetched on first mount and kept in the store afterwards, so re-opening
 * the drawer re-reads only what this session has not fetched yet.
 * @returns the panel.
 */
export function WorldbookPanel(): ReactElement {
  const worldbooks = useIris(state => state.worldbooks)
  const actions = useIrisActions()
  useLanguage()

  useEffect(() => {
    if (worldbooks === undefined) void actions.loadWorldbooks()
  }, [worldbooks, actions])

  const patch = (part: Partial<WorldbookSettingsView>): void => {
    void actions.patchWorldbookSettings(part)
  }

  if (worldbooks === undefined) {
    return (
      <CollapsibleSection id="worldbooks" title={t('sectionWorldbooks')}>
        <p className="iris-list__empty">{t('worldbooksNotLoaded')}</p>
      </CollapsibleSection>
    )
  }

  const settings = worldbooks.settings

  const selected = worldbooks.globalSelect.length

  return (
    <CollapsibleSection
      id="worldbooks"
      title={t('sectionWorldbooks')}
      summary={t('worldbookSummary', { count: selected, total: worldbooks.names.length })}
    >
      {/*
        The global selection. A checkbox list because the underlying fact is a
        set: order is upstream's array order, but every selected book applies
        whole, and a control that implied ranking would promise a semantics the
        host does not implement.
      */}
      <div className="iris-field">
        <span className="iris-field__label">{t('worldbookGlobalSelect')}</span>
        <span />
        <div className="iris-choice iris-field__control" role="group" aria-label={t('worldbookGlobalSelect')}>
          {worldbooks.names.length === 0
            ? <span className="iris-list__empty">{t('worldbooksEmpty')}</span>
            : worldbooks.names.map(name => {
              const selected = worldbooks.globalSelect.includes(name)
              return (
                <button
                  key={name}
                  type="button"
                  className="iris-choice__option"
                  aria-pressed={selected}
                  onClick={() =>
                    void actions.setGlobalSelect(
                      selected
                        ? worldbooks.globalSelect.filter(row => row !== name)
                        : [...worldbooks.globalSelect, name],
                    )}
                >
                  {name}
                </button>
              )
            })}
        </div>
      </div>

      <Slider
        label={t('worldbookScanDepth')}
        note={t('worldbookScanDepthNote')}
        value={settings.scanDepth}
        bounds={SLIDERS.scanDepth}
        onCommit={value => patch({ scanDepth: value })}
      />
      <Slider
        label={t('worldbookBudget')}
        note={t('worldbookBudgetNote')}
        value={settings.budgetPercent}
        bounds={SLIDERS.budgetPercent}
        onCommit={value => patch({ budgetPercent: value })}
      />
      <Slider
        label={t('worldbookBudgetCap')}
        note={t('worldbookBudgetCapNote')}
        value={settings.budgetCap}
        bounds={SLIDERS.budgetCap}
        onCommit={value => patch({ budgetCap: value })}
      />
      <Slider
        label={t('worldbookMinActivations')}
        note={t('worldbookMinActivationsNote')}
        value={settings.minActivations}
        bounds={SLIDERS.minActivations}
        onCommit={value => patch({ minActivations: value })}
      />
      <Slider
        label={t('worldbookMinActivationsDepthMax')}
        note={t('worldbookMinActivationsDepthMaxNote')}
        value={settings.minActivationsDepthMax}
        bounds={SLIDERS.minActivationsDepthMax}
        onCommit={value => patch({ minActivationsDepthMax: value })}
      />
      <Slider
        label={t('worldbookMaxRecursionSteps')}
        note={t('worldbookMaxRecursionStepsNote')}
        value={settings.maxRecursionSteps}
        bounds={SLIDERS.maxRecursionSteps}
        onCommit={value => patch({ maxRecursionSteps: value })}
      />

      <ChoiceField<InsertionStrategy>
        label={t('worldbookStrategy')}
        value={settings.insertionStrategy}
        options={[
          { id: 'character_first', label: t('strategyCharacterFirst') },
          { id: 'global_first', label: t('strategyGlobalFirst') },
          { id: 'evenly', label: t('strategyEvenly') },
        ]}
        onSelect={id => patch({ insertionStrategy: id })}
      />

      <ToggleField
        label={t('worldbookRecursive')}
        note={t('worldbookRecursiveNote')}
        value={settings.recursive}
        onToggle={next => patch({ recursive: next })}
      />
      <ToggleField
        label={t('worldbookCaseSensitive')}
        value={settings.caseSensitive}
        onToggle={next => patch({ caseSensitive: next })}
      />
      <ToggleField
        label={t('worldbookMatchWholeWords')}
        note={t('worldbookMatchWholeWordsNote')}
        value={settings.matchWholeWords}
        onToggle={next => patch({ matchWholeWords: next })}
      />
      <ToggleField
        label={t('worldbookUseGroupScoring')}
        note={t('worldbookUseGroupScoringNote')}
        value={settings.useGroupScoring}
        onToggle={next => patch({ useGroupScoring: next })}
      />
    </CollapsibleSection>
  )
}
