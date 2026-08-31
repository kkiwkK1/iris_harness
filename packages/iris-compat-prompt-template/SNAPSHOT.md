# Filling a `Snapshot` — the host-side seam

Everything the evaluator can read arrives in one object, pushed once per batch.
This document is the contract for building it. The type is in `src/types.ts`; this
says what each field must *contain*, and — more importantly — what must already
have happened to the text before it gets here.

Owned host-side, because it needs `@iris/variables` and the world-book store, and
this package is L0 by design: it depends on nothing of ours, so that the process
boundary is the only thing between it and the card's code.

## The one precondition that is not obvious

**Text arrives macro-substituted and regexed. Both. Already done.**

Upstream's per-field order is:

```
substituteParams (macros)  →  applyRegex  →  EJS
```

and both halves are load-bearing on real cards, not theoretical:

- `命定之诗与黄昏之歌v3.0.4` writes `<%_ if ({{roll 1d100}} >= 100) { _%>` — an ST
  macro **generating the JavaScript source**. Hand this evaluator the
  unsubstituted text and it is a syntax error, not a template.
- `可攻略女主拒绝被攻略` has a `USER_INPUT` regex whose `replaceString` emits a
  whole `<%= getvar('stat_data.App系统状态.运行人格路线') %>` tag for this engine
  to evaluate. Run the regex *after* the templates and that tag reaches the model
  as literal text.

This applies to `items[].text` **and** to `snapshot.worldInfo[].content`, which
is why the world-info entries are pushed as text rather than as records to be
processed later.

## Where a batch comes from

Upstream evaluates at `GENERATE_AFTER_DATA` / `CHAT_COMPLETION_SETTINGS_READY` —
that is, over the **already-assembled message array**, evaluating every message's
content. Not per source field. So the seam in our pipeline is *after* assembly
and *before* the provider call.

One `EvalItem` per assembled message — and **only** that. World-info entries are
not items: their text is already folded into the assembled messages by then, and
`snapshot.worldInfo` exists so `getwi` has something to search, not so entries can
be evaluated one by one.

`origin` is upstream's `filename`, which only ever shows up in an error message;
upstream uses `generate/<chatId>/<index>` for messages and
`worldinfo/<world>/<uid>-<comment>` for entries, and matching that makes an error
report recognisable to someone who knows their SillyTavern.

**Not implemented, and worth knowing it is missing:** upstream *also* evaluates
some entries individually and earlier, at `WORLDINFO_ENTRIES_LOADED` — the ones
carrying `@@preprocessing`, `@@if`, `@@private`, or a `[GENERATE:*]` title. Those
run before assembly, with their own `world_info` in scope, and their output is
what goes into the prompt. The corpus has 117 `@@preprocessing` entries in one
card (and 234 across the disk books) and zero `[GENERATE:*]` titles. When that
pass is built it will add a second item kind with `locals.world_info` set, ahead
of the assembled messages in the same batch. Nothing about the current contract
has to change for it.

## Field by field

### `items: EvalItem[]`

```ts
{ id: string, text: string, origin: string, locals?: Record<string, Json> }
```

- **`id`** — minted by the host, opaque here. Do not derive it from position or
  content: `ARCHITECTURE.md` records what that cost last time.
- **`text`** — see the precondition above.
- **`origin`** — for error messages only.
- **`locals`** — per-item environment additions. In practice: **leave it unset.**

  An earlier version of this document said a world-info entry must carry
  `{ world_info: entry }`. That was wrong, and it was wrong in the direction that
  matters, so the correction is spelled out rather than quietly edited.

  World-info entries are **not items**. By the time the batch is built their text
  is already inside an assembled message, and upstream is in the same position:
  its `processGenerateAfter` pass evaluates assembled message content with no
  `world_info` in scope at all. `world_info` is set by upstream only when an entry
  is evaluated *in its own right* — the `@@preprocessing` and `[GENERATE:*]`
  decorator entries, which this package does not yet implement — and for
  `getwi`'s own recursion, which the evaluator sets for itself.

  So `getwi(null, …)` inside ordinary assembled text does not resolve through
  `world_info`. It resolves through `lorebooks`, below.

