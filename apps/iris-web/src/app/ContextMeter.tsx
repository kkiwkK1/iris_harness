/**
 * How full the context window is, under the composer.
 *
 * Transcribed from deepseek-harness (MIT),
 * `packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx`: a
 * quiet reading beside the send affordance that opens a panel with the
 * breakdown — the headline reading, one proportion bar whose overall length is
 * the exact occupancy, a legend of coloured rows, and the panel's own
 * dismissal on outside pointerdown or Escape (one document listener each,
 * only while open). See `THIRD-PARTY-NOTICES.md`.
 *
 * Three things are Iris's rather than the harness's.
 *
 * **The trigger is a capsule, not a ring.** The composer's row already states
 * what is in force as capsules — the prompt and the model — and each answers
 * the question it raises when pressed. A third capsule is the shape that row
 * already has; a progress ring beside them would be a fourth vocabulary in a
 * strip of two.
 *
 * **It is split in two components on purpose.** `.iris-composer__inner` is a
 * scroll container (`panels.css` says why: it reserves the scrollbar lane so
 * the field's edges match the prose above), and a scroll container clips its
 * absolutely-positioned children. So the capsule lives in the row and the card
 * is a sibling of the plum branch, at `.iris-composer` level, which has no
 * overflow for exactly this reason. That is also why there is no portal: the
 * card is positioned by CSS against a box that is already `position: relative`.
 *
 * **The reading is fetched, not derived.** An itemization is a full world-info
 * scan and a macro pass, so it is asked for **when the card opens** and kept
 * until the conversation changes underneath it — never on a render, and never
 * on a keystroke. Which is also why the capsule states the capacity alone
 * until it has been pressed once: that is a fact the view already carries, and
 * a capsule that showed nothing until a round trip completed would be a control
 * that looks broken.
 *
 * @module iris-web/app/ContextMeter
 */

import { useEffect, useRef } from 'react'
import type { MutableRefObject, ReactElement } from 'react'

import type { PromptItemization, TurnUsage } from '@iris/protocol'

import {
  averageCacheHit,
  contextOccupancy,
  meterSegments,
  stablePrefix,
  type ContextCategory,
  type ContextOccupancy,
} from './context-occupancy.ts'
import { formatExactTokens, formatTokens } from './token-format.ts'
import { t, useLanguage } from './i18n/use-language.ts'
import type { StringKey } from './i18n/strings.ts'

/**
 * The word for each category, and its tint class.
 *
 * One table, read by the bar and the legend both, so a segment and its swatch
 * cannot come to disagree about which colour means which source.
 */
const CATEGORY_ROWS: readonly { category: ContextCategory, label: StringKey }[] = [
  { category: 'messages', label: 'contextCategoryMessages' },
  { category: 'worldbook', label: 'contextCategoryWorldbook' },
  { category: 'preset', label: 'contextCategoryPreset' },
  { category: 'character', label: 'contextCategoryCharacter' },
  { category: 'script', label: 'contextCategoryScript' },
  { category: 'other', label: 'contextCategoryOther' },
]

/**
 * A percentage for a share between 0 and 1.
 *
 * `PromptPanel`'s own `percent` helper, not `token-format.ts`: the panel and
 * this card sit one press apart and print the same kind of figure, and the one
 * property that matters is shared — a part that exists never rounds to `0%`,
 * it reads `<1%`.
 * @param share - 0–1.
 * @returns the display string, with its sign.
 */
function percent(share: number): string {
  const value = share * 100
  if (value >= 10) return `${String(Math.round(value))}%`
  if (value >= 1) return `${value.toFixed(1)}%`
  return value === 0 ? '0%' : '<1%'
}

/** What the capsule needs. */
export interface ContextPillProps {
  budget: { context: number, reserve: number }
  /** The reading, once the card has been opened for this conversation. */
  itemization: PromptItemization | undefined
  open: boolean
  onToggle: () => void
  anchor: MutableRefObject<HTMLButtonElement | null>
}

/**
 * The capsule in the composer's row.
 *
 * Renders only when a budget is known. That is not defensive: `ChatView.budget`
 * is absent when whoever projected the view had no settings to resolve, and a
 * capsule reading 「上下文 0」 would be a confident statement about a window
 * nobody measured.
 * @param props - the budget, the reading if there is one, and the open state.
 * @returns the capsule, or null when there is no capacity to report.
 */
