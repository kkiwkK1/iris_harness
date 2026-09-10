/**
 * The sidebar's small line icons.
 *
 * Kept apart from `marks.tsx` because these are not marks: a chevron, a grip
 * and three tab glyphs carry *function*, and `marks.tsx` is the identity and
 * 「梅花」's decoration. Mixing them would put the product's name in the same
 * file as a search magnifier, and the two change for different reasons.
 *
 * **Why icons here at all.** The shell has drawn its controls with text glyphs
 * — `☰`, `⋯`, `★`, `✕` — which cost nothing and are the right answer for a
 * word-sized action. The collapsed rail is the case they cannot serve: 44px of
 * column with no room for a label, where the glyph *is* the whole control, and
 * a font-dependent 「☰」 that renders at a different weight on every machine is
 * not a set. These are drawn instead: one 16-unit grid, 1.5 stroke, round caps
 * and joins, `currentColor` throughout — so a rail icon takes its state from
 * the button it sits in and needs no second colour decision.
 *
 * Every root is `aria-hidden`: the accessible name is always on the control
 * around the icon, never on the drawing, because the drawing is one of several
 * things a control can hold and the name has to survive it changing.
 *
 * @module iris-web/app/icons
 */

import type { ReactElement } from 'react'

/**
 * The wrapper every icon here shares.
 *
 * One element with the stroke settings on it rather than eight copies of five
 * attributes: the family is only a family because the settings are identical,
 * and five attributes repeated eight times is five chances for one glyph to
 * drift a half-pixel heavier than the rest.
 * @param props.size - the drawn edge in pixels.
 * @param props.children - the paths, on a 16-unit grid.
 * @returns the icon.
 */
function Glyph({ size, children }: { size: number, children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <svg
      className="iris-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/**
 * The collapse chevron: an arrow into a wall.
 *
 * The wall is the point. A bare `‹` says "back", and this control does not
 * navigate — it puts the panel against the window's edge, which is what an
 * arrow arriving at a bar draws. Flipped horizontally in the rail
 * (`shell.css`), so one drawing serves both directions.
 * @param props.size - the drawn edge in pixels; both buttons use 16.
 * @returns the icon.
 */
export function ChevronToEdgeIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <Glyph size={size}>
      <path d="M10 3 5 8l5 5" />
      <path d="M3 3v10" />
    </Glyph>
  )
}

/**
 * The conversations tab: a speech bubble with a tail.
 * @param props.size - the drawn edge in pixels; the rail uses 18.
 * @returns the icon.
 */
export function ConversationIcon({ size = 18 }: { size?: number }): ReactElement {
  return (
    <Glyph size={size}>
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </Glyph>
  )
}

/**
 * The library tab: a book standing on a shelf.
 * @param props.size - the drawn edge in pixels; the rail uses 18.
 * @returns the icon.
 */
export function LibraryIcon({ size = 18 }: { size?: number }): ReactElement {
  return (
    <Glyph size={size}>
      <path d="M3 2.5h7.5a2 2 0 0 1 2 2v9H5a2 2 0 0 0-2 2z" />
      <path d="M3 13.5a2 2 0 0 1 2-2h7.5" />
    </Glyph>
  )
}

/**
 * Search: the magnifier.
 * @param props.size - the drawn edge in pixels; the rail uses 18.
 * @returns the icon.
 */
export function SearchIcon({ size = 18 }: { size?: number }): ReactElement {
  return (
    <Glyph size={size}>
      <circle cx="7" cy="7" r="4" />
      <path d="m10 10 3.5 3.5" />
    </Glyph>
  )
}

/**
 * Import: a plus.
 *
 * A plus rather than a downward arrow into a tray, which is what an import
 * usually gets: in the rail this is the *only* thing that adds anything, and
 * the expanded sidebar's own button says 「导入卡片」 in words underneath the
 * same shape.
 * @param props.size - the drawn edge in pixels; the rail uses 18.
 * @returns the icon.
 */
export function AddIcon({ size = 18 }: { size?: number }): ReactElement {
  return (
    <Glyph size={size}>
      <path d="M8 3v10M3 8h10" />
    </Glyph>
  )
}

/**
 * The drag handle: six dots in two columns.
 *
 * Filled dots rather than the family's strokes, deliberately — a handle is a
 * *texture*, the one place on the row where the drawing says "grip this"
 * instead of naming a thing, and two stroked lines at this size read as an
 * equals sign. Its own `<svg>` for the same reason: it is the only glyph here
 * that is not on the 16-unit stroked grid.
 * @returns the handle.
 */
export function GripIcon(): ReactElement {
  return (
    <svg
      className="iris-icon"
      width="8"
      height="14"
      viewBox="0 0 8 14"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="2" cy="2" r="1.2" />
      <circle cx="6" cy="2" r="1.2" />
      <circle cx="2" cy="7" r="1.2" />
      <circle cx="6" cy="7" r="1.2" />
      <circle cx="2" cy="12" r="1.2" />
      <circle cx="6" cy="12" r="1.2" />
    </svg>
  )
}

/**
 * The overflow trigger: three dots in a row.
 *
 * Drawn rather than the `⋯` character the rows carried before. The row's ⋯ is
 * now permanent — it used to appear on hover — so its optical weight is
 * something the design decides at every one of five row states, and U+22EF is
 * a different width and a different dot size in every installed face.
 * @returns the glyph.
 */
export function MoreIcon(): ReactElement {
  return (
    <svg
      className="iris-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  )
}
