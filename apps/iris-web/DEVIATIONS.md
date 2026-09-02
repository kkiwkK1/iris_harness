# Deviations from SillyTavern — the browser half

Where the interface and the card sandbox deliberately do something other than
what SillyTavern does, and what each difference was measured to cost. A deviation
with no measurement is a guess, so every entry names what it read and **what
would overturn it**.

The host keeps its own ledger at `packages/iris-app-service/DEVIATIONS.md`; this
one covers `apps/iris-web` — the shell, the frames, and the card-facing surface
inside them. Render-pipeline differences that need their surrounding argument are
worked out in `RENDER.md` and referenced from here rather than restated.

Two kinds of entry, and the difference matters more than the list:

- A **compatibility gap** is a place Iris is worse than upstream and intends to
  stop being. It carries what closing it would take.
- A **deliberate improvement** is a place Iris is different on purpose. It
  carries what it costs, because an improvement with no cost recorded is usually
  an unexamined preference.

---

## 1. An unbuilt member on the card surface yields `undefined` and is reported

**Kind:** deliberate improvement.

**Upstream.** Reading an absent property on `SillyTavern` — or on any object —
returns `undefined` and says nothing. That is not a SillyTavern decision, it is
JavaScript's, and every card is written against it.

**Iris** returns `undefined` too, and additionally reports the member by name
once, through the durable card-report channel. The virtual `parent` proxy has
worked this way since an earlier round; the `SillyTavern` surface was brought
into line with it, having previously thrown.

**Why the throw was wrong**, and why this is not merely a preference: every
measured `SillyTavern` access in the corpus sits behind a guard, and both guard
styles in use are defeated by a throwing getter.

| guard style | sites | what a throw does |
| --- | --- | --- |
| `if (ctx && ctx.eventSource && ctx.event_types)` | 18 | throws at the read |
| `if (typeof ctx.setExtensionPrompt === 'function')` | 4 | throws at the read |

`typeof` does not help: it guards an undeclared **identifier**, never a missing
**property**, and `typeof obj.x` still evaluates `obj.x`. The guard triggers the
thing it exists to prevent. The identical failure had already been paid for once
on the `parent` proxy, where throwing on a read-with-default broke upstream's
cross-script coordination inside an init that swallows exceptions.

**What it costs.** A misspelled member is now a silent `undefined` at the call
site instead of a named exception. The report is what buys that back, so the
report is not decoration — if it is ever made conditional or dropped, this entry
becomes a plain compatibility hazard.

**What would overturn it.** A measurement showing cards that rely on a throw to
detect absence — none does today; the corpus's habit is the opposite.

---

## 2. `chatMetadata` is not replaced when the snapshot refreshes

**Kind:** deliberate improvement, forced by a difference Iris cannot remove.

**Upstream.** `saveMetadata()` takes no argument. The idiom, and the one corpus
caller follows it exactly, is: mutate `chatMetadata` in place, then ask for it to
be saved. Upstream can do that because its metadata object is live and in the
same realm as the card.

**Iris** hands a card a snapshot across an origin boundary, and refreshes that
snapshot on every event that settles the chat. Everything in it is replaced
wholesale **except `chatMetadata`**, which the frame keeps for its lifetime.

**Why.** Without the exemption, any reply settling anywhere in the chat between a
card writing a key and calling `saveMetadata` swaps the object out from under it.
The save then proceeds, reports success, and stores the version without the
write. The window is not instantaneous: the corpus's caller saves on a 2000ms
debounce that every further write resets, so under continuous use it stays open
indefinitely, and what is lost is every write since the last save.

**What it costs.** A stale read — a metadata change made outside this frame does
not reach a card already running. That is visible and reversible; a discarded
write is neither, and disguises itself as success. No measured card reads
metadata it did not itself write.

**Guarded by** `sandbox-frame.test.ts`, in a pair: one test that the edit
survives, and one that **everything else still refreshes**. The second exists
because the cheapest way to stop a refresh discarding writes is to stop
refreshing, which would satisfy the first test perfectly while silently undoing
the live-snapshot work.

**What would overturn it.** A card that reads metadata written elsewhere, or a
host-side channel that lets the frame merge remote changes without clobbering
local ones.

---

