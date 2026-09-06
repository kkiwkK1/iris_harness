/**
 * The world books panel: the global selection, the scan settings, and the
 * entry editor.
 *
 * The first two are the mechanism-grade half — the things that change what
 * every prompt contains. The third, added on top of them, is the fine-grained
 * half: one named book's entries, listed, filtered, sorted, and editable
 * field by field, from the primary keys down to the per-entry scan overrides.
 *
 * The editor's shape is upstream's. Every field it shows exists in
 * SillyTavern's entry editor (`index.html` `entry_edit_template`), every
 * semantic was checked against that editor and against `@iris/lorebook`'s
 * `entryDefaults` — the stored template — and nothing was invented to fill a
 * gap: where the wire shape cannot carry a field, the field does not appear.
 * The list sorts are transcribed from upstream's selector one for one, with
 * its tie-breakers; see `worldbook-editor.ts`.
 *
 * Writes are whole-book, through `worldbook.replace`, and deliberately so:
 * that is the one write the host offers and upstream's own semantics besides.
 * The edits accumulate in a local draft (`store.wiEditor`), the panel says
 * plainly when that draft holds unsaved work, and leaving the draft — closing
 * the editor, switching books — asks, naming the book, before the work goes.
 *
 * @module iris-web/app/WorldbookPanel
 */

import { useEffect } from 'react'
import type { ReactElement } from 'react'
import { useState } from 'react'

import type { InsertionStrategy, WorldbookEntry, WorldbookSettingsView } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { ChoiceField, CollapsibleSection, ToggleField } from './fields.tsx'
import type { StringKey } from './i18n/strings.ts'
import { useLanguage, t } from './i18n/use-language.ts'
import {
  changedUids,
  DEFAULT_WI_SORT,
  formatKeyList,
  isDirty,
  parseKeyList,
  searchWiEntries,
  sortWiEntries,
  wiSearchScore,
  WI_SORTS,
  type WiSortId,
} from './worldbook-editor.ts'

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
 * The eight insertion positions, in upstream's selector order.
 *
 * The numbers are the stored `position` codes, which are the contract; the
 * labels are upstream's own terms (`↑Char`, `↓EM`, `at Depth`, `Outlet`),
 * with the key suffix carrying the wording.
 */
const WI_POSITIONS = [
  { type: 'before_character_definition', labelKey: 'wiPosBeforeChar' },
  { type: 'after_character_definition', labelKey: 'wiPosAfterChar' },
  { type: 'before_example_messages', labelKey: 'wiPosBeforeEm' },
  { type: 'after_example_messages', labelKey: 'wiPosAfterEm' },
  { type: 'before_author_note', labelKey: 'wiPosBeforeAn' },
  { type: 'after_author_note', labelKey: 'wiPosAfterAn' },
  { type: 'at_depth', labelKey: 'wiPosAtDepth' },
  { type: 'outlet', labelKey: 'wiPosOutlet' },
] as const

/**
 * The secondary-key logics, in the order upstream's dropdown lists them:
 * AND ANY first because it is the value a book gets when the field is absent.
 */
const WI_LOGICS = [
  { id: 'and_any', labelKey: 'wiLogicAndAny' },
  { id: 'and_all', labelKey: 'wiLogicAndAll' },
  { id: 'not_all', labelKey: 'wiLogicNotAll' },
  { id: 'not_any', labelKey: 'wiLogicNotAny' },
] as const

/** The three activation strategies, upstream's status selector. */
const WI_STRATEGIES = [
  { id: 'constant', labelKey: 'wiStrategyConstant' },
  { id: 'selective', labelKey: 'wiStrategyNormal' },
  { id: 'vectorized', labelKey: 'wiStrategyVectorized' },
] as const

/** The roles an at-depth injection can be written as. */
const WI_ROLES = [
  { id: 'system', labelKey: 'wiRoleSystem' },
  { id: 'user', labelKey: 'wiRoleUser' },
  { id: 'assistant', labelKey: 'wiRoleAssistant' },
] as const

/** The generation types an entry can be restricted to, upstream's list. */
const WI_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'] as const

/**
 * Each table's id → dictionary key, spelled out rather than templated
 * (`wiSort_${id}`): the dictionary's key union is the type that keeps the two
 * languages honest, and a template literal would slip every typo past it.
 */
