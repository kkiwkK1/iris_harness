/**
 * A reply's reasoning, treated as a footnote.
 *
 * Collapsed by default and set as a marginal note rather than a card: reasoning
 * is apparatus, not prose, and a reader following a scene should be able to
 * ignore it without it occupying a third of the page. The label carries a length
 * so the decision to expand is informed.
 *
 * **Except when it is the whole reply.** A reasoning model can spend its entire
 * output on `reasoning_content` and send no `content` at all — measured in the
 * owner's 黑兽 chats, three generations whose provider-reported reasoning tokens
 * equal their completion tokens and whose body is empty. Upstream shows such a
 * reply as an empty message under a collapsed reasoning block, and the user's
 * way out is to copy the trace into an edit by hand. Here the block opens itself,
 * says what happened, and offers that edit as one action: the message editor
 * opens on the trace, for the reader to keep or trim before saving. Nothing is
 * written until they save, and the trace stays where it is. The web ledger
 * records it (`notes/apps/iris-web/DEVIATIONS.md` §130).
 *
 * @module iris-web/app/Reasoning
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { approximateWords } from './format.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Render the reasoning disclosure.
 * @param props.text - the trace.
 * @param props.streaming - whether it is still arriving; a trace that is still
 * growing opens itself, because watching a model think is the one time this
 * content is the main event.
 * @param props.onUseAsReply - present only for a settled reply whose body is
 * empty: the block then opens itself and offers to edit the trace into the body.
 * @returns the disclosure, or null when there is no trace.
 */
export function Reasoning({ text, streaming, onUseAsReply }: {
  text: string
  streaming: boolean
  onUseAsReply?: (() => void) | undefined
}): ReactElement | null {
  // `null` until the reader clicks, so the default can follow the reply: a
  // trace that is the whole reply starts open, any other starts closed.
  const [chosen, setChosen] = useState<boolean | null>(null)
  // Subscribed so a language switch re-renders the label.
  useLanguage()
  if (text.trim() === '') return null

  const orphaned = onUseAsReply !== undefined && !streaming
  const open = chosen ?? orphaned
  const shown = open || streaming
  return (
    <div className="iris-reason">
      <button
        type="button"
        className="iris-reason__toggle"
        aria-expanded={shown}
        onClick={() => setChosen(!open)}
      >
        <span className={`iris-reason__chevron${shown ? ' iris-reason__chevron--open' : ''}`} aria-hidden="true">
          ▸
        </span>
        {streaming ? t('thinking') : t('reasoningWords', { n: approximateWords(text) })}
      </button>
      {orphaned ? (
        <div className="iris-reason__orphan" role="note">
          <span>{t('reasoningOnly')}</span>
          <button type="button" className="iris-act iris-act--primary" data-control="reasoning-use-as-reply" onClick={onUseAsReply}>
            {t('reasoningUseAsReply')}
          </button>
        </div>
      ) : null}
      {shown ? <div className="iris-reason__body">{text}</div> : null}
    </div>
  )
}
