/**
 * The world books panel: this card's book, its extras, the global selection,
 * the scan settings, and the entry editor.
 *
 * **Grouped by whose a book is, and that ordering is the panel's answer to a
 * measured complaint.** It used to open with a flat multi-select of every book
 * in the installation and mention the open card's own binding as a note
 * underneath. On a real profile — nine books, one of them the 140-entry copy
 * the host had materialised out of the open card under a name matching neither
 * the card nor the card's binding — the reader's conclusion was that their
 * card's world book was not there at all. So the card's own book comes first
 * and says how big it is and where it came from, its extras follow, and the
 * rest of the disk is folded away behind a count.
 *
 * **The host's selection rule is untouched.** `@iris/app-service/worldbooks`
 * chooses — bound book, else the embedded copy, never both — and *adds* the
 * globally selected books on top. This panel renders that; what it now also
 * does is **say** it, in `worldbookCardRule`, because a mechanism nobody can
 * see is a mechanism nobody believes. Where Iris parts from SillyTavern here is
 * the grouping only, and that is written down as entry 48 of `DEVIATIONS.md`.
 *
 * The scan settings are the mechanism-grade half — the things that change what
 * every prompt contains. The entry editor, added on top of them, is the
 * fine-grained half: one named book's entries, listed, filtered, sorted, and
 * editable field by field, from the primary keys down to the per-entry scan
 * overrides.
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

import type {
  CardWorldbookView,
  CharacterSummary,
  InsertionStrategy,
  WorldbookEntry,
  WorldbookSettingsView,
  WorldbookSummary,
} from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { bookOwner } from '../client/store.ts'
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

/**
 * Render the open card's own book: which one, how big, and where from.
 *
 * **The panel's first section, and the reorganisation's whole point.** It used
 * to be a `worldbookCharPrimary` note buried under a flat multi-select of every
 * book the installation has. Measured on a real profile: a card embedding 140
 * entries, a book on disk called
 * `【Sgw】『普通』和『理所当然』是什么呢 2.3（好感度x10版）` — the materialised copy,
 * under neither the card's name nor the card's own binding — and eight
 * strangers laid out beside it in one row. The user's report was "I don't see
 * this card's world book in there", and they were right: nothing on screen
 * connected the card to the book.
 *
 * Three states, and each of them is a real shape rather than a defensive
 * branch: a book with a file (every card that has been played), the card's own
 * embedded entries with no file yet (a card that has never been opened here),
 * and nothing at all (a plain V1 card — 2 of the corpus's 19).
 *
 * The rule sentence under it is the second half of the report: "the world book
 * settings should bind each conversation's own book first, not be polluted by
 * other books". The host already works that way — `worldbooks.ts`' choose,
 * never combine — and the panel simply never said so.
 * @param props.characterId - the open conversation's character, if any.
 * @param props.card - the host's answer for that character, when it keeps books.
 * @param props.primary - what the card file itself binds, for the minted note.
 * @returns the section.
 */
function CardWorldbook({ characterId, card, primary }: {
  characterId: string | undefined
  card: CardWorldbookView | undefined
  primary: string | null | undefined
}): ReactElement {
  useLanguage()

  const counted = card !== undefined && card.source !== 'none'

  return (
    <div className="iris-field iris-wb-card">
      <span className="iris-field__label">{t('worldbookThisCard')}</span>
      <span className="iris-field__value">
        {counted ? t('worldbookEntryCount', { count: card.entryCount }) : ''}
      </span>
      <div className="iris-field__control">
        {characterId === undefined
          ? <p className="iris-list__empty">{t('worldbookNoChat')}</p>
          : card === undefined
            ? (
              <>
                {/*
                  A host with no book store cannot say which book plays, so the
                  only knowable fact is what the card file itself binds — which
                  is exactly what this panel showed before the section existed.
                */}
                <p className="iris-list__empty">{t('worldbookCardNotLoaded')}</p>
                <p className="iris-field__note">
                  {primary === null || primary === undefined
                    ? t('worldbookCharPrimaryNone')
                    : t('worldbookCharPrimary', { name: primary })}
                </p>
              </>
            )
            : (
              <>
                {card.source === 'none'
                  ? <p className="iris-list__empty">{t('worldbookCardNone')}</p>
                  : (
                    <p className="iris-wb-card__name">
                      <span className="iris-wb-card__title">
                        {card.name ?? t('worldbookCardEmbeddedUnnamed')}
                      </span>
                      <span className="iris-entry__badge">
                        {card.source === 'named'
                          ? t('worldbookCardSourceNamed')
                          : t('worldbookCardSourceEmbedded')}
                      </span>
                    </p>
                  )}
                {/*
                  Said only when the name on screen is not the name on the card.
                  A materialisation that got the name it asked for is invisible
                  to the reader and should stay that way; this note exists for
                  the collision, which is the case that makes the panel look
                  like it is showing somebody else's book.
                */}
                {card.materialised && primary !== null && primary !== undefined && (
                  <p className="iris-field__note">{t('worldbookCardMinted', { wanted: primary })}</p>
                )}
                <p className="iris-field__note">{t('worldbookCardRule')}</p>
              </>
            )}
      </div>
    </div>
  )
}

