/**
 * The request/response surface, client → host.
 *
 * Requests carry zod schemas because they are the untrusted direction: the
 * browser is a separate trust domain, and a boundary that is only
 * type-checked is not checked at all once the page is open in devtools.
 * Responses and events are types only — the host is their author.
 *
 * Generation is deliberately NOT a response. `chat.send` returns as soon as the
 * turn is opened and the text arrives as events, because a request that
 * resolves with the finished reply cannot stream and cannot be interrupted.
 *
 * @module @iris/protocol/rpc
 */

import { z } from 'zod'

import type { ChatSummary, ChatView, CharacterSummary, ConnectionProfile, GenerationSettings, PromptItemization, ScriptContext, ScriptView } from './views.ts'

/** Runtime schemas for every request body, keyed by method. */
export const requestSchemas = {
  'chat.list': z.object({}),
  'chat.create': z.object({ characterId: z.string().min(1) }),
  'chat.open': z.object({ chatId: z.string().min(1) }),
  'chat.delete': z.object({ chatId: z.string().min(1) }),
  'chat.rename': z.object({ chatId: z.string().min(1), title: z.string().max(200) }),

  'chat.send': z.object({
    chatId: z.string().min(1),
    // Bounded because it lands in a prompt; an unbounded field is a way to
    // burn someone's tokens from a page they were tricked into opening.
    text: z.string().min(1).max(32_000),
  }),
  'chat.regenerate': z.object({ chatId: z.string().min(1) }),
  'chat.abort': z.object({ chatId: z.string().min(1) }),
  'chat.swipe': z.object({
    chatId: z.string().min(1),
    turn: z.number().int().min(0),
    index: z.number().int().min(0),
  }),
  'chat.editMessage': z.object({
    chatId: z.string().min(1),
    id: z.number().int().min(0),
    text: z.string().max(32_000),
  }),
  'chat.deleteMessage': z.object({ chatId: z.string().min(1), id: z.number().int().min(0) }),

  /**
   * Branch the conversation at a message, into a new chat.
   *
   * `id` is INCLUSIVE, matching upstream: `chat.slice(0, mesId + 1)`. The
   * branch keeps the message you branched at, because a user picks the last
   * message they want to keep, not the first they want gone.
   *
   * `swipeId` branches from an alternate generation rather than the one showing,
   * which is what makes branching useful next to swipes: keep this reply here,
   * and explore that one over there.
   */
  /**
   * Where an assembled prompt's tokens went.
   *
   * Upstream hangs this off a message's ⋯ menu (`mes_prompt`, 📊), which is
   * where a SillyTavern user will look for it.
   *
   * Omitting `turn` asks how the NEXT request would assemble — a preview, which
   * needs no stored record because assembly is pure. Giving one asks for the
   * request that turn actually sent; the host keeps those only while the chat
   * is open, and answers with a preview (`preview: true`) when the record is
   * gone.
   */
  /**
   * Saved connections: an endpoint, a model and a preset switched as a set.
   *
   * Measured on the user's install, their two profiles differ in endpoint URL
   * *and* credential as well as model — switching a connection is switching all
   * of it, which is why this is one object rather than a model picker.
   *
   * The endpoint itself is a composition row (`provider`), not a field here.
   * That is a real limit: a new endpoint means editing the composition, not
   * adding one in the interface. Lifting it is not blocked on registering an
   * adapter at runtime, which is mechanical — it is blocked on **where a
   * credential added through the interface would be stored**. Today the answer
   * is the gitignored `.env`; putting one in a profile file needs a deliberate
   * secret-storage decision, and SillyTavern's plaintext `secrets.json` is a
   * counter-example rather than a precedent. Whoever lifts this passes that gate
   * first.
   */
  /**
   * Run a slash command pipeline on the card's behalf.
   *
   * The command string crosses the wire **unparsed**. Splitting it needs
   * upstream's escape rule — a `|` preceded by an odd number of backslashes is
   * literal — and a second implementation of that rule in the browser would be
   * two copies of one convention, agreeing in every test and disagreeing on the
   * first message a user types a `|` into. That is the shape of the most
   * expensive bug this project has had.
   *
   * Measured: four call sites in the corpus, all one snippet, two commands
   * (`/send` and `/trigger`). Anything else is refused by name.
   */
  /**
   * Read a card script's variables.
   *
   * The read half of `script.setVariables`, and it exists for exactly one
   * caller: `updateVariablesWith` is the only Tavern Helper writer that reads
   * before it writes, so it is the only one that needs the current table before
   * it can send a `replace`. The frame's prompt snapshot carries the `message`
   * scope and nothing else, and MVU applies the same updater to `chat` as well
   * (`update_variables.ts:1548`), where the frame has nothing to read.
   *
   * Defaulting that read to `{}` would be worse than refusing it: an updater run
   * against an empty tree and stored back **erases the scope it was meant to
   * amend**. So the frame refuses by name without this, and with it, reads.
   */
  'script.getVariables': z.object({
    chatId: z.string().min(1),
    scope: z.enum(['message', 'chat', 'global', 'script']),
    /** For `message`: which turn's candidate. Absent means the newest. */
    messageId: z.number().int().min(0).optional(),
    /** For `script`: whose partition. */
    scriptId: z.string().min(1).optional(),
  }),
  /**
   * Write a card script's variables.
   *
   * The **operation** crosses the wire, not a pre-merged tree. Tavern Helper's
   * five writers differ in ways that matter — `insertOrAssign` lets the incoming
   * value win and replaces an array wholesale rather than merging it, `insert`
   * lets the existing value win — and folding them into "read, merge, replace"
   * in the browser would put those rules in a second implementation. That is the
   * shape of this project's most expensive bug, and of the slash-parsing mistake
   * that preceded this method.
   *
   * `updateVariablesWith` is the exception and stays in the frame: it takes a
   * function, which cannot cross a process boundary. The frame reads, applies
   * the card's function, and sends the result as `replace`.
   */
  'script.setVariables': z.object({
    chatId: z.string().min(1),
    scope: z.enum(['message', 'chat', 'global', 'script']),
    /** For `message`: which turn's candidate. Absent means the newest. */
    messageId: z.number().int().min(0).optional(),
    /** For `script`: whose partition. */
    scriptId: z.string().min(1).optional(),
    op: z.enum(['replace', 'insertOrAssign', 'insert', 'delete']),
    /** The tree, for every op but `delete`. */
    variables: z.record(z.string(), z.unknown()).optional(),
    /** The lodash path, for `delete`. */
    path: z.string().min(1).max(500).optional(),
  }),
  /**
   * Show a different alternate generation.
   *
   * `messageId` is a {@link ScriptChatMessage} index, the same number a card
   * script sees; the host maps it to the turn that owns it.
   */
  'script.swipeTo': z.object({
    chatId: z.string().min(1),
    messageId: z.number().int().min(0),
    swipeIndex: z.number().int().min(0),
  }),

  'script.slash': z.object({
    chatId: z.string().min(1),
    command: z.string().min(1).max(32_000),
  }),

  'connection.list': z.object({}),
  'connection.save': z.object({
    /** Absent creates; present replaces that profile. */
    id: z.string().min(1).optional(),
    label: z.string().max(200).optional(),
    provider: z.string().min(1),
    model: z.string().min(1),
    preset: z.string().max(255).optional(),
    sampling: z.record(z.string(), z.unknown()).optional(),
  }),
  'connection.delete': z.object({ id: z.string().min(1) }),
  /** Apply a profile: globally, or to one chat when `chatId` is given. */
  'connection.activate': z.object({
    id: z.string().min(1),
    chatId: z.string().min(1).optional(),
  }),

  'prompt.itemize': z.object({
    chatId: z.string().min(1),
    turn: z.number().int().min(0).optional(),
  }),

  'chat.branch': z.object({
    chatId: z.string().min(1),
    id: z.number().int().min(0),
    swipeId: z.number().int().min(0).optional(),
  }),

  'character.list': z.object({}),
  'character.import': z.object({
    filename: z.string().min(1).max(255),
    /** Base64 of a PNG card, a `.json` card, or a `.charx`. */
    content: z.string().min(1),
  }),
  'character.delete': z.object({ characterId: z.string().min(1) }),

  'settings.get': z.object({ chatId: z.string().min(1).optional() }),
  /**
   * A partial patch, with three cases the two halves must read alike:
   * an omitted key leaves that field alone, an explicit `null` clears the
   * optional field so the host's own default applies, and an unrecognized key
   * is dropped rather than stored — a typo must not look supported.
   *
   * `null` carries that meaning because omission is already spoken for: a patch
   * has no other way to say "stop overriding this".
   */
  'settings.set': z.object({
    chatId: z.string().min(1).optional(),
    settings: z.record(z.string(), z.unknown()),
  }),

  /** Every script a character's card carries, enabled or not. */
  'script.list': z.object({ characterId: z.string().min(1) }),
  /**
   * The user's own on/off for one script, independent of the card's `enabled`.
   *
   * Two switches rather than one: the card author's is a fact about the card and
   * survives re-import, the user's is a decision about this installation. Fusing
   * them would let a re-import quietly revive a script the user turned off.
   */
  'script.setEnabled': z.object({
    characterId: z.string().min(1),
    scriptId: z.string().min(1),
    enabled: z.boolean(),
  }),
  /**
   * Grant or revoke one card's access to the real page document.
   *
   * Per-card and user-driven. There is deliberately no method by which a script
   * can request this: a request is text the card authored, and a card that can
   * put words in front of the user can argue for its own privileges.
   */
  'script.setDocumentGrant': z.object({
    characterId: z.string().min(1),
    granted: z.boolean(),
  }),
  /**
   * Record the user's answer to "may this card's scripts run at all".
   *
   * Asked once per card and remembered, in the same table and with the same
   * lifetime as the document grant — so deleting the card forgets it and a
   * reused id does not inherit it. There is deliberately no "always allow every
   * card" switch: that would short-circuit the per-card model, which is the one
   * SillyTavern's users already hold.
   */
  'script.setScriptsAllowed': z.object({
    characterId: z.string().min(1),
    allowed: z.boolean(),
  }),
  /**
   * Fetch a remote script dependency through the host.
   *
   * The whitelist is enforced here and not in the page, because a page cannot
   * police its own fetches. A refusal names the host rather than reporting a
   * generic failure — a card that cannot load a dependency has to be
   * diagnosable by whoever holds the card.
   */
  'script.fetch': z.object({
    url: z.string().min(1).max(2048),
  }),

  /**
   * Everything a card reads through `SillyTavern.getContext()`.
   *
   * One read rather than fifteen field methods, because that is how cards use
   * it: they take the whole context once and then read members off it, often in
   * a loop. Fifteen round trips per script would be the shape of our contract
   * imposed on theirs.
   */
  'script.context': z.object({
    chatId: z.string().min(1),
    /** Whose partition of extension settings to include. */
    characterId: z.string().min(1),
    /**
     * The floor this context belongs to, for a **message** frame.
     *
     * Absent for a script frame, which belongs to the card rather than to any
     * one message. When present the context carries that floor's own variable
     * layer, so a frame rendered inside a message answers
     * `getCurrentMessageId()` with its real floor and reads
     * `{type: 'message', message_id: <its own floor>}` from what it was given
     * instead of asking again.
     *
     * Requested rather than always included: the layer is per floor, and pushing
     * every floor's was measured at 22x the newest one with no upper bound —
     * 8.29 MiB on the corpus's longest chat. One floor's worst case is 282.8 KiB
     * and is bounded by construction.
     */
    messageId: z.number().int().min(0).optional(),
  }),
  /**
   * Write back the chat metadata a card has been mutating.
   *
   * Whole-object, not a patch, because that is what upstream does and because
   * cards mutate arbitrarily deep and also delete — a patch dialect able to
   * express what they do would be a design of its own. The consequence is
   * last-write-wins, which is upstream's behaviour too: two scripts racing on
   * the same chat lose one of the writes.
   */
  'script.saveMetadata': z.object({
    chatId: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()),
  }),
  /** Persist the chat now, as upstream's `saveChat` does. */
  'script.saveChat': z.object({ chatId: z.string().min(1) }),
  /**
   * Inject a script's text into the prompt.
   *
   * Keyed so a script can replace its own injection: upstream's
   * `setExtensionPrompt` is idempotent per key, and a card calling it every
   * turn expects to overwrite rather than accumulate.
   */
  'script.setExtensionPrompt': z.object({
    chatId: z.string().min(1),
    key: z.string().min(1).max(200),
    value: z.string().max(32_000),
    position: z.enum(['before', 'after', 'at-depth']).default('at-depth'),
    depth: z.number().int().min(0).max(1000).default(0),
  }),
  /**
   * One script's body, for the runner about to execute it.
   *
   * Separate from `script.list` on purpose: the list answers "what does this
   * card contain" and stays cheap enough to open in a settings pane, while a
   * body can be megabytes of webpack output. One script per call, because the
   * runner starts scripts one at a time and a card's whole payload is only
   * needed by the card that is actually being run.
   */
  'script.body': z.object({
    characterId: z.string().min(1),
    scriptId: z.string().min(1),
  }),

  /**
   * Write back this card's extension settings.
   *
   * The read side alone was not enough, and the corpus is what showed it: a
   * card does `if (!extensionSettings.someKey) { …compute… }` and then
   * `extensionSettings.someKey = result`. Without a write it reads falsy every
   * run, recomputes, assigns into a snapshot that is discarded, and repeats
   * that work forever without ever saying anything.
   *
   * Whole-object per card, matching `script.saveMetadata`: cards mutate their
   * settings object and expect deletions to stick, which a merge would undo.
   * The partition is the card's own — one card can neither read nor overwrite
   * another's, because cross-card access would defeat the per-card grant model
   * by letting a card learn through a neighbour what it was not allowed itself.
   */
  'script.setExtensionSettings': z.object({
    characterId: z.string().min(1),
    settings: z.record(z.string(), z.unknown()),
  }),

  /**
   * One completion, on the card's behalf.
   *
   * Non-streaming, matching upstream's `generateRaw`, which resolves with the
   * finished string. A card asking for one is doing a side computation — a
   * summary, a classification — not writing the visible reply, so there is
   * nothing to stream it into.
   */
  'script.generateRaw': z.object({
    chatId: z.string().min(1),
    prompt: z.string().min(1).max(64_000),
    systemPrompt: z.string().max(32_000).optional(),
  }),
  /**
   * Rewrite the text of one or more floors, as a card script does.
   *
   * Upstream's `setChatMessages`, and it is on MVU's generation-time path rather
   * than being an editing convenience: `update_variables.ts:1563` appends a
   * status placeholder or strips a `<status_current_variable>` block from the
   * reply that just arrived, and `on_message_received.ts:56` appends an
   * extra-model result to it. A card that cannot do this cannot render a status
   * panel, which is what most of the corpus's scripts exist to do.
   *
   * **The same write path as `chat.editMessage`**, not a second one: a floor's
   * text lives in its swipe list and `mes` only points at one entry, so an edit
   * that misses the list is undone by the next swipe back and forth. That rule
   * is already implemented once and this goes through it.
   *
   * Batched because upstream's signature is, and because a script appending a
   * panel to several floors should not be able to leave half of them rewritten:
   * every id is checked before anything is written.
   *
   * `refresh` is accepted and ignored — upstream's `'none' | 'affected' | 'all'`
   * is a hint about repainting its own DOM, and this host tells every attached
   * page what changed regardless. Rejecting the field would make a caller
   * written against upstream fail on an argument that means nothing here.
   */
  'script.setChatMessages': z.object({
    chatId: z.string().min(1),
    messages: z.array(z.object({
      /** The chat-file line index, which is what a card counts. */
      messageId: z.number().int().min(0),
      message: z.string().max(32_000),
    })).min(1).max(200),
    refresh: z.enum(['none', 'affected', 'all']).optional(),
  }),
  /**
   * Generate the way a real turn would, without becoming one.
   *
   * Upstream has two of these and the difference is not cosmetic.
   * `TavernHelper.generate` assembles the preset, the world info and the history
   * and puts `user_input` last; `generateRaw` sends only what it is handed.
   * `script.generateRaw` above is the second. A card asking for the first and
   * served by the second gets a reply produced with no persona, no lorebook and
   * no conversation — **and it succeeds**, which is why they are separate
   * methods rather than a flag.
   *
   * Nothing is recorded: not the log, and not the two pieces of chat state a
   * real assembly advances (world-info timed effects, the turn's itemization).
   *
   * `injects`, `overrides`, `tools`, `tool_choice` and `json_schema` are in
   * upstream's config and deliberately absent here: no card in the corpus passes
   * any of them, and a field added for a hypothetical caller is untested
   * surface. `should_stream` is absent for a measured reason — the stream only
   * drives a character-count progress indicator, and the body comes from the
   * awaited return value.
   */
  'script.generate': z.object({
    chatId: z.string().min(1),
    userInput: z.string().min(1).max(64_000),
    systemPrompt: z.string().max(32_000).optional(),
    /** Upstream's `max_chat_history`; absent keeps all of it. */
    maxHistory: z.number().int().min(0).optional(),
  }),
} as const

