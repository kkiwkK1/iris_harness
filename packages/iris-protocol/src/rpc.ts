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

import { MAX_CONTEXT_WINDOW } from './views.ts'

import type { BackupPreview, BackupSummary, CardBookDigest, CardWorldbookView, CharacterSummary, ChatSearchHit, ChatSummary, ChatView, ConnectionKeySource, ConnectionProfile, ConnectionTestError, DebugReport, GenerationSettings, HostDefaultConnection, ModelContextLength, PersonaView, PresetManagerView, PresetSummary, PromptDivergence, PromptItemization, RegexScriptView, ScopedRegexView, ScriptContext, ScriptView, TavernRegexView, UsageSummary, UserScript, UserScriptView, WorldbookEntry, WorldbookSettingsView, WorldbookSummary, ScriptChatMessage } from './views.ts'
// —— family①: identity & messages ——
import type { CardCharacter, ChatHistoryBriefRow } from './views.ts'

/**
 * A partial card-facing entry, as the book-writing methods accept it.
 *
 * Shared by `worldbook.replace` and `worldbook.create`: both build a stored
 * book from the same shape, and a second copy of an eight-nested-field schema
 * is exactly how the two halves drift.
 */
const worldbookEntriesPatch = z.array(z.object({
  uid: z.number().int().min(0),
  name: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  strategy: z.object({
    type: z.enum(['constant', 'vectorized', 'selective']).optional(),
    /**
     * Keys as **strings**, never as revived `RegExp` objects.
     *
     * This is the return leg of a round trip, and it is the half that gets
     * forgotten. `worldbook.get` hands a card `RegExp` objects for its
     * regex-shaped keys; the most natural way to write an update is to
     * change one field and hand the entry straight back, so what arrives
     * here is whatever `get` produced. A `RegExp` does not survive JSON —
     * it serializes to `{}` — and this schema rejects it outright, which
     * fails a card that did nothing wrong.
     *
     * So whoever revived them un-revives them before crossing:
     * `String(re)` yields `/pattern/flags`, exactly the shape
     * `parseRegexFromString` reads. The frame does this in
     * `flattenKeys`.
     *
     * Both lists, for the same reason `keys_secondary` is revived on the
     * way out — see `WorldbookEntry` in `views.ts`.
     */
    keys: z.array(z.string().max(1000)).max(200).optional(),
    keys_secondary: z.object({
      logic: z.enum(['and_any', 'not_all', 'not_any', 'and_all']).optional(),
      /** Strings, like `keys` above — the same un-revival applies. */
      keys: z.array(z.string().max(1000)).max(200).optional(),
    }).optional(),
    scan_depth: z.union([z.number().int(), z.literal('same_as_global')]).optional(),
  }).optional(),
  position: z.object({
    type: z.enum([
      'before_character_definition', 'after_character_definition',
      'before_example_messages', 'after_example_messages',
      'before_author_note', 'after_author_note', 'at_depth', 'outlet',
    ]).optional(),
    role: z.enum(['system', 'user', 'assistant']).optional(),
    depth: z.number().int().optional(),
    order: z.number().int().optional(),
  }).optional(),
  content: z.string().max(200_000).optional(),
  probability: z.number().int().min(0).max(100).optional(),
  recursion: z.object({
    prevent_incoming: z.boolean().optional(),
    prevent_outgoing: z.boolean().optional(),
    delay_until: z.number().int().nullable().optional(),
  }).optional(),
  effect: z.object({
    sticky: z.number().int().nullable().optional(),
    cooldown: z.number().int().nullable().optional(),
    delay: z.number().int().nullable().optional(),
  }).optional(),
  addMemo: z.boolean().optional(),
  group: z.string().max(200).optional(),
  groupOverride: z.boolean().optional(),
  groupWeight: z.number().int().optional(),
  caseSensitive: z.boolean().nullable().optional(),
  matchWholeWords: z.boolean().nullable().optional(),
  /**
   * The write legs of the fields `WorldbookEntry` reads out, added with the
   * shell's entry editor. Each is optional, and each defaults exactly as this
   * host's stored writer always defaulted — so a caller that never heard of
   * them writes the same book it always did, and the extension serves a caller
   * that read a whole book and is putting it back whole. `outletName` was
   * already on the stored writer and the read view; it was only ever missing
   * here, which made an outlet name the one field a round trip could read and
   * not write.
   */
  outletName: z.string().max(200).optional(),
  automationId: z.string().max(200).optional(),
  useGroupScoring: z.boolean().nullable().optional(),
  ignoreBudget: z.boolean().optional(),
  useProbability: z.boolean().optional(),
  triggers: z.array(z.string().max(60)).max(12).optional(),
  characterFilter: z.object({
    isExclude: z.boolean(),
    names: z.array(z.string().max(200)).max(100),
    tags: z.array(z.string().max(200)).max(100),
  }).optional(),
  matchPersonaDescription: z.boolean().optional(),
  matchCharacterDescription: z.boolean().optional(),
  matchCharacterPersonality: z.boolean().optional(),
  matchCharacterDepthPrompt: z.boolean().optional(),
  matchScenario: z.boolean().optional(),
  matchCreatorNotes: z.boolean().optional(),
})).max(2000)

/**
 * One global regex script as the wire carries it.
 *
 * Loose on purpose, and only here: the storage contract for this list is
 * verbatim — an export file's unknown keys must survive the round trip — so
 * this is the one request body that may carry fields nobody declared. The three
 * required fields are the ones upstream's own importer insists on (`scriptName`
 * — "No script name provided." — plus the two the engine reads on every run);
 * the size caps keep a pasted file from being a memory request, and sit far
 * above anything a real script carries.
 */
const regexScriptRequest = z.looseObject({
  scriptName: z.string().min(1).max(300),
  findRegex: z.string().max(100_000),
  replaceString: z.string().max(100_000),
})

/**
 * Which of the user's own script repositories a request names.
 *
 * `'character'` requires a `characterId`; `'global'` refuses one. The pair is
 * checked in the handler rather than modelled as a discriminated union, because
 * the refusal has to *name* the mistake — a schema failure on a two-field
 * request reads as "malformed" and sends the reader to the transport.
 */
const libraryScope = z.enum(['global', 'character'])

/**
 * One library script as the wire carries it.
 *
 * Loose for `regexScriptRequest`'s reason and with the same consequence: what
 * a 酒馆助手 export file carried, the host keeps, so `data` and `export_with`
 * survive a round trip through a shell that renders neither. The caps are the
 * ones that matter for a *body of code* — 2 MB is above the largest script in
 * the local corpus by a wide margin (the biggest card script measures 448 kB)
 * and far below a memory request.
 */
const userScriptRequest = z.looseObject({
  /** Absent on create; present on edit, and then it must already exist. */
  id: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(300),
  content: z.string().max(2_000_000),
  info: z.string().max(20_000).optional(),
  enabled: z.boolean().optional(),
  button: z.object({
    enabled: z.boolean(),
    buttons: z.array(z.object({ name: z.string().max(300), visible: z.boolean() })).max(200),
  }).optional(),
})