**Order is the contract.** Items are evaluated in array order, sharing variable
state, so a `setvar` in item 3 is visible to item 4 — because upstream is writing
to the live application and later entries in one generation do see earlier
writes. Push them in the order upstream would evaluate them.

### `variables: Record<Scope, Json>`

Four scopes, **unmerged**. The evaluator recomputes upstream's merged view
itself, because `getvar(key, 'global')` has to be able to see past the merge.

| Field | Upstream's store | Suggested Iris source |
|---|---|---|
| `global` | `extension_settings.variables.global` | `{ type: 'global' }` |
| `local` | `chat_metadata.variables` | `{ type: 'chat' }` |
| `message` | `chat[i].variables[swipe_id]` | `{ type: 'message', message_id }` for the turn being generated |
| `initial` | `STATE.initialVariables` | **your call** — see below |

`initial` is the one that needs a decision. Upstream fills it from the card's
shipped starting state: `@@initial_variables` world-info entries plus the
`variables` that ship beside a card's scripts, which `@iris/script` already
extracts as `CardScriptBundle.variables`. It is *not* `{ type: 'character' }`,
which is a live store with a different lifetime. If nothing populates it yet,
push `{}` — the corpus never reads `initial` explicitly, it only participates in
the merge.

The merge the evaluator performs, transcribed from `precacheVariables`:

```ts
Object.assign({}, global, initial, local, message, { _trace_id, _modify_id: 0 })
```

**Shallow**, and in that precedence order: message wins, global loses. A card
keeping `stat_data` in two scopes gets the later one *entire*, not a union. If
the host merges deeply on the way in, cards change behaviour in a way nothing in
one generation would reveal.

### `chatMetadata: Json`

`SillyTavern.chatMetadata`. The whole object, since a card indexes into it by its
own keys — `(SillyTavern.chatMetadata || {}).yinqi_story_flags` in the corpus.

It is the only member of `SillyTavern` that is bridged, along with
`saveMetadata()`; anything else throws `UnsupportedTemplateApiError` naming the
member rather than returning `undefined`.

### `worldInfo: WorldInfoEntry[]`

```ts
{ world: string, uid: string, comment: string, content: string }
```

**Push every enabled entry, not a pre-filtered set.** The reachable set cannot be
computed host-side: 58 of the 62 `getwi` call sites pass a literal title, but 4
compute it at runtime and one of those builds a `RegExp` from a variable
(``getwi(null, `^${charName}$`)``). Filtering statically silently loses those.

Measured, this is cheap: 882 entries, 3.12 MiB, 4–16 ms over the IPC channel.

- `comment` is the entry's **title**, which is what `getwi` matches on — by exact
  string, by regex, or falling back to `uid`.
- `content` is macro-substituted and regexed, as above.
- Entries the card's author disabled should not be here. So should entries from
  books that are not active for this chat: `getwi` searches what it is given.

### `lorebooks: { character?, persona?, chat? }`

Which book an unqualified `getwi` searches. **Exactly one book gets searched,
never the union** — this is the field that makes that possible, and it was
missing from the first version of this document.

Upstream's chain, from `getWorldInfoEntries`:

```js
const lore = name                                        // the explicit argument
  || characters[this_chid]?.data?.extensions?.world      // → lorebooks.character
  || power_user.persona_description_lorebook             // → lorebooks.persona
  || chat_metadata[METADATA_KEY]                         // → lorebooks.chat
  || ''                                                  // → nothing is searched
```

with the entry's own book slotted in ahead of `character` when there is one
(`boundedReadWorldinfo` passes `worldinfoOrEntry || this.world_info?.world || ''`).
`loadWorldInfo('')` finds nothing, so a chain that runs out means the lookup
fails and `getwi` returns `''` — it does **not** widen to every book.

Measured, this is the whole story for the corpus:

- **58 of 58** literal `getwi` call sites pass `null` as the book. Not one names
  a book explicitly.
- Both cards that call `getwi` have `data.extensions.world` set to a disk book
  that exists, and **58/58 targets resolve inside it**.
- **58/58 are exact `comment` hits**, 0 need upstream's regex fallback, and 0 are
  ambiguous — which is why the entry sort order is not reproduced (see
  `DEVIATIONS.md`).

