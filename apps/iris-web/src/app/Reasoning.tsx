/**
 * A reply's reasoning, treated as a footnote.
 *
 * Collapsed by default and set as a marginal note rather than a card: reasoning
 * is apparatus, not prose, and a reader following a scene should be able to
 * ignore it without it occupying a third of the page. The label carries a length
 * so the decision to expand is informed.
 *
 * @module iris-web/app/Reasoning
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { approximateWords } from './format.ts'

/**
 * Render the reasoning disclosure.
 * @param props.text - the trace.
 * @param props.streaming - whether it is still arriving; a trace that is still
 * growing opens itself, because watching a model think is the one time this
 * content is the main event.
 * @returns the disclosure, or null when there is no trace.
 */
export function Reasoning({ text, streaming }: { text: string, streaming: boolean }): ReactElement | null {
  const [open, setOpen] = useState(false)
  if (text.trim() === '') return null

  const shown = open || streaming
  return (
    <div className="iris-reason">
      <button
        type="button"
        className="iris-reason__toggle"
        aria-expanded={shown}
        onClick={() => setOpen(!open)}
      >
        <span className={`iris-reason__chevron${shown ? ' iris-reason__chevron--open' : ''}`} aria-hidden="true">
          ▸
        </span>
        {streaming ? 'Thinking' : `Reasoning · ${approximateWords(text)} words`}
      </button>
      {shown ? <div className="iris-reason__body">{text}</div> : null}
    </div>
  )
}