## 3. `getCharWorldbookNames` serves only `'current'`

**Kind:** compatibility gap, scoped by measurement.

**Upstream.** `getCharWorldbookNames(character_name)` is **synchronous** and
accepts `'current'` or a character name. A named lookup matches
case-insensitively against both the character's name and its avatar filename, and
throws when nothing matches; `'current'` with no character selected returns an
empty result rather than throwing.

**Iris** answers `'current'` from the pushed snapshot's `charWorldbooks`, and
refuses any other argument by name.

**Why.** The synchrony is the constraint. All five corpus call sites read a
property straight off the result — `getCharWorldbookNames('current').primary` —
and two of the three cards have no guard on the value that flows onward into
`getWorldbook`. A promise-returning façade would hand those cards `undefined`
silently. Serving the named branch would require the snapshot to carry every
character's bindings, which is unbounded.

**Measured, not inferred:** 5 of 5 call sites pass `'current'`. The named branch
is the one no card travels — which is the reverse of what this looked like before
it was measured.

**What it costs.** A card asking for a named character gets a refusal naming the
member. That is worse than upstream and better than `undefined`.

**What would overturn it.** A card in the corpus passing a character name, or a
host-side synchronous read that makes the named branch answerable.

---

## 4. A card interface has no storage at all

**Kind:** compatibility gap, and one that cannot be closed the obvious way.

**Upstream.** Message iframes carry **no `sandbox` attribute** and are therefore
same-origin, so a card interface can use `localStorage` and IndexedDB.

**Iris** renders them in an opaque origin. Measured, not assumed: `localStorage`
**throws** on access, and `indexedDB.open` throws as well — the throwing variant,
not the hang some references describe.

**What it costs.** Concretely, the sample card's settings pane writes its API
configuration to `localStorage`, so under Iris it starts blank every time.

**Why it cannot be closed by adding `allow-same-origin`:** that flag *is* the
wall. Closing it properly means the shell offering a storage channel over the
bridge that already exists and cards opting into it — separate work, not an
oversight in the render pipeline. See `RENDER.md`, "What this does not do".

**What would overturn it.** Nothing about the measurement; only the work.

---

## 5. Live objects: two surfaces, opposite rules

**Kind:** compatibility gap on one surface, faithful behaviour on the other. They
are recorded together because the same measurement produced both answers, and
reading either alone gets the other backwards.

An audit of what the frame hands a card, measured by mutating each return value
and re-reading it — one fresh realm per probe, for the reason in `METHODS.md`:

| accessor | hands the card |
| --- | --- |
| `getVariables({type})` | live |
| `getAllVariables()` | copy (the merge builds a new object) |
| `SillyTavern.chat` | live |
| `SillyTavern.characters` | live |
| `getChatMessages()` | a new array of **live** message objects |
| `getSwipes()` | live |
| `SillyTavern.chatMetadata` | live |

"Live" is not one verdict, because the two surfaces have opposite upstream rules.

### The SillyTavern context surface: live is correct

`chat` (63 accesses), `chatMetadata` (57), `extensionSettings` (15) and
`characters` (6) are SillyTavern's own objects, and upstream hands them over
live. Cards mutate them and that is the documented idiom. **Here the gap is not
that we hand out a live object — it is that our live object is a snapshot, so the
mutation never reaches the host.** Each of the three that cards actually write is
handled separately and none of the fixes is "stop handing out a live object":

- `chat` — recorded and replayed (`CHAT-WRITES.md`, entry in progress)
- `chatMetadata` — carried across refreshes (§2)
- `extensionSettings` — a proxy that posts each write (already worked, and the
  precedent the others were designed against). **Shallow**: a nested write is not
  intercepted, which is the same element-level blind spot the chat journal wraps
  message objects to avoid.

### The Tavern Helper surface: live is a divergence

Upstream TH's house rule is the opposite — it clones on the way out, 21 `klona`
calls across 10 modules, `getVariables` / `getChatMessages` / `getPreset` /
`getCharacter` among them. So a card mutating a TH return value changes nothing
on real SillyTavern, and changes our snapshot here.

That makes our liveness **Iris-only behaviour**: a card doing this works in Iris
and silently does nothing upstream — the worse direction, because it invites
cards to depend on something no other host provides. Corpus mutations of TH
return values: **zero**, so cloning breaks nothing measured.

