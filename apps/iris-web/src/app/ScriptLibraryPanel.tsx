/**
 * The user's own script library.
 *
 * TavernHelper's 脚本库, which is the other half of the script feature Iris did
 * not have: this shell could list, govern and run the scripts a **card** ships,
 * and a user who wanted a script of their own — a dice roller, a status panel,
 * anything they had written — had nowhere to put it.
 *
 * Two repositories, and they are upstream's own (`store/scripts.ts:19-24` and
 * `store/settings/character.ts:34`, from the 酒馆助手 4.9.1 source):
 *
 * - **global**, which runs in every conversation;
 * - **per character**, which runs only in that card's.
 *
 * Both are listed here; the character half appears when a conversation is open,
 * which is the only time this panel knows which card to ask about. The
 * character page carries the same rows for a card merely being browsed, and its
 * own control for adding one.
 *
 * **Same sandbox, same consent, same allowlist.** A script from this library
 * reaches the page through `script.list` and `script.body` — the two calls the
 * card runner already used — so it runs in the same frame, under the same
 * per-card permission question, with the same remote-code allowlist. There is
 * no path here that a card script does not already have, which is the point:
 * the user's own code is not more trusted than a card's, because the two run in
 * the same realm and a card would inherit anything granted to a neighbour.
 *
 * @module iris-web/app/ScriptLibraryPanel
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { UserScript, UserScriptView } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { CollapsibleSection } from './fields.tsx'
import { describeBytes } from './format.ts'
import { ScriptEditor } from './ScriptEditor.tsx'
import { exportScriptFile, isUserScriptFile, scriptImportDraft } from './script-library.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/** Which row the editor is open on, if any. */
type Editing =
  | { kind: 'new', scope: 'global' | 'character' }
  | { kind: 'edit', scope: 'global' | 'character', id: string, script: UserScript }

/**
 * Render the script-library section, or nothing.
 *
 * Nothing when the host keeps no library — `library === undefined` after a
 * load, which is the refusal — because a panel of live controls over a store
 * that does not exist would take a script the user typed and lose it silently.
 * @returns the section, or null.
 */
export function ScriptLibraryPanel(): ReactElement | null {
  const characterId = useIris(state => state.view?.characterId)
  const rows = useIris(state => state.library)
  const notify = useIris(state => state.notify)
  const actions = useIrisActions()

  const [editing, setEditing] = useState<Editing | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // Which repository an import lands in. Upstream asks the same question with a
  // popup before it parses anything (`panel/script/TargetSelector.vue`); here it
  // is the scope of whichever "import" button was pressed.
  const importScope = useRef<'global' | 'character'>('global')
  // Subscribed so a language switch re-renders the panel's words.
  useLanguage()

  useEffect(() => {
    void actions.loadLibrary(characterId)
  }, [characterId, actions])

  if (rows === undefined) return null

  const global = rows.filter(row => row.scope === 'global')
  const mine = rows.filter(row => row.scope === 'character')

  /** The character id a write in this scope needs, and `undefined` for global. */
  const idFor = (scope: 'global' | 'character'): string | undefined =>
    (scope === 'global' ? undefined : characterId)

  const openEditor = (scope: 'global' | 'character', row?: UserScriptView): void => {
    if (row === undefined) {
      setEditing({ kind: 'new', scope })
      return
    }
    // Fetched rather than taken from the row: the listing deliberately carries
    // no body, and an editor opened on a row would show an empty textarea and
    // then save that emptiness over the real script.
    void actions.readLibraryScript(scope, idFor(scope), row.id)
      .then(script => { setEditing({ kind: 'edit', scope, id: row.id, script }) })
      .catch(() => { notify('error', t('libraryReadFailed', { name: row.name })) })
  }

  const save = (scope: 'global' | 'character', draft: Parameters<typeof actions.saveLibraryScript>[2]): void => {
    if (busy) return
    setBusy(true)
    void actions.saveLibraryScript(scope, idFor(scope), draft)
      .then(id => {
        // Closed only on a write that landed. A refused save that closed the
        // form would take whatever the reader had typed with it, and the notice
        // explaining the refusal would be the only thing left of it.
        if (id !== undefined) setEditing(undefined)
      })
      .finally(() => setBusy(false))
  }

  const importFile = async (file: File | undefined): Promise<void> => {
    const scope = importScope.current
    if (file === undefined || busy) return
    if (scope === 'character' && characterId === undefined) return
    setBusy(true)
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!isUserScriptFile(parsed)) throw new Error('not a script export')
      const draft = scriptImportDraft(parsed)
      const id = await actions.saveLibraryScript(scope, idFor(scope), draft)
      if (id !== undefined) notify('info', t('libraryImported', { name: draft.name }))
    } catch {
      notify('error', t('libraryImportFailed'))
    } finally {
      setBusy(false)
    }
  }

  const exportOne = (scope: 'global' | 'character', row: UserScriptView): void => {
    void actions.readLibraryScript(scope, idFor(scope), row.id)
      .then(script => { exportScriptFile(script) })
      .catch(() => { notify('error', t('libraryReadFailed', { name: row.name })) })
  }

  return (
    <CollapsibleSection
      id="scriptLibrary"
      title={t('sectionScriptLibrary')}
      summary={t('librarySummary', { count: rows.length })}
    >
      <p className="iris-field__note">{t('libraryNote')}</p>

      <Repository
        heading={t('libraryGlobalHeading')}
        note={t('libraryGlobalNote')}
        rows={global}
        busy={busy}
        onToggle={(row, enabled) => void actions.setLibraryScriptEnabled('global', undefined, row.id, enabled)}
        onEdit={row => openEditor('global', row)}
        onExport={row => exportOne('global', row)}
        onDelete={row => void actions.deleteLibraryScript('global', undefined, row.id)}
      />
      {editing?.kind === 'new' && editing.scope === 'global' ? (
        <ScriptEditor
          busy={busy}
          onSave={draft => save('global', draft)}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}
      {editing?.kind === 'edit' && editing.scope === 'global' ? (
        <ScriptEditor
          script={editing.script}
          busy={busy}
          onSave={draft => save('global', draft)}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}
      <div className="iris-regex__import">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => openEditor('global')}>
          {t('libraryNew')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            importScope.current = 'global'
            fileRef.current?.click()
          }}
        >
          {t('libraryImport')}
        </Button>
      </div>

      {/*
        The per-character repository, and it is absent rather than empty when no
        conversation is open: a repository belongs to a card, and this panel has
        no card to name until one is. The character page is where a card being
        browsed gets the same list.
      */}
      {characterId === undefined ? (
        <p className="iris-field__note">{t('libraryCharacterNeedsChat')}</p>
      ) : (
        <>
          <Repository
            heading={t('libraryCharacterHeading')}
            note={t('libraryCharacterNote')}
            rows={mine}
            busy={busy}
            onToggle={(row, enabled) =>
              void actions.setLibraryScriptEnabled('character', characterId, row.id, enabled)}
            onEdit={row => openEditor('character', row)}
            onExport={row => exportOne('character', row)}
            onDelete={row => void actions.deleteLibraryScript('character', characterId, row.id)}
          />
          {editing?.kind === 'new' && editing.scope === 'character' ? (
            <ScriptEditor
              busy={busy}
              onSave={draft => save('character', draft)}
              onCancel={() => setEditing(undefined)}
            />
          ) : null}
          {editing?.kind === 'edit' && editing.scope === 'character' ? (
            <ScriptEditor
              script={editing.script}
              busy={busy}
              onSave={draft => save('character', draft)}
              onCancel={() => setEditing(undefined)}
            />
          ) : null}
          <div className="iris-regex__import">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => openEditor('character')}>
              {t('libraryNew')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                importScope.current = 'character'
                fileRef.current?.click()
              }}
            >
              {t('libraryImport')}
            </Button>
          </div>
        </>
      )}

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
      <p className="iris-field__note">{t('libraryImportNote')}</p>
    </CollapsibleSection>
  )
}

