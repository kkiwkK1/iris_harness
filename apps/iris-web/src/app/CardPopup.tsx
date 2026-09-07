/**
 * The dialog a card raised through SillyTavern's popup API.
 *
 * Drawn by the shell rather than by the frame that asked, and that is forced
 * rather than chosen: a card frame is clipped to its message's height, so a
 * modal drawn inside one is a modal nobody can see. The frame computed the
 * whole plan — which buttons, in which order, carrying which `POPUP_RESULT` —
 * in `sandbox/popup.ts`; this file draws the plan and reports the press. It
 * decides nothing about the result.
 *
 * **Upstream's button order is reproduced, including the part that looks
 * wrong.** ST prepends custom buttons before the ok button
 * ([ST] `popup.js:312-315`), so MagVarUpdate's cleanup dialog reads "back up
 * and clean" / "clean only" / "do not remind me again" — the leading button is
 * not the default action, which is why the ok button and not the first one
 * carries the primary treatment.
 *
 * **What Iris adds, once:** the dialog says a card is asking. Upstream's popups
 * are indistinguishable from SillyTavern's own, because upstream has no
 * boundary there — the extension *is* the application. Here a card is content,
 * and a modal that could be the application asking about the reader's data or
 * could be a card asking about its own is a modal the reader cannot answer
 * safely. Recorded in `notes/apps/iris-web/DEVIATIONS.md`.
 *
 * @module iris-web/app/CardPopup
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { POPUP_RESULT, POPUP_TYPE, type PopupButtonPlan, type PopupLabel } from '../sandbox/popup.ts'
import { answerCardPopup, getCardPopups, subscribeCardPopups } from './card-popups.ts'
import { sanitizeCardHtml } from './sanitize-html.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * The caption for a button whose card supplied none.
 *
 * The frame sends a **token** rather than a string, because the caption belongs
 * to the reader's language and the frame does not hold the dictionary. Upstream
 * reads the same six captions off its popup template's attributes
 * ([ST] `index.html:6455`), where its own i18n translates them.
 * @param label - the token.
 * @returns the caption in the reader's language.
 */
function captionFor(label: PopupLabel): string {
  switch (label) {
    case 'yes': return t('popupYes')
    case 'no': return t('popupNo')
    case 'cancel': return t('popupCancel')
    case 'save': return t('popupSave')
    case 'crop': return t('popupCrop')
    case 'close': return t('close')
    default: return t('popupOk')
  }
}

/**
 * Which of the primitive's four variants a slot gets.
 *
 * `primary` follows the **ok** button, not the leading one. Upstream's custom
 * buttons are prepended but are not the default action — its `defaultResult` is
 * `AFFIRMATIVE`, which is the ok button — so giving the first button the
 * primary treatment would teach the reader that "back up and clean" is what
 * Enter does when it is not.
 * @param button - the button's plan.
 * @param isDefault - whether Enter completes with this button's result.
 * @returns the variant name.
 */
function variantFor(button: PopupButtonPlan, isDefault: boolean): 'primary' | 'ghost' | 'outline' {
  if (isDefault) return 'primary'
  if (button.slot === 'cancel') return 'ghost'
  return 'outline'
}

/**
 * The popup on screen, if a card has raised one.
 * @returns the dialog, or nothing.
 */
