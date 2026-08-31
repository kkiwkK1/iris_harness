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
import { MarkdownText, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MessageView } from '@iris/protocol'

import { Slot } from '../slots/Slot.tsx'
import { Reasoning } from './Reasoning.tsx'
import { VariantRail } from './VariantRail.tsx'

/** What a message row can do, supplied by the pane that owns the chat. */
export interface MessageHandlers {
  onSwipe: (turn: number, index: number) => void
  onRegenerate: () => void
  onEdit: (id: number, text: string) => void
  onDelete: (id: number) => void
  onNotify: (text: string) => void
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
                Save
              </button>
              <button type="button" className="iris-act" onClick={() => setEditing(false)}>
                Cancel
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
                <MarkdownText text={message.text} streaming={streaming} />
              ) : (
                message.text
              )}
              {streaming ? <span className="iris-caret" aria-label="Generating" /> : null}
            </div>

            <Slot name="iris.message.footer" owner={{ message, streaming }} />

            <div className="iris-actions">
              <button
                type="button"
                className="iris-act"
                onClick={() => {
                  void writeClipboard(message.text)
                  handlers.onNotify('Copied.')
                }}
              >
                Copy
              </button>
              <button type="button" className="iris-act" onClick={beginEdit}>
                Edit
              </button>
              {canRegenerate ? (
                <button
                  type="button"
                  className="iris-act iris-act--primary"
                  onClick={handlers.onRegenerate}
                >
                  Regenerate
                </button>
              ) : null}
              <button
                type="button"
                className="iris-act iris-act--danger"
                onClick={() => handlers.onDelete(message.id)}
              >
                Delete
              </button>
              <Slot name="iris.message.actions" owner={{ message, streaming }} />
            </div>
          </>
        )}
      </div>
    </article>
  )
}
