/**
 * The drawer's entry to the usage page.
 *
 * A card with one button rather than the page itself, and the reason is a
 * measurement of the drawer: it is 392px wide, and the chart keeps a legible
 * column per time bucket — a 30-day range needs about 1.7 of those widths
 * before it has to scroll. So the page is a dialog (`./UsagePanel.tsx`) and
 * this is the handle, which is also what lets the reading surface stay visible
 * behind it.
 *
 * The dialog's own state lives here rather than in `App`, so the entry and the
 * page it opens are one component and nothing has to be threaded through the
 * drawer's props. The one thing that *is* threaded is `onNavigate`: opening a
 * conversation from a subtotal row has to close the drawer as well, or the
 * reader is left looking at settings over the chat they just asked for.
 *
 * @module iris-web/app/UsageSection
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIrisActions } from '../client/provider.tsx'
import { CollapsibleSection } from './fields.tsx'
import { UsagePanel } from './UsagePanel.tsx'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Render the entry card and, while open, the usage page.
 * @param props.onNavigate - called when the page sends the reader to a
 *   conversation, so the surface that opened this can get out of the way.
 * @returns the card.
 */
export function UsageSection({ onNavigate }: { onNavigate?: () => void }): ReactElement {
  const actions = useIrisActions()
  const [open, setOpen] = useState(false)
  // Subscribed so a language switch re-renders the card's words.
  useLanguage()

  return (
    <CollapsibleSection id="usage" title={t('usageEntry')} summary={t('usageEntrySummary')}>
      <div className="iris-field iris-field--tight">
        <span className="iris-field__label">{t('usageEntry')}</span>
        <span />
        <div className="iris-field__control">
          <Button
            variant="outline"
            size="sm"
            data-control="usage"
            onClick={() => { setOpen(true) }}
          >
            {t('usageOpen')}
          </Button>
        </div>
      </div>
      <UsagePanel
        open={open}
        onClose={() => { setOpen(false) }}
        onOpenChat={chatId => {
          setOpen(false)
          onNavigate?.()
          void actions.openChat(chatId)
        }}
      />
    </CollapsibleSection>
  )
}
