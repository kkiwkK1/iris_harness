/**
 * The chat's variables, in the desk's margin.
 *
 * This exists because a wide window had nothing in it. The reading column must
 * not grow — thirty characters a line is the thing that works — so past 1360px
 * the space beside the sheet gets real content rather than more emptiness. The
 * variables are the obvious candidate: the protocol already carries them, MVU
 * cards spend their whole life writing them, and "what is the state right now"
 * is a question a reader of a long scene actually asks.
 *
 * Marginalia, in other words. Same figure as the variant rail, one scale up.
 *
 * @module iris-web/app/StatePanel
 */

import type { ReactElement } from 'react'
import { JsonTree } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris } from '../client/provider.tsx'

/** Whether a value can be shown as a single line of text. */
function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/**
 * Render the state margin.
 * @returns the aside; hidden below the width where it has room.
 */
export function StatePanel(): ReactElement | null {
  const variables = useIris(state => state.view?.variables)
  const open = useIris(state => state.chatId !== undefined)
  if (!open) return null

  const entries = Object.entries(variables ?? {})
  const scalars = entries.filter(([, value]) => isScalar(value))
  const nested = entries.filter(([, value]) => !isScalar(value))

  return (
    <aside className="iris-aside" aria-label="Conversation state">
      <div className="iris-aside__inner">
        <h2 className="iris-label iris-aside__head">State</h2>
        {entries.length === 0 ? (
          <p className="iris-aside__empty">
            Nothing tracked yet. A card that keeps variables will fill this in as the scene moves.
          </p>
        ) : (
          <>
            <dl className="iris-state">
              {scalars.map(([key, value]) => (
                <div className="iris-state__row" key={key}>
                  <dt className="iris-state__key">{key}</dt>
                  <dd className="iris-state__value">{String(value)}</dd>
                </div>
              ))}
            </dl>
            {nested.map(([key, value]) => (
              <div className="iris-state__nested" key={key}>
                <div className="iris-state__key">{key}</div>
                <JsonTree data={value as object} label={key} copyable expandTopLevel />
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  )
}