**Fix:** clone at the façade's exit, once, rather than per accessor — a per-member
`klona` makes "the new member forgot to clone" a regression that can happen,
where a single exit makes it impossible. Ordered after the shape fix in §6,
because cloning an object whose field names are wrong accomplishes nothing.

**Unclassified:** `groups`. The census pattern that produced this table looks for
mutation, not rebinding, so a member that is only ever reassigned reads as
untouched. Absence of evidence here is not evidence — recorded as unknown rather
than as safe.

**What would overturn it.** A corpus card mutating a TH return value, which would
mean upstream's clone is load-bearing for it and our liveness was masking a bug.

---

## 6. `getChatMessages` returns SillyTavern's shape, not Tavern Helper's

**Kind:** compatibility gap. Live, and the most consequential one open.

**Upstream** (`chat_message.ts:164`) returns a **renamed** object:

```
{ message_id, name, role, is_hidden, message, data, extra,
  swipe_id, swipes, swipes_data }
```

**Iris** returns `ScriptChatMessage` — SillyTavern's storage shape: `mes`,
`is_user`, `is_system`, `swipes`. So a card reading `.message`, `.role`,
`.is_hidden` or `.message_id` gets `undefined`.

**How it happened**, because the mechanism matters more than the fault:
`ScriptChatMessage`'s field names rest on a real measurement — 194 `context.chat`
accesses across the corpus read `mes`, `is_user`, `swipes`. That measurement is
correct, and it is about `context.chat`, which *is* SillyTavern's own array.
`TavernHelper.getChatMessages()` is a different surface, where upstream renames.
**A sound measurement of one surface was applied one notch beyond its range.**

The divergence needed no upstream access to establish: this repo already contains
the TH shape, in `packages/iris-compat-tavernhelper/src/chat-messages.ts`. Two
implementations of one member, in one repo, disagreeing.

**The `data` field is half of a larger gap.** It is annotated *"where MVU keeps
`stat_data`"*, and Iris's shape has no such field. The other route to floor
variables — `getVariables({type:'message', message_id})` — is refused by name.
So both paths are closed: one loudly, one silently. They were treated as two
items for some time; they are one picture, and MVU loading successfully says
nothing about whether it can read floor state.

**What would overturn it.** Nothing — the shape is settled. What is still being
measured is *which* fields the corpus's fourteen call sites read, which decides
how many cards are silently receiving `undefined` today and whether `data` is on
a live read path.

---

## 7. `getSwipes` and `swipeTo` are Iris's own members

**Kind:** deliberate improvement.

**Upstream** has no member of either name — confirmed against its `@types` and
its `src`, both zero hits. Swipes are reached through the message that carries
them.

**Iris** makes a swipe a first-class object, so there is a name to call and no
upstream spelling to copy.

**Why this is recorded rather than left as an implementation detail.** The
provenance lived only in a test comment. `identity.test.ts` holds an `IRIS_OWN`
allowlist with a paired guard — any name in it that upstream *does* have fails —
so the fact is enforced, but a reader of the surface had no way to learn that
these two are ours rather than a spelling nobody checked. Under the upgrade
discipline an addition has to be visible as an addition.

**What it costs.** Two names on the surface that no card written for upstream
will call, and that a card written for Iris cannot take elsewhere.

**What would overturn it.** Upstream adding members of the same name with
different semantics, which the `IRIS_OWN` guard would catch as a failure rather
than a silent collision.

---

## 8. Three Tavern Helper members left the SillyTavern surface

**Kind:** compatibility fix, with a predicted side effect.

**Upstream.** `st-context.js` returns 145 keys. `getVariables`, `getWorldbook`
and `replaceWorldbook` are not among them — they are Tavern Helper members, and
a card reading `SillyTavern.getVariables` on real SillyTavern gets `undefined`.

**Iris** carried them on that surface, because `CARD_METHODS` answered one
question — *may the shell route this* — where there were two, the other being
*does a card find it on `SillyTavern`*. They were the same question until the
chat journal needed to reach an arm that does not belong on the surface at all.

