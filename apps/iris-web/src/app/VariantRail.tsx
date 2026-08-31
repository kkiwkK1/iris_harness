/**
 * The variant rail.
 *
 * Iris's signature element. A regenerated reply is not a replacement, it is
 * another *reading* of the same beat, and the whole set survives — so it is
 * notated the way a critical edition notates variants: a quiet ladder in the
 * margin, one tick per reading, the current one filled and wider. It answers
 * "how many, which one" without a hover toolbar, and it disappears entirely
 * when there is only one reading, which is most of the time.
 *
 * @module iris-web/app/VariantRail
 */

import type { ReactElement } from 'react'

/**
 * Render the rail for one message.
 * @param props.count - how many readings exist.
 * @param props.index - the visible reading, zero-based.
 * @param props.onSelect - called with the reading to show.
 * @returns the rail, or null when there is nothing to choose between.
 */
export function VariantRail({
  count,
  index,
  onSelect,
}: {
  count: number
  index: number
  onSelect: (index: number) => void
}): ReactElement | null {
  if (count <= 1) return null

  return (
    <div className="iris-rail" role="group" aria-label={`${count} readings of this reply`}>
      {Array.from({ length: count }, (_unused, at) => (
        <button
          key={at}
          type="button"
          className="iris-rail__tick"
          aria-current={at === index}
          aria-label={`Reading ${at + 1} of ${count}`}
          onClick={() => onSelect(at)}
        />
      ))}
      <span className="iris-rail__count" aria-hidden="true">
        {index + 1}/{count}
      </span>
    </div>
  )
}
