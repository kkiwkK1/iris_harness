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

import { useIris } from '../client/provider.tsx'
import type { ResolvedButton } from './script-buttons.ts'
import { Slot } from '../slots/Slot.tsx'
import { ScriptButtons } from './ScriptButtons.tsx'
import { registerComposer } from './composer-bus.ts'

/**
 * Render the composer.
 * @param props.chatId - the open chat, for extension contributions.
 * @param props.generating - whether a reply is arriving; Send becomes Stop.
 * @param props.onSend - called with the trimmed draft.
 * @param props.onStop - called to interrupt the reply in flight.
 * @param props.onPreviewPrompt - opens the breakdown of what would be sent next.
 * @returns the composer.
 */
export function Composer({
  chatId,
  generating,
  onSend,
  onStop,
  onPreviewPrompt,
  onPressButton,
}: {
  chatId: string
  generating: boolean
  onSend: (text: string) => void
  onStop: () => void
  onPreviewPrompt: () => void
  /**
   * Press one of the card-script buttons.
   *
   * A prop rather than something this component resolves, for the reason the
   * seam exists: the event name a press must emit is
   * `${scriptId}_${cyrb53(buttonName)}`, and that hash has to be bit-identical
   * to upstream’s or the card’s own listener is never called — silently. The
   * hash lives in one shared place; this file does not get a copy.
   */
  onPressButton: (button: ResolvedButton) => void
}): ReactElement {
  /*
   * Read here rather than threaded down. The script list is store state, and
   * this component already re-renders on every keystroke of the draft — one
   * more prop through that path is one more chance to hold a stale copy.
   */
  const scripts = useIris(state => state.scripts)
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

  /*
   * A card's way in, for the send path upstream gives it.
   *
   * Cards write `#send_textarea.value` and click `#send_but` — 44 measured that
   * in nine cards, eight of them from interface code — so Iris serves it rather
   * than refusing. What Iris adds is that the panel says it happened.
   *
   * **The send reads the field's DOM value, not `draft`.** In this build the
   * card's write already went through `setDraft`, so the two agree; the DOM is
   * the conservative source anyway, because it is what the *card* would have
   * seen and it is one indirection closer to what actually gets sent. It also
   * keeps this correct if anything ever writes the element directly, where
   * React's value tracker leaves `draft` stale.
   *
   * Re-registered whenever `generating` changes, so a card clicking send during
   * a generation is refused with the **current** answer rather than the one from
   * the render where it registered.
   */
  useEffect(() => registerComposer({
    setDraft: text => {
      setDraft(text)
    },
    send: () => {
      if (generating) return 'a generation is already running'
      const text = (field.current?.value ?? draft).trim()
      if (text === '') return 'the composer is empty, so there was nothing to send'
      setDraft('')
      onSend(text)
      return undefined
    },
  }), [generating, draft, onSend])

  return (
    <div className="iris-composer">
      <div className="iris-composer__inner">
        {/*
          * Above the field, which is where upstream puts it — it prepends its bar
          * to the send form. Inside `__inner` rather than beside it so the bar
          * lines up with the field's own left edge instead of the panel's.
          */}
        <ScriptButtons scripts={scripts} onPress={onPressButton} />
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
          {/* Beside the composer because that is where "what will be sent" lives.
              The per-turn record hangs off each message instead. */}
          <button type="button" className="iris-act" onClick={onPreviewPrompt}>
            Prompt
          </button>
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
