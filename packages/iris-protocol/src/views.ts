/**
 * What the browser is allowed to know.
 *
 * These are wire shapes, deliberately narrower than the domain types they are
 * projected from. The chat log carries every alternate generation, every raw
 * stream chunk and every variable write; a UI needs the current text, a swipe
 * counter and enough identity to act on a message. Sending the log itself would
 * couple the front end to the durable format and make every schema change a
 * client release.
 *
 * @module @iris/protocol/views
 */

/** Conversation roles the UI renders. */
export type ViewRole = 'system' | 'user' | 'assistant'

/** One message as the UI shows it. */
export interface MessageView {
  /** Stable index in the conversation, matching what a card script would see. */
  id: number
  /**
   * Identity for the lifetime of one open chat.
   *
   * `id` cannot serve: it is a position, so deleting a message shifts every
   * later one and a UI keyed on it reuses component instances across what are
   * now different messages — an open inline editor ends up attached to the
   * neighbouring turn. This need not survive a reload or match anything the
   * host stores; it only has to stay put while the chat is open.
   */
  key: string
  role: ViewRole
  /** Speaker name, for group chats and instruct-mode display. */
  name: string
  /** The selected candidate's text. */
  text: string
  /** Reasoning the model emitted, kept separate so the UI can collapse it. */
  reasoning?: string
  /**
   * Swipe state. Present on assistant messages only; `count` of 1 still means
   * the UI should offer regeneration, just not left/right navigation.
   */
  swipes?: { count: number, index: number }
  /**
   * The turn this message belongs to. The UI needs it because swipe and
   * regenerate address a turn, not a message index.
   */
  turn?: number
  /** True while this message is still streaming. */
  streaming?: boolean
  /**
   * What generating the **selected** candidate cost, when the provider reported
   * it. Assistant messages only; user lines and imported history carry none.
   */
  usage?: TurnUsage
}

/**
 * What one generation cost, in the harness convention: the three prompt-side
 * buckets are **disjoint** (`inputTokens` excludes what the cache served), so a
 * cache-hit share is `cacheReadTokens / (inputTokens + cacheReadTokens +
 * cacheWriteTokens)`. Mirrors `@deepseek-ai/dsh-llm` `TokenUsage`, which the
 * adapter already produces; kept as its own name here because a view type must
 * not import from the LLM layer. Absent fields were not reported by the
 * provider - never zero-filled, because "0 cache reads" and "the provider does
 * not report cache" are different facts and a hit rate must not be computed
 * from the second.
 */
export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /** Present only when the provider's aggregate counters were exact and agreed. */
  totalTokens?: number

  /*
   * The three fields below are **not** buckets and are **not** summed. They
   * identify the one generation this record describes, which is what makes a
   * usage record answerable across conversations: "what did this model cost
   * last week" cannot be asked of numbers that carry neither a model nor a
   * moment.
   *
   * They are on this type rather than beside it because they must ride in the
   * same stored object as the buckets — see `@iris/app-service`'s
   * `USAGE_FIELD`, which explains why a parallel array in a SillyTavern chat
   * file is a record that silently shifts. `PromptFingerprint`'s hashes ride
   * there for the same reason, and are deliberately NOT here: those are
   * host-side evidence and nothing on the wire reads them.
   *
   * **A sum never carries them.** `sumUsage` builds its total from the buckets
   * alone, so a conversation-level or bucket-level aggregate has all three
   * absent — which is the honest reading, since a conversation can have run on
   * several models over several days. Only a single generation's record carries
   * an identity. A consumer that finds `model` on an aggregate has found a bug,
   * not a route.
   */

  /**
   * The model this generation was routed to, as configured — never normalised,
   * because the string a provider bills under is the string a user typed.
   *
   * Absent on every record written before this field existed, and on any
   * generation whose route the host could not name. A statistics surface must
   * render that as "unknown model" and keep counting the tokens: they were
   * spent either way, and dropping them would understate a bill. Iris's own
   * `usage.summary` groups by exactly this string.
   */
  model?: string
  /** The provider behind {@link model}; same absence rule. Recorded because one model name can be served by more than one route, and not part of any grouping key. */
  provider?: string
  /**
   * When the request went out, Unix epoch milliseconds.
   *
   * The request, not the reply: it is the moment fixed by the host at the point
   * it already knows the route, one site rather than two, and for a figure
   * bucketed by hour or day the difference from the settle time is not
   * observable. Absent on records written before the field existed — a chat
   * file carries no per-message date either (Iris's own export writes no
   * `send_date`, measured over the 16 real chats on this machine), so a reader
   * that needs to place an undated record in time has to fall back to the
   * chat's own header and say that it did.
   */
  at?: number
  /**
   * Who asked for this generation: the user's own turn, a card's script, or the
   * host's own compaction summarizer.
   *
   * **Absent reads as `'turn'`**, which is what every record written before
   * this field existed is — and the reason it is optional rather than required
   * with a default. A reader that treated absence as unknown would put the
   * whole existing corpus in a third category that has no meaning: before card
   * generations were recorded at all, every stored record was a turn by
   * construction.
   *
   * A `'script'` record is a request `TavernHelper.generate` /
   * `generateRaw` made from inside a card (`@iris/app-service`'s
   * `#sideGenerate` / `#generateRaw`). It was billed exactly like a turn and
   * it is **not** a turn: it produced no candidate, so it hangs off the
   * conversation rather than off any message — see `SIDE_USAGE_FIELD`. MVU
   * fires one of these per turn for its variable update, so on that card the
   * two populations are the same size and a total that counted only one of
   * them was about half the bill.
   *
   * A `'compaction'` record is the **host's own** summary request
   * (`@iris/app-service`'s `#summarize`, reached from `/compact` and from the
   * automatic trigger). Same standing as a script's, and a different asker: no
   * candidate, billed on this conversation's route, and nobody asked for it in
   * the turn it happens inside. It is kept apart from `'script'` rather than
   * folded into one "not a turn" bucket because the two answer different
   * questions — a card's spend is the card author's doing, a compaction's is
   * Iris's own policy, and a reader who wants less of the second changes a
   * threshold rather than a card.
   *
   * Not a grouping key on the wire's own summary cells: those are cut by
   * (time, model). The splits by source are carried instead as
   * {@link UsageTotals.script} and {@link UsageTotals.compaction}, so a surface
   * can show a share without the cell count doubling.
   */
  source?: 'turn' | 'script' | 'compaction'
}

/**
 * An early span of a conversation, standing in for itself as a summary.
 *
 * **No message was deleted.** {@link ChatView.messages} still carries every
 * floor; this record says that the leading {@link ChatCompaction.count} of them
 * are no longer sent to the model verbatim — one summary floor is sent in their
 * place when the next request assembles. Upstream's Summarize extension has the
 * same relationship to a chat (it injects a summary and leaves `context.chat`
 * alone); the difference is that Iris also *stops sending* the span, which is
 * what makes the context actually shrink.
 * `notes/packages/iris-app-service/DEVIATIONS.md` §27.
 */
export interface ChatCompaction {
  /**
   * How many leading floors the summary stands for.
   *
   * A count rather than a message id, because a count is the unit the
   * substitution is written in — the assembler is handed a list of history
   * entries and the summary replaces its first `count`. An id would have to be
   * converted at every read, and the conversion is where an off-by-one hides.
   */
  count: number
  /** The model's summary, unframed — the framing is the host's and is added at assembly. */
  summary: string
  /** What the compacted span was estimated to cost when it was replaced. */
  spanTokens: number
  /** What the framed summary costs instead. Always less than {@link ChatCompaction.spanTokens}. */
  summaryTokens: number
  /** Unix epoch milliseconds. */
  at: number
  /** Which model wrote it, so a reader can tell a cheap summary from a careful one. */
  model: string
}

/**
 * The largest context window this host will accept from anyone.
 *
 * **In the protocol, because three layers check it and only one of them could
 * have owned it.** The settings store bounds what a person may type
 * (`@iris/app-service`'s `NUMERIC_FIELDS.contextWindow`), the probe bounds what
 * an endpoint may report about a model, and `connection.save`'s schema bounds
 * what may cross the wire. The first two are host-side and the third is not, so
 * a constant living in the host could only be *restated* on the wire — and a
 * wire validator restating a bound is how a schema comes to reject what the
 * store would have accepted.
 *
 * A bound on *credulity*, not a capability claim: nothing here says a 4M window
 * works anywhere, only that a larger number is likelier to be a unit error than
 * a model.
 */
export const MAX_CONTEXT_WINDOW = 4_000_000

/**
 * How long a model's context is, and who said so.
 *
 * The `source` is not decoration. A number the endpoint itself reported and a
 * number this host looked up in a table baked in at build time are two
 * different kinds of fact — the first is current, the second is as old as the
 * release — and a surface that shows a window without saying which one it is
 * leaves the user unable to tell "my provider says 1M" from "we guessed".
 */
export interface ModelContextLength {
  /** Tokens. */
  tokens: number
  /**
   * `'provider'`: the endpoint's own `/models` row carried it.
   * `'table'`: read out of this host's built-in model table.
   */
  source: 'provider' | 'table'
}

/**
 * Why the context window is the number it is.
 *
 * Four answers, because they are four different next steps for the reader: a
 * clamped window changes by changing model or unlocking, a window in force from
 * the settings changes in the settings, an unlocked one is a decision they have
 * already made, and the host default means nothing has ever set one.
 */
export type ContextWindowSource
  /** Clamped down to the model's own known window. */
  = 'model'
  /** The stored value — the user's, or their preset's — stands. */
  | 'settings'
  /**
   * The stored value stands *above* the model's known window, because
   * {@link GenerationSettings.contextUnlocked} is on.
   */
  | 'unlocked'
  /** Nothing has set one; the host composition's value is in force. */
  | 'host'

/**
 * What one conversation's next request may spend, and who decided the window.
 *
 * Named rather than inline because three layers hand it to each other — the
 * service resolves it, the entry projects it, the composer divides by it — and
 * an inline shape restated at each boundary is the seam a field goes missing
 * across.
 */
export interface ChatBudget {
  context: number
  /**
   * Tokens held back out of {@link context} for the reply, so `context -
   * reserve` is what the prompt may spend.
   *
   * **This is the same number the request sends as `max_tokens`**, whenever the
   * chat configures one — upstream's rule, transcribed: `openai.js:1558` calls
   * `setTokenBudget(openai_max_context, openai_max_tokens)` and
   * `openai.js:3887` is `this.tokenBudget = context - response`, while
   * `openai.js:2750` puts that very `openai_max_tokens` on the wire. So there
   * is one figure upstream and it does both jobs; a host that reserved less
   * than it allowed the reply to produce would assemble a prompt that plus the
   * reply overflows the window, which is a provider error rather than a trim.
   *
   * The host's own `reserveTokens` is the fallback for a chat that configures
   * no `maxTokens` — nothing to subtract is not the same as subtracting
   * nothing, and a window with no reply allowance held back is the one shape
   * that cannot be sent.
   */
  reserve: number
  /**
   * Why {@link context} is that number.
   *
   * **Required, not optional.** The two fields below are absent when there is
   * nothing to say; this one always has an answer, because the host cannot
   * resolve a window without taking one of the four paths. Making it optional
   * would let a projection that forgot it read as "no opinion", and a capacity
   * readout that cannot name its own denominator is exactly the state that made
   * a 2 000 000-token window sit unexplained under a 1M model.
   */
  source: ContextWindowSource
  /** The model the window was judged against, when the settings named one. */
  model?: string
  /**
   * That model's own known window, when anything knew one.
   *
   * Carried even when it did **not** win — with `source: 'unlocked'` this is
   * the number the user chose to exceed, and a surface that wants to say so
   * needs it. Absent means nothing knows this model's window, which is why
   * nothing was clamped.
   */
  modelContext?: number
}