export function CardPopup(): ReactElement | null {
  const popups = useSyncExternalStore(subscribeCardPopups, getCardPopups, getCardPopups)
  const popup = popups[0]
  const panel = useRef<HTMLDivElement>(null)
  const [text, setText] = useState('')
  // Subscribed so a language switch re-renders the default captions.
  useLanguage()

  const key = popup?.key
  const plan = popup?.plan

  /*
   * The input box starts from the card's `inputValue` and is re-seeded whenever
   * a different popup takes the screen — one `useState` for a queue of dialogs
   * would otherwise carry the previous popup's text into the next one's box.
   */
  useEffect(() => {
    setText(plan?.inputValue ?? '')
  }, [key, plan?.inputValue])

  /*
   * Focus moves into the panel when it appears, on the same reasoning as the
   * cleaning offer's: a modal a keyboard reader has to hunt for is a modal they
   * answer by accident.
   */
  useEffect(() => {
    if (key === undefined) return
    panel.current?.focus()
  }, [key])

  /*
   * **Escape is listened for on the document, not on the panel** — the same
   * correction the cleaning offer needed. An `onKeyDown` on the panel only
   * fires once focus is already inside it, so the first press does nothing.
   * Capture phase, so the composer's own Escape handling does not eat it first.
   *
   * `allowEscapeClose: false` asks upstream for a double-Escape force-close
   * confirmation. Here it simply means Escape does nothing, which is the same
   * answer to "did this dismiss?" without a second dialog about the first.
   */
  useEffect(() => {
    if (key === undefined || plan === undefined || !plan.allowEscapeClose) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      answerCardPopup(key, { closed: true, result: POPUP_RESULT.CANCELLED, input: text })
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
    }
  }, [key, plan, text])

  if (popup === undefined || plan === undefined || key === undefined) return null

  const content = sanitizeCardHtml(plan.content)
  const press = (button: PopupButtonPlan): void => {
    answerCardPopup(key, {
      // A button with no result does not close the popup: upstream fires its
      // action and leaves the dialog up ([ST] `popup.js:69`).
      closed: button.result !== undefined,
      result: button.result ?? POPUP_RESULT.CANCELLED,
      button: button.at,
      input: text,
    })
  }

  return (
    <div
      className="iris-popup"
      role="presentation"
      onMouseDown={event => {
        /*
         * Clicking the dim area is a dismissal, exactly as Escape is — and only
         * when the press *starts* on the scrim: a drag that begins on the body
         * text and releases past the edge is a selection, not an answer. The
         * cleaning offer learned this the hard way.
         */
        if (event.target !== event.currentTarget) return
        if (!plan.allowEscapeClose) return
        answerCardPopup(key, { closed: true, result: POPUP_RESULT.CANCELLED, input: text })
      }}
    >
      <div
        className={`iris-popup__panel iris-popup__panel--${plan.measure}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="iris-popup-title"
        tabIndex={-1}
        ref={panel}
        onKeyDown={event => {
          /*
           * Enter completes with the plan's `defaultResult` — upstream's
           * `AFFIRMATIVE` unless the card said otherwise ([ST] `popup.js:209`).
           * Not inside the input box's textarea, where Enter is a newline: an
           * INPUT popup whose Enter submitted would make a multi-line answer
           * impossible to type.
           */
          if (event.key !== 'Enter') return
          if (event.target instanceof HTMLTextAreaElement) return
          const fallback = plan.buttons.find(button => button.result === plan.defaultResult)
          if (fallback === undefined) return
          event.preventDefault()
          press(fallback)
        }}
      >
        <div className="iris-popup__head">
          {/*
            Attribution, which upstream has no need for: its popups come from
            the application. A reader has to be able to tell a card's question
            from Iris's own before answering it.
          */}
          <h2 className="iris-label" id="iris-popup-title">{t('popupCardAsks')}</h2>
          {plan.closeCorner ? (
            <button
              type="button"
              className="iris-popup__close"
              aria-label={t('close')}
              onClick={() => {
                /*
                 * Upstream's corner close on a DISPLAY popup carries
                 * `data-result="0"` (`index.html:6471`) — it completes with
                 * NEGATIVE, not CANCELLED, and a card that tells the two apart
                 * would be told the wrong thing by a tidier choice here.
                 */
                answerCardPopup(key, { closed: true, result: POPUP_RESULT.NEGATIVE, input: text })
              }}
            >
              ×
            </button>
          ) : null}
        </div>

        {/*
          The card's own content. Sanitized in `app/sanitize-html.ts` — no
          scripts, no event handlers, no off-page loads — and escaped to plain
          text if the sanitizer could not run or its own audit found something,
          which is why `escaped` is shown rather than silently absorbed.
        */}
        <div
          className={`iris-popup__body${plan.scrolling ? ' iris-popup__body--scroll' : ''}${plan.leftAlign ? ' iris-popup__body--left' : ''}`}
          {...plan.tooltip === '' ? {} : { title: plan.tooltip }}
          dangerouslySetInnerHTML={{ __html: content.html }}
        />
        {content.escaped && plan.content !== '' ? (
          <p className="iris-field__note">{t('popupMarkupRefused')}</p>
        ) : null}

        {plan.kind === POPUP_TYPE.INPUT ? (
          <textarea
            className="iris-popup__input"
            rows={plan.rows}
            value={text}
            placeholder={plan.placeholder}
            {...plan.tooltip === '' ? {} : { title: plan.tooltip }}
            onChange={event => {
              setText(event.target.value)
            }}
          />
        ) : null}

        <div className="iris-popup__buttons">
          {plan.buttons.map(button => (
            <Button
              key={button.at}
              variant={variantFor(button, button.result === plan.defaultResult)}
              size="sm"
              {...button.tooltip === undefined ? {} : { title: button.tooltip }}
              onClick={() => {
                press(button)
              }}
            >
              {button.text ?? captionFor(button.label)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
