/**
 * The global regex layer.
 *
 * The one tier of regex scripts the user writes rather than downloads with a
 * card: upstream keeps it at `extension_settings.regex` and runs it against
 * **every** conversation, before anything the character ships
 * (`extensions/regex/engine.js`, `SCRIPT_TYPES.GLOBAL`). This panel lists the
 * tier in run order and edits it — write a rule from scratch, change one, toggle,
 * delete, reorder, export, and the import that is the migration path: a
 * `regex-*.json` file exported from SillyTavern, in either shape that export
 * produces (one script, or an array of them).
 *
 * **Writing one from scratch is new**, and its absence was the gap that
 * mattered most: until it existed, every rule in this tier had to be authored
 * in a SillyTavern install and imported, so the panel could govern rules it
 * could not create and could not fix a typo in one. `RegexEditor` is the form,
 * and it is upstream's `editor.html` field for field.
 *
 * The card's own tier is next door in `ScopedRegexPanel` — it belongs to one
 * card, so it answers to the open conversation rather than to the profile. The
 * preset tier is still absent: this host's preset library is read-only, and a
 * panel that showed what it cannot edit would be promising edits that do
 * nothing.
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
import { CollapsibleSection } from './fields.tsx'
import { RegexEditor } from './RegexEditor.tsx'
import { exportRegexFile } from './regex-export.ts'
import { RegexBadges } from './regex-rows.tsx'
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
 * A stable handle for one row, for the "which row is being edited" state.
 *
 * The id when there is one, and the index otherwise. A rule really can arrive
 * without an id — upstream assigns them lazily, and an import file may carry
 * none until the host mints one — and `undefined` as a key would open the
 * editor on every unnamed rule at once.
 * @param script - the row.
 * @param index - its position, as the fallback.
 * @returns the handle.
 */
function keyOf(script: RegexScriptView, index: number): string {
  return script.id ?? `#${String(index)}`
}

/**
 * Render the global regex card.
 *
 * Returns nothing when the host keeps no global regex store: the store's
 * `regexScripts === undefined` is that refusal, and a card of dead controls
 * would read as breakage rather than absence.
 * @returns the card, or nothing.
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
  /*
   * Which row the editor is open on: its `id`, `'new'`, or nothing.
   *
   * Keyed by id rather than by index, because every write here is a whole-list
   * replacement and the list can be reordered under the editor. An index would
   * survive a move and start editing whichever rule had slid into that
   * position — with the form still showing the old rule's fields.
   */
  const [editing, setEditing] = useState<string | undefined>(undefined)

  useEffect(() => {
    void actions.loadRegex()
  }, [actions])

  if (scripts === undefined) return null

  const replace = (next: readonly RegexScriptView[]): void => {
    if (busy) return
    setBusy(true)
    void actions.setRegexScripts(next).finally(() => setBusy(false))
  }

  /**
   * Store one rule the editor produced, and close the form.
   *
   * A whole-list replacement, because that is the only write the host offers
   * for this tier — so an edit is "the list, with this row swapped" and a
   * create is "the list, with this row appended". The row is matched by
   * identity rather than by id: a rule can legitimately arrive from an import
   * with no id at all, and `undefined === undefined` would match the wrong one.
   * @param row - the row being edited, or undefined when creating.
   * @param next - the rule as the form left it.
   */
  const commit = (row: RegexScriptView | undefined, next: RegexScriptView): void => {
    setEditing(undefined)
    replace(row === undefined
      ? [...scripts, next]
      : scripts.map(entry => (entry === row ? next : entry)))
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

  const move = (index: number, target: number): void => {
    if (target < 0 || target >= scripts.length) return
    const next = [...scripts]
    const [row] = next.splice(index, 1)
    if (row === undefined) return
    next.splice(target, 0, row)
    replace(next)
  }

  return (
    <CollapsibleSection
      id="regex"
      title={t('sectionRegex')}
      summary={t('regexSummary', { count: scripts.length })}
    >
      <p className="iris-field__note">{t('regexNote')}</p>

      {scripts.length === 0 ? (
        <p className="iris-list__empty">{t('regexEmpty')}</p>
      ) : (
        <div className="iris-regex__list">
          {scripts.map((script, index) => (
            <div className="iris-regex__entry" key={script.id ?? index}>
            <div className="iris-regex__row">
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
                <RegexBadges script={script} />
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
                  onClick={() => setEditing(editing === keyOf(script, index) ? undefined : keyOf(script, index))}
                >
                  {t('edit')}
                </button>
                <button
                  type="button"
                  className="iris-act"
                  onClick={() => exportRegexFile(script)}
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
            {editing === keyOf(script, index) ? (
              <RegexEditor
                script={script}
                busy={busy}
                onSave={next => commit(script, next)}
                onCancel={() => setEditing(undefined)}
              />
            ) : null}
            </div>
          ))}
        </div>
      )}

      {editing === 'new' ? (
        <RegexEditor
          busy={busy}
          onSave={next => commit(undefined, next)}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}

      {/*
        The import row is unconditional: the file comes from the user's disk,
        not from a configured install, so there is no install-shaped refusal to
        render — this is the migration path and it is always live.
      */}
      <div className="iris-regex__import">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || editing === 'new'}
          onClick={() => setEditing('new')}
        >
          {t('regexNew')}
        </Button>
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
    </CollapsibleSection>
  )
}
