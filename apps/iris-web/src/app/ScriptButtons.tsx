/**
 * The buttons a card's scripts publish, in a bar above the composer.
 *
 * Upstream puts these in the QuickReply bar — `#qr--bar`, prepended to the send
 * form if QuickReply has not already made one (`use_button_destination_element.ts`).
 * **The position is copied; the tenancy is not.** Upstream hunts for another
 * extension's element, removes its own if that extension later appears, and
 * inherits QR's class names (`qr--button menu_button interactable`) so the
 * buttons look like something else's. That is a sensible thing to do when you
 * are a guest in someone's page and a strange thing to do when you own it. Iris
 * renders its own bar in its own vocabulary, in the same place.
 *
 * @module iris-web/app/ScriptButtons
 */
import type { ReactElement } from 'react'
import { useState } from 'react'

import type { ScriptView } from '@iris/protocol'

import { visibleButtons, type ResolvedButton } from './script-buttons.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * The button bar.
 *
 * **Collapsed by default.** A heavy card can publish a dozen controls a reader
 * uses once a session, and the bar is the composer's neighbour — every pixel it
 * takes is an argument with the text. The toggle line names the count so the
 * reader knows what is folded before spending the click; a card's press still
 * works while folded only in the sense that the reader can unfold it — a
 * control the reader cannot see is not a control they pressed.
 *
 * @param props - the scripts to read, and what to do when one is pressed.
 * @returns the bar, or nothing when no script publishes a visible button.
 */
export function ScriptButtons({
  scripts,
  onPress,
}: {
  scripts: readonly ScriptView[]
  /**
   * Press one button.
   *
   * Injected rather than computed here, because the event name is
   * `${scriptId}_${cyrb53(buttonName)}` and that hash must be **bit-identical**
   * to upstream's: a card registers its listener under the name it computed
   * itself, so a hash differing anywhere means the listener is never called and
   * nothing reports it. The hash lives in one shared place for that reason, and
   * this component does not get its own copy.
   */
  onPress: (button: ResolvedButton) => void
}): ReactElement | null {
  // Subscribed so a language switch re-renders the bar's label. Above the early
  // return: hook order must not depend on whether a card published buttons —
  // the same reason the fold state sits here too.
  useLanguage()
  const [expanded, setExpanded] = useState(false)
  const buttons = visibleButtons(scripts)
  if (buttons.length === 0) return null

  return (
    <div className="iris-buttons" role="group" aria-label={t('cardButtonsAria')}>
      <button
        type="button"
        className="iris-buttons__toggle"
        aria-expanded={expanded}
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          setExpanded(!expanded)
        }}
      >
        {t('cardActionsToggle', { n: buttons.length })}
        <span className="iris-buttons__chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded
        ? buttons.map(button => (
            <button
              key={`${button.scriptId}/${button.name}`}
              type="button"
              className="iris-buttons__button"
              /*
               * The script's name, not the button's, because the button's is already
               * the label. Two scripts may publish buttons with the same text, and
               * the only thing that separates them for a reader is who they belong
               * to.
               */
              title={button.scriptName}
              onClick={event => {
                // Upstream's `@click.stop.prevent`: the bar sits inside the composer,
                // and a press must not reach the form behind it.
                event.preventDefault()
                event.stopPropagation()
                onPress(button)
              }}
            >
              {button.name}
            </button>
          ))
        : null}
    </div>
  )
}
