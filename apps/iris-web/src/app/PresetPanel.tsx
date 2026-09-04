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

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Section } from './fields.tsx'
import { useLanguage, t } from './i18n/use-language.ts'

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
        The import row exists only when the host has an install configured —
        `install === undefined` means the composition never named one, and a
        button that answers "no install" forever is a button that lies.
      */}
      {install !== undefined && install.length > 0 ? (
        <div className="iris-preset__import">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
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
