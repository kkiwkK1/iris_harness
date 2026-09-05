/**
 * One message on the reading surface.
 *
 * The layout is a two-column row: marginalia, then text at the measure. What
 * goes in the margin says what the row *is* — a turn ordinal for the reader's
 * own lines, the variant rail for a reply with alternates. There is no bubble,
 * no avatar and no rule, because none of those carry information a reader of a
 * long scene needs, and all of them cost measure.
 *
 * @module iris-web/app/Message
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'

import { MessageActions } from './MessageActions.tsx'
import { MessageInterfaces } from './MessageInterfaces.tsx'
import type { MessageView } from '@iris/protocol'

import { Slot } from '../slots/Slot.tsx'
import { Reasoning } from './Reasoning.tsx'
import { VariantRail } from './VariantRail.tsx'
import { useLanguage, t } from './i18n/use-language.ts'

/** What a message row can do, supplied by the pane that owns the chat. */
export interface MessageHandlers {
  onSwipe: (turn: number, index: number) => void
  onRegenerate: () => void
  /** Write on from the newest reply; the result rejoins that floor. */
  onContinue: () => void
  /** Have the model write the user's next line instead of a reply. */
  onImpersonate: () => void
  onEdit: (id: number, text: string) => void
  onDelete: (id: number) => void
  onNotify: (text: string) => void
  /** Show how this turn's request was assembled. */
  onExplain: (turn: number) => void
}

/**
 * Render one message.
 * @param props.message - the view to render.
 * @param props.canRegenerate - whether this is the row a retry would replace.
 * @param props.handlers - the actions the row offers.
 * @returns the message row.
 */
export function Message({
  message,
  canRegenerate,
  handlers,
}: {
  message: MessageView
  canRegenerate: boolean
  handlers: MessageHandlers
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.text)
  const field = useRef<HTMLTextAreaElement>(null)
  // Subscribed so a language switch re-renders the row's actions.
  useLanguage()

  useEffect(() => {
    if (editing) field.current?.focus()
  }, [editing])

  const streaming = message.streaming === true
  const swipes = message.swipes
  const turn = message.turn

  const beginEdit = (): void => {
    setDraft(message.text)
    setEditing(true)
  }

  const commit = (): void => {
    setEditing(false)
    if (draft !== message.text) handlers.onEdit(message.id, draft)
  }

  return (
    <article className={`iris-msg iris-msg--${message.role}`}>
      <div className="iris-msg__margin">
        {message.role === 'assistant' && swipes !== undefined && turn !== undefined ? (
          <VariantRail
            count={swipes.count}
            index={swipes.index}
            interactive={canRegenerate}
            onSelect={index => handlers.onSwipe(turn, index)}
          />
        ) : null}
        {/*
          The floor's number (upstream's `mesIDDisplay_enabled`, which the
          measured profile turned on). Rendered whenever there is a floor to
          name; the reading preference decides whether it shows, so toggling it
          never remounts a row.
        */}
        <span className="iris-msg__floor" aria-hidden="true">#{message.id}</span>
      </div>

      <div className="iris-msg__body">
        <div className="iris-msg__who">{message.name}</div>

        {message.reasoning !== undefined ? (
          <Reasoning text={message.reasoning} streaming={streaming && message.text === ''} />
        ) : null}

        {editing ? (
          <>
            <textarea
              ref={field}
              className="iris-edit"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') setEditing(false)
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commit()
              }}
            />
            <div className="iris-actions iris-actions--shown">
              <button type="button" className="iris-act" onClick={commit}>
                {t('save')}
              </button>
              <button type="button" className="iris-act" onClick={() => setEditing(false)}>
                {t('cancel')}
              </button>
            </div>
          </>
        ) : (
          <>
            {/*
              Keyed by the visible reading. A swipe therefore remounts this div,
              which is what replays the slip — the animation is attached to mount
              rather than toggled by a class, so it cannot get out of step with
              the state, and streaming (same key throughout) never replays it.
            */}
            <div key={swipes?.index ?? 0} className="iris-msg__text iris-msg__text--enter">
              {message.role === 'assistant' ? (
                /*
                 * The assistant body goes through `MessageInterfaces`, which
                 * renders the markdown itself and puts a card interface **in
                 * place of** the block that declares it. Rendering `MarkdownText`
                 * here as well would show 360 KiB of source above the interface
                 * it describes, which is what the first cut did.
                 */
                <MessageInterfaces floor={message.id} text={message.text} streaming={streaming} />
              ) : (
                message.text
              )}
              {streaming ? <span className="iris-caret" aria-label={t('generatingAria')} /> : null}
            </div>
            <Slot name="iris.message.footer" owner={{ message, streaming }} />

            <div className="iris-actions">
              <button
                type="button"
                className="iris-act"
                onClick={() => {
                  void writeClipboard(message.text)
                  handlers.onNotify(t('copied'))
                }}
              >
                {t('copy')}
              </button>
              <button type="button" className="iris-act" onClick={beginEdit}>
                {t('edit')}
              </button>
              {message.role === 'assistant' && turn !== undefined ? (
                <button type="button" className="iris-act" onClick={() => handlers.onExplain(turn)}>
                  {t('promptButton')}
                </button>
              ) : null}
              {canRegenerate ? (
                <>
                  {/*
                    The two generation kinds that act on this floor without
                    replacing it: a continue writes on from THIS reading (the
                    result rejoins it as a new one), and an impersonation has
                    the model write the reader's next line. Both live beside
                    regenerate because they answer the same question — what
                    happens next — just from different seats.
                  */}
                  <button type="button" className="iris-act" onClick={handlers.onContinue}>
                    {t('continueWriting')}
                  </button>
                  <button type="button" className="iris-act" onClick={handlers.onImpersonate}>
                    {t('speakForMe')}
                  </button>
                  <button
                    type="button"
                    className="iris-act iris-act--primary"
                    onClick={handlers.onRegenerate}
                  >
                    {t('regenerate')}
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="iris-act iris-act--danger"
                onClick={() => handlers.onDelete(message.id)}
              >
                {t('delete')}
              </button>
              {/*
                Provider-contributed actions (the `iris.message.actions`
                seam), folded into one menu so the row's layout does not
                depend on how many providers are installed. Renders nothing —
                literally nothing, no wrapper — when none are.
              */}
              <MessageActions message={message} streaming={streaming} notify={handlers.onNotify} />
            </div>
          </>
        )}
      </div>
    </article>
  )
}