const WI_SORT_LABELS: Record<WiSortId, StringKey> = {
  priority: 'wiSort_priority',
  custom: 'wiSort_custom',
  title_asc: 'wiSort_title_asc',
  title_desc: 'wiSort_title_desc',
  tokens_asc: 'wiSort_tokens_asc',
  tokens_desc: 'wiSort_tokens_desc',
  depth_asc: 'wiSort_depth_asc',
  depth_desc: 'wiSort_depth_desc',
  order_asc: 'wiSort_order_asc',
  order_desc: 'wiSort_order_desc',
  uid_asc: 'wiSort_uid_asc',
  uid_desc: 'wiSort_uid_desc',
  probability_asc: 'wiSort_probability_asc',
  probability_desc: 'wiSort_probability_desc',
  search: 'wiSort_search',
}

const WI_TRIGGER_LABELS: Record<(typeof WI_TRIGGERS)[number], StringKey> = {
  normal: 'wiTrigger_normal',
  continue: 'wiTrigger_continue',
  impersonate: 'wiTrigger_impersonate',
  swipe: 'wiTrigger_swipe',
  regenerate: 'wiTrigger_regenerate',
  quiet: 'wiTrigger_quiet',
}

const WI_MATCH_LABELS: Record<(typeof WI_MATCH_SOURCES)[number], StringKey> = {
  matchCharacterDescription: 'wiMatch_matchCharacterDescription',
  matchCharacterPersonality: 'wiMatch_matchCharacterPersonality',
  matchScenario: 'wiMatch_matchScenario',
  matchPersonaDescription: 'wiMatch_matchPersonaDescription',
  matchCharacterDepthPrompt: 'wiMatch_matchCharacterDepthPrompt',
  matchCreatorNotes: 'wiMatch_matchCreatorNotes',
}

/**
 * The six additional matching sources, in upstream's drawer order.
 * `id` is the field's own name on the wire.
 */
const WI_MATCH_SOURCES = [
  'matchCharacterDescription',
  'matchCharacterPersonality',
  'matchScenario',
  'matchPersonaDescription',
  'matchCharacterDepthPrompt',
  'matchCreatorNotes',
] as const

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
 * Render a keys list as removable tags over a comma-aware input.
 *
 * Tags because that is what a keys list is — several independent words — and
 * because upstream's own input is a tag box with a comma-separated plaintext
 * mode beside it. Enter or a comma commits the typed part; a pasted
 * comma-separated list commits whole; Backspace on an empty input takes the
 * last tag back off.
 */
function WiKeysField({ label, keys, onCommit }: {
  label: string
  keys: readonly string[]
  onCommit: (keys: string[]) => void
}): ReactElement {
  useLanguage()
  const [text, setText] = useState('')

  const commit = (): void => {
    const parts = parseKeyList(text)
    if (parts.length === 0) {
      setText('')
      return
    }
    // A key typed twice stores once: the list is a set in the order of first
    // mention, which is what a scanner reading it wants.
    const merged = [...keys]
    for (const part of parts) {
      if (!merged.includes(part)) merged.push(part)
    }
    onCommit(merged)
    setText('')
  }

  return (
    <div className="iris-field">
      <span className="iris-field__label">{label}</span>
      <span className="iris-field__value">{String(keys.length)}</span>
      <div className="iris-tags iris-field__control" role="list" aria-label={label}>
        {keys.map((key, index) => (
          <span key={`${key}:${String(index)}`} className="iris-tags__chip" role="listitem">
            {key}
            <button
              type="button"
              className="iris-tags__x"
              aria-label={t('wiKeyRemove', { key })}
              onClick={() => onCommit(keys.filter((_, at) => at !== index))}
            >×</button>
          </span>
        ))}
        <input
          className="iris-tags__input"
          type="text"
          value={text}
          placeholder={t('wiKeyPlaceholder')}
          aria-label={label}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Backspace' && text === '' && keys.length > 0) {
              onCommit(keys.slice(0, -1))
            }
          }}
          onBlur={commit}
        />
      </div>
    </div>
  )
}

/**
 * Render a small labelled number input whose empty state is a real null.
 *
 * The per-entry numbers are full of honest absences — no sticky, no cooldown,
 * no scan-depth override — and a zero would lie about every one of them, so
 * the empty field is what sends `null`.
 */
