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

- **Creating a book.** Upstream's `createWorldbook` / `createOrReplaceWorldbook`
  exist; no corpus card calls them.
- **`charLore` extra books.** `CharWorldbookNames.additional` is always empty:
  the measured installation has a `world_info` section — under
  `world_info_settings`, not at the top level — and it carries `globalSelect`
  but no `charLore`. So the mechanism has never been exercised by real data,
  though not because the section is missing. An earlier version of this section
  said it was, having read the top-level path; the conclusion survived, the
  reason did not. The shape comes from upstream's source, not from a file.
- **Global selection.** `world_info.globalSelect` is likewise absent, which is
  why the corpus has 2 books that no card binds and nothing can currently reach.
- **`render: 'debounced' | 'immediate'`.** It redraws upstream's world book
  editor panel; this host has no such panel. If the frame needs a "this book
  changed" signal, that is a broadcast to add, not this option to port.
