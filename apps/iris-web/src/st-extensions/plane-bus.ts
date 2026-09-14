/**
 * The in-shell bus between the store's event chain and the extension plane.
 *
 * The `st-compat.request` broadcast arrives on the same WebSocket as every
 * other host event, so it flows through the store's HANDLERS chain like they
 * do — but the plane is a UI concern the store must not know, and the store is
 * a lifecycle concern the plane must not own. This bus is the seam: the
 * handler forwards every bridge round, the plane subscribes while mounted.
 */

import type { HostRequest } from './plane-core.ts'

type Dispatch = (request: HostRequest) => void

const subscribers = new Set<Dispatch>()

/** The store's `st-compat.request` handler calls this with every round. */
export function dispatchStCompatRequest(request: HostRequest): void {
  for (const subscriber of subscribers) subscriber(request)
}

/** The plane subscribes on mount and disposes its subscription on unmount. */
export function subscribeStCompatRequests(dispatch: Dispatch): () => void {
  subscribers.add(dispatch)
  return () => { subscribers.delete(dispatch) }
}
