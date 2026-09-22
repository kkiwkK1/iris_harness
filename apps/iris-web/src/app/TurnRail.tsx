/**
 * The turn rail: a minimap of the conversation in the air left of the reading
 * column — one tick per **exchange** (what the user sent plus what the model
 * replied), laid out proportionally to where that exchange sits in the
 * document, so the rail always spans the band no matter how long the
 * conversation grows. Hovering a tick floats that exchange's preview card;
 * clicking scrolls the exchange to the top of the reading surface.
 *
 * The preview card shows both sides: the user's line first (bounded tighter —
 * it is a prompt, not the story), then the reply's bounded excerpt. Both are
 * bounded the way dsh's trajectory preview bounds its own:
 * `extractMarkdownPlainText` over the first slice, whitespace collapsed, a
 * hard cap, and the ellipsis only when something was actually cut — from the
 * same dsh primitives package the composer reads.
 *
 * @module iris-web/app/TurnRail
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ReactElement } from 'react'
import { extractMarkdownPlainText } from '@deepseek-ai/dsh-client-ui-primitives'

import type { MessageView } from '@iris/protocol'

import { useLanguage, t } from './i18n/use-language.ts'

/** How much of a text the source slice may inspect before capping. */
const PREVIEW_SOURCE_CHARACTERS = 2_048
/** How much of the reply's compacted preview a card may show. */
const REPLY_OUTPUT_CHARACTERS = 200
/** The user's own line is a prompt; it earns a shorter bound. */
const USER_OUTPUT_CHARACTERS = 100

/**
 * A bounded one-line preview of a text, without parsing the Markdown.
 * @param text - the stored text, blocks and all.
 * @param cap - the compact preview's character ceiling.
 * @returns the compact preview, ending in an ellipsis when something was cut.
 */
function previewOf(text: string, cap: number): string {
  // Style and script runs are the preset's machinery, not prose — the reading
  // surface turns them into sheets and frames, never into text, and a preview
  // that showed their bytes would show machinery too.
  const source = text
    .slice(0, PREVIEW_SOURCE_CHARACTERS)
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/(style|script)>\s*/gi, '')
    .replace(/<(style|script)[^>]*>[\s\S]*$/i, '')
  const compact = extractMarkdownPlainText(source).replace(/\s+/g, ' ').trim()
  const preview = compact.slice(0, cap).trimEnd()
  return source.length < text.length || preview.length < compact.length
    ? `${preview}…`
    : preview
}

/**
 * The rail's own height, as a fraction of the reading band — the band var the
 * composer and the frames already share.
 */
const RAIL_HEIGHT = 'calc(var(--iris-app-frame-height, 100vh) * 0.72)'

/** One exchange: what the user sent, and what the model replied. */
interface Exchange {
  /** The floor the exchange starts at — its user line, or its reply alone. */
  startFloor: number
  /** Identity for hover state, stable while the chat is open. */
  key: string
  userText: string | undefined
  replyText: string | undefined
  reasoningMs: number | undefined
  /** True while this exchange's reply is still arriving. */
  streaming: boolean
}

/**
 * Fold the visible floors into exchanges.
 *
 * A user line opens an exchange; the assistant replies that follow belong to
 * it (a continue grows the same round). An assistant floor with no user line
 * before it is an exchange of its own: the greeting is content too. The
 * in-flight round (a reply still streaming) is left out — the rail shows
 * settled history, and the round appears when it settles.
 * @param messages - the visible conversation, in floor order.
 * @returns the exchanges in floor order.
 */
function exchangesOf(messages: readonly MessageView[]): Exchange[] {
  const exchanges: Exchange[] = []
  let open:
    | {
        startFloor: number
        key: string
        userText: string | undefined
        replyText: string | undefined
        reasoningMs: number | undefined
        streaming: boolean
      }
    | undefined = undefined

  const close = (): void => {
    if (open === undefined) return
    if (open.userText === undefined && open.replyText === undefined) return
    exchanges.push({
      startFloor: open.startFloor,
      key: open.key,
      userText: open.userText,
      replyText: open.replyText,
      reasoningMs: open.reasoningMs,
      streaming: open.streaming,
    })
  }

  for (const message of messages) {
    if (message.role === 'user') {
      close()
      open = {
        startFloor: message.id,
        key: message.key,
        userText: message.text,
        replyText: undefined,
        reasoningMs: undefined,
        streaming: message.streaming === true,
      }
      continue
    }
    if (message.role !== 'assistant') continue
    if (open === undefined) {
      open = {
        startFloor: message.id,
        key: message.key,
        userText: undefined,
        replyText: message.text,
        reasoningMs: message.generation?.reasoningMs,
        streaming: message.streaming === true,
      }
      continue
    }
    open.replyText = message.text
    open.reasoningMs = message.generation?.reasoningMs ?? open.reasoningMs
    open.streaming = message.streaming === true
  }
  close()
  return exchanges.filter(exchange => !exchange.streaming)
}

/**
 * @param props.messages - the visible conversation, in floor order.
 * @param props.onJump - scroll the reading surface to an exchange's floor.
 * @returns the rail, or null before the first reply has settled.
 */
export function TurnRail({ messages, onJump }: {
  messages: readonly MessageView[]
  onJump: (floor: number) => void
}): ReactElement | null {
  const [hovered, setHovered] = useState<string | undefined>(undefined)
  /** Each exchange's midpoint as a fraction of the whole document, 0..1. */
  const [fractions, setFractions] = useState<readonly number[]>([])
  const railRef = useRef<HTMLElement | undefined>(undefined)
  useLanguage()

  const exchanges = useMemo(() => exchangesOf(messages), [messages])

  /*
   * Measure each exchange's midpoint as a fraction of the whole document,
   * from the live DOM. The positions are document-proportional, so they are
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
      setFractions(exchanges.map(exchange => {
        const row = rows.get(String(exchange.startFloor))
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
  }, [exchanges])

  if (exchanges.length === 0) return null

  return (
    <nav
      className="iris-turnrail"
      aria-label={t('turnRailAria')}
      ref={railRef as React.Ref<HTMLElement>}
      style={{ '--iris-turnrail-h': RAIL_HEIGHT } as CSSProperties}
    >
      <div className="iris-turnrail__column">
        {exchanges.map((exchange: Exchange, index: number) => {
          const fraction = fractions[index]
          return (
            <div
              key={exchange.key}
              className="iris-turnrail__slot"
              style={{
                ...(fraction === undefined ? {} : { top: `${Math.round(fraction * 1000) / 10}%` }),
                '--iris-turnrail-i': String(index),
              } as CSSProperties}
              onMouseEnter={() => setHovered(exchange.key)}
              onMouseLeave={() => setHovered(current => (current === exchange.key ? undefined : current))}
            >
              <button
                type="button"
                className="iris-turnrail__tick"
                data-current={index === exchanges.length - 1 || undefined}
                aria-label={t('turnRailJumpAria', { n: index + 1 })}
                onClick={() => onJump(exchange.startFloor)}
              />
              {hovered === exchange.key && (
                <div className="iris-turnrail__preview" role="tooltip">
                  {exchange.userText !== undefined && (
                    <p className="iris-turnrail__you">
                      <span className="iris-turnrail__you-label">{t('turnRailYou')}</span>
                      {previewOf(exchange.userText, USER_OUTPUT_CHARACTERS)}
                    </p>
                  )}
                  {exchange.replyText !== undefined && (
                    <p className="iris-turnrail__excerpt">
                      {previewOf(exchange.replyText, REPLY_OUTPUT_CHARACTERS)}
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </nav>
  )
}