/** Every callable method. */
export type RpcMethod = keyof typeof requestSchemas

/** The validated request body of one method. */
export type RpcRequest<M extends RpcMethod> = z.infer<(typeof requestSchemas)[M]>

/** What each method resolves with. */
export interface RpcResponseMap {
  'chat.list': { chats: ChatSummary[] }
  'chat.create': { view: ChatView }
  'chat.open': { view: ChatView }
  'chat.delete': Record<string, never>
  'chat.rename': { chats: ChatSummary[] }

  /** Resolves when the turn is open, not when the reply is finished. */
  'chat.send': { turn: number }
  /**
   * Produces another candidate for the LAST turn only.
   *
   * Regenerating an earlier turn would mean discarding everything after it,
   * which is a different operation with different consequences; it is
   * deliberately absent rather than implied.
   */
  'chat.regenerate': { turn: number }
  'chat.abort': Record<string, never>
  'chat.swipe': { view: ChatView }
  'chat.editMessage': { view: ChatView }
  'chat.deleteMessage': { view: ChatView }
  /** The new branch, already open, plus the refreshed list it now appears in. */
  'chat.branch': { view: ChatView, chats: ChatSummary[] }
  'prompt.itemize': { itemization: PromptItemization }

  /** The stored table, so a card sees what its write actually produced. */
  'script.getVariables': { variables: Record<string, unknown> }
  'script.setVariables': { variables: Record<string, unknown> }
  'script.swipeTo': { view: ChatView }
  /** Upstream's `triggerSlash` resolves with the pipeline's result. */
  'script.slash': { result: string }