**The predicted side effect, written down on purpose.** These names now return
`undefined` **and file a report**, so logs will start carrying lines like *"a card
read SillyTavern.getVariables, which Iris has not built"*. That is the correct
new behaviour, not a regression. It is recorded here because **a predicted noise
and an unpredicted regression are indistinguishable in a log** — the only thing
that separates them is having said so in advance.

**Deliberately not moved**, though they look like the same case: `generate`,
`generateRaw` and `macros` exist on **both** upstream surfaces with different
meanings, and `generateRaw` is one of the legitimate 145. Removing them would be
a compatibility break dressed as tidying.

**What would overturn it.** A corpus card reading one of the three off
`SillyTavern` rather than off Tavern Helper — none does today; the reports would
say so if one appeared.

---

## 9. Members Iris adds that upstream does not have

**Kind:** deliberate improvement. Collected in one place because an addition has
to be visible *as* an addition — that is the whole of the upgrade discipline, and
until now the provenance of these lived in a test comment or nowhere.

| member | why it exists | what it costs |
| --- | --- | --- |
| `getSwipes`, `swipeTo` | a swipe is a first-class object here; upstream reaches swipes through the message that holds them, so there is no name to copy | two names no upstream-written card will call, and that an Iris-written card cannot take elsewhere |
| `charWorldbooks` | lets `getCharWorldbookNames('current')` answer **synchronously**, which upstream's declaration requires and an RPC cannot do (§3) | a snapshot field with no upstream counterpart |
| `floor`, `variableLayers` | the four variable scopes arrive unmerged and floor-addressed, which is what makes `getAllVariables` and per-floor reads both answerable from one payload | a wider snapshot than upstream sends |
| `setVariables` | see below — this one is a mistake, not a feature | |

`identity.test.ts` holds an `IRIS_OWN` allowlist with a paired guard: any name in
it that upstream *does* have fails the build. So these are enforced as additions
rather than merely asserted to be.

### `setVariables` is an invented verb, and should not stay one

Upstream has no member of this name. Its vocabulary is five verbs —
`replaceVariables`, `insertOrAssignVariables`, `insertVariables`,
`deleteVariable`, `updateVariablesWith` — and every upstream write funnels into
`replaceVariables`.

So `setVariables` is not an Iris capability upstream lacks; it is **a sixth verb
for something upstream already names**. That is the one kind of addition the
upgrade discipline does not cover: it adds no capability and costs
interoperability, since a card written against it works nowhere else.

**When this is next touched, fold it into `replaceVariables` rather than keeping
both — and do not add a seventh.** Recorded here rather than fixed now because
the rename has callers and belongs in its own change.

**What would overturn it.** Nothing about the naming. The entry closes when the
member is folded in.

---

## 10. `role` has a fourth value, and filtering silently drops it

**Kind:** faithful copy of an upstream defect, recorded so it is not read as ours.

**Upstream** derives the role (`chat_message.ts:91-103`):

```
extra.type === 'narrator' ? (is_user ? 'unknown' : 'system')
                          : (is_user ? 'user'    : 'assistant')
```

Two consequences, both upstream's:

1. **`'unknown'` exists at runtime and upstream's own type says it cannot.** The
   declared return is a three-value union, populated through an `as` assertion
   (`:137`, `:148`) that validates nothing. **Iris types the runtime value, not
   the declaration** — a contract that repeats the lie makes the fourth value
   unrepresentable in every consumer while it keeps arriving.
2. **A narrator message on a user row disappears from every filtered read.** The
   filter compares against the derived role and its parameter type has no
   `'unknown'`, so no argument returns those floors. Copied rather than repaired:
   a card relying on `role: 'user'` to skip them would start seeing them.

**What it costs.** Cards cannot reach those floors through a filtered read here
either. The cost of *not* copying it is higher and less visible.

**What would overturn it.** Upstream widening the filter, or a corpus card that
depends on those floors being reachable — none does today.

---

## 11. jQuery UI is installed but deliberately not bundled

**Kind:** deliberate improvement, recorded because the evidence for it is invisible.

**Upstream** ships jQuery UI and touch-punch into every frame.

**Iris** does not put them in the message preset. Measured at **zero uses**
across the corpus by two independent probes — method calls and theme class names
— against 349,109 bytes that every message frame fetches cold, because the HTTP
cache is partitioned by origin and each of these frames is its own opaque origin.

