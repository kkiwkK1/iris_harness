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
| `FRAME_OVERHEAD_BYTES` | 43 KiB | bootstrap + snapshot + srcdoc wrapper, all inlined and uncacheable |
| `FRAME_BUDGET_BYTES` | 2 MiB | `RENDER.md` |
| `FRAME_COUNT_LIMIT` | 20 | below the ≈48-frame point where overhead alone eats the budget |

The count gate is not a precaution. At 2 MiB / 43 KiB ≈ 48 frames the fixed
overhead consumes the entire budget and not one byte of card content fits, so a
pure byte budget degrades into "all scaffolding, no content" exactly when there
are most frames. A test pins the *relationship* rather than the numbers: change
either constant so the gate rises above that point and it fails.

### The overhead figure was wrong, and now a build says so

**43 KiB, not the 39 KiB this section first claimed.** The measured bootstrap is
42,343 bytes; with about a KiB of srcdoc wrapper that is 43,367, and the
constant rounds **up** to the next whole KiB above it.

It has since moved again, and that move is the check earning its keep twice
over: adding a second observer to the height reporter grew the bootstrap by 536
bytes, and the build **failed in the same commit that caused it** rather than
leaving a stale figure for someone to find later.

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
## 17. Dismissing the cleaning offer defers; upstream's declines forever

**Kind:** deliberate improvement — and specifically a **bug we do not
reproduce**, which is the rarer sort of entry.

**Upstream.** MagVarUpdate offers, once per chat, to sweep old variables out of
the whole file (`cleanup/legacy_chat.ts:16-25`). The dialog has three buttons —
"back up and clean", "clean only", "do not remind me again" — and the branch
that handles the answer treats **`POPUP_RESULT.CANCELLED` and
`POPUP_RESULT.NEGATIVE` identically** (`:27-33`): both write
`chat[1].variables[0].ignore_cleanup = true` and return.

So pressing **Esc**, or clicking outside the dialog, permanently declines. The
user believes they postponed a question; the extension has recorded that they
never want to be asked again. Nothing on screen distinguishes the two, and the
next chat load says nothing because there is nothing left to say.

**Iris.** A dismissal sends **nothing**. The protocol already defines silence as
a complete outcome — no answer means nothing is cleaned, nothing is recorded,
and the offer returns next time (`rpc.ts`, `chat.answerCleanup`) — so deferring
needs no new state anywhere. The three buttons keep upstream's labels and
upstream's order (its custom button is prepended before the ok button,
`popup.js:312-315`, so "back up and clean" leads), and only the dismissal
differs.

**Both dismissal gestures**, and this took a correction. Escape was wired first
and clicking the dim area was not, so half of what upstream calls a dismissal
did nothing at all — a reader who clicked outside would reasonably read the
dialog as stuck. Escape is listened for on the **document** rather than on the
panel (a modal whose keyboard dismissal depends on where focus happens to be is
broken for anyone whose focus is in the composer, which is where it is while
they read), and the outside click is taken on `mousedown` **only when the target
is the scrim itself** — a drag that starts on the body text and releases past
the edge is a selection, not a dismissal.

**What it costs.** A user who *wants* never to be asked again, and who expects
Esc to mean that because they learned it from the extension, has to press the
third button instead. That is the whole cost, and it is paid by the reader who
already understood the old behaviour rather than by the one who did not.

The dialog also says so in a line beneath the buttons: *"Closing this without
choosing asks again next time — it does not decline."* Without that sentence the
divergence only helps people who already know it exists.

**What would overturn it.** Evidence that upstream's folding is deliberate
rather than incidental — a comment, an issue, a changelog line saying a
dismissal is meant to decline. `legacy_chat.ts:27-33` has none: `CANCELLED` is
simply not distinguished from `NEGATIVE` in the condition.

## 18. The periodic trim is announced; upstream's is silent

**Kind:** deliberate improvement.

**Upstream.** Two cleanup paths, and they report differently. The **periodic**
one prints and nothing more — `console.log(tr('runtime.cleanup.cleanedFloorsLog',
{ count: counter }))` (`cleanup/index.ts:43`), unconditionally, whether or not
anything was removed, with **no toast at all**. The **legacy** path does toast,
`toastr.info(…, { timeOut: 1000 })`, and only when `counter > 0`
(`cleanup/legacy_chat.ts:98-106`).