/** One open conversation. */
export interface ChatView {
  chatId: string
  title: string
  characterId?: string
  messages: MessageView[]
  /**
   * What this conversation's next request is allowed to spend.
   *
   * The two numbers {@link PromptItemization.budget} carries, resolved the same
   * way — the preset's own `openai_max_context` when it has one, clamped to the
   * model's known window, the host composition's value otherwise — carried on
   * the open chat so a surface can say how full the window is **without**
   * asking for an itemization. Assembling one is not free (a full world-info
   * scan and a macro pass), and a capacity readout that paid that on every
   * keystroke is a readout nobody could afford to show.
   *
   * Plus the provenance the two numbers alone could not carry: an itemization's
   * budget is an account of one assembly, while this is a standing answer to
   * "what is the window, and who decided" — see {@link ContextWindowSource}.
   *
   * **Optional, and absent is a real state rather than a gap to fill in.** The
   * projection is handed these numbers by whoever resolves the settings;
   * something that projects a conversation without them — a fixture, a
   * transport test — gets a view that says nothing about capacity, and a
   * surface reading it shows no meter. Zero-filling instead would put a `0`
   * window on the wire, and every consumer that divides by it would report a
   * conversation as infinitely full.
   */
  budget?: ChatBudget
  /**
   * What the newest real turn's prompt actually measured.
   *
   * The one free reading of "how full is it" this host has. Every real
   * generation records its own itemization (`@iris/app-service`'s
   * `entry.itemizations`), and the host was already reading the newest one back
   * for auto-compaction without projecting it — so a capacity surface can draw
   * a measured occupancy with no `prompt.itemize` round trip and no second
   * assembly, which is what {@link budget} alone could never give it.
   *
   * **A measurement, so it is dated by turn rather than presented as current.**
   * `turn` is the turn it was taken on; the newest floor may be later than that
   * (a swipe, an imported chat, a floor added by a script), and a reader that
   * wants to know whether the reading still describes the next request compares
   * it against the conversation's own length.
   *
   * **Absent is the normal state after a restart.** The records live in memory
   * for as long as the host holds the chat open, so a freshly opened profile
   * has none until it generates once. Absent means "nothing has been measured
   * in this process", never "nothing is in the window".
   */
  measured?: { turn: number, tokens: number }
  /** Present only when an early span of this conversation has been compacted. */
  compaction?: ChatCompaction
  /** Variables of the newest turn, for a status-bar surface. */
  variables?: Record<string, unknown>
  /**
   * Every generation this conversation ever paid for, summed - all swipes, not
   * only the selected ones, because a regenerated reply was billed too. Absent
   * until one generation has reported usage. Optional buckets are summed only
   * over generations that reported them; a bucket no generation reported stays
   * absent, so the hit rate is never diluted by providers that say nothing.
   *
   * **{@link TurnUsage.totalTokens} is always absent here**, on purpose and by
   * ruling. Summed under the rule above it would cover only the generations
   * that carried an exact total, coming out *smaller* than the buckets printed
   * beside it whenever a conversation mixed providers — and a field named
   * `totalTokens` sitting next to four buckets it does not total is a number
   * every consumer reads wrong, silently. So a conversation reports the four
   * buckets and no total; a surface that wants one adds the buckets it is
   * showing. One generation keeps its own `totalTokens`, where the provider's
   * aggregate is exactly what it claims to be — see {@link MessageView.usage}.
   *
   * A generation the host could not attach to a reply is not counted: an
   * impersonation writes a *user* line, so it has no candidate to carry a cost
   * and its tokens are absent from this sum. The host records why (see
   * `@iris/app-service`'s `recordUsage`).
   *
   * **A card's own generations are in here, and so are the host's compaction
   * summaries.** `TavernHelper.generate` / `generateRaw` and `#summarize` are
   * all billed to this conversation on this conversation's route, so they
   * belong in "what this conversation has cost" — which is the reading the
   * composer's line is asked for. None of them has a candidate to hang off, so
   * they are stored on the header instead of on a message
   * (`@iris/app-service`'s `SIDE_USAGE_FIELD`), and {@link scriptUsage} /
   * {@link compactionUsage} are how a surface says how much of this figure they
   * are.
   */
  usage?: TurnUsage
  /**
   * The part of {@link usage} that a card's own script asked for, and how many
   * generations that was.
   *
   * Inside `usage`, never beside it — see the paragraph there. Reported
   * separately because the two are answers to different questions: `usage` is
   * "what has this conversation cost", which is what a running total means, and
   * this is "how much of that was not me", which is what a reader asks when the
   * total is larger than the replies they can see. On MVU it is roughly half.
   *
   * Absent when no card generation has been recorded for this conversation —
   * including every conversation whose file predates the record.
   */
  scriptUsage?: { turns: number, usage: TurnUsage }
  /**
   * The part of {@link usage} that **Iris's own compaction** asked for, and how
   * many summary requests that was.
   *
   * The same relationship to `usage` as {@link scriptUsage}, and a sibling of
   * it rather than a merge: "how much of that was not me" and "how much of that
   * was the host folding my history" have different answers and different
   * remedies. One request per compaction, so a conversation that has never been
   * compacted has none of this — which is most of them, and the reason it is
   * absent rather than a pair of zeros.
   */
  compactionUsage?: { turns: number, usage: TurnUsage }
}

/** A conversation in the sidebar list. */
export interface ChatSummary {
  chatId: string
  title: string
  characterId?: string
  /** Unix epoch milliseconds of the last activity. */
  updatedAt: number
  messageCount: number
  /**
   * The conversation this one was branched from, when it was.
   *
   * Present so a list can group a branch under its parent. Upstream records the
   * same relationship as a chat *name* in `chat_metadata.main_chat`; this is the
   * id, because a name changes when the user renames the parent and a broken
   * link is worse than no link.
   */
  parentChatId?: string
}

/**
 * One floor a search matched, and where it sits.
 *
 * `messageId` is the chat-file line index minus the header — the same number a
 * card script sees and `chat.open`'s views use — so a hit names a floor the
 * reader can act on, not a byte offset into a file.
 */
export interface ChatSearchMatch {
  /** The floor whose text matched. */
  messageId: number
  /** The floor's speaker, so a hit can say who said it. */
  name: string
  /** True when the floor is the user's own line. */
  isUser: boolean
  /** Text clipped around the first match, for a row that shows why it hit. */
  snippet: string
}

/**
 * One conversation a search found, with its floors.
 *
 * The identity fields mirror `ChatSummary` so a list can render a hit the same
 * way it renders a row; a hit without at least one match is never sent.
 */
export interface ChatSearchHit {
  chatId: string
  title: string
  characterId?: string
  /** Unix epoch milliseconds of the last activity, as `ChatSummary` carries it. */
  updatedAt: number
  messageCount: number
  parentChatId?: string
  /** The floors that matched, in file order, at most the requested limit. */
  matches: ChatSearchMatch[]
}

/** A character in the library. */
export interface CharacterSummary {
  characterId: string
  name: string
  /** Endpoint serving the card's avatar, or absent when it has none. */
  avatarUrl?: string
  tags: string[]
  creator?: string
  /**
   * The card file's last modification, Unix epoch milliseconds.
   *
   * A rename or a tag edit touches the file, so this is "when the character
   * last changed" and not "when it arrived" — which is what a sort by
   * recency has to mean to match the user's expectation of it.
   */
  updatedAt?: number
  /** Whether the profile has starred this character. Absent means not starred. */
  favorite?: boolean
  /**
   * The opening of the card's `data.description`, at most 200 **code points**.
   *
   * Three facts a character page shows — this, {@link bookEntryCount} and
   * {@link scriptCount} — are counts and one short string, deliberately, and the
   * deliberation is the same one {@link data} argues below: a whole card costs a
   * median of 494 KiB and up to 2.8 MiB, so nothing here may be a whole
   * anything. A clipped description and two integers cost about as much as the
   * `tags` array beside them.
   *
   * **200 is a clip, and on this corpus it is the normal case, not the edge.**
   * Measured over the 19 local cards: 15 carry an *empty* description (the
   * modern Chinese cards put everything in the world book), and the four that
   * carry one run 730, 779, 1744 and 2851 code points — every one of them
   * clipped. So a reader must not treat this as the description; it is its
   * first paragraph-ish worth. No ellipsis is added: whether the clip is marked
   * is the interface's decision, and a host that added one would put a character
   * in the data that the card never had.
   *
   * Code points rather than UTF-16 units, so the clip never lands between the
   * halves of a surrogate pair and produces a lone surrogate — which survives
   * `structuredClone`, reaches the DOM, and renders as a replacement character
   * for exactly the emoji-bearing cards nobody tests with. Combining marks and
   * ZWJ sequences can still be cut; that costs one glyph, not a broken string.
   *
   * **Absent when the card's description is empty**, which as measured is most
   * of them — so a page must render "no description" as *nothing*, not as a
   * blank line under a heading.
   */
  description?: string
  /**
   * How many entries the card's **embedded** `character_book` holds.
   *
   * The count of the same book {@link data} carries in full for the character
   * being played, so the two cannot disagree — this one is carried for every
   * card because a count is 8 bytes and a book is up to 1.1 MiB. Measured over
   * the local corpus: 17 of 19 cards embed a book, holding 4 to 168 entries.
   *
   * **Absent means the card embeds no book at all; `0` means it embeds an empty
   * one.** Those are different facts about a card — an author who shipped a book
   * and emptied it did something an author who never shipped one did not — and
   * folding them together is a one-way loss. This is the one field here that
   * carries a zero; the others treat zero as absent, for the reason
   * {@link scriptCount} gives.
   *
   * It counts *only* the embedded book. A card's world-info bindings by name
   * (`data.extensions.world`, and what the host resolved them to) are a separate
   * question, deliberately not answered here — see `ScriptContext.charWorldbooks`.
   */
  bookEntryCount?: number
  /**
   * How many script units the card carries, in `extractScripts`' reckoning.
   *
   * The same number `script.list` would return rows for — every script the card
   * declares, including the ones its author shipped switched off, because that
   * is what a user is being told the card *contains*. Deriving it any other way
   * would let a page say "3 scripts" over a panel listing 5: the format stores
   * scripts under two extension keys and in three shapes (see
   * `@iris/script/extract`), and a hand-rolled walk of the obvious one missed 7
   * of 15 cards the first time it was tried. Measured over the local corpus: 14
   * of 19 cards carry at least one script, between 1 and 9 each.
   *
   * **Absent means none.** Zero and unknown are the same sentence to a reader —
   * a page says nothing about scripts either way — and every other optional
   * field on this summary already reads that way (`creator` absent when blank,
   * `favorite` absent when not starred, `avatarUrl` absent when there is no
   * picture). {@link bookEntryCount} is the deliberate exception, and says why.
   *
   * It reports what the card holds, never what the user allowed: consent is per
   * card and lives in `script.list`'s own answer, which a library listing has no
   * business anticipating.
   */
  scriptCount?: number
  /**
   * The card's own data, carried **only for the character being played**.
   *
   * Upstream's `characters[this_chid]` is a whole card, and a card script reads
   * it by index. Measured across the corpus, exactly **one** script reaches into
   * that array for real — the other three `characters[…]` hits are the cards'
   * *own* local objects that happen to share the name — and it reads exactly one
   * path, guarded at every level:
   *
   * ```js
   * charData.data && charData.data.character_book && charData.data.character_book.entries
   * ```
   *
   * So this carries `data.character_book` and nothing else. Whole cards would
   * cost a median of 494 KiB and up to **2.8 MiB** on every snapshot, to deliver
   * a book that is at most 1.1 MiB of that and is the only part anybody reads.
   * The nesting is kept exactly as written above, because the shape is what the
   * card tests — a flattened `character_book` at the top level would fail its
   * first guard and read as "this card has no world info".
   *
   * **Only the current character has it.** Every other entry is a summary, as
   * before. Handing out every card's embedded book would put the whole library's
   * world info in a frame that asked about one conversation.
   */
  data?: { character_book?: unknown }
}

/**
 * Which repository a runnable script came out of.
 *
 * TavernHelper's three repositories, minus the one this host has no place for:
 * `'card'` is `character.data.extensions.tavern_helper.scripts` (what the card
 * shipped), `'global'` is `extension_settings.tavern_helper.script.scripts`
 * (the user's own, running in every conversation), and `'character'` is the
 * user's own kept against one card. Upstream's fourth, `preset`, is absent for
 * the same reason the preset regex tier is: this host's preset library is
 * read-only.
 *
 * **Reported, never inferred.** "Where is this from" is the first question a
 * list of runnable code raises, and until this round the character page
 * answered it with a fixed 「卡内嵌」 — correct while the card was the only
 * source, and a lie the moment it stopped being.
 */
export type ScriptSource = 'card' | 'global' | 'character'

/**
 * One runnable script, as a script list shows it.
 *
 * Carries no `content`. A script body runs in the page, but it reaches the
 * frame through the runner, not through this view: putting 3 MB of webpack
 * output in a list response would make opening a settings pane the most
 * expensive call in the product, and the list exists so the user can see and
 * govern what a card contains.
 */
export interface ScriptView {
  id: string
  name: string
  /**
   * Which repository this row came out of.
   *
   * Required, not defaulted. An optional field read as `'card'` when absent
   * would label the user's own scripts as the card's on any client that had not
   * been updated, which is the one mistake this field exists to prevent — and
   * an absent key would be indistinguishable from a host that genuinely has no
   * library.
   */
  source: ScriptSource
  /** Author's notes, when the card carries them. */
  info?: string
  /**
   * What the card's author shipped it as. Not the user's decision.
   *
   * **Always `true` on a library row** (`source !== 'card'`), and that is a
   * statement rather than a filler: there is no second party to disagree with
   * on a script the user wrote, so the pair collapses and every reader that
   * asks "did the card switch this off" correctly gets no. A `false` here would
   * make `ScriptPanel` hide the toggle on the user's own script.
   */
  enabledByCard: boolean
  /**
   * Whether it will actually run: the card's switch and the user's, combined.
   *
   * Both are reported because they answer different questions — "why is this
   * off" is answered by which of the two is off, and a UI showing only the
   * result leaves the user unable to tell a card's own choice from their own.
   */
  enabled: boolean
  /**
   * The buttons this script asks the panel to show.
   *
   * Upstream's shape, unchanged: `{ name, visible }`, identified **by position**
   * and by nothing else — a button carries no id, no icon and no callback name,
   * so `buttons[i]` is the only handle there is.
   *
   * **Address a button by `(scriptId, index)`, not by its name.** Measured over
   * the corpus: no script has two buttons with the same name, so
   * `(scriptId, name)` happens to be unique *today* — but one card
   * (`性斗学园超级重制版`) has two different scripts each offering a button
   * called `打开状态栏`, so a name alone is already ambiguous, and nothing
   * upstream prevents a single script from repeating one. Position is unique by
   * construction, because position is the only identity the format stores.
   *
   * **`visible: false` is the common case**: 58 of the corpus's 89 buttons.
   * Rendering the whole array shows a pile of controls their authors hid on
   * purpose. `buttonsEnabled` is the author's separate switch for the group.
   *
   * **The card's declaration, overridden by whatever the script has since
   * written** through `script.replaceScriptButtons` —
   * `ScriptContext.scriptButtons` merges identically. The panel's bar and the
   * card-facing snapshot are two views of one fact; building the bar from the
   * declaration alone would leave it showing buttons a script had already
   * replaced, with the card and the UI each correct on their own terms and
   * disagreeing with each other.
   */
  buttons?: { name: string, visible: boolean }[]
  /** Whether the card's author left this script's button group switched on. */
  buttonsEnabled?: boolean
  /**
   * Size of the body in **UTF-8 bytes**, so a list can say what it is about to
   * run.
   *
   * Bytes, not characters: a consent prompt built from a string's `.length`
   * understates a Chinese script body roughly threefold, and this number's whole
   * job is to tell a user how much code they are agreeing to.
   */
  bytes: number
}

/**
 * One message in the shape a card script expects.
 *
 * SillyTavern's own storage shape, field names included, because that is what
 * the 194 `context.chat` accesses measured across the local corpus read: `mes`,
 * `is_user`, `swipes`. Renaming these to Iris's own vocabulary would move the
 * translation into the browser bridge, where it becomes a second table that can
 * drift from this one — and the bridge's whole job is to be a pass-through.
 *
 * Structurally identical to `@iris/persistence`'s `SillyTavernMessage`, and the
 * index signature makes the two assignable without a cast. Declared here rather
 * than imported so the contract package keeps its one dependency.
 */
