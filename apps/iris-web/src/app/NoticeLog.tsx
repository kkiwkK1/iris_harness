/**
 * Every notice this session raised, after the bar has forgotten it.
 *
 * **Why this exists, precisely.** The notice bar shows one message and clears
 * itself — 3.2 seconds for an `info`, 8 for an `error`. That is right for
 * interrupting someone and useless for anyone who was not watching at that
 * moment, which includes every verification pass: two acceptance rounds were
 * spent scanning the DOM for notices that had certainly fired and had already
 * gone. The evidence existed for three seconds and nothing kept it.
 *
 * So the bar keeps its behaviour and gains a record. This is the argument the
 * card report list was built on, applied to the last channel with no memory.
 *
 * **Repeats collapse into a count, within a short window.** The log used to
 * keep every arrival, because the same sentence arriving twice is two events.
 * The reconnect schedule refuted the absolute form of that: during a host
 * restart it raises "the Iris event socket failed" every few seconds, and the
 * panel filled with identical rows — one outage, four entries, no more
 * information per entry than the first. So identical neighbours inside the
 * store's dedup window render as one row with `×N`; a *recurrence* still shows
 * itself as a number, which is the part that was worth keeping. The same
 * sentence after the window is a separate row, as before.
 *
 * Transport errors — the one species the client survives on its own — show
 * whether they healed: resolved rows dim and name themselves, because a
 * standing red row for an outage that already ended teaches the reader to
 * ignore the red rows that matter.
 *
 * @module iris-web/app/NoticeLog
 */

import type { ReactElement } from 'react'

import { NOTICE_LOG_LIMIT } from '../client/store.ts'
import { reportRowClass } from './host-report-rows.ts'
import { useIris } from '../client/provider.tsx'
import { useLanguage, t } from './i18n/use-language.ts'

/** A local time, to the second. */
function timeOf(at: number): string {
  try {
    return new Date(at).toLocaleTimeString()
  } catch {
    return String(at)
  }
}

/**
 * The notice history.
 *
 * @returns the section.
 */
export function NoticeLog(): ReactElement {
  const log = useIris(state => state.noticeLog)
  const dropped = useIris(state => state.noticesDropped)
  // Subscribed so a language switch re-renders the section's words. The notice
  // bodies stay as they were announced — quoted evidence, not copy.
  useLanguage()

  return (
    <section className="iris-notices">
      <span className="iris-field__label">{t('noticesHead')}</span>

      {log.length === 0 ? (
        <p className="iris-field__note">{t('noticesEmpty')}</p>
      ) : (
        <ol className="iris-notices__list">
          {/*
            Newest first here, oldest first in the store. The store's order is
            the order things happened, which is what `slice(-N)` needs; a reader
            opening this panel wants the most recent thing at the top.
          */}
          {[...log].reverse().map(notice => (
            <li
              key={notice.seq}
              /*
                The class names come from one place; which field decides is
                this list's own business — here it is the notice's kind, dimmed
                when the thing it reported has already healed itself.
              */
              className={[
                reportRowClass(notice.kind === 'error'),
                notice.resolved ? 'iris-notices__row--resolved' : '',
              ].filter(Boolean).join(' ')}
            >
              <span className="iris-reports__at">{timeOf(notice.at)}</span>
              <span className="iris-reports__message">{notice.text}</span>
              {/*
                The recurrence count, and the healed mark. Both are facts the
                row holds so the reader does not reconstruct them.
              */}
              {notice.count !== undefined && notice.count > 1 && (
                <span
                  className="iris-notices__times"
                  aria-label={t('noticeRepeatAria', { n: notice.count })}
                >
                  ×{notice.count}
                </span>
              )}
              {notice.resolved && (
                <span className="iris-notices__healed">{t('stateSelfHealed')}</span>
              )}
            </li>
          ))}
        </ol>
      )}

      {/*
        Said when it becomes true, because a bounded list that quietly forgets is
        a list someone will read as complete — and said with the **count**,
        which is why the store keeps one.

        `log.length >= LIMIT` was the first condition here and it is off by one:
        at exactly the limit nothing has been dropped yet, so the panel claimed
        a loss that had not happened. A sentence that is false at the moment it
        first appears is worse than no sentence, because it is the instrument
        talking about itself.
      */}
      {dropped > 0 && (
        <p className="iris-field__note">
          {dropped === 1
            ? t('noticesDroppedOne', { n: NOTICE_LOG_LIMIT })
            : t('noticesDropped', { n: dropped })}
        </p>
      )}
    </section>
  )
}