**Iris.** The periodic trim reaches the screen: the host pushes a `report` event
carrying `irreversible: true`, and the shell shows a notice and keeps a durable
line in the report list. Cleaning is on by default and it deletes a user's
message data — "we trimmed it correctly" and "the user knows we trimmed it" are
two different claims, and only the second one needs a channel. A `console.log`
in a page nobody has open is not that channel.

**Wording.** Upstream's own two strings disagree about the unit: the periodic
one says `{count} 层` (layers) and the legacy one says `{count} 条消息`
(messages), while **both come from the same `cleanupMessageVariables` return
value** — one counter, indexed by chat position. The legacy phrasing is the
accurate one, so it is the one used; "层" is upstream's older name for the same
thing.

**What it costs.** A notice on a routine housekeeping action, on chats where the
count may be zero. Mitigated rather than solved: only the *irreversible* records
are pushed, so an ordinary trim of nothing is a line in the report list and not
an interruption.

**What would overturn it.** A reading that the periodic window never removes
anything a user would miss — it is bounded by `keep`, so this is arguable — or a
user saying the notice is noise. Both are about the *notice*, not about the
record: the durable line stays either way.

## 19. Same-origin fetches answer through a bridge with a narrower shape

**Kind:** deliberate improvement — it closes a compatibility gap (`fetch('/version')`
died under `connect-src 'none'` with a banner naming Iris's own host) at a
deliberately reduced fidelity.

**Upstream.** `fetch` is the page's own. Card scripts run same-origin with
SillyTavern, so any method works, request headers ride along, bodies go out,
responses stream, and the user's cookies are attached because the browser
attaches them — there is no policy between a bundle and its server.

**Iris.** Same-origin **GET and HEAD** requests are carried to the shell on the
`fetch` message and fetched by the shell page with its own credentials; the
frame hands the card a real `Response` carrying the body, status and content
type. Everything else — any other method, any request with a body or headers,
any foreign origin — takes the native path, where CSP refuses it and the
refusal is reported as it always was. `XMLHttpRequest` is not bridged at all.

**What it costs.** Measured against the corpus: MVU's bundle POSTs to
`/api/backends/chat-completions/status` and `/api/chats/export` — upstream
server endpoints — and those still arrive at a refusal instead of a response.
The bundle wraps them in its own `catch`, so the cost is the degraded answer,
not a dead card; a banner shows when the path is exercised, which is honest
(the endpoint does not exist here) rather than a bridge pretending otherwise.
Responses are buffered text, so there is no streaming and no `arrayBuffer`, and
an `AbortSignal` passed to the bridged call does not reach the shell's fetch —
a card that aborts a same-origin request sees it complete anyway.

**What would overturn it.** A measured card that cannot render without a
same-origin POST answering, or that awaits a same-origin response as a stream.
That reopens the question the GET-only rule exists to defer — what a bridged
POST to Iris's own routes may do with the user's credentials — and it is a
design decision to make, not a shim to widen.

## 20. `document.head` is the card frame's head, not the page's

**Kind:** deliberate improvement — closes the gap where 灭仇家满门之后's
script read `document.head` after mounting and died on the refusal.

**Upstream.** A card script's `document` *is* the page's document, so
`document.head` is the app's `<head>` and a `<style>` appended there restyles
the whole SillyTavern UI — cards do this to re-theme the page around
themselves.

**Iris** answers with the head of the card's **own frame document**, a real
element like the container `body` is. Injections land, render, and style every
pixel the card owns — and nothing else, because the card's page is the frame.

**What it costs.** A card that injected page-level styles upstream now styles
only itself; a theme that used to leak past the card's boundary stops leaking.
That leak was never reproducible here — a cross-origin frame cannot restyle the
shell — so the cost is a difference in *what the card believes it changed*, not
a lost visual effect. Writes to the member itself (`document.head = …`) stay
refused like every other write.

**What would overturn it.** A measured card whose interface visibly depends on
styling something outside its own frame — that would be a request for the
document grant, which exists for exactly this and is decided per card by the
user.
---

## 21. Interface frames are handed an `Mvu` surface built on their own facade

**Kind:** deliberate improvement (closing a measured compatibility gap).

**Upstream.** A card's MVU bundle runs in a *script* iframe and publishes itself
onto the shared host page: `_.set(window.parent, 'Mvu', …)` — and a script
iframe's parent **is** the page. An interface iframe reaches the same live
object two ways, both in upstream's own injection: `predefine.js` defines
`window.Mvu` as a getter to `_.get(window.parent, 'Mvu')` (its own comment:
"只是为了兼容性"), and `waitGlobalInitialized('Mvu')` resolves through the page's
event source when the bundle emits `global_Mvu_initialized`.

**Iris.** Each frame is an opaque origin with its own virtual parent and its own
event bus, so the bundle's publication stays in the script frame and no message
frame can ever see it. Measured consequence (哈人冰恋世界 v2.0.1, and the same
shape in 尸变纪元 and 绿茵好莱坞): every one of their status bars opens with
`await waitGlobalInitialized('Mvu')` and draws its panels only afterwards — the
wait never resolved, and the frame rendered its chassis with no number in it.

A live object cannot cross the wall, so Iris provides the surface the bundle
itself delegates to, built on the interface frame's **own** Tavern Helper:
`Mvu.events` is the constant table Iris already carries, and `Mvu.getMvuData` /
`Mvu.replaceMvuData` are the frame's own `getVariables` / `replaceVariables`.
That is not a guess about the bundle's semantics — the published artifact reads
`getMvuData:function(e){return getVariables(e)}`,
`replaceMvuData:function(e,t){return replaceVariables(e,t)}`. A display panel
therefore works fully, with its own floor's variables; the bundle's schema-driven
update machinery stays where it runs, in the script frame. Published
interface-frames-only, into both the window globals and the virtual parent bag
the wait polls; a later real publication replaces the entry, and script frames —
where the real bundle runs — get nothing.

**What it costs.** A status bar's *edit* path that round-trips through the bundle
(`Mvu.replaceMvuData`) now writes through the frame's facade instead of the
bundle's schema pipeline: the write lands, but the bundle's zod validation and
its `*_for_zod` event pair do not run. The display path — what a reader sees —
is unaffected.

**What would overturn it.** A cross-frame published-global bridge (the shell
brokering calls into the script frame's live objects) would make the stand-in
redundant; or a status bar observed to depend on bundle-only members beyond the
two measured delegations.

---

## 22. The shell speaks `mag_variable_update_ended` into message frames

**Kind:** deliberate improvement, and the twin of §3.

**Upstream.** The MVU bundle emits `mag_variable_update_ended` on the page's
shared event source, and every iframe's `eventOn` subscription is bridged to
that source — so a status bar redraws when the variables it draws change, no
matter which frame the bundle ran in.

**Iris.** The bundle runs in the script frame, whose bus is private. A message
frame that subscribes (all three measured status bars do) would wait forever, so
the shell emits the name into **message frames** on exactly the host events that
assign a view — `chat.updated` and `stream.end`, the same two that already
refresh the frames' snapshots. Script frames are deliberately **not** spoken to:
their bundle emits the event itself, and a shell copy would deliver every update
twice — the same ground §3 covers for the host side.

**What it costs.** A card whose interface listens for that name redraws on every
view-assigning event even when its variables did not change; the redraw is a
read of an in-memory snapshot, not a round trip.

**What would overturn it.** Evidence that a message frame hosts its own MVU
emitter (then the shell copy would double-fire there too), or a frame-side
bridge of the script frame's event bus (§21's overturn condition).

---

## 23. The height reporter treats its own applied height as silence, not as a
sizing event

**Kind:** deliberate improvement (fixing a self-inflicted loop), with one named
narrowing.

**Upstream.** `adjust_iframe_height.js` measures and writes
`frameElement.style.height` synchronously, same-origin. A measurement that comes
back equal to the frame's height is written back again; writing the same value
is a no-op, no observer fires, and the loop is a fixed point by construction.

**Iris.** The height crosses an origin as a message, and Iris added a second
message — `sizing`, "asking me how tall my content is has no answer" — which
upstream does not have. The first rule set announced `sizing` whenever a
measurement equalled the viewport, and the shell answered by *removing* the
applied height; the content then overflowed again, a real height was reported
(which re-armed the announcement), the shell applied it, the next measurement
equalled the viewport again — a closed message loop flipping the frame between
its content height and the CSS fallback on every animation frame. Measured
against four real cards' shapes (content 900 in a 60vh slot with a 100vh
fallback; content 1450 likewise): the pre-fix write-back series never
terminates — `height 900 / sizing / height 900 / sizing / …` past 40 steps, the
box alternating 900 → 1000 → 900 — which is the "右侧和下侧疯狂闪烁" report.
Post-fix the same series is one write-back and silence.