export interface ScriptChatMessage {
  name: string
  is_user: boolean
  is_system?: boolean
  send_date?: string
  mes: string
  extra?: Record<string, unknown>
  swipes?: string[]
  swipe_id?: number
  /**
   * This floor's per-swipe variable tables, **as JSON text**.
   *
   * A string, not an array of objects, and the reason is transport rather than
   * taste: structured clone costs per object rather than per byte, so carrying
   * the tables as trees made them 45% of the snapshot's bytes and roughly 91%
   * of its clone time. As text the whole `chat` array clones in a fifth of the
   * time; a reader parses the one floor it wants, which measured at 0.83 ms for
   * the largest table in the longest corpus chat and 0.00 ms at the median.
   *
   * Parse it to read it: `JSON.parse(line.variables)[line.swipe_id ?? 0]`. The
   * value is the same array the chat file holds — only its encoding differs,
   * and only in transit.
   */
  variables?: string
  [key: string]: unknown
}

/**
 * What a card script sees when it reads `SillyTavern.getContext()`.
 *
 * Deliberately narrow. SillyTavern's own context object exposes 145 keys; the
 * 19 here are the ones the local corpus's 47 scripts actually touch, found by
 * intersecting what the scripts read against the real key list rather than by
 * transcribing documentation. Anything absent is absent on purpose: a surface
 * built to the documentation would be seven times larger, and every extra
 * member is something a card can come to depend on.
 *
 * Field names are SillyTavern's for the same reason as {@link ScriptChatMessage}.
 */
export interface ScriptContext {
  /** The conversation, in storage order. 194 accesses — the largest single one. */
  chat: ScriptChatMessage[]
  /**
   * Per-chat storage, read AND written: cards use it as their durable store
   * (`meta.someKey[k] = v`, then save). 28 accesses.
   */
  chatMetadata: Record<string, unknown>
  /** The user's name, as the chat file records it. */
  name1: string
  /** The character's name. */
  name2: string
  characterId?: string
  chatId?: string
  /**
   * The library, for a card that offers to switch or reference another.
   *
   * Whole summaries, so this carries the three content facts a summary
   * carries — a clipped `description` and the two counts. Measured on the
   * 19-card corpus, they add 2003 bytes of JSON to a 4026-byte list (1.96 KiB),
   * and they are strictly *less* than upstream hands a card here, which is the
   * whole `characters` array with every card's full description in it.
   */
  characters: CharacterSummary[]
  /**
   * This card's extension settings, partitioned per card.
   *
   * One card must not read another's: cross-card reads would defeat the
   * per-card grant model, since a card could learn — and store — through a
   * neighbour what it was not itself allowed.
   *
   * **This answers a narrower question than upstream's field of the same name,
   * and the difference is deliberate.** SillyTavern's `extension_settings` is
   * one installation-wide bag every extension and card shares. Measured across
   * 121 sources, cards mostly do not use it as storage at all: of 20 sites in 3
   * cards, 19 are **reads probing whether some other extension is present**
   * (`extension_settings['st-chatu8']`, `.EjsTemplate.enabled`) and one is a
   * card writing its own namespace. So the common use is detection.
   *
   * A partition serves detection *correctly*: a key belonging to an extension
   * this host does not have is absent, which is the true answer, and a
   * neighbouring card cannot make it look present. It also serves a card's own
   * namespace, which is the only write shape measured.
   *
   * What it does not serve: a card writing a **foreign** extension's key in
   * order to configure that extension installation-wide. Upstream would apply
   * that globally; here it stays in the card's own partition and affects
   * nobody. No corpus card does this, and the scope of that negative is 19
   * cards plus one sample — card 20 is under no obligation.
   *
   * The trap to avoid is aliasing this to any populated installation-wide
   * store. The field would keep its name, keep type-checking, and start
   * answering "is this extension installed" with unrelated data — wrong in a
   * way nothing reports. `tests/extension-settings-shapes.test.ts` pins all
   * three measured shapes.
   */
  extensionSettings: Record<string, unknown>
  /** Current variable state, for a card reading MVU's store. */
  variables: Record<string, unknown>
  /**
   * The world books this card is bound to, by name.
   *
   * Names, never contents — upstream's `getCharWorldbookNames` returns names and
   * makes the caller fetch a book separately, so listing them costs nothing.
   *
   * **`primary` is the binding, not the book in use.** It is
   * `data.extensions.world` as the card declares it, reported even when no file
   * of that name exists (2 of 18 corpus bindings are dangling). The host may
   * well be assembling prompts from the card's *embedded* book instead — see
   * `resolveCardWorldbook`'s fallback — but reporting what we chose rather than
   * what the card declares would answer a different question than the one
   * upstream's member asks.
   *
   * The card's own embedded `character_book` is a separate body of entries and
   * is deliberately not reported here; upstream's member does not report it
   * either.
   */
  charWorldbooks?: { primary: string | null, additional: string[] }
  /**
   * Every world book the host knows, by name.
   *
   * The synchronous source for TavernHelper's `getWorldbookNames()`, which
   * upstream answers with `klona(world_names)` — no promise. A book the host
   * seeded from a card's embedded copy is a real book upstream (it lives in
   * ST's `world_names` the moment it is written), so it has to be a real name
   * here: a card that names its own book in an existence assertion must find it.
   *
   * Names only, and refreshed with the snapshot like `charWorldbooks` beside
   * which it sits — the same freshness argument, and the same "names cost
   * nothing" shape. `getChatWorldbookName()` applies the same list as the
   * existence guard on `chat_metadata.world_info`, exactly as upstream's
   * `getChatLorebook` honours the key only while `world_names` holds it.
   */
  worldbookNames?: string[]
  /**
   * Each script's buttons, by script id — **unfiltered**.
   *
   * `getScriptButtons()` is synchronous upstream
   * (`JS-Slash-Runner/src/function/script.ts:58`), so it has to be answerable
   * from this snapshot rather than over the wire.
   *
   * **Every button, including the hidden ones.** `visible: false` means "do not
   * render", not "does not exist" — 58 of the corpus's 89 buttons are hidden,
   * and a script flipping one to `true` is how it makes a button appear. A
   * surface that filtered here would make that impossible and would look
   * correct: the panel shows the right buttons, and the script simply cannot
   * find the one it wants to reveal.
   *
   * **What it carries is the card's declaration overridden by whatever the
   * script has since written** — not the declaration alone. That distinction
   * used to be wrong in this very comment: the field merged from the moment
   * `replaceScriptButtons` existed, while the words still said "declared". A
   * contract's prose has to hold up the semantics, or the next reader builds
   * against the sentence.
   *
   * `ScriptView.buttons` merges the same way, so the panel's bar and this
   * snapshot are two views of one fact rather than two sources that can
   * disagree.
   *
   * The script-level `buttonsEnabled` switch and the panel's own rendering
   * rules are separate layers that live where the rendering happens; this is the
   * data layer.
   */
  scriptButtons?: Record<string, { name: string, visible: boolean }[]>
  /**
   * World-info settings, for TavernHelper's `getLorebookSettings()`.
   *
   * Carried in the snapshot rather than fetched, because that member is
   * **synchronous**: MVU calls it both with and without `await`, and both work
   * only while the value is already in hand. Backing it with a request would
   * break the call site that does not await.
   *
   * Sixteen fields, and two of the names mislead — `max_depth` is the ceiling
   * for *minimum activations*, not the scan depth, and `context_percentage` is
   * a percentage while `budget_cap` is the byte count. Copied as-is, because a
   * card reads them by name.
   */
  lorebookSettings?: LorebookSettings
  /**
   * The card storage shared across this profile, as key to value.
   *
   * Flat and string-valued, matching `localStorage`. Provenance — which card
   * wrote a key last — is kept by the host and deliberately not shipped here: a
   * frame has no use for it, and the snapshot is already the expensive part of
   * every turn.
   */
  storage?: Record<string, string>
  /**
   * The layers `getAllVariables` merges, each unmerged and labelled by source.
   *
   * Upstream's `_getAllVariables` (`JS-Slash-Runner/src/function/variables.ts`)
   * shallow-assigns in a fixed order, and for a **script** frame that order is
   * `global → character → script → chat`, later winning. Floor tables are folded
   * in only for a *message* frame — measured by d7 — which is why they are absent
   * here and why this carries no per-floor data at all.
   *
   * Sent unmerged on purpose. The merge is one `_.assign` chain that the façade
   * can do, while the reverse is impossible: a card calling
   * `getVariables({type: 'chat'})` needs that layer alone, and a pre-merged tree
   * cannot be taken apart again.
   */
  /**
   * The floor a message frame is rendered in, and that floor's own variables.
   *
   * Present only when `script.context` was asked for a `messageId`; a script
   * frame has no floor. `variables` here is **that floor's own layer** and does
   * not inherit from earlier floors — upstream reads
   * `chat_message.variables[swipe_id] ?? {}` with no walk backwards, so a floor
   * that wrote nothing reports an empty table rather than the newest state it
   * could reach. Inheriting would make the anchoring decorative.
   *
   * It follows the **selected** swipe, `variables` being an array parallel to
   * `swipes`.
   */
  floor?: {
    /** The chat-file line index — what `getCurrentMessageId()` should answer. */
    messageId: number
    /** That floor's own layer, empty when it has none. */
    variables: Record<string, unknown>
  }
  variableLayers: {
    /** Installation-wide. Upstream's `extension_settings.variables.global`. */
    global: Record<string, unknown>
    /** The card's own, from its `tavern_helper.variables`. */
    character: Record<string, unknown>
    /**
     * Per script, keyed by script id.
     *
     * All of the card's partitions rather than one, because this context is
     * fetched per card while the scope is per script — the façade knows which
     * script it is running and picks its own. One script must not read
     * another's, so the façade selecting is the enforcement point.
     */
    script: Record<string, Record<string, unknown>>
    /** This conversation's, from `chat_metadata.variables`. */
    chat: Record<string, unknown>
  }
  // —— family②: regex ——
  /**
   * Whether **this chat's card** may run its own regex tier.
   *
   * Upstream's `isCharacterTavernRegexesEnabled()` is *synchronous*
   * (`function/tavern_regex.ts:196`) and reads
   * `extension_settings.character_allowed_regex.includes(characters[this_chid].avatar)`
   * — a membership test over the character being played, not over whichever
   * card's script is asking. So it rides the snapshot rather than the wire, and
   * it is the chat's own card that is reported, exactly as
   * {@link ScriptContext.charWorldbooks} is.
   *
   * One boolean, which is why this tier's *gate* can ride the snapshot while
   * the tier's *rules* cannot: measured over the ST corpus, 15 of 19 cards
   * carry a scoped tier weighing a median of 131.7 KiB and up to 1.04 MiB, and
   * this snapshot is inlined into every frame's `srcdoc` uncached (host ledger
   * §64).
   *
   * **Absent means allowed**, matching `ScriptPolicyStore.scopedRegex`'s
   * `!== false` — the host default this project deliberately diverges to (§30).
   * A host running without a policy store leaves it absent, and a reader that
   * read absent as refused would report a tier as off on a host that runs it.
   */
  characterRegexAllowed?: boolean

  // —— family①: identity & messages ——
  /**
   * The profile's personas, **names and ids only**.
   *
   * Six of upstream's persona members are synchronous
   * (`JS-Slash-Runner/src/function/persona.ts:53,60,67,74,302,310` — every one
   * reads `power_user.personas` off the page and returns), so four of them
   * (`getPersonaNames`, `getPersonaIds`, `getCurrentPersonaName`,
   * `getCurrentPersonaId`) can only be answered from a snapshot. A name and an
   * id is what those four need, and it is all they get here.
   *
   * **Key absent and empty list are different facts, and both happen.** A host
   * with no persona store configured (`service.ts`'s `#personas()` refuses with
   * `unsupported`) omits the key; a profile that has a store and no personas
   * sends `[]`. The façade reports the first as a gap and answers the second
   * with upstream's own answer for an empty list, because a default applied to
   * a missing key manufactures a clean zero that reads as a measurement.
   */
  personas?: { id: string, name: string }[]
  /**
   * The persona **in use**, in full — the only one whose content travels.
   *
   * `getPersona(id)` is synchronous upstream too and returns the whole
   * descriptor, so serving it at all means carrying content. Carrying *every*
   * persona's would hand a card the user's other alter egos' prompt text for no
   * measured demand (zero corpus calls), so the snapshot carries one: the
   * persona this conversation is being played with, which is already part of
   * what the card is being told about. `getPersona` on any other id throws and
   * says which narrowing refused it.
   *
   * Absent means no persona is in use — which is a real state here, since a
   * persona with an empty description counts as none (`persona.ts:263,290`).
   */
  persona?: PersonaView
  /**
   * Each runnable script's name and author note, by script id.
   *
   * `getScriptName()` and `getScriptInfo()` are synchronous upstream
   * (`function/script.ts:125,134`, both `useScriptIframeRuntimesStore().get(id)`
   * off the page) and both answer about **the calling script**, which the frame
   * knows by its own `scriptId`. Keyed by id like `scriptButtons` beside it, and
   * carrying every script of the card for the same reason that field does: one
   * snapshot serves a card whose scripts share a realm.
   *
   * `info` is absent when the script carries no author note — `ScriptView.info`
   * is already optional in exactly that way, and this is that field.
   */
  scripts?: Record<string, { name: string, info?: string }>
  // —— family③: preset ——
  /**
   * The preset half of the snapshot, for the three **synchronous** preset
   * members.
   *
   * `getPreset`, `getPresetNames` and `getLoadedPresetName` all return values
   * upstream, not promises (`@types/function/preset.d.ts:180`, `:150`, `:161`),
   * and the corpus's one real consumer reads
   * `TavernHelper.getPreset('in_use').prompts` with no `await` anywhere on the
   * path. So a faithful answer has to be in the frame's hands before a card
   * asks, which is what riding this snapshot means.
   *
   * **Why the snapshot and not a channel of its own.** The in-use preset is
   * host state rather than chat state, so its own push looked right — but a
   * preset switch already reaches every live frame through this field:
   * `#applyPreset` ends in `#refreshRegex`, which re-announces every open chat,
   * which is a `chat.updated` the shell's `watchContext` answers by refetching
   * the snapshot. A second channel would have been a second freshness rule for
   * the same fact.
   *
   * Absent on a host that keeps no preset library, which is a different thing
   * from a host whose library is empty — see {@link ScriptContext.preset.names}.
   */
  preset?: {
    /**
     * The library name the running body was loaded from, for
     * `getLoadedPresetName()`.
     *
     * Absent when the running body has **no** library name: `preset.delete` of
     * the active preset leaves the body live and nameless on purpose, and so
     * does a host composed with a preset but no `presetName`. Upstream's member
     * always returns a string, so the frame answers `''` for this state and
     * reports it once — a fabricated name would be a name `getPreset` then
     * throws on.
     */
    loaded?: string
    /**
     * Every name `getPresetNames()` answers with, `'in_use'` first.
     *
     * `'in_use'` is included because upstream includes it
     * (`preset.ts:571-573`), and it is first for the same reason: a card
     * reading `names[0]` gets the running preset upstream and must get it here.
     */
    names: string[]
    /**
     * The running preset as a card sees it, **as JSON text**.
     *
     * Text, parsed by `getPreset` on the call rather than here, for two reasons
     * that point the same way. Upstream's `getPreset` returns `klona(...)` — a
     * fresh object per call — so a card that mutates the result and hands it to
     * `replacePreset` must not have been editing the frame's own copy; parsing
     * per call *is* that clone. And a string crosses the frame boundary for a
     * fraction of an object's cost: measured 2026-09-10 on the heaviest real
     * preset, `structuredClone` of the prompt graph is 0.481 ms against
     * 0.252 ms for the same data as text, and a frame that never calls
     * `getPreset` pays the parse (0.304 ms) never. The same trick, for the same
     * reason, as `restoreFloorTables`' per-row getter.
     *
     * Absent when the body could not be offered — see
     * {@link ScriptContext.preset.refusal}.
     */
    inUse?: string
    /**
     * Why `inUse` is absent, in a sentence `getPreset` can throw with.
     *
     * Upstream throws for a preset it cannot resolve (`preset.ts:588-594`), so
     * a card's `try`/`catch` already handles a throw here; what it cannot
     * handle is silence. Present exactly when `inUse` is absent, so the frame
     * never has to decide which of the two states it is looking at.
     */
    refusal?: string
  }
  // —— family③ end ——
}