export function ContextPill({
  budget,
  itemization,
  open,
  onToggle,
  anchor,
}: ContextPillProps): ReactElement | null {
  useLanguage()
  const available = Math.max(0, budget.context - budget.reserve)
  if (available === 0) return null
  const occupancy = contextOccupancy(itemization)
  const label = occupancy === null
    ? t('contextPillCapacity', { total: formatTokens(available) })
    : t('contextPill', {
      used: formatTokens(occupancy.usedTokens),
      total: formatTokens(available),
      percent: String(occupancy.percent),
    })
  return (
    <button
      ref={anchor}
      type="button"
      className={`iris-composer__pill iris-composer__pill--action${
        occupancy?.over === true ? ' iris-composer__pill--over' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={t('contextPillTitle')}
      data-control="context-meter"
      onClick={onToggle}
    >
      {label}
    </button>
  )
}

/** What the card needs. */
export interface ContextCardProps {
  budget: { context: number, reserve: number }
  itemization: PromptItemization | undefined
  /** Why there is no reading yet, or why the last attempt failed. */
  state: 'loading' | 'ready' | { error: string }
  /** The conversation's summed usage, for the cache-hit line. */
  usage: TurnUsage | undefined
  /** The capsule, so a press on it is not treated as a press outside the card. */
  anchor: MutableRefObject<HTMLButtonElement | null>
  onClose: () => void
}

/**
 * The breakdown card, above the composer.
 * @param props - the reading, its state, and how to dismiss.
 * @returns the card.
 */
export function ContextCard({
  budget,
  itemization,
  state,
  usage,
  anchor,
  onClose,
}: ContextCardProps): ReactElement {
  useLanguage()
  const root = useRef<HTMLDivElement | null>(null)

  // The harness's dismissal, transcribed: one document listener each while
  // open. A pointerdown inside the card or on the capsule is not "outside" —
  // the capsule has to be excluded explicitly, or its own press would close
  // the card on pointerdown and its click would reopen it, leaving a toggle
  // that never toggles.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (root.current?.contains(target) === true) return
      if (anchor.current?.contains(target) === true) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor, onClose])

  const occupancy = contextOccupancy(itemization)
  return (
    <div
      ref={root}
      className="iris-context-card"
      role="dialog"
      aria-label={t('contextCardTitle')}
      data-control="context-card"
    >
      {occupancy === null
        ? (
            // Two answers for one absence: the host refused, or it has not
            // answered yet. `'ready'` cannot reach here — it is set together
            // with the itemization — so it falls in with the waiting case
            // rather than getting a third sentence nobody would ever read.
            <p className="iris-context-card__note">
              {typeof state === 'object'
                ? t('contextCardFailed', { reason: state.error })
                : t('contextCardLoading')}
            </p>
          )
        : <ContextBody occupancy={occupancy} itemization={itemization} usage={usage} reserve={budget.reserve} />}
    </div>
  )
}

/**
 * The card's contents once there is a reading.
 *
 * Split out so the loading and failed states above stay one line each, and so
 * the branch that has data is not nested three deep inside the branch that does
 * not.
 * @param props - the reading and what to say around it.
 * @returns the body.
 */
function ContextBody({
  occupancy,
  itemization,
  usage,
  reserve,
}: {
  occupancy: ContextOccupancy
  itemization: PromptItemization | undefined
  usage: TurnUsage | undefined
  reserve: number
}): ReactElement {
  const segments = meterSegments(occupancy)
  const cacheHit = averageCacheHit(usage)
  const prefix = stablePrefix(itemization)
  const remaining = Math.max(0, occupancy.available - occupancy.usedTokens)
  const byCategory = new Map(occupancy.categories.map(row => [row.category, row]))
  return (
    <>
      <div className="iris-context-card__head">
        <span className="iris-label">{t('contextCardTitle')}</span>
        <span className="iris-context-card__figures">
          {t('contextCardFigures', {
            used: formatExactTokens(occupancy.usedTokens),
            total: formatExactTokens(occupancy.available),
            percent: String(occupancy.percent),
          })}
        </span>
      </div>
      {/*
        The bar's overall length is the exact occupancy and the categories only
        divide that length — the harness's rule, and the reason the two can
        never disagree with the percentage printed above. A zero-width part is
        dropped rather than drawn: the `min-width` that keeps a genuinely small
        part visible would otherwise paint a filled bar over an empty context.
      */}
      <div className="iris-context-card__bar">
        {segments.map(segment => (
          <span
            key={segment.category}
            className={`iris-context-card__slice iris-context-card__slice--${segment.category}`}
            style={{ width: `${String(segment.width)}%` }}
          />
        ))}
      </div>
      <dl className="iris-context-card__rows">
        {CATEGORY_ROWS.map((row) => {
          const found = byCategory.get(row.category)
          return (
            <div className="iris-context-card__row" key={row.category}>
              <dt>
                <span
                  className={`iris-context-card__swatch iris-context-card__swatch--${row.category}`}
                  aria-hidden="true"
                />
                {t(row.label)}
              </dt>
              <dd className="iris-context-card__share">{percent(found?.share ?? 0)}</dd>
              <dd className="iris-context-card__tokens">
                {t('usageCount', { count: formatTokens(found?.tokens ?? 0) })}
              </dd>
            </div>
          )
        })}
      </dl>
      <p className="iris-context-card__note">
        {t('contextRemaining', { tokens: formatExactTokens(remaining) })}
        {' · '}
        {t('contextReserve', { tokens: formatExactTokens(reserve) })}
      </p>
      {/*
        Cache hit is the one figure on this card that is **not** an estimate —
        it is the provider's own accounting, summed over the conversation. Kept
        on its own line, and worded with 「用量」's vocabulary rather than
        「估算」's, because `STRINGS.md` §三 pins that distinction and this card
        is the one place the two kinds of number sit together.
      */}
      {cacheHit === null
        ? null
        : (
            <p className="iris-context-card__note">
              {t('usageCacheHit', { percent: cacheHit })}
            </p>
          )}
      {/*
        The estimate that sits beside it, and its own line for the same reason:
        this one is 「估算」 — how much of the request the *assembly* leaves
        reusable — while the line above is the provider's accounting of what
        happened. Same subject, different kind of number, so they never share a
        sentence. It appears even when the provider says nothing about caching,
        because a prompt shaped badly for the cache is worth seeing before the
        first bill.
      */}
      {prefix === null
        ? null
        : (
            <p className="iris-context-card__note" data-control="stable-prefix">
              {t('contextStablePrefix', {
                percent: String(prefix.percent),
                tokens: formatTokens(prefix.tokens),
              })}
            </p>
          )}
      <p className="iris-context-card__note iris-context-card__note--source">
        {itemization?.preview === false
          ? t('contextFromRecord', { turn: String(itemization.turn) })
          : t('contextFromPreview')}
      </p>
    </>
  )
}
