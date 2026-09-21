/**
 * The margin rail: one tick per assistant turn, hover for what that turn said.
 *
 * The reading column already carries a per-message marginalia track (the 46px
 * on `.iris-msg`), but its marks answer "which floor is this" — they do not
 * answer "what did turn twelve say". This rail is the archive-flip answer: one
 * tick per settled reply, the newest boldest, hovering a tick floating a
 * preview card with the turn's status line and a bounded excerpt of its text.
 *
 * The preview text is bounded the same way dsh's trajectory preview bounds
 * its own: `extractMarkdownPlainText` over the first slice, whitespace
 * collapsed, a hard cap, and the ellipsis only when something was actually
 * cut. The component rides the column as a zero-height sticky nav, so it
 * stays pinned while the conversation scrolls under it.
 *
 * @module iris-web/app/TurnRail
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { extractMarkdownPlainText } from '@deepseek-ai/dsh-client-ui-primitives'

import type { MessageView } from '@iris/protocol'

import { useLanguage, t } from './i18n/use-language.ts'

/** How much of a turn's text the source slice may inspect before capping. */
const PREVIEW_SOURCE_CHARACTERS = 2_048
/** How much of the compacted preview a card may show. */
const PREVIEW_OUTPUT_CHARACTERS = 200

/**
 * A bounded one-line preview of a turn's text, without parsing the Markdown.
 *
 * The same shape `ui-trajectory`'s preview uses upstream, for the same
 * reason: the excerpt is a compass, not the text.
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
  // Subscribed so a language switch re-renders the rail's words.
  useLanguage()

  const turns = messages.filter(message => message.role === 'assistant' && message.streaming !== true)
  if (turns.length === 0) return null

  return (
    <nav className="iris-turnrail" aria-label={t('turnRailAria')}>
      {turns.map((turn: MessageView, index: number) => (
        <div
          key={turn.key}
          className="iris-turnrail__slot"
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
      ))}
    </nav>
  )
}