**The rule now:** a measurement equal to the viewport **and** equal to the
height this frame itself asked for is the echo of the frame's own write; it is
silence, and it flips no state. The single `sizing` announcement is preserved
for every state the frame did not create — unmeasurable from the start, or a
viewport that is not what we asked for.

**What it costs — stated, not hidden.** A card that becomes unmeasurable
*after* having reported a real height (a measurable screen followed by one that
clips its own overflow in a descendant) measures exactly its applied viewport,
which no ruler can distinguish from the echo (`informsShell`'s original
finding). That frame now keeps its last real height instead of escalating to a
full screen. The alternative — escalating on echoes — is the flicker loop, and
it hits every card whose height was ever successfully applied; the trade narrows
a rare transition rather than breaking the common case.

**What would overturn it.** A discriminator between "content fits what we
applied" and "content is now clipped and pinned" that is not gameable by a
continuously-mutating card — e.g. the shell reporting which of its writes
landed, or a frame-side overflow probe that survives descendant clipping.

---

## 24. A card with no script pack renders its message interfaces unasked

**Kind:** deliberate improvement, and the closing of a dead-end the gate and
the question built together.

**Upstream.** There is no consent step for a message interface: the card's own
embedded markup arrives with the card, and rendering it is what "installed the
card" means.

