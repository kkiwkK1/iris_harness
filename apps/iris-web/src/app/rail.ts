/**
 * How many readings the variant rail can notate before it stops being a rail.
 *
 * Two constraints decide the threshold, and they agree.
 *
 * The one handed down: **the rail must never be taller than the message it
 * annotates.** A ladder costs 7px per reading, so the shortest message a chat
 * can contain — one line of prose, with its speaker label and action row, around
 * 80px — is the real ceiling, and it lands near eight readings.
 *
 * The one from the notation itself: a tick-per-reading ladder earns its place by
 * being *countable at a glance*. Nobody distinguishes thirteen ticks from
 * fourteen. Past roughly eight, the ladder is no longer reporting a number, it
 * is only reporting "several" — and a compact readout does that better in a
 * quarter of the height.
 *
 * The distribution on this machine's nineteen cards is
 * `0,0,0,0,0,0,0,0,0,0,0,1,1,2,4,6,10,10,13` — eleven cards have no alternate
 * greetings at all and one already needs fourteen cells. Regenerations stack on
 * top of that with no upper bound, so the compact form is a real case, not a
 * defensive one.
 *
 * @module iris-web/app/rail
 */

/** Most readings the ladder will draw before handing over to the compact form. */
export const RAIL_MAX_TICKS = 8

/** What the margin shows for a given number of readings. */
export type RailMode = 'hidden' | 'ladder' | 'compact'

/**
 * Choose the rail's form.
 * @param count - how many readings the message has.
 * @returns `hidden` when there is nothing to choose between, `ladder` while the
 * ticks are still countable, `compact` once they are not.
 */
export function railMode(count: number): RailMode {
  if (!Number.isFinite(count) || count <= 1) return 'hidden'
  return count <= RAIL_MAX_TICKS ? 'ladder' : 'compact'
}

/**
 * Clamp a step through the readings.
 *
 * Returns undefined at the ends rather than wrapping: wrapping from the last
 * reading back to the first would make a reader who is holding the key down lose
 * their place, and the ends are exactly where they need the feedback of nothing
 * happening.
 * @param index - the visible reading.
 * @param count - how many readings exist.
 * @param step - -1 for the earlier reading, 1 for the later one.
 * @returns the reading to show, or undefined when there is none that way.
 */
export function stepReading(index: number, count: number, step: number): number | undefined {
  const next = index + step
  return next >= 0 && next < count ? next : undefined
}