A card that reaches for one gets `undefined`, which is what a SillyTavern install
without the plugin gives it, plus a report naming the method
(`jquery-plugin-gap.ts`). No list of jQuery UI methods exists anywhere in this
repo; the rule catches any name jQuery does not have.

**The packages remain in `package.json` on purpose.** Removing them would touch
the lockfile, which needs a quiet window while several sessions share this tree —
but the substantive reason is that the version-pinning test guards the property
*"every message-frame library is pinned to an exact version"*, and that property
should not be weakened for two libraries that merely stopped being bundled.

**So the absence is a decision, not an oversight**, and this paragraph is the
only thing that distinguishes the two: an installed-but-unimported dependency
looks identical to a forgotten one. Delete them in a quiet window if the pinning
test is reworked at the same time.

**What would overturn it.** A corpus card using jQuery UI — the reports would
name it.

---

## 12. `ctx.chat_metadata` stays broken, on purpose

**Kind:** faithful copy — and the first entry here that is **deliberately not
fixed**. The reason is fidelity, not effort, and it leads because an entry
reading "known broken, not repaired" is otherwise indistinguishable from debt.

**Upstream.** `chat_metadata` — snake case — is **not among `st-context.js`'s 145
keys**. A card reading it off the context object gets `undefined` on a real
SillyTavern install too. The corpus has one such read, as a fallback path behind
the `characters[characterId]` route.

**Iris** returns `undefined` and reports the name, like any unbuilt member.

**Why this must not be "fixed".** The fallback is dead code upstream. Making it
work here would give one card a path that exists nowhere else — a card author
testing against Iris would see their fallback exercised, conclude it works, and
ship something that silently takes the other branch everywhere else. **Repairing
it would be the divergence.**

The camel-cased `chatMetadata` **is** a real member and is served (§2). So the
two spellings differ in kind, not just in case: one is the API, the other is a
typo that upstream never rejected.

**What would overturn it.** Upstream adding `chat_metadata` to its context.

---

## 13. Acceptance criteria for the embedded-book chain

**Not a deviation** — recorded here because the numbers were wrong once and the
wrong ones are the kind you chase.

The chain: `ctx.characters[ctx.characterId]` → `.data.character_book.entries` →
`renderEntry` per entry → entries containing `<%` reach `evalTemplate` → one of
them writes, producing a `saveMetadata` op in the host log.

| reading | value |
| --- | --- |
| `saveMetadata` ops in one pass | **1**, naming the `yinqi_phone` key |
| `evalTemplate` calls in one pass | **3 to 14** |

**The range is not slack.** `renderEntry` returns on its first match, so one call
renders at most one entry: three fixed call sites plus one per character the card
iterates, of which there are eleven. The upper bound of 14 happens to equal the
count of `<%`-bearing entries, which makes it **easy to mistake for a
confirmation** — seeing 14 does not verify anything, and seeing 5 does not mean 9
were lost.

Two entries match and contain no `<%`. They return their content directly, so
**not calling `evalTemplate` for them is correct** rather than a miss.

So `saveMetadata` = 1 is the primary criterion: it is unaffected by how many
characters get iterated. The call count is corroborating evidence read as a
range.

## 14. `EjsTemplate` is a frame global as well as a parent member

**Improvement ledger, and a correction to an instrument.**

`EjsTemplate` was built on the virtual parent only, because that is where the
corpus card reads it (`window.parent.EjsTemplate`). Upstream's shim copies all
seven of its borrowed globals onto the child window, so upstream cards may write
either spelling; Iris answered only one of them.

What forced the issue was not a card but a lie. `EXPECTED_GLOBALS` drives the
frame's missing-library banner, and that banner reads the frame's own `window`.
With the member reachable only through `parent`, the banner announced
`EjsTemplate` among "libraries a card may expect are not present in this frame"
— a sentence that had been true when it was written and was not true any more.
A false report is worse than a missing one, because it sends a reader looking
for a gap that is not there. This one cost a peer a diagnosis round.

Two ways out of a false report: make the report accurate, or make the thing it
reports on true. Here the second is also the more upstream-faithful, so
`EjsTemplate` joins the shadowed-and-published list and the banner falls silent
about it on its own.

