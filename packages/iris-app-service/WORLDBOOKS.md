# World books

Where a character's world info comes from, which of the two possible sources
wins, and what a card script can do to a book. The pieces live in
`src/worldbooks.ts`, the contract's `worldbook.*` methods, and
`DEVIATIONS.md §3`; this is the entry point that connects them.

Upstream references are line numbers in the installed copies:
`E:/sillyTavern/SillyTavern/public/scripts/world-info.js` for the application,
`.../data/default-user/extensions/JS-Slash-Runner/src/function/worldbook.ts` for
the card-facing API. Corpus measurements are dated and were taken 2026-09-02;
`scripts/worldbook-source-census.mjs` reproduces them.

---

## 1. There are two kinds of book, and only one of them is read

A card can carry world info in two places, and they are not two halves of one
thing:

| | where it lives | read at runtime? |
| --- | --- | --- |
| **embedded book** | `data.character_book` inside the card file | **no**, upstream |
| **named book** | `worlds/<name>.json`, referenced by `data.extensions.world` | yes |

`getCharacterLore()` (`world-info.js:4363`) gathers `data.extensions.world` and
`world_info.charLore[…].extraBooks` — named books only. It never touches
`character_book`. The embedded book is an **import-time** source: the only
runtime path that reads it is `world-info.js:5618`, which asks the user, runs
`convertCharacterBook`, saves the result under a name, and binds that name onto
the card. After that the embedded copy is a leftover.

This is the fact the whole design turns on, and it is easy to get backwards. On
the corpus, 15 cards carry both; 14 of them are identical entry for entry, and
the fifteenth differs by one entry edited after the import. **The bound book is
the embedded book, copied.**

## 2. Choose one source, never combine them

`resolveCardWorldbook(card, store)` in `src/worldbooks.ts` is the only place this
decision is made. Three rules, in order:

1. **A binding that resolves wins.** Upstream's semantics, and also the copy the
   user edits — where the two disagree, the named one is the newer.
2. **Otherwise fall back to the embedded book.** Deliberately better than
   upstream, which reads nothing here until the user accepts an import prompt.
   Their prompt guards a migration that writes a file and rebinds a card; this
   fallback only reads, so it has nothing to ask permission for. Two corpus cards
   depend on it for 102 and 153 entries they would otherwise lose.
3. **Never both.** Assembling both sources gives 2246 entries across the corpus,
   1122 of them the same text twice. That failure does not throw, does not show
   in a diff, and reaches a reader as a model that has begun repeating itself.

The choice is made once, when the chat opens, and hangs on
`ChatEntry.worldbook`. Three consumers read it — `worldInfoOf` (the EJS `getwi`
surface), `scanEntriesOf` (activation scanning), and `entry.initVars()` (the
`[InitVar]` declared tree). They read the resolved book rather than the card
because three consumers each digging into `card.data.character_book` is exactly
how they drift apart; `initVars` was the one that had already drifted, and a card
declaring `[InitVar]` only in its named book would have started with no declared
tree, making every later MVU `set` fail silently against a path that does not
exist.

A branch reuses its parent's resolution rather than re-resolving, so a book
changed on disk mid-conversation cannot make a branch disagree with its parent.

**What would overturn this section:** `tests/worldbook-source.test.ts`. Its
corpus case asserts that a card with both books resolves to *exactly* its named
book and keeps nothing that exists only in the embedded one.

## 2b. How many entries actually reach a prompt

`1478` is the number of entries on disk. It is an **upper bound**, and it was
written in this document and in `worldbooks.ts` without saying so, which reads as
a claim that it is the working figure. Measured by 3e (2026-09-02):

```
entries in the 18 book files                 1478   100.0%
  …in a book some card binds, or globally
    selected                                 1142    77.3%
  …and not disabled by its author             859    58.1%
       of which constant (always injected)    288    19.5%   ← firmest lower bound
       of which keyword-triggered             571    38.6%   ← depends on the conversation
          …with no keywords, so never firing     5     0.3%
       of which vectorized                      0     0.0%
  disabled                                    503    34.0%
```

**336 entries (22.7%) are on disk and reachable by no path at all**, and 333 of
those are one book — `缄默之秋2.5`, the largest in the corpus, bound by no card
and not globally selected. Any suspicion that this host is failing to read
content should rule that book out first.

Two layers are **not** in these numbers, so 288 is "survived the switches", not
"landed in the context": `world_info_budget: 100` trims after activation, and
`world_info_recursive: true` adds back. The 571 keyword-triggered entries depend
on what is actually said, so any single figure for them is false precision.