/**
 * One repository's rows.
 *
 * The regex list's grammar — a switch, a name with badges, actions on the right
 * — because the two sit in one drawer and matching them is what makes it read
 * as one drawer rather than two bolted together.
 * @param props.heading - which repository.
 * @param props.note - what running these means.
 * @param props.rows - the scripts.
 * @param props.busy - whether a write is in flight.
 * @param props.onToggle - the user's switch.
 * @param props.onEdit - open the editor on one.
 * @param props.onExport - write one to disk.
 * @param props.onDelete - remove one.
 * @returns the list.
 */
function Repository({
  heading,
  note,
  rows,
  busy,
  onToggle,
  onEdit,
  onExport,
  onDelete,
}: {
  heading: string
  note: string
  rows: readonly UserScriptView[]
  busy: boolean
  onToggle: (row: UserScriptView, enabled: boolean) => void
  onEdit: (row: UserScriptView) => void
  onExport: (row: UserScriptView) => void
  onDelete: (row: UserScriptView) => void
}): ReactElement {
  return (
    <div className="iris-library__repo">
      <h4 className="iris-label">{heading}</h4>
      <p className="iris-field__note">{note}</p>
      {rows.length === 0 ? (
        <p className="iris-list__empty">{t('libraryNoScripts')}</p>
      ) : (
        <div className="iris-regex__list">
          {rows.map(row => (
            <div className="iris-regex__row" key={row.id}>
              <input
                type="checkbox"
                className="iris-regex__toggle"
                checked={row.enabled}
                disabled={busy}
                aria-label={row.name}
                onChange={event => onToggle(row, event.target.checked)}
              />
              <span className="iris-regex__name">
                {row.name}
                <span className="iris-meta iris-fact__meta"> {describeBytes(row.bytes)}</span>
                {/*
                  Both numbers, always. 58 of the corpus's 89 buttons are
                  `visible: false`, so "3 buttons" over a bar showing one is the
                  ordinary case rather than the odd one.
                */}
                {row.buttons === undefined || row.buttons.length === 0 ? null : (
                  <span className="iris-regex__badge">
                    {t('libraryButtonCount', {
                      n: row.buttons.length,
                      visible: row.buttons.filter(button => button.visible).length,
                    })}
                  </span>
                )}
                {row.info === undefined || row.info === '' ? null : (
                  <span className="iris-fact__note">{row.info}</span>
                )}
              </span>
              <span className="iris-regex__actions">
                <button type="button" className="iris-act" onClick={() => onEdit(row)}>
                  {t('edit')}
                </button>
                <button type="button" className="iris-act" onClick={() => onExport(row)}>
                  {t('regexExport')}
                </button>
                <button
                  type="button"
                  className="iris-act iris-act--danger"
                  aria-label={t('libraryDeleteNamed', { name: row.name })}
                  onClick={() => onDelete(row)}
                >
                  {t('delete')}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
