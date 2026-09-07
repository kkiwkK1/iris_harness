/**
 * What this profile has cost, and which model is costing it.
 *
 * The two usage surfaces that already exist answer a smaller question each: the
 * composer line says what the **open conversation** cost, and a reply's own
 * reading says what **one turn** cost. Neither can answer the one a user
 * actually asks — "what am I spending, and on what" — because that question is
 * across conversations and across days, and the numbers to answer it were until
 * now stored without a model or a moment. This page is the other half of that
 * change (`notes/apps/iris-web/DEVIATIONS.md` 60, host side §28).
 *
 * **The shape follows one measurement.** On the 16 real conversations on this
 * machine there are 12 usage records; every one of them names no model and
 * carries no timestamp. So the page is not designed around a rich history — it
 * is designed around the fact that *everyone's* history up to today is one
 * unattributed lump, and the honest rendering of that is a labelled "unknown
 * model" line plus a note saying how many of the counted generations had their
 * moment reconstructed from their conversation. A page that hid either would
 * look like a working chart of the wrong data.
 *
 * The per-turn vocabulary — 未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 推理 — is
 * the deepseek harness's, transcribed from
 * `packages/client/ui-chat/src/client/chat/TurnUsagePanel.tsx` (MIT; see
 * `THIRD-PARTY-NOTICES.md`), so a reader who has met the per-turn dialog reads
 * the same words here. The harness has no usage chart; the chart, its colour
 * scheme and its geometry are Iris's own (`./usage-stats.ts`).
 *
 * @module iris-web/app/UsagePanel
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UsageChat, UsageGranularity, UsageSummary, UsageTotals } from '@iris/protocol'

import { useIrisActions } from '../client/provider.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import { formatExactTokens, formatTokens } from './token-format.ts'
import {
  assignSeriesStyles,
  axisMax,
  billedPrompt,
  bucketLabel,
  chartData,
  chartLayout,
  hitRate,
  linePath,
  seriesDomKey,
  seriesKey,
  rangeParams,
  totalTokens,
  USAGE_METRICS,
  USAGE_RANGES,
  xFor,
  yFor,
  yTicks,
  type UsageMetric,
  type UsageRange,
} from './usage-stats.ts'

/** What the panel is doing. */
type PanelState =
  | { kind: 'loading' }
  | { kind: 'error', message: string }
  | { kind: 'ready', summary: UsageSummary }

/**
 * Render the usage page.
 * @param props.open - whether the page is showing.
 * @param props.onClose - dismissal.
 * @param props.onOpenChat - open one conversation from its subtotal row.
 * @returns the modal.
 */
export function UsagePanel({
  open,
  onClose,
  onOpenChat,
}: {
  open: boolean
  onClose: () => void
  onOpenChat: (chatId: string) => void
}): ReactElement {
  const actions = useIrisActions()
  const [range, setRange] = useState<UsageRange>('week')
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  // Subscribed so a language switch re-renders the page's words.
  useLanguage()

  useEffect(() => {
    if (!open) return
    let live = true
    setState({ kind: 'loading' })
    // `Date.now()` read here rather than held in state: the range is relative
    // to when it was asked, and a "today" pinned at the moment the panel first
    // mounted would keep answering about yesterday after midnight.
    void actions.usageSummary(rangeParams(range, Date.now())).then(result => {
      if (!live) return
      setState(
        result.ok
          ? { kind: 'ready', summary: result.summary }
          : { kind: 'error', message: `${result.error.code}: ${result.error.message}` },
      )
    })
    return () => {
      live = false
    }
  }, [open, range, actions])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('usagePageTitle')}
      closeLabel={t('close')}
      /*
        Wider than the primitive's 380px confirmation card and wider than the
        prompt breakdown's 640px, for one reason: the chart keeps a legible
        column per bucket, and at 640px a 30-day range spends its whole measure
        inside a scroller. The dialog carries the width because the clip is on
        the dialog (`PromptPanel` records the same finding).
      */
      className="iris-usage-dialog"
    >
      <div className="iris-usage">
        <div className="iris-choice" role="group" aria-label={t('usageRangeAria')}>
          {USAGE_RANGES.map(one => (
            <button
              key={one}
              type="button"
              className="iris-choice__option"
              aria-pressed={one === range}
              onClick={() => { setRange(one) }}
            >
              {t(RANGE_KEYS[one])}
            </button>
          ))}
        </div>
        {state.kind === 'loading' ? <p className="iris-list__empty">{t('usageCounting')}</p> : null}
        {state.kind === 'error' ? <p className="iris-list__empty">{state.message}</p> : null}
        {state.kind === 'ready' ? (
          <UsageReport summary={state.summary} onOpenChat={onOpenChat} />
        ) : null}
      </div>
    </Modal>
  )
}

