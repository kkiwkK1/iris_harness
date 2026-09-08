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

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UsageChat, UsageGranularity, UsageSummary, UsageTotals } from '@iris/protocol'

import { useIrisActions } from '../client/provider.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import { formatExactTokens, formatTokens } from './token-format.ts'
import {
  assignSeriesStyles,
  axisMax,
  axisTicks,
  billedPrompt,
  bucketLabel,
  chartData,
  chartHasSpend,
  chartLayout,
  hitRate,
  linePath,
  seriesDomKey,
  seriesKey,
  rangeParams,
  scriptTokens,
  styleFor,
  totalTokens,
  USAGE_METRICS,
  USAGE_RANGES,
  xFor,
  yFor,
  yTicks,
  type SeriesStyle,
  type UsageChartData,
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
        {/*
          The range switch is the report's when there is a report, and this
          branch's while there is not — one `Toolbar`, two mutually exclusive
          call sites, rather than one control rendered twice. It has to survive
          a failed or pending read: a reader whose "today" answered nothing (or
          errored) needs the switch that gets them out of it, and a toolbar that
          only exists inside a successful reading is the one arrangement that
          strands them.
        */}
        {state.kind === 'ready' ? (
          <UsageReport
            summary={state.summary}
            range={range}
            onRange={setRange}
            onOpenChat={onOpenChat}
          />
        ) : (
          <>
            <Toolbar range={range} onRange={setRange} />
            <p className="iris-usage__status">
              {state.kind === 'error' ? state.message : t('usageCounting')}
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}

/**
 * The page's one control row: the range on the left, the metric on the right.
 *
 * Both are `.iris-choice`, the segmented control the prompt breakdown's
 * 「从大到小 / 按装配顺序」 switch is drawn with, so a reader who has met one
 * has met all of them. Left and right of one row rather than stacked because
 * they answer different questions about the same picture — *when* and *what* —
 * and a column of two identical control strips reads as one control with eight
 * options.
 *
 * The metric half is optional, and its absence is the loading state: a switch
 * over which line the chart draws, above no chart, is a control with nothing to
 * control.
 * @param props.range - the range in force.
 * @param props.onRange - pick a range.
 * @param props.metric - the metric in force, absent while there is no chart.
 * @param props.onMetric - pick a metric; absent with `metric`.
 * @returns the row.
 */
function Toolbar({
  range,
  onRange,
  metric,
  onMetric,
}: {
  range: UsageRange
  onRange: (range: UsageRange) => void
  metric?: UsageMetric
  onMetric?: (metric: UsageMetric) => void
}): ReactElement {
  useLanguage()
  return (
    <div className="iris-usage__toolbar">
      <div className="iris-choice" role="group" aria-label={t('usageRangeAria')}>
        {USAGE_RANGES.map(one => (
          <button
            key={one}
            type="button"
            className="iris-choice__option"
            aria-pressed={one === range}
            onClick={() => { onRange(one) }}
          >
            {t(RANGE_KEYS[one])}
          </button>
        ))}
      </div>
      {metric === undefined || onMetric === undefined ? null : (
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
      )}
    </div>
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
  script: 'usageMetricScript',
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
 * It owns the metric switch's state and the legend's hidden set because both
 * are readings *of one summary*: they must reset when a new summary arrives and
 * must not reset when the range control beside them re-renders. The **range**
 * is the opposite — it decides which summary is fetched, so it is the panel's
 * and arrives here as a prop, and the row that carries both is
 * {@link Toolbar}.
 * @param props.summary - the aggregate to read.
 * @param props.range - the range this summary answers, for the switch.
 * @param props.onRange - pick another range; the panel re-fetches.
 * @param props.onOpenChat - open one conversation from its subtotal row.
 * @returns the report.
 */
export function UsageReport({
  summary,
  range,
  onRange,
  onOpenChat,
}: {
  summary: UsageSummary
  range: UsageRange
  onRange: (range: UsageRange) => void
  onOpenChat: (chatId: string) => void
}): ReactElement {
  // Subscribed rather than inherited: this renders on its own in the render
  // check, with no `UsagePanel` above it to have subscribed for it.
  useLanguage()
  const [metric, setMetric] = useState<UsageMetric>('total')
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
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
      <>
        {/* The metric switch is left off: it picks a line on a chart there is
            none of. The range switch stays, because it is the way out. */}
        <Toolbar range={range} onRange={onRange} />
        <div className="iris-empty">
          <p className="iris-empty__line">{t('usageEmpty')}</p>
          <p className="iris-empty__hint">
            {t('usageScanned', { chats: summary.scannedChats })}
          </p>
        </div>
      </>
    )
  }

  return (
    <>
      <Toolbar range={range} onRange={onRange} metric={metric} onMetric={setMetric} />
      <Cards totals={summary.totals} />
      {/*
        The chart and its legend are one figure — one paper card, the plot above
        a hairline and the legend below it — because the legend is not a
        paragraph about the chart, it is the chart's key and its only control.
      */}
      <div className="iris-usage__chart">
        {chartHasSpend(data) ? (
          <>
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
                const style = styleFor(series, styles)
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
                          background: style.color,
                          // The dash is what tells a seventh model from the
                          // first — and the unattributed line from every named
                          // one — so the swatch has to carry it too. A legend of
                          // identical bars sends the reader back to the chart to
                          // guess.
                          ...style.dash === undefined
                            ? {}
                            : { backgroundImage: dashSwatch(style.color) },
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
          </>
        ) : (
          /*
            A sentence, not an empty coordinate system. Three of the four
            metrics can be legitimately empty over a range that billed plenty —
            a profile whose providers never mentioned caching has no cache read
            anywhere — and an axis labelled `0` with a flat line along its floor
            is a picture of a measurement where there was nothing to measure.
          */
          <p className="iris-usage__quiet">{t('usageChartEmpty')}</p>
        )}
      </div>
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

/**
 * The headline figures, as one large card and six small ones.
 *
 * **Seven equal cards were seven unranked facts.** The reading a reader came
 * for is the first one — what this profile has cost — and the other six are how
 * that total divides, so the total is a sheet of its own at twice the type size
 * and the rest are a grid of capsules beside it. Nothing was dropped: the same
 * seven figures, ranked.
 *
 * The card generations' share is a **line under the total**, not an eighth
 * capsule, because it is not another way of dividing the total — it is a
 * statement about the same figure directly above it: how much of that was
 * something the user did not ask for. It appears only when the host reported
 * the share; a `0 次 · 0 token` line on every profile that runs no card
 * scripts is a line a reader learns to skip.
 * @param props.totals - the range's aggregate.
 * @returns the cards.
 */
function Cards({ totals }: { totals: UsageTotals }): ReactElement {
  useLanguage()
  const share = hitRate(totals)
  return (
    <div className="iris-usage__cards">
      <div className="iris-usage__hero">
        <span className="iris-usage__total">{formatExactTokens(totalTokens(totals))}</span>
        <span className="iris-label">{t('usageCardTotal')}</span>
        {totals.script === undefined ? null : (
          <span className="iris-usage__hero-note" title={t('usageScriptBasis')}>
            {t('usageScriptShare', {
              n: totals.script.turns,
              tokens: formatExactTokens(scriptTokens(totals)),
            })}
          </span>
        )}
      </div>
      <div className="iris-usage__grid">
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

          The bar and the hint are both here rather than on any other card
          because this is the only figure whose denominator is not on this page.
        */}
        <Card
          label={t('usageCardHitRate')}
          value={share === null ? '—' : `${share}%`}
          share={share}
          hint={t('usageHitRateBasis')}
        />
        <Card label={t('usageCardTurns')} value={String(totals.turns)} />
      </div>
    </div>
  )
}

/**
 * One of the six small figures.
 * @param props.label - what it counts.
 * @param props.value - the figure, already formatted.
 * @param props.share - a percentage to draw as a bar under the figure, `null`
 *   for a reading that does not exist; omitted where the figure is not a share.
 * @param props.hint - hover text, for a figure whose basis needs saying.
 * @returns the card.
 */
function Card({
  label,
  value,
  share,
  hint,
}: {
  label: string
  value: string
  share?: string | null
  hint?: string
}): ReactElement {
  return (
    <div className="iris-usage__card" {...hint === undefined ? {} : { title: hint }}>
      <span className="iris-usage__figure">{value}</span>
      {share === undefined ? null : <ShareBar share={share} />}
      <span className="iris-label">{label}</span>
    </div>
  )
}

/**
 * A share as a hairline bar.
 *
 * **Drawn from the very percentage printed above it**, and that is the whole
 * design of this element. The obvious bar here is cache-read over the billed
 * input on the card next door, and it would be a *third* denominator: the
 * figure is over `cachePrompt`, the generations that reported a cache bucket at
 * all (`usage-stats.ts` `hitRate`, `DEVIATIONS.md` 60), and on a mixed range
 * the two differ by a lot — 75% against 19% on a two-generation fixture. A bar
 * and a number that disagree teach the reader to trust neither, so this one
 * cannot: it is the same string, as a width.
 *
 * `null` draws the empty track beside the dash, which reads as "no reading" —
 * not as a share of zero.
 * @param props.share - the percentage without its sign, or `null`.
 * @returns the bar.
 */
function ShareBar({ share }: { share: string | null }): ReactElement {
  const read = share === null ? 0 : Number(share)
  const percent = Number.isFinite(read) ? Math.min(100, Math.max(0, read)) : 0
  return (
    <span className="iris-usage__bar" aria-hidden="true">
      <span className="iris-usage__bar-fill" style={{ width: `${String(percent)}%` }} />
    </span>
  )
}

/** An optional bucket's figure, or a dash where the providers said nothing. */
function figureOrDash(value: number | undefined): string {
  return value === undefined ? '—' : formatExactTokens(value)
}

/**
 * The chart: gridlines, the axes, one line per showing model, and the hover.
 *
 * The scroller and the floating reading are **siblings**, not nested, and that
 * is a fix rather than a preference: the reading used to be absolutely
 * positioned inside the horizontal scroller, so on a 30-day range scrolled to
 * the right it sat at the far left of the *content* — off screen, over nothing,
 * exactly when the chart is wide enough to need it. It is now pinned to the
 * card, which does not scroll.
 * @param props.data - the axis and the lines.
 * @param props.styles - the colour assignment for the named models.
 * @param props.granularity - which cut the buckets came from.
 * @param props.metric - which figure the lines draw, for the description.
 * @param props.hidden - the series the reader switched off in the legend.
 * @returns the plot.
 */
function Chart({
  data,
  styles,
  granularity,
  metric,
  hidden,
}: {
  data: UsageChartData
  styles: ReadonlyMap<string, SeriesStyle>
  granularity: UsageGranularity
  metric: UsageMetric
  hidden: ReadonlySet<string>
}): ReactElement {
  useLanguage()
  const [hover, setHover] = useState<number | undefined>(undefined)
  const plot = useRef<HTMLDivElement | null>(null)
  /*
   * How much room the plot has, so a chart with three buckets fills the card
   * instead of sitting in the left half of it (`chartLayout` says why this
   * cannot be a CSS rule). `0` until measured, which is what a server render
   * and the first paint see — the layout then falls back to its own minimum,
   * so nothing depends on the measurement having happened.
   */
  const [room, setRoom] = useState(0)
  useEffect(() => {
    const node = plot.current
    // The guard is for the render check and for any environment without the
    // observer: no measurement, and the chart draws at its minimum.
    if (node === null || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      // Floored: a fractional width rounds up to a scrollbar over nothing.
      if (width !== undefined && width > 0) setRoom(Math.floor(width))
    })
    watch.observe(node)
    return () => { watch.disconnect() }
  }, [])
  const shown = data.series.filter(series => !hidden.has(seriesKey(series)))
  const layout = chartLayout(data.axis.length, room)
  // The scale is set by the lines that are **showing**: hiding the largest
  // model has to make the rest readable, which is the whole point of a legend
  // you can click. A fixed scale would leave four lines crushed at the bottom.
  const max = axisMax(shown.flatMap(series => series.values))
  const ticks = yTicks(max)
  // Which buckets get a label and what it says — the stride, and the switch to
  // month labels on a long axis, are `usage-stats.ts`'s and unit-tested there.
  const labels = axisTicks(data.axis, granularity)
  const reading = hover === undefined ? undefined : data.axis[hover]

  return (
    <>
      <div className="iris-usage__plot" ref={plot}>
        <svg
          className="iris-usage__svg"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
          role="img"
          aria-label={t('usageChartAria', { metric: t(METRIC_KEYS[metric]), lines: shown.length })}
        >
          {/*
            The gridlines, with the baseline drawn one step louder than the rest:
            a chart whose floor is as faint as its interior rules reads as
            floating, and the floor is the one line a reader measures against
            without consulting a number.
          */}
          {ticks.map(tick => {
            const y = yFor(tick, max, layout)
            return (
              <g key={tick}>
                <line
                  x1={layout.plot.left}
                  y1={y}
                  x2={layout.plot.right}
                  y2={y}
                  stroke={tick === 0 ? 'var(--iris-rule)' : 'var(--iris-rule-faint)'}
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
            The hovered column's reference line, drawn before the data rather
            than over it: it says which column the reading beside the chart is
            about, and a rule painted over a 1.5px line would cover the point it
            is pointing at.
          */}
          {hover === undefined ? null : (
            <line
              x1={xFor(hover, data.axis.length, layout)}
              y1={layout.plot.top}
              x2={xFor(hover, data.axis.length, layout)}
              y2={layout.plot.bottom}
              stroke="var(--iris-rule-strong)"
              strokeWidth="1"
            />
          )}
          {/*
            Only the buckets `axisTicks` labelled. Dropped rather than hidden: an
            x position comes from the bucket's index and the axis length, so a
            missing label moves nothing — and `hidden` is not honoured on an SVG
            element, because the rule that implements it lives in the HTML
            user-agent stylesheet.
          */}
          {labels.map(tick => (
            <text
              key={tick.index}
              x={xFor(tick.index, data.axis.length, layout)}
              y={layout.height - 8}
              textAnchor="middle"
              className="iris-usage__axis"
              fill="var(--iris-ink-faint)"
            >
              {tick.label}
            </text>
          ))}
          {shown.map(series => {
            const style = styleFor(series, styles)
            return (
              <g key={seriesDomKey(series)}>
                <path
                  d={linePath(series.values, max, layout)}
                  fill="none"
                  stroke={style.color}
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  {...style.dash === undefined ? {} : { strokeDasharray: style.dash }}
                  vectorEffect="non-scaling-stroke"
                />
                {/*
                  A dot per point, because a single-bucket range is a path with
                  one command and nothing to draw — the same rule the prompt bar
                  states as "a part is never allowed to round to nothing". The
                  hovered column's dots grow, which is what ties the reading to
                  the column without spending a second colour on it.
                */}
                {series.values.map((value, index) => (
                  <circle
                    key={data.axis[index] ?? index}
                    cx={xFor(index, series.values.length, layout)}
                    cy={yFor(value, max, layout)}
                    r={hover === index ? 3.2 : 2}
                    fill={style.color}
                  />
                ))}
              </g>
            )
          })}
          {/*
            One transparent column per bucket, carrying the hover. Also carries a
            native `<title>`, so the numbers are reachable without the reading
            panel — which is what a reader gets when the pointer is a finger and
            there is no hover at all.
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
      </div>
      {/*
        The reading is `aria-hidden`, and not because it is decoration: the same
        numbers are already on the hovered column's `<title>`, which is what an
        assistive reader and a touch device get. A live region here would
        announce the whole table on every pixel of pointer movement.
      */}
      {reading === undefined ? null : (
        <div className="iris-usage__tip" aria-hidden="true">
          <span className="iris-label">{bucketLabel(reading, granularity)}</span>
          <ul>
            {shown.map(series => (
              <li key={seriesDomKey(series)}>
                <span className="iris-usage__tip-name">
                  {series.model ?? t('usageUnknownModel')}
                </span>
                <span className="iris-meta">
                  {formatExactTokens(hover === undefined ? 0 : series.values[hover] ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
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
 *
 * **One line of small type, with the sentences on hover** — where this used to
 * be up to two paragraphs of warm-coloured prose between the chart and the
 * conversations, which is more page than a caveat about a figure should take and
 * read as an error message about something that is not an error. What stays
 * *visible* is each caveat's **count**, because that is the part a reader cannot
 * reconstruct: "some of this is a reconstruction" is not a reading, and 12 of 12
 * is a different page from 1 of 400. The `?` carries the whole sentence, and so
 * does the line itself, so a reader who hovers anywhere on it gets the text.
 * @param props.summary - the aggregate, for its two counts.
 * @returns the line, or nothing when neither caveat applies.
 */
function Notes({ summary }: { summary: UsageSummary }): ReactElement | null {
  useLanguage()
  /** Each caveat twice: the count for the line, the sentence for the hover. */
  const notes: { short: string, long: string }[] = []
  if (summary.totals.undatedTurns > 0) {
    const counts = { n: summary.totals.undatedTurns, turns: summary.totals.turns }
    notes.push({ short: t('usageUndatedShort', counts), long: t('usageUndated', counts) })
  }
  if (summary.skippedChats > 0) {
    notes.push({
      short: t('usageSkippedShort', { n: summary.skippedChats }),
      long: t('usageSkipped', { n: summary.skippedChats }),
    })
  }
  if (notes.length === 0) return null
  const full = notes.map(one => one.long).join('\n')
  return (
    <p className="iris-usage__note" title={full}>
      {notes.map((one, index) => (
        <span key={one.short}>
          {index === 0 ? '' : ' · '}
          {one.short}
        </span>
      ))}
      {/*
        A native `title` rather than the borrowed `Tooltip`, and the reason is a
        defect rather than a preference: the bridge maps that primitive's bubble
        text and its plate to the *same* Iris token (`theme/bridge.css` —
        `--dsw-static-neutral-bluish-00` and `--dsw-alias-tooltip-bg` are both
        `--iris-bg-raised`), so its first consumer would ship paper on paper.
        Reported rather than fixed from here. `title` is also the mechanism this
        page already uses, for the per-turn breakdown and the chart's columns.
      */}
      <span className="iris-usage__why" title={full} aria-label={t('usageBasisAria')}>?</span>
    </p>
  )
}

/**
 * Per-conversation subtotals, as a list of rows on one sheet.
 *
 * Five columns and only one of them flexible, so the numbers line up down the
 * page: the title takes what is left, the count, the share and the card share
 * are their own columns, and the total is right-aligned and monospaced — a
 * column of tokens whose digits do not line up is unrelated readings rather
 * than a ranking. The share carries the same hairline bar as the hit-rate card,
 * over the same population ({@link ShareBar} says why it can be no other).
 *
 * **The card-generation column is a second column and not a second number in
 * the total's.** The total is what the conversation cost and includes the
 * card's requests; putting the card's figure inside that cell would read as a
 * subtraction the reader has to guess the direction of. It is blank — not `0` —
 * on the conversations the host reported no share for, which is most of them:
 * one blank cell in a column says "not this one", and a column of zeros says
 * the feature is broken.
 * @param props.chats - the subtotals, in the host's order.
 * @param props.onOpenChat - open one conversation from its row.
 * @returns the list, or nothing when the range holds no conversation.
 */
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
      <h3 className="iris-label iris-usage__head">{t('usageByChat')}</h3>
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
                <span className="iris-usage__chat-count iris-meta">
                  {t('usageTurnCount', { n: chat.turns })}
                </span>
                <span className="iris-usage__chat-hit">
                  <ShareBar share={share} />
                  <span className="iris-meta">{share === null ? '—' : `${share}%`}</span>
                </span>
                <span className="iris-usage__chat-script iris-meta">
                  {chat.script === undefined
                    ? ''
                    : t('usageScriptCell', {
                      n: chat.script.turns,
                      tokens: formatTokens(scriptTokens(chat)),
                    })}
                </span>
                <span className="iris-usage__chat-total">{formatTokens(totalTokens(chat))}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