  'connection.list': { profiles: ConnectionProfile[], activeId?: string }
  'connection.save': { profiles: ConnectionProfile[], activeId?: string }
  'connection.delete': { profiles: ConnectionProfile[], activeId?: string }
  'connection.activate': { settings: GenerationSettings, activeId: string }

  'character.list': { characters: CharacterSummary[] }
  'character.import': { character: CharacterSummary }
  'character.delete': Record<string, never>

  'settings.get': { settings: GenerationSettings }
  'settings.set': { settings: GenerationSettings }

  /**
   * What a card contains, and what the user has decided about it.
   *
   * `scriptsAllowed` carries **three** states and is absent for the third:
   * absent means the user has never been asked, `false` means they were asked
   * and declined. The shell must not fold those together — absent is what makes
   * it ask, and `false` is what stops it asking again. This is the opposite of
   * `documentGranted`, which is a plain boolean because a revoked grant and one
   * never given are meant to be the same state.
   */
  'script.list': { scripts: ScriptView[], documentGranted: boolean, scriptsAllowed?: boolean }
  'script.setEnabled': { scripts: ScriptView[] }
  'script.body': { content: string }
  'script.setDocumentGrant': { documentGranted: boolean }
  'script.setScriptsAllowed': { scriptsAllowed: boolean }
  /** The fetched body. Refusals arrive as an `unsupported` rejection. */
  'script.fetch': { content: string, contentType?: string }

