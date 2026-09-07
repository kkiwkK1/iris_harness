/**
 * The editor for one of the user's own scripts.
 *
 * TavernHelper's `ScriptEditor.vue` reduced to the fields it actually stores:
 * a name, a body, the author's notes, and the button table. Read from the
 * 酒馆助手 4.9.1 source on this machine rather than from documentation — the
 * form's own schema is `panel/script/type.ts:3-13`, and the stored shape it
 * parses into is `type/scripts.ts:18-33`.
 *
 * **Two of upstream's fields have no control here, and both are round-tripped
 * rather than dropped.** `data` is the script's variable table, and this host
 * keeps script variables in a file of its own rather than in the document the
 * user shares — so a table imported with a script is preserved and is not
 * presented as something to hand-edit. `export_with` is the author's choice
 * about their own export and travels the same way. A save writes the stored
 * record with these fields intact; see `ScriptLibraryStore.save`.
 *
 * **What this form does not do is switch the script on.** Upstream's default is
 * `enabled: false` (`type/scripts.ts:20`) and its importer forces it again
 * (`panel/script/Toolbar.vue:95`); a script does not begin executing because
 * someone pressed Save, and the panel's own switch is one deliberate click
 * away.
 *
 * @module iris-web/app/ScriptEditor
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { UserScript } from '@iris/protocol'

import type { UserScriptDraft } from '../client/store.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/** One button row as the form holds it. */
interface ButtonDraft {
  name: string
  visible: boolean
}

/**
 * Render the editor for one script.
 * @param props.script - the script being edited, whole, or undefined for a new
 *   one. Whole rather than a listing row, because the body is the point.
 * @param props.busy - whether a write is already in flight.
 * @param props.onSave - called with the draft to store.
 * @param props.onCancel - called when the reader abandons the edit.
 * @returns the form.
 */
export function ScriptEditor({
  script,
  busy,
  onSave,
  onCancel,
}: {
  script?: UserScript | undefined
  busy?: boolean
  onSave: (draft: UserScriptDraft) => void
  onCancel: () => void
}): ReactElement {
  // Seeded once, so nothing the reader has typed is lost when the panel around
  // it re-renders.
  const [name, setName] = useState(script?.name ?? '')
  const [content, setContent] = useState(script?.content ?? '')
  const [info, setInfo] = useState(script?.info ?? '')
  const [buttons, setButtons] = useState<ButtonDraft[]>(
    () => (script?.button?.buttons ?? []).map(button => ({ ...button })))
  const [buttonsEnabled, setButtonsEnabled] = useState(script?.button?.enabled ?? true)
  // Subscribed so a language switch re-renders the form's words.
  useLanguage()

  const named = name.trim().length > 0
  const bytes = new TextEncoder().encode(content).length

  const save = (): void => {
    onSave({
      ...script === undefined ? {} : { id: script.id },
      name: name.trim(),
      content,
      // Written as an empty string rather than omitted when the reader clears
      // it: omitting would leave the previous note in place, because a save
      // merges onto the stored record.
      info,
      button: {
        enabled: buttonsEnabled,
        // Blank names dropped. A button with no name has no event to fire —
        // upstream keys its listener on `scriptId + hash(name)` — so it would
        // render as an unlabelled control that does nothing.
        buttons: buttons.filter(button => button.name.trim() !== '')
          .map(button => ({ name: button.name.trim(), visible: button.visible })),
      },
    })
  }

  return (
    <div className="iris-library__editor">
      <label className="iris-field iris-regex__field">
        <span className="iris-field__label">{t('libraryFieldName')}</span>
        <input
          className="iris-text iris-field__control"
          type="text"
          value={name}
          onChange={event => setName(event.target.value)}
        />
      </label>

      <label className="iris-field iris-regex__field">
        <span className="iris-field__label">{t('libraryFieldInfo')}</span>
        <input
          className="iris-text iris-field__control"
          type="text"
          value={info}
          placeholder={t('libraryFieldInfoPlaceholder')}
          onChange={event => setInfo(event.target.value)}
        />
      </label>

      <label className="iris-field iris-regex__field">
        <span className="iris-field__label">{t('libraryFieldContent')}</span>
        <textarea
          className="iris-text iris-field__control iris-regex__mono iris-library__body"
          rows={10}
          value={content}
          placeholder={t('libraryFieldContentPlaceholder')}
          onChange={event => setContent(event.target.value)}
        />
      </label>
      {/*
        The size, live, because it is the same number the consent question and
        the listing quote — and because the person typing here is the person who
        will later be asked whether to run this much code.
      */}
      <p className="iris-field__note">{t('libraryBodyBytes', { n: bytes })}</p>

      <fieldset className="iris-regex__group">
        <legend className="iris-field__label">{t('libraryFieldButtons')}</legend>
        <label className="iris-regex__check">
          <input
            type="checkbox"
            checked={buttonsEnabled}
            onChange={event => setButtonsEnabled(event.target.checked)}
          />
          <span>{t('libraryButtonsEnabled')}</span>
        </label>
        {buttons.map((button, index) => (
          // Keyed by position, which is the only identity upstream's format
          // stores: a button carries no id, and `buttons[i]` is the whole
          // handle. Names are not unique — one corpus card ships two scripts
          // each offering a 打开状态栏 — so keying by name would collapse rows.
          <div className="iris-library__button" key={index}>
            <input
              className="iris-text"
              type="text"
              value={button.name}
              aria-label={t('libraryButtonName', { n: index + 1 })}
              onChange={event => setButtons(previous => previous.map((row, at) =>
                (at === index ? { ...row, name: event.target.value } : row)))}
            />
            <label className="iris-regex__check">
              <input
                type="checkbox"
                checked={button.visible}
                onChange={event => setButtons(previous => previous.map((row, at) =>
                  (at === index ? { ...row, visible: event.target.checked } : row)))}
              />
              <span>{t('libraryButtonVisible')}</span>
            </label>
            <button
              type="button"
              className="iris-act iris-act--danger"
              aria-label={t('libraryButtonRemove', { n: index + 1 })}
              onClick={() => setButtons(previous => previous.filter((_row, at) => at !== index))}
            >
              {t('delete')}
            </button>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setButtons(previous => [...previous, { name: '', visible: true }])}
        >
          {t('libraryAddButton')}
        </Button>
        <p className="iris-field__note">{t('libraryButtonsNote')}</p>
      </fieldset>

      <div className="iris-regex__editor-actions">
        <Button size="sm" disabled={busy === true || !named} onClick={save}>
          {t('save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <span className="iris-field__note">
          {named ? t('libraryArrivesOff') : t('libraryNameRequired')}
        </span>
      </div>
    </div>
  )
}
