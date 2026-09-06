/**
 * The one-time offer to clean a chat's old variables.
 *
 * Upstream (MagVarUpdate `cleanup/legacy_chat.ts:16-25`) asks before this sweep
 * and only before this one, because it is far wider than the periodic window —
 * `[1, len - 1 - keep]` against the whole file — and it deletes a user's
 * message data. Doing it without the question would turn a deletion its own
 * author requires consent for into a silent one, so the question is reproduced
 * rather than improved away.
 *
 * **What is copied, and it is copied deliberately rather than redesigned:** the
 * body text, the three button labels, and the render order — upstream passes
 * plain strings as `customButtons`, and ST's popup *prepends* those
 * (`popup.js:312-315`), so "back up and clean" comes **before** "clean only".
 * A reader who has used the extension should recognise this dialog.
 *
 * **What diverges, once, and it is recorded in `notes/apps/iris-web/DEVIATIONS.md`:** dismissing.
 * Upstream routes `CANCELLED` into the same branch as `NEGATIVE`
 * (`legacy_chat.ts:27-33`), so one press of Esc writes `ignore_cleanup`
 * permanently — the user believes they deferred and the extension believes they
 * declined forever, and nothing on screen says which happened. Iris sends
 * nothing at all, which the protocol already defines as a complete outcome:
 * nothing cleaned, nothing recorded, asked again next time.
 *
 * **What is added:** the counts. Upstream's text says only that old variables
 * can be removed; the offer carries the range and how many layers inside it
 * still hold something, and a question about deleting data should say how much.
 * That is an improvement in the upgrade ledger, not a fix.
 *
 * @module iris-web/app/CleanupOffer
 */

import { useEffect, useRef, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris, useIrisStore } from '../client/provider.tsx'
import { actionsOf } from '../client/store.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * The offer, when there is one for the conversation on screen.
 *
 * The dialog's copy is upstream's own — "what is copied is copied deliberately"
 * below — and it lives in the dictionary now so the Chinese reader meets the
 * same dialog in their language; the zh column follows the meaning of
 * upstream's zh-CN variants. The counts line and the deferral note at the
 * bottom are Iris's additions and translate as any other shell copy.
 *
 * @returns the dialog, or nothing.
 */
export function CleanupOffer(): ReactElement | null {
  const store = useIrisStore()
  const offer = useIris(state => state.cleanupOffer)
  const chatId = useIris(state => state.chatId)
  const dialog = useRef<HTMLDivElement>(null)
  // Subscribed so a language switch re-renders the dialog.
  useLanguage()

  /*
   * Focus moves into the dialog when it appears. A modal question about
   * deleting data that a keyboard user has to hunt for is a question they will
   * answer by accident.
   */
  useEffect(() => {
    if (offer === undefined) return
    dialog.current?.focus()
  }, [offer])

  /*
   * **Escape is listened for on the document, not on the panel.**
   *
   * It was an `onKeyDown` on the panel, which only fires when focus is already
   * inside it — so the first press did nothing and the second worked, exactly
   * as observed on 8789. The window is small (one effect, after the focus call)
   * and it is not the real problem: a modal whose dismissal depends on where
   * focus happens to be is broken for anyone whose focus is in the composer,
   * which is where it is while they are reading.
   *
   * Capture phase, so the composer's own Escape handling does not consume it
   * first, and `stopPropagation` so nothing downstream treats one press as two
   * separate dismissals.
   */
  useEffect(() => {
    if (offer === undefined) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      actionsOf(store).dismissCleanupOffer()
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
    }
  }, [offer, store])

  // The offer carries its own chat, because it can arrive a beat before the
  // store learns which chat is open — see the store's `cleanup.offer` handler.
  if (offer === undefined || offer.chatId !== chatId) return null

  const actions = actionsOf(store)

  return (
    <div
      className="iris-cleanup"
      role="presentation"
      onMouseDown={event => {
        /*
         * **Clicking outside defers, exactly like Esc.** The spec names both as
         * dismissals, and only Esc was wired — so a reader who clicked the dim
         * area got nothing and would reasonably conclude the dialog was stuck.
         *
         * `onMouseDown` on the scrim, guarded by `event.target === event
         * .currentTarget`: a click that *starts* inside the panel and drifts
         * out — selecting the body text and releasing past the edge — must not
         * count as a dismissal, and a `click` handler would treat it as one.
         *
         * It is a deferral, not a decline: nothing is sent, so the host records
         * nothing and asks again. Same divergence from upstream as Esc, same
         * reason, and the line under the buttons says so.
         */
        if (event.target !== event.currentTarget) return
        actions.dismissCleanupOffer()
      }}
    >
      <div
        className="iris-cleanup__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="iris-cleanup-title"
        tabIndex={-1}
        ref={dialog}
        onKeyDown={event => {
          /*
           * **Esc defers, it does not decline.** The whole divergence, in one
           * branch: `dismissCleanupOffer` sends nothing, so the host records
           * nothing and asks again. Mapping this to `'never'` — which is what
           * upstream does — is invisible when it is wrong, because the user
           * sees a closed dialog either way.
           */
          if (event.key === 'Escape') {
            event.stopPropagation()
            actions.dismissCleanupOffer()
          }
        }}
      >
        <h2 className="iris-label" id="iris-cleanup-title">{t('cleanupTitle')}</h2>
        <p className="iris-cleanup__body">{t('cleanupPrompt')}</p>

        {/*
          The counts, which upstream does not show. A question about deleting
          data should say how much: the range it would sweep, and how many
          layers in that range still hold something to remove — the second
          number is the one that can be zero while the first is large.
        */}
        <p className="iris-field__note">
          {t('cleanupCounts', {
            layers: offer.layers,
            from: offer.from,
            to: offer.to,
            lines: offer.lines,
          })}
        </p>

        <div className="iris-cleanup__buttons">
          {/*
            Upstream's order: its custom button is prepended before the ok
            button (`popup.js:312-315`), so backup-and-clean leads. The
            decline's position relative to them comes from ST's popup template,
            which was not read — it is last here, and that placement is ours
            rather than copied.
          */}
          {/*
            `outline` rather than `primary` for the leading button: upstream's
            prepended custom button leads the row but is not its default
            action — `primary` is the ok button, which is "clean only". The
            available variants are `primary | ghost | outline | toolbar`, so
            this is the closest of the four to "prominent, not the default".
          */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void actions.answerCleanup('backup-and-clean')
            }}
          >
            {t('cleanupBackupAndClean')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void actions.answerCleanup('clean')
            }}
          >
            {t('cleanupCleanOnly')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void actions.answerCleanup('never')
            }}
          >
            {t('cleanupDoNotRemind')}
          </Button>
        </div>

        {/*
          Said out loud, because the difference between this and upstream is
          exactly the thing a user cannot see: that closing the dialog is not an
          answer. Without this line the divergence only helps people who already
          know it exists.
        */}
        <p className="iris-field__note">
          {t('cleanupDeferNote')}
        </p>
      </div>
    </div>
  )
}
