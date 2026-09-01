/**
 * Which floors are allowed to build frames.
 *
 * Interim protection, and it is worth saying plainly which part of this is the
 * design and which part is the stopgap.
 *
 * **The design** is that a message frame lives exactly as long as its message is
 * displayed — the same shape as a card's script frames living as long as its
 * chat is in the foreground. That needs no counting: a message that is not
 * mounted has no frames because nothing built them.
 *
 * **The stopgap** is this file. Iris's reading view is not windowed
 * (`ChatPane.tsx` maps every message), so today "displayed" means "in the
 * conversation" and the lifecycle anchor protects nothing on a long chat. Until
 * the view is windowed — a separate project, deliberately not folded into this
 * pipeline — an explicit depth limit stands in for it.
 *
 * The shape is upstream's `calcToRender`
 * (`store/iframe_runtimes/message.ts:41-55`), including the part that is easy to
 * get wrong: **`depth: 0` means every displayed floor, not none.** Upstream's own
 * default is `0`, so upstream ships with this valve open — which is why it is a
 * stopgap and not an answer.
 *
 * @module iris-web/sandbox/render-window
 */

/** What the window needs to know about one floor. */
export interface FloorSummary {
  /** The floor's index in the conversation. */
  id: number
  /** Whether it is a system message, for `ignoreHidden`. */
  isSystem?: boolean
}

/** How the window is configured. */
export interface RenderWindow {
  /**
   * How many floors from the end may render.
   *
   * `0` means **all of them**, which is upstream's spelling and its default.
   * Written out because reading it as "none" inverts the feature.
   */
  depth: number
  /** Skip system messages when counting the depth back from the end. */
  ignoreHidden?: boolean
}

/**
 * Decide which floors may build frames.
 *
 * @param floors - every floor currently displayed, in conversation order.
 * @param window - the depth configuration.
 * @returns the ids allowed to render, as a set for a cheap membership test.
 */
export function floorsToRender(
  floors: readonly FloorSummary[],
  window: RenderWindow,
): ReadonlySet<number> {
  if (floors.length === 0) return new Set()

  /*
   * Zero is "all", not "none". Upstream spells its own default this way, and a
   * reader who takes it the other way turns the feature off for everyone while
   * believing they have left it at its default.
   */
  if (window.depth <= 0) return new Set(floors.map(floor => floor.id))

  const eligible =
    window.ignoreHidden === true ? floors.filter(floor => floor.isSystem !== true) : floors

  /*
   * Counted back from the end over the *eligible* floors, so hidden messages do
   * not consume the budget when they are being ignored. Upstream splits these
   * into two branches for the same reason.
   */
  return new Set(eligible.slice(-window.depth).map(floor => floor.id))
}