/** Where a script's injected prompt goes. Mirrors upstream's positions. */
/**
 * Where a script's injection goes.
 *
 * `'none'` is upstream's `NONE: -1` — **registered but never assembled**. No
 * call site of `getExtensionPrompt` ever queries that position, so such an
 * injection holds its key (to be overwritten or removed) and contributes no
 * text. That is a third state, distinct from both "assembled" and "absent".
 */
export type ScriptPromptPosition = 'before' | 'after' | 'at-depth' | 'none'

/** One part of an assembled prompt, and what it cost. */
export interface PromptItemEntry {
  /**
   * The contribution's stable id.
   *
   * Machine-facing, and frequently a UUID: measured over a real preset, 29 of
   * its 41 prompts identify themselves that way. Which is exactly why this is
   * not the thing to render.
   */
  id: string
  /**
   * What to show a person.
   *
   * The preset's own `name` (`"写作模式（二选一）"`), or the identifier for a
   * built-in. The same string SillyTavern's own UI displays, so a user who
   * imported the preset recognises the row.
   *
   * Both this and {@link id} are carried because neither alone is enough: ids
   * are unreadable, and real presets reuse names across different prompts.
   */
  label: string
  kind: 'system' | 'depth' | 'history'
  tokens: number
  /** For a depth injection, how many messages from the end it sits. */
  depth?: number
  role?: ViewRole
  /**
   * True when {@link GenerationSettings.cacheFriendly} moved this section out
   * of the system prompt and into the volatile segment after the conversation.
   *
   * The row keeps its place in {@link PromptItemization.entries} — that list is
   * contribution order, which is the order the preset and the card asked for —
   * so a surface can say both things at once: where the user put it, and that
   * it is not being sent from there. A surface showing *assembly* order sorts
   * the flagged rows to the end itself.
   */
  deferred?: boolean
  /**
   * True when {@link GenerationSettings.cacheFriendly} moved this depth
   * injection *forward*, out of the conversation and into the stable prefix.
   *
   * The mirror of {@link deferred}, and the direction with the larger effect
   * and the larger semantic cost: a depth injection is written to sit a fixed
   * number of floors from the end, and a promoted one arrives before the
   * transcript instead. The row is the only place a person can see that.
   */
  promoted?: boolean
  /**
   * The parts this row is the join of, when the reorder placed them separately.
   *
   * A world-info **depth bucket** is upstream's newline join of every entry
   * that landed on one depth and role, and it is routinely the largest row in
   * this list. With {@link GenerationSettings.cacheFriendly} on the entries are
   * classified one by one, because the bucket's own text moves whenever its
   * *membership* does while the entries in it hold still — so two entries can
   * reach the prefix while a third stays at depth 0.
   *
   * When that happens the row above carries **neither** {@link deferred} nor
   * {@link promoted}: no single mark is true of it any more, and one invented
   * for it would tell a reader their whole world-info block moved. The marks
   * are on these sub-rows instead, and the row keeps them only when every
   * member went the same way.
   *
   * Absent when the host did not split this row — with the setting off, always.
   */
  members?: PromptItemMember[]
}

/** One entry inside a split prompt row, and what it cost. */
export interface PromptItemMember {
  /**
   * The member's stable id.
   *
   * `<row id>#<book>.<uid>` for a world-info entry. Machine-facing, and the
   * same id the divergence report names the entry by, so a surface can line the
   * two up on one row.
   */
  id: string
  /** What to show a person — the entry's own `comment`, or its book and uid. */
  label: string
  tokens: number
  /** True when the reorder sent this member after the conversation. */
  deferred?: boolean
  /** True when the reorder sent this member ahead of the conversation. */
  promoted?: boolean
}

/**
 * Where an assembled prompt's tokens went.
 *
 * The feature exists because the answer is routinely surprising. Measured on a
 * real preset and card: of 2929 prompt tokens, **1920 — 66% — were a single
 * world-info depth injection**. Nothing else in the product can show that.
 */
export interface PromptItemization {
  turn: number
  entries: PromptItemEntry[]
  /** Sum of the entries. */
  tokens: number
  /**
   * What the provider reported this prompt actually cost, when it has.
   *
   * Shown beside {@link tokens} so a user can see whether the estimate is
   * trustworthy. Absent in preview, and absent for a turn whose provider
   * reported no usage.
   */
  actualTokens?: number
  /**
   * Tokens of the request's leading run that carries no volatile part — the
   * most a prefix cache could serve on the next turn.
   *
   * The reading the cache-friendly reorder exists to move, so it is the reading
   * that says whether it worked. Against {@link tokens} it is a share: 95% means
   * a next turn that changes only its newest floors can be served from the
   * cache down to those floors, and 22% means something near the front of the
   * request changes every turn (a `{{roll}}` in a world-info entry, measured).
   *
   * An estimate of a **ceiling**, on the assumption that existing floors are
   * not rewritten and the budget does not start trimming from the front —
   * {@link droppedHistory} beside it is the second of those. Absent when the
   * host did not compute one; a surface must not read absence as zero.
   */
  stablePrefixTokens?: number
  /**
   * The window this assembly ran against and what it held back for the reply —
   * the same two figures, resolved the same way, that {@link ChatBudget}
   * carries, which says why `reserve` is the request's own `max_tokens`.
   *
   * Restated inline rather than reusing `ChatBudget` because an itemization is
   * a *record of one request* and must not gain the window-provenance fields:
   * those are resolved per read, so a stored copy of them would age.
   */
  budget: { context: number, reserve: number }
  /** History entries dropped to make the request fit. */
  droppedHistory: number
  overBudget: boolean
  /**
   * True when this is how the NEXT request would assemble, rather than a record
   * of one already sent.
   *
   * A record lives only as long as the host holds the chat open, so a UI asking
   * for an old turn can get a preview instead. Say so rather than showing
   * nothing: "the record for this turn was lost when the chat closed; here is
   * how it would assemble now" is useful, and a blank panel is not.
   */
  preview: boolean
}

/** What happened to one assembly part between two requests. */
export type DivergenceState = 'same' | 'changed' | 'added' | 'gone'

/**
 * What a conversation floor's part id begins with, the floor number following.
 *
 * In the shared vocabulary rather than in either end, because both ends need it
 * and for opposite reasons: the host mints these ids and the interface has to
 * recognise them to print a floor number instead of `history.6`. Two constants
 * spelled the same in two packages is the shape where one of them changes.
 */
export const HISTORY_ITEM_PREFIX = 'history.'

/** One assembly part, compared across two requests. */
export interface PromptDivergenceItem {
  /** The part's stable id: a contribution's, or `history.N` for a floor. */
  id: string
  /** What to show a person; the id when there is nothing better. */
  label: string
  kind: 'system' | 'depth' | 'history' | 'tail'
  role?: ViewRole
  state: DivergenceState
  /** Bytes it occupies in the newer body; `0` when it is `gone`. */
  bytes: number
  /** Bytes it occupied in the older body; `0` when it is `added`. */
  previousBytes: number
  /**
   * Bytes of it that fall after the divergence point, and so cannot be served
   * from cache however unchanged they are.
   *
   * This is the figure that makes depth injection legible. A world-info block
   * anchored at depth 0 is byte-identical every turn and sits *after* the newest
   * floor, so every byte of it is re-billed every turn — `state: 'same'` with
   * `uncachedBytes` equal to `bytes` is exactly that shape, and it is invisible
   * in any account that only asks what changed.
   */
  uncachedBytes: number
}

/**
 * Where two adjacent requests of one conversation stopped being the same bytes.
 *
 * DeepSeek's context cache matches the request **prefix** in 64-token blocks, so
 * the first differing byte decides everything after it: a turn that diverges at
 * 20% of the body can be served at most 20% from cache no matter how much of the
 * remaining 80% it sent verbatim last turn. This view is that measurement, taken
 * on the bodies actually sent rather than on a replay.
 *
 * **Bytes, and no percentages.** Every figure here is a byte count, because
 * bytes are the unit the comparison is exact in; a share is a division two
 * readers can disagree about (the newer body or the older one as the
 * denominator) and is left to whoever renders it, so the ratio is chosen once,
 * visibly, in one place rather than baked in here.
 */
export interface PromptDivergence {
  /** The chat both requests belong to. */
  chatId: string
  /** The newer request's sequence number in this chat's trace. */
  seq: number
  /** The older one's. */
  previousSeq: number
  /** When the newer request went out; Unix epoch milliseconds. */
  at: number
  /** When the older one did. */
  previousAt: number
  /**
   * What each request was: `send`, `regenerate`, `continue`, `impersonate`, or
   * one of the card-initiated kinds.
   *
   * Carried because the two requests need not be the same kind of thing, and
   * "the prompt grew by 3 000 tokens" reads very differently for two swipes of
   * one turn than for two consecutive turns.
   */
  kind: string
  previousKind: string
  /**
   * Where each request went.
   *
   * Carried as fields rather than folded into the bytes, and that is a
   * correction: the canonical body used to open with the route, so the prefix
   * hash moved whenever a model was switched and a switch read as "the prompt
   * head changed". A cache lives on one model, so a route change is a complete
   * and sufficient explanation for a miss — but it is a *different* explanation
   * from a prompt change, and the two must not arrive as one number.
   */
  model: string
  previousModel: string
  provider: string
  previousProvider: string
  /** Byte length of the newer canonical body. */
  bytes: number
  /** Byte length of the older one. */
  previousBytes: number
  /**
   * The first byte at which the two bodies differ.
   *
   * Equal to the shorter body's length when one is a prefix of the other, and
   * equal to {@link bytes} when they are byte-identical — which is what two
   * swipes of an unchanged conversation should produce and, measured, do not.
   */
  divergedAt: number
  /** The part the divergence lands in, or absent when it lands in JSON framing. */
  divergedIn?: { id: string, label: string, kind: PromptDivergenceItem['kind'] }
  /** `bytes - divergedAt`: what this request must pay full price for. */
  uncacheableBytes: number
  /** Of {@link uncacheableBytes}: parts no earlier request carried. */
  addedBytes: number
  /** Of {@link uncacheableBytes}: parts that were there and now read differently. */
  changedBytes: number
  /**
   * Of {@link uncacheableBytes}: parts whose bytes are identical to last time
   * and still cannot be served, because they sit after the divergence.
   *
   * The one number that says whether a conversation's cost is a content problem
   * or a *placement* problem. Nothing can be done about `addedBytes` — a new
   * floor is new text — but a large `repeatedBytes` is text being re-billed for
   * where it sits.
   */
  repeatedBytes: number
  /**
   * Of {@link uncacheableBytes}: JSON framing and role names, which belong to
   * no part.
   *
   * Reported rather than swallowed so the four terms add up to
   * {@link uncacheableBytes} exactly. An account that came within a few hundred
   * bytes of its own total invites the reader to assume the rest is rounding,
   * and there is no rounding here.
   */
  structureBytes: number
  /** Every part, compared; ordered as the newer body lays them out. */
  items: PromptDivergenceItem[]
  /**
   * What the provider said it served from cache for the newer request, when it
   * said anything.
   *
   * Placed beside the byte measurement deliberately, and **the two are in
   * different units**: this is tokens as the provider counts them, while
   * {@link divergedAt} is bytes as this host wrote them, and the bytes-per-token
   * ratio of CJK text is not the ratio of the JSON framing around it. So the two
   * shares are comparable in *magnitude* and not in the last digit. A share far
   * below the byte ceiling is the finding — it means the prefix was identical
   * and the provider still did not serve it, which is a provider-side fact and
   * the only thing that can explain a turn reporting zero on an unchanged
   * prefix.
   */
  cacheReadTokens?: number
  /** Prompt tokens the provider charged in full, when it reported them. */
  inputTokens?: number
  /**
   * What surfaced in the report panel when the newer request's reply did not
   * complete, verbatim.
   *
   * Present together with absent usage fields — never zero, just absent — because
   * a reply that never finished was never billed, and zero would read as a free
   * turn to a reader comparing adjacent sequence numbers. It is the one fact that
   * distinguishes "the provider served nothing and I do not know why" from "the
   * provider never got to say", which is the same line the {@link providerExcuse}
   * `interrupted` answer draws.
   */
  error?: string
  /**
   * False when the byte offsets could not be attributed to parts with
   * certainty, and why.
   *
   * A card template that rewrote a slot after the assembly recorded it, or a
   * request composed outside the assembler, leaves the offsets sound and the
   * *attribution* unsound. Saying so is the difference between a reader
   * distrusting one line and distrusting the instrument.
   */
  attributed: boolean
  /** Present when {@link attributed} is false: what could not be mapped. */
  attributionNote?: string
}