/** Each range's label key, so the switch is a map rather than a switch statement. */
const RANGE_KEYS = {
  today: 'usageRangeToday',
  week: 'usageRangeWeek',
  month: 'usageRangeMonth',
  all: 'usageRangeAll',
} as const

/** Each metric's label key. */
const METRIC_KEYS = {
  total: 'usageMetricTotal',
  cacheRead: 'usageMetricCacheRead',
  cacheMiss: 'usageMetricCacheMiss',
  output: 'usageMetricOutput',
} as const

/**
 * The report itself: cards, chart, legend, caveats, per-conversation subtotals.
 *
 * **Exported, and separate from the modal above it on purpose.** The modal is a
 * `createPortal`, which `react-dom/server` refuses — so a component that only
 * exists inside it cannot be rendered by `tools/render-check.tsx`, and the one
 * surface on this page that most needs a rendering check is the chart. Split
 * here, the report renders from a summary alone, which is also what makes it
 * checkable against the fake's seeded numbers rather than against a fixture
 * written by the same belief as the code.
 *
 * It owns the metric switch and the legend's hidden set because both are
 * readings *of one summary*: they must reset when a new summary arrives and
 * must not reset when the range control above re-renders.
 * @param props.summary - the aggregate to read.
 * @param props.onOpenChat - open one conversation from its subtotal row.
 * @returns the report.
 */
