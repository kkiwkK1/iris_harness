/**
 * The row that says an early span of this conversation is being sent as a summary.
 *
 * Transcribed from deepseek-harness (MIT),
 * `packages/client/ui-chat/src/client/chat/CompactionItem.tsx`: a single
 * collapsed row naming what was folded and how much it cost, expanding to the
 * checkpoint's own text. Its opening comment is the property worth copying —
 * *"a compaction marker does not replace shadowed transcript rows"* — and it is
 * the same property here for a stronger reason: in Iris nothing was removed
 * from the chat file at all, so every folded floor is still on the page below
 * this row. See `THIRD-PARTY-NOTICES.md`.
 *
 * **At the top of the column rather than spliced between two floors**, which is
 * the one placement decision that is Iris's. The obvious position is after the
 * last folded floor, and it cannot be used: the reading surface mounts a tail
 * (`reading-window.ts`), so on any conversation long enough to be worth
 * compacting the boundary is above the mounted rows and a marker placed there
 * would not render at all. A reader asking "what happened to the beginning"
 * looks at the beginning, and this is the beginning.
 *
 * @module iris-web/app/CompactionNote
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import type { ChatCompaction } from '@iris/protocol'

import { formatTokens } from './token-format.ts'
import { t, useLanguage } from './i18n/use-language.ts'

/**
 * Render the marker.
 * @param props.compaction - the record on the open conversation.
 * @returns the row, collapsed until pressed.
 */
export function CompactionNote({ compaction }: { compaction: ChatCompaction }): ReactElement {
  useLanguage()
  const [open, setOpen] = useState(false)
  return (
    <div className="iris-compacted" data-control="compaction-note">
      <button
        type="button"
        className="iris-compacted__head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="iris-compacted__mark" aria-hidden="true">{open ? '−' : '+'}</span>
        <span className="iris-compacted__title">
          {t('compactedTitle', { floors: compaction.count })}
        </span>
        <span className="iris-compacted__figures">
          {t('compactedFigures', {
            before: formatTokens(compaction.spanTokens),
            after: formatTokens(compaction.summaryTokens),
          })}
        </span>
      </button>
      {/*
        The one sentence a reader needs and the interface would otherwise hide:
        the floors are still here. Inside the disclosure rather than on the
        collapsed row, because the collapsed row has to stay one line and this
        is the answer to a question only a reader who opened it is asking.
      */}
      {open
        ? (
            <div className="iris-compacted__body">
              <p className="iris-compacted__kept">{t('compactedKept')}</p>
              <pre className="iris-compacted__summary">{compaction.summary}</pre>
            </div>
          )
        : null}
    </div>
  )
}