/** One book as a row: its name, its size, and whose card it is. */
function BookRow({ name, count, owner, on, onToggle }: {
  name: string
  count: number | undefined
  owner: string | undefined
  on: boolean
  onToggle: () => void
}): ReactElement {
  useLanguage()
  return (
    <button
      type="button"
      className="iris-choice__option iris-wb-book"
      aria-pressed={on}
      onClick={onToggle}
    >
      <span className="iris-wb-book__name">{name}</span>
      {/*
        Absent rather than zero when the host could not parse the file: a book
        it could not read and a book the user emptied are different repairs, and
        `worldbook.names` keeps them apart deliberately.
      */}
      {count === undefined ? null : <span className="iris-entry__badge">{t('worldbookEntryCount', { count })}</span>}
      {owner === undefined ? null : <span className="iris-entry__badge">{t('worldbookFromCard', { name: owner })}</span>}
    </button>
  )
}

/**
 * Render the global selection: what is on, always; everything else, folded.
 *
 * **Folded by default, and that is the answer to "as cards pile up the books
 * pile up and this layout squeezes them against each other".** What a reader
 * needs in view is their own card's book and the handful that are switched on
 * for every chat; the rest of the disk is a chooser they open when they are
 * choosing. Nine books flat was already crowded, and the corpus profile this
 * was measured on has eighteen.
 *
 * `useState`, not `CollapsibleSection`: that component's open state is keyed by
 * `CardId` and persisted per drawer card, and this is a section *inside* one of
 * those cards. Local, so it also reverts to folded on the next drawer visit —
 * which is the behaviour wanted here, unlike a drawer card the reader has
 * deliberately pinned open.
 * @param props.worldbooks - names, selection and counts as last fetched.
 * @param props.bindings - the bindings the client knows, for ownership labels.
 * @param props.characters - the library, for turning an owner id into a name.
 * @param props.onSelect - called with the whole next selection.
 * @returns the section.
 */
