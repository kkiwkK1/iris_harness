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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { buttonEventName } from '../sandbox/button-event.ts'
import { emitToCard } from './card-bus.ts'
import { Composer } from './Composer.tsx'
import { Message, type MessageHandlers } from './Message.tsx'
import { PromptPanel } from './PromptPanel.tsx'
import { groupByTurn, lastReplyId, swipeTarget, withStream } from './project.ts'
import { DEFAULT_WINDOW, grow, readingWindow } from './reading-window.ts'
import { stepReading } from './rail.ts'

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

  const generating = stream !== undefined
  const all = useMemo(() => withStream(view, stream), [view, stream])

  /*
   * How much of the conversation is mounted. A tail, so a chat that grows
   * while the reader watches needs no recalculation — and so the anchor is the
   * end of the conversation, which is where a reader of a live chat already is.
   */
  const [shown, setShown] = useState(DEFAULT_WINDOW)
  const window_ = useMemo(() => readingWindow(all, shown), [all, shown])
  const messages = window_.visible
  const groups = useMemo(() => groupByTurn(messages), [messages])

  /*
   * A new chat starts at its own tail. Without this, opening a short
   * conversation after scrolling back through a long one would inherit the
   * widened window — harmless there, but it also means opening the long one
   * again would silently mount everything.
   */
  useEffect(() => {
    setShown(DEFAULT_WINDOW)
  }, [chatId])
  const retryId = lastReplyId(messages)

  // `undefined` means "preview the next request"; a number means "the record for
  // that turn". Both go to the same panel, which is why one piece of state
  // carries the distinction rather than two booleans that could disagree.
  const [explaining, setExplaining] = useState<{ turn: number | undefined } | undefined>(undefined)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  /** The load-more control, so a press can ask whether it was on screen. */
  const more = useRef<HTMLButtonElement>(null)

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
      // Not while the reader is typing. SillyTavern gates its own arrow-key
      // swipe on an empty composer and on focus being outside every input; the
      // second is the one that matters here, because it also covers an open
      // inline editor — changing a reading out from under a half-finished edit
      // would discard it silently.
      const focused = document.activeElement
      if (
        focused instanceof HTMLTextAreaElement ||
        focused instanceof HTMLInputElement ||
        (focused instanceof HTMLElement && focused.isContentEditable)
      ) {
        return
      }
      // Not while generating, for the same reason SillyTavern refuses: the turn
      // being written is about to replace what a swipe would have selected.
      if (generating) return
      // Same clamp the rail's own stepper uses, so the keyboard and the margin
      // cannot disagree about where the set ends.
      const next = stepReading(target.index, target.count, step)
      if (next === undefined) return
      event.preventDefault()
      void actions.swipe(target.turn, next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, generating, target?.turn, target?.count, target?.index])

  const handlers: MessageHandlers = useMemo(
    () => ({
      onSwipe: (turn, index) => void actions.swipe(turn, index),
      onRegenerate: () => void actions.regenerate(),
      onEdit: (id, text) => void actions.editMessage(id, text),
      onDelete: id => void actions.deleteMessage(id),
      onNotify: text => actions.notify('info', text),
      onExplain: turn => setExplaining({ turn }),
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
          {window_.hidden === 0 ? null : (
            <button
              type="button"
              ref={more}
              className="iris-more"
              onClick={() => {
                /*
                 * Compensate the scroll position **only if this button was
                 * visible when it was pressed** — upstream measures the same
                 * thing before adjusting (`script.js:1445`, used at `:1466`).
                 *
                 * What it defends against: content growing above the viewport
                 * pushes everything down, so a reader who is not looking at the
                 * top has the passage they *are* reading yanked away. When the
                 * button is on screen the reader is at the top and expects the
                 * new messages to appear where they are looking; when it is not,
                 * they pressed it by keyboard or from far away and the sane
                 * outcome is that nothing under their eyes moves.
                 *
                 * Written out because copying a defensive line without knowing
                 * what it defends is how it gets deleted in the next refactor.
                 */
                const scroller_ = scroller.current
                const button = more.current
                const wasVisible =
                  scroller_ !== null &&
                  button !== null &&
                  button.getBoundingClientRect().bottom > scroller_.getBoundingClientRect().top
                const before = scroller_?.scrollHeight ?? 0
                const at = scroller_?.scrollTop ?? 0

                setShown(current => grow(current, DEFAULT_WINDOW, all.length))

                if (!wasVisible || scroller_ === null) return
                // After the new rows land, keep the reader's passage where it was.
                requestAnimationFrame(() => {
                  scroller_.scrollTop = at + (scroller_.scrollHeight - before)
                })
              }}
            >
              {`Show ${String(Math.min(DEFAULT_WINDOW, window_.hidden))} earlier`}
              <span className="iris-more__count">
                {`${String(window_.hidden)} above`}
              </span>
            </button>
          )}
          {messages.length === 0 ? (
            <div className="iris-empty">
              <p className="iris-empty__line">The page is blank.</p>
              <p className="iris-empty__hint">Write the first line and {view.title} will answer.</p>
            </div>
          ) : (
            groups.map((group, at) => (
              <section className="iris-turn" key={group.turn ?? `loose-${at}`}>
                {/*
                  On the boundary, and only where there is one. The number names
                  the turn — the thing swipe and regenerate address — so it marks
                  where turns divide rather than being stamped on whichever rows
                  happen to be the reader's.
                */}
                {at > 0 && group.turn !== undefined ? (
                  <span className="iris-turn__ordinal" aria-hidden="true">
                    {group.turn}
                  </span>
                ) : null}
                {group.messages.map(message => (
                  <Message
                    // `key`, not `id`: `id` is a position, so a delete shifts
                    // every later one and React would carry this row's local
                    // state (an open editor) onto its neighbour. The streaming
                    // row deliberately shares the key its settled row will
                    // have, so a finished reply updates in place.
                    key={message.key}
                    message={message}
                    canRegenerate={message.id === retryId && !generating}
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
        generating={generating}
        onSend={text => void actions.send(text)}
        onStop={() => void actions.abort()}
        onPreviewPrompt={() => setExplaining({ turn: undefined })}
        onPressButton={button => {
          /*
           * The button id **is** the event name, computed here and computed
           * again by the card, with nothing checking that the two agree. When
           * they do not, the card's handler is simply never called — no error,
           * no warning, a button that does nothing. That is why the name comes
           * from one shared builder over one shared hash rather than being
           * assembled at either end.
           */
          const event = buttonEventName(button.scriptId, button.name)
          if (emitToCard(event)) return

          /*
           * Nothing was listening because no card is running — not the same as a
           * card that ignored it, and only this one is worth saying. A press that
           * vanishes silently is the failure this whole seam exists to avoid.
           */
          actions.addCardReport(
            `button "${button.name}" (${button.scriptName}) was pressed while no card scripts are running`,
          )
        }}
      />
      <PromptPanel
        open={explaining !== undefined}
        turn={explaining?.turn}
        onClose={() => setExplaining(undefined)}
      />
    </>
  )
}