/**
 * How long a gap between two requests puts a provider's cache out of reach.
 *
 * DeepSeek documents a lifetime of "hours to days" and commits to nothing
 * narrower, so this is a **reporting** threshold rather than a measurement: half
 * an hour is short enough that a shortfall inside it is worth asking about, and
 * long enough that a normal back-and-forth never trips it. Here rather than in
 * either consumer because the interface and the offline report must draw the
 * same line — two thresholds spelled the same in two places is the shape where
 * one of them moves.
 */
export const CACHE_STALE_MS = 30 * 60 * 1000

/**
 * Why a provider might legitimately have served nothing.
 *
 * Not "why it did" — nothing on this side can see the provider's. These are the
 * conditions under which a shortfall is **expected**, so a reader is not sent
 * looking for a prompt defect that is not there:
 *
 * - `cold-start`: DeepSeek stores a prefix only once it has seen it twice, so
 *   the first two requests of a conversation cannot hit however identical they
 *   are. The first recorded turn of `爱衣` reported `0`, and this is the whole
 *   explanation of it.
 * - `stale`: the gap exceeds {@link CACHE_STALE_MS}, so the entry may be gone.
 * - `route`: the two requests went to different models. A cache lives on one
 *   model, so this is sufficient on its own — and it is the reason the route was
 *   moved out of the prompt hash, because a switch used to read as the prompt's
 *   head changing.
 * - `interrupted`: the newer request's reply never completed — the provider
 *   closed the connection mid-stream, or never answered within budget. There is
 *   no shortfall to explain: usage was never reported because the request was
 *   never served, and a reader hunting a prompt defect would be hunting the one
 *   thing that did not happen.
 *
 * Checked before any shortfall is reported, and the ordering is the point: four
 * ordinary conditions each produce a miss on an identical prompt, and reporting
 * those as findings spends a reader's attention on false alarms.
 * @param divergence - the comparison.
 * @returns the condition, or null when none applies.
 */
export function providerExcuse(divergence: PromptDivergence): 'cold-start' | 'stale' | 'route' | 'interrupted' | null {
  // Checked first: an interrupted reply is not a miss to explain, it is a
  // request that never got an answer — and every other check below reads fields
  // that were never reported for it.
  if (divergence.error !== undefined) return 'interrupted'
  if (divergence.model !== divergence.previousModel || divergence.provider !== divergence.previousProvider) {
    return 'route'
  }
  // `seq` counts recorded requests of this conversation from zero, so `1` is the
  // second one — the last that cannot have a stored prefix to match.
  if (divergence.seq <= 1) return 'cold-start'
  if (divergence.at - divergence.previousAt > CACHE_STALE_MS) return 'stale'
  return null
}

/**
 * One saved connection: an endpoint, a model and a preset, switched together.
 *
 * Upstream stores a display name generated once at creation, from the values as
 * they were then. Measured on the user's own install, the profile they have
 * selected is called `deepseek deepseek-chat - Default` and points at a Gemini
 * model, a different endpoint and a different preset — the name was true when it
 * was written and has been wrong ever since.
 *
 * So there is no stored name here. {@link label} is the user's own words, which
 * cannot go stale, and {@link summary} is derived on every read. Disagreement
 * between a profile's name and its contents is not prevented by discipline; it
 * is unrepresentable.
 */
export interface ConnectionProfile {
  id: string
  /** What the user called it. Absent means they never named it. */
  label?: string
  /** Derived from the current values on every read, never stored. */
  summary: string
  /** Which registered adapter route to generate through. */
  provider: string
  model: string
  /** Preset file to assemble with, by name. */
  preset?: string
  /** Sampling overrides applied when this profile is activated. */
  sampling?: Partial<GenerationSettings>
  /**
   * The endpoint this profile generates through, when it carries one of its
   * own. Absent means the profile rides the host's configured route as it was
   * before profiles carried endpoints — those still work exactly as they did.
   */
  baseURL?: string
  /**
   * Whether a key is stored for this profile. **The key itself is never on
   * the wire** — a read answers with this flag and, when the key is long
   * enough not to be given away by it, its last four characters, so the user
   * can tell which key of theirs this is without the interface ever holding
   * one to show.
   */
  hasKey?: boolean
  /** The stored key's last four characters, when there is a key and it is long enough to show them. */
  keyTail?: string
  /** The header the key is sent in, when not the OpenAI-compatible default. */
  apiKeyHeader?: string
  /**
   * The model ids the last successful probe of **this profile's** endpoint
   * reported, so a picker has a list without the user opening the connection
   * form and probing again.
   *
   * This is the one thing stored here that was not typed by the user, and it is
   * allowed for a reason the rest of this type forbids: it is not *derived from*
   * the profile's other fields — it is a **record of an observation**, and it
   * ships with {@link modelsProbedAt} so it can never pass itself off as
   * current truth. (The rule this type is built around is that a *description*
   * of the profile must be computed on every read; a measurement with a
   * timestamp is the opposite case — recomputing it would mean putting a
   * request on the network for every list read.)
   *
   * Absent means no probe of this endpoint has ever succeeded. An empty array
   * means one did and the endpoint advertised nothing — a different fact, and
   * the picker says so differently.
   */
  models?: string[]
  /** Unix epoch milliseconds of the probe {@link models} came from. */
  modelsProbedAt?: number
  /**
   * What is known about the context window of the ids in {@link models}, keyed
   * by id.
   *
   * **Sparse on purpose.** Most endpoints annotate some rows and not others —
   * vLLM leaves `max_model_len` null on its LoRA adapters, OpenRouter documents
   * both its context fields as nullable — and the built-in table answers for
   * some ids and not others. A missing key means "nothing knows this one",
   * which is a different fact from a window of zero and is why this is a record
   * rather than an array parallel to {@link models}.
   *
   * Each entry says whether the endpoint reported it or the host's table did
   * ({@link ModelContextLength}). A `'table'` entry is not an observation of
   * this endpoint at all, which is why it does not travel under
   * {@link modelsProbedAt}'s timestamp in the reader's mind — the source field
   * is what keeps the two kinds apart.
   */
  modelContexts?: Record<string, ModelContextLength>
}

/**
 * Where the key a `connection.test` probe actually sent came from.
 *
 * The form's problem this answers: an API key is shown once by most providers,
 * so a probe that demands a re-typed key on every attempt is a probe the user
 * cannot run twice. The host therefore falls back to what it already holds —
 * and then has to say **which** key it used, because "it worked" means three
 * different things depending on the answer, and only one of them ("typed") is
 * a verdict on what is currently in the form.
 *
 * `'none'` is not a failure: a local serve (Ollama, llama.cpp, LM Studio) is
 * reached with no credential at all, and that is worth saying rather than
 * leaving the field absent to be read as "unknown".
 */
export type ConnectionKeySource =
  /** The key came from the request — what the user has just typed in the form. */
  | 'typed'
  /** The key came from a saved profile's own store; the browser never held it. */
  | 'stored'
  /** The key came from the host's environment (the startup credential). */
  | 'host'
  /** No key was sent, because none was available or none is needed. */
  | 'none'

/**
 * The credential the host process holds from its environment, and where it
 * points — **not a connection a user can choose.**
 *
 * This used to be a row in the provider list: the connection the process was
 * launched with (`IRIS_BASE_URL` / `IRIS_MODEL` / `IRIS_API_KEY_ENV`), read-only,
 * testable, and — since web §78 — selectable. The user's ruling of 2026-09-10
 * retires that idea: 「宿主环境这个功能废弃了，以后都从在 Iris 中自己添加供应商来调用
 * 模型」. A generation now needs a saved provider in use, the environment
 * configuration is imported into the provider list once at first start (host
 * §61), and nothing in the interface offers the environment as a route.
 *
 * What survives is the one fact the *provider editor* still needs: the process
 * holds a credential for a particular origin, so a provider saved with a blank
 * key at that origin generates and probes anyway (host §58's ladder, which is
 * now a fallback rather than a route). Every field describing the environment
 * as a *connection* — its provider, its model, and the model list a probe of it
 * reported — is gone, because nothing reads them any more and a field nobody
 * reads is a claim nobody checks.
 *
 * The name is older than this shape. It is kept because renaming it touches the
 * wire field, the store and the panel for no reader-visible gain; host §61
 * records the debt.
 */
export interface HostDefaultConnection {
  /**
   * The endpoint the credential belongs to, when the host was told one.
   *
   * Compared by *origin* against a provider's own endpoint — both sides of
   * that comparison exist so a form can say "the key you left blank comes from
   * the environment", and for nothing else.
   */
  baseURL?: string
  /** Whether the host holds a credential for it. **Never the credential.** */
  keySource: 'env' | 'none'
  /**
   * The environment variable the key is read from, named so a user who wants
   * to change it knows where to look. The variable's *name*, never its value.
   */
  keyEnv?: string
}

/**
 * Why a `connection.test` probe said no, named.
 *
 * Each code is a different next step for the person in front of the form, so
 * they are kept apart rather than folded into one "failed": a missing key is
 * fixed in this form, a 401 means the key typed is wrong or expired, a
 * timeout points at the network or the endpoint's own serve, and the rest
 * mean the thing reached is not speaking the OpenAI-compatible dialect the
 * probe assumes.
 */
export type ConnectionTestErrorCode =
  /** The endpoint is known to need a key and none was available to send. */
  | 'missing-key'
  /** The endpoint answered 401/403 — the key sent does not open it. */
  | 'unauthorized'
  /** The endpoint did not answer within the probe's budget. */
  | 'timeout'
  /** The request never reached an endpoint — DNS, refused, reset, TLS. */
  | 'network'
  /**
   * The address typed is not one a request can be sent to — no scheme, a
   * full-width character from an IME, a stray word pasted into the field. Said
   * before any request, because "could not reach" would point the person at
   * their network when the fix is in the field in front of them.
   */
  | 'bad-url'
  /**
   * The key holds a character an HTTP header cannot carry (outside Latin-1, or
   * a control character inside it). Same reason as `bad-url`: `fetch` throws
   * this as a `TypeError` that a naive catch would file under `network`.
   */
  | 'bad-key'
  /** The endpoint answered, with a status that is not one of the named kinds. */
  | 'http-error'
  /** The endpoint answered 200, but not with a model list the probe can read. */
  | 'bad-response'
  /** A saved profile was probed that carries no endpoint of its own. */
  | 'no-endpoint'

/** The named failure half of a `connection.test` result. */
export interface ConnectionTestError {
  code: ConnectionTestErrorCode
  /** Human-readable detail. Safe to show; must not carry a credential. */
  message: string
}

/**
 * One user persona, as the persona panel lists it.
 *
 * `position` uses upstream's own words (`parsePersonaPosition`,
 * `personas.js:1963`): the description either rides the `personaDescription`
 * prompt slot (`inprompt`), sits a fixed number of turns from the end of the
 * conversation (`atdepth`), or is held out of the prompt entirely (`none`) —
 * where it still reaches the world-info scan, exactly as upstream's scan data
 * carries it regardless of position.
 */
export interface PersonaView {
  id: string
  /** The persona's name — upstream keeps it beside the avatar file it is keyed by. */
  name: string
  description: string
  position: 'inprompt' | 'atdepth' | 'none'
  /** Turns from the end of the conversation, when `position` is `atdepth`. */
  depth?: number
  /** The injection's role, when `position` is `atdepth`. */
  role?: 'system' | 'user' | 'assistant'
}

/**
 * How much reasoning a reasoning model should spend on a reply.
 *
 * Upstream's own value set (`reasoning_effort_types`, openai.js:237), sent as
 * the request body's `reasoning_effort`. `'auto'` is the upstream default and
 * means "let the provider decide", which this host expresses by **sending no
 * field at all** — see `@iris/llm-openai-compat`.
 */
export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'min' | 'max'

/**
 * What separates a continued reply from the text it writes on from, in the
 * four spellings upstream's own radio group offers (`continue_postfix_types`,
 * openai.js:211). `'space'` is upstream's default; the words name the literal
 * separators (`''`, `' '`, `'\n'`, `'\n\n'`), which the host maps at the
 * consumer.
 */
export type ContinuePostfix = 'none' | 'space' | 'newline' | 'double'

/** The model route, budget, sampling and reply shaping a chat is running with. */
export interface GenerationSettings {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
  /**
   * The context window in tokens — upstream's `openai_max_context`.
   *
   * Preset-scoped like everything here: a real preset is tuned for one window
   * (measured on this machine's install: 4095, 655 350, 1 000 000, 2 000 000),
   * and assembling against a different one silently trims a different part of
   * the conversation. Absent falls back to the host composition's value.
   */
  contextWindow?: number
  /**
   * Let {@link contextWindow} stand above the model's known window — upstream's
   * `max_context_unlocked` (openai.js:308).
   *
   * Without it, a stored window larger than what the model is known to accept
   * is clamped down to the model's — the mechanism upstream applies once per
   * *named* source branch of `onModelChange`
   * (`oai_settings.openai_max_context = Math.min(<the model's max>, …)`). With
   * it, the stored number is used as written, which is what upstream does for
   * its **CUSTOM** source — a base URL plus a model name, structurally the only
   * route this host has (`openai.js:5704-5710` sets the bound to `unlocked_max`
   * and consults no model table). So here the clamp is a deliberate improvement
   * and this switch hands upstream's own answer for this route back; see
   * `notes/packages/iris-app-service/DEVIATIONS.md` §44.
   *
   * Absent means off, which is upstream's default (openai.js:479). Note that
   * upstream's unlock *raises* its bound to 2 000 000 rather than removing it;
   * this one removes it, because this host has no 2 000 000 of its own and
   * borrowing upstream's would cap a future 4M model at a 2026 constant.
   */
  contextUnlocked?: boolean
  /** How hard a reasoning model thinks, upstream's `reasoning_effort`. */
  reasoningEffort?: ReasoningEffort
  topP?: number
  topK?: number
  minP?: number
  repetitionPenalty?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
  stop?: string[]
  /**
   * Cut a finished reply back to its last complete sentence — upstream's
   * `power_user.trim_sentences` ("trim incomplete sentences"), applied to the
   * text the model produced. Absent means off, which is upstream's default:
   * most models end their replies cleanly and the cut only ever removes text.
   */
  trimSentences?: boolean
  /**
   * The separator between a reply and its continuation — upstream's
   * `continue_postfix`, applied when a continue assembles its request.
   * Absent means `'space'`, upstream's default; on every OpenAI-compatible
   * route upstream applies this and so does this host, which has no other
   * route.
   */
  continuePostfix?: ContinuePostfix
  /**
   * Merge consecutive system-role messages into one — upstream's
   * `squash_system_messages`. Some providers take a system message in the
   * middle of a conversation badly; depth injections and card scripts make
   * adjacent system messages possible here, and this is the one control over
   * whether they ride as they were assembled. Absent means off, upstream's
   * default.
   */
  squashSystemMessages?: boolean
  /**
   * Assemble for a prefix cache: move every prompt part that changes from turn
   * to turn out of the system prompt into one segment after the conversation,
   * ahead of the depth-0 injections.
   *
   * **Absent means ON**, the only field in this type that defaults to on. A
   * prefix cache serves a request's leading bytes and stops at the first byte
   * that differs, so a single `{{roll}}` near the front of a world book caps a
   * whole conversation's hit rate — measured at 21.9% on three real
   * conversations in this profile (`CACHE-PREFIX.md` §1.3). `false` restores
   * SillyTavern's order byte for byte; the host's `IRIS_CACHE_FRIENDLY=0`
   * overrides every chat at once.
   *
   * **Not an upstream setting**, and the cost is real: the model reads the
   * moved instructions later than their author placed them. Recorded in
   * `notes/packages/iris-app-service/DEVIATIONS.md` §38.
   */
  cacheFriendly?: boolean
}

