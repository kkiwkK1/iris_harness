/**
 * The model choices the composer's capsule offers, as data.
 *
 * Its own module because the decision is the interesting part and the markup is
 * not. Four questions get answered here, and every one of them was a wrong
 * answer waiting in the first sketch:
 *
 * - **Which list?** The *active connection's* recorded models — the endpoint
 *   actually answering this conversation. A union of every profile's list would
 *   offer models the live endpoint has never heard of.
 * - **What is ticked?** The model in force for this chat, which is not
 *   necessarily a member of the list: a conversation can be running a model the
 *   endpoint has since stopped advertising, and the capsule has to be able to
 *   say so rather than tick nothing and look empty.
 * - **What does "default" mean?** The *connection's* model, not the global
 *   settings layer. The menu is scoped to one conversation, and the thing it
 *   returns that conversation to is the route it belongs to.
 * - **When is there nothing to show?** Two different nothings — no active
 *   connection, and an active connection nobody has ever probed — because the
 *   next step differs and a single "no models" would send the reader looking in
 *   the wrong place.
 *
 * A `.ts` module rather than a helper inside `Composer.tsx` for a reason worth
 * writing down: node's test runner strips types but does **not** transform JSX,
 * so nothing in a `.tsx` file can be reached by a unit test. Keeping the
 * decision here is what makes it assertable at all.
 *
 * @module iris-web/app/model-menu
 */

import type { ConnectionProfile } from '@iris/protocol'

/** Why the menu has no models to offer, when it has none. */
export type ModelMenuEmpty =
  /** No profile is active, so there is no endpoint whose list to show. */
  | 'no-connection'
  /** A connection is active but no successful probe has ever been filed against it. */
  | 'no-list'

/** What the capsule needs in order to render itself and its menu. */
export interface ModelMenu {
  /** The model this conversation is actually generating with. */
  current: string
  /** The ids to offer, in the endpoint's own order. Empty when {@link empty} is set. */
  models: string[]
  /**
   * Whether {@link current} is this conversation's own choice rather than the
   * connection's model showing through.
   *
   * Read from the chat's override layer, never by comparing values: a chat that
   * overrode the model with the string the connection already used is a real
   * state, and a comparison would call it "not overridden" and hide the undo.
   */
  overridden: boolean
  /**
   * The connection's own model — what "back to the default" returns to.
   *
   * Absent when no connection is active, in which case there is no default to
   * name and the restore row is not offered.
   */
  connectionModel?: string
  /** The active connection's name, for the menu's heading. */
  connectionName?: string
  /** Set when {@link models} is empty, naming which nothing this is. */
  empty?: ModelMenuEmpty
}

/**
 * Work out what the composer's model capsule should offer.
 * @param input.model - the model in force for the open chat (the merged read).
 * @param input.overrides - the open chat's own settings layer, or undefined
 * when the loaded settings are the global ones. Presence is scope: `{}` means
 * a chat is open and overrides nothing.
 * @param input.connections - the saved profiles.
 * @param input.activeId - which profile is active, if any.
 * @returns the capsule's data, including why it is empty when it is.
 */
export function modelMenu(input: {
  model: string
  overrides: Partial<{ model: string }> | undefined
  connections: readonly ConnectionProfile[]
  activeId: string | undefined
}): ModelMenu {
  const active = input.activeId === undefined
    ? undefined
    : input.connections.find(profile => profile.id === input.activeId)
  const models = active?.models ?? []
  return {
    current: input.model,
    models: [...models],
    // `overrides` absent means the global layer was read, and the global layer
    // overrides nothing by definition — so `?.` here is the difference between
    // "no chat open" and "chat open, nothing overridden", not a convenience.
    overridden: input.overrides?.model !== undefined,
    ...active === undefined ? {} : { connectionModel: active.model },
    ...active === undefined ? {} : { connectionName: active.label ?? active.summary },
    ...models.length > 0
      ? {}
      : { empty: active === undefined ? 'no-connection' as const : 'no-list' as const },
  }
}
