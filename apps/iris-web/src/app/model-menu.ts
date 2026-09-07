/**
 * The model choices the composer's capsule offers, as data.
 *
 * Its own module because the decision is the interesting part and the markup is
 * not. Five questions get answered here, and every one of them was a wrong
 * answer waiting in the first sketch:
 *
 * - **Which list?** The list belonging to the endpoint that is actually
 *   answering this conversation. That is the active *profile* when the user has
 *   one, and otherwise the **host's own startup connection** — the row
 *   `connection.list` projects for a host configured from its environment. A
 *   union of every profile's list would offer models the live endpoint has
 *   never heard of; ignoring the host row entirely was the reported bug (user,
 *   2026-09-07: 「没有活动连接，因此没有可选的模型列表」 shown on a host that was
 *   plainly connected, because its route came from the `IRIS_*` variables and
 *   no profile had ever been saved).
 * - **What is ticked?** The model in force for this chat, which is not
 *   necessarily a member of the list — and which is therefore **pinned as the
 *   first row whatever the list says**. A conversation can be running a model
 *   the endpoint has since stopped advertising, or one nobody has fetched a
 *   list for at all, and in both cases the menu still has to answer "what am I
 *   using right now?" rather than open onto rows that do not include it.
 * - **What does "default" mean?** The *connection's* model, not the global
 *   settings layer. The menu is scoped to one conversation, and the thing it
 *   returns that conversation to is the route it belongs to. For the host row
 *   that is the model the process was started with.
 * - **When is there nothing to show?** Two different nothings — no connection
 *   at all, and a connection nobody has fetched a list for — because the next
 *   step differs and a single "no models" would send the reader looking in the
 *   wrong place. The nothings are decided from the **source's own list**, not
 *   from the rows offered, precisely because the current model is always one of
 *   the rows: deciding it from the rows would silence the explanation.
 * - **Is it worth fetching one now?** {@link ModelMenu.probe} answers, and it
 *   is why the menu can be useful on first open instead of sending the reader
 *   to the connection panel to press "Test". Suppressed while a recent
 *   observation exists ({@link MODEL_LIST_FRESH_MS}), so opening the menu ten
 *   times does not probe ten times, and suppressed for a host row with no
 *   endpoint of its own — there is nothing to address a probe to.
 *
 * A `.ts` module rather than a helper inside `Composer.tsx` for a reason worth
 * writing down: node's test runner strips types but does **not** transform JSX,
 * so nothing in a `.tsx` file can be reached by a unit test. Keeping the
 * decision here is what makes it assertable at all.
 *
 * @module iris-web/app/model-menu
 */

import type { ConnectionProfile, HostDefaultConnection } from '@iris/protocol'

/** Why the menu has no list to offer, when it has none. */
export type ModelMenuEmpty =
  /** Neither a profile nor a host row: there is no endpoint whose list to show. */
  | 'no-connection'
  /** A connection is named but no successful probe of it has ever been read. */
  | 'no-list'

/** Which connection the offered list belongs to. */
export type ModelMenuSource =
  /** One of the user's saved profiles — the active one. */
  | 'profile'
  /** The connection the host process was started with. */
  | 'host'

/**
 * How long an observed model list is treated as still describing the endpoint.
 *
 * Not a cache lifetime in the usual sense — nothing is discarded when it
 * expires, and a list past it is still shown. What it governs is whether
 * *opening the menu* is allowed to spend a round trip on a fresh look: inside
 * the window the answer is "you asked a moment ago", outside it the menu is
 * willing to ask again. Five minutes because the failure it guards against is a
 * reader opening and closing the menu while deciding, and the fact it chases —
 * which models an endpoint serves — changes on the order of weeks.
 */
export const MODEL_LIST_FRESH_MS = 5 * 60 * 1000