/**
 * One prompt of the active preset, as the prompt manager shows it.
 *
 * Field names are camelCased projections of the file's own (`injection_depth`
 * → `injectionDepth`): the manager edits live state, not the file shape, and
 * the file shape rides verbatim in `@iris/preset` for whoever needs it.
 */
export interface PresetPromptView {
  id: string
  /** Display name; absent for the built-in markers upstream leaves unnamed. */
  name?: string
  role?: string
  /** Whether this prompt contributes to the assembled request. */
  enabled: boolean
  /** A slot the host fills with live data; carries no editable text. */
  marker?: boolean
  /** A built-in prompt upstream refuses to delete. */
  systemPrompt?: boolean
  /** `'relative'` follows the list order; `'absolute'` pins a chat depth. */
  injectionPosition?: 'relative' | 'absolute'
  injectionDepth?: number
  injectionOrder?: number
  /** A card may not replace this prompt's content with its own. */
  forbidOverrides?: boolean
  /** Whether the manager allows toggling this prompt at all. */
  toggleable: boolean
}

/** The prompt manager's state: the active preset and its ordered prompts. */
export interface PresetManagerView {
  /** The active preset's name, when it is one from the library. */
  name?: string
  prompts: PresetPromptView[]
}

/** One preset file in the profile's library, by name. */
export interface PresetSummary {
  name: string
}

/**
 * One global regex script, in the shape SillyTavern stores under
 * `extension_settings.regex` and exports as a `regex-*.json` file.
 *
 * The known fields are spelled out so the shell can render a row without
 * guessing; the index signature is the actual contract. Upstream's script
 * objects are open — extensions and shared decks add keys this host has never
 * heard of — and a list → set → disk round trip must hand them back untouched,
 * or an import from an install would arrive complete and quietly degrade. The
 * engine's reading of these fields is `@iris/regex`'s `RegexScript`.
 */
export interface RegexScriptView {
  id?: string
  /** Required, the same gate upstream's importer applies ("No script name provided."). */
  scriptName: string
  /** Pattern, either bare or in `/pattern/flags` form. */
  findRegex: string
  replaceString: string
  trimStrings?: string[]
  placement?: number[]
  disabled?: boolean
  markdownOnly?: boolean
  promptOnly?: boolean
  runOnEdit?: boolean
  substituteRegex?: number
  minDepth?: number | null
  maxDepth?: number | null
  [key: string]: unknown
}

/**
 * One of a card's own regex rules, with the user's opinion of it beside it.
 *
 * Upstream's second tier: `data.extensions.regex_scripts`
 * (`extensions/regex/engine.js:118`), which travels inside the card and runs
 * only for a character the user put on `character_allowed_regex` (`:115`).
 * **Measured over the 19 local cards: 15 carry this tier, 173 rules in total**,
 * every one of them with all 13 fields present — so this is the *dominant*
 * regex tier in practice, not the exotic one, and the global tier the settings
 * drawer already edited was empty in the same install.
 *
 * The two switches are separate for the reason {@link ScriptView}'s are: the
 * rule's own `disabled` is a fact about the card and survives re-import, and
 * the user's is a decision about this installation.
 */
export interface ScopedRegexView {
  /**
   * The rule as the card stores it, **verbatim** — unknown keys included.
   *
   * Whole rather than projected, because a scoped rule is exportable: the
   * export has to be the file a SillyTavern install would accept, and a view
   * that kept only the fields this shell renders would write a lossy one.
   */
  script: RegexScriptView
  /**
   * What the **file's** author shipped it as: `!script.disabled`.
   *
   * Named for the card because the card tier was the only one with rows when
   * this was written, and kept that way when `regex.presetList` began answering
   * with the same shape: the field means "whoever wrote the document these
   * rules travel in said this", and a preset is such a document. A second view
   * type differing in one field's name would be two places to keep one panel's
   * reading in step. The preset panel renders it as 「预设作者关掉的」.
   */
  enabledByCard: boolean
  /** Whether it will actually run, once both switches are read. */
  enabled: boolean
}

/**
 * One script in the user's own library, as a listing shows it.
 *
 * TavernHelper's script repositories, in the two shapes this host keeps: a
 * global one that runs in every conversation and one per character
 * (`store/scripts.ts:19-24` and `store/settings/character.ts:34`, read from
 * the 酒馆助手 4.9.1 source at
 * `data/default-user/extensions/JS-Slash-Runner/`).
 *
 * Carries no `content`, for {@link ScriptView}'s reason — a listing must not
 * cost what the bodies cost. `scriptLibrary.read` is how the editor gets one.
 *
 * **Not a `ScriptView`.** It is missing `enabledByCard` on purpose: the user
 * wrote these, so there is no second party whose switch could disagree, and a
 * field reporting the author's intent about the reader's own script would be
 * answering a question nobody asked. It carries {@link scope} instead, which a
 * `ScriptView` cannot: a `ScriptView` reports where a *running* script came
 * from, and this reports which repository a *stored* one lives in.
 */
export interface UserScriptView {
  id: string
  name: string
  /** The author's own notes — TavernHelper's `info`. */
  info?: string
  /** Whether the user has switched it on. New scripts arrive off, as upstream's do. */
  enabled: boolean
  /** Which repository it lives in. */
  scope: 'global' | 'character'
  /** Upstream's `button.buttons`, unchanged: `{ name, visible }`, addressed by position. */
  buttons?: { name: string, visible: boolean }[]
  /** Upstream's `button.enabled` — the author's switch for the whole group. */
  buttonsEnabled?: boolean
  /** Size of the body in **UTF-8 bytes**, so a listing can say what it would run. */
  bytes: number
}

/**
 * One library script whole, as the editor and the export file carry it.
 *
 * TavernHelper's `Script` (`src/type/scripts.ts:18-33`), field for field, with
 * its own defaults noted. The index signature is the actual contract, for
 * {@link RegexScriptView}'s reason: a script exported from a 酒馆助手 install
 * and imported here must survive a round trip with every key it arrived with —
 * `data` (the script's variable table) and `export_with` among them — or the
 * export half of that cycle would silently strip it.
 */
export interface UserScript {
  /** Upstream's discriminator against `'folder'`. Folders are not carried; see the ledger. */
  type?: 'script'
  id: string
  name: string
  /** The JS body. */
  content: string
  info?: string
  /** Upstream's default is `false`: a newly created script arrives switched off. */
  enabled: boolean
  button?: { enabled: boolean, buttons: { name: string, visible: boolean }[] }
  /**
   * Upstream's script-variable table.
   *
   * Stored and round-tripped, **not** read as the live `script` scope: this host
   * keeps script variables in a file of its own rather than in the document a
   * user shares (`packages/iris-app-service/src/script-variables.ts`), and
   * seeding that store from a library entry is not part of this round. See the
   * host ledger §33.
   */
  data?: Record<string, unknown>
  export_with?: { data: boolean, button: boolean }
  [key: string]: unknown
}

/** Where a world book entry is inserted, by TavernHelper's name for it. */
export type WorldbookPosition =
  | 'before_character_definition'
  | 'after_character_definition'
  | 'before_example_messages'
  | 'after_example_messages'
  | 'before_author_note'
  | 'after_author_note'
  | 'at_depth'
  | 'outlet'

/** How a world book entry's secondary keys combine. */
export type SecondaryLogic = 'and_any' | 'not_all' | 'not_any' | 'and_all'

/**
 * One world book entry, in the shape a card script reads.
 *
 * TavernHelper's `WorldbookEntry`, which is **not** the shape on disk, and the
 * two disagree in ways a card would notice: `name` is the file's `comment`,
 * `enabled` is the negation of its `disable`, and three independent booleans
 * (`constant`, `vectorized`, `selective`) collapse into one `strategy.type`.
 * Putting the file's own shape on the wire would be a quieter kind of wrong —
 * every field present, several of them inverted.
 */
export interface WorldbookEntry {
  uid: number
  /** The file's `comment`. Cards treat it as the entry's title. */
  name: string
  enabled: boolean
  strategy: {
    type: 'constant' | 'vectorized' | 'selective'
    /**
     * Primary keys, as written.
     *
     * Upstream revives regex-shaped strings (`/foo/i`) into live `RegExp`
     * objects before a card sees them. A `RegExp` cannot cross this boundary —
     * it would arrive as `{}` — so the host sends the strings it read and the
     * revival belongs to whoever hands these to a card.
     */
    keys: string[]
    /**
     * Secondary keys, and the logic combining them.
     *
     * `keys` here needs the **same** revival as the primary ones above — this
     * was measured, not assumed: upstream maps both lists through
     * `parseRegexFromString` with the identical expression
     * (`worldbook.ts:214` and `:218`), and this host's activation engine runs
     * both through `matchKey`, which does the same. Reviving only the primary
     * list would give a card plain strings for keys the engine is matching as
     * patterns — each half self-consistent, the pair wrong, nothing raised.
     *
     * The earlier version of this comment mentioned only `keys`, and a reader
     * building the façade correctly inferred the narrower rule from it. Field
     * documentation that is silent about a sibling reads as a statement about
     * that sibling.
     */
    keys_secondary: { logic: SecondaryLogic, keys: string[] }
    /** `'same_as_global'` when the entry sets no depth of its own. */
    scan_depth: number | 'same_as_global'
  }
  position: {
    type: WorldbookPosition
    role: 'system' | 'user' | 'assistant'
    depth: number
    order: number
  }
  content: string
  /** Already resolved: 100 when the entry does not use probability. */
  probability: number
  recursion: {
    prevent_incoming: boolean
    prevent_outgoing: boolean
    /** Null rather than 0 or false when there is no delay. */
    delay_until: number | null
  }
  effect: {
    /** Null rather than 0 when unset — the two are one state on disk. */
    sticky: number | null
    cooldown: number | null
    delay: number | null
  }
  addMemo: boolean
  group: string
  groupOverride: boolean
  groupWeight: number
  caseSensitive: boolean | null
  matchWholeWords: boolean | null
  /**
   * The entry's world-info outlet, when it has one: an `outlet`-positioned
   * entry is parked under this name by the scan and rendered only where a
   * template asks for `{{outlet::name}}`. Empty when the entry has none.
   */
  outletName: string
  matchPersonaDescription: boolean
  matchCharacterDescription: boolean
  matchCharacterPersonality: boolean
  matchCharacterDepthPrompt: boolean
  matchScenario: boolean
  matchCreatorNotes: boolean
  /**
   * Identifier an automation (quick reply, STscript) can key off. Empty when
   * the entry carries none.
   *
   * Added with the shell's entry editor: a field the stored shape carries and
   * the editor has to show was missing from this view, and a book round-tripped
   * through a save silently blanked every automation binding it had. The four
   * fields below it are the same story — each is on disk, each was unreadable
   * here, and each was dropped by a write that could not carry it.
   */
  automationId: string
  /** Per-entry group-scoring override; `null` defers to the global setting. */
  useGroupScoring: boolean | null
  /** Bypass the token budget for this entry. */
  ignoreBudget: boolean
  /** Whether `probability` is rolled at all; `false` means the entry always fires. */
  useProbability: boolean
  /** Generation types this entry may fire on; empty means all of them. */
  triggers: string[]
  /** Restrict the entry to (or, with `isExclude`, away from) characters and tags. */
  characterFilter: { isExclude: boolean, names: string[], tags: string[] }
}

/**
 * One survived failure the host kept, as a debug page reads it.
 *
 * The wire shape of `@iris/app-service`'s diagnostic buffer. Declared here
 * rather than imported from the host so the page half compiles against the
 * protocol alone.
 */
/**
 * What a report is claiming.
 *
 * **`fault` means a call was not served**: something asked for did not happen,
 * and whoever asked is now working from an answer they did not get. **`note`
 * means it was served and there is still something to say** — a deletion that
 * succeeded, a value that survived in a different shape, a state worth knowing.
 *
 * The two levels match the frame’s own `reportFault` / `reportGap`, so a reader
 * moving between the two halves is not re-learning a vocabulary. It is separate
 * from {@link DebugReport.kind}: the kind says what the report is about, the
 * grade says whether anything is broken.
 */
export type ReportGrade = 'fault' | 'note'

export interface DebugReport {
  /** Whether a call went unserved, or was served with something to say. */
  grade: ReportGrade
  /** Monotonic, and the cursor a page pages with. */
  seq: number
  /** Unix epoch milliseconds. */
  at: number
  /** `mvu | template | prompt | script | variables | storage | host`. */
  kind: string
  chatId?: string
  characterId?: string
  scriptId?: string
  message: string
  /**
   * The original failure's stack, **present only when one was caught**.
   *
   * Most report sites write their own sentence rather than catching an error.
   * Giving those a stack would be worse than giving them none: it names the
   * place that reported, while reading as the place that failed.
   */
  stack?: string
}

