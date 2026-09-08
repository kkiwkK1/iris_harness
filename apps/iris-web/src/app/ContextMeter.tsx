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
 * on a keystroke.
 *
 * That rule used to mean the capsule showed its capacity and nothing else until
 * pressed. It no longer has to: the host records an itemization for every turn
 * it assembles anyway, and now projects the newest one (`ChatView.measured`),
 * so the capsule draws a *measured* occupancy off a fact the view already
 * carries. Nothing is assembled to draw the bar; a conversation with no record
 * — nothing generated yet, or a host that has just restarted — still states its
 * capacity alone, because a capsule that showed nothing until a round trip
 * completed would be a control that looks broken.
 *
 * @module iris-web/app/ContextMeter
 */

import { useEffect, useRef } from 'react'
import type { MutableRefObject, ReactElement } from 'react'

import type { ChatBudget, PromptDivergence, PromptItemization, TurnUsage } from '@iris/protocol'

import {
  averageCacheHit,
  capsuleReading,
  contextOccupancy,
  meterSegments,
  stablePrefix,
  windowSourceKey,
  type ContextCategory,
  type ContextOccupancy,
} from './context-occupancy.ts'
import { cacheCeiling, itemName } from './divergence.ts'
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

/**
 * Where the window in force came from, in one phrase.
 *
 * The question the whole feature exists to answer. The reported case: a
 * conversation on `deepseek-v4-flash` — a model documented at 1M — assembling
 * against 2 000 000 tokens, because a preset switched earlier had left that
 * number on the global settings layer and nothing on any surface said so. The
 * window was on the card the whole time; *who chose it* was not.
 * @param budget - the resolved budget, provenance included.
 * @returns the phrase, ready to print.
 */
function windowSourceText(budget: ChatBudget): string {
  // Every slot for every case: `interpolate` leaves an unused one alone, and
  // one call site is what keeps the four sentences from drifting into four
  // different vocabularies for the same three numbers.
  return t(windowSourceKey(budget.source), {
    tokens: formatTokens(budget.context),
    model: budget.model ?? '',
    // Only the `unlocked` sentence prints this, and that case is reachable only
    // with a known model window — so the fallback stands in for nothing rather
    // than quietly answering for a missing figure.
    modelTokens: formatTokens(budget.modelContext ?? budget.context),
  })
}

