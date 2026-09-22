/** Adapted from DeepSeek Harness (MIT, Copyright (c) 2026 DeepSeek).
 * See THIRD-PARTY-NOTICES.md for the source revision and license. */
import {
  memo, useId, useState, type CSSProperties, type MouseEvent, type PointerEvent,
} from 'react'
import { useLanguage, t } from './i18n/use-language.ts'
import type { TurnNavigationItem } from './turn-navigation.ts'
import css from './TurnNavigator.module.css'

interface TurnNavigatorProps {
  readonly items: readonly TurnNavigationItem[]
  readonly activeTurn: string | null
  readonly onNavigate: (item: TurnNavigationItem) => void
}

const TURN_SPACING_PX = 10
const RAIL_INSET_PX = 6

type TurnPositionStyle = CSSProperties & {
  readonly '--turn-natural-position': string
  readonly '--turn-position': string
}

type TurnRailStyle = CSSProperties & {
  readonly '--turn-natural-height': string
  readonly '--turn-rail-inset': string
}

function itemPosition(index: number, count: number): TurnPositionStyle {
  const ratio = count <= 1 ? 0 : index / (count - 1)
  return {
    '--turn-natural-position': `${String(index * TURN_SPACING_PX)}px`,
    '--turn-position': `${String(ratio * 100)}%`,
  }
}

function railSize(count: number): TurnRailStyle {
  return {
    '--turn-natural-height': `${String((count - 1) * TURN_SPACING_PX + 2 * RAIL_INSET_PX)}px`,
    '--turn-rail-inset': `${String(RAIL_INSET_PX)}px`,
  }
}

function itemAtPointer(
  items: readonly TurnNavigationItem[],
  rail: HTMLElement,
  clientY: number,
): TurnNavigationItem | undefined {
  const rect = rail.getBoundingClientRect()
  const usableHeight = Math.max(1, rect.height - 2 * RAIL_INSET_PX)
  const ratio = Math.max(0, Math.min(1, (clientY - rect.top - RAIL_INSET_PX) / usableHeight))
  return items[Math.round(ratio * (items.length - 1))]
}

function TurnNavigatorRail({ items, activeTurn, onNavigate }: TurnNavigatorProps) {
  const [previewTurn, setPreviewTurn] = useState<string | null>(null)
  useLanguage()
  const previewId = useId()
  if (items.length < 2) return null
  const previewIndex = items.findIndex(item => item.key === previewTurn)
  const preview = previewIndex < 0 ? undefined : items[previewIndex]
  const previewPosition = previewIndex < 0 ? undefined : itemPosition(previewIndex, items.length)
  const previewAtPointer = (event: PointerEvent<HTMLElement>): void => {
    setPreviewTurn(itemAtPointer(items, event.currentTarget, event.clientY)?.key ?? null)
  }
  const navigateAtPointer = (event: MouseEvent<HTMLElement>): void => {
    const item = itemAtPointer(items, event.currentTarget, event.clientY)
    if (item !== undefined) onNavigate(item)
  }
  return (
    <div className={css.slot}>
      <nav
        className={css.rail}
        style={railSize(items.length)}
        aria-label={t('turnNavigationLabel')}
        onClick={navigateAtPointer}
        onPointerMove={previewAtPointer}
        onPointerLeave={() => { setPreviewTurn(null) }}
        onKeyDown={event => { if (event.key === 'Escape') setPreviewTurn(null) }}
      >
        <div className={css.marks}>
          {items.map((item, index) => {
            const active = item.key === activeTurn
            const showingPreview = item.key === previewTurn
            const markClass = active
              ? `${css.mark} ${css.markActive}`
              : showingPreview ? `${css.mark} ${css.markPreview}` : css.mark
            return (
              <div key={item.key} className={css.markPosition} style={itemPosition(index, items.length)}>
                <button
                  type="button"
                  className={markClass}
                  aria-label={t('turnNavigationJump', { n: item.ordinal })}
                  aria-current={active ? 'true' : undefined}
                  aria-describedby={showingPreview ? previewId : undefined}
                  onClick={(event) => {
                    event.stopPropagation()
                    onNavigate(item)
                  }}
                  onFocus={() => { setPreviewTurn(item.key) }}
                  onBlur={() => { setPreviewTurn(null) }}
                />
              </div>
            )
          })}
        </div>
        {preview !== undefined && previewPosition !== undefined && (
          <div id={previewId} role="tooltip" className={css.preview} style={previewPosition}>
            <div className={css.previewPrompt}>
              {preview.prompt || t('turnNavigationEntry', { n: preview.ordinal })}
            </div>
            {preview.response !== '' && <div className={css.previewResponse}>{preview.response}</div>}
          </div>
        )}
      </nav>
    </div>
  )
}

/**
 * Compact rail of all exchanges, including those outside the mounted window.
 * Memoization avoids rebuilding marks for unrelated pane updates; streamed
 * content deliberately refreshes the excerpt of the current exchange.
 */
export const TurnNavigator = memo(TurnNavigatorRail)
