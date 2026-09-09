/**
 * The hover card a usage reading opens, and the two readings that open it.
 *
 * **Why this exists.** Both usage readings — a reply's chip in its actions row
 * and the composer's session strip — used to carry their breakdown as a native
 * `title`: unreachable by touch, unreadable by a screen reader as a table, and
 * gone the moment the pointer left (`DEVIATIONS.md` 47). This replaces that
 * with one styled card for both.
 *
 * **The primitive it reuses.** Anchoring, viewport clamping and re-placement
 * on scroll and resize are `useAnchoredPosition` from
 * `@deepseek-ai/dsh-client-ui-primitives` — the same package the model
 * capsule's menu and the completion list come from, and the same engine its
 * portal mode uses. The dismissal is `ContextCard`'s transcribed idiom: one
 * document `pointerdown` and one `keydown` listener each, attached only while
 * the card is open. What is added here, and why it is added here rather than
 * into the package: the package's own `HoverCard` opens on hover alone — no
 * keyboard focus, no Escape, no touch toggle — and paints a hardcoded dsh
 * surface, so neither of the two cards' requirements (focus-reachable, Esc
 * closable, token-only colour) could be met by calling it. This composes the
 * package's exported engine with Iris's tokens instead of forking either.
 *
 * **The interaction model** is the tooltip disclosure: three independent
 * reasons to be open, and the card stays up while any one of them holds.
 *
 * - **hover** — pointer dwell opens, pointer leave closes after a short grace,
 *   so the trip from trigger to card (the card is portaled, so it is not a
 *   descendant and entering it is a leave of the trigger) does not close it;
 *   resting on the card holds it open, because the numbers are a bill and a
 *   reader may want to select them.
 * - **focus** — keyboard focus opens at once (a dwell would punish exactly the
 *   reader who cannot hover); blur closes.
 * - **pinned** — a touch tap toggles. Touch has no hover, so the tap is the
 *   whole interaction, and the outside-pointerdown dismissal is what closes it.
 *
 * Escape and an outside press clear all three at once: a dismissal is a
 * dismissal, whichever reason would otherwise still hold. After an Escape the
 * card stays closed even while the pointer or focus is still on the trigger,
 * until a fresh enter or focus — the native `title`'s own semantics, kept.
 *
 * @module iris-web/app/UsagePopover
 */

