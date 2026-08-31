import type { ScriptContext } from '@iris/protocol'

/**
 * The host↔frame message protocol.
 *
 * A cross-origin frame means every exchange is a `postMessage`, so this is the
 * whole surface between the shell and a card. It is kept narrow on purpose: each
 * message added here is a capability the card can attempt to use.
 *
 * Both directions are validated. The frame is untrusted by construction, and the
 * host end must not be trusted either — a message arriving at the frame is only
 * believed if it came from the expected source with the expected run token,
 * because any page that can get a handle on the frame can post to it.
 *
 * @module iris-web/sandbox/protocol
 */

/** Host → frame. */
export type ToFrame =
  /**
   * The card's view of the host, pushed once before `run`.
   *
   * Pushed rather than fetched, and this is forced rather than chosen: cards call
   * `SillyTavern.getContext()` synchronously, and a cross-origin frame can only
   * talk to the host asynchronously. So the snapshot has to be in the frame
   * before any card code exists. It is also the cheap direction — the corpus
   * reads `context.chat` from 194 sites, and a card's pattern is to take the
   * whole context once and then read members off it.
   */
  | { iris: string, type: 'context', context: ScriptContext }
  /**
   * Run a script body. Sent once per frame, after the frame reports ready.
   *
   * `mode` is carried rather than sniffed. Upstream runs every card script as
   * `<script type="module">` with no per-script branch, so guessing from the
   * source would make cards behave differently for reasons no card author could
   * predict. `classic` exists for Iris's own probe, which exercises the shadowed
   * globals a module cannot be handed.
   */
  | { iris: string, type: 'run', code: string, mode: 'classic' | 'module' }
  /** The host page's viewport, at boot and on every resize. */
  | { iris: string, type: 'viewport', width: number, height: number }
  /** Answer to a `fetch` request, resolved or refused. */
  | { iris: string, type: 'fetch:ok', id: string, content: string }
  | { iris: string, type: 'fetch:error', id: string, message: string }
  /**
   * Answer to a slash command.
   *
   * Its existence is what lets `triggerSlash` resolve when upstream's does.
   * Upstream resolves when the *command* has run, not when generation has
   * finished — and `/send|/trigger` running to completion means the turn is open,
   * which is exactly what the host's answer reports. Resolving on dispatch
   * instead would have been a deviation to document; this is alignment.
   */
  | { iris: string, type: 'slash:ok', id: string, result: string }
  | { iris: string, type: 'slash:error', id: string, message: string }

/** Frame → host. */
export type FromFrame =
  /**
   * The bootstrap failed before it could stamp a token.
   *
   * Deliberately outside the token scheme, because the failure it reports may be
   * "the token never arrived". Accepted on `event.source` alone, and only ever as
   * a diagnostic: it can neither run code nor change state, so the weaker check
   * buys visibility without buying authority.
   */
  | { iris: string, type: 'bootstrap-error', message: string }
  /**
   * The frame's own policy refused a request.
   *
   * Reported so the shell can *say* it. A refusal the user cannot see is
   * indistinguishable from a bug in whatever the card does next — and the case
   * that settled this is real: one card's author pre-wrote "is Tavern Helper
   * installed? open your console!" as a fallback for exactly this situation, so a
   * silent refusal is delivered to the user as the card's misdiagnosis of Iris.
   */
  | { iris: string, type: 'blocked', host: string, directive: string }
  /**
   * The card assigned something into its extension settings.
   *
   * Reported rather than silently kept: the corpus contains the
   * read-or-initialise-then-write-back shape, and a card whose write lands only
   * on a discarded snapshot recomputes the same thing every run, forever, without
   * a sound.
   */
  | { iris: string, type: 'settings', settings: Record<string, unknown> }
  /** The bootstrap is installed and waiting for `run`. */
  | { iris: string, type: 'ready' }
  /**
   * Which bridged globals the frame managed to publish onto its own window.
   *
   * Module code cannot be handed shadowed parameters, so in module mode the
   * bridge has to be real properties — which is how upstream does it too, via a
   * classic script that runs before the module. Whether `parent` and `top` can be
   * redefined at all is a browser question this project cannot answer from
   * outside one, so the frame reports what it actually achieved instead of the
   * code assuming an answer.
   */
  | { iris: string, type: 'globals', published: string[], refused: string[] }
  /** The script body evaluated without throwing. */
  | { iris: string, type: 'ran' }
  /** The script threw, or refused a member. `member` is set for a policy refusal. */
  | { iris: string, type: 'error', message: string, member?: string }
  /** The card asked for a remote dependency. */
  | { iris: string, type: 'fetch', id: string, url: string }
  /**
   * The card invoked a slash command.
   *
   * The **raw string**, unparsed. Parsing it means reproducing upstream's pipe
   * escaping — an odd number of backslashes escapes, an even number does not —
   * and that semantic already exists once, host-side. A second copy in the
   * browser is the shape that produced this project's worst bug so far, where two
   * halves each held their own idea of a convention and agreed only in tests.
   */
  | { iris: string, type: 'slash', id: string, command: string }
  /** The card's content changed height; the shell sizes the frame to it. */
  | { iris: string, type: 'height', pixels: number }

/**
 * Validate a message arriving at the frame.
 *
 * The run token is the point. A `srcdoc` frame's `postMessage` origin is `"null"`
 * for every opaque-origin sender, so origin alone cannot distinguish the shell
 * from another sandboxed frame on the same page. The token is generated per run,
 * never leaves the shell except into that one frame, and is what makes an
 * injected `run` message from elsewhere inert.
 * @param token - the run token this frame was started with.
 * @param data - the raw message payload.
 * @returns the message, or undefined if it is not one of ours.
 */
