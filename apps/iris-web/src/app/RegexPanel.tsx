/**
 * The global regex layer.
 *
 * The one tier of regex scripts the user writes rather than downloads with a
 * card: upstream keeps it at `extension_settings.regex` and runs it against
 * **every** conversation, before anything the character ships
 * (`extensions/regex/engine.js`, `SCRIPT_TYPES.GLOBAL`). This panel lists the
 * tier in run order and edits it — toggle, delete, reorder, and the import that
 * is the migration path: a `regex-*.json` file exported from SillyTavern, in
 * either shape that export produces (one script, or an array of them).
 *
 * The other two tiers are deliberately absent: a card's own scripts belong to
 * the card, and the preset tier is one this host does not carry. A panel that
 * showed what it cannot edit would be promising edits that do nothing.
 *
 * Rendered inside the settings drawer, after the presets: both are "what the
 * model and the reader actually see" surfaces, and both are profile-wide.
 *
 * @module iris-web/app/RegexPanel
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { RegexScriptView } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Section } from './fields.tsx'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Whether a parsed value is one importable script, per the host's own gate:
 * the three fields the engine reads on every run must be present and honest.
 * Everything else rides along verbatim — that is the point of the format.
 * @param value - one element of a parsed `regex-*.json` file.
 * @returns true when the host will accept it.
 */
function isRegexScript(value: unknown): value is RegexScriptView {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['scriptName'] === 'string' && candidate['scriptName'].length > 0
    && typeof candidate['findRegex'] === 'string' && candidate['findRegex'].length <= 100_000
    && typeof candidate['replaceString'] === 'string' && candidate['replaceString'].length <= 100_000
}

/**
 * The filename an export lands under, spelled the way upstream spells it:
 * `regex-` plus the script name run through its own `sanitizeFileName`
 * (illegal characters to `_`, then lowercased). A script exported from here
 * and imported into SillyTavern arrives under the name that install expects.
 * @param script - the script being exported.
 * @returns a safe filename.
 */
function exportName(script: RegexScriptView): string {
  const stem = (script.scriptName ?? 'script')
    .replace(/[\s.<>:"/\\|?*\u0000-\u001F\u007F]/g, '_')
    .toLowerCase()
  return `regex-${stem}.json`
}

/**
 * Render the global regex section.
 *
 * Returns nothing when the host keeps no global regex store: the store's
 * `regexScripts === undefined` is that refusal, and a section of dead controls
 * would read as breakage rather than absence.
 * @returns the section, or nothing.
 */
export function RegexPanel(): ReactElement | null {
  const scripts = useIris(state => state.regexScripts)
  const notify = useIris(state => state.notify)
  const actions = useIrisActions()
  // Subscribed so a language switch re-renders the panel's words.
  useLanguage()

  // The file input is hidden and driven by a visible button, the Sidebar's
  // card-import pattern: a file picker cannot be styled, so it is not shown.
  const fileRef = useRef<HTMLInputElement>(null)
  // Set while a write is in flight, so a second click cannot interleave two
  // read-modify-writes and lose one of them.
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void actions.loadRegex()
  }, [actions])

  if (scripts === undefined) return null

  const replace = (next: readonly RegexScriptView[]): void => {
    if (busy) return
    setBusy(true)
    void actions.setRegexScripts(next).finally(() => setBusy(false))
  }

  const importFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined || busy) return
    setBusy(true)
    try {
      // Both shapes the upstream export produces: one script object, or the
      // array its bulk export writes. Anything else, or one row the host would
      // refuse, fails the whole file — a half-visible import is harder to
      // reason about than a refused one.
      const parsed: unknown = JSON.parse(await file.text())
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      if (!rows.every(isRegexScript)) throw new Error('not a regex export')
      // Ids are dropped, not carried: upstream's importer mints a fresh UUID
      // for every import, so importing the same file twice is how a user
      // *duplicates* a script, and carrying the old id would turn that into a
      // silent overwrite.
      const fresh = rows.map(row => {
        const { id: _id, ...rest } = row
        return rest
      })
      await actions.setRegexScripts([...scripts, ...fresh])
      notify('info', t(fresh.length === 1 ? 'regexImportedOne' : 'regexImported', { n: fresh.length }))
    } catch {
      notify('error', t('regexImportFailed'))
    } finally {
      setBusy(false)
    }
  }

  const exportScript = (script: RegexScriptView): void => {
    // Four-space JSON, matching what upstream's export writes — a file that
    // goes out of here can go straight back into an install without showing
    // up as a full-file diff there.
    const body = JSON.stringify(script, null, 4)
    const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = exportName(script)
    link.click()
    URL.revokeObjectURL(url)
  }

  const move = (index: number, target: number): void => {
    if (target < 0 || target >= scripts.length) return
    const next = [...scripts]
    const [row] = next.splice(index, 1)
    if (row === undefined) return
    next.splice(target, 0, row)
    replace(next)
  }

  return (
    <Section title={t('sectionRegex')}>
      <p className="iris-field__note">{t('regexNote')}</p>

      {scripts.length === 0 ? (
        <p className="iris-list__empty">{t('regexEmpty')}</p>
      ) : (
        <div className="iris-regex__list">
          {scripts.map((script, index) => (
            <div className="iris-regex__row" key={script.id ?? index}>
              <input
                type="checkbox"
                className="iris-regex__toggle"
                checked={script.disabled !== true}
                aria-label={script.scriptName}
                onChange={event => replace(scripts.map(row =>
                  row === script ? { ...row, disabled: !event.target.checked } : row))}
              />
              <span className="iris-regex__name">
                {script.scriptName}
                {script.markdownOnly === true ? <span className="iris-regex__badge">{t('regexDisplayOnly')}</span> : null}
                {script.promptOnly === true ? <span className="iris-regex__badge">{t('regexPromptOnly')}</span> : null}
                {script.markdownOnly !== true && script.promptOnly !== true
                  ? <span className="iris-regex__badge">{t('regexPermanent')}</span>
                  : null}
              </span>
              <span className="iris-regex__actions">
                <button
                  type="button"
                  className="iris-act"
                  disabled={index === 0}
                  aria-label={t('regexMoveUp')}
                  onClick={() => move(index, index - 1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="iris-act"
                  disabled={index === scripts.length - 1}
                  aria-label={t('regexMoveDown')}
                  onClick={() => move(index, index + 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="iris-act"
                  onClick={() => exportScript(script)}
                >
                  {t('regexExport')}
                </button>
                <button
                  type="button"
                  className="iris-act iris-act--danger"
                  aria-label={t('regexDeleteNamed', { name: script.scriptName ?? String(script.id ?? '') })}
                  onClick={() => replace(scripts.filter(row => row !== script))}
                >
                  {t('delete')}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/*
        The import row is unconditional: the file comes from the user's disk,
        not from a configured install, so there is no install-shaped refusal to
        render — this is the migration path and it is always live.
      */}
      <div className="iris-regex__import">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {t('regexImport')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={event => {
            void importFile(event.target.files?.[0])
            // A second import of the same file must still fire `change`.
            event.target.value = ''
          }}
        />
        <p className="iris-field__note">{t('regexImportNote')}</p>
      </div>
    </Section>
  )
}