/** How a character's books and the globally selected ones are interleaved. */
export type InsertionStrategy = 'evenly' | 'character_first' | 'global_first'

/**
 * World-info settings as TavernHelper's `getLorebookSettings()` reports them.
 *
 * Declared here so the page half compiles against the protocol alone. The
 * host's `@iris/app-service/lorebook-settings` is the authority on the values.
 */
export interface LorebookSettings {
  selected_global_lorebooks: string[]
  scan_depth: number
  /** A percentage of context, not a byte count. */
  context_percentage: number
  /** Bytes; `0` disables the cap. */
  budget_cap: number
  min_activations: number
  /** Ceiling for minimum activations; `0` means none. Not the scan depth. */
  max_depth: number
  max_recursion_steps: number
  insertion_strategy: InsertionStrategy
  include_names: boolean
  recursive: boolean
  case_sensitive: boolean
  match_whole_words: boolean
  use_group_scoring: boolean
  overflow_alert: boolean
}

/**
 * The world-info settings as this host stores and runs them, on the wire.
 *
 * This is the host's own vocabulary — the stored field names, camelCase, one
 * meaning each — rather than TavernHelper's snake_case table above, and the
 * deliberate difference is the point: {@link LorebookSettings} exists to be
 * byte-compatible with what a card reads by name, while this exists to be
 * settable by the host's own panel without dragging the compatibility table's
 * misleading names (`max_depth`, `context_percentage`) into a UI that would
 * have to explain them.
 *
 * Every field is effective, never absent: the host merges stored values over
 * SillyTavern's shipped defaults before answering, so a client reading this
 * sees exactly what the next scan will run with.
 */
export interface WorldbookSettingsView {
  /** `world_info_depth` — how many messages back a scan reads. */
  scanDepth: number
  /** `world_info_budget` — a percentage of the context window. */
  budgetPercent: number
  /** `world_info_budget_cap` — an absolute token ceiling; `0` disables. */
  budgetCap: number
  /** `world_info_min_activations` — keep widening the scan until this many fire. */
  minActivations: number
  /** `world_info_min_activations_depth_max` — how far that widening may reach. */
  minActivationsDepthMax: number
  /** `world_info_max_recursion_steps` — hard cap on scan loop iterations. */
  maxRecursionSteps: number
  /** How the global and character books interleave. */
  insertionStrategy: InsertionStrategy
  /** Whether activated content is scanned for further matches. */
  recursive: boolean
  /** Default case sensitivity for entries that defer. */
  caseSensitive: boolean
  /** Default whole-word matching for entries that defer. */
  matchWholeWords: boolean
  /**
   * Whether the world-info scan buffer carries speaker names.
   *
   * Affects what the scan matches on, never what the model receives — the
   * buffer is built for matching and discarded. ST default true.
   */
  includeNames: boolean
  /** Default inclusion-group resolution by key-match score. */
  useGroupScoring: boolean
}

/**
 * One named world book, with the two facts a chooser needs beside its name.
 *
 * **Deliberately not part of `worldbook.names`' default answer.** That method
 * documents itself as names-and-not-contents because listing books must not
 * read every entry off the disk, and an entry count cannot be had without
 * opening the file. So the counts are asked for — `worldbook.names`'
 * `withCounts` — and a caller that only wants names pays exactly what it paid
 * before.
 */
export interface WorldbookSummary {
  /** The book's name, exactly as `worldbook.names` spells it. */
  name: string
  /**
   * How many entries the file holds, enabled or not.
   *
   * Every entry, because that is what the file *contains* and what an editor
   * would list. How many of them a scan would admit depends on the chat, the
   * budget and the keys, and is not a property of the book.
   */
  entryCount: number
  /**
   * The card this book was materialised from, when this host materialised it.
   *
   * Read off the materialisation table (`materialise.ts`'s
   * `WorldbookBindingStore`), which is **the** link between a card and its
   * book — the filename is not, precisely so that a name can be given up when
   * it collides. So this answers "which card's embedded book became this file",
   * which is the question a reader looking at nine similarly-named books is
   * actually asking.
   *
   * An id, not a name: resolving the name means decoding the card, and a
   * listing of 18 books must not decode 19 cards. The client already holds the
   * library and can look it up.
   *
   * **Absent does not mean "no card's".** A book the user made in SillyTavern
   * and bound to a card by hand was never materialised here, so this host has
   * no record of the link; a client that also knows a card's `extensions.world`
   * can match on the name as a second, weaker rule.
   */
  fromCharacterId?: string
}

/**
 * Which book one card's own world info comes from, and how.
 *
 * A **report of the host's choice, not a second choice.** The name is the same
 * one `resolveCardWorldbook` resolves with — the materialised binding when
 * there is one, otherwise the card's `extensions.world` — so a panel showing
 * this and a prompt built by that host cannot disagree about which book is
 * playing.
 */
export interface CardWorldbookView {
  /**
   * The book the card's world info comes from, or `null` when it has none.
   *
   * Not always the card's own `extensions.world`: see {@link materialised}.
   */
  name: string | null
  /**
   * Where {@link entryCount} was counted.
   *
   * - `named` — a book file, the case every played card is in once its chat has
   *   been opened.
   * - `embedded` — the card's own `character_book`, which has **not** been
   *   materialised into a file yet. A real and transient state: materialisation
   *   runs on the import and open paths, so a card that has never been opened
   *   on this host sits here.
   * - `none` — neither. The card ships no book and binds nothing that resolves.
   */
  source: 'named' | 'embedded' | 'none'
  /** Entries in that book; `0` when {@link source} is `none`. */
  entryCount: number
  /**
   * Whether {@link name} is the name this host minted rather than the card's own.
   *
   * True exactly when the materialisation table holds a name for this card and
   * it differs from `extensions.world` — a collision made the host give the
   * wanted name up. It is the reason a user reads a book name in this panel
   * that is not the one written on their card, so it has to be sayable.
   */
  materialised: boolean
}

/**
 * One world book entry with its content left behind.
 *
 * **The whole point is what is absent.** {@link WorldbookEntry} is the shape a
 * card script reads and it carries `content` — the injected text, which is the
 * bulk of a book: the local corpus's 18 named books hold 1478 entries between
 * them, and one card (`爱衣`) embeds 140. A page listing entries so a reader can
 * see what a card carries needs none of that text, and sending it would put
 * hundreds of kilobytes on the wire every time a character page opened. So this
 * is the *listing* shape: what an entry is called, whether it fires, what fires
 * it, and where it lands.
 *
 * Field meanings are {@link WorldbookEntry}'s, not the file's — `name` is the
 * file's `comment`, `enabled` is the negation of its `disable` — because both
 * shapes are produced by one mapper (`toEntryDigest`) and a second vocabulary
 * here would be a second thing to get inverted.
 */
export interface WorldbookEntryDigest {
  uid: number
  /** The file's `comment`. Empty for an entry whose author titled nothing. */
  name: string
  enabled: boolean
  /**
   * Whether the entry fires on every scan without matching anything.
   *
   * `strategy.type === 'constant'`, flattened to the one bit a listing shows. A
   * `vectorized` entry reads as `false` here, which is right for the question
   * this answers — it does not fire unconditionally — and the strategy's third
   * state is not carried: it is not a fact a reader of a card's contents acts
   * on, and this shape exists to be small.
   */
  constant: boolean
  /**
   * Primary keys, as written — regex-shaped strings included.
   *
   * Verbatim, exactly as `WorldbookEntry.strategy.keys` carries them: upstream
   * revives `/foo/i` into a live `RegExp` before a card sees it, and a listing
   * showing the revived object would show `{}`. A reader is shown what the
   * author typed.
   */
  keys: string[]
  /**
   * Secondary keys, when the entry has any.
   *
   * **Omitted rather than empty**, because empty is the common case and the
   * cost is paid once per entry per page: on a 140-entry book the omission is
   * the difference between 140 `"keysSecondary":[]` and nothing. The logic
   * combining them is not carried — a listing says *that* an entry has
   * secondary conditions; the entry editor says how they combine.
   */
  keysSecondary?: string[]
  /** Where the entry is inserted, by TavernHelper's name for it. */
  position: WorldbookPosition
  /**
   * How many messages up from the end, for an `at_depth` entry.
   *
   * **Omitted for every other position**, where the stored number is carried on
   * disk but means nothing: a `before_character_definition` entry has a `depth`
   * of 4 simply because 4 is the field's default, and printing "depth 4" beside
   * it would invent a fact about an entry whose position does not use one.
   */
  depth?: number
}

/**
 * Why one book is on a card's list.
 *
 * - `card` — the book the card's own world info comes from, as
 *   {@link CardWorldbookView} resolves it. Exactly one book can be this, and it
 *   is the embedded/named *choice*, never both (see `@iris/app-service`'s
 *   `resolveCardWorldbook`: assembling both sources produced 2246 entries of
 *   which 1122 were duplicates).
 * - `additional` — a book the user bound to this character **through the host**
 *   (upstream's `world_info.charLore[…].extraBooks`), on top of the card's own
 *   binding. The user's act, not the card's.
 *
 * Globally selected books are deliberately not a value here: they apply to
 * every character, so listing them under one card would report an
 * installation-wide setting as a property of that card.
 */
export type CardBookRole = 'card' | 'additional'

/**
 * One of a card's world books, listed for a reader rather than for a scan.
 *
 * The figures a page shows over it — how many entries, how many enabled, how
 * many constant — are **not** here: each is derivable from {@link entries} by
 * counting, and a host-computed copy beside the rows it summarises is a second
 * derivation that can disagree with the first. The client counts what it was
 * sent.
 */
export interface CardBookDigest {
  /**
   * The book's name.
   *
   * Never null: a book with no name is not one a reader can be shown, and a
   * card with no book contributes no digest at all. The card's *embedded* book
   * keeps the name its binding asks for even when no file carries it yet —
   * "bound to X, and X is not on disk" is the state, and blanking it would hide
   * the half a reader needs to go looking.
   */
  name: string
  /**
   * Where {@link entries} came from.
   *
   * - `named` — a book file on the host.
   * - `embedded` — the card's own `character_book`, not yet materialised into a
   *   file. A real and transient state: materialisation runs on the import and
   *   open paths, so a card nobody has opened on this host sits here.
   * - `missing` — a binding with **no readable book behind it**. 2 of the
   *   corpus's 18 bindings are in this state, and it is why such a book is
   *   listed rather than dropped: a bound name that activates nothing looks
   *   exactly like a book with no entries, and only one of those is broken.
   */
  source: 'named' | 'embedded' | 'missing'
  /** Why this book is on the card's list. */
  role: CardBookRole
  /**
   * Whether {@link name} is a name this host minted rather than the card's own.
   *
   * {@link CardWorldbookView.materialised}, carried for the `card` role only
   * and omitted when false — it is the reason a reader sees a book name that is
   * not the one written on their card, and false is the ordinary case.
   */
  materialised?: boolean
  /**
   * The book's entries, in the order the book presents them — `displayIndex`
   * for a file, stored order for an embedded book.
   *
   * Empty for a `missing` book, where the emptiness is a fact about the disk
   * rather than about the book. Otherwise every entry the book holds, enabled
   * or not: what the card *contains* is the question a card page answers, and
   * which of them a scan would admit depends on the chat.
   */
  entries: WorldbookEntryDigest[]
}

/**
 * Why a snapshot of a conversation exists.
 *
 * The host records the reason **in the snapshot's file name**, so a folder
 * listing is self-describing and a sidecar index has nothing to drift from.
 * Each value names the dangerous operation the copy was taken in front of.
 */
export type BackupReason =
  /** The cleanup sweep's explicit "back up and clean" answer. */
  | 'cleanup'
  /** One floor was about to be removed (`chat.deleteMessage`). */
  | 'delete-message'
  /** Several floors were about to be removed by a card's replay batch. */
  | 'delete-messages'
  /** An import was about to write over an existing conversation file. */
  | 'import-overwrite'
  /** A restore was about to write a snapshot back over the live conversation. */
  | 'pre-restore'
  /** A card was about to rewrite floors in place (`script.setChatMessages`). */
  | 'rewrite-messages'

/**
 * One stored snapshot of a conversation.
 *
 * `backupId` is the path **relative to the profile's backups root** — the
 * handle every other backup method takes. It is built from validated ids, so
 * it is safe to echo back, and it never leaks an absolute host path.
 */
export interface BackupSummary {
  backupId: string
  /** The conversation the snapshot was taken of. */
  chatId: string
  /** The card the conversation was played with, when it had one. */
  characterId?: string
  /**
   * When the snapshot was taken, parsed from the file name's stamp.
   *
   * Unix epoch milliseconds. `0` when the name carries no readable stamp — a
   * file dropped in by hand is still listable, it just sorts as oldest.
   */
  createdAt: number
  /** Floors carried, header line excluded — recorded in the name at snapshot time. */
  messageCount: number
  /** File size in bytes. */
  bytes: number
  /** What the host was about to do, when the name says. */
  reason?: BackupReason
}

/** One floor of a snapshot, as the read-only preview shows it. */
export interface BackupPreviewFloor {
  /** The floor's index in the snapshot, the same number a card script would see. */
  messageId: number
  /** The floor's speaker. */
  name: string
  /** True when the floor is the user's own line. */
  isUser: boolean
  /** The floor's text, clipped — a preview, not a re-render. */
  text: string
}

/**
 * A read-only look into one snapshot: the header's facts and the first floors.
 *
 * Everything here comes off the snapshot's own bytes, so what a reader sees is
 * what a restore would write back — not a summary the host computed at
 * snapshot time and could have gone stale.
 */
export interface BackupPreview {
  /** The snapshot itself, as the list carries it. */
  backup: BackupSummary
  /** The conversation's title, as the snapshot's header records it. */
  title: string
  /** Who the user was in that conversation, when the header says. */
  userName?: string
  /** Who the character was, when the header says. */
  characterName?: string
  /** The header's own `create_date`, verbatim, when it carries one. */
  createDate?: string
  /** The first floors, in file order. */
  floors: BackupPreviewFloor[]
  /** How many floors the snapshot holds in full. */
  totalFloors: number
}

/**
 * How finely a usage summary is cut in time.
 *
 * Two, not a free interval: the day is the unit a bill is read in and the hour
 * is the unit a single long session is read in, and any third would need a rule
 * for how the chart labels it. Both are cut on **local** boundaries, because
 * the reader's own midnight is the boundary they mean — the same reasoning
 * `parseCreateDate` writes down for reading a chat's `create_date` back.
 */
