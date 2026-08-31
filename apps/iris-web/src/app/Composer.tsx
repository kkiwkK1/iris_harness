/**
 * Where the reader writes their part.
 *
 * One field, one hairline, and the send affordance as text rather than as a
 * coloured circle — this sits under a page of prose, and a saturated button
 * would be the loudest thing on the screen. It grows with the draft up to a
 * cap, because a reader writing three paragraphs of scene should see them.
 *
 * @module iris-web/app/Composer
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { Slot } from '../slots/Slot.tsx'

/**
 * Render the composer.
 * @param props.chatId - the open chat, for extension contributions.
 * @param props.generating - whether a reply is arriving; Send becomes Stop.
 * @param props.onSend - called with the trimmed draft.
 * @param props.onStop - called to interrupt the reply in flight.
 * @returns the composer.
 */
export function Composer({
  chatId,
  generating,
  onSend,
  onStop,
}: {
  chatId: string
  generating: boolean
  onSend: (text: string) => void
  onStop: () => void
}): ReactElement {
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)

  // Grow to fit. Measured in a layout effect rather than tracked as state: the
  // height is a function of the text, and holding it in state means a render
  // where the box and its contents disagree.
  useLayoutEffect(() => {
    const node = field.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [draft])

  // Focus follows the chat: opening a conversation puts the cursor where the
  // reader is going to type next.
  useEffect(() => {
    field.current?.focus()
  }, [chatId])

  const empty = draft.trim() === ''

  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || generating) return
    setDraft('')
    onSend(text)
  }

  return (
    <div className="iris-composer">
      <div className="iris-composer__inner">
        <textarea
          ref={field}
          className="iris-composer__field"
          rows={1}
          value={draft}
          placeholder={generating ? 'Iris is writing…' : 'Write your part…'}
          aria-label="Your message"
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="iris-composer__row">
          <Slot name="iris.composer.actions" owner={{ chatId, generating }} />
          <span className="iris-composer__hint">
            Enter sends · Shift+Enter for a new line · Alt+←/→ changes reading
          </span>
          {generating ? (
            <Button variant="outline" size="sm" onClick={onStop}>
              Stop
            </Button>
          ) : (
            // Quiet until there is something to send, saturated once there is.
            // A permanently-disabled primary button was the first thing on the
            // page and it read as broken; this way the single saturated element
            // in the interface appears exactly when it has a job.
            <Button
              variant={empty ? 'outline' : 'primary'}
              size="sm"
              onClick={submit}
              disabled={empty}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
