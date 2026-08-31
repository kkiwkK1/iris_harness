/**
 * Where the context went.
 *
 * The panel's shape comes from one measurement rather than from a guess about
 * what a breakdown looks like: on a real preset and card, 1920 of 2929 prompt
 * tokens were a single world-info injection. So this is not a chart of comparable
 * parts — it is one column and a pile of rubble, and the design follows from
 * that.
 *
 * - **A proportion bar first**, because "one thing is eating everything" is the
 *   headline and a table of numbers makes the reader compute it.
 * - **Rows ordered by size by default**, so the answer is the first line rather
 *   than somewhere in the middle of forty two-token rows.
 * - **`label`, never `id`.** 29 of that preset's 41 prompts identify themselves
 *   with a UUID; the label is the string SillyTavern shows, so a user who
 *   imported the preset recognises the row.
 * - **Nothing merged into an "other".** The rubble is thin but it is real, and a
 *   panel whose job is accounting must not round away the parts it finds small.
 *
 * @module iris-web/app/PromptPanel
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptItemization } from '@iris/protocol'

import { useIrisActions } from '../client/provider.tsx'
import {
  budgetUse,
  contributing,
  discrepancy,
  itemizationMode,
  rowsFor,
  type ItemOrder,
} from './itemization.ts'

/** One decimal, and only where it says something: 0.4% and 66% both have to read cleanly. */
function percent(share: number): string {
  const value = share * 100
  if (value >= 10) return `${Math.round(value)}%`
  if (value >= 1) return `${value.toFixed(1)}%`
  return value === 0 ? '0%' : '<1%'
}

/** What the panel is doing. */
type PanelState =
  | { kind: 'loading' }
  | { kind: 'error', message: string }
  | { kind: 'ready', itemization: PromptItemization }

/**
 * Render the breakdown panel.
 * @param props.open - whether the panel is showing.
 * @param props.turn - the turn to itemize, or undefined to preview the next request.
 * @param props.onClose - dismissal.
 * @returns the modal.
 */
export function PromptPanel({
  open,
  turn,
  onClose,
}: {
  open: boolean
  turn: number | undefined
  onClose: () => void
}): ReactElement {
  const actions = useIrisActions()
  const [order, setOrder] = useState<ItemOrder>('size')
  const [state, setState] = useState<PanelState>({ kind: 'loading' })

  useEffect(() => {
    if (!open) return
    let live = true
    setState({ kind: 'loading' })
    void actions.itemize(turn).then(result => {
      if (!live) return
      setState(
        result.ok
          ? { kind: 'ready', itemization: result.itemization }
          : { kind: 'error', message: `${result.error.code}: ${result.error.message}` },
      )
    })
    return () => {
      live = false
    }
  }, [open, turn, actions])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={turn === undefined ? 'How the next request assembles' : `How turn ${turn} was assembled`}
      closeLabel="Close"
    >
      {state.kind === 'loading' ? <p className="iris-list__empty">Counting…</p> : null}
      {state.kind === 'error' ? <p className="iris-list__empty">{state.message}</p> : null}
      {state.kind === 'ready' ? (
        <Breakdown
          itemization={state.itemization}
          requestedTurn={turn}
          order={order}
          onOrder={setOrder}
        />
      ) : null}
    </Modal>
  )
}