export function UsageReport({
  summary,
  onOpenChat,
}: {
  summary: UsageSummary
  onOpenChat: (chatId: string) => void
}): ReactElement {
  // Subscribed rather than inherited: this renders on its own in the render
  // check, with no `UsagePanel` above it to have subscribed for it.
  useLanguage()
  const [metric, setMetric] = useState<UsageMetric>('total')
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const onMetric = setMetric
  const onToggle = (key: string): void => {
    setHidden(was => {
      const next = new Set(was)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const data = useMemo(() => chartData(summary.buckets, metric), [summary.buckets, metric])
  // Keyed on the model names present, so a model keeps its line's colour as the
  // metric switches — only the range can change the set, and only a colliding
  // name can then move.
  const styles = useMemo(
    () => assignSeriesStyles(data.series.flatMap(one => one.model === undefined ? [] : [one.model])),
    [data.series],
  )

  if (summary.totals.turns === 0) {
    return (
      <div className="iris-empty">
        <p className="iris-empty__line">{t('usageEmpty')}</p>
        <p className="iris-empty__hint">
          {t('usageScanned', { chats: summary.scannedChats })}
        </p>
      </div>
    )
  }

  return (
    <>
      <Cards totals={summary.totals} />
      <div className="iris-usage__controls">
        <div className="iris-choice" role="group" aria-label={t('usageMetricAria')}>
          {USAGE_METRICS.map(one => (
            <button
              key={one}
              type="button"
              className="iris-choice__option"
              aria-pressed={one === metric}
              onClick={() => { onMetric(one) }}
            >
              {t(METRIC_KEYS[one])}
            </button>
          ))}
        </div>
      </div>
      <Chart
        data={data}
        styles={styles}
        granularity={summary.granularity}
        metric={metric}
        hidden={hidden}
      />
      <ul className="iris-usage__legend">
        {data.series.map(series => {
          const key = seriesKey(series)
          const style = series.model === undefined ? undefined : styles.get(series.model)
          const off = hidden.has(key)
          return (
            <li key={seriesDomKey(series)}>
              <button
                type="button"
                className={`iris-usage__legend-item${off ? ' iris-usage__legend-item--off' : ''}`}
                aria-pressed={!off}
                onClick={() => { onToggle(key) }}
              >
                <span
                  className="iris-usage__swatch"
                  aria-hidden="true"
                  style={{
                    background: style?.color ?? 'var(--iris-tick)',
                    // The dash is what tells a seventh model from the first, so
                    // the swatch has to carry it too — a legend of identical
                    // squares would send the reader back to the chart to guess.
                    ...style?.dash === undefined ? {} : { backgroundImage: dashSwatch(style.color) },
                  }}
                />
                <span className="iris-usage__legend-name">
                  {series.model ?? t('usageUnknownModel')}
                </span>
                <span className="iris-meta">{formatTokens(series.total)}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <Notes summary={summary} />
      <ChatRows chats={summary.chats} onOpenChat={onOpenChat} />
    </>
  )
}

/**
 * A dashed swatch, as a gradient over the solid fill.
 *
 * A `repeating-linear-gradient` rather than a second element: the swatch is
 * 10px of decoration and the alternative was an inline SVG per legend row.
 * @param color - the series colour, already a `var()` reference.
 * @returns the CSS value.
 */
function dashSwatch(color: string): string {
  return `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)`
}

/** The headline figures. */
function Cards({ totals }: { totals: UsageTotals }): ReactElement {
  useLanguage()
  const share = hitRate(totals)
  return (
    <div className="iris-usage__cards">
      <Card label={t('usageCardTotal')} value={formatExactTokens(totalTokens(totals))} />
      <Card label={t('usageCardPrompt')} value={formatExactTokens(billedPrompt(totals))} />
      <Card label={t('usageCardCacheRead')} value={figureOrDash(totals.cacheRead)} />
      <Card label={t('usageCardCacheMiss')} value={formatExactTokens(totals.cacheMiss)} />
      <Card label={t('usageCardOutput')} value={formatExactTokens(totals.output)} />
      {/*
        A dash, never `0%`. `hitRate` returns null when no generation in the
        range reported a cache bucket at all, and printing zero there would be
        Iris asserting "the cache never helped" about providers that never
        spoke about caching — the distinction the whole bucket convention
        exists to keep.
      */}
      <Card label={t('usageCardHitRate')} value={share === null ? '—' : `${share}%`} />
      <Card label={t('usageCardTurns')} value={String(totals.turns)} />
    </div>
  )
}

/** One headline figure. */
function Card({ label, value }: { label: string, value: string }): ReactElement {
  return (
    <div className="iris-usage__card">
      <span className="iris-usage__figure">{value}</span>
      <span className="iris-label">{label}</span>
    </div>
  )
}

/** An optional bucket's figure, or a dash where the providers said nothing. */
function figureOrDash(value: number | undefined): string {
  return value === undefined ? '—' : formatExactTokens(value)
}

/** The chart. */
function Chart({
  data,
  styles,
  granularity,
  metric,
  hidden,
}: {
  data: ReturnType<typeof chartData>
  styles: Map<string, { color: string, dash?: string }>
  granularity: UsageGranularity
  metric: UsageMetric
  hidden: ReadonlySet<string>
}): ReactElement {
  useLanguage()
  const [hover, setHover] = useState<number | undefined>(undefined)
  const shown = data.series.filter(series => !hidden.has(seriesKey(series)))
  const layout = chartLayout(data.axis.length)
  // The scale is set by the lines that are **showing**: hiding the largest
  // model has to make the rest readable, which is the whole point of a legend
  // you can click. A fixed scale would leave four lines crushed at the bottom.
  const max = axisMax(shown.flatMap(series => series.values))
  const ticks = yTicks(max)
  // Every other label when the columns are narrow enough to collide. 54px
  // holds `12-08`; it does not hold two of them.
  const labelEvery = data.axis.length > 16 ? 2 : 1

  return (
    <div className="iris-usage__plot">
      <svg
        className="iris-usage__svg"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
        role="img"
        aria-label={t('usageChartAria', { metric: t(METRIC_KEYS[metric]), lines: shown.length })}
      >
        {ticks.map(tick => {
          const y = yFor(tick, max, layout)
          return (
            <g key={tick}>
              <line
                x1={layout.plot.left}
                y1={y}
                x2={layout.plot.right}
                y2={y}
                stroke="var(--iris-rule-faint)"
                strokeWidth="1"
              />
              <text
                x={layout.plot.left - 8}
                y={y + 4}
                textAnchor="end"
                className="iris-usage__axis"
                fill="var(--iris-ink-faint)"
              >
                {formatTokens(tick)}
              </text>
            </g>
          )
        })}
        {/*
          Dropped rather than hidden: an x position comes from the bucket's
          index and the axis length, so a missing label moves nothing — and
          `hidden` is not honoured on an SVG element, because the rule that
          implements it lives in the HTML user-agent stylesheet.
        */}
        {data.axis.map((bucket, index) => index % labelEvery !== 0 ? null : (
          <text
            key={bucket}
            x={xFor(index, data.axis.length, layout)}
            y={layout.height - 8}
            textAnchor="middle"
            className="iris-usage__axis"
            fill="var(--iris-ink-faint)"
          >
            {bucketLabel(bucket, granularity)}
          </text>
        ))}
        {shown.map(series => {
          const style = series.model === undefined
            ? { color: 'var(--iris-tick)' as string, dash: '3 3' as string | undefined }
            : styles.get(series.model) ?? { color: 'var(--iris-tick)', dash: undefined }
          return (
            <g key={seriesDomKey(series)}>
              <path
                d={linePath(series.values, max, layout)}
                fill="none"
                stroke={style.color}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                {...style.dash === undefined ? {} : { strokeDasharray: style.dash }}
                vectorEffect="non-scaling-stroke"
              />
              {/*
                A dot per point, because a single-bucket range is a path with
                one command and nothing to draw — the same rule the prompt bar
                states as "a part is never allowed to round to nothing".
              */}
              {series.values.map((value, index) => (
                <circle
                  key={data.axis[index] ?? index}
                  cx={xFor(index, series.values.length, layout)}
                  cy={yFor(value, max, layout)}
                  r={hover === index ? 3.4 : 2.2}
                  fill={style.color}
                />
              ))}
            </g>
          )
        })}
        {/*
          One transparent column per bucket, carrying the hover. Also carries a
          native `<title>`, so the numbers are reachable without the React
          tooltip below — which is what a reader gets when the pointer is a
          finger and there is no hover at all.
        */}
        {data.axis.map((bucket, index) => {
          const half = data.axis.length <= 1
            ? (layout.plot.right - layout.plot.left) / 2
            : (layout.plot.right - layout.plot.left) / (2 * (data.axis.length - 1))
          const centre = xFor(index, data.axis.length, layout)
          return (
            <rect
              key={bucket}
              x={Math.max(layout.plot.left, centre - half)}
              y={layout.plot.top}
              width={Math.min(half * 2, layout.plot.right - layout.plot.left)}
              height={layout.plot.bottom - layout.plot.top}
              fill="transparent"
              onMouseEnter={() => { setHover(index) }}
              onMouseLeave={() => { setHover(was => (was === index ? undefined : was)) }}
            >
              <title>{hoverText(bucket, granularity, shown, index)}</title>
            </rect>
          )
        })}
      </svg>
      {/*
        The tooltip is `aria-hidden`, and not because it is decoration: the
        same numbers are already on the hovered column's `<title>`, which is
        what an assistive reader and a touch device get. A live region here
        would announce the whole table on every pixel of pointer movement.
      */}
      {hover === undefined || data.axis[hover] === undefined ? null : (
        <div className="iris-usage__tip" aria-hidden="true">
          <span className="iris-label">{bucketLabel(data.axis[hover], granularity)}</span>
          <ul>
            {shown.map(series => (
              <li key={seriesDomKey(series)}>
                <span className="iris-usage__tip-name">
                  {series.model ?? t('usageUnknownModel')}
                </span>
                <span className="iris-meta">{formatExactTokens(series.values[hover] ?? 0)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * The native tooltip's text: one bucket, every showing line.
 * @param bucket - the bucket's start.
 * @param granularity - which cut it came from.
 * @param series - the showing lines.
 * @param index - the bucket's position on the axis.
 * @returns one line per model.
 */
function hoverText(
  bucket: number,
  granularity: UsageGranularity,
  series: readonly { model?: string, values: number[] }[],
  index: number,
): string {
  const rows = series.map(one =>
    `${one.model ?? t('usageUnknownModel')} ${formatExactTokens(one.values[index] ?? 0)}`)
  return [bucketLabel(bucket, granularity), ...rows].join('\n')
}

/**
 * The two things a reader has to be told about a figure this page computed.
 *
 * Both are about how much of the reading is a reading. Neither is an error, and
 * neither is hidden: a total over an unknown fraction of the corpus, and a time
 * axis partly reconstructed from conversation headers, are the two ways this
 * page can be quietly wrong.
 */
function Notes({ summary }: { summary: UsageSummary }): ReactElement | null {
  useLanguage()
  const notes: string[] = []
  if (summary.totals.undatedTurns > 0) {
    notes.push(t('usageUndated', {
      n: summary.totals.undatedTurns,
      turns: summary.totals.turns,
    }))
  }
  if (summary.skippedChats > 0) notes.push(t('usageSkipped', { n: summary.skippedChats }))
  if (notes.length === 0) return null
  return (
    <>
      {notes.map(note => (
        <p key={note} className="iris-usage__note">{note}</p>
      ))}
    </>
  )
}

/** Per-conversation subtotals. */
function ChatRows({
  chats,
  onOpenChat,
}: {
  chats: readonly UsageChat[]
  onOpenChat: (chatId: string) => void
}): ReactElement | null {
  useLanguage()
  if (chats.length === 0) return null
  return (
    <>
      <h3 className="iris-label iris-section__head">{t('usageByChat')}</h3>
      <ul className="iris-usage__chats">
        {chats.map(chat => {
          const share = hitRate(chat)
          return (
            <li key={chat.chatId}>
              <button
                type="button"
                className="iris-usage__chat"
                onClick={() => { onOpenChat(chat.chatId) }}
              >
                <span className="iris-usage__chat-title">{chat.title}</span>
                <span className="iris-meta">{t('usageTurnCount', { n: chat.turns })}</span>
                <span className="iris-meta">{share === null ? '—' : `${share}%`}</span>
                <span className="iris-usage__chat-total">{formatTokens(totalTokens(chat))}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
