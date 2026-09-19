/**
 * Where a sandbox plugin's stylesheets live between the frame that wrote them
 * and the message frames that have to paint them.
 *
 * A plugin runs in exactly one realm — the card-script frame (§5.1) — and one of
 * the three things it can do is inject CSS. But the thing a player asks for
 * ("make the status bar dark") is usually drawn in a **different** frame: the
 * card's status bar is a message interface, one opaque-origin document per
 * claimed block per floor. Those frames cannot see the card-script frame's head
 * and nothing may reach across, so the stylesheet travels as **text**: the frame
 * says `plugin:style`, the shell keeps it here, and the next time a message
 * frame is built the text is folded into its `srcdoc` on the road
 * `withMessageCss` already walks.
 *
 * Three properties this module exists to hold, and each one is a decision:
 *
 * - **The store is the shell's, not the sidecar's.** A plugin's styles are
 *   derived from running code, not authored data: they are re-derived on every
 *   mount, and a persisted copy would be a second source of truth that outlives
 *   the code that produced it. Nothing here is written to disk and nothing here
 *   survives a reload — that is the intended lifetime, not a gap.
 * - **The CSS is a string, never markup.** It is a model's output arriving from
 *   an untrusted frame. This module bounds it and `srcdoc.ts` splits its closing
 *   sequences; neither side ever parses it.
 * - **It never touches a document.** Not "does not currently" — the fan-out is
 *   pure data, and the shell's own page must never carry a plugin's sheet
 *   (§16.3). A module with no DOM in it cannot put one there, and a test reads
 *   this file's own source to keep it that way.
 *
 * Outside React, like `plugin-bench.ts` and `card-bus.ts` beside it and for the
 * reason recorded there: the writer is a frame callback whose lifetime is one
 * run of one card, and threading a live handle through a component that
 * re-renders on every keystroke is how a stale closure reaches a torn-down
 * frame.
 *
 * @module iris-web/app/plugin-style-fanout
 */
import { SANDBOX_PLUGIN_LIMITS } from '@iris/protocol'

/** One stylesheet, with the plugin that owns it. */
export interface PluginStyleSheet {
  readonly pluginId: string
  readonly css: string
}

/** What a publish did, so the caller can say so where reports are filed. */
export type PluginStylePublication =
  | { readonly accepted: true, readonly chars: number }
  | {
      readonly accepted: false
      /** Everything this plugin would have held, had the sheet been taken. */
      readonly chars: number
      /** The ceiling it went over. */
      readonly limit: number
    }

/** chatId → pluginId → that plugin's sheets, in the order it inserted them. */
const sheets = new Map<string, Map<string, string[]>>()
/**
 * chatId → how many times its sheets have changed.
 *
 * A counter rather than a digest of the text. `useSyncExternalStore` needs a
 * snapshot that is stable when nothing moved and different when something did,
 * and a digest over two sheets of equal length is exactly the place a cheap hash
 * collides — which would show as a message frame that quietly kept a stylesheet
 * it should have dropped. The counter cannot collide, and it is **per chat** so
 * a plugin in one conversation does not rebuild another's frames.
 */
const revisions = new Map<string, number>()
const subscribers = new Set<() => void>()

/**
 * Tell everyone watching that a conversation's sheets moved.
 * @param chatId - the conversation.
 */
function bump(chatId: string): void {
  revisions.set(chatId, (revisions.get(chatId) ?? 0) + 1)
  for (const subscriber of subscribers) subscriber()
}

/**
 * Take a stylesheet a plugin published, or refuse it by name.
 *
 * **Refused, never truncated.** Half a stylesheet is a stylesheet that paints
 * something nobody wrote, and a syntax error in the half that survived would
 * point a reader at CSS rather than at a ceiling. The frame keeps its own copy
 * either way, so a refusal costs the fan-out and not the plugin — which is the
 * sentence the caller's report has to be able to say.
 *
 * The ceiling is per **plugin**, not per call: `insert` may be called any number
 * of times, and a cap that only looked at one call would be no cap at all. It is
 * the same number the wire enforces on a single sheet
 * ({@link SANDBOX_PLUGIN_LIMITS}.cssChars), in the same unit — UTF-16 units, as
 * `parseFromFrame` measures them — so the two ceilings cannot drift into
 * disagreeing about what 32 KiB means.
 * @param chatId - which conversation's frames this reaches.
 * @param pluginId - the owner.
 * @param css - the stylesheet text, as the frame sent it.
 * @returns whether it was taken, with the numbers a report needs.
 */
