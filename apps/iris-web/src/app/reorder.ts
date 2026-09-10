/**
 * The arithmetic behind dragging a row to a new place.
 *
 * Separated from `Sidebar.tsx` for the reason `library-search.ts` is: this is
 * behaviour a `node --test` file can import and check, where the same rules
 * inlined in a `.tsx` could only ever have been pinned against their own source
 * text. Pointer plumbing — capture, the 150ms press, the cancel key — stays in
 * the component, because that part is the browser's and not a rule.
 *
 * **No library.** A reorderable list is three numbers (which row is up, where
 * it would land, how far its neighbours move) and one of them is a `splice`.
 * The libraries that do this ship a drag abstraction, a sensor stack and a
 * collision strategy, none of which this list needs, and all of which would be
 * bytes in the shell's bundle for one gesture in one panel.
 *
 * @module iris-web/app/reorder
 */

/**
 * Move one item to a new index.
 *
 * `to` is an index in the **finished** array, not in the original — which is
 * the convention {@link dropIndex} answers in and the only one where "move A
 * to position 2" of `[A, B, C]` means `[B, C, A]` rather than `[B, A, C]`. Both
 * spellings are defensible and they disagree, so the array this returns is the
 * definition.
 * @param ids - the current order.
 * @param from - the index of the item being moved.
 * @param to - the index it should occupy afterwards.
 * @returns a new array; the input is not touched. Out-of-range indices, and a
 *   move that changes nothing, return a copy of the input.
 */
export function moveItem(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids]
  if (from < 0 || from >= next.length) return next
  if (to < 0 || to >= next.length || to === from) return next
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return [...ids]
  next.splice(to, 0, moved)
  return next
}

/**
 * Where a dragged row would land, given where the pointer is.
 *
 * The model is "the list without the dragged row": the remaining rows stay at
 * the vertical centres they already had, and the pointer's own centre falls
 * between two of them. Counting the centres above the pointer *is* the
 * insertion index, which is why this needs no per-row hit testing and no
 * assumption that rows are the same height — a branch row indented under its
 * parent measures the same way as a root.
 *
 * Row centres are measured, never computed from a constant. The rows are 44px
 * today and a title that grows to two lines would make that a lie the same
 * afternoon; a wrong constant here shows up as a drop that lands one row off,
 * which reads as a mysterious bug rather than as a stale number.
 * @param centres - every row's resting vertical centre, in the same order as
 *   the ids and including the row being dragged.
 * @param from - the index of the row being dragged.
 * @param pointerY - the dragged row's current centre, in the same coordinates.
 * @returns the index the row should occupy in the finished array.
 */
export function dropIndex(centres: readonly number[], from: number, pointerY: number): number {
  if (centres.length === 0) return 0
  let above = 0
  for (const [index, centre] of centres.entries()) {
    if (index === from) continue
    if (centre < pointerY) above += 1
  }
  return Math.min(Math.max(above, 0), centres.length - 1)
}

/**
 * How far one row slides to make way, while a drag is in flight.
 *
 * Every row between the one being dragged and where it would land moves by
 * exactly one step, in the direction that opens the gap; everything else stays
 * put. Returned in steps rather than pixels so the caller multiplies by the
 * height it measured — the same reason {@link dropIndex} takes centres.
 * @param index - the row asked about.
 * @param from - the index of the row being dragged.
 * @param to - where that row would land.
 * @returns -1 (up one row), 0 (still), or 1 (down one row).
 */
export function makeWay(index: number, from: number, to: number): -1 | 0 | 1 {
  if (index === from) return 0
  if (from < to) return index > from && index <= to ? -1 : 0
  if (to < from) return index >= to && index < from ? 1 : 0
  return 0
}