/** The breakdown itself, once it has arrived. */
function Breakdown({
  itemization,
  requestedTurn,
  order,
  onOrder,
}: {
  itemization: PromptItemization
  requestedTurn: number | undefined
  order: ItemOrder
  onOrder: (order: ItemOrder) => void
}): ReactElement {
  const rows = rowsFor(itemization.entries, order, itemization.tokens)
  const use = budgetUse(itemization)
  const mismatch = discrepancy(itemization)
  const mode = itemizationMode(itemization, requestedTurn)

  return (
    <div className="iris-prompt">
      {mode === 'expired' ? (
        <p className="iris-prompt__notice">
          The record for this turn was lost when the chat closed. This is how the request would
          assemble now.
        </p>
      ) : null}
      {mismatch === undefined ? null : (
        <p className="iris-prompt__notice iris-prompt__notice--wrong">
          These parts add up to {(itemization.tokens + mismatch).toLocaleString()}, not the reported{' '}
          {itemization.tokens.toLocaleString()}. Treat the numbers below as unreliable.
        </p>
      )}

      <div className="iris-prompt__totals">
        <div className="iris-prompt__total">
          <span className="iris-prompt__figure">{itemization.tokens.toLocaleString()}</span>
          <span className="iris-label">estimated</span>
        </div>
        {itemization.actualTokens === undefined ? null : (
          <div className="iris-prompt__total">
            <span className="iris-prompt__figure">{itemization.actualTokens.toLocaleString()}</span>
            {/* Both, side by side: the only way to answer "is the estimate
                trustworthy", which the reader cannot otherwise ask. */}
            <span className="iris-label">provider counted</span>
          </div>
        )}
        <div className="iris-prompt__total">
          <span className="iris-prompt__figure">{percent(use.used)}</span>
          <span className="iris-label">of {use.available.toLocaleString()} available</span>
        </div>
      </div>

      {/*
        One bar, proportions only, always in assembly order — the bar answers
        "how is it divided", and reordering its segments would make the same
        prompt look like a different one depending on a control above it.
        Nothing is merged, so a one-pixel segment stays a real part.
      */}
      <div className="iris-prompt__bar" role="img" aria-label="Share of the prompt by part">
        {rowsFor(contributing(itemization.entries), 'assembly', itemization.tokens).map(row => (
          <span
            key={row.entry.id}
            className={`iris-prompt__slice iris-prompt__slice--${row.entry.kind}`}
            style={{ width: `${row.share * 100}%` }}
            title={`${row.entry.label} · ${row.entry.tokens.toLocaleString()}`}
          />
        ))}
      </div>

      <div className="iris-prompt__controls">
        <div className="iris-choice" role="group" aria-label="Row order">
          <button
            type="button"
            className="iris-choice__option"
            aria-pressed={order === 'size'}
            onClick={() => onOrder('size')}
          >
            Largest first
          </button>
          <button
            type="button"
            className="iris-choice__option"
            aria-pressed={order === 'assembly'}
            onClick={() => onOrder('assembly')}
          >
            In assembly order
          </button>
        </div>
        {itemization.droppedHistory === 0 ? null : (
          <span className="iris-meta">
            {itemization.droppedHistory} earlier messages dropped to fit
          </span>
        )}
        {itemization.overBudget ? <span className="iris-prompt__over">over budget</span> : null}
      </div>

      <ul className="iris-prompt__rows">
        {rows.map(row => (
          <li className="iris-prompt__row" key={row.entry.id}>
            <span className={`iris-prompt__kind iris-prompt__kind--${row.entry.kind}`}>
              {row.entry.kind === 'depth' ? `@${row.entry.depth ?? 0}` : row.entry.kind}
            </span>
            {/* The id is the tooltip, not the text: it is usually a UUID. */}
            <span className="iris-prompt__label" title={row.entry.id}>
              {row.entry.label}
              {row.entry.role === undefined ? null : <span className="iris-meta"> {row.entry.role}</span>}
            </span>
            {/*
              A zero-token part reads as "empty", not as "0". They are common — 14
              of one real preset's 53 — and a reader looking for one is asking why
              their X did not get through. Seeing it present and empty answers
              that; seeing `0` invites them to wonder if the count is broken.
            */}
            <span className="iris-prompt__share iris-meta">
              {row.entry.tokens === 0 ? '' : percent(row.share)}
            </span>
            <span className={`iris-prompt__tokens${row.entry.tokens === 0 ? ' iris-prompt__tokens--empty' : ''}`}>
              {row.entry.tokens === 0 ? 'empty' : row.entry.tokens.toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