export function parseToFrame(token: string, data: unknown): ToFrame | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = data as Record<string, unknown>
  if (message['iris'] !== token) return undefined

  switch (message['type']) {
    case 'context': {
      const context = message['context']
      // Shape-checked only as far as the frame needs: this arrives from the
      // shell, and the host already validated it. The frame's own use is to hand
      // it to a card, so what matters is that it is an object at all.
      return typeof context === 'object' && context !== null
        ? { iris: token, type: 'context', context: context as ScriptContext }
        : undefined
    }
    case 'run': {
      const mode = message['mode']
      return typeof message['code'] === 'string' && (mode === 'classic' || mode === 'module')
        ? { iris: token, type: 'run', code: message['code'], mode }
        : undefined
    }
    case 'viewport':
      return typeof message['width'] === 'number' && typeof message['height'] === 'number'
        ? { iris: token, type: 'viewport', width: message['width'], height: message['height'] }
        : undefined
    case 'fetch:ok':
      return typeof message['id'] === 'string' && typeof message['content'] === 'string'
        ? { iris: token, type: 'fetch:ok', id: message['id'], content: message['content'] }
        : undefined
    case 'slash:ok':
      return typeof message['id'] === 'string' && typeof message['result'] === 'string'
        ? { iris: token, type: 'slash:ok', id: message['id'], result: message['result'] }
        : undefined
    case 'slash:error':
      return typeof message['id'] === 'string' && typeof message['message'] === 'string'
        ? { iris: token, type: 'slash:error', id: message['id'], message: message['message'] }
        : undefined
    case 'fetch:error':
      return typeof message['id'] === 'string' && typeof message['message'] === 'string'
        ? { iris: token, type: 'fetch:error', id: message['id'], message: message['message'] }
        : undefined
    default:
      return undefined
  }
}

/**
 * Validate a message arriving at the host.
 *
 * Same token check, and the same reason: the shell listens on `window`, where
 * anything on the page can post. Fields are checked rather than cast — a card
 * controls this payload entirely, so a `height` of `"1e9"` or a `message` that is
 * an object has to be rejected here rather than reaching the UI.
 * @param token - the run token of the frame being listened to.
 * @param data - the raw message payload.
 * @returns the message, or undefined if it is not one of ours.
 */
export function parseFromFrame(token: string, data: unknown): FromFrame | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = data as Record<string, unknown>

  // Checked before the token, because this is the one frame whose whole purpose
  // is to report that the token never got that far.
  if (message['type'] === 'bootstrap-error') {
    const detail = message['message']
    return typeof detail === 'string'
      ? { iris: token, type: 'bootstrap-error', message: detail.slice(0, 2000) }
      : undefined
  }

  if (message['iris'] !== token) return undefined

  switch (message['type']) {
    case 'ready':
      return { iris: token, type: 'ready' }
    case 'ran':
      return { iris: token, type: 'ran' }
    case 'globals': {
      const published = message['published']
      const refused = message['refused']
      const names = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((row): row is string => typeof row === 'string').slice(0, 32) : []
      return Array.isArray(published) && Array.isArray(refused)
        ? { iris: token, type: 'globals', published: names(published), refused: names(refused) }
        : undefined
    }
    case 'blocked': {
      const host = message['host']
      const directive = message['directive']
      return typeof host === 'string' && typeof directive === 'string'
        ? {
            iris: token,
            type: 'blocked',
            // Card-influenced strings, so bounded before they reach the UI.
            host: host.slice(0, 253),
            directive: directive.slice(0, 40),
          }
        : undefined
    }
    case 'settings': {
      const settings = message['settings']
      return typeof settings === 'object' && settings !== null && !Array.isArray(settings)
        ? { iris: token, type: 'settings', settings: settings as Record<string, unknown> }
        : undefined
    }
    case 'error': {
      if (typeof message['message'] !== 'string') return undefined
      const member = message['member']
      return {
        iris: token,
        type: 'error',
        message: message['message'].slice(0, 2000),
        ...(typeof member === 'string' ? { member: member.slice(0, 200) } : {}),
      }
    }
    case 'slash': {
      const command = message['command']
      const id = message['id']
      // Bounded like every card-controlled string. Generous, because a `/send`
      // carries a user's message.
      return typeof command === 'string' && typeof id === 'string'
        ? { iris: token, type: 'slash', id, command: command.slice(0, 32_000) }
        : undefined
    }
    case 'fetch':
      return typeof message['id'] === 'string' && typeof message['url'] === 'string'
        ? { iris: token, type: 'fetch', id: message['id'], url: message['url'].slice(0, 2048) }
        : undefined
    case 'height': {
      const pixels = message['pixels']
      if (typeof pixels !== 'number' || !Number.isFinite(pixels) || pixels < 0) return undefined
      // Capped: a card that reports a million pixels would produce a frame the
      // page cannot scroll past, which is a denial of the interface by a card
      // that may only have a bug.
      return { iris: token, type: 'height', pixels: Math.min(Math.round(pixels), 20_000) }
    }
    default:
      return undefined
  }
}

/**
 * Mint a run token.
 *
 * `crypto.getRandomValues` rather than `Math.random`: the token's whole job is to
 * be unguessable by other code on the page, and a card can read `Math.random`'s
 * output stream from inside its own frame.
 * @returns a fresh token.
 */
export function mintToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
