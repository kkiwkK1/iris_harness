/**
 * The host side of the pilot bridge, as pure state — no I/O, no clocks beyond
 * the injectable deadline, no app-service imports. The service wiring (central,
 * landed with the wiring commit) constructs one bridge and calls:
 *
 * - `arm` / `detach` from the shell plane's `stCompat.plane.attach` /
 *   `stCompat.plane.detach` RPCs;
 * - `begin` from the generation path (contributions) and the settle path
 *   (replies), which broadcasts the request and awaits `submit` or the
 *   deadline, whichever first;
 * - `submit` from the shell plane's `stCompat.submit` RPC.
 *
 * The semantics the UCs hang on: **an unarmed bridge is not a slow bridge, it
 * is no bridge** — `begin` returns a promise resolved with `null` immediately
 * when no plane is armed for the given extension and revision, so a disabled
 * extension costs zero latency and its templates reach the prompt untouched.
 * A stale plane (armed at an older revision) cannot answer: `submit` checks
 * the revision recorded with the pending request, not the caller's word.
 */

import { randomUUID } from 'node:crypto'

import type { StBridgeResult } from '../runtime/protocol.ts'

export interface ArmedPlane {
  extensionId: string
  /** The runtime revision the plane was built against (`SandboxPluginRuntime`-style fencing). */
  revision: number
  armedAt: number
}

interface PendingRequest {
  extensionId: string
  kind: 'generate' | 'reply'
  revision: number
  resolve: (result: StBridgeResult | null) => void
  deadline: NodeJS.Timeout
}

export interface BeginRequest {
  extensionId: string
  kind: 'generate' | 'reply'
  revision: number
  payload: unknown
  deadlineMs: number
}

export interface BeginTicket {
  token: string
  event: {
    type: 'st-compat.request'
    token: string
    extensionId: string
    kind: 'generate' | 'reply'
    revision: number
    payload: unknown
  }
  /** Resolves with the submitted result, or null on deadline/detach. */
  wait: Promise<StBridgeResult | null>
}

export class StCompatBridge {
  readonly #planes = new Map<string, ArmedPlane>()
  readonly #pending = new Map<string, PendingRequest>()
  #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** The shell plane reports a live extension frame at this revision. */
  arm(extensionId: string, revision: number): ArmedPlane {
    if (typeof extensionId !== 'string' || extensionId === '') throw new TypeError('arm: extensionId must be a non-empty string')
    if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('arm: revision must be a non-negative safe integer')
    const plane: ArmedPlane = { extensionId, revision, armedAt: this.#now() }
    this.#planes.set(extensionId, plane)
    return plane
  }

  /** The plane went away (disable, uninstall, page close, rebuild). */
  detach(extensionId: string): boolean {
    const had = this.#planes.delete(extensionId)
    // A pending round cannot be answered by a detached plane: fail fast toward
    // the raw passthrough instead of burning the deadline.
    for (const [token, request] of [...this.#pending.entries()]) {
      if (request.extensionId === extensionId) {
        clearTimeout(request.deadline)
        request.resolve(null)
        this.#pending.delete(token)
      }
    }
    return had
  }

  /** Whether a plane is armed for exactly this extension and revision. */
  isArmed(extensionId: string, revision: number): boolean {
    const plane = this.#planes.get(extensionId)
    return plane !== undefined && plane.revision === revision
  }

  /** Every currently armed plane (for the diagnostics view and tests). */
  armed(): ReadonlyArray<ArmedPlane> {
    return [...this.#planes.values()]
  }

  /**
   * Start one round. Returns null-resolving immediately when unarmed — the
   * caller proceeds with the untouched prompt/text in that case.
   */
  begin(request: BeginRequest): BeginTicket | null {
    if (!this.isArmed(request.extensionId, request.revision)) return null
    const token = randomUUID()
    let resolve!: (result: StBridgeResult | null) => void
    const wait = new Promise<StBridgeResult | null>(resolvePromise => { resolve = resolvePromise })
    const deadline = setTimeout(() => {
      if (this.#pending.delete(token)) resolve(null)
    }, request.deadlineMs)
    this.#pending.set(token, {
      extensionId: request.extensionId,
      kind: request.kind,
      revision: request.revision,
      resolve,
      deadline,
    })
    return {
      token,
      event: {
        type: 'st-compat.request',
        token,
        extensionId: request.extensionId,
        kind: request.kind,
        revision: request.revision,
        payload: request.payload,
      },
      wait,
    }
  }

  /**
   * The shell plane's answer. Validates token, kind and revision; a valid
   * result resolves the waiting caller, anything else is refused with a
   * named reason and leaves the round to its deadline.
   */
  submit(input: {
    token: string
    kind: 'generate' | 'reply'
    revision: number
    result: StBridgeResult
  }): { ok: true } | { ok: false, why: string } {
    const pending = this.#pending.get(input.token)
    if (pending === undefined) return { ok: false, why: 'no pending request carries this token' }
    if (pending.kind !== input.kind) return { ok: false, why: `pending kind is "${pending.kind}", submit said "${input.kind}"` }
    if (pending.revision !== input.revision) {
      return { ok: false, why: `submit carries revision ${input.revision}, the round was opened at ${pending.revision} — a stale frame` }
    }
    clearTimeout(pending.deadline)
    this.#pending.delete(input.token)
    pending.resolve(input.result)
    return { ok: true }
  }

  /** Drop every armed plane and pending round (host shutdown / extension uninstall). */
  dispose(): void {
    for (const request of this.#pending.values()) clearTimeout(request.deadline)
    this.#pending.clear()
    this.#planes.clear()
  }
}
