/**
 * Who a frame is, and what that lets it address.
 *
 * Every card→host call used to be addressed at the moment it **landed**: the
 * store read `get().chatId`, `get().cardRun` and `get().view` when the frame's
 * message was handled, and spread the frame's own params *after* the chat — so
 * a frame could override the chat and the run it wrote into, and a call a frame
 * posted during a chat switch went to whichever conversation had just opened.
 * The store had already paid for that shape once (`endCardRun`, measured on
 * 8787: the React cleanup that tears a frame down runs after `chatId` has moved
 * on), and the card-call path had the same bug in two more places.
 *
 * The fix has two halves, and this module is both:
 *
 * - **A binding captured when the frame is built.** The frame host (script
 *   overlay, message interface, dev probe) knows which chat, which card and —
 *   for the script frame — which run it is building for. That value, not live
 *   store state, is what a call from that frame is about.
 * - **Shaping that refuses rather than overwrites.** A frame param naming a
 *   different chat, card or run than its binding is refused by name, and so is
 *   a call from a frame whose chat is no longer the open one. Overwriting would
 *   turn a stale frame's `generate` into a silent write to another
 *   conversation; refusing makes it a sentence a card author can read. The
 *   shell-owned fields are then spread **last**, from the binding.
 *
 * Pure, with no store: the store adapts its live state into `LiveScope` and
 * calls in, so every rule here is a function a test can drive directly.
 *
 * @module iris-web/client/card-gateway
 */
import type { RpcMethod } from '@iris/protocol'

/**
 * What a frame is bound to, fixed when its host built the run.
 *
 * `runId` is the script frame's run, minted by `beginCardRun` for exactly that
 * frame. Interface frames have none of their own: they are built per message
 * and outlive nothing the script run does not, and an injection they make is
 * owned by whatever script run this same chat has — see `runFor`.
 */
export interface FrameBinding {
  readonly kind: 'script' | 'interface' | 'probe'
  readonly chatId: string
  readonly characterId: string
  readonly runId?: string
}

/** The shell's live state a call is checked against, read at call time. */
export interface LiveScope {
  /** The chat in front of the reader now. */
  readonly openChatId: string | undefined
  /** The script run the store holds now. */
  readonly currentRun: { readonly runId: string, readonly chatId: string } | undefined
}

/** A shaped call: the params to put on the wire, or the sentence refusing it. */
export type ShapedCall =
  | { readonly ok: true, readonly params: Record<string, unknown> }
  | { readonly ok: false, readonly reason: string }

/**
 * Whether a call from this frame may be made at all right now.
 *
 * Two refusals, both about a frame that has outlived what it was built for:
 * its chat is no longer the open one (the switch window, before the React
 * cleanup disposes it), or it is a script frame whose run has ended. Neither
 * is sent to "its own" chat instead — a write into a conversation the reader
 * has left, arriving with no frame alive to own it, is the case the refusal
 * exists to make visible.
 * @param method - the card-facing name, for the sentence.
 * @param binding - the frame's binding.
 * @param live - the shell's state now.
 * @returns the refusal sentence, or undefined when the call may proceed.
 */
export function staleBindingReason(
  method: string,
  binding: FrameBinding,
  live: LiveScope,
): string | undefined {
  if (live.openChatId !== binding.chatId) {
    return `${method} was refused: the ${binding.kind} frame that sent it was built for chat`
      + ` ${binding.chatId}, and ${live.openChatId === undefined ? 'no chat' : `chat ${live.openChatId}`}`
      + ' is open now — a call from a frame that outlived its chat is not redirected'
  }
  if (binding.runId !== undefined && live.currentRun?.runId !== binding.runId) {
    return `${method} was refused: the ${binding.kind} frame that sent it belongs to run`
      + ` ${binding.runId}, which has ended`
  }
  return undefined
}

/**
 * The run an injection from this frame belongs to.
 *
 * The frame's own when it has one. An interface frame has none, and its
 * injection is owned by the script run of **its** chat if one is live — the
 * behaviour it always had, now with the chat checked: a run of another chat is
 * never borrowed.
 * @param binding - the frame's binding.
 * @param live - the shell's state now.
 * @returns the run id, or undefined when no run of this chat exists.
 */
export function runFor(binding: FrameBinding, live: LiveScope): string | undefined {
  if (binding.runId !== undefined) return binding.runId
  return live.currentRun?.chatId === binding.chatId ? live.currentRun.runId : undefined
}

/** The params the shell owns, in the order they are checked and named. */
const OWNED = ['chatId', 'characterId', 'runId'] as const

/**
 * Shape one card call for the wire.
 *
 * The frame's params go **first**, with every shell-owned key taken out; the
 * binding's values go last. A frame that sent an owned key with a different
 * value is refused by name — the one thing this never does is quietly replace
 * the frame's value and send the call anyway, because a frame that names
 * another chat is either stale or hostile, and in both cases the write it
 * wanted is not the write the reader expects.
 *
 * Stamped on the wire: `chatId` always; `runId` on `script.setExtensionPrompt`
 * only, the one call that leaves something behind for a run to own; and
 * `characterId` on `worldbook.setCharBooks` (a rebind names the character the
 * frame belongs to) and on any call where the frame sent one that matched.
 * @param method - the card-facing name, for the sentence.
 * @param wire - the wire method it routes to.
 * @param params - the frame's params, untrusted.
 * @param binding - the frame's binding.
 * @param live - the shell's state now.
 * @returns the params to send, or the refusal.
 */
export function shapeCardCall(
  method: string,
  wire: RpcMethod,
  params: unknown,
  binding: FrameBinding,
  live: LiveScope,
): ShapedCall {
  const stale = staleBindingReason(method, binding, live)
  if (stale !== undefined) return { ok: false, reason: stale }
  const frame = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>
  const runId = runFor(binding, live)
  const expected: Record<(typeof OWNED)[number], string | undefined> = {
    chatId: binding.chatId,
    characterId: binding.characterId,
    runId,
  }
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frame)) {
    if (!(OWNED as readonly string[]).includes(key)) {
      rest[key] = value
      continue
    }
    const owned = key as (typeof OWNED)[number]
    // `undefined` is "not sent", which every shell-owned key may be.
    if (value === undefined) continue
    if (value !== expected[owned]) {
      return {
        ok: false,
        reason: `${method} was refused: the frame sent ${owned} ${JSON.stringify(value)}, but it`
          + ` belongs to ${owned} ${expected[owned] === undefined ? '(none)' : JSON.stringify(expected[owned])}`
          + ` — the shell fills ${owned} itself, and a frame naming another is not forwarded`,
      }
    }
  }
  const sentCharacter = frame['characterId'] !== undefined
  return {
    ok: true,
    params: {
      ...rest,
      chatId: binding.chatId,
      ...wire === 'script.setExtensionPrompt' && runId !== undefined ? { runId } : {},
      ...wire === 'worldbook.setCharBooks' || sentCharacter ? { characterId: binding.characterId } : {},
    },
  }
}
