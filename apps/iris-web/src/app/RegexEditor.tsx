/**
 * The regex rule editor.
 *
 * SillyTavern's `editor.html`, field for field, because this is the half of the
 * regex feature Iris did not have: the panel could import, toggle, reorder,
 * export and delete, and a user who wanted to change one character of a
 * pattern had to go back to an install to do it.
 *
 * Two departures from upstream's form, both deliberate.
 *
 * It has **no test panel**. Upstream's runs the rule with every gate disabled —
 * no placement, no depth, no ephemerality — so it answers a question the user
 * did not ask ("would this pattern match this text, ignoring everything that
 * decides whether it runs") and the four combinations in `regexDraftProblems`
 * all pass it. A control that says "works" about a rule that will never fire is
 * worse than no control.
 *
 * And it **says what a rule would fail to do** before the rule is saved. Two of
 * those four sentences upstream shows as toasts after the save; the other two it
 * states only in a tooltip and in nothing at all, and one of them is pre-made by
 * upstream's own defaults. See `regexDraftProblems` for the derivation.
 *
 * @module iris-web/app/RegexEditor
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { RegexScriptView } from '@iris/protocol'

import {
  applyDraft,
  draftOf,
  emptyDraft,
  PLACEMENT_CHOICES,
  regexDraftProblems,
  SUBSTITUTE_CHOICES,
  type RegexDraft,
} from './regex-editor.ts'
import { useLanguage, t } from './i18n/use-language.ts'
import type { StringKey } from './i18n/strings.ts'

/** The i18n key naming each placement, by upstream's number. */
const PLACEMENT_LABELS: Record<number, StringKey> = {
  1: 'regexPlaceUser',
  2: 'regexPlaceAi',
  3: 'regexPlaceSlash',
  5: 'regexPlaceWorldInfo',
  6: 'regexPlaceReasoning',
}

/** The i18n key naming each macro mode, by upstream's number. */
const SUBSTITUTE_LABELS: Record<number, StringKey> = {
  0: 'regexMacroNone',
  1: 'regexMacroRaw',
  2: 'regexMacroEscaped',
}

/** The i18n key naming each thing a draft can be wrong about. */
const PROBLEM_LABELS = {
  noPlacement: 'regexProblemNoPlacement',
  noPattern: 'regexProblemNoPattern',
  worldInfoNeedsPrompt: 'regexProblemWorldInfo',
  slashNeedsNeither: 'regexProblemSlash',
} as const satisfies Record<string, StringKey>

/**
 * Render the editor for one rule.
 * @param props.script - the rule being edited, or undefined for a new one.
 * @param props.busy - whether a write is already in flight.
 * @param props.onSave - called with the rule to store. The caller owns the
 *   write, because a scoped rule and a global one are stored by different
 *   methods and this form does not need to know which it is filling.
 * @param props.onCancel - called when the reader abandons the edit.
 * @returns the form.
 */
