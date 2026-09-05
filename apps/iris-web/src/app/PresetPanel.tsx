/**
 * The preset library and the prompt manager.
 *
 * Two instruments in one section, because they answer one question — "what does
 * the model actually get asked?" — from its two ends. The library half switches
 * which preset runs and moves files in and out of the profile's folder; the
 * manager half edits the active preset's prompt list in place, in the order the
 * assembler reads it. Upstream splits them across a dropdown and a modal
 * (`PromptManager.js`); here they sit together because a switch without the
 * manager is a switch the reader cannot inspect, and the manager without the
 * library edits a body the reader cannot change.
 *
 * Rendered inside the settings drawer, under the connection section: a preset
 * is the largest single input to what a conversation says, and it is the one
 * the drawer previously had no view of at all.
 *
 * @module iris-web/app/PresetPanel
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Section } from './fields.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import { toBase64 } from './format.ts'

/**
 * One hand-carried file's outcome, kept until the next import — the shape the
 * store's `importPresetFiles` answers, flattened for the report list.
 */
type FileOutcome =
  | { name: string, kind: 'imported', overwritten: boolean, sensitive: readonly string[] }
  | { name: string, kind: 'refused', reason: 'invalid-json' | 'not-a-preset' | 'unusable-name' }

/**
 * The sentence one outcome renders as — the named part after "{name} — ".
 * Kept out of the JSX so the three-way refusal mapping reads as the table it is.
 */
function outcomeNote(row: FileOutcome): string {
  if (row.kind === 'refused') {
    return row.reason === 'invalid-json' ? t('presetFileInvalidJson')
      : row.reason === 'not-a-preset' ? t('presetFileNotAPreset')
      : t('presetFileUnusableName')
  }
  const note = row.overwritten ? t('presetFileOverwrote') : t('presetFileImported')
  // The safety-relevant half of the sentence never yields to the bookkeeping
  // half: a file that carried a proxy password is said in the same breath as
  // whether it replaced something.
  return row.sensitive.length === 0 ? note
    : `${note} ${t('presetFileSensitive', { fields: row.sensitive.join(', ') })}`
}

/**
 * Render the preset section.
 *
 * Returns nothing when the host keeps no preset library: the store's
 * `presets === undefined` is that refusal, and a section of dead controls would
 * read as breakage rather than absence.
 * @returns the section, or nothing.
 */