**Iris.** Message interfaces are gated on script consent, and script consent is
solicited exactly once — by `ConsentAsk`, which renders nothing for a card
whose script list is empty ("a card with no scripts is not a decision"). A
script-less card is therefore **never asked**, and an interface gate that
demanded an answer anyway stranded its greeting forever: measured on a real
card whose greeting is a 30 KB HTML document — frame claimed, shell healthy,
and no iframe in the row, with no sentence anywhere saying why. The two halves
each matched their own spec; the gap lived between them.

**The rule now:** `interfacesMayBuild` — consent answers `allowed`, or the
state is `unasked` **and** the card carries no scripts, the one state where
waiting is a wait nothing can end. Every other state keeps Iris's rule:
`unknown` is still in flight, `unasked` with scripts waits for the question,
`declined` is an answer.

**What it costs.** A script-less card's embedded interface scripts run without
an explicit yes. That is upstream's own default, and the scripts in question
are part of the message the user installed — not a separate pack the consent
question was built to judge.

**What would overturn it.** A surface that puts the question to script-less
cards whose messages carry interfaces (then the widening folds back into
`mayRun`), or evidence that a card ships an empty script pack as a marker with
meaning beyond "nothing to run".

---

## 25. Bare HTML in a message renders as a sandbox frame, not as escaped source

**Kind:** compatibility gap, closed — with one deliberate twist.

**Upstream.** Message HTML is sanitized in place (`messageFormatting`: DOMPurify
over the whole rendered message), so a card's bare `<div>`/`<style>` fragment —
no fence anywhere — renders as the panel the card author wrote. The measured
population is large: 936 fragment floors across the corpus carry line-initial
block tags with no fence, and cards like 尸变纪元 ship their MVU status widget
exactly that way.

**Iris** renders message text through `MarkdownText`, which disables raw HTML by
design — so until this change the two claimers of the message-frame pipeline
covered only **fenced** blocks (`claimFrontendBlocks`), and a bare widget arrived
on the reading surface as escaped source text. `splitHtmlRegions` (the
936-floor-spec split in `app/html-regions.ts`) existed but had no consumer.

**The wiring** (`claimMessageSurfaces` in `sandbox/frontend-blocks.ts`): one
claim list per message, fenced blocks and bare regions together, in source
order, consumed by all three surfaces that count or render instances — the
frame budget's plan, the frame controller, and the row's prose splice. Regions
run through the fence pipeline's own frame path (same `runCard`, same CSP and
opaque origin, same `planFrames` budget and count gate, same height sync), not
through a second renderer.