So `character` is the field that carries this corpus. Fill the other two if the
host knows them; an absent field is skipped, matching upstream's `||`.

Matching within the resolved book is upstream's, one pass per entry:
`comment === title || uid === title || comment.match(title)`. The third is
`String.prototype.match`, so a plain string target is *also* tried as a regular
expression — and a title containing regex metacharacters throws, exactly as it
does upstream, surfacing as a failed item.

### `scalars: Record<string, Json>`

Upstream's flat environment values. Anything absent is not `undefined` in the
template — it is an unresolved identifier, so the template throws and the item
fails loudly. That is the intended failure, but it means the list is worth
filling even where the corpus is silent.

What upstream exposes, with corpus usage:

| Name | Corpus sites |
|---|---|
| `charName` | 2 |
| `userName`, `assistantName` | 0 |
| `chatId`, `characterId` | 0 |
| `charAvatar`, `userAvatar` | 0 |
| `groups`, `groupId` | 0 |
| `charLoreBook`, `userLoreBook`, `chatLoreBook` | 0 |
| `lastUserMessage`, `lastUserMessageId` | 0 |
| `lastCharMessage`, `lastCharMessageId`, `lastMessageId` | 0 |
| `model` | 0 |

`assistantName` and `charName` are the same value upstream (both `name2`).

Deliberately **not** bridged, and refused by name if a template reaches for them:
`execute` (slash commands), `SillyTavern.getContext`, `$`, `z`, `toastr`,
`faker`, `injectPrompt`, `jsonPatch`, `define`, `getchr`, `getprp`, `getqr`,
`activateRegex`. All are 0 sites in the corpus, and all are how a template would
reach the application rather than its data.

### `traceId: number`

Upstream stamps an incrementing `_trace_id` into the variable cache each time it
rebuilds it. Pass a counter that increases per batch. Nothing in the corpus reads
it; it exists so that a card that does sees what it expects.

## What comes back

```ts
{ results: { id, result }[], ops: Op[], timedOut: boolean }
```

- **`results`** is in request order, one per item. `result.ok === false` means
  **keep the original text** — that is upstream's behaviour, and it is why a
  failure is a value here rather than an exception. One broken entry must not
  cost a generation.
- **`ops`** is every write, in the order the templates performed them, described
  rather than applied:

  ```ts
  { op: 'setvar', scope, key, value } | { op: 'delvar', scope, key }
  | { op: 'insvar', scope, key, value, index? } | { op: 'saveMetadata', value }
  ```

  Apply them through the host's own storage entry points — `assertStorable` and
  whatever else guards a write. That is the point of describing rather than
  applying: a template cannot bypass a check the host makes on the way in.

  `key` is a lodash path (`stat_data.银麒系统.账户.银麒点`). `scope` is
  `global` / `local` / `message` and maps back the same way as the table above.
  The default write scope is **`message`**, not the read default — upstream's
  asymmetry, and reproduced here.

  **`initial` never appears in an op.** A template writing it is refused at the
  evaluator with a named error, so the host needs no branch for it: upstream
  allows the write into an in-memory store that evaporates with the page, and
  Iris has no equivalent — `initial` is a projection of the card file, so the
  write would either vanish silently or edit the card. Silence is the thing this
  project rejects, so it is refused loudly instead. `DEVIATIONS.md` records it.

  **Ops from a failed item are still present, deliberately.** Upstream applies a
  `setvar` the moment it runs, so a template that writes and then throws has
  already written. Dropping those would be tidier and would not match what the
  user's SillyTavern does.

- **`timedOut`** means the child was killed for overrunning. Items that had
  already streamed back are kept; the rest report a failure naming the timeout,
  so the "keep the original text on failure" path handles them with no special
  case.

## Acceptance

The differential test: run the corpus's 204 EJS-bearing fields through this seam
and compare against upstream's own engine, which is where the 204/204 compile
figure came from. That harness is the acceptance criterion for the wiring, not
just for this package.

## What is not decided here

`Snapshot` is versioned with the batch (`v: 1`). Adding a field is cheap; changing
the meaning of one is not. If something is missing, say so before working around
it — a workaround host-side becomes a second definition of the contract.