### The bug that came with the fix

Adding one name to `core` broke every Tavern Helper binding, because the names
and their values are two hand-written lists matched **by index**. The tenth name
now met the first helper's value, and all twenty-six slid one place along.

That failure has no symptom at the boundary a test usually watches: each name is
still present, each value is still a callable function, and only the card's own
behaviour goes wrong — `getChatMessages` running whatever code sat next to it.
The suite caught it as a hang, not as a mismatch.

So the alignment is now checked against a source that does not share the array:
the virtual parent resolves each member **by name**, so comparing the published
value for `name` against `parent[name]` (falling back to
`parent.TavernHelper[name]`, since that is where most members live) fails on any
shift. Checking the two literals against each other would have been no check at
all — they are the two things that can disagree.

### What that check found on its first run

Two names — `triggerSlash` and `getScriptId` — were **not** the same object on
the two routes. `helperNames` filters out whatever `core` already binds, so
those two alone skipped the detach layer every sibling passes through: a card
calling `triggerSlash` bare received live host values, and the same card calling
`parent.TavernHelper.triggerSlash` received a clone. Upstream has one function
per name. The core positions now resolve out of `tavernHelper`, so both routes
hand out the same object.

The comment above `helperNames` had asserted the opposite — "both carry the same
behaviour, so which one wins does not change what a card sees" — and had been
wrong for as long as it had been written down. It now records why the claim
holds rather than asserting that it does.

## 15. The frame budget: layer ③ of the reading window

**Compatibility ledger — upstream has no equivalent, and its absence is the bug
this replaces.** Upstream's own valve is `chat_truncation`, whose default is `0`
(meaning *all*), so upstream ships with no limit at all and a long chat builds a
frame per interface floor.

`frame-budget.ts` holds the figures, each a named constant citing
`WINDOWING.md`, rounded on purpose — the measurements behind them drift with
every build, and exact bytes in code go stale before they go wrong.

| constant | value | source |
| --- | --- | --- |
| `FRAME_OVERHEAD_BYTES` | 42 KiB | bootstrap + snapshot + srcdoc wrapper, all inlined and uncacheable |
| `FRAME_BUDGET_BYTES` | 2 MiB | `RENDER.md` |
| `FRAME_COUNT_LIMIT` | 20 | below the ≈49-frame point where overhead alone eats the budget |

The count gate is not a precaution. At 2 MiB / 42 KiB ≈ 49 frames the fixed
overhead consumes the entire budget and not one byte of card content fits, so a
pure byte budget degrades into "all scaffolding, no content" exactly when there
are most frames. A test pins the *relationship* rather than the numbers: change
either constant so the gate rises above that point and it fails.

### The overhead figure was wrong, and now a build says so

**42 KiB, not the 39 KiB this section first claimed.** The measured bootstrap is
41,807 bytes; with about a KiB of srcdoc wrapper that is 42,831, and the
constant rounds **up** to the next whole KiB above it.

The 39 KiB came from a measurement taken before the script-button members joined
the frame's import chain. Nothing pointed at it: the budget went on charging
about 2.9 KB less per frame than a frame cost — roughly 58 KB unaccounted for at
the 20-frame gate, which is small against 2 MiB and would have gone on growing
with no signal at all.

**The drift is unattributed beyond its total.** +2,453 bytes since the last
recorded measurement (39,354). The button writers and their four validation
helpers are the obvious candidate, and I did not itemise it: the helpers are
function-scoped consts, so a stubbed build does not tree-shake them and the
delta it reports would be an undercount. Stating the total and naming it
unattributed is the same treatment the earlier +811 B got in `WINDOWING.md` §三.

What changed structurally is that this number is no longer maintained by
remembering. `tools/check-bootstrap.mjs` compares the constant against the
artifact on every sandbox build, and the two directions are not symmetric:
understating **fails** the build, because it silently removes the protection the
layer exists to give; overstating only **warns**, because a tighter budget than
necessary is visible and harmless. It printed the failure the first time it ran.

Two figures moved with it, and both are consequences rather than decisions: the
degradation point is ≈49 frames rather than ≈53, and the 20-frame gate holds
about 840 KiB of overhead (41% of the budget) rather than 780 KiB (38%). The
test beside the constants pins the **relationship** — the gate sits well below
the degradation point — precisely because the numbers move whenever the
bootstrap does. It caught this change on its own.