export type UsageGranularity = 'day' | 'hour'

/**
 * What a set of generations cost, in the buckets that are safe to add up.
 *
 * The four token fields are the protocol's own **disjoint** prompt-and-output
 * buckets, summed under `sumUsage`'s rule: a required bucket sums plainly, an
 * optional one is summed only over the generations that reported it and stays
 * **absent** when none did. That is what makes `cacheRead` readable as a fact
 * rather than a claim — a bucket zero-filled from providers that never spoke
 * about caching would say "the cache never helped" about generations that were
 * never asked.
 *
 * **`cacheMiss` is `TurnUsage.inputTokens`, and it is the "uncached" figure.**
 * The adapter derives it by subtraction — `inputTokens = prompt_tokens -
 * cached_tokens` (`@iris/llm-openai-compat`'s `mapUsage`) — and DeepSeek
 * documents `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`,
 * so on a DeepSeek route this bucket *is* `prompt_cache_miss_tokens`. It is
 * named for the meaning rather than for the wire field because the same
 * subtraction covers the endpoints that only report `cached_tokens`.
 *
 * There is deliberately no `input` or `total` field. Billed prompt tokens are
 * `cacheMiss + cacheRead + cacheWrite` and the total is that plus `output`;
 * both are one addition a reader can defend, and a stored field that duplicates
 * a stored field is a number that can disagree with itself.
 */
export interface UsageBuckets {
  /** Prompt tokens the cache did not serve. Always present: it is a required bucket. */
  cacheMiss: number
  /** Output tokens, reasoning included — reasoning is part of the output it is reported inside. Always present. */
  output: number
  /** Prompt tokens the cache served; absent when no generation here reported caching. */
  cacheRead?: number
  /** Prompt tokens written into the cache; absent when no generation here reported it. */
  cacheWrite?: number
  /** The reasoning share of {@link output}; absent when no generation here reported it. Never added to `output` — it is already inside it. */
  reasoning?: number
  /** Generations counted. */
  turns: number
  /**
   * Of {@link turns}, how many reported any cache bucket.
   *
   * The hit rate's **population**, and the reason it can be stated honestly:
   * the share is {@link cacheRead} over {@link cachePrompt}, both restricted to
   * these generations, so a route that says nothing about caching cannot dilute
   * a route that does. `cacheTurns` of `0` means there is no hit rate to show —
   * not a hit rate of zero.
   */
  cacheTurns: number
  /** Billed prompt tokens over the {@link cacheTurns} generations only: the hit rate's denominator. */
  cachePrompt: number
}

/**
 * {@link UsageBuckets} plus the two facts that are about the *reading* rather
 * than about the spend: how much of the time axis was reconstructed, and how
 * much of the spend was a card's own doing.
 *
 * Split from {@link UsageBuckets} so the nested {@link script} share cannot
 * carry a second copy of either. A share of a share is not a thing this page
 * can show, and `undatedTurns` inside `script` would be a count of a count.
 */
export interface UsageTotals extends UsageBuckets {
  /**
   * Of {@link UsageBuckets.turns}, how many carried no `TurnUsage.at` and were
   * placed in time by their conversation's own header instead.
   *
   * Surfaced rather than hidden because it is the one number that says how much
   * of a time-sliced reading is a reconstruction. Every record written before
   * `at` existed is one of these, and they all land in the bucket holding their
   * chat's last activity — so a chart over old data shows spikes at chat
   * boundaries, and a reader who is not told that will read the spikes as
   * sessions.
   */
  undatedTurns: number
  /**
   * The share of everything above that a **card's own script** asked for, over
   * the same population — `TurnUsage.source` of `'script'`.
   *
   * Included in the enclosing figures, not beside them: a card's generation is
   * billed to the same account on the same route, so a total that excluded it
   * would be a total of something other than the bill. This field is what lets
   * a surface say *how much of it* was the card, which is a question a user
   * asks the moment the number is bigger than they expected — MVU fires one
   * side generation per turn, so on that card this is roughly half of
   * everything.
   *
   * **Absent means no script generation was counted in this range**, not that
   * they cost nothing: the same rule the optional buckets follow, and the same
   * rule `summariseUsage` follows when it refuses to emit a conversation row of
   * zeros. `script.turns` is the count — the "how many" a header card prints.
   *
   * There is no matching `turn` field. The turn share is the enclosing figure
   * minus this one and {@link compaction}, which is a subtraction a reader can
   * defend, and a stored share that must sum to the whole is one more number
   * that can disagree with it.
   */
  script?: UsageBuckets
  /**
   * The share of everything above that **Iris's own compaction summarizer**
   * asked for — `TurnUsage.source` of `'compaction'`.
   *
   * Same standing as {@link script}, same absence rule, and a sibling rather
   * than a merged "not a turn" figure: a card's spend and the host's own are
   * two different people's decisions, and a reader who wants to spend less on
   * one does not touch the other. Inside the enclosing figures for the same
   * reason `script` is — a compaction is billed to the same account on the same
   * route, so a total that excluded it would be a total of something other than
   * the bill.
   *
   * **Small and structural.** One request per compaction, so the count is a
   * handful over a conversation's whole life where `script.turns` can equal the
   * turn count. What makes it worth a figure of its own is that it is *Iris's*
   * request: it appears in a profile that has never run a card script, and
   * before it was recorded a compacted profile's usage page was short by
   * exactly one summary per compaction with nothing naming the gap.
   */
  compaction?: UsageBuckets
}

/**
 * One (time bucket, model) cell of a usage summary — a point on one line.
 *
 * Keyed by the model alone and not by the provider: the model is the line the
 * chart draws, and a user asking "which model is costing me this" is asking
 * about the name they configured. `TurnUsage.provider` is still recorded per
 * generation, so a route can be recovered from the conversation; it is simply
 * not a grouping key here.
 */
export interface UsageBucket extends UsageTotals {
  /** The bucket's start, Unix epoch milliseconds, aligned to the summary's granularity. */
  bucket: number
  /**
   * The model, exactly as recorded. **Absent** for generations written before
   * `TurnUsage.model` existed, which is one line of its own labelled as unknown
   * rather than tokens quietly dropped.
   */
  model?: string
}

/** One conversation's share of a usage summary, for the per-chat subtotal list. */
export interface UsageChat extends UsageTotals {
  chatId: string
  title: string
  characterId?: string
  /** The conversation's own last-activity time, as the sidebar list reports it. */
  updatedAt: number
}

/**
 * Everything a statistics surface needs, aggregated **on the host**.
 *
 * The alternative was `chat.list` followed by a `chat.open` per conversation,
 * which is how a browser would naturally do it and is the wrong shape twice
 * over: it ships every floor of every conversation to compute a dozen sums, and
 * `chat.open` is a *stateful* call on this host — it loads the entry, runs the
 * card's scripts and can raise a cleanup offer. Reading a statistic must not
 * have side effects. So this scans the files the way `chat.search` does and
 * returns only rows.
 */
export interface UsageSummary {
  /** The cells, ordered by bucket then by model, so a chart can walk them once. */
  buckets: UsageBucket[]
  /** Per-conversation subtotals, newest activity first — the sidebar's order. */
  chats: UsageChat[]
  /** Every model name that appears in {@link buckets}, sorted; the absent-model line is not in here. */
  models: string[]
  /** The whole range's totals, so the header cards do not re-add the cells. */
  totals: UsageTotals
  /** The granularity the buckets are cut on, echoed so a stale reply cannot be mistaken for a fresh one. */
  granularity: UsageGranularity
  /** Conversations whose file was read and scanned. */
  scannedChats: number
  /**
   * Conversations whose file could not be read or parsed and were skipped.
   *
   * Reported rather than swallowed, unlike `chat.list`'s silent skip: a summary
   * is a claim about a total, and a total computed over an unknown fraction of
   * the corpus is not one.
   */
  skippedChats: number
}

// —— family②: regex ——

/** Which tier of regex rules a card-facing request names. */
export type TavernRegexTier = 'global' | 'character' | 'preset'

/** Which kind of text a card is asking to have rewritten. */
export type TavernRegexSource =
  | 'user_input'
  | 'ai_output'
  | 'slash_command'
  | 'world_info'
  | 'reasoning'

/** What the text is about to be used as. */
export type TavernRegexDestination = 'display' | 'prompt'

/**
 * One regex rule in **Tavern Helper's** vocabulary rather than the file's.
 *
 * A second spelling of {@link RegexScriptView} on purpose. That view is the
 * stored shape — `scriptName`, `findRegex`, `disabled`, `placement: number[]` —
 * carried verbatim so an export re-imports; this is upstream's `TavernRegex`
 * (`@types/function/tavern_regex.d.ts:30-57`), which renames every field to
 * snake_case, **inverts** `disabled` into `enabled`, and turns the numeric
 * `placement` array into two boolean records. Cards are written against this
 * one, so the translation exists; putting it on the wire rather than in the
 * frame keeps `to_tavern_regex`/`from_tavern_regex`
 * (`src/function/tavern_regex.ts:136`/`:165`) as one pair on one side of the
 * boundary instead of two halves that can disagree about `markdownOnly`.
 *
 * **`enabled` is the document author's word, not the user's.** Upstream has
 * only the one switch (`!disabled`), so that is what this reports — the same
 * reading `ScopedRegexView.enabledByCard` gives and deliberately *not*
 * `ScopedRegexView.enabled`, which folds in the user's own override. A card
 * toggling `enabled` and writing the list back therefore edits the card's own
 * `disabled` flag, which is what upstream's own example does; the user's
 * override is a separate record and survives the write. Ledger §64.
 */
export interface TavernRegexView {
  /** Upstream's `id`. Required here: a rule with none cannot be addressed. */
  id: string
  script_name: string
  /** `!disabled` as the file stores it. See the type's note. */
  enabled: boolean
  find_regex: string
  replace_string: string
  trim_strings: string[]
  source: Record<TavernRegexSource, boolean>
  destination: Record<TavernRegexDestination, boolean>
  run_on_edit: boolean
  /** `null`, never absent — upstream normalises a non-number to `null`. */
  min_depth: number | null
  max_depth: number | null
}

// —— family①: identity & messages ——

/**
 * One character card, in **Tavern Helper's** shape rather than SillyTavern's.
 *
 * Upstream's `getCharacter` (`JS-Slash-Runner/src/function/character.ts:240`)
 * does not hand a card the raw `v1CharData` — it runs `toCharacter`
 * (`character.ts:75-119`), which renames, folds `first_mes` and
 * `alternate_greetings` into one `first_messages` array, resolves the bound
 * book's name, and **omits eleven storage fields by name** (`fav`,
 * `talkativeness`, `world`, `depth_prompt`, `pygmalion_id`, `github_repo`,
 * `source_url`, `chub`, `risuai`, `sd_character_prompt`, and the two legacy
 * `TavernHelper_*` keys). This mirrors that projection, so a card reading the
 * member gets the fields its author wrote against.
 *
 * `getCharData` is the *other* member and deliberately not this shape: it is
 * synchronous upstream and answers the raw storage object, so it rides the
 * pushed snapshot instead. Two members, two shapes, one card file.
 */
export interface CardCharacter {
  /**
   * Upstream spells this `${name}.png` — the character's file, which on
   * SillyTavern is also its identity.
   *
   * Here it is the host's `characterId`, which is what every other Iris surface
   * uses to name a card and what `getCharacterIds()` answers with. A card that
   * round-trips this value to another Iris member finds the card it meant; one
   * that appends it to `/characters/` — upstream's own path — does not, and
   * never could, because this host serves avatars from its own endpoint.
   */
  avatar: string
  /** `data.character_version`, empty when the card carries none. */
  version: string
  /** `data.creator`, empty when the card carries none. */
  creator: string
  /** `creatorcomment` or `data.creator_notes`, in upstream's order of preference. */
  creator_notes: string
  /**
   * The **primary bound book's name**, or `null`.
   *
   * The binding, not the book: upstream fills this from
   * `getCharWorldbookNames(name).primary` and so does this, which means a name
   * that no file answers to is still reported. `ScriptContext.charWorldbooks`
   * says why at length.
   */
  worldbook: string | null
  /** `description`, unclipped — this is the round trip, not the summary. */
  description: string
  /** `first_mes` followed by every `alternate_greetings` entry, upstream's fold. */
  first_messages: string[]
  /**
   * `data.extensions`, minus the keys upstream's projection drops.
   *
   * Carries `regex_scripts` and `tavern_helper` — which means it carries the
   * card's script **bodies**, exactly as upstream's member does. That is why
   * this is a round trip and not a snapshot field: a card asks for it, once,
   * rather than every frame paying for it every turn.
   */
  extensions: Record<string, unknown>
}

/**
 * One past conversation, as `getChatHistoryBrief` reports it.
 *
 * Upstream's shape is whatever SillyTavern's `/api/characters/chats` returns
 * (`file_name`, `chat_items`, `mes`, `last_mes`, …) with `ch_name` and
 * `avatar_url` attached by `attachCharacterToChats`
 * (`function/raw_character.ts:66-72`); its declared return type is `any[]`, so
 * there is no contract to break, only a set of key names cards would read.
 *
 * The four upstream keys a caller can use are kept, spelled as upstream spells
 * them, and Iris's own identity travels beside them rather than instead: a
 * `file_name` here is `${chatId}.jsonl`, and `chatId` is the value every other
 * Iris member takes.
 */
export interface ChatHistoryBriefRow {
  /** `${chatId}.jsonl` — upstream's key, and what `getChatHistoryDetail` takes. */
  file_name: string
  /** How many floors the file holds. Upstream's key for the same count. */
  chat_items: number
  /** The character's name, as `attachCharacterToChats` attaches it. */
  ch_name: string
  /**
   * Upstream attaches the character's avatar id here.
   *
   * Iris attaches its `characterId`, for the reason {@link CardCharacter.avatar}
   * gives: this host has no `/characters/<avatar>.png` to name.
   */
  avatar_url: string
  /** Iris's own chat id — the one every other member takes. */
  chatId: string
  /** The conversation's title, which upstream's rows have no equivalent of. */
  title: string
  /** Last activity, Unix epoch milliseconds. `ChatSummary.updatedAt`'s value. */
  updatedAt: number
}