/** What the capsule needs in order to render itself and its menu. */
export interface ModelMenu {
  /** The model this conversation is actually generating with. */
  current: string
  /**
   * The rows to offer: {@link current} first, then the source's own list in the
   * endpoint's order.
   *
   * Never empty while a model is in force, which is the point — see the second
   * question in this module's own docs. Read {@link empty}, not this array's
   * length, to find out whether the *endpoint* has said anything.
   */
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
   * Absent when no connection is named at all, in which case there is no
   * default to name and the restore row is not offered.
   */
  connectionModel?: string
  /** The active profile's name, for the menu's heading. Profiles only. */
  connectionName?: string
  /** Which connection {@link models} came from, when one is named. */
  source?: ModelMenuSource
  /**
   * The environment variable the host's key is read from, so the heading can
   * name the host row by something the reader can go and change.
   *
   * The variable's *name*, never its value. Absent on a host holding no
   * credential, and on a profile source.
   */
  hostKeyEnv?: string
  /*
   * There is deliberately no `probedAt` field, though this module reads one.
   *
   * The stamp's whole job is to decide {@link probe}, and that decision is made
   * here — projecting it as well would be a field whose only reader is a test.
   * Where the stamp is *shown* is already settled elsewhere: the connection
   * panel, not the menu (DEVIATIONS entry 50).
   */
  /**
   * A stable id for the source, so a caller can tell one source's in-flight
   * read from another's.
   *
   * The composer keys its "reading…" and "that failed" rows on this: without
   * it, a failure recorded against one connection would still be on screen
   * after the reader switched, attributing one endpoint's refusal to another.
   */
  sourceKey?: string
  /**
   * The `connection.test` ask that would fetch this source's list — present
   * only when making it is worth a round trip **now**.
   *
   * Absent when there is already a list, when the last look was recent
   * ({@link MODEL_LIST_FRESH_MS}), when there is no connection, and when the
   * host row carries no endpoint to address. Shaped as the request's own
   * parameters so a caller passes it through rather than rebuilding it — and it
   * never carries a key: the host resolves the credential from what it already
   * holds, which is the whole reason a bare probe exists.
   */
  probe?: { profileId?: string, baseURL?: string }
  /** Set when the source has no list of its own, naming which nothing this is. */
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
 * @param input.host - the host's own startup connection, as `connection.list`
 * projects it. The fallback source, read when no profile is active; absent
 * means the host does not describe its own route (not that it has none).
 * @param input.now - the clock, for the freshness window. Defaults to
 * `Date.now()`; passed by tests so the window is assertable without waiting.
 * @returns the capsule's data, including why it is empty when it is.
 */
export function modelMenu(input: {
  model: string
  overrides: Partial<{ model: string }> | undefined
  connections: readonly ConnectionProfile[]
  activeId: string | undefined
  host?: HostDefaultConnection | undefined
  now?: number
}): ModelMenu {
  const active = input.activeId === undefined
    ? undefined
    : input.connections.find(profile => profile.id === input.activeId)
  // The profile wins when there is one. Not a preference for saved things: the
  // active profile is what the host is *generating* through, so its endpoint is
  // where this conversation's next reply comes from. The host row describes the
  // route that answers when no profile has displaced it.
  const host = active === undefined ? input.host : undefined
  const listed: readonly string[] = active?.models ?? host?.models ?? []
  const probedAt = active === undefined ? host?.modelsProbedAt : active.modelsProbedAt
  const now = input.now ?? Date.now()
  // The freshness window is read off the stamp the *host* wrote, not off a
  // counter this module keeps: the stamp survives a remount, a language switch
  // and a second capsule, and a component-local counter survives none of them.
  const stale = probedAt === undefined || now - probedAt >= MODEL_LIST_FRESH_MS

  const source: ModelMenuSource | undefined = active !== undefined
    ? 'profile'
    : host !== undefined ? 'host' : undefined
  const connectionModel = active?.model ?? host?.model

  // The current model is pinned first and de-duplicated out of the rest, so a
  // list that already contains it is offered in the endpoint's own order and
  // one that does not gains a row rather than losing the answer.
  const rows = input.model === ''
    ? [...listed]
    : [input.model, ...listed.filter(id => id !== input.model)]

  // What a probe would be addressed to. A profile is probed by id even when it
  // carries no endpoint of its own — the host then answers `no-endpoint` by
  // name, which is a better sentence than anything this module could guess —
  // while the host row can only be probed by the endpoint it names.
  const ask: { profileId?: string, baseURL?: string } | undefined = active !== undefined
    ? { profileId: active.id }
    : host?.baseURL === undefined || host.baseURL.length === 0
      ? undefined
      : { baseURL: host.baseURL }

  return {
    current: input.model,
    models: rows,
    // `overrides` absent means the global layer was read, and the global layer
    // overrides nothing by definition — so `?.` here is the difference between
    // "no chat open" and "chat open, nothing overridden", not a convenience.
    overridden: input.overrides?.model !== undefined,
    ...connectionModel === undefined ? {} : { connectionModel },
    ...active === undefined ? {} : { connectionName: active.label ?? active.summary },
    ...source === undefined ? {} : { source },
    ...host?.keyEnv === undefined ? {} : { hostKeyEnv: host.keyEnv },
    ...source === undefined
      ? {}
      : { sourceKey: active === undefined ? `host:${host?.baseURL ?? ''}` : `profile:${active.id}` },
    ...listed.length === 0 && stale && ask !== undefined ? { probe: ask } : {},
    ...listed.length > 0
      ? {}
      : { empty: source === undefined ? 'no-connection' as const : 'no-list' as const },
  }
}