### Three claims on the budget, settled in this order

1. **What the reader opted into**, unconditionally. The budget is a default, not
   a ceiling.
2. **What is already rendering**, which growth may never revoke — the layer's one
   hard invariant. Budget returns only when the window *shrinks*.
3. **Everything else**, newest floor first, until bytes or count run out.

A refusal does not stop the walk. One heavy interface early on would otherwise
close the budget for every smaller one behind it, which reads as "the rest of
this chat is broken" rather than "this one did not fit".

### Deviations from `WINDOWING.md`'s own text, and why

**The unit is a frame, not a floor.** A floor can carry several interface
blocks, and the count gate counts frames. Keys are `floor:instance`.

**No AI/user distinction in the accounting.** The design says the budget counts
AI floors only, resting on a measured 0 user rows among 189 interface floors
with nothing enforcing it. Charging the *actual* interface bytes of whatever
builds a frame makes the distinction unnecessary — user rows contribute nothing
because they carry no interfaces, which is the same result with no
un-mechanised premise. Two things now hold the line instead: `Message.tsx`
routes only `role === 'assistant'` through `MessageInterfaces`, so a user row
has no path to a frame at all; and the plan reports any user row that carries
one, which fires if that routing ever changes.

**Hysteresis is not built.** The design proposes a half-screen band so scrolling
across the boundary does not build and tear frames. Layer ② grows the window by
an explicit button and never shrinks it, so there is no boundary to oscillate
across — the mechanism would be dead code guarding a case the shell cannot
reach. It becomes necessary the day the window follows the scroll position, and
`WINDOWING.md` §五之二 holds the figure for then.

### Bytes, not code units

`String.length` counts UTF-16 code units. On this corpus — Chinese — that is
about a third of the bytes the browser inlines, so a budget built on it
undercounts by 3× on exactly the data it exists to bound. `encodedBytes` in
`message-frames.ts` is the one definition, shared with the reader-facing
"KB of markup" figure so the panel's number and the budget's number are the same
quantity. **Both were `String.length` before this layer was built**, which is
why the interface state readout has been quietly reporting a third of the truth.

### The placeholder is a main surface, not an error caption

[WINDOWING.md §五之二] a reader scrolling back sees a placeholder more often
than a live panel. So `over-budget` is its own `InterfacePhase` rather than a
`never-started` with a reason: `never-started` is a **failure**, this is a
**decision**, it is reversible, and the reader can reverse it. Folding a policy
into a failure bucket is how "we chose not to" comes to read as "it broke".

It says three things and offers the third: there **is** an interface here, the
budget is why it did not render, and *Render this one* renders it — for that one
only, taking nothing from any other. Deliberately **not** a fallback to the raw
code block: that is what upstream does with rendering off, and it pours a screen
of HTML into the prose, which is noise that also reads as a broken card.

### `render-window.ts` is deleted

Acceptance item 5. It counted floors back from the end as a stopgap for an
unwindowed view, and it answered the same question this layer answers. Two
windows stacked are not safer — they give "why has this floor no interface?" two
answers. The count is now layer ②'s (which floors mount at all) and the weight
is layer ③'s.

## 16. Script buttons: the five members, and what each one copies

**Compatibility ledger.** All five are now real. They were stubs that answered
the call and reported once that nothing happened — the right shape while there
was no host arm and no bar, because *absence* is the one answer that breaks a
card outright: MagVarUpdate calls three of them while wiring up, and a missing
member turns a card's setup into a `ReferenceError` with everything after it
unrun.

| member | shape | notes |
| --- | --- | --- |
| `getScriptButtons()` | sync, from the snapshot | unfiltered, per script, a copy |
| `getButtonEvent(name)` | sync | `${script_id}_${cyrb53(name)}` — the id **is** the event |
| `replaceScriptButtons(id, buttons)` | whole-table write | equality-guarded |
| `appendInexistentScriptButtons(id, buttons)` | façade sugar | dedupe by name, then append |
| `updateScriptButtonsWith(id, updater)` | façade sugar | sync and async updaters both |

