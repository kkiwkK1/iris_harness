/**
 * The open conversation.
 *
 * Two behaviours here are worth more than they look. Autoscroll only follows
 * when the reader was already at the bottom — scrolling back to re-read a scene
 * while a reply streams must not yank them forward. And Alt+←/→ moves through a
 * turn's readings, addressed by turn rather than by message index, which is what
 * `chat.swipe` takes.
 *
 * @module iris-web/app/ChatPane
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ReactElement } from 'react'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Composer } from './Composer.tsx'
import { Message, type MessageHandlers } from './Message.tsx'
import { groupByTurn, lastReplyId, swipeTarget, withStream } from './project.ts'

/**
 * Render the conversation pane.
 * @returns the pane, or the empty surface when no chat is open.
 */
export function ChatPane(): ReactElement {
  const view = useIris(state => state.view)
  const stream = useIris(state => state.stream)
  const chatId = useIris(state => state.chatId)
  const booting = useIris(state => state.booting)
  const actions = useIrisActions()

  const messages = useMemo(() => withStream(view, stream), [view, stream])
  const groups = useMemo(() => groupByTurn(messages), [messages])
  const retryId = lastReplyId(messages)

  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const onScroll = useCallback(() => {
    const node = scroller.current
    if (node === null) return
    // 64px of slack: a reader who is "at the bottom" is rarely exactly there.
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
  }, [])

  useEffect(() => {
    const node = scroller.current
    if (node === null || !pinned.current) return
    node.scrollTop = node.scrollHeight
  }, [messages])

  // Opening a chat starts at the bottom, which is where the conversation is.
  useEffect(() => {
    pinned.current = true
    const node = scroller.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [chatId])

  const target = swipeTarget(messages)
  useEffect(() => {
    if (target === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return
      const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
      if (step === 0) return
      const next = target.index + step
      if (next < 0 || next >= target.count) return
      event.preventDefault()
      void actions.swipe(target.turn, next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, target?.turn, target?.count, target?.index])

  const handlers: MessageHandlers = useMemo(
    () => ({
      onSwipe: (turn, index) => void actions.swipe(turn, index),
      onRegenerate: () => void actions.regenerate(),
      onEdit: (id, text) => void actions.editMessage(id, text),
      onDelete: id => void actions.deleteMessage(id),
      onNotify: text => actions.notify('info', text),
    }),
    [actions],
  )

  if (chatId === undefined || view === undefined) {
    return (
      <div className="iris-scroll">
        <div className="iris-empty">
          <p className="iris-empty__line">
            {booting ? 'Opening your last conversation…' : 'Nothing open yet.'}
          </p>
          {booting ? null : (
            <p className="iris-empty__hint">Pick a character in the sidebar to begin a conversation.</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="iris-scroll" ref={scroller} onScroll={onScroll}>
        <div className="iris-column">
          {messages.length === 0 ? (
            <div className="iris-empty">
              <p className="iris-empty__line">The page is blank.</p>
              <p className="iris-empty__hint">Write the first line and {view.title} will answer.</p>
            </div>
          ) : (
            groups.map((group, at) => (
              <section className="iris-turn" key={group.turn ?? `loose-${at}`}>
                {group.messages.map(message => (
                  <Message
                    // `key`, not `id`: `id` is a position, so a delete shifts
                    // every later one and React would carry this row's local
                    // state (an open editor) onto its neighbour. The streaming
                    // row deliberately shares the key its settled row will
                    // have, so a finished reply updates in place.
                    key={message.key}
                    message={message}
                    canRegenerate={message.id === retryId && stream === undefined}
                    handlers={handlers}
                  />
                ))}
              </section>
            ))
          )}
        </div>
      </div>
      <Composer
        chatId={chatId}
        generating={stream !== undefined}
        onSend={text => void actions.send(text)}
        onStop={() => void actions.abort()}
      />
    </>
  )
}