**The twist, and why it is not the INLINE-HTML.md plan.** That document's
recommendation is a sanitizer-based **inline** path (§三: "加一条内联渲染路，不是
给 frame 路加一个片段模式"), and this wiring deliberately does not follow it: the
task ordered the frame path, and the frame path is the stronger floor for the
same compatibility target — a bare region can carry a `<script>`, which the
inline path must strip (fragment gains no script capability, by ruling) but the
frame runs inside the existing wall. What is lost is upstream's styling
continuity: a bare panel renders in a frame that breaks out of the measure,
like every interface, rather than inside the message's own flow. Measured on
the acceptance fixtures: the widget renders with its own `<style>` intact inside
the frame, 898px wide, height-synced.

**Composition rule, because two grammars now describe one text:** fence-first.
The region split runs only on the prose between fences, so a fence body's
line-initial tags never open a region and nothing is claimed twice; unclaimed
fences are excluded too (their tags would frame while the fence markers leaked
into the prose); indented blocks are *not* excluded, because a region can only
open at up to three leading spaces while card markup is routinely indented
deeper behind blank lines — excluding them would carve real panels in half. A
region that still reaches into a claimed indented block loses to the claim and
falls back to the renderer.

**The unclosed region is reported, not silent.** The split's fallback (rest of
the gap becomes HTML) puts a note on the durable card-report channel
(`addCardReport`, channel `interface`); the store's one-entry-per-fact dedupe
keeps a card with the flaw on many floors at one line.

**What it costs.** Every bare region is now a frame candidate, so the frame
budget spends on both populations from one pool — intended (there is no second,
quieter accounting), and bounded by the same count gate. And a prose sentence
that happens to *open* with a line-initial block tag mid-sentence-flow is now a
frame: the split's own measurements (936 floors, blank lines inside regions
normal, 66% multi-region) are the evidence the rule fits cards, and the
unclosed-region report is the tripwire when a card does not.

**What would overturn it.** A card whose narrative regularly begins lines with
CommonMark type-6 tags as *prose* (none in the corpus — that is the split's
specification), or an interface that must style its surrounding message text
(impossible from a frame; would reopen the inline path as a separate, ruled
piece of work).
## 26. A card's overlay surface is confined to the reading column

**Kind:** deliberate improvement, on an explicit product ruling — and the
sharpest divergence from upstream in this file, because it takes a capability
cards have upstream and does not give it back.

**Upstream.** A card's script frame *is* the host page: its `$` is the page's,
its `.appendTo('body')` lands on SillyTavern's body, and a card that wants the
whole window takes the whole window — navigation, sidebar, send box and all.
`clearChat()` does not touch the body layer, so the takeover also outlives the
conversation. Nothing upstream bounds a card's interface, because nothing
upstream needs to.

**Iris.** The reader ruled that a card must never be able to take the
interface hostage: **Iris's navigation is always reachable.** The overlay
surface (`.iris-overlay-surface`) is therefore no longer `position:fixed;
inset:0` over the viewport; it is `position:absolute; inset:0` inside
`.iris-card-stage`, the reading column's own container in `App.tsx` — the
region below the masthead and right of the sidebar. The rectangle is the
layout's, not a measurement's: nothing is computed, cached or re-measured, so
it cannot fall out of sync with the real column at any window size.

The mechanism follows the box, because the box *is* the card's viewport:

- the frame fills the surface with `width/height:100%`, so the card's
  `100dvh` / `100svh` / `position:fixed` ladder (the full-screen forum class,
  `OVERLAY-HOST.md` §一) resolves against the column, not the window;
- the viewport metrics published to the card — the `viewport` message at
  `ready` and on resizes, which `--TH-viewport-height` is built from — are
  read off that same element (`overlay-surface.ts`), ending the two-sources
  regime where a frame could lay out at 1449px against a window the shell
  believed was 1218px;
- a `ResizeObserver` on the surface re-publishes them whenever the box changes
  for any reason, because the runner's window-`resize` listener cannot see a
  notice appearing or a pane toggling — layout changes with no window event
  that still reshape the frame.

And because geometry alone is not a guarantee a reader can bet on, Iris adds
its own way back: a small collapse control above the surface
(`.iris-overlay-toggle`, `z` = the surface's layer + 5), shown exactly while a
frame is attached, toggling the surface's `visibility`. `visibility`, never
`display:none` — a display change is observable from inside the frame (zeros
from every measurement, a `--TH-viewport-height` that describes nothing),
while a visibility change keeps the box laid out and the numbers true. The
control binds no key: a card's own ESC (V1.5.4's page declares it exits its
fullscreen) and Iris's escape must not fight over the keyboard, so the
guaranteed exit is a click.

