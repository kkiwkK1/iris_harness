/**
 * The turn rail: a minimap of the conversation in the air left of the reading
 * column — one tick per settled reply, laid out proportionally to where that
 * turn sits in the document, so the rail always spans the band no matter how
 * long the conversation grows: three turns spread across it, thirty compress
 * into it, and neither runs off the edge. Hovering a tick floats that turn's
 * preview card; clicking scrolls the turn to the top of the reading surface.
 *
 * The excerpt inside the preview card is bounded the way dsh's trajectory
 * preview bounds its own: `extractMarkdownPlainText` over the first slice,
 * whitespace collapsed, a hard cap, and the ellipsis only when something was
 * actually cut — from the same dsh primitives package the composer reads.
 *
 * @module iris-web/app/TurnRail
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ReactElement } from 'react'
import { extractMarkdownPlainText } from '@deepseek-ai/dsh-client-ui-primitives'

import type { MessageView } from '@iris/protocol'

import { useLanguage, t } from './i18n/use-language.ts'

/** How much of a turn's text the source slice may inspect before capping. */
const PREVIEW_SOURCE_CHARACTERS = 2_048
/** How much of the compacted preview a card may show. */
const PREVIEW_OUTPUT_CHARACTERS = 200
/**
 * The rail's own height, as a fraction of the reading band — the band var the
 * composer and the frames already share.
 */
const RAIL_HEIGHT = 'calc(var(--iris-app-frame-height, 100vh) * 0.72)'

/**
 * A bounded one-line preview of a turn's text, without parsing the Markdown.
 * @param text - the turn's stored text, blocks and all.
 * @returns the compact preview, ending in an ellipsis when something was cut.
 */
function previewOf(text: string): string {
  const source = text.slice(0, PREVIEW_SOURCE_CHARACTERS)
  const compact = extractMarkdownPlainText(source).replace(/\s+/g, ' ').trim()
  const preview = compact.slice(0, PREVIEW_OUTPUT_CHARACTERS).trimEnd()
  return source.length < text.length || preview.length < compact.length
    ? `${preview}…`
    : preview
}

/**
 * @param props.messages - the visible conversation, in floor order.
 * @param props.onJump - scroll the reading surface to a turn's floor.
 * @returns the rail, or null before the first reply has settled.
 */
export function TurnRail({ messages, onJump }: {
  messages: readonly MessageView[]
  onJump: (floor: number) => void
}): ReactElement | null {
  const [hovered, setHovered] = useState<string | undefined>(undefined)
  /** Each turn's midpoint as a fraction of the whole document, 0..1. */
  const [fractions, setFractions] = useState<readonly number[]>([])
  const railRef = useRef<HTMLElement | undefined>(undefined)
  useLanguage()

  const turns = useMemo(
    () => messages.filter(message => message.role === 'assistant' && message.streaming !== true),
    [messages],
  )

  /*
   * Measure each turn's midpoint as a fraction of the whole document, from
   * the live DOM. The positions are document-proportional, so they are
   * stable while the page scrolls and only move when the content does — the
   * mutation observer catches streaming growth and edits, the resize handler
   * catches the window around them.
   */
  useEffect(() => {
    const rail = railRef.current
    const scroller = rail?.closest('.iris-scroll')
    if (scroller === null || !(scroller instanceof HTMLElement)) return undefined

    const measure = (): void => {
      const rows = new Map(
        [...scroller.querySelectorAll<HTMLElement>('.iris-msg[data-floor]')]
          .map(row => [row.getAttribute('data-floor') ?? '', row]),
      )
      const total = Math.max(1, scroller.scrollHeight)
      setFractions(turns.map(turn => {
        const row = rows.get(String(turn.id))
        if (row === undefined) return 1
        const rect = row.getBoundingClientRect()
        const bounds = scroller.getBoundingClientRect()
        const midpoint = rect.top - bounds.top + scroller.scrollTop + rect.height / 2
        return Math.max(0, Math.min(1, midpoint / total))
      }))
    }

    measure()
    let scheduled = 0
    const throttled = (): void => {
      cancelAnimationFrame(scheduled)
      scheduled = requestAnimationFrame(measure)
    }
    const observer = new MutationObserver(throttled)
    observer.observe(scroller, { childList: true, subtree: true, characterData: true })
    window.addEventListener('resize', throttled)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', throttled)
      cancelAnimationFrame(scheduled)
    }
  }, [turns])

  if (turns.length === 0) return null

  return (
    <nav
      className="iris-turnrail"
      aria-label={t('turnRailAria')}
      ref={railRef as React.Ref<HTMLElement>}
      style={{ '--iris-turnrail-h': RAIL_HEIGHT } as CSSProperties}
    >
      <div className="iris-turnrail__column">
        {turns.map((turn: MessageView, index: number) => {
          const fraction = fractions[index]
          return (
            <div
              key={turn.key}
              className="iris-turnrail__slot"
              style={{
                ...(fraction === undefined ? {} : { top: `${Math.round(fraction * 1000) / 10}%` }),
                '--iris-turnrail-i': String(index),
              } as CSSProperties}
              onMouseEnter={() => setHovered(turn.key)}
              onMouseLeave={() => setHovered(current => (current === turn.key ? undefined : current))}
            >
              <button
                type="button"
                className="iris-turnrail__tick"
                data-current={index === turns.length - 1 || undefined}
                aria-label={t('turnRailJumpAria', { n: index + 1 })}
                onClick={() => onJump(turn.id)}
              />
              {hovered === turn.key && (
                <div className="iris-turnrail__preview" role="tooltip">
                  {turn.generation?.reasoningMs !== undefined && (
                    <span className="iris-turnrail__meta">
                      {t('turnRailThinking', { seconds: Math.max(1, Math.round(turn.generation.reasoningMs / 1000)) })}
                    </span>
                  )}
                  <p className="iris-turnrail__excerpt">{previewOf(turn.text)}</p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </nav>
  )
}