Scope: 19 corpus cards plus one sample card, and one installation's
`settings.json`. That exactly one book is globally selected is a fact about this
machine, not about the product.

## 2c. Globally selected books reach every character

A **third source**, added to the character's rather than chosen between — the
exception to §2, and for a reason: the embedded and named books are two copies of
one thing, while a globally selected book is a different thing. Upstream
concatenates it (`world-info.js:4478`).

- Stored as `worldbooks.globalSelect` in this host's own settings file, read
  fresh whenever a chat opens. Reachable over `worldbook.globalSelect` /
  `worldbook.setGlobalSelect`.
- **Dedup is mandatory.** `world-info.js:4387` skips a character's book when it
  is already active globally. Without it, the one card that binds a globally
  selected book receives every entry twice.
- **Order is `character_first`** on the measured installation
  (`world_info_character_strategy = 1`): the character's own entries, then the
  global ones. Order breaks activation ties, so it is behaviour.
- **`[InitVar]` seeding uses the opposite order.** MVU builds
  `[...selected_global_lorebooks, primary, ...additional]`
  (`MagVarUpdate/.../variable_init.ts:230`), so a global book's declaration is
  folded first and the character's wins where they overlap. Matching only one of
  the two orders would be plausible tidiness that changes behaviour.
- A selected book that no longer exists is skipped, not fatal.

Measured effect of turning this on, 2026-09-02: **18 cards gain 15 always-on
entries each; the 1 card that binds the selected book gains 0.** That zero is the
strongest assertion available — every other card gains legitimately, so only that
card can tell a fix from a duplication.

## 2d. There are five sources, and two of them jump the queue

Measured by the upstream-research domain (3c) against SillyTavern's own source,
2026-09-03, and **not yet independently reviewed** — the line numbers below are
one path, not two.

Beyond the embedded book, the bound book and the globally selected ones, two
more sources exist and **neither is implemented here yet**:

- **The chat book** — `chat_metadata['world_info']`, holding a **book name as a
  plain string**, not an object and not the entries (`world-info.js:94`). A
  chat book is minted as `` `Chat Book ${chatId}` `` with non-alphanumerics
  collapsed to underscores and truncated to 64 characters
  (`world-info.js:1176`), and the key is only honoured when
  `world_names.includes(...)` — delete the file and the key is ignored rather
  than erroring.
- **The persona book** — `power_user.persona_description_lorebook`,
  `getPersonaLore()` at `world-info.js:4452`.

**Copy the key's type as well as its name.** A corpus card (银麒赎世) contains
`if (wi.entries) entries = Object.values(wi.entries)` guarded on
`chat_metadata.world_info` — dead code today precisely *because* the value is a
string. Storing an object there would **wake that branch up**, in a card nobody
is testing.

### The ordering claim in §2c is too weak, and this is the correction

`world_info_character_strategy` orders **only the global and character sources**.
The chat and persona books are **prepended unconditionally**, ahead of
everything, with upstream's own comment saying so:

```js
// world-info.js:4512
// Chat lore always goes first, then persona lore, then the rest
entries = [...chatLore.sort(fn), ...personaLore.sort(fn), ...entries]
```

That is the candidate-table order, and the candidate table *is* the scan
traversal order (`:4632`). So a chat book's entries compete for budget ahead of
every other source. (**"First come, first served" is 3c's inference from the
traversal order, not a statement they read** — recorded as inference, not fact.)

Each source also carries a **per-book dedup guard**, and the direction is fixed:
a globally selected book wins over the chat book, and the chat book wins over
the persona book.

### Branching shares the chat book, deliberately

`chat_metadata` is `structuredClone`d into a branch, so the child inherits the
same **book name** — parent and child then read and write **one book**, not a
copy. Ruled 2026-09-03 to keep upstream's behaviour rather than clearing the key
or copying the book. A branch here is a save point the user jumps back to, and
someone resuming from one expects the same book; copying would let the two
silently diverge, and clearing would make the branch forget. The cost is real
and recorded rather than hidden: **a write on either side is visible to the
other**, and world books are rewritten whole, so the later writer replaces the
earlier one's entire book.

## 3. Names are used verbatim

A book's name is its identity, and it comes from another application's data. All
18 real names pass `isSafeId`, so none of them needs transforming — and **13 of
18 are changed by `toId`** (`创世回廊1.3` → `创世回廊1`,
`[SG]可攻略女主拒绝被攻略` loses its brackets). A card's binding holds the exact
name, so deriving an id would fail to find two thirds of the corpus's books while
looking entirely reasonable in code.

`WorldbookStore` asks `fileFor` for the containment guard and never transforms
the name.

## 4. The card-facing shape is not the stored shape