export function publishPluginStyle(
  chatId: string,
  pluginId: string,
  css: string,
): PluginStylePublication {
  const byPlugin = sheets.get(chatId) ?? new Map<string, string[]>()
  const held = byPlugin.get(pluginId) ?? []
  const chars = held.reduce((sum, sheet) => sum + sheet.length, 0) + css.length
  if (chars > SANDBOX_PLUGIN_LIMITS.cssChars) {
    return { accepted: false, chars, limit: SANDBOX_PLUGIN_LIMITS.cssChars }
  }
  held.push(css)
  byPlugin.set(pluginId, held)
  sheets.set(chatId, byPlugin)
  bump(chatId)
  return { accepted: true, chars }
}

/**
 * Forget one plugin's sheets in one conversation.
 *
 * The counterpart of `plugin:style`, and it is a message of its own rather than
 * something the shell infers from `plugin:unmount`: a plugin may call
 * `iris.styles.clear()` while it goes on running, and the shell has no way to
 * see that from outside the frame. Teardown item 4 sends it too, so the two
 * paths that drop a sheet in the frame drop it here as well.
 *
 * **Only this plugin's.** A conversation's other plugins keep theirs — the sheets
 * are stored per owner precisely so that "B went away" cannot take A's styling
 * with it, which from the reader's side would look like the wrong plugin being
 * removed.
 * @param chatId - the conversation.
 * @param pluginId - the owner.
 * @returns whether anything was there to forget.
 */
export function retractPluginStyles(chatId: string, pluginId: string): boolean {
  const byPlugin = sheets.get(chatId)
  if (byPlugin === undefined || !byPlugin.has(pluginId)) return false
  byPlugin.delete(pluginId)
  if (byPlugin.size === 0) sheets.delete(chatId)
  bump(chatId)
  return true
}

/**
 * Forget every plugin's sheets in one conversation.
 *
 * Called when the card-script frame that produced them goes away. The styles are
 * derived from running code: a sheet outliving the realm that inserted it would
 * keep painting message frames for a plugin that is no longer mounted, and no
 * later `plugin:style-clear` is ever coming to take it back.
 * @param chatId - the conversation.
 * @returns whether anything was there to forget.
 */
export function forgetChatPluginStyles(chatId: string): boolean {
  if (!sheets.has(chatId)) return false
  sheets.delete(chatId)
  bump(chatId)
  return true
}

/**
 * Every sheet a conversation's message frames should carry, in cascade order.
 *
 * **Plugin id order, ascending**, which is the order the tree mounts in (§9).
 * Two plugins writing the same selector is a tie CSS settles by document order,
 * so the order the sheets are written in *is* the rule "the later-mounted
 * plugin wins" — it has to be the same order in both realms or a card would look
 * different in its own frame than in its message frames.
 * @param chatId - the conversation, or undefined before one is open.
 * @returns the sheets, ready to fold.
 */
export function pluginStyleSheets(chatId: string | undefined): readonly PluginStyleSheet[] {
  if (chatId === undefined) return []
  const byPlugin = sheets.get(chatId)
  if (byPlugin === undefined) return []
  const found: PluginStyleSheet[] = []
  for (const pluginId of [...byPlugin.keys()].sort()) {
    for (const css of byPlugin.get(pluginId) ?? []) found.push({ pluginId, css })
  }
  return found
}

/**
 * How many UTF-16 units of plugin CSS every message frame of a conversation
 * carries.
 *
 * Read by the frame budget: this text is inlined into every one of those frames,
 * so it is weight the 2 MiB pool actually spends.
 * @param chatId - the conversation.
 * @returns the total.
 */
export function pluginStyleChars(chatId: string | undefined): number {
  let total = 0
  for (const sheet of pluginStyleSheets(chatId)) total += sheet.css.length
  return total
}

/**
 * A snapshot token for a conversation's sheets.
 *
 * What an effect depends on, and what `useSyncExternalStore` compares. It is the
 * change counter rather than the text: the text can be hundreds of kilobytes and
 * would be compared on every render of every message row.
 * @param chatId - the conversation.
 * @returns a string that changes exactly when this conversation's sheets do.
 */
export function pluginStyleRevision(chatId: string | undefined): string {
  if (chatId === undefined) return '0'
  return String(revisions.get(chatId) ?? 0)
}

/**
 * Watch the fan-out.
 * @param subscriber - called whenever any conversation's sheets change.
 * @returns the unsubscribe.
 */
export function subscribePluginStyles(subscriber: () => void): () => void {
  subscribers.add(subscriber)
  return () => {
    subscribers.delete(subscriber)
  }
}