export function RegexEditor({
  script,
  busy,
  onSave,
  onCancel,
}: {
  script?: RegexScriptView | undefined
  busy?: boolean
  onSave: (next: RegexScriptView) => void
  onCancel: () => void
}): ReactElement {
  // Seeded once. A form re-seeded from its prop on every render would discard
  // what the user is typing the moment anything else in the panel re-rendered.
  const [draft, setDraft] = useState<RegexDraft>(() =>
    script === undefined ? emptyDraft() : draftOf(script))
  // Subscribed so a language switch re-renders the form's words.
  useLanguage()

  const patch = (fields: Partial<RegexDraft>): void => {
    setDraft(previous => ({ ...previous, ...fields }))
  }
  const togglePlacement = (place: number, on: boolean): void => {
    patch({
      placement: on
        ? [...draft.placement, place].sort((left, right) => left - right)
        : draft.placement.filter(entry => entry !== place),
    })
  }

  const problems = regexDraftProblems(draft)
  const named = draft.scriptName.trim().length > 0

  return (
    <div className="iris-regex__editor">
      <label className="iris-field iris-regex__field">
        <span className="iris-field__label">{t('regexFieldName')}</span>
        <input
          className="iris-text iris-field__control"
          type="text"
          value={draft.scriptName}
          onChange={event => patch({ scriptName: event.target.value })}
        />
      </label>

      <label className="iris-field iris-regex__field">
        <span className="iris-field__label">{t('regexFieldFind')}</span>
        <input
          className="iris-text iris-field__control iris-regex__mono"
          type="text"
          value={draft.findRegex}
          onChange={event => patch({ findRegex: event.target.value })}
        />
      </label>
      <p className="iris-field__note">{t('regexFieldFindNote')}</p>

      <label className="iris-field iris-regex__field">
        <span className="iris-field__label">{t('regexFieldReplace')}</span>
        <textarea
          className="iris-text iris-field__control iris-regex__mono"
          rows={3}
          value={draft.replaceString}
          placeholder={t('regexFieldReplacePlaceholder')}
          onChange={event => patch({ replaceString: event.target.value })}
        />
      </label>

      <label className="iris-field iris-regex__field">
        <span className="iris-field__label">{t('regexFieldTrim')}</span>
        <textarea
          className="iris-text iris-field__control iris-regex__mono"
          rows={2}
          value={draft.trimStrings}
          placeholder={t('regexFieldTrimPlaceholder')}
          onChange={event => patch({ trimStrings: event.target.value })}
        />
      </label>

      <fieldset className="iris-regex__group">
        <legend className="iris-field__label">{t('regexFieldAffects')}</legend>
        {PLACEMENT_CHOICES.map(place => (
          <label className="iris-regex__check" key={place}>
            <input
              type="checkbox"
              checked={draft.placement.includes(place)}
              onChange={event => togglePlacement(place, event.target.checked)}
            />
            <span>{t(PLACEMENT_LABELS[place] ?? 'regexPlaceUser')}</span>
          </label>
        ))}
      </fieldset>

      {/*
        Upstream's "Ephemerality", worded by consequence rather than by field
        name. The names it stores are `markdownOnly` and `promptOnly`, which
        say nothing about the thing a reader is choosing: whether the chat file
        on disk changes.
      */}
      <fieldset className="iris-regex__group">
        <legend className="iris-field__label">{t('regexFieldWhere')}</legend>
        <label className="iris-regex__check">
          <input
            type="checkbox"
            checked={draft.markdownOnly}
            onChange={event => patch({ markdownOnly: event.target.checked })}
          />
          <span>{t('regexAlterDisplay')}</span>
        </label>
        <label className="iris-regex__check">
          <input
            type="checkbox"
            checked={draft.promptOnly}
            onChange={event => patch({ promptOnly: event.target.checked })}
          />
          <span>{t('regexAlterPrompt')}</span>
        </label>
        <p className="iris-field__note">
          {draft.markdownOnly || draft.promptOnly ? t('regexEphemeralNote') : t('regexPermanentNote')}
        </p>
      </fieldset>

      <fieldset className="iris-regex__group">
        <legend className="iris-field__label">{t('regexFieldOther')}</legend>
        <label className="iris-regex__check">
          <input
            type="checkbox"
            checked={draft.runOnEdit}
            onChange={event => patch({ runOnEdit: event.target.checked })}
          />
          <span>{t('regexRunOnEdit')}</span>
        </label>
        <label className="iris-regex__check">
          <input
            type="checkbox"
            checked={draft.disabled}
            onChange={event => patch({ disabled: event.target.checked })}
          />
          <span>{t('regexDisabledField')}</span>
        </label>
      </fieldset>

      <label className="iris-field iris-regex__field">
        <span className="iris-field__label">{t('regexFieldMacros')}</span>
        <select
          className="iris-text iris-field__control"
          value={String(draft.substituteRegex)}
          onChange={event => patch({ substituteRegex: Number(event.target.value) })}
        >
          {SUBSTITUTE_CHOICES.map(mode => (
            <option value={String(mode)} key={mode}>
              {t(SUBSTITUTE_LABELS[mode] ?? 'regexMacroNone')}
            </option>
          ))}
        </select>
      </label>

      <div className="iris-regex__depths">
        <label className="iris-field iris-regex__field">
          <span className="iris-field__label">{t('regexFieldMinDepth')}</span>
          <input
            className="iris-text iris-field__control"
            type="number"
            min={-1}
            max={9999}
            value={draft.minDepth}
            placeholder={t('regexDepthUnlimited')}
            onChange={event => patch({ minDepth: event.target.value })}
          />
        </label>
        <label className="iris-field iris-regex__field">
          <span className="iris-field__label">{t('regexFieldMaxDepth')}</span>
          <input
            className="iris-text iris-field__control"
            type="number"
            min={0}
            max={9999}
            value={draft.maxDepth}
            placeholder={t('regexDepthUnlimited')}
            onChange={event => patch({ maxDepth: event.target.value })}
          />
        </label>
      </div>
      <p className="iris-field__note">{t('regexDepthNote')}</p>

      {/*
        Shown before the save, not after it. These are not validation — the rule
        saves either way, as upstream's does — they are the sentences that turn
        "my regex does nothing" into a five-second fix.
      */}
      {problems.length === 0 ? null : (
        <div className="iris-regex__problems">
          {problems.map(problem => (
            <p className="iris-field__note iris-regex__problem" key={problem}>
              {t(PROBLEM_LABELS[problem])}
            </p>
          ))}
        </div>
      )}

      <div className="iris-regex__editor-actions">
        <Button
          size="sm"
          disabled={busy === true || !named}
          onClick={() => onSave(applyDraft(script ?? {}, draft))}
        >
          {t('save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Button>
        {named ? null : <span className="iris-field__note">{t('regexNameRequired')}</span>}
      </div>
    </div>
  )
}