  'script.context': { context: ScriptContext }
  /** The metadata as stored, so a card can see what survived. */
  'script.saveMetadata': { metadata: Record<string, unknown> }
  'script.saveChat': Record<string, never>
  'script.setExtensionPrompt': Record<string, never>
  /** The settings as stored, so a card can see what survived. */
  'script.setExtensionSettings': { settings: Record<string, unknown> }
  'script.generateRaw': { text: string }
  'script.generate': { text: string }
  'script.setChatMessages': { view: ChatView }
}

/** The response of one method. */
export type RpcResponse<M extends RpcMethod> = RpcResponseMap[M]

/** A failure the client can render. */
export interface RpcError {
  /** Stable machine-readable reason. */
  code:
    | 'not-found'
    | 'invalid-request'
    | 'provider-error'
    | 'busy'
    | 'unsupported'
    | 'internal'
  /** Human-readable detail. Safe to show; must not carry a credential. */
  message: string
}

/**
 * The rejection `IrisClient.call` produces.
 *
 * A real `Error`, not a bare shape: a promise rejected with a plain object
 * loses its stack and every tool that formats errors — the console, a test
 * runner, an error boundary — degrades to printing `[object Object]`. The
 * machine-readable half rides alongside so a caller can still branch on
 * `code` without parsing prose.
 */
