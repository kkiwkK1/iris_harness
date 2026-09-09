/**
 * The composer bar's own menu surface.
 *
 * Three controls in the bar open a list — the 「+」 key, the preset name and the
 * model control — and all three open **this**, so a reader who has learned one
 * has learned the others.
 *
 * **Why not the primitives' `Menu`.** It is what the composer used before, and
 * the slash-command completion list still uses it, because for a typeahead it
 * is exactly right. What it cannot do is the one thing this surface has to: its
 * rows are `role="menuitem"`, minted inside the component from a plain data
 * array, and the effort ladder is a **radio set** — six mutually exclusive
 * answers to one question, of which exactly one is in force. Announced as six
 * plain menu items, a screen reader is told there are six things to do here and
 * not that choosing one un-chooses the rest. `menuitemradio` with
 * `aria-checked` is the shape ARIA has for that, and the row element is where
 * it goes, so the row has to be ours. The model list is the same kind of set
 * and gets the same treatment.
 *
 * What is transcribed from the primitive rather than reinvented: the portal to
 * `document.body` (the composer's `__inner` is a scroll container and clips its
 * absolutely-positioned children — `panels.css` says why it must stay one), the
 * placement from the trigger's own rect with a 12px viewport margin, the
 * re-placement on scroll and resize while open, and the dismissal pair — one
 * document `pointerdown` listener and one `keydown`, only while open. The
 * additions are keyboard ones the primitive leaves out: focus enters the list on
 * open, the arrows and Home/End move between rows, and focus goes back to the
 * trigger on the way out, which is what makes a menu reachable without a mouse.
 *
 * **Mounted only while open** (the callers gate on their own state, there is no
 * `open` prop). That is structural rather than tidy: a closed menu holds no
 * document listeners, pays no layout effect on a keystroke of the draft, and —
 * the reason it is written this way — never calls a layout effect during a
 * server render, where the composer is rendered closed by `tools/render-check`.
 *
 * @module iris-web/app/ComposerMenu
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MutableRefObject, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** The gap between the trigger and the list, and the list's viewport margin. */
const GAP = 6
const MARGIN = 12

/**
 * Render one open menu above its trigger.
 * @param props.anchor - the trigger, for placement, dismissal and focus return.
 * @param props.label - the list's accessible name.
 * @param props.align - which edge of the trigger the list lines up with.
 * @param props.onClose - called on Escape, an outside press, and a row choice.
 * @param props.children - the rows.
 * @returns the portalled list.
 */