export function PresetPanel(): ReactElement | null {
  const presets = useIris(state => state.presets)
  const active = useIris(state => state.activePreset)
  const install = useIris(state => state.presetInstall)
  const manager = useIris(state => state.presetManager)
  const actions = useIrisActions()
  // Subscribed so a language switch re-renders the panel's words.
  useLanguage()

  // The save-as editor, open only while naming — the ConnectionPanel's pattern.
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  // The last import's skips, kept until the next import or rename: a skipped
  // name that vanishes when the notice expires is a skipped name unexplained.
  const [skipped, setSkipped] = useState<readonly { name: string, reason: string }[]>([])
  // The last file import's per-file outcomes, same memory rule as `skipped` —
  // one "last import" story between the two arms, whichever ran last.
  const [fileOutcomes, setFileOutcomes] = useState<readonly FileOutcome[]>([])
  // The hidden picker behind the import button — the Sidebar's foot pattern.
  const filePicker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void actions.loadPresets()
  }, [actions])

  // A preset restored from a previous run is active before any manager call has
  // ever been made; its ordering is one read away and the section is where the
  // reader expects to see it.
  useEffect(() => {
    if (active !== undefined && manager === undefined) void actions.viewManager()
  }, [active, manager, actions])

  if (presets === undefined) return null

  const saveAs = (): void => {
    const named = name.trim()
    if (named === '') return
    setNaming(false)
    setName('')
    void actions.savePreset(named)
  }

  // The hand-carried import: the browser reads each picked file (upstream's
  // `onPresetImportFileChange` does the same in `openai.js`), the host parses
  // and files it, and every file answers on its own — one bad body must not
  // veto the folder, the `importChats` rule.
  const importFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return
    setSkipped([])
    const payload = await Promise.all(
      files.map(async file => ({ filename: file.name, base64: await toBase64(file) })),
    )
    const answer = await actions.importPresetFiles(payload)
    setFileOutcomes([
      ...answer.imported.map(row => ({ ...row, kind: 'imported' as const })),
      ...answer.refused.map(row => ({ ...row, kind: 'refused' as const })),
    ])
  }

  return (
    <Section title={t('sectionPresets')}>
      <p className="iris-field__note">
        {t('presetActive')}: <span className="iris-preset__active">{active ?? t('hostDefault')}</span>
      </p>

      {presets.length === 0 ? (
        <p className="iris-list__empty">{t('presetImportNone')}</p>
      ) : (
        presets.map(preset => (
          <div className="iris-preset" key={preset.name} aria-current={preset.name === active}>
            <span className="iris-preset__name">
              {preset.name}
            </span>
            <span className="iris-preset__actions">
              {preset.name === active ? (
                <span className="iris-preset__badge">{t('activeBadge')}</span>
              ) : (
                <button
                  type="button"
                  className="iris-act"
                  onClick={() => void actions.selectPreset(preset.name)}
                >
                  {t('presetUse')}
                </button>
              )}
              <button
                type="button"
                className="iris-act"
                onClick={() => void actions.exportPreset(preset.name)}
              >
                {t('presetExport')}
              </button>
              <button
                type="button"
                className="iris-act iris-act--danger"
                aria-label={t('presetDeleteNamed', { name: preset.name })}
                onClick={() => void actions.deletePreset(preset.name)}
              >
                {t('delete')}
              </button>
            </span>
          </div>
        ))
      )}

      {/*
        The hand-carried import is the primary entry: the file leaves no trail
        through a SillyTavern install, and a preset someone sent is the common
        case. The picker is hidden; the button only opens it. Per-file outcomes
        are kept until the next import, like the install arm's skips.
      */}
      <div className="iris-preset__import">
        <input
          ref={filePicker}
          type="file"
          accept=".json"
          multiple
          hidden
          onChange={event => {
            const files = [...(event.target.files ?? [])]
            // Reset before reading so picking the same file twice still fires —
            // the second pick may be the fixed copy of the first, refused one.
            event.target.value = ''
            void importFiles(files)
          }}
        />
        <Button variant="outline" size="sm" onClick={() => filePicker.current?.click()}>
          {t('presetImportFiles')}
        </Button>
        {fileOutcomes.length === 0 ? null : (
          <ul className="iris-preset__report">
            {fileOutcomes.map((row, index) => (
              <li key={`${String(index)}-${row.name}`}>
                {row.name} — {outcomeNote(row)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        The install-wide import stays as the secondary entry — the arm that
        reaches into a configured SillyTavern install (`IRIS_ST_DIR`) and copies
        its Chat Completion presets wholesale.
      */}
      {install !== undefined && install.length > 0 ? (
        <div className="iris-preset__import">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFileOutcomes([])
              void actions.importPresets().then(answer => setSkipped(answer.skipped))
            }}
          >
            {t('presetImportAll', { n: install.length })}
          </Button>
          <p className="iris-field__note">{t('presetImportNote')}</p>
          {skipped.length === 0 ? null : (
            <ul className="iris-preset__report">
              {skipped.map(row => (
                <li key={row.name}>
                  {row.name} — {row.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {naming ? (
        <div className="iris-conn__save">
          <input
            className="iris-text"
            autoFocus
            value={name}
            placeholder={t('presetNamePlaceholder')}
            aria-label={t('presetNamePlaceholder')}
            onChange={event => setName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') setNaming(false)
              if (event.key === 'Enter') saveAs()
            }}
          />
          <Button variant="primary" size="sm" onClick={saveAs}>
            {t('save')}
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setNaming(true)}>
          {t('presetSaveAs')}
        </Button>
      )}

      {manager === undefined ? null : (
        <>
          <h4 className="iris-label iris-preset__head">{t('presetPrompts')}</h4>
          <div className="iris-preset__prompts">
            {manager.prompts.map((prompt, index) => (
              <div className="iris-preset__prompt" key={prompt.id}>
                <input
                  type="checkbox"
                  className="iris-preset__toggle"
                  checked={prompt.enabled}
                  disabled={!prompt.toggleable}
                  title={prompt.toggleable ? undefined : t('promptNoToggle')}
                  aria-label={prompt.name ?? prompt.id}
                  onChange={event => void actions.setPromptEnabled(prompt.id, event.target.checked)}
                />
                <span className="iris-preset__prompt-name">
                  {prompt.name ?? prompt.id}
                  {prompt.marker ? <span className="iris-preset__badge">{t('promptMarker')}</span> : null}
                  {prompt.systemPrompt ? <span className="iris-preset__badge">{t('promptSystem')}</span> : null}
                  {prompt.role === undefined ? null : (
                    <span className="iris-preset__badge">{t('promptRole', { role: prompt.role })}</span>
                  )}
                </span>
                <span className="iris-preset__prompt-actions">
                  <button
                    type="button"
                    className="iris-act"
                    disabled={index === 0}
                    aria-label={t('promptMoveUp')}
                    onClick={() => void actions.movePrompt(prompt.id, index - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="iris-act"
                    disabled={index === manager.prompts.length - 1}
                    aria-label={t('promptMoveDown')}
                    onClick={() => void actions.movePrompt(prompt.id, index + 1)}
                  >
                    ↓
                  </button>
                  {prompt.systemPrompt ? null : (
                    <button
                      type="button"
                      className="iris-act iris-act--danger"
                      aria-label={t('promptRemove', { name: prompt.name ?? prompt.id })}
                      onClick={() => void actions.removePrompt(prompt.id)}
                    >
                      {t('delete')}
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </Section>
  )
}
