/**
 * The chat backups panel: the snapshots the host takes in front of the
 * irreversible.
 *
 * Iris already copies a conversation aside before the operations that lose
 * data — a floor's deletion, a card's batch rewrite, a restore, the cleanup
 * sweep a reader opted into. What was missing was the shell view: a list that
 * says when each copy was taken and why, a read-only look inside before
 * anything is written back, the restore that demands the conversation's name
 * typed by hand, and the delete that clears a copy once it has done its work.
 * The mechanism (`backup.*`) serves every chat in the profile; this card is
 * where a reader meets it.
 *
 * Every row names its chat, and the confirm box opens under the row it
 * belongs to — an overwrite confirmed in place is an overwrite the reader can
 * still see.
 *
 * @module iris-web/app/BackupPanel
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { BackupPreview, BackupReason, BackupSummary } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { describeBytes, since } from './format.ts'
import { CollapsibleSection } from './fields.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import type { StringKey } from './i18n/strings.ts'

/** The row's badge word, by the reason the host recorded in the file name. */
const REASON_LABEL: Partial<Record<BackupReason, StringKey>> = {
  cleanup: 'backupReasonCleanup',
  'delete-message': 'backupReasonDeleteMessage',
  'delete-messages': 'backupReasonDeleteMessages',
  'import-overwrite': 'backupReasonImportOverwrite',
  'pre-restore': 'backupReasonPreRestore',
  'rewrite-messages': 'backupReasonRewriteMessages',
}

/**
 * Render the chat backups card.
 *
 * Returns nothing when the host keeps no snapshot store: the store's
 * `backups === undefined` is that refusal, and a card of dead controls would
 * read as breakage rather than absence — the same answer the regex panel
 * gives, for the same reason.
 * @returns the card, or nothing.
 */