Corpus calibration, so the effort is on the record as disproportionate on
purpose: **1** script calls `replaceScriptButtons`, **0** call the other two
writers, and 18 scripts publish 89 buttons of which **58 are hidden**.

### Two arguments, and the one-argument form is refused by name

Upstream is `replaceScriptButtons(script_id, buttons)` — its own 3.2.5 example
is `replaceScriptButtons(getScriptId(), [...])`. The stub here took **one**
argument and discarded it, so a card writing upstream's real call would have had
its script id land in `buttons`, and a no-op cannot tell you it was called
wrongly.

The one-argument form now throws, naming the signature. Guessing would mean
writing a table under a script id taken from an array.

**No default for the id, either.** Upstream requires it, and leniency past
upstream has a recorded cost in this project: a card that works only here, whose
author finds out in real SillyTavern. Worse than usual here, because the thing
being defaulted is *which script gets written*.

### `visible` is required, and defaulting it would be the wrong kindness

Upstream's type has no default. And `visible: false` is the **common** case — 58
of 89 — so a missing field is at least as likely to have meant hidden as shown.
Either default stores a table the card did not ask for, and its author debugs
the bar instead of their call.

### Asynchronous where upstream is synchronous

Upstream assigns a Vue ref and the bar re-renders. Here the table lives on the
host and the write crosses the RPC boundary. Cards call this without `await` and
upstream returns `void`, so:

- the write is fire-and-forget, and a host refusal is **reported to the panel**
  rather than thrown — an async throw would surface as an unhandled rejection
  with no card frame in the stack, which is a report that names nothing;
- a card sees its own next `getScriptButtons` answering the **old** table for one
  round trip. This is the one divergence a card could observe.

`updateScriptButtonsWith` is the exception: an async updater makes it return a
promise, so a card that wrote one can await the write. The thenable check is
duck-typed on `.then`, not `instanceof Promise` — a card's updater may be an
async function from its own realm or a thenable from its own bundled library, and
neither is this realm's `Promise`.

### The equality guard is upstream's, and it earns more here

Upstream guards with `!_.isEqual` (`function/script.ts:80`). Here a write also
returns as a new snapshot, which re-plans the frame budget and refreshes every
running card — so an identical republish, which is exactly what the one corpus
caller does on a button press, would pay for all of that to change nothing.

Comparison is **positional**: the bar renders in table order, so a reordered
table is a different table even though the set is equal.

The guard also made an early return in `appendInexistentScriptButtons`
redundant, and a mutation check found that no test could tell whether that early
return existed. It is gone: one place decides "no change, no write".

### No character open: silent upstream, named here

Upstream's writer simply returns when the card has been switched away
(`script.ts:76-78`, four identical TODOs) — which `SCRIPT-BUTTONS.md` records as
the thinnest part of upstream's observability, since a script trying to change
its buttons during teardown fails with no sound at all. Iris copies the
behaviour and adds the name: nothing is stored, nothing throws, and the panel
gets one line saying which member was called and that upstream is silent here
too.

### Old listeners are left where upstream leaves them

Renaming a button changes its event name, because the name is hashed into it.
Upstream does not migrate the old listener and neither does this — a card that
replaces its table must re-register. Copied deliberately: repairing it would
make cards that work here fail upstream.

### `getScriptButtons` is unfiltered, and that is load-bearing

`visible: false` hides a button from the bar; it does not remove it from the
table. Cards read the list, flip one entry and write the whole table back — so a
filtered read would make the read-modify-write **delete every hidden button**,
and the card's author would report it as "toggling one button deleted my
others". Filtering happens in `script-buttons.ts` and only there.

### One thing deliberately not done

The bar reads `ScriptView.buttons` while the façade reads
`ScriptContext.scriptButtons`. Two read paths for one table is normally a
drift risk worth removing, and the field's own doc used to say it carried "what
the card declared", which would have made the bar go stale the moment a card
replaced its table. The host now derives both from one `effectiveButtons` merge
with a test pinning that they never disagree, so the paths are same-source and
unifying them would only add an async fetch the bar has no other reason to make.
The bar also needs `enabled`, `buttonsEnabled` and `name` from `ScriptView`
regardless, so the unification would have been partial by nature.
