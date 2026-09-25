/**
 * The live reply at a bounded paint rate.
 *
 * The store takes every `stream.text` frame as it arrives — the silence
 * watchdog and the resync guard read its identity, and a card's event tap sees
 * the event after the projection — so rate-limiting there would change what
 * those readers know. What does not need every frame is the **screen**: a
 * delta per token re-rendered the reading pane per token, and a host that
 * pushes faster than the page paints was paid for in commits nobody saw.
 *
 * So this sits between the store and the one component that renders the live
 * row. Growth of the same reply is published at most once per interval, and
 * the interval widens as the reply grows (the streaming row re-parses its whole
 * text on each paint). Every change that is not growth — a reply starting,
 * ending, being aborted, a new turn, a new host-minted key, a restart that
 * shrank the text — is published **at once**, because those are the states a
 * reader acts on (Stop, the settled row, the retry buttons).
 *
 * Ported from the unmerged `codex/performance-stream-ui` commit 930efd7
 * ("perf(web): bound streaming renders and defer frame scans").
 *
 * @module iris-web/client/stream-display
 */
import type { IrisStore, StreamBuffer } from './store.ts'

/**
 * The paint interval for a short reply, in milliseconds.
 *
 * A timer rather than an animation frame: a background tab stops animation
 * frames entirely, and a tab brought back to the front must not be showing
 * the reply as it stood when it was hidden.
 */
export const STREAM_PAINT_INTERVAL_MS = 32

/**
 * Whether `latest` can wait for the next paint, or must be shown now.
 *
 * Only growth of the reply already on screen waits. Anything else is a state
 * change: the buffer appearing or going (start, end, abort, error), another
 * turn, another host-minted key (a same-turn restart), another role or name,
 * or a text that did not grow from the one displayed (a restart or a resync
 * that replaced it).
 * @param displayed - what the screen shows.
 * @param latest - what the store holds.
 * @returns true when `latest` must be published immediately.
 */
export function isStreamTransition(displayed: StreamBuffer | undefined, latest: StreamBuffer | undefined): boolean {
  if (latest === undefined || displayed === undefined) return true
  return latest.turn !== displayed.turn
    || latest.key !== displayed.key
    || latest.role !== displayed.role
    || latest.name !== displayed.name
    || !latest.text.startsWith(displayed.text)
    || !latest.reasoning.startsWith(displayed.reasoning)
}

/**
 * How long growth may wait, by the size of the reply.
 * @param stream - the buffer about to be painted.
 * @param interval - the base interval.
 * @returns the delay in milliseconds.
 */
export function paintDelay(stream: StreamBuffer, interval: number): number {
  const size = stream.text.length + stream.reasoning.length
  return size > 64 * 1024 ? Math.max(interval, 200) : size > 16 * 1024 ? Math.max(interval, 100) : interval
}

/**
 * A rate-limited view of `state.stream`, shaped for `useSyncExternalStore`.
 * @param store - the shell's store.
 * @param interval - the base paint interval; injectable for tests.
 * @returns the snapshot reader and the subscription.
 */
export function createStreamDisplay(store: IrisStore, interval = STREAM_PAINT_INTERVAL_MS): {
  getSnapshot: () => StreamBuffer | undefined
  subscribe: (listener: () => void) => () => void
} {
  let displayed = store.getState().stream
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  const listeners = new Set<() => void>()

  const publish = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    const latest = store.getState().stream
    if (latest === displayed) return
    displayed = latest
    for (const listener of [...listeners]) listener()
  }

  const changed = (): void => {
    const latest = store.getState().stream
    if (latest === displayed) return
    if (isStreamTransition(displayed, latest)) {
      publish()
      return
    }
    if (timer === undefined && latest !== undefined) timer = setTimeout(publish, paintDelay(latest, interval))
  }

  return {
    getSnapshot: () => displayed,
    subscribe: listener => {
      listeners.add(listener)
      if (listeners.size === 1) {
        unsubscribe = store.subscribe(changed)
        changed()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        unsubscribe?.()
        unsubscribe = undefined
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        displayed = store.getState().stream
      }
    },
  }
}