/** What the capsule needs. */
export interface ContextPillProps {
  budget: ChatBudget
  /** The reading, once the card has been opened for this conversation. */
  itemization: PromptItemization | undefined
  /** What the host recorded for the newest real turn, when it has one. */
  measured: { turn: number, tokens: number } | undefined
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
 *
 * **The bar is drawn from a reading that already exists.** The module doc above
 * says an itemization is never paid for on a render, and that still holds: what
 * changed is that the host now projects the measurement it *already recorded*
 * for the newest real turn (`ChatView.measured`), so there is a number to draw
 * without asking for one. A conversation nobody has generated in yet — and
 * every conversation right after a restart, since those records live in memory
 * — has no bar, and states its capacity as it always did.
 * @param props - the budget, whichever readings exist, and the open state.
 * @returns the capsule, or null when there is no capacity to report.
 */
export function ContextPill({
  budget,
  itemization,
  measured,
  open,
  onToggle,
  anchor,
}: ContextPillProps): ReactElement | null {
  useLanguage()
  const available = Math.max(0, budget.context - budget.reserve)
  if (available === 0) return null
  const reading = capsuleReading(budget, itemization, measured)
  const label = reading === null
    ? t('contextPillCapacity', { total: formatTokens(available) })
    : t('contextPill', {
      used: formatTokens(reading.usedTokens),
      total: formatTokens(available),
      percent: String(reading.percent),
    })
  /*
   * The hover carries what the capsule has no room for: the exact figures, the
   * window's provenance, and which request the reading is about. Not a
   * duplicate of the label — the label rounds (「30.1K」) and this does not, and
   * a reader checking a figure against a receipt needs the unrounded one.
   */
  const title = reading === null
    ? `${t('contextPillTitle')} · ${windowSourceText(budget)}`
    : [
        t('contextCardFigures', {
          used: formatExactTokens(reading.usedTokens),
          total: formatExactTokens(reading.available),
          percent: String(reading.percent),
        }),
        windowSourceText(budget),
        reading.basis === 'record'
          ? t('contextFromRecord', { turn: String(reading.turn ?? 0) })
          : t('contextFromPreview'),
      ].join(' · ')
  return (
    <button
      ref={anchor}
      type="button"
      className={`iris-composer__pill iris-composer__pill--action${
        reading?.over === true ? ' iris-composer__pill--over' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={title}
      data-control="context-meter"
      onClick={onToggle}
    >
      {label}
      {/*
        The gauge along the capsule's own bottom edge, inside its `overflow:
        hidden` so the fill is clipped to the capsule's curve.

        `aria-hidden`, deliberately: it draws the percentage already printed in
        the label beside it, so a screen reader announcing it would read one
        fact twice — and the label is the reading that carries units. A
        zero-width fill is not drawn at all, the rule `meterSegments` follows on
        the card: nothing in the window is a real state, and a hairline of plum
        is not how to say it.
      */}
      {reading === null
        ? null
        : (
            <span className="iris-composer__pill-gauge" aria-hidden="true">
              {reading.percent === 0
                ? null
                : (
                    <span
                      className={`iris-composer__pill-fill iris-composer__pill-fill--${reading.level}`}
                      style={{ width: `${String(reading.percent)}%` }}
                      data-control="context-gauge"
                    />
                  )}
            </span>
          )}
    </button>
  )
}

/** What the card needs. */
export interface ContextCardProps {
  budget: ChatBudget
  itemization: PromptItemization | undefined
  /** Why there is no reading yet, or why the last attempt failed. */
  state: 'loading' | 'ready' | { error: string }
  /** The conversation's summed usage, for the cache-hit line. */
  usage: TurnUsage | undefined
  /**
   * Where the newest request stopped matching the one before it.
   *
   * Absent covers three states on purpose — still fetching, the record is
   * switched off, and this conversation has only sent one request — because the
   * card's answer to all three is the same: say nothing. A line reading "no
   * comparison available" on a first turn would be a report about the instrument
   * where the reader is looking for a report about their prompt.
   */
  divergence: PromptDivergence | undefined
  /** Opens the prompt panel, where the per-part marks are. */
  onOpenPanel: () => void
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
  divergence,
  onOpenPanel,
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
        : (
            <ContextBody
              occupancy={occupancy}
              itemization={itemization}
              usage={usage}
              budget={budget}
              divergence={divergence}
              onOpenPanel={onOpenPanel}
            />
          )}
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
  budget,
  divergence,
  onOpenPanel,
}: {
  occupancy: ContextOccupancy
  itemization: PromptItemization | undefined
  usage: TurnUsage | undefined
  /* The whole budget, not just its reserve: the card prints the reserve *and*
     names where the window came from, and those are two reads of one object. */
  budget: ChatBudget
  divergence: PromptDivergence | undefined
  onOpenPanel: () => void
}): ReactElement {
  const reserve = budget.reserve
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
      {/*
        Where this request stopped matching the last one.
        **Bytes, not tokens, and it sits under the cache-hit line for that
        reason**: the line above is a share of the conversation's billed tokens,
        this is a share of one request's bytes, and they are two measurements of
        the same disappointment. The cache line says what the provider gave; this
        says what it *could* have given, and the gap between them is the only
        thing that can tell "we changed the prompt" from "the provider did not
        serve it".

        A press opens the prompt panel, where the per-part marks are — one
        sentence cannot name eleven sections, and this is a button rather than a
        note because it goes somewhere.
      */}
      {divergence === undefined
        ? null
        : (
            <p className="iris-context-card__note">
              <button
                type="button"
                className="iris-context-card__diverge"
                data-control="context-divergence"
                onClick={onOpenPanel}
                title={t('divergenceOpen')}
              >
                {divergence.divergedAt >= divergence.bytes
                  ? t('divergenceIdentical')
                  : t('divergenceLine', {
                      percent: percent(cacheCeiling(divergence)),
                      item: divergence.divergedIn === undefined
                        ? t('divergenceStateChanged')
                        : itemName(divergence.divergedIn, floor => t('divergenceFloor', { n: floor })),
                    })}
              </button>
            </p>
          )}
      {/*
        Where the denominator came from — last of the four, and that ordering is
        the point rather than an accident. The three above are all *about this
        request*: what the provider cached, what the assembly left reusable,
        where this request stopped matching the last one. This one is about the
        **conversation**, and so is the reserve line further up: it does not
        change when the reader sends another turn.

        This is the line the reported case needed: a 2 000 000-token window
        under a 1M model was printed on this card with nothing saying who had
        asked for it. The record-or-preview line stays below it, because that is
        a fact about the *reading* rather than about either.
      */}
      <p className="iris-context-card__note iris-context-card__note--window" data-control="context-window-source">
        {windowSourceText(budget)}
      </p>
      <p className="iris-context-card__note iris-context-card__note--source">
        {itemization?.preview === false
          ? t('contextFromRecord', { turn: String(itemization.turn) })
          : t('contextFromPreview')}
      </p>
    </>
  )
}
