import { createFakeClient, type FakeClient } from '../src/index.ts'
import type { IrisEvent, IrisEventType } from '@iris/protocol'

/** A fake paced for tests: no delay between deltas, few enough deltas to reason about. */
export function testClient(): FakeClient {
  return createFakeClient({ chunkDelayMs: 0, chunkCount: 4 })
}

/** Every event a client emitted, in arrival order. */
export function recorder(client: FakeClient): { events: IrisEvent[], stop: () => void } {
  const events: IrisEvent[] = []
  const stop = client.subscribe(event => {
    events.push(event)
  })
  return { events, stop }
}

/**
 * Resolve once an event of `type` arrives for `chatId`.
 *
 * A timeout rather than an open wait: a fake that stops emitting should fail a
 * test in a second, not hang the suite.
 */
export function nextEvent<T extends IrisEventType>(
  client: FakeClient,
  type: T,
  chatId?: string,
): Promise<Extract<IrisEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timed out waiting for ${type}`))
    }, 2000)
    const off = client.subscribe(event => {
      if (event.type !== type) return
      if (chatId !== undefined && 'chatId' in event && event.chatId !== chatId) return
      clearTimeout(timer)
      off()
      resolve(event as Extract<IrisEvent, { type: T }>)
    })
  })
}