import { forwardRef, useCallback, useEffect, useId, useRef, useState } from 'react'
import type {
  HTMLAttributes,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'

import type { UsageDetailRow } from './token-format.ts'

/** Pointer dwell before a hover opens the card. Native titles take about a
    second; this is quicker, but not so quick that crossing the actions row
    flashes a card per chip. */
const OPEN_DWELL_MS = 300

/** How long the pointer may be off the trigger before hover counts as gone —
    the same grace the package's menus use for the trigger-to-list gap. */
const CLOSE_GRACE_MS = 200

/** Distance kept between the trigger and the card, and between the card and
    the viewport edges — the menu's own margin, so the two never clamp
    differently. */
const GAP_PX = 8
const VIEWPORT_MARGIN_PX = 12

/** What the card is opened by. More than one can hold at once; the card stays
    up while any does. */
interface OpenReasons {
  hovered: boolean
  focused: boolean
  /** Set by a touch tap, cleared by Escape or an outside press. */
  pinned: boolean
}

/** What the card shows. */
export interface UsagePopoverProps {
  /** The card's heading, and its accessible name. */
  heading: string
  /** The breakdown rows, in reading order. */
  rows: readonly UsageDetailRow[]
  /** Sentences under the rows — the composer card's account of the shares of
      its figure that were not turns, one paragraph each. The per-turn chip has
      none, so this is optional, and an empty array draws nothing. */
  notes?: readonly string[]
  /** The trigger element's class. */
  className: string
  /** The trigger's content — the reading itself, unchanged. */
  children: ReactNode
}

/**
 * The card itself: a heading over a two-column table of the rows.
 *
 * A `dl` rather than a table because the reading is pairs of term and
 * definition — the same element the context card's legend uses — and screen
 * readers announce the pairing natively. Optional notes render under the rows,
 * one paragraph each: the composer card carries its share sentences there, the
 * per-turn chip has none. Exported so the render check can prove the rows reach
 * markup without a pointer to hover.
 */
export const UsageDetailCard = forwardRef<
  HTMLDivElement,
  {
    heading: string
    rows: readonly UsageDetailRow[]
    notes?: readonly string[]
  } & HTMLAttributes<HTMLDivElement>
>(function UsageDetailCard({ heading, rows, notes, ...rest }, ref): ReactElement {
  return (
    <div ref={ref} className="iris-usage-card" data-control="usage-card" {...rest}>
      <span className="iris-label">{heading}</span>
      <dl className="iris-usage-card__rows">
        {rows.map(row => (
          <div className="iris-usage-card__row" key={`${row.label} ${row.value}`}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {(notes ?? []).filter(one => one !== '').map(one => (
        <p className="iris-usage-card__note" key={one}>{one}</p>
      ))}
    </div>
  )
})

/**
 * Wrap a usage reading in the disclosure: the reading stays exactly what it
 * was, and now carries the card.
 * @param props - the heading, the rows, and the reading to wrap.
 * @returns the trigger with the conditional portaled card.
 */
export function UsagePopover({ heading, rows, notes, className, children }: UsagePopoverProps): ReactElement {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [reasons, setReasons] = useState<OpenReasons>({ hovered: false, focused: false, pinned: false })
  const open = reasons.hovered || reasons.focused || reasons.pinned
  const cardId = useId()

  // Timers live in refs, not state: a pending dwell is not a renderable fact,
  // and clearing one must not re-render anything.
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // What touched the trigger last, so the focus that a touch tap drags along
  // with it is not read as a keyboard focus (the tap toggles instead).
  const lastPointer = useRef<string>('')

  const clearTimers = useCallback((): void => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current)
      openTimer.current = null
    }
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  /** Every reason withdrawn at once: Escape and an outside press are
      dismissals, not toggles. */
  const dismiss = useCallback((): void => {
    clearTimers()
    setReasons({ hovered: false, focused: false, pinned: false })
  }, [clearTimers])

  /** Hover leaving withdraws only hover — a focused trigger stays open. */
  const unhover = useCallback((): void => {
    setReasons(reasons => ({ ...reasons, hovered: false }))
  }, [])

  const position = useAnchoredPosition({
    open,
    anchorRef,
    panelRef: cardRef,
    gap: GAP_PX,
    margin: VIEWPORT_MARGIN_PX,
  })

  // ContextCard's transcribed dismissal, one listener each while open. The
  // trigger and the card are both "inside"; anything else is an outside press,
  // which is the only close a touch tap has.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (anchorRef.current?.contains(target) === true) return
      if (cardRef.current?.contains(target) === true) return
      dismiss()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, dismiss])

  return (
    <>
      {/*
        A span, not a button: the reading states a fact, it does not do
        anything, and the disclosure answers on hover, focus and touch without
        pretending a press is its job. `tabIndex` is what makes the keyboard
        path exist at all — the native `title` had none.
      */}
      <span
        ref={anchorRef}
        className={className}
        data-control="usage-detail"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        onPointerEnter={(event: ReactPointerEvent<HTMLSpanElement>) => {
          if (event.pointerType === 'touch') return
          if (closeTimer.current !== null) {
            clearTimeout(closeTimer.current)
            closeTimer.current = null
          }
          if (reasons.hovered || openTimer.current !== null) return
          openTimer.current = setTimeout(() => {
            openTimer.current = null
            setReasons(reasons => ({ ...reasons, hovered: true }))
          }, OPEN_DWELL_MS)
        }}
        onPointerLeave={(event: ReactPointerEvent<HTMLSpanElement>) => {
          if (event.pointerType === 'touch') return
          if (openTimer.current !== null) {
            clearTimeout(openTimer.current)
            openTimer.current = null
          }
          if (!reasons.hovered || closeTimer.current !== null) return
          closeTimer.current = setTimeout(() => {
            closeTimer.current = null
            unhover()
          }, CLOSE_GRACE_MS)
        }}
        onPointerDown={(event: ReactPointerEvent<HTMLSpanElement>) => {
          lastPointer.current = event.pointerType
          // Touch has no hover to speak of, so its tap is the toggle; the
          // focus it drags along is not read as a keyboard focus (see below).
          if (event.pointerType === 'touch') {
            setReasons(reasons => ({ ...reasons, pinned: !reasons.pinned }))
          }
        }}
        onFocus={() => {
          // A touch tap focuses too; the tap already toggled, so its focus is
          // not a second reason to open. Read once and cleared, so a later
          // keyboard Tab is not swallowed by an earlier touch.
          const viaTouch = lastPointer.current === 'touch'
          lastPointer.current = ''
          if (viaTouch) return
          setReasons(reasons => ({ ...reasons, focused: true }))
        }}
        onBlur={() => {
          setReasons(reasons => ({ ...reasons, focused: false }))
        }}
      >
        {children}
      </span>
      {/*
        Portaled, because the trigger lives inside a scroll container in both
        homes (the reading pane, the composer's `__inner`) and a scroll
        container clips its absolutely-positioned children — the reason
        `ContextCard` needed a non-scrolling sibling and the menus portal.
      */}
      {open && createPortal(
        <UsageDetailCard
          ref={cardRef}
          id={cardId}
          role="dialog"
          heading={heading}
          rows={rows}
          {...(notes === undefined ? {} : { notes })}
          // Fixed coordinates from the anchor, clamped into the viewport and
          // re-placed on scroll and resize (`useAnchoredPosition`). Hidden
          // until its first measurement lands, the menu's own mount order.
          style={position ?? { visibility: 'hidden' }}
          onPointerEnter={() => {
            if (closeTimer.current !== null) {
              clearTimeout(closeTimer.current)
              closeTimer.current = null
            }
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === 'touch') return
            if (closeTimer.current !== null) return
            closeTimer.current = setTimeout(() => {
              closeTimer.current = null
              unhover()
            }, CLOSE_GRACE_MS)
          }}
        />,
        document.body,
      )}
    </>
  )
}
