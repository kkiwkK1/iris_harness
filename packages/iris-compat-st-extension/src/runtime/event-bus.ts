/**
 * The `eventSource` facade — SillyTavern's event emitter, narrowed to the
 * methods the pilot's extension actually calls (`on`, `once`, `makeFirst`,
 * `makeLast`, `removeListener`, `emit`) and to their upstream semantics:
 *
 * - handlers run **in registration order**, and `emit` awaits each handler in
 *   turn, so an async handler delays the ones after it (upstream ST 1.18.0
 *   `EventSource.emit` awaits sequentially — the pilot's generate-side bridge
 *   depends on this: `CHAT_COMPLETION_SETTINGS_READY` handlers finish their
 *   in-place rewrite before `emit` resolves);
 * - `makeFirst` / `makeLast` move a handler to the front / back of the order
 *   at registration time (upstream registers `CHARACTER_MESSAGE_RENDERED` with
 *   `makeFirst` so the render path sees a fresh floor before anything else);
 * - `removeListener` removes the exact function previously registered;
 * - a handler that throws does not stop the others (upstream wraps each call);
 * - `emit` resolves to the value the last handler returned (unused by the
 *   pilot, kept because the shape is part of the seam).
 */

export type StEventHandler = (...args: unknown[]) => unknown

interface Registration {
  handler: StEventHandler
  once: boolean
}

export class StEventBus {
  readonly #handlers = new Map<string, Registration[]>()

  #list(type: string): Registration[] {
    const existing = this.#handlers.get(type)
    if (existing !== undefined) return existing
    const created: Registration[] = []
    this.#handlers.set(type, created)
    return created
  }

  #register(type: string, handler: StEventHandler, position: 'push' | 'unshift', once: boolean): StEventHandler {
    if (typeof handler !== 'function') throw new TypeError('eventSource: a handler must be a function')
    const list = this.#list(type)
    const registration: Registration = { handler, once }
    if (position === 'unshift') list.unshift(registration)
    else list.push(registration)
    return handler
  }

  /** Register in the normal order. Returns the handler for `removeListener`. */
  on(type: string, handler: StEventHandler): StEventHandler {
    return this.#register(type, handler, 'push', false)
  }

  /** Register for a single dispatch. */
  once(type: string, handler: StEventHandler): StEventHandler {
    return this.#register(type, handler, 'push', true)
  }

  /** Register to run before every same-event handler registered so far. */
  makeFirst(type: string, handler: StEventHandler): StEventHandler {
    return this.#register(type, handler, 'unshift', false)
  }

  /** Register to run after every same-event handler registered so far. */
  makeLast(type: string, handler: StEventHandler): StEventHandler {
    return this.#register(type, handler, 'push', false)
  }

  /** Remove a handler previously returned by a registration call. */
  removeListener(type: string, handler: StEventHandler): void {
    const list = this.#handlers.get(type)
    if (list === undefined) return
    const index = list.findIndex(entry => entry.handler === handler)
    if (index > -1) list.splice(index, 1)
  }

  /**
   * Dispatch, awaiting each handler sequentially in order. A `once` handler is
   * removed before its call, so a handler that re-emits the same event cannot
   * recurse into itself through its own registration.
   */
  async emit(type: string, ...args: unknown[]): Promise<unknown> {
    const list = this.#handlers.get(type)
    if (list === undefined || list.length === 0) return undefined
    let last: unknown
    for (const entry of [...list]) {
      if (entry.once) this.removeListener(type, entry.handler)
      try {
        last = await entry.handler(...args)
      } catch (cause: unknown) {
        // A broken handler is reported, not propagated: upstream's emitter
        // keeps dispatching, and one extension's bug must not swallow another
        // listener's turn.
        console.error(`[iris-st-compat] event handler for "${type}" threw`, cause)
      }
    }
    return last
  }
}