function WiNumField({ label, value, onChange, max, note }: {
  label: string
  value: number | null
  onChange: (value: number | null) => void
  max: number
  note?: string
}): ReactElement {
  useLanguage()
  return (
    <div className="iris-field iris-field--tight">
      <span className="iris-field__label">{label}</span>
      <input
        className="iris-text iris-num"
        type="number"
        min={0}
        max={max}
        value={value ?? ''}
        placeholder={t('wiNumUnset')}
        aria-label={label}
        onChange={event => {
          const raw = event.target.value
          onChange(raw === '' ? null : Math.max(0, Math.min(max, Number(raw))))
        }}
      />
      {note === undefined ? null : <span className="iris-field__note">{note}</span>}
    </div>
  )
}

/**
 * Render a three-state override: unset, on, off.
 *
 * `null` is the state the label names — "as the global setting has it" — and
 * it is what every untouched entry in a real book carries, so the option is
 * first and worded as the passthrough it is.
 */
function WiTriStateField({ label, value, onChange }: {
  label: string
  value: boolean | null
  onChange: (value: boolean | null) => void
}): ReactElement {
  useLanguage()
  const options: { id: 'null' | 'true' | 'false', label: string }[] = [
    { id: 'null', label: t('wiOverrideGlobal') },
    { id: 'true', label: t('wiOverrideYes') },
    { id: 'false', label: t('wiOverrideNo') },
  ]
  const active = value === null ? 'null' : value ? 'true' : 'false'
  return (
    <div className="iris-field iris-field--tight">
      <span className="iris-field__label">{label}</span>
      <span />
      <div className="iris-choice iris-field__control" role="group" aria-label={label}>
        {options.map(option => (
          <button
            key={option.id}
            type="button"
            className="iris-choice__option"
            aria-pressed={option.id === active}
            onClick={() => onChange(option.id === 'null' ? null : option.id === 'true')}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Render one labelled text field.
 */
function WiTextField({ label, value, onChange, placeholder }: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}): ReactElement {
  useLanguage()
  return (
    <div className="iris-field iris-field--tight">
      <span className="iris-field__label">{label}</span>
      <span />
      <input
        className="iris-text iris-field__control"
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={event => onChange(event.target.value)}
      />
    </div>
  )
}

/**
 * Render one entry's full field form.
 *
 * Fields are grouped the way upstream's editor groups them — keys and logic,
 * status and placement, content, recursion, timed effects, groups, per-entry
 * overrides, triggers and filters, the match sources — so a reader moving
 * between the two is re-learning nothing. Every control writes straight into
 * the draft via `onPatch`; nothing here talks to the host.
 */
function WiEntryEditor({ entry, onPatch }: {
  entry: WorldbookEntry
  onPatch: (patch: Partial<WorldbookEntry>) => void
}): ReactElement {
  useLanguage()
  const atDepth = entry.position.type === 'at_depth'

  return (
    <div className="iris-entry__editor">
      <WiKeysField
        label={t('wiKeysPrimary')}
        keys={entry.strategy.keys}
        onCommit={keys => onPatch({ strategy: { ...entry.strategy, keys } })}
      />
      <div className="iris-field iris-field--tight">
        <span className="iris-field__label">{t('wiLogic')}</span>
        <span />
        <div className="iris-choice iris-field__control" role="group" aria-label={t('wiLogic')}>
          {WI_LOGICS.map(logic => (
            <button
              key={logic.id}
              type="button"
              className="iris-choice__option"
              aria-pressed={entry.strategy.keys_secondary.logic === logic.id}
              onClick={() => onPatch({
                strategy: {
                  ...entry.strategy,
                  keys_secondary: { ...entry.strategy.keys_secondary, logic: logic.id },
                },
              })}
            >
              {t(logic.labelKey)}
            </button>
          ))}
        </div>
        <span className="iris-field__note">{t('wiLogicNote')}</span>
      </div>
      <WiKeysField
        label={t('wiKeysSecondary')}
        keys={entry.strategy.keys_secondary.keys}
        onCommit={keys => onPatch({
          strategy: { ...entry.strategy, keys_secondary: { ...entry.strategy.keys_secondary, keys } },
        })}
      />

      {/* Status: upstream's three-state selector. */}
      <div className="iris-field iris-field--tight">
        <span className="iris-field__label">{t('wiStrategy')}</span>
        <span />
        <div className="iris-choice iris-field__control" role="group" aria-label={t('wiStrategy')}>
          {WI_STRATEGIES.map(strategy => (
            <button
              key={strategy.id}
              type="button"
              className="iris-choice__option"
              aria-pressed={entry.strategy.type === strategy.id}
              onClick={() => onPatch({ strategy: { ...entry.strategy, type: strategy.id } })}
            >
              {t(strategy.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="iris-field iris-field--tight">
        <span className="iris-field__label">{t('wiPosition')}</span>
        <span />
        <div className="iris-field__control iris-inline">
          <select
            className="iris-select"
            value={entry.position.type}
            aria-label={t('wiPosition')}
            onChange={event => onPatch({ position: { ...entry.position, type: event.target.value as WorldbookEntry['position']['type'] } })}
          >
            {WI_POSITIONS.map(position => (
              <option key={position.type} value={position.type}>{t(position.labelKey)}</option>
            ))}
          </select>
          {atDepth && (
            <select
              className="iris-select"
              value={entry.position.role}
              aria-label={t('wiRole')}
              onChange={event => onPatch({ position: { ...entry.position, role: event.target.value as WorldbookEntry['position']['role'] } })}
            >
              {WI_ROLES.map(role => (
                <option key={role.id} value={role.id}>{t(role.labelKey)}</option>
              ))}
            </select>
          )}
          <label className="iris-inline__pair">
            <span>{t('wiDepth')}</span>
            <input
              className="iris-text iris-num"
              type="number"
              min={0}
              max={9999}
              value={entry.position.depth}
              aria-label={t('wiDepth')}
              onChange={event => onPatch({ position: { ...entry.position, depth: Math.max(0, Math.min(9999, Number(event.target.value) || 0)) } })}
            />
          </label>
          <label className="iris-inline__pair">
            <span>{t('wiOrder')}</span>
            <input
              className="iris-text iris-num"
              type="number"
              min={0}
              max={9999}
              value={entry.position.order}
              aria-label={t('wiOrder')}
              onChange={event => onPatch({ position: { ...entry.position, order: Math.max(0, Math.min(9999, Number(event.target.value) || 0)) } })}
            />
          </label>
        </div>
      </div>

      <div className="iris-field iris-field--tight">
        <span className="iris-field__label">{t('wiProbability')}</span>
        <span className="iris-field__value">{String(entry.probability)}%</span>
        <input
          className="iris-range iris-field__control"
          type="range"
          min={0}
          max={100}
          step={1}
          value={entry.probability}
          aria-label={t('wiProbability')}
          onChange={event => onPatch({ probability: Number(event.target.value) })}
        />
        <div className="iris-field__note iris-inline">
          <ToggleField
            label={t('wiUseProbability')}
            value={entry.useProbability}
            onToggle={next => onPatch({ useProbability: next })}
          />
        </div>
      </div>

      {/* Content: monospace, the way the file stores it. */}
      <div className="iris-field iris-field--tight">
        <span className="iris-field__label">{t('wiContent')}</span>
        <span className="iris-field__value">{t('wiContentLength', { count: entry.content.length })}</span>
        <textarea
          className="iris-textarea iris-field__control"
          rows={8}
          value={entry.content}
          placeholder={t('wiContentPlaceholder')}
          aria-label={t('wiContent')}
          onChange={event => onPatch({ content: event.target.value })}
        />
      </div>

      <WiTextField
        label={t('wiTitle')}
        value={entry.name}
        placeholder={t('wiTitlePlaceholder')}
        onChange={name => onPatch({ name })}
      />

      <div className="iris-inline iris-wi-toggles">
        <ToggleField label={t('wiEnabled')} value={entry.enabled} onToggle={next => onPatch({ enabled: next })} />
        <ToggleField label={t('wiAddMemo')} value={entry.addMemo} onToggle={next => onPatch({ addMemo: next })} />
        <ToggleField label={t('wiIgnoreBudget')} value={entry.ignoreBudget} onToggle={next => onPatch({ ignoreBudget: next })} />
      </div>

      {/* Recursion guards, upstream's trio. */}
      <div className="iris-inline iris-wi-toggles">
        <ToggleField
          label={t('wiExcludeRecursion')}
          note={t('wiExcludeRecursionNote')}
          value={entry.recursion.prevent_incoming}
          onToggle={next => onPatch({ recursion: { ...entry.recursion, prevent_incoming: next } })}
        />
        <ToggleField
          label={t('wiPreventRecursion')}
          note={t('wiPreventRecursionNote')}
          value={entry.recursion.prevent_outgoing}
          onToggle={next => onPatch({ recursion: { ...entry.recursion, prevent_outgoing: next } })}
        />
      </div>
      <WiNumField
        label={t('wiDelayUntilRecursion')}
        note={t('wiDelayUntilRecursionNote')}
        value={entry.recursion.delay_until}
        max={999}
        onChange={delayUntil => onPatch({ recursion: { ...entry.recursion, delay_until: delayUntil } })}
      />

      {/* Timed effects. */}
      <div className="iris-inline iris-wi-toggles">
        <span className="iris-label">{t('wiTimedEffects')}</span>
      </div>
      <div className="iris-wi-columns">
        <WiNumField
          label={t('wiSticky')}
          note={t('wiStickyNote')}
          value={entry.effect.sticky}
          max={999_999}
          onChange={sticky => onPatch({ effect: { ...entry.effect, sticky } })}
        />
        <WiNumField
          label={t('wiCooldown')}
          note={t('wiCooldownNote')}
          value={entry.effect.cooldown}
          max={999_999}
          onChange={cooldown => onPatch({ effect: { ...entry.effect, cooldown } })}
        />
        <WiNumField
          label={t('wiDelay')}
          note={t('wiDelayNote')}
          value={entry.effect.delay}
          max={999_999}
          onChange={delay => onPatch({ effect: { ...entry.effect, delay } })}
        />
      </div>

      {/* Inclusion groups. */}
      <div className="iris-wi-columns">
        <WiTextField
          label={t('wiGroup')}
          value={entry.group}
          placeholder={t('wiGroupPlaceholder')}
          onChange={group => onPatch({ group })}
        />
        <WiNumField
          label={t('wiGroupWeight')}
          value={entry.groupWeight}
          max={999_999}
          onChange={groupWeight => onPatch({ groupWeight: groupWeight ?? 100 })}
        />
      </div>
      <div className="iris-inline iris-wi-toggles">
        <ToggleField label={t('wiGroupOverride')} value={entry.groupOverride} onToggle={next => onPatch({ groupOverride: next })} />
      </div>

      {/* Per-entry overrides. */}
      <div className="iris-inline iris-wi-toggles">
        <span className="iris-label">{t('wiOverrides')}</span>
      </div>
      <div className="iris-wi-columns">
        <WiNumField
          label={t('wiScanDepthOverride')}
          value={entry.strategy.scan_depth === 'same_as_global' ? null : entry.strategy.scan_depth}
          max={1000}
          onChange={scanDepth => onPatch({
            strategy: { ...entry.strategy, scan_depth: scanDepth ?? 'same_as_global' },
          })}
        />
        <WiTextField
          label={t('wiAutomationId')}
          value={entry.automationId}
          placeholder={t('wiAutomationIdPlaceholder')}
          onChange={automationId => onPatch({ automationId })}
        />
        <WiTextField
          label={t('wiOutletName')}
          value={entry.outletName}
          placeholder={t('wiOutletNamePlaceholder')}
          onChange={outletName => onPatch({ outletName })}
        />
      </div>
      <div className="iris-wi-columns">
        <WiTriStateField
          label={t('wiCaseSensitiveOverride')}
          value={entry.caseSensitive}
          onChange={caseSensitive => onPatch({ caseSensitive })}
        />
        <WiTriStateField
          label={t('wiWholeWordsOverride')}
          value={entry.matchWholeWords}
          onChange={matchWholeWords => onPatch({ matchWholeWords })}
        />
        <WiTriStateField
          label={t('wiGroupScoringOverride')}
          value={entry.useGroupScoring}
          onChange={useGroupScoring => onPatch({ useGroupScoring })}
        />
      </div>

      {/* Generation triggers and the character filter. */}
      <div className="iris-field iris-field--tight">
        <span className="iris-field__label">{t('wiTriggers')}</span>
        <span />
        <div className="iris-choice iris-field__control" role="group" aria-label={t('wiTriggers')}>
          {WI_TRIGGERS.map(trigger => {
            const on = entry.triggers.length === 0 || entry.triggers.includes(trigger)
            return (
              <button
                key={trigger}
                type="button"
                className="iris-choice__option"
                aria-pressed={on}
                onClick={() => {
                  // An empty list means "all of them"; toggling one off an
                  // all-inclusive entry produces the five that remain.
                  const next = entry.triggers.length === 0
                    ? WI_TRIGGERS.filter(row => row !== trigger)
                    : entry.triggers.includes(trigger)
                      ? entry.triggers.filter(row => row !== trigger)
                      : [...entry.triggers, trigger]
                  onPatch({ triggers: next })
                }}
              >
                {t(WI_TRIGGER_LABELS[trigger])}
              </button>
            )
          })}
        </div>
        <span className="iris-field__note">{t('wiTriggersNote')}</span>
      </div>

      <div className="iris-wi-columns">
        <WiTextField
          label={t('wiFilterNames')}
          value={formatKeyList(entry.characterFilter.names)}
          placeholder={t('wiFilterListPlaceholder')}
          onChange={text => onPatch({ characterFilter: { ...entry.characterFilter, names: parseKeyList(text) } })}
        />
        <WiTextField
          label={t('wiFilterTags')}
          value={formatKeyList(entry.characterFilter.tags)}
          placeholder={t('wiFilterListPlaceholder')}
          onChange={text => onPatch({ characterFilter: { ...entry.characterFilter, tags: parseKeyList(text) } })}
        />
      </div>
      <div className="iris-inline iris-wi-toggles">
        <ToggleField
          label={t('wiFilterExclude')}
          note={t('wiFilterExcludeNote')}
          value={entry.characterFilter.isExclude}
          onToggle={isExclude => onPatch({ characterFilter: { ...entry.characterFilter, isExclude } })}
        />
      </div>

      {/* Additional matching sources, upstream's folded drawer. */}
      <div className="iris-inline iris-wi-toggles">
        <span className="iris-label">{t('wiMatchSources')}</span>
      </div>
      <div className="iris-wi-columns">
        {WI_MATCH_SOURCES.map(field => (
          <ToggleField
            key={field}
            label={t(WI_MATCH_LABELS[field])}
            value={Boolean(entry[field])}
            onToggle={next => onPatch({ [field]: next })}
          />
        ))}
      </div>
    </div>
  )
}

/** The status dot's class, per activation strategy. */
function dotClass(entry: WorldbookEntry): string {
  if (!entry.enabled) return 'iris-entry__dot--off'
  if (entry.strategy.type === 'constant') return 'iris-entry__dot--constant'
  if (entry.strategy.type === 'vectorized') return 'iris-entry__dot--vectorized'
  return 'iris-entry__dot--normal'
}

/** The row's second line: keys, or the content's opening when there are none. */
function rowHint(entry: WorldbookEntry): string {
  if (entry.strategy.keys.length > 0) return formatKeyList(entry.strategy.keys)
  if (entry.content !== '') return entry.content.replaceAll(/\s+/gu, ' ').slice(0, 120)
  return ''
}

/**
 * Render the entry editor: a book picker, a toolbar, and the book's entries.
 *
 * The draft lives in the store, so this component holds no state about the
 * work itself; its only local state is which rows are expanded and what a
 * guarded leave is waiting on.
 * @returns the editor, or the picker alone when no book is open.
 */
function WorldbookEditor(): ReactElement {
  const worldbooks = useIris(state => state.worldbooks)
  const editor = useIris(state => state.wiEditor)
  const actions = useIrisActions()
  useLanguage()

  const [query, setQuery] = useState('')
  const [sortId, setSortId] = useState<WiSortId>(DEFAULT_WI_SORT)
  const [expanded, setExpanded] = useState<readonly number[]>([])
  const [pending, setPending] = useState<{ action: 'close' } | { action: 'switch', book: string } | undefined>(undefined)

  if (worldbooks === undefined) return <></>

  const dirty = editor !== undefined && isDirty(editor)
  const changed = editor === undefined ? [] : changedUids(editor)

  /**
   * The one gate every leaving path walks through. Closing the editor or
   * switching books with unsaved work on the table asks first — naming the
   * book, because "a book" is not what the reader is about to lose — and the
   * three answers are buttons in this panel rather than a browser dialog the
   * shell cannot style or test.
   */
  const guarded = (action: { action: 'close' } | { action: 'switch', book: string }): void => {
    if (dirty) setPending(action)
    else if (action.action === 'close') actions.closeWiEditor()
    else void actions.openWiEditor(action.book)
  }

  const resolvePending = async (save: boolean | 'cancel'): Promise<void> => {
    const what = pending
    setPending(undefined)
    if (save === 'cancel' || what === undefined) return
    if (save) await actions.saveWiEditor()
    else actions.discardWiEdits()
    if (what.action === 'close') actions.closeWiEditor()
    else void actions.openWiEditor(what.book)
  }

  // Filter, then sort — the same order upstream applies them, and the order
  // that makes the `search` sort's scores meaningful.
  const filtered = editor === undefined ? [] : searchWiEntries(editor.drafts, query)
  const shown = sortWiEntries(
    filtered,
    sortId,
    new Map(filtered.map(entry => [entry.uid, wiSearchScore(entry, query.trim().toLowerCase())])),
  )

  return (
    <div className="iris-field iris-wi-editor">
      <span className="iris-field__label">{t('wiEditorTitle')}</span>
      <span />
      <div className="iris-field__control">
        {worldbooks.names.length === 0
          ? <span className="iris-list__empty">{t('worldbooksEmpty')}</span>
          : (
            <>
              <select
                className="iris-select iris-wi-picker"
                value={editor?.book ?? ''}
                aria-label={t('wiEditorTitle')}
                onChange={event => {
                  if (event.target.value === '' || event.target.value === editor?.book) return
                  guarded({ action: 'switch', book: event.target.value })
                }}
              >
                <option value="" disabled>{t('wiPickBook')}</option>
                {worldbooks.names.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>

              {editor !== undefined && (
                <>
                  {/*
                    The named reminder. It names the book and counts the work,
                    and it stays up until a save or a discard clears it — a
                    dirty flag nobody can see is a save nobody makes.
                  */}
                  {dirty && (
                    <p className="iris-wi-unsaved" role="status">
                      {t('wiUnsavedNamed', { name: editor.book, count: changed.length })}
                    </p>
                  )}

                  {pending !== undefined && (
                    <div className="iris-wi-confirm" role="alertdialog" aria-label={t('wiUnsavedTitle')}>
                      <p>{t('wiUnsavedAsk', { name: editor.book, count: changed.length })}</p>
                      <div className="iris-inline">
                        <button type="button" className="iris-choice__option" onClick={() => void resolvePending(true)}>
                          {t('wiUnsavedSave')}
                        </button>
                        <button type="button" className="iris-choice__option" onClick={() => void resolvePending(false)}>
                          {t('wiUnsavedDiscard')}
                        </button>
                        <button type="button" className="iris-choice__option" onClick={() => void resolvePending('cancel')}>
                          {t('wiUnsavedResume')}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="iris-inline iris-wi-toolbar">
                    <input
                      className="iris-text iris-wi-filter"
                      type="search"
                      value={query}
                      placeholder={t('wiFilterPlaceholder')}
                      aria-label={t('wiFilterPlaceholder')}
                      onChange={event => setQuery(event.target.value)}
                    />
                    <select
                      className="iris-select"
                      value={sortId}
                      aria-label={t('wiSort')}
                      onChange={event => setSortId(event.target.value as WiSortId)}
                    >
                      {WI_SORTS
                        // Upstream keeps the search sort hidden until a filter
                        // term exists, because score-sorting an unfiltered
                        // list is ordering by nothing.
                        .filter(sort => sort.id !== 'search' || query.trim() !== '')
                        .map(sort => (
                          <option key={sort.id} value={sort.id}>{t(WI_SORT_LABELS[sort.id])}</option>
                        ))}
                    </select>
                    <span className="iris-wi-count">{t('wiShownCount', { shown: shown.length, total: editor.drafts.length })}</span>
                    <button type="button" className="iris-choice__option" disabled={!dirty} onClick={() => void actions.saveWiEditor()}>
                      {t('wiSave')}
                    </button>
                    <button type="button" className="iris-choice__option" disabled={!dirty} onClick={() => actions.discardWiEdits()}>
                      {t('wiDiscard')}
                    </button>
                    <button type="button" className="iris-choice__option" onClick={() => void actions.exportWiBackup()}>
                      {t('wiBackup')}
                    </button>
                    <button type="button" className="iris-choice__option" onClick={() => guarded({ action: 'close' })}>
                      {t('wiClose')}
                    </button>
                  </div>

                  <div className="iris-wi-list">
                    {shown.length === 0
                      ? <p className="iris-list__empty">{t('wiFilterEmpty')}</p>
                      : shown.map(entry => {
                        const open = expanded.includes(entry.uid)
                        const changedRow = changed.includes(entry.uid)
                        return (
                          <div key={entry.uid} className={`iris-entry${changedRow ? ' iris-entry--changed' : ''}`}>
                            <div className="iris-entry__head">
                              <button
                                type="button"
                                className="iris-entry__toggle"
                                aria-expanded={open}
                                aria-label={t('wiExpand', { title: entry.name })}
                                onClick={() => setExpanded(open ? expanded.filter(uid => uid !== entry.uid) : [...expanded, entry.uid])}
                              >
                                <span className={`iris-entry__dot ${dotClass(entry)}`} aria-hidden="true" />
                                <span className="iris-entry__title">{entry.name === '' ? t('wiUntitled', { uid: entry.uid }) : entry.name}</span>
                                <span className="iris-entry__hint">{rowHint(entry)}</span>
                                <span className="iris-entry__badges">
                                  <span className="iris-entry__badge">{t('wiBadgeOrder', { order: entry.position.order })}</span>
                                  <span className="iris-entry__badge">{t('wiBadgeProbability', { probability: entry.probability })}</span>
                                  {!entry.enabled && <span className="iris-entry__badge iris-entry__badge--off">{t('wiBadgeDisabled')}</span>}
                                  {entry.strategy.type === 'constant' && <span className="iris-entry__badge">{t('wiBadgeConstant')}</span>}
                                  {changedRow && <span className="iris-entry__badge iris-entry__badge--changed">{t('wiBadgeChanged')}</span>}
                                </span>
                              </button>
                              <div className="iris-entry__switch">
                                <ToggleField
                                  label={t('wiEnabledShort')}
                                  value={entry.enabled}
                                  onToggle={next => actions.patchWiEntry(entry.uid, { enabled: next })}
                                />
                              </div>
                            </div>
                            {open && (
                              <WiEntryEditor
                                entry={entry}
                                onPatch={patch => actions.patchWiEntry(entry.uid, patch)}
                              />
                            )}
                          </div>
                        )
                      })}
                  </div>

                  <p className="iris-field__note">{t('wiEditorNote')}</p>
                </>
              )}
            </>
          )}
      </div>
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
  const characterId = useIris(state => state.view?.characterId)
  const charBooks = useIris(state => state.charBooks)
  const actions = useIrisActions()
  useLanguage()

  useEffect(() => {
    if (worldbooks === undefined) void actions.loadWorldbooks()
  }, [worldbooks, actions])

  // The binding belongs to the open chat's character: fetched on mount and on
  // every character change, so switching conversations shows the new
  // character's binding rather than the previous one's.
  useEffect(() => {
    if (characterId !== undefined) void actions.loadCharBooks()
  }, [characterId, actions])

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

  // The additional bindings as they stand for the character actually open —
  // never the held answer for a different character, which would bind books
  // onto a conversation that never asked for them.
  const charBinding = charBooks !== undefined && charBooks.characterId === characterId
    ? charBooks
    : undefined

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

      {characterId !== undefined && (
        <div className="iris-field">
          <span className="iris-field__label">{t('worldbookCharBind')}</span>
          <span />
          <div className="iris-field__control">
            {/*
              The card's own binding, shown for orientation and deliberately
              not editable here: it lives on the card file, which is shared
              between installations — this panel only writes the host's own
              per-character list.
            */}
            <p className="iris-field__note">
              {charBinding?.primary !== null && charBinding?.primary !== undefined
                ? t('worldbookCharPrimary', { name: charBinding.primary })
                : t('worldbookCharPrimaryNone')}
            </p>
            <div className="iris-choice" role="group" aria-label={t('worldbookCharBind')}>
              {worldbooks.names.length === 0
                ? <span className="iris-list__empty">{t('worldbooksEmpty')}</span>
                : worldbooks.names.map(name => {
                  const bound = charBinding?.additional.includes(name) ?? false
                  return (
                    <button
                      key={name}
                      type="button"
                      className="iris-choice__option"
                      aria-pressed={bound}
                      onClick={() =>
                        void actions.setCharBooks(
                          bound
                            ? charBinding?.additional.filter(row => row !== name) ?? []
                            : [...charBinding?.additional ?? [], name],
                        )}
                    >
                      {name}
                    </button>
                  )
                })}
            </div>
            {/*
              Honest about the two boundaries of the feature: a chat resolves
              its books when it opens, and the list is stored with the profile
              rather than written into the card file.
            */}
            <p className="iris-field__note">{t('worldbookCharNote')}</p>
          </div>
        </div>
      )}

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

      {/*
        The entry editor, below the scan settings on purpose: it edits one
        book's contents, and everything above it edits how every book is
        scanned. A save writes entries and nothing else — the bindings above
        and the settings between are untouched, which is what keeps the editor
        from being able to disturb the multi-book wiring.
      */}
      <WorldbookEditor />
    </CollapsibleSection>
  )
}