function GlobalBooks({ worldbooks, bindings, characters, onSelect }: {
  worldbooks: { names: string[], globalSelect: string[], books: WorldbookSummary[] }
  bindings: readonly { characterId: string, primary: string | null }[]
  characters: readonly CharacterSummary[]
  onSelect: (names: readonly string[]) => void
}): ReactElement {
  useLanguage()
  const [open, setOpen] = useState(false)

  const counts = new Map(worldbooks.books.map(book => [book.name, book.entryCount]))
  // The selection in the order the host stores it — that is the order the user
  // built — and everything else by name, which is the only order a chooser of
  // eighteen strangers can be scanned in.
  const on = worldbooks.globalSelect.filter(name => worldbooks.names.includes(name))
  const off = worldbooks.names
    .filter(name => !worldbooks.globalSelect.includes(name))
    // `.sort` on the array `.filter` just made, not `toSorted`: it is the
    // project's idiom, it mutates nothing the caller can see, and it does not
    // ask the browser for an ES2023 method this build does not downlevel.
    .sort((left, right) => left.localeCompare(right))

  const row = (name: string, selected: boolean): ReactElement => (
    <BookRow
      key={name}
      name={name}
      count={counts.get(name)}
      owner={bookOwner(name, worldbooks.books, bindings, characters)}
      on={selected}
      onToggle={() =>
        onSelect(
          selected
            ? worldbooks.globalSelect.filter(other => other !== name)
            : [...worldbooks.globalSelect, name],
        )}
    />
  )

  return (
    <div className="iris-field iris-wb-global">
      <span className="iris-field__label">{t('worldbookGlobalHead')}</span>
      <span className="iris-field__value">
        {t('worldbookGlobalCount', { count: on.length, total: worldbooks.names.length })}
      </span>
      <div className="iris-field__control">
        {worldbooks.names.length === 0
          ? <span className="iris-list__empty">{t('worldbooksEmpty')}</span>
          : (
            <>
              {on.length === 0
                ? <p className="iris-list__empty">{t('worldbookGlobalNone')}</p>
                : (
                  <div className="iris-choice iris-wb-books" role="group" aria-label={t('worldbookGlobalSelect')}>
                    {on.map(name => row(name, true))}
                  </div>
                )}
              {off.length > 0 && (
                <>
                  <button
                    type="button"
                    className="iris-wb-more"
                    aria-expanded={open}
                    aria-controls="iris-wb-offlist"
                    onClick={() => setOpen(!open)}
                  >
                    {open ? t('worldbookGlobalCollapse') : t('worldbookGlobalExpand', { total: worldbooks.names.length })}
                  </button>
                  <div
                    id="iris-wb-offlist"
                    className="iris-choice iris-wb-books"
                    role="group"
                    aria-label={t('worldbookGlobalSelect')}
                    hidden={!open}
                  >
                    {off.map(name => row(name, false))}
                  </div>
                </>
              )}
            </>
          )}
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
  // The library, read only to turn an owner's character id into a name. The
  // host answers ids on purpose — resolving names there would decode every
  // card, which the corpus measures at about two seconds for nineteen — and
  // this store already holds the listing.
  const characters = useIris(state => state.characters)
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

  /*
   * The bindings `bookOwner` may match a book's name against.
   *
   * One entry, because the client fetches one binding — the open chat's
   * character. That is the section's coverage limit and it is stated on
   * `bookOwner`: a book bound by hand to a card that is not open goes
   * unlabelled. The strong rule (what this host materialised, and from which
   * card) does not depend on this list and covers every book on disk.
   */
  const bindings = charBinding === undefined
    ? []
    : [{ characterId: charBinding.characterId, primary: charBinding.primary }]

  return (
    <CollapsibleSection
      id="worldbooks"
      title={t('sectionWorldbooks')}
      summary={t('worldbookSummary', { count: selected, total: worldbooks.names.length })}
    >
      {/*
        This card first, then this card's extras, then the global list folded.
        The old order was the reverse — every book in the installation flat at
        the top, the card's own binding as a note below it — and it is what the
        report was about: with nine books there was no way to tell which one was
        the open card's, and the panel never said that a chat plays its own
        card's book and nothing else's.

        Nothing about the host's selection rule changed. `worldbooks.ts` still
        chooses (bound book, else embedded) and still *adds* the global list;
        this is the same facts, grouped by whose they are.
      */}
      <CardWorldbook
        characterId={characterId}
        card={charBinding?.card}
        primary={charBinding?.primary}
      />

      {characterId !== undefined && (
        <div className="iris-field">
          <span className="iris-field__label">{t('worldbookCharBind')}</span>
          <span className="iris-field__value">
            {t('worldbookCharBindCount', {
              count: charBinding?.additional.length ?? 0,
              total: worldbooks.names.length,
            })}
          </span>
          <div className="iris-field__control">
            {/*
              The extra bindings, and only those: the card's own binding is the
              section above, and it is deliberately not editable — it lives on
              the card file, which is shared between installations, while this
              list is the host's own per-character one.

              One book per line, with its count and its owner, for the same
              reason the global list is: this control also offered every book in
              the installation as one horizontal row, and on an eighteen-book
              profile that row is the squeeze the report was about. What is
              editable is unchanged, and nothing is hidden here — the whole list
              stays open, because binding an extra book is a deliberate act on
              a short list, not a chooser someone scrolls.
            */}
            <div className="iris-choice iris-wb-books" role="group" aria-label={t('worldbookCharBind')}>
              {worldbooks.names.length === 0
                ? <span className="iris-list__empty">{t('worldbooksEmpty')}</span>
                : worldbooks.names.map(name => {
                  const bound = charBinding?.additional.includes(name) ?? false
                  return (
                    <BookRow
                      key={name}
                      name={name}
                      count={worldbooks.books.find(book => book.name === name)?.entryCount}
                      owner={bookOwner(name, worldbooks.books, bindings, characters)}
                      on={bound}
                      onToggle={() =>
                        void actions.setCharBooks(
                          bound
                            ? charBinding?.additional.filter(row => row !== name) ?? []
                            : [...charBinding?.additional ?? [], name],
                        )}
                    />
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

      <GlobalBooks
        worldbooks={worldbooks}
        bindings={bindings}
        characters={characters}
        onSelect={names => void actions.setGlobalSelect(names)}
      />

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
