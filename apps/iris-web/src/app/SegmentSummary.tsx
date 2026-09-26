/**
 * The tree map's segment-summary layer: a hover card per branch segment, the
 * invisible hover targets along the lanes, and the header's 「总结所有分支段」.
 *
 * A **segment** is a run of floors between fork points (`segmentsOf` in
 * `@iris/protocol`). Hovering one — the folded "⋯ 29 层" row, or a lane
 * between two dots — shows a card anchored under it with the floor range,
 * the summary and when it was written; a stale summary says so and offers
 * 「重新总结」, a missing one offers 「总结这一段」. Keyboard: the folded row's
 * button, a floor label and a lane's name open the card on focus, Tab walks
 * into it, Escape closes it.
 *
 * **Nothing here generates on hover.** Every summary is a billed model call, so
 * the card reads what is stored and only a button press asks for more
 * (coordinator ruling, 2026-09-26).
 *
 * The decisions are in `segment-summary.ts`; this file renders them.
 *
 * @module iris-web/app/SegmentSummary
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { segmentsOf, type ChatSegment, type ChatTreeView, type SegmentSummaryView } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { segmentKey } from '../client/segment-summaries.ts'
import { pendingSegments, summaryOf, type SegmentHit } from './segment-summary.ts'
import { t, useLanguage } from './i18n/use-language.ts'

/** How long the pointer may be away from a trigger and its card before the card closes. */
const CLOSE_DELAY_MS = 180

/**
 * Keep the family's summaries fresh: after the lineage is re-read, and after
 * the open conversation's view changes (an edit or a swipe is exactly what
 * makes a summary stale). A read, so it costs nothing; settled briefly so a
 * burst of view updates asks once.
 */
export function useSegmentSummarySync(): void {
  const tree = useIris(state => state.tree)
  const chatId = useIris(state => state.chatId)
  const view = useIris(state => state.view)
  const actions = useIrisActions()
  useEffect(() => {
    if (chatId === undefined || tree === undefined || !tree.chats.some(node => node.chatId === chatId)) return
    const timer = setTimeout(() => { void actions.loadSegmentSummaries(chatId) }, 120)
    return () => clearTimeout(timer)
  }, [actions, chatId, tree, view])
}

/**
 * The family's summaries, when the stored answer is about the lineage on screen.
 * @param tree - the lineage on screen.
 * @returns the summaries, empty when none are known for it.
 */
export function useFamilySummaries(tree: ChatTreeView | undefined): SegmentSummaryView[] {
  const stored = useIris(state => state.segmentSummaries)
  if (tree === undefined || stored === undefined) return []
  return tree.chats.some(node => node.chatId === stored.chatId) ? stored.summaries : []
}

/** Which card is open, and under which row of the map. */
export interface SegmentHoverOpen {
  segments: ChatSegment[]
  /** The row the card is drawn under. */
  row: number
  /** The hint a folded row adds (where a click on it goes). */
  hint?: string
}

/** The open card and the handlers that move it. */
export interface SegmentHover {
  open: SegmentHoverOpen | undefined
  /** The card's element id, for the trigger's `aria-describedby`. */
  id: string
  show: (open: SegmentHoverOpen) => void
  /** The pointer or focus left a trigger or the card: close unless it arrives at the other. */
  leave: () => void
  /** The pointer or focus arrived at the card: keep it. */
  stay: () => void
  close: () => void
}

/**
 * The hover card's controller: one card at a time, closing a moment after the
 * pointer leaves so it can travel from the lane into the card's button.
 * @returns the controller.
 */
export function useSegmentHover(): SegmentHover {
  const [open, setOpen] = useState<SegmentHoverOpen | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const id = useId()
  const stay = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
  }, [])
  const show = useCallback((next: SegmentHoverOpen) => {
    stay()
    setOpen(current => (current !== undefined && current.row === next.row
      && current.segments.map(segmentKey).join() === next.segments.map(segmentKey).join() ? current : next))
  }, [stay])
  const close = useCallback(() => {
    stay()
    setOpen(undefined)
  }, [stay])
  const leave = useCallback(() => {
    stay()
    timer.current = setTimeout(() => {
      timer.current = undefined
      setOpen(undefined)
    }, CLOSE_DELAY_MS)
  }, [stay])
  useEffect(() => stay, [stay])
  return { open, id: `iris-seg-card-${id}`, show, leave, stay, close }
}

/**
 * Whether an element was focused by the keyboard, so a focus opens the card
 * only where a hover would have. A browser without `:focus-visible` (or a DOM
 * without selectors, under test) counts every focus.
 */
export function focusedByKeyboard(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}

/**
 * The invisible hover targets along the lanes: one per segment, from the
 * centre of its first row to the centre of its last, under the dots so a
 * dot's click still lands. A one-floor segment is a zero-length path whose
 * round cap makes a ring round its dot.
 */
export function SegmentHits({
  hits,
  x,
  centre,
  hover,
}: {
  hits: readonly SegmentHit[]
  x: (lane: number) => number
  centre: (index: number) => number
  hover: SegmentHover
}): ReactElement {
  return (
    <g className="iris-tree__segs">
      {hits.map(hit => {
        const lx = String(x(hit.lane))
        return (
          <path
            key={segmentKey(hit.segment)}
            className="iris-tree__seg-hit"
            data-segment={segmentKey(hit.segment)}
            d={`M ${lx} ${String(centre(hit.top))} L ${lx} ${String(centre(hit.bottom))}`}
            onPointerEnter={() => hover.show({ segments: [hit.segment], row: hit.bottom })}
            onPointerLeave={hover.leave}
          />
        )
      })}
    </g>
  )
}

