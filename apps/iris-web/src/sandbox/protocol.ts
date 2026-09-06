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
  | { iris: string, type: 'context', context: ScriptContext, floor?: number }
  /**
   * Run a script body. Sent once per frame, after the frame reports ready.
   *
   * `mode` is carried rather than sniffed. Upstream runs every card script as
   * `<script type="module">` with no per-script branch, so guessing from the
   * source would make cards behave differently for reasons no card author could
   * predict. `classic` exists for Iris's own probe, which exercises the shadowed
   * globals a module cannot be handed.
   */
  | {
      iris: string
      type: 'run'
      code: string
      mode: 'classic' | 'module'
      /**
       * Which entry of `script.list` this body came from, for `getScriptId()`.
       *
       * Always present, `undefined` when the body has no identity in the host's
       * list — a file dragged in from disk, or Iris's own probe. That is the
       * host's own answer for an unidentified caller, and synthesising an id
       * here would give `getVariables({type:'script'})` a scope named after
       * something that will not exist on the next run.
       */
      scriptId: string | undefined
    }
  /** The host page's viewport, at boot and on every resize. */
  | { iris: string, type: 'viewport', width: number, height: number }
  /**
   * A host event, translated to the upstream name a card listens for.
   *
   * One direction only. A card emitting on its own bus stays inside its frame:
   * most of MVU's traffic is it talking to itself — 53 emit sites against 17
   * subscriptions — and routing that through the shell would put a card's
   * internal chatter on the wire for no one to read.
   */
  | { iris: string, type: 'event', event: string, args: unknown[] }
  /**
   * Answer to a `fetch` request, resolved or refused.
   *
   * `status` and `contentType` are carried when the shell fetched the resource
   * itself — the same-origin bridge — so the frame can hand back a `Response`
   * that answers `res.ok` and `res.status` the way the native one would. The
   * allowlisted remote path predates them and sends neither; the frame then
   * answers 200 with no content type, which is what that path always meant.
   */
  | {
      iris: string
      type: 'fetch:ok'
      id: string
      content: string
      status?: number
      contentType?: string
    }
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
  /** Answer to a card action. */
  | { iris: string, type: 'call:ok', id: string, result: unknown }
  | { iris: string, type: 'call:error', id: string, message: string }

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
  | {
    iris: string
    type: 'blocked'
    host: string
    directive: string
    detail?: string
    covered?: string
  }
  /**
   * Which parts of a full-viewport card frame may catch a click.
   *
   * Its own type rather than a field on `height`, which already carries three
   * meanings — a measured height, a sizing mode, and silence. A fourth would
   * make "what did the frame say?" unanswerable without reading the sender.
   *
   * The `clip` is a ready `clip-path` value rather than a list of rectangles:
   * the decisions that turn rectangles into a path (dropping empties, dropping
   * contained ones, rounding outward) belong beside the measurement, and the
   * shell comparing one string against the one already set is what lets it skip
   * the write.
   */
  | { iris: string, type: 'regions', clip: string, detail?: string }
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
  /**
   * A body finished evaluating.
   *
   * Carries the script's id because one frame now runs a card's whole set: with
   * several bodies in flight, an outcome that did not say whose it was would be
   * attributed to whichever script the shell happened to be tracking.
   */
  | { iris: string, type: 'ran', scriptId: string | undefined, lateMs?: number }
  /**
   * Something the frame observed that is **not** a failure.
   *
   * Separate from `error` because the panel treats an error as a failure and
   * counts it in the heading — and a frame reporting what its libraries cost is
   * not a card going wrong. Reusing `error` for it would make every healthy run
   * report a failure, which is the fastest way to teach a reader to skip the
   * whole list.
   */
  | { iris: string, type: 'note', scriptId: string | undefined, message: string }
  /** The script threw, or refused a member. `member` is set for a policy refusal. */
  | { iris: string, type: 'error', message: string, member?: string, scriptId: string | undefined }
  /**
   * A script is blocked waiting for a sibling to publish a global.
   *
   * Reported because hanging is the failure with no voice. A script that throws
   * says so; one waiting for a provider that never arrives looks exactly like
   * one that is working — and under co-location its siblings are visibly fine,
   * so the card reads as healthy while one of its scripts is stopped forever.
   */
  | {
      iris: string
      type: 'waiting'
      scriptId: string | undefined
      global: string
      /** Sent again once the wait is long enough to be worth remarking on. */
      elapsedMs: number
    }
  /** The wait ended — the global arrived, or the deadline passed. */
  | { iris: string, type: 'waited', scriptId: string | undefined, global: string, arrived: boolean }
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
  /**
   * The card invoked one of the actions on its `SillyTavern` facade.
   *
   * Generic rather than one frame per action, because the set will grow and a
   * message type per member would be a second place to declare it. Generic does
   * NOT mean open: the shell decides whether a named action may run, and a name
   * it does not recognise is refused there. The frame proposes; the trusted side
   * disposes.
   */
  | { iris: string, type: 'call', id: string, method: string, params: unknown }
  /**
   * The card showed one of the blocking dialogs.
   *
   * The sandbox never carries `allow-modals`, so the browser answers `alert`
   * with silence — a card's chosen failure channel, swallowed. The frame
   * shadows the three names with bridges that post here instead; the shell
   * puts the text in the notice panel, where a failure a card meant to show
   * actually shows.
   */
  | { iris: string, type: 'dialog', kind: 'alert' | 'confirm' | 'prompt', text: string }
  /** The card's content changed height; the shell sizes the frame to it. */
  | { iris: string, type: 'height', pixels: number }
  /**
   * A card dispatched an event on the page window it sees.
   *
   * `parent.dispatchEvent(new CustomEvent(name, {detail}))` upstream hands the
   * event to the page — every frame of the card can be listening. The frame
   * cannot deliver it itself: the listener may live in another frame, and no
   * opaque origin can reach one. So the dispatch travels to the shell, which
   * rebroadcasts it to every frame as an ordinary `event` message; the
   * synthetic argument is assembled shell-side, once, where every sender's
   * shape can be made to agree.
   */
  | { iris: string, type: 'winevent', event: string, detail?: unknown }
  /**
   * The card sizes itself to whatever viewport it is given, so its content
   * height cannot be measured from outside.
   *
   * A separate message from `height` because it is a different kind of fact.
   * `height` says "my content is this tall"; this says "asking me how tall my
   * content is has no answer" — every ruler returns the frame's own viewport,
   * because the card clips its overflow inside a descendant. Sent once, when
   * the frame notices; a card cannot un-notice it.
   *
   * The shell needs it because the alternative is the loop: a frame that
   * reports its own viewside back gets that height applied and reports it again,
   * so its starting height becomes permanent.
   */
  | { iris: string, type: 'sizing', mode: 'viewport' }

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
      if (typeof context !== 'object' || context === null) return undefined
      // The floor the frame renders in, present only for a message frame. It is
      // what `getCurrentMessageId()` answers; a script frame gets none and the
      // member keeps upstream's throw.
      const floor = message['floor']
      return {
        iris: token,
        type: 'context',
        context: context as ScriptContext,
        ...(typeof floor === 'number' && Number.isInteger(floor) && floor >= 0 ? { floor } : {}),
      }
    }
    case 'run': {
      const mode = message['mode']
      const scriptId = message['scriptId']
      if (scriptId !== undefined && typeof scriptId !== 'string') return undefined
      return typeof message['code'] === 'string' && (mode === 'classic' || mode === 'module')
        ? { iris: token, type: 'run', code: message['code'], mode, scriptId }
        : undefined
    }
    case 'event': {
      const name = message['event']
      const args = message['args']
      return typeof name === 'string' && name.length > 0 && Array.isArray(args)
        ? { iris: token, type: 'event', event: name, args: args as unknown[] }
        : undefined
    }
    case 'viewport':
      return typeof message['width'] === 'number' && typeof message['height'] === 'number'
        ? { iris: token, type: 'viewport', width: message['width'], height: message['height'] }
        : undefined
    case 'fetch:ok': {
      if (typeof message['id'] !== 'string' || typeof message['content'] !== 'string') return undefined
      const status = message['status']
      const contentType = message['contentType']
      return {
        iris: token,
        type: 'fetch:ok',
        id: message['id'],
        content: message['content'],
        // Bounded to what a `Response` can be built with: a status outside the
        // range would make the frame's constructor throw, which would turn a
        // refused request into a frame fault.
        ...(typeof status === 'number' && status >= 200 && status <= 599 ? { status } : {}),
        ...(typeof contentType === 'string' && contentType !== '' ? { contentType } : {}),
      }
    }
    case 'call:ok':
      return typeof message['id'] === 'string'
        ? { iris: token, type: 'call:ok', id: message['id'], result: message['result'] }
        : undefined
    case 'call:error':
      return typeof message['id'] === 'string' && typeof message['message'] === 'string'
        ? { iris: token, type: 'call:error', id: message['id'], message: message['message'] }
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
/**
 * A string field that may legitimately be absent.
 *
 * Absent is a real answer here — a body dragged in from disk has no entry in the
 * host's list — so this narrows without inventing one, and anything that is
 * present but not a string is dropped rather than stringified downstream.
 * @param value - the raw field.
 * @returns the string, or undefined.
 */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

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
    case 'note': {
      const note = message['message']
      return typeof note === 'string'
        ? { iris: token, type: 'note', scriptId: stringOrUndefined(message['scriptId']), message: note }
        : undefined
    }
    case 'ran':
      return {
        iris: token,
        type: 'ran',
        scriptId: stringOrUndefined(message['scriptId']),
        // Present only when the module finished *after* the frame had already
        // declared it timed out, which makes an earlier verdict wrong rather
        // than merely incomplete.
        ...(typeof message['lateMs'] === 'number' ? { lateMs: message['lateMs'] } : {}),
      }
    case 'globals': {
      const published = message['published']
      const refused = message['refused']
      const names = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((row): row is string => typeof row === 'string').slice(0, 32) : []
      return Array.isArray(published) && Array.isArray(refused)
        ? { iris: token, type: 'globals', published: names(published), refused: names(refused) }
        : undefined
    }
    case 'regions': {
      const clip = message['clip']
      /*
       * Bounded, because the card's own DOM decides how long it is. The
       * pruning in `overlay-regions.ts` keeps a real card's path under a
       * hundred characters, so this ceiling is only reached by something
       * pathological — and a `clip-path` that long would be a performance
       * problem in the shell rather than a useful clip.
       */
      const detail = message['detail']
      return typeof clip === 'string' && clip.length <= 8_000
        ? {
            iris: token,
            type: 'regions',
            clip,
            /*
             * The visibility summary, for the panel only. Bounded because the
             * card's own DOM decides how many regions there are, and this is a
             * diagnostic — a thousand lines of it would push everything else
             * out of the list it exists to sit in.
             */
            ...(typeof detail === 'string' && detail !== ''
              ? { detail: detail.slice(0, 1_000) }
              : {}),
          }
        : undefined
    }
    case 'blocked': {
      const host = message['host']
      const directive = message['directive']
      const detail = message['detail']
      const covered = message['covered']
      return typeof host === 'string' && typeof directive === 'string'
        ? {
            iris: token,
            type: 'blocked',
            // Card-influenced strings, so bounded before they reach the UI.
            host: host.slice(0, 253),
            directive: directive.slice(0, 40),
            /*
             * The library name, which downgrades this report from a failure to
             * a note. **Not card-influenced** — the frame picks it from a fixed
             * list — but bounded anyway, because the frame is untrusted and a
             * field that decides how a report is *graded* is exactly the one
             * worth not taking on trust.
             */
            ...(typeof covered === 'string' && covered !== ''
              ? { covered: covered.slice(0, 40) }
              : {}),
            /*
             * Present only when the host alone does not identify the request —
             * see `reportBlocked`. Bounded harder than the host because it
             * carries a path and a source location, both card-authored.
             */
            ...(typeof detail === 'string' && detail !== ''
              ? { detail: detail.slice(0, 300) }
              : {}),
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
        scriptId: stringOrUndefined(message['scriptId']),
      }
    }
    case 'waiting':
    case 'waited': {
      const global = message['global']
      if (typeof global !== 'string' || global.length === 0) return undefined
      const scriptId = stringOrUndefined(message['scriptId'])
      const name = global.slice(0, 100)
      return message['type'] === 'waiting'
        ? {
            iris: token,
            type: 'waiting',
            scriptId,
            global: name,
            elapsedMs: typeof message['elapsedMs'] === 'number' ? message['elapsedMs'] : 0,
          }
        : { iris: token, type: 'waited', scriptId, global: name, arrived: message['arrived'] === true }
    }
    case 'call': {
      const id = message['id']
      const method = message['method']
      return typeof id === 'string' && typeof method === 'string'
        ? { iris: token, type: 'call', id, method: method.slice(0, 100), params: message['params'] }
        : undefined
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
    case 'dialog': {
      const kind = message['kind']
      const text = message['text']
      if (kind !== 'alert' && kind !== 'confirm' && kind !== 'prompt') return undefined
      if (typeof text !== 'string') return undefined
      return { iris: token, type: 'dialog', kind, text: text.slice(0, 2000) }
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
    case 'winevent': {
      const event = message['event']
      if (typeof event !== 'string' || event.length === 0) return undefined
      // `detail` is the card's payload, carried as-is the way `call`'s params
      // are: structured clone already refused whatever cannot cross the boundary,
      // at the sender, before this saw it.
      const detail = message['detail']
      return {
        iris: token,
        type: 'winevent',
        event: event.slice(0, 200),
        ...(detail === undefined ? {} : { detail }),
      }
    }
    case 'sizing': {
      // One value today, and validated rather than passed through: a frame is
      // untrusted, and a mode the shell does not know would reach a switch that
      // has no arm for it.
      if (message['mode'] !== 'viewport') return undefined
      return { iris: token, type: 'sizing', mode: 'viewport' }
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