export function ComposerMenu({
  anchor,
  label,
  align = 'start',
  onClose,
  children,
}: {
  anchor: MutableRefObject<HTMLButtonElement | null>
  label: string
  align?: 'start' | 'end'
  onClose: () => void
  children: ReactNode
}): ReactElement | null {
  const list = useRef<HTMLDivElement | null>(null)
  const [at, setAt] = useState<{ left: number, top: number } | undefined>(undefined)

  /*
   * Placed from the trigger's rect, in a layout effect so the first paint is
   * the placed one. Until it is measured the list is laid out but not painted
   * (`visibility: hidden` below), because a list that paints at 0,0 for one
   * frame is a flash in the corner of the screen every time a menu opens.
   */
  const place = useCallback((): void => {
    const trigger = anchor.current
    const box = list.current
    if (trigger === null || box === null) return
    const rect = trigger.getBoundingClientRect()
    const width = box.offsetWidth
    const height = box.offsetHeight
    const wanted = align === 'end' ? rect.right - width : rect.left
    const left = Math.min(Math.max(wanted, MARGIN), Math.max(MARGIN, window.innerWidth - width - MARGIN))
    // Above the trigger, which is where a bar at the bottom of the page has
    // room. Flipped below only when there is genuinely no room above, so the
    // list is never half off the top edge.
    const above = rect.top - height - GAP
    const top = above >= MARGIN ? above : Math.min(rect.bottom + GAP, window.innerHeight - height - MARGIN)
    setAt({ left, top })
  }, [align, anchor])

  useLayoutEffect(() => {
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [place])

  // Focus enters the list, and goes back to the trigger when the list goes. The
  // return is in the cleanup rather than in `onClose`, so it happens however the
  // menu was dismissed — including by the row that closed it.
  useEffect(() => {
    const trigger = anchor.current
    rows(list.current)[0]?.focus()
    return () => {
      // Only if the reader is still in the list: a press on another control
      // took focus deliberately, and dragging it back would fight them.
      if (list.current?.contains(document.activeElement) === true) trigger?.focus()
    }
  }, [anchor])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (list.current?.contains(target) === true) return
      // The trigger is excluded, or its own press would close the list on
      // pointerdown and its click would reopen it — a toggle that never toggles.
      if (anchor.current?.contains(target) === true) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor, onClose])

  return createPortal(
    <div
      ref={list}
      className="iris-composer-menu"
      role="menu"
      aria-label={label}
      style={at === undefined ? { visibility: 'hidden' } : { left: `${String(at.left)}px`, top: `${String(at.top)}px` }}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
        const items = rows(list.current)
        if (items.length === 0) return
        if (step !== 0) {
          event.preventDefault()
          const here = items.indexOf(document.activeElement as HTMLButtonElement)
          const next = here === -1 ? 0 : (here + step + items.length) % items.length
          items[next]?.focus()
          return
        }
        if (event.key === 'Home') {
          event.preventDefault()
          items[0]?.focus()
        }
        if (event.key === 'End') {
          event.preventDefault()
          items[items.length - 1]?.focus()
        }
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

/**
 * The rows a reader can land on, in document order.
 *
 * Disabled rows are excluded rather than skipped later: the note row that
 * explains a missing model list is a sentence, and an arrow key that stopped on
 * it would be a keyboard trap in the middle of a list.
 * @param box - the list element.
 * @returns the focusable rows.
 */
function rows(box: HTMLDivElement | null): HTMLButtonElement[] {
  if (box === null) return []
  return [...box.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not([disabled])')]
}

/**
 * One chooseable row.
 *
 * `checked` is what decides the role, and the two cases are different
 * statements: a row with no `checked` is an action (「open the breakdown」),
 * a row with one is a member of a set exactly one of whose members is in force
 * (a model, an effort, a preset). Passing `false` is therefore meaningful — it
 * says "one of these, not this one" — and omitting it says "not a set at all".
 * @param props.checked - membership in a radio set, and whether this is the one.
 * @param props.onSelect - what the press does; the caller closes the menu.
 * @param props.note - a second, quieter half of the row, right-aligned.
 * @param props.children - the row's words.
 * @returns the row.
 */
export function ComposerMenuItem({
  checked,
  onSelect,
  note,
  children,
}: {
  checked?: boolean
  onSelect: () => void
  note?: string
  children: ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      {...checked === undefined ? {} : { 'aria-checked': checked }}
      className={`iris-composer-menu__item${checked === true ? ' iris-composer-menu__item--on' : ''}`}
      onClick={onSelect}
    >
      <span className="iris-composer-menu__label">{children}</span>
      {note === undefined ? null : <span className="iris-composer-menu__note">{note}</span>}
    </button>
  )
}

/**
 * A heading over a group of rows.
 *
 * `role="presentation"` and never focusable, the primitive's own treatment of a
 * label row: it names what the rows below it are and pressing it does nothing,
 * so it must not be somewhere the arrow keys stop.
 * @param props.id - so the group of rows below can be labelled *by* this
 * heading rather than carry a second copy of its words in an `aria-label`. Two
 * copies is how the visible heading and the announced one come to differ.
 * @param props.children - the heading's words.
 * @returns the heading.
 */
export function ComposerMenuLabel({ id, children }: { id?: string, children: ReactNode }): ReactElement {
  return <div className="iris-composer-menu__head" role="presentation" id={id}>{children}</div>
}

/**
 * The one row that explains the list's own state.
 *
 * A sentence, not a control — 「no model list for this connection yet」 — so it
 * is not a `button` at all and the arrows pass over it.
 * @param props.children - the sentence.
 * @returns the row.
 */
export function ComposerMenuNote({ children }: { children: ReactNode }): ReactElement {
  return <p className="iris-composer-menu__sentence" role="presentation">{children}</p>
}