`toWorldbookEntry` translates; the two disagree in ways a card notices.

| stored | card-facing |
| --- | --- |
| `comment` | `name` |
| `disable` | `enabled` (negated) |
| `constant` / `vectorized` / `selective` | one `strategy.type` |
| `selectiveLogic: 0..3` | `strategy.keys_secondary.logic` |
| `position: 0..7` | `position.type` |
| `sticky: 0` | `effect.sticky: null` |
| `useProbability: false, probability: 25` | `probability: 100` |

Returning the stored shape would be a quieter kind of wrong: every field
present, several of them inverted.

One thing does **not** cross the wire. Upstream revives regex-shaped key strings
(`/foo/i`) into live `RegExp` objects before a card sees them. A `RegExp`
serializes to `{}`, so the host sends the strings it read and the revival belongs
to whoever hands the entries to a card, on the frame side.

## 5. Writing replaces the whole book

`worldbook.replace` → `WorldbookStore.replace`. An entry the caller left out is
gone, because that is what `createOrReplaceWorldbook` does: it builds the saved
file fresh from the array it is handed.

The append-only rule that governs the chat log does **not** apply. A book is a
document the user edits in another application, not a history this host is
custodian of.

- A book that does not exist is **not created** by replacing it, matching
  upstream's `replaceWorldbook`.
- The write goes through a temporary file and a rename. The alternative to an
  atomic replace is not an error but a *shorter book*: a crash midway through
  writing 167 entries leaves a file that parses fine and has lost half the world.
- `displayIndex` is reassigned from the array index, so **writing a book back
  reorders it** to whatever order the caller passed.
- Missing uids are assigned upstream's way — random below a million, quadratic
  probing on collision. Reproduced rather than simplified because uid is an
  entry's identity, and a book written here and reopened in SillyTavern has to
  agree about which entry is which.

`updateWorldbookWith` is **not** a host method and cannot be: it takes a
function. It lives in the frame on the `updateVariablesWith` precedent — read,
apply the caller's updater, call `worldbook.replace`, then re-read and return
what the file now says (upstream returns the re-read, not the updater's result).

### Two asymmetries that are upstream's, copied on purpose

Both are pinned by `tests/worldbook-write.test.ts`, so removing them is a red
line rather than a card that stops working.

1. **Omitting `strategy` means `constant: true`.** So
   `updateWorldbookWith(name, book => book.map(e => ({ uid: e.uid })))` does not
   mean "keep everything and change nothing" — it turns every entry in the book
   into an always-on one. The read direction maps a non-constant entry to
   `selective`, so a value that came out of `get` goes back in as `constant`
   unless the caller carries `strategy` with it.
2. **`useProbability` is always written `true`.** Benign: reading resolves the
   flag away, so the effective probability survives a round trip even though the
   stored flag does not.

Anyone reaching to fix either should note they are load-bearing compatibility,
not oversights — a card may depend on the behaviour, and correcting it is what
would break them.

## 6. What is not implemented

- **Creating a book.** Upstream's `createWorldbook`, `createOrReplaceWorldbook`,
  `deleteWorldbook` and `createWorldbookEntries` exist and are called by no
  corpus card. That zero was originally written without a measurement behind it;
  it has since been measured, by **bare member name** across 47 card scripts in
  19 cards — no `TavernHelper.` anchor, because a path-anchored pattern cannot
  see `window.parent.TavernHelper.x` or `getContext().x`, and its output for a
  member it cannot see is `0`, which reads as "unused" rather than "unsearched".
  Scope caveat: 47 card scripts is a **narrower source set** than the 121 sources
  (card scripts, rendered interface blocks, sample card) used for the census
  numbers elsewhere in this document, so this zero is weaker than one taken
  there.
- **`charLore` extra books.** `CharWorldbookNames.additional` is always empty:
  the measured installation has a `world_info` section — under
  `world_info_settings`, not at the top level — and it carries `globalSelect`
  but no `charLore`. So the mechanism has never been exercised by real data,
  though not because the section is missing. An earlier version of this section
  said it was, having read the top-level path; the conclusion survived, the
  reason did not. The shape comes from upstream's source, not from a file.
- **Migrating a selection from SillyTavern.** Global selection itself *is*
  implemented (§2c); what is not is adopting an existing installation's
  `globalSelect` value. Importing settings is its own unstarted piece of work,
  and silently following another application's live file would make this host's
  prompts depend on that application's current state. A user moving across
  re-selects their global books once.
- **`render: 'debounced' | 'immediate'`.** It redraws upstream's world book
  editor panel; this host has no such panel. If the frame needs a "this book
  changed" signal, that is a broadcast to add, not this option to port.