export class RpcCallError extends Error implements RpcError {
  readonly code: RpcError['code']

  /**
   * @param error - the failure the host reported.
   */
  constructor(error: RpcError) {
    super(error.message)
    this.name = 'RpcCallError'
    this.code = error.code
  }
}

/** One request frame on the wire. */
export interface RpcRequestFrame<M extends RpcMethod = RpcMethod> {
  /** Correlates the response. */
  id: string
  method: M
  params: RpcRequest<M>
}

/** One response frame on the wire. */
export type RpcResponseFrame<M extends RpcMethod = RpcMethod> =
  | { id: string, ok: true, result: RpcResponse<M> }
  | { id: string, ok: false, error: RpcError }

/**
 * Validate an incoming request body.
 *
 * The single place the host is allowed to trust a browser payload. Returns a
 * discriminated result rather than throwing, so the transport answers with an
 * `invalid-request` frame instead of tearing down the connection — a malformed
 * frame from one page must not disconnect the others.
 * @param method - the requested method.
 * @param params - the raw body.
 * @returns the parsed params, or the reason they were refused.
 */
export function parseRequest<M extends RpcMethod>(
  method: M,
  params: unknown,
): { ok: true, params: RpcRequest<M> } | { ok: false, error: RpcError } {
  // Widened to `unknown` rather than to `RpcRequest<M>`: the map's value type is
  // a union of concrete schemas, and asserting it into the per-method schema
  // type is the cast TypeScript rightly refuses. The narrowing happens once, on
  // the parsed result, where the schema has already proved the shape.
  const schema = requestSchemas[method] as z.ZodType<unknown> | undefined
  if (schema === undefined) {
    return { ok: false, error: { code: 'unsupported', message: `unknown method "${String(method)}"` } }
  }
  const result = schema.safeParse(params)
  if (!result.success) {
    return { ok: false, error: { code: 'invalid-request', message: result.error.issues[0]?.message ?? 'invalid params' } }
  }
  return { ok: true, params: result.data as RpcRequest<M> }
}