/** Runtime schemas for every request body, keyed by method. */
export const requestSchemas = {
  'chat.list': z.object({}),
  'chat.create': z.object({ characterId: z.string().min(1) }),
  'chat.open': z.object({ chatId: z.string().min(1) }),
  'chat.delete': z.object({ chatId: z.string().min(1) }),
  'chat.rename': z.object({ chatId: z.string().min(1), title: z.string().max(200) }),
  /**
   * Put the conversation list in the order the reader arranged.
   *
   * **Iris has no upstream to be compatible with here.** SillyTavern's chat
   * list is sorted by its own picker — by name, by date, ascending or
   * descending — and offers no manual order at all, so there is no file format,
   * no key and no behaviour to match. This is an addition, recorded as one
   * (host DEVIATIONS §62).
   *
   * **The whole visible order, not a move.** A `{ chatId, toIndex }` shape
   * would be smaller and would be wrong: the browser has just laid the list out
   * and knows exactly what it means, while a host applying a relative move has
   * to agree with the browser about what the list was *before* it — and the two
   * disagree the moment a chat is created, deleted or renamed in another tab.
   * Sending the sequence makes the request idempotent and makes a stale caller
   * fail loudly (an id the host does not have is refused) rather than quietly
   * arranging the wrong rows.
   *
   * Branches are included even though a reader cannot place one: a branch
   * renders under the conversation it left, but it is still an id in the
   * arrangement, and an id the arrangement omits is treated as newer than it.
   */
  'chat.reorder': z.object({
    /**
     * Every conversation, in the order it should be listed.
     *
     * Capped at 2000, which is two orders of magnitude above the largest
     * profile measured on this machine (31 chat files) and low enough that a
     * malformed request cannot ask the host to hold a megabyte of ids. The
     * per-id 120 is `isSafeId`'s own ceiling, so an id too long to name a file
     * is refused by the schema rather than by the filesystem.
     */
    order: z.array(z.string().min(1).max(120)).max(2000),
  }),
  /**
   * Find conversations by a fragment of floor text.
   *
   * Upstream's `POST /api/chats/search` (`chats.js:874`) plus the "Previous
   * Chats" filter that calls it. The scan is linear over the profile's chat
   * files — no index — because the corpus's largest conversation (677 floors,
   * 19 MiB) reads and searches in a fraction of the one-second line, and an
   * index would add invalidation on every write to answer the same question
   * the files already answer. Hits name the chat and the floor, so a caller
   * can open one and know where inside it the text lives.
   */
  'chat.search': z.object({
    /** The fragment to find, matched against each floor's stored text (`mes`). */
    query: z.string().min(1).max(200),
    /** Default false, like upstream's filter: a name is typed as it is remembered. */
    caseSensitive: z.boolean().optional(),
    /** Matches reported per chat, when a caller wants fewer than the default. */
    limit: z.number().int().positive().max(20).optional(),
  }),
  /**
   * Answer the one-time offer to clean a chat that has never been cleaned.
   *
   * **A reply to an event, not a poll.** The host raises `cleanup.offer` and
   * then does nothing: no answer is a complete outcome, and the ordinary one —
   * a shell that is closed, a page that never rendered the dialog, a user who
   * walked away. Nothing is cleaned and nothing is recorded, so the offer comes
   * back next time.
   *
   * **`'never'` is sent only when someone presses "do not remind me".** Upstream
   * treats a dismissal as that answer — `CANCELLED` and `NEGATIVE` take the same
   * branch and both write `ignore_cleanup` (`legacy_chat.ts:27-33`) — and **this
   * host deliberately does not reproduce it**. Pressing Esc there records a
   * permanent refusal the user did not make: they believe they deferred, and the
   * offer never returns. Here a dismissal is simply no answer, which is a
   * complete outcome and brings the offer back next time.
   */
  'chat.answerCleanup': z.object({
    chatId: z.string().min(1),
    answer: z.enum(['clean', 'never', 'backup-and-clean']),
  }),

  /**
   * Open a generation.
   *
   * `kind` selects what is generated, in SillyTavern's vocabulary. Absent (or
   * `'send'`) is the ordinary exchange: `text` becomes a user line and a reply
   * is generated after it. `'continue'` writes on from the newest reply — its
   * result rejoins that floor as a new reading, every earlier reading
   * preserved — and takes no text. `'impersonate'` writes the user's next line
   * instead of a reply, and takes no text either: the model IS the author of
   * the user side here.
   */
  'chat.send': z.object({
    chatId: z.string().min(1),
    kind: z.enum(['send', 'continue', 'impersonate']).optional(),
    // Bounded because it lands in a prompt; an unbounded field is a way to
    // burn someone's tokens from a page they were tricked into opening.
    // Required for `send` and refused for the other two kinds — a continue
    // carries no input, and text sent with an impersonation has no defined
    // meaning to be quietly dropped.
    text: z.string().min(1).max(32_000).optional(),
  }).superRefine((value, ctx) => {
    const wantsText = value.kind === undefined || value.kind === 'send'
    if (wantsText && value.text === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'a send needs text' })
    }
    if (!wantsText && value.text !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: `a "${value.kind}" takes no text; the newest floor or the model supplies the words`,
      })
    }
  }),
  'chat.regenerate': z.object({ chatId: z.string().min(1) }),
  /**
   * Compact this conversation's older history into a summary, now.
   *
   * Takes no span: which floors are compacted is the host's decision, made
   * from the same retained-tail rule the automatic trigger uses, with its
   * retention set to zero — everything but the newest floor. A client that
   * could name a span would be a client that has to know the token cost of
   * every floor, and the host is the only side that does.
   *
   * Idle-only. A compaction rewrites what the *next* request assembles from, so
   * running one while a reply is streaming would change the conversation under
   * a request already in flight; the host refuses with `busy` rather than
   * queueing, because a queued compaction is one the user has stopped watching.
   */
  'chat.compact': z.object({ chatId: z.string().min(1) }),
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
  /**
   * Which floor a message-scope read or write addresses.
   *
   * **An integer, a numeric string, `'latest'`, or omitted.** The domain is
   * upstream's, and it is wider than it looks: `_.inRange` and
   * `Array.prototype.at` both coerce, so `'3'` works there, and `at` gives a
   * negative its from-the-end meaning. Two corpus cards write
   * `message_id: 'latest'` verbatim.
   *
   * **The range is deliberately not checked here.** How far a chat extends is
   * not something a wire schema knows, and `-1` is only meaningful against a
   * length — so the shape is checked here and the domain in `turnForMessage`,
   * where an out-of-range id can be refused by name against the chat it was
   * addressed to. Pinning `min(0)` would reject the negatives upstream accepts;
   * pinning a maximum would be guessing.
   *
   * `null` is refused rather than normalised, and the reason lives with the
   * behaviour in `turnForMessage`: upstream's guards let it through to floor 0.
   */
  'script.getVariables': z.object({
    chatId: z.string().min(1),
    scope: z.enum(['message', 'chat', 'global', 'script']),
    /** For `message`: which turn's candidate. Absent means the newest. */
    messageId: z.union([z.number().int(), z.string()]).optional(),
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
    messageId: z.union([z.number().int(), z.string()]).optional(),
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
    /**
     * The endpoint this profile generates through. Absent on a **new** profile
     * means it rides the host's configured route; absent on a **replacement**
     * drops the stored one, like every non-secret field.
     */
    baseURL: z.string().max(2000).optional(),
    /**
     * The key to store, **write-only**: no read ever returns it, so the form
     * has nothing to pre-fill and must not pretend otherwise.
     *
     * Absent keeps the stored key — the only field that merges, because a
     * caller editing a label cannot re-send what it was never shown. Empty
     * string clears it. Non-empty replaces it.
     */
    apiKey: z.string().max(2000).optional(),
    /** The header the key is sent in. Absent means the OpenAI-compatible `Authorization: Bearer`. */
    apiKeyHeader: z.string().max(200).optional(),
    /*
     * `adoptHostKey` stood here: a flag asking the host to copy its own startup
     * credential into the profile being saved, which is what turned the
     * read-only 「宿主环境」 row of `connection.list` into an editable profile in
     * one press. That row is gone (the user's ruling of 2026-09-10; host §61,
     * web §79) and so is its 存为供应商 button, the flag's only caller. The copy
     * survives where it is now needed: `importLaunchConnection()` writes the
     * environment's endpoint, model and credential into a profile once, at
     * first start, so the key still never crosses the wire in either direction.
     */
    /**
     * The model ids a probe of this profile's endpoint just reported, recorded
     * on the profile so a picker elsewhere has a list without probing again.
     *
     * A **record of an observation**, not a claim about the present — the store
     * stamps it with the time it was written. Absent leaves whatever was
     * recorded before; an empty array records "probed, and it advertised
     * nothing", which is a different fact from never having probed.
     */
    models: z.array(z.string().min(1).max(400)).max(2000).optional(),
    /**
     * What is known about those ids' context windows, keyed by id — the same
     * record `connection.test` answers with, carried back so a saved profile
     * keeps it.
     *
     * Sparse: only the ids anything knows a window for appear. `tokens` reads
     * its ceiling from {@link MAX_CONTEXT_WINDOW} — the same constant the
     * settings store bounds a typed `contextWindow` by and the probe bounds a
     * reported one by — so an endpoint cannot put a window on the wire that the
     * settings layer would refuse a person for typing, and raising the ceiling
     * cannot raise two of the three.
     */
    modelContexts: z.record(
      z.string().min(1).max(400),
      z.object({
        tokens: z.number().int().min(1).max(MAX_CONTEXT_WINDOW),
        source: z.enum(['provider', 'table']),
      }),
    ).optional(),
  }),
  'connection.delete': z.object({ id: z.string().min(1) }),
  /** Apply a profile: globally, or to one chat when `chatId` is given. */
  'connection.activate': z.object({
    id: z.string().min(1),
    chatId: z.string().min(1).optional(),
  }),
  /*
   * `connection.deactivate` stood here: apply **no** profile and put the global
   * layer back on the route and model the host was launched with (host §60, web
   * §78, both one day old when this was written). It was the 「宿主环境」 row's
   * own verb, and the row is gone — the user's ruling of 2026-09-10 retires the
   * environment as something a person can select, so "no profile applied" is no
   * longer a state the interface can ask for. A generation with nothing in use
   * is refused by name (`no-provider`) rather than served from the environment.
   * Host §61 and web §79.
   */
  /**
   * Probe an endpoint the way a model list would be fetched, and say what
   * happened in words a form can show.
   *
   * Either a saved profile (`profileId`) or unsaved form values (`baseURL`,
   * with the key as typed). The two share one schema rather than two methods:
   * the question is the same — can this endpoint serve me — and the caller's
   * distinction of "saved or not" is not worth a second method to guess at.
   *
   * **`apiKey` is optional on purpose, and its absence is a request, not an
   * omission.** Most providers show an API key exactly once, so a form that
   * demands a re-typed key on every probe is a form that can be used once. An
   * absent key asks the host to probe with what it already holds — the named
   * profile's stored key, or the credential the process was started with — and
   * the answer says which one it used (`keySource`). The host will only reuse a
   * key **at the origin that key belongs to**: a probe pointed somewhere else
   * goes out bare, because otherwise this parameter would be a way for the page
   * to post a stored credential to an endpoint of its choosing.
   */
  'connection.test': z.object({
    profileId: z.string().min(1).optional(),
    baseURL: z.string().max(2000).optional(),
    /**
     * The key as typed in the form. Never logged, never echoed back.
     *
     * Absent means "use what the host has" (see above). Empty string means the
     * same thing — a form that clears the field has not asked for a bare probe,
     * it has just not typed anything.
     */
    apiKey: z.string().max(2000).optional(),
    apiKeyHeader: z.string().max(200).optional(),
    /** Which provider preset the form is testing, so a known-to-need-a-key endpoint says so by name. */
    preset: z.string().max(200).optional(),
  }),

  'prompt.itemize': z.object({
    chatId: z.string().min(1),
    turn: z.number().int().min(0).optional(),
  }),

  /**
   * Compare one recorded request against the one before it.
   *
   * `seq` addresses the **newer** of the pair and defaults to the newest
   * recorded; the older is whichever trace sits immediately before it. Optional
   * rather than required because "why did the turn I just sent miss" is the
   * question this answers most of the time, and making a caller find a sequence
   * number first would make the common case the awkward one.
   */
  'prompt.divergence': z.object({
    chatId: z.string().min(1),
    seq: z.number().int().min(0).optional(),
  }),

  'chat.branch': z.object({
    chatId: z.string().min(1),
    id: z.number().int().min(0),
    swipeId: z.number().int().min(0).optional(),
  }),

  /**
   * Copy a SillyTavern chat file into this profile.
   *
   * Upstream's `/api/chats/import` ([ST 1.18.0] `src/endpoints/chats.js:696`;
   * `:604`, which this used to cite, is `/export`) — the migration path for a
   * user whose history lives in an install. The file crosses as base64 because
   * that is how a browser file upload already reaches `character.import`; the
   * bytes go in untouched, and everything below is reading, not conversion.
   *
   * **The owning character is asked for, not inferred.** Upstream hangs import
   * off a character's own chat-management panel, so the file's `character_name`
   * and the character it lands under can disagree there too. The id is recorded
   * in the file's `iris` block — where the card, the scripts and the books come
   * from when the chat opens — while the header's own names stay verbatim, so
   * an exported file still reads as the file it was.
   *
   * **One file per call, all-or-nothing.** Upstream also accepts several other
   * chat dialects (Kobold Lite, CAI, oobabooga, Agnai, Risu) and renames what
   * it imports; this arm takes SillyTavern JSONL only and refuses everything
   * else **before anything is written**, with the reason named. A file that
   * half-imported would be worse than a file refused.
   */
  'chat.import': z.object({
    /** The file's name, whose stem becomes the chat's id when it is a safe one. */
    filename: z.string().min(1).max(255),
    /** Base64 of the JSONL file, exactly as it left SillyTavern. */
    content: z.string().min(1),
    /** The character this conversation is played with. */
    characterId: z.string().min(1),
  }),
  /**
   * One conversation as SillyTavern's own JSONL.
   *
   * The reverse leg of `chat.import`, and the same promise the storage layer
   * was built on: a chat taken out of Iris is a chat SillyTavern can read. The
   * text is produced by the same projection every save uses — the one with the
   * key-order round-trip tests — not a second exporter.
   *
   * The bytes travel as a response for the browser to save locally. Nothing
   * lands on the host's disk, because an export the user cannot find is a
   * backup only in the moment it was offered.
   */
  'chat.export': z.object({
    chatId: z.string().min(1),
  }),

  'character.list': z.object({}),
  'character.import': z.object({
    filename: z.string().min(1).max(255),
    /**
     * Base64 of the card file. Which extensions are accepted is decided in one
     * place — `EXTENSIONS` in `@iris/app-service`'s `library.ts` (`.png`,
     * `.jpg`, `.jpeg`, `.json`; `.charx` is refused by name as unsupported) —
     * and not repeated here: this comment used to say "a PNG, a `.json` or a
     * `.charx`", which omitted the JPEGs the library takes and promised the one
     * format it refuses.
     */
    content: z.string().min(1),
  }),
  'character.delete': z.object({ characterId: z.string().min(1) }),

  /**
   * Manager operations on one card in the library.
   *
   * **Rename is in-place.** Upstream's `/api/characters/rename` writes the new
   * name into the card *and* moves the file, because upstream's ids are avatar
   * filenames and its chats live in per-character folders. Iris's ids are
   * load-bearing far beyond the filename — the worldbook binding table, every
   * chat header, the script policy and the favorites are keyed by them — so
   * the display name changes and the id does not. The binding is untouched
   * either way: `extensions.world` is a book *name*, used verbatim, and never
   * derived from the character's (see `@iris/app-service/worldbooks`).
   *
   * **Duplicate copies the file bytes verbatim** — upstream's `copyFileSync` —
   * under a fresh id minted the way imports mint them. Chats are not copied.
   * The card's binding row is copied with it, so the duplicate resolves to the
   * *same* named book its source binds, which is exactly what sharing one
   * `extensions.world` name means upstream; minting the duplicate a second
   * book of its own would be a divergence a user could only discover as two
   * world infos that drift.
   *
   * **Export strips the private fields upstream strips** (`unsetPrivateFields`:
   * `fav` in both spellings, and the last-open-chat pointer `chat`) and
   * otherwise sends the card as stored — a PNG goes out as a PNG with its card
   * chunks rewritten in place, a `.json` card as pretty-printed JSON.
   */
  'character.duplicate': z.object({ characterId: z.string().min(1) }),
  'character.rename': z.object({
    characterId: z.string().min(1),
    /** The new display name, verbatim. Empty is refused. */
    name: z.string().min(1).max(255),
  }),
  'character.export': z.object({
    characterId: z.string().min(1),
    format: z.enum(['png', 'json']),
  }),
  /** Replace the card's whole tag list — the add/remove/edit of a tag editor. */
  'character.setTags': z.object({
    characterId: z.string().min(1),
    tags: z.array(z.string().min(1).max(120)).max(100),
  }),
  /**
   * Star or unstar a character. **Profile-level, deliberately not the card's
   * `fav`**: a star is this user's reading preference, and Iris's standing rule
   * is that runtime state does not go into shared card files.
   */
  'character.favorite': z.object({
    characterId: z.string().min(1),
    favorite: z.boolean(),
  }),

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

  /**
   * The preset library and the prompt manager.
   *
   * The prompt manager's state (which prompts, in what order, which enabled)
   * is the active preset's, live: a switch re-seeds it from the file, and the
   * mutations below write through to the persisted state the assembler reads.
   * Upstream keeps the same two layers — preset files are snapshots, the
   * manager edits `oai_settings` on top — and this reproduces the mechanism.
   */
  'preset.list': z.object({}),
  /** Make a library preset the active one and apply what it carries. */
  'preset.select': z.object({ name: z.string().min(1).max(255) }),
  /** The prompt manager's current state. */
  'preset.view': z.object({}),
  /** Toggle one prompt of the active ordering, where upstream allows it. */
  'preset.setEnabled': z.object({ id: z.string().min(1), enabled: z.boolean() }),
  /** Move one prompt within the active ordering. */
  'preset.move': z.object({ id: z.string().min(1), index: z.number().int().min(0) }),
  /**
   * Create or edit one prompt of the active preset.
   *
   * An absent `identifier` creates one (upstream mints a UUID); an `id` the
   * preset does not carry creates with that identifier, which is how a preset
   * gains a prompt an extension or a card expects to find.
   */
  'preset.upsertPrompt': z.object({
    prompt: z.object({
      identifier: z.string().min(1).max(120).optional(),
      name: z.string().max(500).optional(),
      role: z.enum(['system', 'user', 'assistant']).optional(),
      content: z.string().max(1_000_000).optional(),
      marker: z.boolean().optional(),
      system_prompt: z.boolean().optional(),
      forbid_overrides: z.boolean().optional(),
      injection_position: z.enum(['relative', 'absolute']).optional(),
      injection_depth: z.number().int().min(0).max(1000).optional(),
      injection_order: z.number().int().optional(),
    }),
  }),
  /** Remove one non-system prompt from the active preset. */
  'preset.removePrompt': z.object({ id: z.string().min(1) }),
  /** Persist the active state as a named preset in the library (upsert). */
  'preset.save': z.object({ name: z.string().min(1).max(255) }),
  /** Delete a preset from the library. */
  'preset.delete': z.object({ name: z.string().min(1).max(255) }),
  /** Read one preset's file body — what an export downloads. */
  'preset.read': z.object({ name: z.string().min(1).max(255) }),
  /**
   * Copy presets from the configured SillyTavern install, read-only.
   *
   * Names are file stems; absent means every preset the install has. Also the
   * listing for an import picker: the response carries what the install offers.
   */
  'preset.import': z.object({ names: z.array(z.string().min(1).max(255)).optional() }),
  /**
   * Import one hand-carried preset file — upstream's import button.
   *
   * Upstream splits the work: the browser reads the picked file, derives the
   * preset's name from the filename minus its last extension and refuses what
   * does not parse (`openai.js` `onPresetImportFileChange`), then posts to
   * `/api/presets/save` (`presets.js`), which sanitizes the name and writes the
   * body four-space indented. Nothing on that path converts a foreign format —
   * parseable JSON goes in as it is. This arm takes the whole file and answers
   * one outcome, so the naming of refusals stays the host's job and the same
   * code path's. The content crosses as base64 because that is how a browser
   * file upload already reaches `character.import`.
   */
  'preset.importFile': z.object({
    /** The file's name, extension included; the stem becomes the preset's name. */
    filename: z.string().min(1).max(255),
    /** Base64 of the `.json` file, exactly as it left the disk. */
    content: z.string().min(1),
  }),

  /**
   * The user's personas — who `{{user}}` is, in upstream's
   * `power_user.persona_descriptions` sense, one per named persona with the
   * active one standing in for upstream's selected avatar.
   *
   * `position` takes upstream's own words (`parsePersonaPosition`,
   * `personas.js:1963`). The `topan` / `bottoman` words are deliberately
   * absent from the enum: they merge the description into an author's note
   * this host does not assemble, and accepting them would store a position
   * nothing can act on.
   */
  'persona.list': z.object({}),
  /**
   * One persona, or the active one. Absent `id` reads the active persona —
   * `undefined` in the answer means no persona is active, which is the
   * every-install default and not an error.
   */
  'persona.get': z.object({ id: z.string().min(1).optional() }),
  /**
   * Create a persona (absent `id`) or edit one (present `id`), and optionally
   * make it active in the same call. An absent `description` keeps whatever is
   * stored, so a rename does not blank the text it was never shown.
   */
  'persona.set': z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).max(255),
    description: z.string().max(1_000_000).optional(),
    position: z.enum(['inprompt', 'atdepth', 'none']).optional(),
    depth: z.number().int().min(0).max(1000).optional(),
    role: z.enum(['system', 'user', 'assistant']).optional(),
    active: z.boolean().optional(),
  }),
  /** Remove a persona; removing the active one clears the activation. */
  'persona.delete': z.object({ id: z.string().min(1) }),

  /**
   * The profile's global regex scripts — upstream's `extension_settings.regex`
   * tier (`extensions/regex/engine.js:110`), the one every chat runs before any
   * card's own.
   *
   * The list arrives loose (`regexScriptRequest` below) because the storage
   * contract is verbatim: whatever an export file carried, the panel shows and
   * the host keeps. The run order inside the tier is the array order, the same
   * order upstream's drag handler persists.
   */
  'regex.list': z.object({}),
  /**
   * Replace the whole global list.
   *
   * One whole-list primitive rather than per-row verbs — the same shape
   * `worldbook.replace` chose — so toggle, delete, reorder and import are all
   * the panel doing a read-modify-write over what `regex.list` last showed. A
   * script arriving without an `id` is given one (upstream's importer mints a
   * UUID for every import); an id already on a script is kept, which is what
   * makes a toggle a rewrite of the same script rather than a new one.
   */
  'regex.set': z.object({ scripts: z.array(regexScriptRequest).max(1000) }),

  /**
   * One card's own regex tier, and whether the user lets it run.
   *
   * Upstream's second tier (`data.extensions.regex_scripts`), which travels
   * inside the card. Read-only as a *list*: the rules belong to the card and are
   * not rewritten here, so the two writes below record the user's decisions
   * instead — which is the whole difference from `regex.set`, where the list
   * itself is the thing being edited.
   */
  'regex.scopedList': z.object({ characterId: z.string().min(1) }),
  /**
   * Allow or refuse one card's own regex tier.
   *
   * Upstream's `character_allowed_regex` membership (`engine.js:175`/`:194`),
   * per character. Two states, not three: nothing asks, so "never decided" and
   * "allowed" are one state — see `ScriptPolicyStore.regexAllowed` for why that
   * is the opposite convention from `script.setScriptsAllowed`, and what a
   * future round that adds the question would have to change first.
   */
  'regex.setScopedAllowed': z.object({
    characterId: z.string().min(1),
    allowed: z.boolean(),
  }),
  /**
   * The user's own on/off for one of a card's regex rules.
   *
   * Stored beside the user's other decisions rather than written into the card,
   * which is where upstream puts it (`writeExtensionField`, `engine.js:148`).
   * The rule must exist on the card: a decision recorded against an id the card
   * does not carry is one nobody can audit, the same rule `script.setEnabled`
   * holds.
   */
  'regex.setScopedEnabled': z.object({
    characterId: z.string().min(1),
    scriptId: z.string().min(1),
    enabled: z.boolean(),
  }),

  /**
   * The **active preset's** own regex tier, and whether the user lets it run.
   *
   * Upstream's third tier: the active preset file's `extensions.regex_scripts`,
   * read through `presetManager.readPresetExtensionField`
   * (`extensions/regex/engine.js:126`) and gated on the preset's *name* being
   * in `extension_settings.preset_allowed_regex[api]` (`:126-128`).
   *
   * **No parameters, deliberately.** The subject is whichever preset is active,
   * because that is the only one whose rules can run — a request naming a
   * preset would invite a panel to show and switch a tier that is not in play,
   * and the two writes below would then need to say which preset they meant
   * while the runner would still only ever read the active one.
   */
  'regex.presetList': z.object({}),
  /**
   * Allow or refuse the active preset's own regex tier.
   *
   * Upstream's `preset_allowed_regex` membership, keyed by preset name. Two
   * states like the scoped pair above, but **absent means refused** here, which
   * is upstream's own default rather than a divergence — see
   * `ScriptPolicyStore.presetRegex` and §53 for why the two tiers' defaults
   * disagree on purpose.
   */
  'regex.setPresetAllowed': z.object({ allowed: z.boolean() }),
  /**
   * The user's own on/off for one of the active preset's regex rules.
   *
   * Stored beside the user's other decisions rather than written into the
   * preset file, which a preset being passed around as a file makes stronger
   * than the same argument about a card. The rule must exist in the active
   * preset, the same gate `regex.setScopedEnabled` applies.
   */
  'regex.setPresetEnabled': z.object({
    scriptId: z.string().min(1),
    enabled: z.boolean(),
  }),

  /**
   * Every script that would run in this character's conversations.
   *
   * **Three repositories now, not one.** The card's own, plus the user's global
   * library (which runs everywhere) and the user's library for this card. They
   * arrive in one list, in run order, each row naming its `source` — because
   * they are one list at run time too, and a caller that had to compose three
   * responses would be the place the composition could disagree with what
   * actually runs.
   */
  'script.list': z.object({ characterId: z.string().min(1) }),
  /**
   * The user's own on/off for one script, independent of the card's `enabled`.
   *
   * Two switches rather than one: the card author's is a fact about the card and
   * survives re-import, the user's is a decision about this installation. Fusing
   * them would let a re-import quietly revive a script the user turned off.
   *
   * `source` says which store the write lands in — the per-character policy for
   * a card script, the library entry itself for one of the user's. **Absent
   * means `'card'`**, which is the one place in this family where a default is
   * right: the field is a routing hint from a caller that already read the row
   * it is toggling, and every caller that predates the library was toggling a
   * card script. A wrong route cannot silently mislabel anything, unlike
   * `ScriptView.source`, because the id has to exist in the store it names.
   */
  'script.setEnabled': z.object({
    characterId: z.string().min(1),
    scriptId: z.string().min(1),
    enabled: z.boolean(),
    source: z.enum(['card', 'global', 'character']).optional(),
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
   * Read the host's retained diagnostic reports.
   *
   * **Pull, not push.** A broadcast channel already exists, and hanging the
   * diagnostic stream on it would turn the debug page into a log subscription —
   * the charter asked for a page, not a platform. A `since` cursor with polling
   * is enough, and it costs nothing while the page is closed.
   */
  /**
   * Write one key of the card storage shared across this profile.
   *
   * **Shared, as `localStorage` is shared per origin upstream.** Two cards
   * choosing the same key see each other's values; that is reproduced rather
   * than partitioned away. What is added is attribution: the host records which
   * card and script wrote a key last, so a later removal can say whose it was.
   */
  'storage.set': z.object({
    /** The card doing the writing, for attribution. */
    characterId: z.string().min(1),
    /** Which of its scripts, when the caller knows. */
    scriptId: z.string().min(1).optional(),
    key: z.string().min(1).max(400),
    /** `localStorage` values are strings; so are these. */
    value: z.string(),
  }),
  'storage.remove': z.object({
    characterId: z.string().min(1),
    scriptId: z.string().min(1).optional(),
    key: z.string().min(1).max(400),
  }),
  /**
   * Empty the whole store, as upstream's `clear()` empties the origin.
   *
   * Every key goes, including other cards'. The host reports each removal that
   * took a key another card had written — upstream wipes them with no way to
   * attribute the loss.
   */
  'storage.clear': z.object({
    characterId: z.string().min(1),
    scriptId: z.string().min(1).optional(),
  }),

  'debug.reports': z.object({
    /** Return records newer than this `seq`. Absent means from the oldest held. */
    since: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(2000).optional(),
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
  /**
   * Append messages to a chat, or insert them at a position.
   *
   * Takes the **stored** shape rather than upstream's `role`-based
   * `ChatMessageCreating`, and that is a seam decision, not laziness. One arm
   * serves two façades: a card's `context.chat.push`, which hands over a raw
   * SillyTavern message object, and `createChatMessages`, whose `role` has to
   * become a `name` using `name1`/`name2`. Those two names live in the frame's
   * snapshot; making the host rebuild them from the chat header would create a
   * second source for the same fact, and the symptom of the two disagreeing is a
   * message attributed to the wrong speaker — stored fine, read back fine, wrong.
   *
   * **This arm does not save.** A replay batch is heterogeneous (append, remove,
   * rewrite through three arms), so a `persist` flag would have to exist on all
   * three and "who writes the file" would depend on which kind happened to be
   * last. `script.saveChat` is one decision in one place, it already exists, and
   * it is what a card calls upstream anyway.
   */
  'script.createChatMessages': z.object({
    chatId: z.string().min(1),
    messages: z.array(z.object({
      /**
       * The speaker. Required, never defaulted here.
       *
       * Upstream derives it from `role` when absent, using `name1`/`name2` — so
       * the defaulting belongs on the side that has those, and requiring it here
       * is what forces it to stay there rather than existing in two places.
       */
      name: z.string().max(500),
      /**
       * Required, and the one field whose absence is dangerous rather than
       * merely incomplete: `importChat` opens with `if (line.is_user)`, so a
       * missing value is falsy and the message silently becomes an assistant
       * one. That reads back cleanly and is wrong, which is worse than a message
       * that fails to read back at all.
       */
      is_user: z.boolean(),
      mes: z.string().max(200_000),
      /** Upstream's `is_hidden`. */
      is_system: z.boolean().optional(),
      /**
       * Passed through verbatim, including upstream's own asymmetry: for
       * `role: 'system'` upstream sets `extra.type` to its narrator marker and
       * then lets a supplied `extra` **replace the whole object**, wiping it.
       * Copied rather than corrected — a card may depend on it.
       */
      extra: z.record(z.string(), z.unknown()).optional(),
      /**
       * The floor's variable layer — upstream's `data`, which it stores as
       * `variables[0]`.
       *
       * One layer, not the array: upstream only ever writes slot 0 here. Reaches
       * this host only through the `createChatMessages` façade; the
       * `context.chat.push` replay narrows away `variables` and `swipes` and
       * reports the loss to the card, so it never arrives by that route.
       */
      variables: z.record(z.string(), z.unknown()).optional(),
    })).min(1).max(200),
    /**
     * Where to insert. Absent appends at the end.
     *
     * Negative values are legal and clamped to `[-length, length]`, which is
     * upstream's `_.clamp(insert_before, -chat.length, chat.length)`.
     */
    insertAt: z.number().int().optional(),
  }),
  /**
   * Delete messages by their position in the chat.
   *
   * **`messageIds` are indices into the chat as it is now, and every one of them
   * is resolved against that same snapshot — they are removed in one pass.**
   * This is upstream's `deleteChatMessages`, which sorts, de-duplicates and
   * `_.pullAt`s. Deleting `[2, 5]` removes the messages currently at 2 and 5.
   *
   * That is **not** the same as calling `chat.deleteMessage` twice, where the
   * second index is read against a list that has already shifted: `[2, 5]`
   * applied one at a time removes the messages at 2 and at 6. Both are correct
   * for their own caller — a card's ledger replay applies its removals in
   * sequence and *must* keep calling the single-message arm — and the two index
   * meanings are both `number[]`, so nothing but this sentence distinguishes
   * them. Measured on a 7-message chat: sequential deletion of 2 and 5 removed
   * the wrong second message, with no error and two successful responses.
   */
  'script.deleteChatMessages': z.object({
    chatId: z.string().min(1),
    messageIds: z.array(z.number().int().min(0)).min(1).max(500),
  }),
  /**
   * Read a preset's prompt list.
   *
   * Minimal by measurement: the corpus has **one** call site, its argument is
   * always the literal `'in_use'`, and it reads only `id`, `enabled`, `content`
   * and `role` off each prompt. Everything else upstream's `PresetPrompt`
   * carries is left out until something asks for it.
   *
   * **Prompt ids are camelCase**, and this is the one place a reader is likely
   * to get it wrong from the documentation. Upstream's own JSDoc
   * (`@types/function/preset.d.ts:81`) lists them in snake_case —
   * `world_info_before`, `persona_description`, `enhance_definitions` — while
   * the type union immediately below it at `:83`, the type-guard array at
   * `preset.ts:115`, and the default preset's literals at `preset.ts:161`/`:190`
   * all say `worldInfoBefore`, `personaDescription`, `enhanceDefinitions`. Three
   * runtime sources against one comment. Implementing from the comment gives a
   * card whose `prompt.id === 'worldInfoBefore'` is never true: its world info
   * silently disappears and the output still reads as complete.
   */
  'script.getPreset': z.object({
    /**
     * Which preset. `'in_use'` means the one currently loaded.
     *
     * Any other name is refused by name rather than quietly answered with the
     * one in use — a card that asked for a specific preset and got a different
     * one cannot tell, and would go on to reason about prompts that are not
     * there.
     */
    name: z.string().min(1).max(200),
  }),
  /**
   * Render one EJS template on the card's behalf.
   *
   * Upstream's `evalTemplate(content, data?, options?)`. The corpus calls it at
   * **one site in one card** and always with a single argument, so this takes
   * `content` alone. The schema is **strict**: a call carrying `data` or
   * `options` is refused by name rather than having them dropped, because a
   * template silently evaluated without the data it was given returns
   * well-formed text built from the wrong values — the failure this project
   * keeps meeting, where the wrong answer looks like an answer.
   *
   * **The evaluation never happens in this process.** The string goes verbatim
   * into `@iris/compat-prompt-template`'s forked child, which runs with `env: {}`
   * so nothing of the host's environment crosses. There is no `eval`, `Function`
   * or `vm` on the host side of this call, and there must not be: the argument
   * is attacker-controlled in the only sense that matters — it is whatever a
   * card put there.
   *
   * **Failure is an error, not an empty string.** Cards expect upstream's soft
   * degradation, so the façade turns a rejection into a warning plus the
   * original text. Returning `''` here would hand the card a rendered-looking
   * empty result and lose the text it asked about.
   */
  'script.evalTemplate': z.strictObject({
    chatId: z.string().min(1),
    content: z.string().max(200_000),
  }),
  /**
   * Replace one script's button table.
   *
   * Upstream's `replaceScriptButtons`. Whole-table: a button left out of
   * `buttons` is gone, because upstream's writer assigns the array it is given
   * rather than merging into it.
   *
   * `appendInexistentScriptButtons` is **not** a separate method here — upstream
   * builds it out of this one (`script.ts:110` → `_updateScriptButtonsWith` →
   * `_replaceScriptButtons`, deduplicating by name and appending), and
   * `updateScriptButtonsWith` takes a function, which cannot cross this
   * boundary. Both stay in the façade, composed from this.
   */
  'script.replaceScriptButtons': z.object({
    characterId: z.string().min(1),
    scriptId: z.string().min(1),
    buttons: z.array(z.object({
      name: z.string().min(1).max(200),
      /** Required, never defaulted: upstream's type has no default either. */
      visible: z.boolean(),
    })).max(200),
  }),
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
    /**
     * The injection's identity, and its handle.
     *
     * Upstream's key is `prompt.id ?? uuidv4()` with **no script prefix**, so
     * two scripts choosing the same id overwrite each other there too — this
     * matches rather than diverges. Note the consequence a card author rarely
     * expects: assembly order within a group is the lexicographic order of
     * these keys, so a UUID id lands at a random position in the prompt.
     */
    key: z.string().min(1).max(200),
    /** An empty value removes the injection, which is how `uninject` works. */
    value: z.string().max(32_000),
    position: z.enum(['before', 'after', 'at-depth', 'none']).default('at-depth'),
    depth: z.number().int().min(0).max(1000).default(0),
    /** Upstream maps `{system, user, assistant}` onto `0 | 1 | 2`. */
    role: z.enum(['system', 'user', 'assistant']).optional(),
    /**
     * Whether the injected text is itself scanned for world-book keywords.
     *
     * Upstream's `should_scan`, default false. Carried through the contract and
     * **stored but not yet honoured** by the scan pass; a request that sets it
     * is recorded rather than silently treated as false.
     */
    scan: z.boolean().optional(),
    /**
     * Which frame run this injection belongs to.
     *
     * **The shell mints it and the host never parses it.** The readable form is
     * `${chatId}:${generation}` so a report can name which open it came from,
     * but it travels as an opaque key: a host that reads structure out of it
     * acquires an opinion about how the shell counts its runs.
     *
     * Why it exists: the shell rebuilds a card’s script frame per chat, and the
     * new frame re-injects. Without a run to attribute an injection to, the old
     * one has no moment at which it can be cleared, and the two accumulate —
     * while clearing everything on a chat open would break a *second* page that
     * still has that conversation open (the reason DEVIATIONS 10 keeps
     * injections per chat rather than clearing on switch).
     *
     * **Required.** It was optional for exactly one batch, while the frame did
     * not yet send it: rejecting those injections would have taken the feature
     * down between two deploys, and defaulting them would have made each one
     * immortal with nothing said, so they were stored and reported instead.
     * The frame now sends it on every call — verified in the front end, twelve
     * run ends paired with no missing-id fault — so the allowance is gone and
     * an injection without a run is refused at the boundary.
     */
    runId: z.string().min(1).max(200),
  }),
  /**
   * A frame run has ended, so its injections can go.
   *
   * Sent by the shell when it tears a run down — the moment upstream’s
   * `clearChat()` would have emptied its single global `extension_prompts`.
   * Only that run’s injections go, which is what makes this safe with several
   * pages open: another page’s run is a different key and is not touched.
   */
  'script.runEnded': z.object({
    chatId: z.string().min(1),
    runId: z.string().min(1).max(200),
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
    /**
     * Which repository the id belongs to, from the `script.list` row the runner
     * is executing.
     *
     * **Named rather than searched for**, and this is the one place it is
     * load-bearing. Upstream keeps its three repositories' ids globally unique
     * by re-minting on collision (`use_resolve_id_conflict.ts`), but *card* ids
     * are the card author's and this host cannot re-mint them — so "look in the
     * card, then in the library" would resolve a collision by silently running
     * the wrong body. Absent means `'card'`, which is what every caller before
     * the library meant.
     */
    source: z.enum(['card', 'global', 'character']).optional(),
  }),

  /**
   * The user's own script library, as a listing.
   *
   * `characterId` picks up that card's repository alongside the global one; with
   * it absent the answer is the global repository alone, which is what the
   * settings drawer asks for when no conversation is open.
   */
  'scriptLibrary.list': z.object({ characterId: z.string().min(1).optional() }),
  /**
   * One library script whole, for the editor and for an export.
   *
   * Separate from the listing for `script.body`'s reason — a listing must not
   * carry the bodies — and distinct from `script.body`, which serves a *runner*
   * and refuses a switched-off script. This one serves the person editing it, so
   * it answers regardless of the switch: refusing to show someone the script
   * they just turned off would make the switch a lock on their own work.
   */
  'scriptLibrary.read': z.object({
    scope: libraryScope,
    characterId: z.string().min(1).optional(),
    id: z.string().min(1).max(200),
  }),
  /**
   * Create or replace one library script.
   *
   * One script per call, not a whole-list replacement like `regex.set`. The two
   * differ because the payloads differ: a regex list is a few kilobytes and the
   * panel holds all of it, while a library holds bodies the listing deliberately
   * does not carry — a whole-list write would mean the panel had to fetch every
   * body just to toggle one switch, and any body it failed to fetch would be
   * erased by the write.
   *
   * A script arriving without an `id` is created and given one; one with an `id`
   * replaces the entry it names, and is refused if no such entry exists — a
   * create that silently happens because an edit missed its target is how a
   * duplicate appears with nothing reporting it.
   */
  'scriptLibrary.save': z.object({
    scope: libraryScope,
    characterId: z.string().min(1).optional(),
    script: userScriptRequest,
  }),
  /** Remove one library script, and the user's switch with it. */
  'scriptLibrary.delete': z.object({
    scope: libraryScope,
    characterId: z.string().min(1).optional(),
    id: z.string().min(1).max(200),
  }),
  /**
   * Switch one library script on or off.
   *
   * A verb of its own rather than a `save` with one field changed, because
   * `save` carries the body: a toggle that had to round-trip a megabyte of
   * webpack output would be the most expensive control in the panel, and the
   * body it sent back would be whatever the panel last read rather than what is
   * stored.
   */
  'scriptLibrary.setEnabled': z.object({
    scope: libraryScope,
    characterId: z.string().min(1).optional(),
    id: z.string().min(1).max(200),
    enabled: z.boolean(),
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
   * Nothing that changes the conversation is recorded: not the log, and not the
   * two pieces of chat state a real assembly advances (world-info timed
   * effects, the turn's itemization). What **is** recorded is the bill — one
   * append-only entry on the chat header, reported back as
   * `ChatView.scriptUsage` and counted by `usage.summary`. The provider charged
   * for it either way, and recording nothing is what made a card's spend
   * invisible on every surface that reports cost.
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

  /**
   * The named world books this installation has.
   *
   * Names, not contents: upstream separates the two so listing books does not
   * read 1478 entries off the disk to answer a question about 18 names.
   */
  'worldbook.names': z.object({
    /**
     * Also count each book's entries, and say which card it was materialised
     * from — `books` in the answer.
     *
     * Opt-in rather than always, because it is the exact cost the paragraph
     * above exists to avoid: a count means opening the file, so this reads all
     * 18 books where the bare call reads a directory listing. A panel showing a
     * chooser pays it once per open; a card asking what books exist must not.
     */
    withCounts: z.boolean().optional(),
  }),
  /**
   * One named world book's entries.
   *
   * Ordered by the file's `displayIndex`, which is the order the user arranged
   * and not uid order.
   */
  /**
   * One book in the **raw saved shape**, as `SillyTavern.loadWorldInfo` returns it.
   *
   * Deliberately a second reader beside `worldbook.get`: the two upstream APIs
   * for one book answer with different shapes — this one with `entries` keyed
   * by uid, TavernHelper's `getWorldbook()` with a normalised array. A card
   * picks an API and expects that API's shape; MVU's guard is literally
   * `isPlainObject(loaded) && isPlainObject(loaded.entries)`, so handing back
   * the array form is what produces its "Failed to read character-card
   * configuration".
   */
  'worldbook.load': z.object({
    /**
     * The book's name. **Empty is a real input**, not a client bug: upstream's
     * first line is `if (!name) return;`, and the caller distinguishes that
     * answer from "asked and could not get it".
     */
    name: z.string().max(200),
  }),

  'worldbook.get': z.object({
    /**
     * The book's name, exactly as spelled.
     *
     * Not an id. 13 of the corpus's 18 book names change under this host's
     * `toId`, and a card's binding holds the untransformed name, so normalizing
     * here would silently fail to find two thirds of the real books.
     */
    name: z.string().min(1).max(120),
  }),
  /**
   * Which books a card is bound to.
   *
   * A binding is a name; the card's own embedded `character_book` is a separate
   * body of entries and is not reported here, because upstream's member does not
   * report it either.
   */
  'worldbook.charNames': z.object({
    characterId: z.string().min(1),
    /**
     * Also report which book actually plays for this character — `card` in the
     * answer.
     *
     * Opt-in for the same reason `worldbook.names`' `withCounts` is: it costs a
     * read of the book file and of the materialisation table, and the caller
     * this method exists for — upstream's `getCharWorldbookNames`, which
     * returns names and makes you fetch contents yourself — must not pay for a
     * panel's question.
     */
    withCard: z.boolean().optional(),
  }),
  /**
   * Every world book one card involves, listed entry by entry, without content.
   *
   * **The reading half of the family.** `worldbook.charNames` answers a card
   * script's question — which names is this character bound to — and
   * `worldbook.get` answers a card's or an editor's: give me one book in full,
   * content and all. Neither answers the question a *character page* asks, which
   * is "what world info does this card carry", over as many books as the card
   * involves and with no text: the embedded book (140 entries on one local card)
   * plus every host-stored extra binding, each entry named, keyed, placed and
   * flagged. Composing it from the two existing methods costs one call per book
   * and downloads every entry's `content` to throw it away.
   *
   * **One call per page open, and it must stay that way.** A page that asked
   * per frame is what put 322 KB × 60 on the host's queue on the
   * `script.context` path. There is no `characterId`-less form and no list form:
   * this is a card's page asking about the card in front of the reader.
   *
   * Refused, never answered empty, on a host with no book store: an empty list
   * would read as "this card carries no world info", which is a claim about the
   * card rather than an admission that there is no store to look in.
   */
  'worldbook.charDigest': z.object({ characterId: z.string().min(1) }),
  /**
   * Replace a named world book's entire contents.
   *
   * **Whole-book replacement, which is upstream's semantics.** An entry not in
   * `entries` is deleted. Upstream's `replaceWorldbook` builds the saved file
   * fresh from the array it is handed, and partial updates are expressed by
   * reading first — which is what `updateWorldbookWith` does.
   *
   * `updateWorldbookWith` itself stays in the frame, on the `updateVariablesWith`
   * precedent: it takes a function, and a function cannot cross this boundary.
   * The frame reads, applies the caller's updater, and calls this.
   *
   * Every field but `uid` is optional, and **omitting `strategy` does not mean
   * "leave it alone"** — it means `constant: true`, an always-on entry. That is
   * upstream's default and this host copies it; see `worldbooks.ts`.
   */
  /**
   * The books injected into every chat, whatever character is playing.
   *
   * Upstream's `world_info.globalSelect`, which lives under
   * `settings.json` → `world_info_settings`. Its own pair of methods rather than
   * a field of `settings.set`: that patch is merged per chat and range-checked
   * as numbers, and this is neither — it is installation-wide and a list of
   * names.
   */
  'worldbook.globalSelect': z.object({}),
  'worldbook.setGlobalSelect': z.object({
    /** Book names, verbatim. A name with no file behind it is simply skipped. */
    names: z.array(z.string().min(1).max(120)).max(100),
  }),
  'worldbook.replace': z.object({
    name: z.string().min(1).max(120),
    entries: worldbookEntriesPatch,
  }),
  /**
   * Create a book that does not exist yet.
   *
   * Upstream's `createWorldbook` reports existence with `false` rather than an
   * error — "already there" is a normal outcome of the get-or-create patterns
   * cards write, and an exception would turn a race between two scripts into a
   * card-facing failure. `entries` is optional and defaults to empty, which is
   * what `getOrCreateChatWorldbook` wants: a file to bind before any entry
   * exists to put in it.
   */
  'worldbook.create': z.object({
    name: z.string().min(1).max(120),
    entries: worldbookEntriesPatch.optional(),
  }),
  /**
   * Bind (or unbind) a chat's own world book.
   *
   * `chat_metadata.world_info` — upstream's `setChatLorebook` — holds a book
   * **name**, and the name must resolve: binding a book with no file behind it
   * would make every later scan silently skip it, which reads as a book that
   * activates nothing. `null` clears the binding, which is how upstream's
   * own reader behaves when the key names a deleted file.
   */
  'worldbook.bindChat': z.object({
    chatId: z.string().min(1),
    name: z.string().min(1).max(120).nullable(),
  }),
  /**
   * Replace one character's **additional** book bindings.
   *
   * Upstream's `world_info.charLore` — the row keyed by the character's file
   * name whose `extraBooks` join the card's own binding in
   * `getCharacterLore` (`world-info.js:4376`). Iris' `characterId` is that same
   * file stem, so it keys the row directly.
   *
   * A whole-list write, matching upstream's `updateAuxBooks`: the caller sends
   * the complete next list in the order to keep; duplicates collapse to their
   * first occurrence; and **an empty list removes the row entirely** — upstream
   * splices the `charLore` entry when the last book is unbound
   * (`world-info.js:6044`), so unbinding leaves no residual key. The primary
   * binding is deliberately out of reach here: it lives on the card, and the
   * card file is shared between installations.
   *
   * Every name must resolve to a stored book — a binding with no file behind it
   * makes every later scan silently skip it, which reads as a book that
   * activates nothing (the same rule `worldbook.bindChat` applies).
   */
  'worldbook.setCharBooks': z.object({
    characterId: z.string().min(1),
    /** The complete additional list, in the order to keep. Empty unbinds all. */
    names: z.array(z.string().min(1).max(120)).max(100),
  }),
  /**
   * Read and write the scan knobs: scan depth, budget, recursion, matching.
   *
   * Their own pair of methods rather than fields of `settings.set` for the same
   * reason `globalSelect` is: the sampler patch is merged per chat and
   * range-checked as numbers, while these are installation-wide, semantically
   * mixed, and default-valued — a field the user has never set still answers
   * with SillyTavern's shipped value, because that is what the scan actually
   * runs.
   */
  'worldbook.settings': z.object({}),
  'worldbook.setSettings': z.object({
    scanDepth: z.number().int().min(0).max(1000).optional(),
    budgetPercent: z.number().int().min(0).max(100).optional(),
    budgetCap: z.number().int().min(0).optional(),
    minActivations: z.number().int().min(0).max(1000).optional(),
    minActivationsDepthMax: z.number().int().min(0).max(1000).optional(),
    maxRecursionSteps: z.number().int().min(0).max(1000).optional(),
    insertionStrategy: z.enum(['evenly', 'character_first', 'global_first']).optional(),
    recursive: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    matchWholeWords: z.boolean().optional(),
    useGroupScoring: z.boolean().optional(),
    includeNames: z.boolean().optional(),
  }),

  /**
   * The profile's conversation snapshots, newest first.
   *
   * Upstream's `GET /api/backups/chat/get` (`endpoints/backups.js`), narrowed
   * to what a restore point needs: when it was taken, how many floors it holds,
   * how big it is, and **why the host took it** — a list of copies without the
   * reasons is a list a reader cannot trust, because "which of these was made
   * before the thing I want to undo" is the only question one asks of it.
   * Absent `chatId` lists the whole profile.
   */
  'backup.list': z.object({
    /** Only this conversation's snapshots, when given. */
    chatId: z.string().min(1).max(120).optional(),
  }),
  /**
   * Read the head of one snapshot.
   *
   * A restore is an overwrite, and confirming an overwrite sight-unseen is how
   * the wrong snapshot gets written over the right conversation. The preview is
   * read off the snapshot's own bytes — what it shows is what a restore writes.
   */
  'backup.preview': z.object({
    /** The snapshot's handle, as `backup.list` carried it. */
    backupId: z.string().min(1).max(400),
    /** How many floors to show. Default is a head, not the whole file. */
    floors: z.number().int().min(1).max(50).optional(),
  }),
  /**
   * Write a snapshot back over its conversation.
   *
   * **`confirm` is the conversation's title, typed.** This is the one backup
   * method that destroys something — the live file — so it refuses to run on a
   * bare click: the caller must send the name the interface showed them, and a
   * mismatch is refused by name. The check lives here and not only in the page,
   * because the page is the untrusted side and an RPC that asks the host to
   * overwrite a conversation should carry its own proof of intent.
   *
   * Before anything is written, the **current** file is snapshotted too — a
   * restore that goes wrong must itself be restorable.
   */
  'backup.restore': z.object({
    backupId: z.string().min(1).max(400),
    /** The conversation's title as the reader typed it; compared against the snapshot's header. */
    confirm: z.string().max(200),
  }),
  /** Remove one snapshot. The live conversation is never touched by this. */
  'backup.delete': z.object({
    backupId: z.string().min(1).max(400),
  }),

  /**
   * What every conversation in the profile has cost, cut by time and by model.
   *
   * **Aggregated on the host, on purpose.** The shape a browser reaches for is
   * `chat.list` and then a `chat.open` per conversation, and that is wrong twice:
   * it ships every floor of every conversation across the wire to compute a
   * dozen sums, and `chat.open` is a *stateful* call here — it loads the entry,
   * composes its scripts and can raise a cleanup offer. Reading a statistic must
   * not have side effects. So this scans the profile's chat files the way
   * `chat.search` does — a substring check per line, `JSON.parse` only on the
   * lines that carry a usage array — and returns rows, never floors.
   *
   * No pagination and no cap. A summary is a claim about a total, so a cap would
   * make it a claim about an unstated fraction; what makes that safe is that the
   * reply's size is set by (buckets x models) and by the number of
   * conversations, never by their length — see `UsageSummary`.
   */
  'usage.summary': z.object({
    /**
     * Earliest moment to count, Unix epoch milliseconds, inclusive.
     *
     * Absent means "from the first record there is", which is what the
     * interface's "all" range sends — rather than a zero every reader would
     * have to recognise as a sentinel.
     */
    since: z.number().int().min(0).optional(),
    /** Latest moment to count, exclusive. Absent means "up to now". */
    until: z.number().int().min(0).optional(),
    /** How finely to cut time. Default `'day'`. */
    granularity: z.enum(['day', 'hour']).optional(),
  }),

  // —— family②: regex ——
  /**
   * One tier of regex rules, in Tavern Helper's own vocabulary.
   *
   * Upstream's `getTavernRegexes(option)`
   * (`@types/function/tavern_regex.d.ts:87`; the reader is
   * `get_tavern_regexes_without_clone`, `src/function/tavern_regex.ts:115-134`),
   * which reads `extension_settings.regex` for `'global'`,
   * `characters.at(id).data.extensions.regex_scripts` for `'character'` and the
   * preset body's `extensions.regex_scripts` for `'preset'`.
   *
   * **No `name`, and that is the deviation.** Upstream's option carries
   * `name?: string | 'current'` for a character and `name?: string | 'in_use'`
   * for a preset, so a card there can read *any* installed card's tier and any
   * saved preset's. Here the tier is resolved from the `chatId` the shell
   * stamps on every card action: `'character'` is the chat's own card and
   * `'preset'` is the active one. A card cannot name another. See the host
   * ledger §64 for why the same rule governs the write.
   *
   * **One tier per call, in that tier's own stored order** — the tiers' run
   * order (global, then preset, then card: upstream's iteration order and not
   * its numbering, `@iris/regex`'s `TIER_ORDER`) is not visible in one answer,
   * because upstream's own new signature answers one tier too. The frame's
   * deprecated `{scope}` path is where the order shows, by concatenating two of
   * the three.
   */
  'regex.tavernList': z.strictObject({
    chatId: z.string().min(1),
    tier: z.enum(['global', 'character', 'preset']),
  }),
  /**
   * Replace one tier of regex rules wholesale.
   *
   * Upstream's `replaceTavernRegexes(regexes, option)`
   * (`src/function/tavern_regex.ts:260-329`): the tier is rebuilt from the
   * array, so a rule absent from it is deleted. `'global'` writes the profile's
   * own list, `'character'` writes **the chat's card** — upstream's
   * `writeExtensionField(id, 'regex_scripts', …)`, which really does rewrite
   * the card file — and `'preset'` is refused, because this host's preset
   * library is read-only (the same reason `ScriptSource` carries no `'preset'`).
   *
   * The caps are sized off the corpus rather than off a round number: the
   * largest single `replaceString` measured across 251 rules is **524,550
   * characters** (创世回廊 1.3's 「开局」), and a card writing its own tier back
   * has to be able to send its own rules. `regexScriptRequest`'s 100 kB cap
   * one screen up is for the *global* tier, which no card's rule reaches.
   */
  'regex.tavernReplace': z.strictObject({
    chatId: z.string().min(1),
    tier: z.enum(['global', 'character', 'preset']),
    regexes: z.array(z.strictObject({
      /**
       * Required. Upstream mints ids lazily and would accept a rule without
       * one, but an id is how a stored rule's unnamed fields
       * (`substituteRegex`, and anything a file carried that this vocabulary
       * has no word for) are matched back to it — see the handler.
       */
      id: z.string().min(1).max(200),
      /** Blank is accepted: upstream renames it to `未命名-${id}` on the way in. */
      script_name: z.string().max(300),
      enabled: z.boolean(),
      find_regex: z.string().max(2_000_000),
      replace_string: z.string().max(2_000_000),
      trim_strings: z.array(z.string().max(10_000)).max(200),
      source: z.strictObject({
        user_input: z.boolean(),
        ai_output: z.boolean(),
        slash_command: z.boolean(),
        world_info: z.boolean(),
        reasoning: z.boolean(),
      }),
      destination: z.strictObject({ display: z.boolean(), prompt: z.boolean() }),
      run_on_edit: z.boolean(),
      /** `null` is the unset spelling, as upstream normalises it. */
      min_depth: z.number().int().min(-1).max(10_000).nullable(),
      max_depth: z.number().int().min(0).max(10_000).nullable(),
    })).max(1000),
  }),
  /**
   * Run this chat's regex chain over one string.
   *
   * Upstream's `formatAsTavernRegexedString(text, source, destination, {depth,
   * character_name})` (`src/function/tavern_regex.ts:27-73`), which calls
   * `getRegexedString` with `isMarkdown: destination === 'display'` /
   * `isPrompt: destination === 'prompt'`
   * (`extensions/regex/engine.js:334-381`), then expands macros over the
   * result, then applies any `registerMacroLike` macros.
   *
   * Answered in the host rather than in the frame **because that is where the
   * rules are** — see `regex.tavernList` for the measurement that settled it —
   * and the by-product is that it runs the very chain the reader's page and the
   * outgoing prompt run (`entry.scripts`), so the three cannot disagree.
   */
  'regex.tavernFormat': z.strictObject({
    chatId: z.string().min(1),
    /** Sized as `regex.tavernReplace`'s bodies are; a card may format a page. */
    text: z.string().max(2_000_000),
    source: z.enum(['user_input', 'ai_output', 'slash_command', 'world_info', 'reasoning']),
    destination: z.enum(['display', 'prompt']),
    /**
     * How far from the end of the chat this text sits, `0` being the last.
     *
     * Absent means **do not consider depth at all** — upstream's own wording,
     * and its engine's `typeof depth === 'number'` gate: a rule with a depth
     * window applies regardless.
     */
    depth: z.number().int().min(0).max(100_000).optional(),
    /** Upstream's `character_name`; absent uses the chat's own character. */
    characterName: z.string().max(300).optional(),
  }),
  // —— family④: lorebook / worldbook ——
  /**
   * Delete a named world book, file and all.
   *
   * The write half of the family that `worldbook.names` reads, and the one arm
   * of it that destroys something the user may be the only holder of — so it is
   * its own method rather than a flag on another, and the answer carries a
   * report instead of a bare success.
   *
   * **Upstream's `deleteWorldInfo` (`world-info.js:4234`) is the model, and it
   * does three things this copies and two it cannot.** Copied: a name with no
   * file behind it answers `false` rather than raising — that is upstream's own
   * first line, and it is why `deleteLorebook`/`deleteWorldbook` are typed
   * `Promise<boolean>`; the file goes; and the name is dropped from the
   * **global selection**, because upstream splices `selected_world_info` and
   * saves the settings (`world-info.js:4253`). Not copied: the two UI-local
   * clears — `#character_world` for whichever card happens to be open
   * (`:4262`) and the persona lorebook field (`:4270`) — have no equivalent
   * here, and the first is a write into the card file, which this host has no
   * arm for at all.
   *
   * **Every other binding is left dangling, which is upstream's behaviour
   * rather than an omission.** A character's additional books
   * (`worldbook.setCharBooks`) and a chat's own book (`worldbook.bindChat`)
   * keep naming a book that is gone; upstream touches neither, every reader
   * here already treats a name with no file as unbound
   * (`getChatWorldbookName`, `resolveCardWorldbook`'s rules 2 and 4), and
   * clearing them would make a delete rewrite settings the caller never
   * mentioned. What the answer does instead is **say so**, which is the part
   * upstream has no channel for.
   */
  'worldbook.delete': z.object({
    /** The book's name, exactly as spelled — not an id, like `worldbook.get`. */
    name: z.string().min(1).max(120),
  }),

  // —— family①: identity & messages ——
  /**
   * One character card, projected the way Tavern Helper's `getCharacter` does.
   *
   * **Scoped to the conversation's own character, and that is a narrowing.**
   * Upstream takes any name in the library and hands back the whole card
   * including its script bodies; here `name` must be `'current'`, or the open
   * chat's character by name or by id, and anything else is refused by
   * `unsupported` naming the narrowing. The reason is not the bytes: a card
   * script runs under a per-card consent (`notes/apps/iris-web/GRANTS.md`), and
   * a member that reads a *neighbouring* card's regexes and script bodies would
   * let one card's grant answer for another's. Zero corpus scripts call it, so
   * the narrowing costs no measured behaviour.
   *
   * `chatId` rather than `characterId` for the reason `script.context` takes
   * one: the conversation is what a frame is anchored to, and the character is
   * derived from it rather than asserted by the asking frame.
   */
  'script.getCharacter': z.object({
    chatId: z.string().min(1),
    /** `'current'`, or the open chat's character by name or by id. */
    name: z.string().min(1).max(200),
  }),
  /**
   * The conversations of the open chat's character, as a brief list.
   *
   * Upstream's `getChatHistoryBrief(name)` takes a character; this takes the
   * chat and answers about that chat's character only — the same narrowing
   * `script.getCharacter` makes, for the same reason. A card asking about
   * `'current'`, which is the only spelling the corpus uses anywhere, gets
   * exactly upstream's answer.
   *
   * Rows, never floors: the detail arm below is a separate call, because
   * upstream's two members are separate calls and because a brief list of a
   * character with forty conversations must not ship forty chat files.
   */
  'script.chatHistoryBrief': z.object({ chatId: z.string().min(1) }),
  /**
   * The floors of named past conversations of the open chat's character.
   *
   * Upstream's `getChatHistoryDetail(data)` takes the brief rows back and
   * fetches each file; this takes their `file_name`s. **Every file must belong
   * to the same character as the open chat** — checked here, not in the frame,
   * because the frame is the untrusted side and a card naming another
   * character's file is asking to read past a grant boundary.
   *
   * `isGroupChat` is upstream's second parameter and has no counterpart here:
   * this host has no group chats, so the flag could only be a lie in one
   * direction. The frame accepts it, ignores it, and says so once.
   */
  'script.chatHistoryDetail': z.object({
    chatId: z.string().min(1),
    /**
     * The `file_name`s from `script.chatHistoryBrief`.
     *
     * Capped at 50 — upstream caps nothing and fetches every file in parallel,
     * which on this host is a request whose answer size is set by the corpus
     * rather than by the request. A card wanting more asks twice.
     */
    files: z.array(z.string().min(1).max(300)).min(1).max(50),
  }),
  /**
   * Rotate a span of floors, upstream's `[begin, middle, end)` three-index form.
   *
   * A host arm rather than a composition of `script.setChatMessages`, and the
   * difference is not convenience: that arm carries a floor's **text** and
   * nothing else (its own answer reports the fields it cannot carry), so a
   * rotation built out of it would move the words while leaving every speaker
   * name, role, swipe list and per-floor variable table where it was. That
   * succeeds and corrupts. The chat file is the host's, so the splice belongs
   * here, where a line moves whole and `rebuild` carries its variables with it.
   *
   * Indices arrive signed and are clamped here exactly as upstream clamps them
   * (`_.clamp(normalizeMessageId(x), 0, chat.length)`, `middle` into
   * `[begin, end]`), so a card that asks for an impossible span gets upstream's
   * no-op rather than an error it has no handler for.
   */
  'script.rotateChatMessages': z.object({
    chatId: z.string().min(1),
    /** First floor of the span. Negative counts from the end, as upstream's does. */
    begin: z.number().int(),
    /** The floor that becomes first. */
    middle: z.number().int(),
    /** One past the last floor of the span. */
    end: z.number().int(),
    /**
     * Upstream's redraw switch, accepted and not acted on.
     *
     * The shell re-renders on the `chat.updated` broadcast this write already
     * emits, so `'affected'` and `'all'` are the same thing here; `'none'`
     * cannot be honoured, because there is no way to change the file and hold
     * the view. Recorded in the schema rather than dropped in the frame, so the
     * asymmetry is visible to whoever next builds a redraw arm.
     */
    refresh: z.enum(['none', 'affected', 'all']).optional(),
  }),
  // —— family③: preset ——
  /**
   * Create a library preset, or replace one that exists — Tavern Helper's
   * `createOrReplacePreset` (`@types/function/preset.d.ts:204`).
   *
   * **The one write primitive**, and deliberately the only one: upstream builds
   * `createPreset`, `replacePreset`, `setPreset` and `updatePresetWith` on top
   * of this single function (`src/function/preset.ts:596`, `:705`, `:718`,
   * `:731`), so five card members composed in the frame reach one arm here. An
   * arm per member would be five places for the same body to be validated
   * differently.
   *
   * The `render` option upstream's signature carries is deliberately **not**
   * here: it chooses between a debounced and an immediate re-render of
   * SillyTavern's own prompt-manager DOM, which this host does not have. The
   * refresh a write to `'in_use'` *does* have to trigger — every open
   * conversation's regex tier — is unconditional and lives in `#applyPreset`,
   * because getting that wrong leaves the previous preset's rules running with
   * nothing to show it (host §53).
   */
  'script.createOrReplacePreset': z.object({
    /** The library name, or `'in_use'` for the running body. */
    name: z.string().min(1).max(200),
    /**
     * The preset as a card sees it — Tavern Helper's shape, not the file's.
     *
     * The four fields are upstream's whole `Preset` (`preset.ts:9-53`), and the
     * three that are objects are `record`s rather than field-by-field schemas
     * on purpose: `extensions` is declared open upstream (`[other: string]:
     * any`) and real presets keep 200 KiB of a third-party extension's state in
     * it, so a schema that enumerated fields would silently drop what it did
     * not name and the preset would still save. The shape is checked where it
     * is *used* — `fromTavernHelperPreset` classifies every prompt by id and
     * throws by upstream's own rule for a repeated marker — so a malformed body
     * is refused with a sentence rather than trimmed into a plausible one.
     */
    preset: z.object({
      settings: z.record(z.string(), z.unknown()).optional(),
      prompts: z.array(z.record(z.string(), z.unknown())).max(2000),
      prompts_unused: z.array(z.record(z.string(), z.unknown())).max(2000).optional(),
      extensions: z.record(z.string(), z.unknown()).optional(),
    }),
    /**
     * Write only if the name is free — what `createPreset` needs and what
     * nothing else may pass.
     *
     * Upstream's `createPreset` answers `false` and writes **nothing** when a
     * preset of that name exists (`preset.ts:596-604`), deciding from its own
     * synchronous name list. A card face here has a name list too — the one on
     * the snapshot — but it is as fresh as the last snapshot, so deciding there
     * would leave a window in which `createPreset` silently *replaced* a preset
     * created since. The decision belongs where the file is: with this flag the
     * arm answers `created: false` and writes nothing, and the race cannot
     * destroy anything.
     */
    ifAbsent: z.boolean().optional(),
  }),
  /** Remove a library preset — `deletePreset` (`preset.d.ts:217`). */
  'script.deletePreset': z.object({
    /**
     * The library name. `'in_use'` is refused rather than obeyed: upstream's
     * signature excludes it (`Exclude<string, 'in_use'>`) and its
     * `preset_manager.deletePreset` has no entry to remove for it, so a host
     * that obliged would destroy the running body on a call upstream answers
     * `false` to.
     */
    name: z.string().min(1).max(200),
  }),
  /**
   * Rename a library preset — `renamePreset` (`preset.d.ts:227`).
   *
   * One arm rather than the create-then-delete the frame could compose, and the
   * reason is a data loss upstream has: its `renamePreset` calls `createPreset`
   * (which answers `false` and writes nothing when the new name is taken) and
   * then deletes the old one **unconditionally** (`preset.ts:696-703`), so a
   * rename onto an existing name destroys the source and returns `true`. This
   * arm refuses a taken target and leaves both presets standing — recorded as a
   * deliberate divergence in host §65.
   */
  'script.renamePreset': z.object({
    name: z.string().min(1).max(200),
    newName: z.string().min(1).max(200),
  }),
  /**
   * Load a library preset as the running one — `loadPreset`
   * (`preset.d.ts:169`).
   *
   * Goes through the host's `#applyPreset`, the same path `preset.select`
   * takes, so a card's switch and the panel's switch cannot mean different
   * things: the body becomes the assembler's input, the scalar fields it acts
   * on land in the global settings layer, and every open conversation's regex
   * tier is refreshed.
   */
  'script.loadPreset': z.object({
    name: z.string().min(1).max(200),
  }),
  // —— family③ end ——
} as const

/** Every callable method. */
export type RpcMethod = keyof typeof requestSchemas

/** The validated request body of one method. */
export type RpcRequest<M extends RpcMethod> = z.infer<(typeof requestSchemas)[M]>

/**
 * What the three `regex.*Preset*` methods answer with.
 *
 * Named rather than spelled three times, because the three are one reading —
 * a list and two writes that answer with the list they produced, exactly as
 * the scoped trio does. A shape repeated inline is a shape that drifts on the
 * fourth edit.
 */
export interface PresetRegexAnswer {
  /**
   * The preset the rules came out of, **absent** when the active preset has no
   * library name.
   *
   * That state is a host still assembling with the file its composition
   * configured, which upstream cannot represent. The allow-list is keyed by
   * name, so such a tier can never be permitted: `allowed` is `false`,
   * `scripts` is empty, and the panel says why rather than offering a control
   * that could not be honoured.
   */
  presetName?: string
  /** One row per runnable rule, in the preset's own order. */
  scripts: ScopedRegexView[]
  /** Whether the user has allow-listed this preset — absent from the store means no. */
  allowed: boolean
  /**
   * How many stored rows the reader refused.
   *
   * A rule with no `replaceString`, or with an **empty** `findRegex` — two of
   * the 40 rules in the one preset measured for §47 are UI separators of
   * exactly that shape, and an empty pattern matches at every position, so
   * running one would splice its replacement between every character of every
   * message. Reported rather than dropped in silence: a preset with 38 rules
   * and one with 40 of which 2 are unrunnable look identical otherwise.
   */
  malformed: number
}

/** What each method resolves with. */
export interface RpcResponseMap {
  /**
   * The sidebar list, and whether its order is one somebody arranged.
   *
   * `ordered` is **optional, and absent means the host keeps no arrangement** —
   * the same shape and the same reason as `chat.delete`'s `cleared` (§59): a
   * host without an order store cannot say "false, nothing is arranged", it can
   * only decline to answer, and a caller that reads a missing field as `false`
   * has manufactured a fact. It exists because the interface has one decision
   * to make with it: whether to offer the reader a choice between this order
   * and newest-first at all, which is a control that must not appear until
   * there are two different lists to choose between.
   */
  'chat.list': { chats: ChatSummary[], ordered?: boolean }
  'chat.create': { view: ChatView }
  'chat.open': { view: ChatView }
  'chat.delete': Record<string, never>
  'chat.rename': { chats: ChatSummary[] }
  /**
   * The list as it now reads, so the caller renders the host's answer rather
   * than its own optimistic guess.
   *
   * The array it returns is not necessarily the array it was sent: a chat the
   * request did not mention is still in the profile and still has to appear
   * somewhere, and the host's rule puts it on top (`chat-order.ts`).
   */
  'chat.reorder': { chats: ChatSummary[], ordered: boolean }
  /**
   * Chats with at least one matching floor, newest activity first.
   *
   * **No hit is never padded.** An empty array is the answer for "nothing in
   * this profile says that", and a caller that keeps showing a previous list
   * when it receives one is lying to its reader.
   */
  'chat.search': { hits: ChatSearchHit[] }
  /**
   * What the answer did.
   *
   * `backup` is present only when one was written, and it is a path under the
   * profile rather than a download: the export exists so the sweep is
   * survivable, and a file the host can still find is what makes it so.
   */
  'chat.answerCleanup': { cleaned: number, recorded: boolean, backup?: string }

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
  /**
   * The conversation with its new compaction record, and what the compaction did.
   *
   * `compacted` is `null` for the one non-failure that produces no summary:
   * there was nothing left to compact — a conversation of one floor, or one
   * already compacted up to its newest. That is an answer, not a refusal, so it
   * arrives as a result rather than as an error, and the view still comes back
   * so a caller cannot end up holding a staler one than it started with.
   *
   * Every other outcome is a refusal with a code: the chat was generating
   * (`busy`), the provider failed (`provider-error`), or the model's summary was
   * not smaller than the history it would have replaced (`unsupported` — the
   * request was well formed and the answer is that compacting this would save
   * nothing).
   */
  'chat.compact': {
    view: ChatView
    compacted: null | {
      /** Floors newly folded into the summary by this compaction. */
      floors: number
      /** What those floors were estimated to cost. */
      spanTokens: number
      /** What the summary costs instead. */
      summaryTokens: number
    }
  }
  'chat.abort': Record<string, never>
  'chat.swipe': { view: ChatView }
  'chat.editMessage': { view: ChatView }
  'chat.deleteMessage': { view: ChatView }
  /** The new branch, already open, plus the refreshed list it now appears in. */
  'chat.branch': { view: ChatView, chats: ChatSummary[] }
  /** The conversation as stored, summary-shaped — the sidebar's own currency. */
  'chat.import': { chat: ChatSummary }
  /**
   * The JSONL text and the file name to save it under.
   *
   * The name is the chat's id, which is the name SillyTavern's own branch
   * fields (`chat_metadata.main_chat`) address it by — so a branch exported
   * with its parent still links up after a re-import on either host.
   */
  'chat.export': { filename: string, content: string }
  'prompt.itemize': { itemization: PromptItemization }
  /**
   * The comparison, or `undefined` when this conversation has fewer than two
   * recorded requests.
   *
   * `undefined` rather than a refusal: a chat whose first turn has just gone out
   * has nothing to compare and that is a normal state, not an error. A caller
   * shows nothing; a caller told `not-found` would show a failure.
   */
  'prompt.divergence': { divergence?: PromptDivergence }

  /** The stored table, so a card sees what its write actually produced. */
  'script.getVariables': { variables: Record<string, unknown> }
  'script.setVariables': { variables: Record<string, unknown> }
  'script.swipeTo': { view: ChatView }
  /** Upstream's `triggerSlash` resolves with the pipeline's result. */
  'script.slash': { result: string }

  /**
   * The names, and — only when `withCounts` was asked for — the same books
   * with their entry counts and their materialisation provenance.
   *
   * `books` is absent rather than empty when it was not asked for: a caller
   * that reads it as "no books have counts" would be reading the cheap call's
   * silence as a fact about the disk.
   *
   * When present it is in `names`' order and may be **shorter**: a file that
   * this host cannot parse is listed by name and left out here, so a broken
   * book shows up as a book with no count rather than as a book with none.
   */
  'worldbook.names': { names: string[], books?: WorldbookSummary[] }
  /**
   * The raw book, and **three answers rather than two**.
   *
   * - `book` present and an object — the saved file.
   * - `book: null` — a name was given and no book came back. Upstream returns
   *   `null` for a response that was not ok.
   * - **key absent** — no name was asked for, upstream's bare `return;`.
   *
   * The two empties are kept apart because upstream's caller keeps them apart,
   * and because they mean different things to a card: "you asked for nothing"
   * against "what you asked for is not there".
   */
  'worldbook.load': { book?: unknown }

  'worldbook.get': { entries: WorldbookEntry[] }
  /**
   * A name may be bound with no file behind it; 2 of 18 corpus bindings are.
   *
   * `card`, present only when `withCard` asked for it, is the host reporting
   * **its own** resolution of that binding —
   * which book actually plays, counted, and whether the name is one this host
   * minted. Kept beside `primary` rather than replacing it because they answer
   * different questions: `primary` is a fact about the card file, `card` is a
   * fact about this installation. They differ exactly when a materialisation
   * had to give the wanted name up, which is the case a reader cannot make
   * sense of without being told.
   *
   * Absent when it was not asked for, and absent on a host that keeps no book
   * store even when it was: "which book plays" has no answer there, and
   * `{source: 'none'}` would be a claim rather than a silence.
   */
  'worldbook.charNames': {
    primary: string | null
    additional: string[]
    card?: CardWorldbookView
  }
  /**
   * The card's books, in reading order: its own first, then the extra bindings
   * in the order the user made them.
   *
   * A card with no world info at all answers `{books: []}` — that is a fact
   * about the card, and the host was able to look. A host with no book store
   * refuses instead (see the request), so the empty list never has to carry
   * both meanings.
   */
  'worldbook.charDigest': { books: CardBookDigest[] }
  /** The book as stored, read back — so a writer sees what its partial produced. */
  'worldbook.replace': { entries: WorldbookEntry[] }
  'worldbook.globalSelect': { names: string[] }
  'worldbook.setGlobalSelect': { names: string[] }
  /** `created` is false when the book already existed — upstream's boolean, not an error. */
  'worldbook.create': { created: boolean }
  /** The binding as it now stands, read back from the chat header. */
  'worldbook.bindChat': { name: string | null }
  /** The character's full binding, read back after the write. */
  'worldbook.setCharBooks': { primary: string | null, additional: string[] }
  'worldbook.settings': { settings: WorldbookSettingsView }
  'worldbook.setSettings': { settings: WorldbookSettingsView }

  /** Newest first, so the snapshot a reader is looking for is the first one. */
  'backup.list': { backups: BackupSummary[] }
  'backup.preview': { preview: BackupPreview }
  /**
   * The conversation as it now stands, plus the snapshot the **previous**
   * version was saved as before the restore wrote over it.
   *
   * `previous` is absent when there was no live file to snapshot — restoring
   * into the hole a deletion left is a normal use, and there is nothing to
   * protect where nothing survives.
   */
  'backup.restore': { chat: ChatSummary, previous?: BackupSummary }
  'backup.delete': Record<string, never>

  /** The aggregate, and only the aggregate. */
  'usage.summary': { summary: UsageSummary }

  /**
   * The saved profiles, and the connection the host itself was started with.
   *
   * `host` is present only when the composition told this runtime what it is
   * generating through. Its absence means "this host does not describe its own
   * route", **not** "there is no route" — a host has always had one.
   */
  'connection.list': { profiles: ConnectionProfile[], activeId?: string, host?: HostDefaultConnection }
  'connection.save': { profiles: ConnectionProfile[], activeId?: string, host?: HostDefaultConnection }
  /**
   * The profiles that remain — and which settings layers stopped naming the
   * deleted one.
   *
   * `cleared` exists because a profile's `provider` is stored as a **reference**
   * to a runtime route rather than as a copy of its values (host §59): the
   * layer that named the deleted connection would otherwise keep naming it, and
   * the next generation on that layer would fail in the adapter registry
   * instead of here. Absent means this host does not clean the layers (the fake
   * client does not); `{ global: false, chats: [] }` means it does and nothing
   * was pointing at the profile.
   */
  'connection.delete': {
    profiles: ConnectionProfile[]
    activeId?: string
    host?: HostDefaultConnection
    cleared?: {
      /** Whether the global layer was returned to the host's configured route. */
      global: boolean
      /** The conversations whose own `provider` override was removed. */
      chats: string[]
    }
  }
  'connection.activate': { settings: GenerationSettings, activeId: string }
  /**
   * The probe's verdict, said in full even when it failed.
   *
   * A failed probe is a **result, not an error**: the method answered, and the
   * answer is "no, and here is the named reason" — so a form can render it
   * without a try/catch and the transport stays out of the story. `latencyMs`
   * is present either way, because "how long until it said no" is itself a
   * diagnosis.
   */
  'connection.test': {
    ok: boolean
    latencyMs: number
    /** Model ids from `GET /models`, in the endpoint's own order, when the probe succeeded. */
    models?: string[]
    /**
     * What is known about those ids' context windows, keyed by id.
     *
     * Sparse, and mixed by source: an id the endpoint annotated carries
     * `'provider'`, an id it did not but the host's table knows carries
     * `'table'`, and an id nothing knows is simply absent. Absent as a whole
     * when the probe failed — there is no list to annotate.
     */
    modelContexts?: Record<string, ModelContextLength>
    /**
     * Which key the probe actually sent — always, pass or fail.
     *
     * Present on every verdict, including the refusals that never left the
     * process, because the sentence a form shows differs by source: a `stored`
     * pass says the saved profile still works, and a `typed` pass says what is
     * in the field right now does. Never the key, and never enough of it to
     * reconstruct one.
     */
    keySource: ConnectionKeySource
    error?: ConnectionTestError
  }

  'character.list': { characters: CharacterSummary[] }
  'character.import': { character: CharacterSummary }
  'character.delete': Record<string, never>
  'character.duplicate': { character: CharacterSummary }
  'character.rename': { character: CharacterSummary }
  /** The card's bytes as base64, named for the download a browser saves. */
  'character.export': { filename: string, content: string }
  'character.setTags': { character: CharacterSummary }
  /** The star's new state, echoed so a caller need not diff the list. */
  'character.favorite': { characterId: string, favorite: boolean }

  /**
   * The settings in force, and — when a chat was named — which of them that
   * chat is overriding.
   *
   * `settings` is the merged read it always was: the global layer with the
   * chat's own values on top. `overrides` is the chat layer **by itself**, and
   * it exists because the merged value alone cannot answer "is this the
   * conversation's choice or the default showing through?" — a question an
   * interface has to answer before it can offer to undo the choice. Two
   * different `model` values that happen to be equal are indistinguishable in
   * the merge and distinguishable here.
   *
   * **Presence is scope, not emptiness.** `overrides` is present exactly when
   * the request named a `chatId` — `{}` then means "that chat overrides
   * nothing", a real answer. Absent means the read was of the global layer,
   * which is the bottom and has nothing to override. A reader that treats
   * absent as `{}` will report the global layer as an un-overridden chat.
   */
  'settings.get': { settings: GenerationSettings, overrides?: Partial<GenerationSettings> }
  'settings.set': { settings: GenerationSettings, overrides?: Partial<GenerationSettings> }

  'preset.list': { presets: PresetSummary[], active?: string, install?: string[] }
  'preset.select': { presets: PresetSummary[], active: string, manager: PresetManagerView }
  'preset.view': { manager: PresetManagerView }
  'preset.setEnabled': { manager: PresetManagerView }
  'preset.move': { manager: PresetManagerView }
  'preset.upsertPrompt': { manager: PresetManagerView }
  'preset.removePrompt': { manager: PresetManagerView }
  'preset.save': { presets: PresetSummary[], active: string }
  'preset.delete': { presets: PresetSummary[], active?: string }
  'preset.read': { name: string, preset: Record<string, unknown> }
  'preset.import': { imported: string[], skipped: { name: string, reason: string }[], presets: PresetSummary[] }
  'preset.importFile': {
    outcome:
      | { name: string, imported: true, overwritten: boolean, sensitive: readonly string[] }
      | { name: string, imported: false, reason: 'invalid-json' | 'not-a-preset' | 'unusable-name' }
    presets: PresetSummary[]
  }

  'persona.list': { personas: PersonaView[], activeId?: string }
  /** `persona` is absent when the id is unknown or nothing is active — not an error. */
  'persona.get': { persona?: PersonaView }
  'persona.set': { personas: PersonaView[], activeId?: string }
  'persona.delete': { personas: PersonaView[], activeId?: string }

  /** The global tier as stored, in run order — so a writer sees what survived. */
  'regex.list': { scripts: RegexScriptView[] }
  'regex.set': { scripts: RegexScriptView[] }

  /**
   * The card's own tier, and whether it may run.
   *
   * `allowed` is a plain boolean rather than the three-state `scriptsAllowed`
   * shape: nothing asks the question, so there is no "not asked yet" for a
   * reader to act on. The rows are listed **whether or not** the tier is
   * allowed, the way upstream's own panel lists them (`getRegexScripts`
   * defaults to `allowedOnly: false` and only the engine passes `true`) — a
   * refused tier that showed an empty list would read as a card with no rules.
   */
  'regex.scopedList': { scripts: ScopedRegexView[], allowed: boolean }
  'regex.setScopedAllowed': { scripts: ScopedRegexView[], allowed: boolean }
  'regex.setScopedEnabled': { scripts: ScopedRegexView[], allowed: boolean }

  /**
   * The active preset's own tier, and whether it may run.
   *
   * The same row shape as the scoped tier — one file's rules with the user's
   * two switches over each — because it is the same fact about a different
   * document, and a second view type would be two places to keep one panel's
   * reading in step. The envelope's own fields are on
   * {@link PresetRegexAnswer}.
   */
  'regex.presetList': PresetRegexAnswer
  'regex.setPresetAllowed': PresetRegexAnswer
  'regex.setPresetEnabled': PresetRegexAnswer

  /**
   * The user's own library. Global first, then this character's — run order.
   *
   * One flat list with each row naming its `scope`, rather than two fields.
   * Two fields would let a caller render them in an order the runtime does not
   * use, and the order is observable: a global script and a character script
   * that both write the same variable settle it by who ran last.
   */
  'scriptLibrary.list': { scripts: UserScriptView[] }
  'scriptLibrary.read': { script: UserScript }
  'scriptLibrary.save': { scripts: UserScriptView[], id: string }
  'scriptLibrary.delete': { scripts: UserScriptView[] }
  'scriptLibrary.setEnabled': { scripts: UserScriptView[] }

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

  /**
   * Retained reports, plus the three counters that make them trustworthy.
   *
   * `dropped` is required rather than decorative: a truncated bundle and a
   * complete one are otherwise identical, and "there was more before this" is a
   * state a reader acts on differently. `oldest` lets a page notice its cursor
   * has fallen outside the buffer. `kinds` is what the host declares it
   * collects, so an empty section can say **which** empty it is — collected and
   * quiet, or never wired. A page cannot infer that from a count of zero, and
   * a diagnostic page reporting "all clear" when it means "not instrumented" is
   * the one lie it must never tell.
   */
  /** The value as stored, so a writer sees what survived. */
  'storage.set': { value: string }
  /** Whether a key was there to remove. */
  'storage.remove': { removed: boolean }
  /** How many keys went, and how many of those belonged to other cards. */
  'storage.clear': { removed: number, foreign: number }

  'debug.reports': {
    reports: DebugReport[]
    dropped: number
    oldest: number
    kinds: readonly string[]
  }
  /** The fetched body. Refusals arrive as an `unsupported` rejection. */
  'script.fetch': { content: string, contentType?: string }

  'script.context': { context: ScriptContext }
  /** The metadata as stored, so a card can see what survived. */
  'script.saveMetadata': { metadata: Record<string, unknown> }
  'script.createChatMessages': { view: ChatView }
  'script.deleteChatMessages': { view: ChatView }
  /**
   * One whole preset, in Tavern Helper's shape.
   *
   * **This used to be `{ prompts }` alone** — four fields per prompt, chosen
   * because the corpus's one call site reads only those four. That was the
   * right minimum for a read and the wrong shape for a *write*: every write
   * member upstream is a read-modify-write over the whole `Preset`
   * (`setPreset` → `updatePresetWith` → `getPreset` + `replacePreset`), so a
   * partial read would have a card save back a preset whose settings and
   * unused prompts had been silently replaced with nothing. The narrow reply
   * also disagreed with upstream on three points nothing had noticed, because
   * nothing was reading it: it returned **every** prompt where upstream returns
   * only the ordered ones, in **file order** where upstream returns them in the
   * ordering's order, and it called an unordered prompt `enabled: false` where
   * upstream puts it in `prompts_unused` carrying its own flag.
   *
   * Untrimmed, unlike the copy that rides `ScriptContext.preset.inUse`: this is
   * one round trip on demand, not a structured clone per live frame, so the
   * 5 MiB of `extensions.tavern_helper` the heaviest real preset carries is a
   * cost only the caller who asked for it pays.
   *
   * **`Record<string, unknown>` rather than the named type, and that is not
   * laziness.** The shape is `TavernHelperPreset` in
   * `@iris/compat-tavernhelper-core/src/preset.ts`, which is where it has to
   * live: the frame needs its `default_preset` and its three type guards as
   * *runtime* values, and the browser's import allowlist admits that package
   * only because it imports nothing at all (`architecture.test.ts:135`,
   * `purity.test.ts`). This package, in turn, imports no `@iris` package —
   * every other one depends on it. So the two contracts meet exactly here, and
   * the choice is between a second declaration that can rot and an untyped
   * field with a pointer. `preset.read` answers a preset body the same way, for
   * a smaller version of the same reason.
   */
  'script.getPreset': { preset: Record<string, unknown> }
  'script.evalTemplate': { text: string }
  /** The table as stored, so a writer sees what its replace produced. */
  'script.replaceScriptButtons': { buttons: { name: string, visible: boolean }[] }
  'script.saveChat': Record<string, never>
  'script.setExtensionPrompt': Record<string, never>
  /** How many injections that run had left behind. */
  'script.runEnded': { cleared: number }
  /** The settings as stored, so a card can see what survived. */
  'script.setExtensionSettings': { settings: Record<string, unknown> }
  'script.generateRaw': { text: string }
  'script.generate': { text: string }
  'script.setChatMessages': { view: ChatView }

  // —— family②: regex ——
  'regex.tavernList': { regexes: TavernRegexView[] }
  /**
   * The tier as it stands **after** the write, read back from storage.
   *
   * Read back rather than echoed, for `worldbook.replace`'s reason: the write
   * renames a blank `script_name` and carries unnamed fields across by id, so
   * the caller's array and the stored tier differ wherever that happened —
   * and those are exactly the changes a card needs to see. It is also what
   * `updateTavernRegexesWith` returns.
   */
  'regex.tavernReplace': { regexes: TavernRegexView[] }
  'regex.tavernFormat': { text: string }
  // —— family④: lorebook / worldbook ——
  /**
   * What the delete removed, and what it deliberately left behind.
   *
   * `deleted` alone is what the card-facing member answers with, because
   * upstream's is `Promise<boolean>` and nothing else can travel that
   * signature. The rest is for the reader of a host report: a delete is
   * irreversible, and the facts that make it comprehensible afterwards —
   * whether a selection changed, and which bindings now name nothing — are
   * unrecoverable once the file is gone.
   */
  'worldbook.delete': {
    /** False when no book had that name; upstream's answer, not an error. */
    deleted: boolean
    /**
     * Whether the name was in the global selection, and so was dropped from it.
     *
     * Upstream's own delete does this (`world-info.js:4253`), and it is the one
     * binding this method rewrites.
     */
    clearedGlobalSelect: boolean
    /**
     * Bindings left naming a book that is gone — upstream leaves these too.
     *
     * `characters` are the ids whose **additional** books named it, read from
     * the settings layer (one file). `materialisedFor` are the ids whose
     * embedded book this was the host's materialised copy of, read from the
     * binding table (one file) — those cards fall back to the copy inside the
     * card, which `resolveCardWorldbook`'s rule 2 already does.
     *
     * A card's own `extensions.world` primary binding is **not** scanned, and
     * neither are chat bindings: the first costs decoding every card in the
     * library and the second a read of every chat file, for a sentence beside a
     * delete. Both dangle silently, exactly as they do upstream.
     */
    dangling: { characters: string[], materialisedFor: string[] }
  }
  // —— family①: identity & messages ——
  /** The card, projected as upstream's `getCharacter` projects it. */
  'script.getCharacter': { character: CardCharacter }
  /**
   * The character's conversations, newest activity first.
   *
   * The open chat is **in** the list, as it is in upstream's: upstream asks
   * SillyTavern for every chat file of the character and the current one is a
   * file like the rest. A card wanting the others compares against
   * `getCurrentChatId()`, which it already has.
   */
  'script.chatHistoryBrief': { chats: ChatHistoryBriefRow[] }
  /**
   * The requested conversations' floors, keyed by the `file_name` asked for.
   *
   * A file that could not be read is **absent from the map** rather than
   * present and empty, which is upstream's own behaviour (its per-file fetch
   * returns early on a non-ok response and never writes the key) and is the
   * distinction a caller needs: an empty conversation and an unreadable one are
   * different answers.
   *
   * Floors arrive in SillyTavern's storage shape, like `ScriptContext.chat`,
   * **without** the per-floor variable tables: those are another
   * conversation's state, they are the bulk of a chat file, and upstream's
   * consumers of this member read `mes` and `name`.
   */
  'script.chatHistoryDetail': { chats: Record<string, ScriptChatMessage[]> }
  'script.rotateChatMessages': { view: ChatView }
  // —— family③: preset ——
  'script.createOrReplacePreset': {
    /**
     * True when the name was new — upstream's return value for
     * `createOrReplacePreset` (`preset.ts:657`), and the value `createPreset`
     * reads to decide whether it created anything.
     */
    created: boolean
    /**
     * Which `extensions` keys the host put back from the stored body.
     *
     * Present and empty is the normal answer. A non-empty list means the card
     * handed back a preset it had got from the *frame's* trimmed copy, and this
     * host restored the sub-trees that copy had left out — so upstream's own
     * documented round trip (`const p = getPreset('in_use'); …; await
     * replacePreset('in_use', p)`) does not delete a preset's script library as
     * a side effect. Reported rather than silent, because a restore means the
     * write was not literally what the card asked for.
     */
    restored: string[]
  }
  /** Whether a preset was there to remove — upstream's `deletePreset` boolean. */
  'script.deletePreset': { deleted: boolean }
  /**
   * Whether the rename happened.
   *
   * False for a source that does not exist, **and** for a target name already
   * taken — where upstream returns true having destroyed the source. The
   * `reason` says which, so a card that only sees `false` still logs something
   * a person can act on.
   */
  'script.renamePreset': { renamed: boolean, reason?: 'no-such-preset' | 'name-taken' }
  /** Whether the switch happened — upstream's `loadPreset` boolean. */
  'script.loadPreset': { loaded: boolean }
  // —— family③ end ——
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
    /**
     * The card storage is full.
     *
     * Its own code rather than `invalid-request`, because the frame has to turn
     * it into the exception a card already knows: a browser refusing
     * `setItem` throws `QuotaExceededError`, and cards in SillyTavern are
     * written against that. A generic failure would make them handle a case
     * they already handle, under a name they do not recognise.
     */
    | 'quota-exceeded'
    /**
     * No saved provider is in use, so there is nothing to generate through.
     *
     * Its own code rather than `invalid-request`, because the request was
     * perfectly well formed and the fix is somewhere else entirely: the
     * connection card, where a provider is added and put in use. The user's
     * ruling of 2026-09-10 retired the host's own launch route as a fallback
     * (「以后都从在 Iris 中自己添加供应商来调用模型」), and a refusal that named
     * no next step would be the worse half of that change — so the code exists
     * to let the interface say which card to open, in the reader's own
     * language, rather than passing through a host sentence about routes.
     *
     * Raised at the one funnel every generation passes (host §61), so it
     * reaches a turn as `stream.error`'s code and an `script.generate` as this.
     */
    | 'no-provider'
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