/** A moment, in the reader's language. */
function when(at: number, lang: string): string {
  return new Date(at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * The hover card.
 * @param props.hover - the controller; the card shows `hover.open`.
 * @param props.chatId - the conversation on screen, which asks (and is billed).
 * @param props.top - where the card goes, in the rows' own coordinates.
 * @param props.titles - lane titles by chat id, named when the card holds several lanes.
 * @param props.summaries - the family's summaries.
 * @returns the card.
 */
export function SegmentCard({
  hover,
  chatId,
  top,
  titles,
  summaries,
}: {
  hover: SegmentHover
  chatId: string
  top: number
  titles: ReadonlyMap<string, string>
  summaries: readonly SegmentSummaryView[]
}): ReactElement | null {
  const busy = useIris(state => state.segmentBusy)
  const errors = useIris(state => state.segmentErrors)
  const actions = useIrisActions()
  const { lang } = useLanguage()
  const open = hover.open
  if (open === undefined) return null
  const many = open.segments.length > 1
  return (
    <div
      id={hover.id}
      className="iris-seg-card"
      role="group"
      aria-label={t('segAria', { from: open.segments[0]?.from ?? 0, to: open.segments[0]?.to ?? 0 })}
      style={{ top }}
      onPointerEnter={hover.stay}
      onPointerLeave={hover.leave}
      onFocus={hover.stay}
      onBlur={event => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) hover.leave()
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          hover.close()
        }
      }}
    >
      {open.segments.map(segment => {
        const key = segmentKey(segment)
        const summary = summaryOf(summaries, segment)
        const working = busy.includes(key)
        const error = errors[key]
        return (
          <section key={key} className="iris-seg-card__item" data-segment={key} data-stale={summary?.stale === true ? '' : undefined}>
            <header className="iris-seg-card__head">
              {many ? <span className="iris-seg-card__lane">{titles.get(segment.chatId) ?? segment.chatId}</span> : null}
              <span className="iris-seg-card__range">
                {t('segHead', { from: segment.from, to: segment.to, n: segment.to - segment.from + 1 })}
              </span>
            </header>
            {summary === undefined
              ? <p className="iris-seg-card__none">{t('segNone')}</p>
              : <p className="iris-seg-card__text">{summary.summary}</p>}
            {summary?.stale === true ? <p className="iris-seg-card__stale">{t('segStale')}</p> : null}
            {summary === undefined ? null : (
              <p className="iris-seg-card__meta">
                {summary.model === undefined
                  ? t('segAt', { time: when(summary.at, lang) })
                  : t('segAtModel', { time: when(summary.at, lang), model: summary.model })}
              </p>
            )}
            {error === undefined ? null : <p className="iris-seg-card__error" role="alert">{error}</p>}
            {working ? <p className="iris-seg-card__busy" aria-live="polite">{t('segBusy')}</p> : summary !== undefined && !summary.stale ? null : (
              <div className="iris-seg-card__actions">
                <button
                  type="button"
                  className="iris-seg-card__go"
                  data-control="segment-summarize"
                  title={t('segCost')}
                  onClick={() => { void actions.summarizeSegment(chatId, segment) }}
                >
                  {summary === undefined ? t('segSummarize') : t('segResummarize')}
                </button>
              </div>
            )}
          </section>
        )
      })}
      {open.hint === undefined ? null : <p className="iris-seg-card__hint">{open.hint}</p>}
    </div>
  )
}

/**
 * The header's 「总结所有分支段」: confirm first (how many, how many of them
 * re-summaries), then one request at a time, with a stop while it runs.
 * @returns the control, or nothing while no lineage is on screen.
 */
export function SummarizeAllButton(): ReactElement | null {
  const tree = useIris(state => state.tree)
  const chatId = useIris(state => state.chatId)
  const run = useIris(state => state.segmentRun)
  const summaries = useFamilySummaries(tree)
  const actions = useIrisActions()
  const [asking, setAsking] = useState(false)
  useLanguage()
  const segments = useMemo(() => (tree === undefined ? [] : segmentsOf(tree)), [tree])
  if (chatId === undefined || tree === undefined || !tree.chats.some(node => node.chatId === chatId)) return null
  if (segments.length === 0) return null

  if (run !== undefined) {
    return (
      <button
        type="button"
        className="iris-seg-all"
        data-running=""
        data-control="segment-summarize-stop"
        aria-label={t('segAllStopAria', { done: run.done, total: run.total })}
        onClick={() => { void actions.cancelSegmentRun() }}
      >
        {t('segAllRunning', { done: run.done, total: run.total })}
      </button>
    )
  }

  const pending = pendingSegments(segments, summaries)
  const n = pending.segments.length
  return (
    <>
      <button
        type="button"
        className="iris-seg-all"
        data-control="segment-summarize-all"
        disabled={n === 0}
        title={n === 0 ? t('segAllNone') : t('segAllTip')}
        onClick={() => setAsking(true)}
      >
        {t('segAll')}
      </button>
      {!asking ? null : (
        <Modal open onClose={() => setAsking(false)} title={t('segAllTitle')} closeLabel={t('close')} className="iris-seg-confirm">
          <div className="iris-seg-confirm__body">
            <p>{t('segAllBody', { n })}</p>
            {pending.stale === 0 ? null : <p>{t('segAllBodyStale', { m: pending.stale })}</p>}
          </div>
          <div className="iris-seg-confirm__actions">
            <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>{t('cancel')}</Button>
            <Button
              variant="outline"
              size="sm"
              data-control="segment-summarize-all-confirm"
              onClick={() => {
                setAsking(false)
                void actions.summarizeAllSegments(chatId, pending.segments)
              }}
            >
              {t('segAllGo', { n })}
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}
