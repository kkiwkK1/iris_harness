/**
 * The variant rail.
 *
 * Iris's signature element. A regenerated reply is not a replacement, it is
 * another *reading* of the same beat, and the whole set survives — so it is
 * notated the way a critical edition notates variants: a quiet ladder in the
 * margin, one tick per reading, the current one filled and wider. It answers
 * "how many, which one" without a hover toolbar, and it disappears entirely
 * when there is only one reading, which on real cards is most of the time.
 *
 * Past the point where ticks stop being countable it hands over to a stepper of
 * fixed height (see `rail.ts` for where that point is and why). The stepper is
 * still a vertical marginal object reading top-to-bottom, so earlier readings
 * stay up and later ones stay down — the ladder's axis survives the change of
 * form, which is what keeps the two from feeling like different controls.
 *
 * On any turn but the last it is a **record, not a control**, and it is worth
 * separating what is checkable here from what is not.
 *
 * Checkable, from SillyTavern's source: its swipe handlers hardcode `.last_mes`;
 * it ships a labelled setting, `show_swipe_num_all_messages`, for showing swipe
 * *numbers* on earlier messages; the CSS that setting unlocks names only
 * `.swipes-counter` and dims it to `opacity: 0.3`, never the arrows; and no
 * delegation anywhere responds to a non-last message. So upstream deliberately
 * built "show how many readings an earlier passage had" and, in doing it, did not
 * release the controls.
 *
 * Not checkable: *why*. The reasoning this implementation actually rests on is
 * that switching an earlier beat's reading would leave every later turn answering
 * words the transcript no longer shows — a consequence that holds whatever
 * upstream's motive was. An apparatus criticus records the variants of a passage;
 * it does not rewrite the passage. So the ticks stay, quieted and inert, and
 * still answer "how many, which one".
 *
 * @module iris-web/app/VariantRail
 */

import type { ReactElement } from 'react'

import { railMode, stepReading } from './rail.ts'

/**
 * Render the rail for one message.
 * @param props.count - how many readings exist.
 * @param props.index - the visible reading, zero-based.
 * @param props.interactive - whether this turn's readings can still be changed.
 * @param props.onSelect - called with the reading to show.
 * @returns the rail, or null when there is nothing to choose between.
 */
export function VariantRail({
  count,
  index,
  interactive,
  onSelect,
}: {
  count: number
  index: number
  interactive: boolean
  onSelect: (index: number) => void
}): ReactElement | null {
  const mode = railMode(count)
  if (mode === 'hidden') return null

  const label = interactive
    ? `${count} readings of this reply`
    : `${count} readings were generated for this reply; the current one is ${index + 1}`

  if (!interactive) {
    return (
      <div className="iris-rail iris-rail--record" role="group" aria-label={label}>
        {Array.from({ length: mode === 'compact' ? 1 : count }, (_unused, at) => (
          <span
            key={at}
            className="iris-rail__tick"
            aria-current={mode === 'compact' ? undefined : at === index}
          />
        ))}
        <span className="iris-rail__count">
          {index + 1}/{count}
        </span>
      </div>
    )
  }

  if (mode === 'compact') {
    const earlier = stepReading(index, count, -1)
    const later = stepReading(index, count, 1)
    return (
      <div className="iris-rail iris-rail--compact" role="group" aria-label={label}>
        <button
          type="button"
          className="iris-rail__step"
          aria-label="Earlier reading"
          disabled={earlier === undefined}
          onClick={() => {
            if (earlier !== undefined) onSelect(earlier)
          }}
        >
          ▲
        </button>
        {/* The readout is the whole report here, so unlike the ladder's count it
            is not decorative and must not be hidden from assistive tech. */}
        <span className="iris-rail__count">
          {index + 1}/{count}
        </span>
        <button
          type="button"
          className="iris-rail__step"
          aria-label="Later reading"
          disabled={later === undefined}
          onClick={() => {
            if (later !== undefined) onSelect(later)
          }}
        >
          ▼
        </button>
      </div>
    )
  }

  return (
    <div className="iris-rail" role="group" aria-label={label}>
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