**What it costs.** A card designed against the whole window now lays out
against the reading column, which is narrower — a full-screen forum gets a
column, and a card that positions floating chrome near the window's edges
finds the edges closer. That is the product ruling, accepted. Second, the
layering facts that were true of the old full-viewport surface stay true of
the smaller one: the settings drawer (z 30) and the small-screen sidebar
(z 20) sit below the overlay (40), so while a card's interface is up the way
back is the collapse control, the masthead, or switching chats in the sidebar
— which is outside the surface on every screen size. Third, the recorded
upstream limitation survives unchanged: a card that reads the viewport once
and stores pixel positions keeps them; Iris re-tells it on every box change
and fires `resize` in-frame, but nothing can move pixels a card already
computed.

**What would overturn it.** A product decision that cards may own the whole
window again, or a measured card that is genuinely unusable at column width
and cannot be operated collapsed — that would argue for widening the stage,
not for removing the toggle.

---

## 27. The bare `SillyTavern` / `extension_settings` spellings answer from the
context snapshot, and say nothing until it lands

**Kind:** deliberate improvement over a frozen absence; still narrower than
upstream.

**Upstream.** The `SillyTavern` global exists on the host page before any iframe
is created, so every spelling — `SillyTavern`, `window.parent.SillyTavern` —
answers truthfully from the first line a card runs.

**Iris.** An interface frame publishes its surface at install, which is before
the context message can arrive, so the install-time `resolveValues()` answers
`undefined` for both names and `defineProperty` freezes that onto the window.
Since the plugin-detection round this was a **failure shape**, not a nuance: the
bare spelling in interface markup read absent forever, and the corpus's
self-checks (`if (window.parent.SillyTavern)` has a bare-spelling twin in the
same scripts) took it for "the host is not SillyTavern". The context handler now
re-publishes the two names into interface frames on every snapshot, so the bare
spelling agrees with the live parent spelling from the moment an answer exists.

**What it costs.** Between install and the first context message the bare names
answer `undefined` where upstream would answer an object — a card probing
during that window takes its own fallback path, which is what upstream cards do
on any page where the host has not finished booting. Per snapshot the answer is
a fresh settings proxy, matching the run path's per-evaluation semantics rather
than upstream's one-live-object model; the trade is recorded in the
snapshot-sharing deviation and is the same one `generate()` already accepted.

**What would overturn it.** Publishing context-dependent members as live
getters from install would close the boot-window gap entirely; it needs a
second publish channel (getter descriptors alongside value descriptors) and was
judged not worth it while every measured card reads these names after the
context has settled.

---

## 28. `generateRaw` leaves world-info environment names out of the prompt

**Kind:** compatibility gap.

**Upstream.** `generateRaw({ordered_prompts})` resolves every environment name
against the generation context — `world_info_before` / `world_info_after`
expand to the activated world info, `persona_description` to the user persona,
`char_description` to the card's — and sends the composed prompt.

**Iris.** The member exists (it was documented in the surface's mapping table
and never implemented, which made a bare `generateRaw(...)` a `ReferenceError`
inside the card's own catch — 神隐挑战's engine reported "questionnaire failed"
and its player read that as a missing plugin). The composition carries what the
caller literally hands over: literal `{role, content}` messages, `user_input`
at its marker, and environment names from `overrides`. Names the frame cannot
resolve — `world_info_before` / `world_info_after` without an override, and any
unknown environment name — are skipped and reported by name through the gap
channel.

**What it costs.** A raw generation ordered with world-info names produces text
with no world info in it, where upstream would have activated entries inlined.
Measured callers in the corpus (神隐挑战's 游戏引擎, 13 sites) override the
persona and carry their own scene context in system messages, so the measured
cost is nil; an unmeasured card relying on world-info activation would see
thinner generations and at least a report naming why.

**What would overturn it.** A host-side raw-generation contract that accepts
resolved world-info text (the assembling `generate` already assembles world
info inside the host), at which point the frame can resolve the two names the
way upstream does instead of skipping them.