export function BackupPanel(): ReactElement | null {
  const backups = useIris(state => state.backups)
  const chats = useIris(state => state.chats)
  const actions = useIrisActions()
  // Subscribed so a language switch re-renders the panel's words.
  const { lang } = useLanguage()

  // The preview and the confirm box are panel-local on purpose: they describe
  // one snapshot for as long as the reader is looking at it, and nothing about
  // them outlives the drawer.
  const [preview, setPreview] = useState<BackupPreview | undefined>(undefined)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [confirming, setConfirming] = useState<BackupSummary | undefined>(undefined)
  const [typed, setTyped] = useState('')
  // The delete is a two-step arm, because an irreversible click on a list
  // where rows sit close together is how the wrong copy goes.
  const [armed, setArmed] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (backups === undefined) void actions.loadBackups()
  }, [backups, actions])

  if (backups === undefined) return null

  /*
   * Grouped by conversation, newest snapshot first within and across groups —
   * the question the panel answers is "what happened to this chat lately",
   * and the chat's own name is the first thing a reader scans for.
   */
  const groups: { chatId: string, rows: BackupSummary[] }[] = []
  for (const row of backups) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.chatId === row.chatId) last.rows.push(row)
    else groups.push({ chatId: row.chatId, rows: [row] })
  }

  const titleOf = (chatId: string): string =>
    chats.find(chat => chat.chatId === chatId)?.title ?? chatId

  const openPreview = (row: BackupSummary): void => {
    if (previewBusy) return
    setPreviewBusy(true)
    setConfirming(undefined)
    void actions.previewBackup(row.backupId)
      .then(answer => { setPreview(answer ?? undefined) })
      .finally(() => setPreviewBusy(false))
  }

  const openConfirm = (row: BackupSummary): void => {
    // The confirm box needs the preview's header facts, and the reader needs
    // to have seen what would come back — so restoring always looks first.
    if (preview?.backup.backupId === row.backupId) {
      setConfirming(row)
      return
    }
    if (previewBusy) return
    setPreviewBusy(true)
    void actions.previewBackup(row.backupId)
      .then(answer => {
        setPreview(answer ?? undefined)
        if (answer !== undefined) setConfirming(row)
      })
      .finally(() => setPreviewBusy(false))
  }

  const confirmReady = ((): boolean => {
    if (confirming === undefined || preview === undefined) return false
    const expected = preview.title.length > 0 ? preview.title : preview.backup.chatId
    return typed.trim() === expected
  })()

  return (
    <CollapsibleSection
      id="backups"
      title={t('sectionBackups')}
      summary={t('backupsSummary', { count: backups.length })}
    >
      {backups.length === 0 ? (
        <p className="iris-list__empty">{t('backupsEmpty')}</p>
      ) : (
        <div className="iris-backup__list">
          {groups.map(group => (
            <div key={group.chatId}>
              <div className="iris-backup__group">{titleOf(group.chatId)}</div>
              {group.rows.map(row => {
                const isPreview = preview?.backup.backupId === row.backupId
                const isConfirm = confirming?.backupId === row.backupId
                return (
                  <div key={row.backupId}>
                    <div className="iris-backup__row">
                      <span className="iris-backup__when">
                        {since(row.createdAt, Date.now(), lang)}
                        <span className="iris-backup__badge">
                          {row.reason === undefined
                            ? t('backupUnknownReason')
                            : t(REASON_LABEL[row.reason] ?? 'backupUnknownReason')}
                        </span>
                      </span>
                      <span className="iris-backup__detail">
                        {t('backupFloors', { n: row.messageCount })} · {describeBytes(row.bytes, lang)}
                      </span>
                      <span className="iris-backup__actions">
                        <button
                          type="button"
                          className="iris-act"
                          disabled={previewBusy}
                          onClick={() => (isPreview ? setPreview(undefined) : openPreview(row))}
                        >
                          {t('backupPreview')}
                        </button>
                        <button
                          type="button"
                          className="iris-act"
                          disabled={previewBusy}
                          onClick={() => (isConfirm ? setConfirming(undefined) : openConfirm(row))}
                        >
                          {t('backupRestore')}
                        </button>
                        <button
                          type="button"
                          className="iris-act iris-act--danger"
                          aria-label={t('backupDeleteAria', { time: since(row.createdAt, Date.now(), lang) })}
                          onClick={() => {
                            if (armed !== row.backupId) {
                              setArmed(row.backupId)
                              return
                            }
                            setArmed(undefined)
                            if (isPreview) setPreview(undefined)
                            if (isConfirm) setConfirming(undefined)
                            void actions.deleteBackup(row.backupId)
                          }}
                          onBlur={() => { if (armed === row.backupId) setArmed(undefined) }}
                        >
                          {armed === row.backupId ? t('backupDeleteSure') : t('backupDelete')}
                        </button>
                      </span>
                    </div>

                    {isPreview && !isConfirm ? (
                      <div className="iris-backup__panel">
                        <span className="iris-field__label">
                          {t('backupPreviewHead', { n: preview?.floors.length ?? 0, total: preview?.totalFloors ?? 0 })}
                        </span>
                        {(preview?.floors.length ?? 0) === 0
                          ? <p className="iris-list__empty">{t('backupPreviewEmpty')}</p>
                          : preview?.floors.map(floor => (
                            <div className="iris-backup__floor" key={floor.messageId}>
                              <span className="iris-backup__floor-name">
                                {floor.messageId} · {floor.name}
                              </span>
                              {floor.text}
                            </div>
                          ))}
                      </div>
                    ) : null}

                    {isConfirm && preview !== undefined ? (
                      <div className="iris-backup__panel">
                        <span className="iris-field__label">
                          {t('backupRestoreTitle', { title: titleOf(row.chatId) })}
                        </span>
                        <p className="iris-field__note">
                          {t('backupRestoreBody', {
                            floors: t('backupFloors', { n: preview.totalFloors }),
                            size: describeBytes(preview.backup.bytes, lang),
                          })}
                        </p>
                        <label className="iris-field__label" htmlFor={`iris-backup-confirm-${row.backupId}`}>
                          {t('backupRestoreType', {
                            name: preview.title.length > 0 ? preview.title : preview.backup.chatId,
                          })}
                        </label>
                        <input
                          id={`iris-backup-confirm-${row.backupId}`}
                          className="iris-text iris-backup__confirm-input"
                          type="text"
                          value={typed}
                          autoComplete="off"
                          onChange={event => { setTyped(event.target.value) }}
                        />
                        <span className="iris-backup__actions">
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={!confirmReady}
                            onClick={() => {
                              const done = confirming
                              setConfirming(undefined)
                              setTyped('')
                              if (done !== undefined) void actions.restoreBackup(done.backupId, typed)
                            }}
                          >
                            {t('backupRestoreGo')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setConfirming(undefined)
                              setTyped('')
                            }}
                          >
                            {t('backupRestoreCancel')}
                          </Button>
                        </span>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </CollapsibleSection>
  )
}
