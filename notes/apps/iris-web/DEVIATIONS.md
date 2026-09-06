# Deviations from SillyTavern — the browser half

Where the interface and the card sandbox deliberately do something other than
what SillyTavern does, and what each difference was measured to cost. A deviation
with no measurement is a guess, so every entry names what it read and **what
would overturn it**.

The host keeps its own ledger at `notes/packages/iris-app-service/DEVIATIONS.md`; this
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
builds a frame makes the distinction unnecessary — and when user floors began
carrying interfaces too (§52: a console writes its markup floor as a **user**
message, and upstream renders message HTML wherever the floor sits), the
role-blind accounting absorbed the change with no edit at all: a user floor's
blocks are candidates on the same terms, spent and gated beside every other.
The plan's `userInterfaces` report remains the account of which on-screen
frames a user floor is responsible for.

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

## 29. The virtual document answers unknown names instead of refusing them

**Kind:** policy change, in the direction the surface had already moved.

**What it was.** An unprovided `parent.document.<name>` read threw
`UnsupportedApiError` naming the member, and every write was refused. The throw
cost the 开场白2.0.1 component (哈人冰恋世界 / 绿茵好莱坞 carry the same script)
its initialisation one step past the world-book assertion this task fixed:
`$(parent.document)` hands jQuery the stand-in, and jQuery's first act is
reading its private expando slot off the document
(`document['jQuery3510…']`, read-with-default), then writing the cache back.
The read threw, `init` died inside `errorCatched`, and the panel showed a
script failure for a library idiom.

**What it is now.** The parent proxy's unpublished-name policy, applied here:
an unknown read yields `undefined` and is reported once by name ("it returned
undefined, which is not a statement that a real document has no such member");
an unknown write lands in a per-frame data bag and is reported once
("the slot is the card's own, and dies with the frame"); writes to **provided**
members (`body`, `head`, …) keep the read-only refusal. `nodeType` staying `9`
is what makes `acceptData` take the stand-in, so the existing constant was
already half of this.

**What it costs.** A card probing a capability by reading it
(`document.cookie`) now gets `undefined` plus a deduplicated report where it
used to get a throw; the report still names the member, but the failure moves
from the read to wherever the card consumes the `undefined`. No corpus card is
known to read an unprovided document member for its value — the measured
unknown-name traffic is library data, which is the case this exists to serve.

## 30. Interface frames' inline scripts still see the real `top`

**Kind:** known remaining gap, unchanged by this task.

**Upstream.** Every frame of a card is same-origin with the page, so
`window.top.addEventListener` / `window.top.dispatchEvent` /
`window.top.mvuCurrentFloatingBg = …` work natively from markup as well as from
scripts.

**Iris.** `top` is `[LegacyUnforgeable]` — an own, non-configurable accessor —
so `publishGlobals` cannot put the virtual parent there (the frame's `globals`
report answers `refused: [top]`; `parent` is `[Replaceable]` and takes the
publish). Card **modules** now receive the shadow as a lexical `const window`
(preamble), which is what fixed the projector's boot; interface frames run
**inline** markup, which has no preamble, so a message frame's
`window.top.…` still reaches the real cross-origin top and throws. Measured
use: 状态栏v2.0's `broadcastFloatingBg` — click-driven ("设为悬浮背景"
buttons), so it produces no chat-opening notice, and its behaviour is exactly
what it was before this task. A fix means rewriting inline card scripts in
srcdoc, which is a mechanism this task deliberately did not build.

## 31. A message frame's inlined snapshot is read at install, so its surfaces exist before the push

**Kind:** timing consequence, recorded because it changes when a report can
appear rather than what any member answers.

**What changed.** The seed script now precedes the bootstrap (see
`srcdoc.ts`), so `installSandbox` consumes `__iris_context__` during the
bootstrap instead of finding nothing. A consequence the seed's original author
intended but the old ordering silently denied: an **interface** frame's
install-time surface publication (`SillyTavern`, `extension_settings`, the
whole member view) now answers from a real snapshot at install, where it used
to publish `undefined` and wait for the pushed `context` message to re-publish.
The push still happens on `ready` and still carries refreshes; nothing reads
the seed after install, and frame-entry deletes the global so no stale copy
survives for a card to find.

**What it costs.** A plugin-detection probe in interface markup that
previously reported "not SillyTavern" during the boot window and corrected
itself a round trip later now answers correctly on the first read. The
corrected-self behaviour is gone; nothing in the corpus depended on the wrong
first answer. If a future mechanism needs to distinguish "seeded" from
"pushed", the frame currently cannot tell them apart — the seed is deleted on
consumption precisely so it cannot become a second, stale source.

## 32. The frames' zod chains `prefault()` through the inner schema's methods

**Kind:** compatibility layer over the served library, in the direction cards
were written.

**Upstream.** Tavern Helper bundles its own zod (4.9.x by `version:` in its
dist) and publishes it as `globalThis.z`; frames take `window.parent.z`. The
same chain that breaks here breaks there — `.prefault()` returns a
`ZodPrefault`, whose type carries none of the inner schema's methods — so the
upstream truth for `z.coerce.number().prefault(0).min(0)` is itself a
`TypeError`. The corpus says the chain is nevertheless a living idiom:
全职高手's variable-structure script is written entirely in it (158 `prefault`
sites, 5 chained), while the other four `prefault`-using cards call it only at
a chain's tail, where nothing follows and nothing breaks. A card that never ran
upstream is not evidence about upstream; it is evidence about what its author
believed `z` did — and under "every family must run as it does in ST", a
believed API the host can honour for the whole family is the mechanism to
implement.

**Iris.** The preset bundle installs a forwarding view before publishing `z`:
each classic schema prototype that owns `prefault` returns, instead of the bare
wrapper, a proxy that answers the wrapper's own members and forwards anything
else to the wrapped inner schema, re-applying the same prefault value to the
result. `prefault(0).min(0)` therefore composes as
`prefault(inner.min(0), 0)` — parse semantics identical to the author's left-
to-right reading, chainable, and safe to embed inside objects, records and
arrays. A contradictory chain (`prefault(0).min(1)` with no input) still
refuses; nothing clamps, because a clamp would be an approximate answer wearing
a schema's clothes. The install is deduplicated by prototype identity and runs
exactly once (the preset evaluates once per origin); `check-preset`'s `z` probe
now runs the measured chain against the built artifact, so a bundler change
that silently dropped the install fails the build instead of failing a card.

**What it costs.** A card probing the wrapper's *type* shape (`instanceof
ZodPrefault` on a chained result) sees the proxy, whose `Symbol.hasInstance`
target is unchanged, but a `getPrototypeOf`-sensitive walker would observe a
Proxy where it expects a plain object. No measured helper does this: `mvu_zod`
wraps the card's schema in `z.object(...)` (untouched — the wrapper sits
inside), `safeParse`s it, and reads `_zod.def`, all of which the proxy forwards.
If zod later makes `prefault` chain natively, the break-guard in
`tests/zod-compat.test.ts` fails on its first assertion and names the removal.

## 33. The state margin's "this round" is measured against the last snapshot this session witnessed, not against "the previous floor"

**Kind:** deliberate constraint — the task asked for the previous floor's
variables; the protocol does not carry them, and the protocol was not to be
touched.

**What changed.** The brief read "diff the current floor against the previous
one" (`chat_message.variables` is stored per floor, so the host could answer
it). But `chat.open` — the one channel the panel is allowed to keep reading —
carries only the **newest** turn's table. Rather than widen the protocol, the
panel diffs the snapshots it has already been handed: consecutive views are
consecutive floors whenever variables moved, which is the same comparison in
every case the reader can witness. The baseline is kept per chat in
`sessionStorage` (`iris.state.lastTree.<chatId>`), so the diff also survives a
page reload and a stream whose end landed while the event socket was cycling —
the two ordinary ways a long reading session loses the moment. On first sight
in a session the chat starts unmarked.

**What it costs.** Two genuine turns completing inside 90 seconds read as one
round — the tally sums them, which is arguably "everything since you looked".
A change that landed while *no* page was watching is invisible until the next
witnessed change; the panel never claims a diff it did not see. A browser
reopened tomorrow starts clean: `sessionStorage`, not `localStorage`, on
purpose — yesterday's news is not this round. `diffStats` itself is a pure
function over two trees (`state-panel.ts`), so if the protocol ever carries
floor tables, the same function answers the original brief with a different
caller. Along the way `sameValue` grew an equality the first live diff
needed: an **empty array re-created under a new identity is not a change** —
the host re-materialises tables wholesale, and `Object.is` on two fresh `[]`
reported every empty list as moved.

## 34. A branch renders open down to depth 1, folded below it — and the `toggle` event no longer gets to vote on what the reader did

**Kind:** interpretation of the brief, plus a measured bug in the obvious
implementation.

**What changed.** "各分支默认折叠只留顶层" is realised as: depth 0 (the
variable table's own shape) renders open, everything below folds behind a
count badge — `政局 14` is countable without being shown, which is the point.
The bug: `<details>` fires `toggle` whenever its state changes, **including
when this panel changes the `open` attribute** — a chat switch, a search
forcing hits open. Treating those echoes as reader input wrote one chat's
forced-open paths into another chat's fold memory (observed live: a chat that
was merely *visited* grew a `localStorage` record). Each tree level now keeps
the `open` value it last rendered per path and drops any event that agrees
with it — a real click always flips the DOM to the opposite of what was
rendered.

**What it costs.** A reader click that lands inside the millisecond window
between a store-driven re-render and its `toggle` dispatch can be swallowed —
the same window the old code raced unprotected; a second click folds it. The
rendered-open map is per mounted tree level, so nothing survives a branch
unmounting.

## 35. Long values clamp to two lines with the full text on hover, instead of wrapping without bound

**Kind:** deliberate reversal of this file's own earlier rule.

**What changed.** The margin previously argued (in `StatePanel.tsx`'s header)
that a long value should wrap the way prose wraps, because a 260px column that
scrolls sideways cannot show both ends of a line. Real MVU trees settled it:
values are frequently 20–40 character policy sentences, and unbounded wrapping
was half of the "information too much" complaint the rebuild answers. Stacked
values now clamp at two lines (`-webkit-line-clamp`), keep the prose face, and
carry the full text as `title` — truncation with the whole value one hover
away, and still no horizontal scrollbar anywhere.

**What it costs.** A reader who wants the whole sentence without hovering must
click nothing — it is not expandable, only hoverable. If touch-only reading
ever matters here, the hover needs a tap affordance.

## 36. The notice log now merges an identical notice into a counted row, inside a short window

**Kind:** deliberate reversal of a recorded decision, on new evidence.

**What changed.** `NoticeLog` refused dedup on the argument that "the same
sentence arriving twice is two events — that something recurred is usually the
finding". The reconnect schedule refuted the absolute form: during a host
restart it raises `the Iris event socket failed` every few seconds, and the
log filled with identical rows — one outage, four entries, no more information
per entry than the first. The store's `raise` now merges an identical neighbour
inside `NOTICE_DEDUP_WINDOW_MS` (10s — longer than any backoff step) into one
row carrying `×N`; the bar still re-announces on every recurrence (fresh
`seq`). Transport errors — the one species the client survives on its own —
are tagged at the source (`notifyTransportError`) and marked **resolved** when
the connection returns, dimmed in the log with a self-healed badge, plus one
`reconnected` line; an outage that logged nothing announces nothing.

**What it costs.** Two genuine occurrences of the same sentence inside ten
seconds read as one row with `×2` — the recurrence is still on the record, as
the count, but the per-event timestamps are gone. At the window's edge (the
backoff ceiling is exactly 10s) a long outage can still open a second row;
both carry counts, and the reconnected line closes them together.

## 37. One scrollbar, defined once in the token layer, imposed on every surface with `*`

**Kind:** deliberate globality.

**What changed.** Scrollbars were whatever each scroll container inherited —
which meant thick native grey bars in the reading column, the sidebar, the
state margin and the drawer, on a page whose whole grammar is hairlines. The
tokens now define `--iris-scrollbar` / `--iris-scrollbar-strong` (resting grey
below the rules in contrast; hover deepens), and the token layer itself sets
`scrollbar-width: thin` + `scrollbar-color` on `*` alongside the
`::-webkit-scrollbar` capsule (8px hit area, 2px transparent border, 999px
radius, transparent track). Both mechanisms, because Chromium 121+ prefers the
standard pair and then *ignores* the webkit rules: current Chromium loses the
hover state (the standard property cannot express one), older WebKit gets the
full capsule. The dsh primitives' scrollbar aliases now point at the same
tokens.

**What it costs.** `*` reaches every surface by construction, so a panel
cannot forget — and equally cannot opt out. Card frames' inner documents are
their own origins and keep native scrollbars, which is out of reach by the
same token. `scrollbar-gutter: stable` on the reading column now reserves a
*thin* gutter: the message column's centre shifts less on first overflow than
before, and card interfaces reading the container width see the content box,
which already excludes the gutter.


## 38. An interface frame's fault raises an error notice beside its graded report

**Kind:** channel completion — the same event now reaches the same two channels
the script-frame side has always used.

**What changed.** `MessageInterfaces`' host passed `onError` to
`addCardReport` alone; the fault was on record in the card panel and **silent
everywhere else**. The script-frame host (`useCardScripts`'s `onFailure`) has
always done both — a graded report as the record and a `notify('error', …)` as
the immediate signal — and an interface frame's uncaught error is the same
species of event. It now raises the notice too. This was the measured cause of
"the card errored and the notice panel is empty": on the interface-rendering
cards (the corpus's dominant families put the card's generation-time code in
markup), every frame fault after the move into message frames stopped short of
the one panel that answers "what did this session say".

**What it costs.** A burst of interface faults now interrupts the notice bar
where it used to be quiet everywhere but the scripts panel. The store's dedup
window (§36, and the recurrence identity of §39) collapses a burst of the same
fault into one counted row, and distinct faults were never the kind of quiet a
reader was served by.

## 39. The notice log's recurrence identity blanks per-run addresses

**Kind:** dedup identity, widened no further than the noise goes.

**What changed.** `repeatsLatestNotice` compared exact text. A card's scripts
evaluate from a fresh blob URL on every run and the frame's error reports quote
it with a stack position, so the *same* bug arrived as a different sentence
each run and exact-text dedup collapsed nothing — measured: three re-opens of
one faulty card read as three separate rows. The identity is now
`noticeRecurrenceKey(text)`: `blob:` references (positions included) blanked,
every other byte compared. The merged row carries the **newest** occurrence's
verbatim text, matching its `at`.

**What it costs.** Two failures that differ only in which run they happened in
read as one counted row rather than two rows. Two failures that say anything
differently about the cause are still two rows; the first and only occurrence
of anything is still a row of its own — the blanking applies to addresses and
nothing else.

## 40. The composer shares the reading column's centre line — lane, box, and inset

**Kind:** geometry parity, stated in CSS rather than measured by hand.

**What changed.** Three silent offsets put the composer's midline 19px right of
the message prose's (measured on HEAD at 1920×1080 and 1366×768): the field's
`width: 100%` resolved as **content** width, so the textarea overflowed
`__inner` by its own padding plus border (+14px at centre); the reading
surface's `scrollbar-gutter: stable` centred the column in a box the composer
did not reserve (+5px); and the narrow-window stylesheet zeroed the composer's
gutter inset while the prose kept its marginalia track (+17px at ≤880px, until
then masked by the first bug's opposite sign). Now: the field is
`box-sizing: border-box`; `.iris-composer` reserves the same lane
(`overflow-y: auto; scrollbar-gutter: stable; min-height: max-content` — the
reservation needs a scroll container, and the min-height hands back the
automatic minimum a scroll container loses, so a short window cannot squash
the composer into an internal scroller); the narrow override is gone, so the
inner inset is `var(--iris-gutter)` at every width, mirroring `.iris-msg`'s
marginalia track. The asymmetric `padding-left` itself stays: the prose starts
one gutter in from the column's content edge, and the field starts one gutter
in from the composer's — the two centres coincide exactly. Measured after:
0.00px at 1920×1080, 1366×768 and 800×700, with the lane reserved
(`stable`) so a scrollbar's appearance moves neither centre.

**What it costs.** The composer is a scroll container; its lane is reserved
even on the empty surface, and the field is inset by the gutter on narrow
windows where it used to run full width — under the prose, which is the
point. The lane's width is the UA's thin scrollbar, not a token, so the
*reserved* amount is not project-owned; the *parity* is, because both
surfaces ask the same question of the same browser.

---

## 41. A card's remote stylesheet is refused, and its font never arrives

**Kind:** compatibility gap — the mechanism that closes it is ruled and queued, not built.

**Upstream.** There is no policy layer here at all. SillyTavern mounts helmet with the CSP switched off — `app.use(helmet({ contentSecurityPolicy: false }))`, `[ST] src/server-main.js:103-106` — and that is its only CSP source: `public/index.html` carries no `<meta http-equiv>`, and the string `Content-Security-Policy` occurs nowhere under `public/` or `src/` (excluding `third-party/` and `lib/`). The message frame adds none either: TavernHelper's generated document (`[TH] src/panel/render/iframe.ts:78-103`) is a charset meta, a viewport meta, an optional `<base>`, one `<style>`, the third-party head block and four scripts — no CSP meta, and no `sandbox` attribute anywhere in `src/panel/render/` or `src/panel/script/`. **And the host frame is itself doing the thing in question**: `[TH] src/iframe/third_party_message.html` links two remote stylesheets and five remote scripts from `testingcf.jsdelivr.net`, plus a sixth remote script at `iframe.ts:95`. So a card adding one more `<link rel="stylesheet">` to any host is doing what the frame around it already does. (Read from the operator's install: ST `1.18.0`, TH `4.9.1`.)

**Iris** refuses it. `style-src` admits `fonts.googleapis.com` and `'unsafe-inline'` by default and widens to `https:` only under a per-card network grant; `font-src` is `data: https://fonts.gstatic.com` **unconditionally** (`sandbox/srcdoc.ts:120-124`, `:156`). The refusal is named rather than silent: the bootstrap listens for `securitypolicyviolation` and posts the blocked host to the shell, which shows it beside the frame with the directive that refused it.

**Why not an allow-list entry.** Ruled, 2026-09-06: `fontsapi.zeoseven.com` is one card and the next card is a different host, so a list keyed on hosts observed in the corpus is a per-card fix wearing a policy's clothes. This is one family — *a card referencing a remote stylesheet or font* — and the mechanism-layer answer is a **host-side proxy for remote stylesheets**, on the route the script bundles already take, rewriting the fetched CSS's own `@font-face` `src` to proxy URLs so `style-src`/`font-src` stay at `self`. Queued in `ROADMAP.md`; the reading behind it is in `SANDBOX.md`.

**Measured, not inferred.** `Lights_ON.png`, read through `decodeCardPng`: the font link is **not in the greeting**. `first_mes` is three characters (`嘎嘎嘎`) and `alternate_greetings[0]` is three more (`咕咕咕`); the 30 188-character document is produced by the card's regex layer at display time. `data.extensions.regex_scripts` holds five scripts, all enabled, all `placement: [2]` (`AI_OUTPUT`, `[ST] public/scripts/extensions/regex/engine.js:281-287`), and **all five** carry the same pair of lines in a `<head>` they write themselves:

```html
<link href="https://fontsapi.zeoseven.com/925/main/result.css" onload="this.rel='stylesheet'" rel="preload" as="style" crossorigin />
<noscript><link rel="stylesheet" href="https://fontsapi.zeoseven.com/925/main/result.css" /></noscript>
```

for `body { font-family: "Ark Pixel 12px Prop latin", sans-serif; font-size: 8px; }`. Ten references across five emission points, in one card — which is why this is filed as a family and not as a card.

**Four gates sit on those two lines, and only the first has been observed.**
`style-src` governs the `as="style"` preload — that is the refusal in the report. `font-src` governs the faces named inside that CSS, which resolve against the CSS's own URL and may live on a **different host**; this is the shape already encoded for Google at `srcdoc.ts:88-91` (*"`fonts.googleapis.com` serves the CSS, `fonts.gstatic.com` the faces — both are needed or neither works"*). `script-src` governs the `onload` rel-swap, and that gate is already open (`'unsafe-inline'`, `srcdoc.ts:153`) — the `<noscript>` twin is inert in a scripted frame, so it is a no-JS fallback and not a second path. And the preload carries **`crossorigin`**, making it a CORS-mode fetch from an **opaque origin**, so the response must answer `Access-Control-Allow-Origin: null` or `*` or the browser discards it *after* CSP has allowed it. **A host-side proxy meets none of the four; a per-host allow-list would open only the first.**

**What it costs.** The document typesets in the fallback `sans-serif` at 8px and the card's pixel font never arrives. The handoff note for that card records a second-order effect — the late/absent font as a disturbance source in the height loop (`NOTES-handoff.md` §2, their observation, not re-measured here). **And the existing per-card network grant does not close it**: a granted card gets the stylesheet, because the grant widens `style-src` to `https:`, and still gets no faces, because `font-src` has no grant branch — so the visible outcome moves from "no font, `style-src` named" to "no font, `font-src` named, pointing at a host nobody has seen yet". Out of scope here and unchanged: the same card's eight `img.remit.ee` images, which ride `img-src` and the existing grant.

**What would overturn it.** The stylesheet proxy landing. At that point a card's remote stylesheet loads with `style-src`/`font-src` still at `self`, this entry closes, and what replaces it is a note on what the proxy rewrites and what it does not.

---

## 42. `Mvu` is predefined per script, not per frame, and is never backfilled

**Kind:** faithful reproduction across a structural difference — the behaviour is upstream's, the placement cannot be.

**Upstream.** `predefine.js:36-44` runs at a script iframe's bootstrap and asks once whether the shared parent already holds `Mvu`. On a hit it defines a live accessor on that frame's own window (`get: () => _.get(window.parent,'Mvu')`, empty `set`, `configurable`); on a miss it installs nothing and never revisits. One name, conditionally — the other members ride the `_.pick` allow-list at `predefine.js:11-19`. The author's own comment calls it a compatibility patch and points at `waitGlobalInitialized` as the supported route.

**Iris** does the same thing at a different moment, because the moment upstream uses does not exist here. Upstream gives **every script its own iframe**, so "when the frame boots" is "when the script starts". Iris runs all of a card's scripts in **one** frame, so frame bootstrap happens once — and always before the card's own MVU script, which is what publishes `Mvu`. Checking there would be a guard that can never fire. The check therefore runs immediately before **each script body** (`frame.ts`, the `run` handler): if the card's shared namespace already holds `Mvu`, install the accessor through `definePredefined`; otherwise install nothing, and do not revisit.

`definePredefined` is a separate door from `defineForwarding` on purpose. The two upstream sites differ in exactly one thing: `predefine.js` writes an empty setter, so a card assigning the name is ignored; `waitGlobalInitialized` writes a getter alone, so the same assignment throws in a module's strict mode. Folding them into one door with a flag would file that difference where nobody reads it.

**Why the wait path is still the thing that has to work.** `waitGlobalInitialized` is what actually installs the name for the cards that ask properly, and it is unchanged. This entry is only about the cards that never ask.

**Measured: who this can reach.** Three script units in the corpus read `Mvu` and never await it. In all three, the reading unit is declared **after** its card's MVU publisher:

| card | script order (publisher ▸ reader) |
| --- | --- |
| 魔法少女是不会败北恶堕的吧！ | `#1 [MVU变量框架]var_update` ▸ `#3 魔法少女-MVU变量维护监视器` |
| 灭仇家满门之后，我收养了想对我复仇的孤女 | `#1 MVU` ▸ `#3 气泡面板` |
| 绿茵好莱坞 | `#2 MVUbeta` ▸ `#3 状态栏` |

**And declaration order is not the boundary — this is the part that matters.** The runner posts every `run` message in one loop without awaiting (`runner.ts`, *"Sent together rather than awaited one at a time"*), and a module body evaluates asynchronously. So when a later script's `run` is handled, the earlier MVU script has begun a dynamic import and has **not** published yet: the bundle is fetched through the host proxy, and its own `fetch('/version')` was measured arriving 3–8 s after the chat opened. For a module-mode card — which every MVU card is, since the publisher is an `import` — the check will therefore usually **miss**, and these three units keep reading `undefined`.

That is inference from the runner's own comment plus those timings, **not** a direct reading of the namespace at each script's dispatch. It is cheap to settle: re-run the script-frame probe on 绿茵好莱坞 after a build and read `Object.getOwnPropertyDescriptor(window,'Mvu')` in the script frame without awaiting — `present` means the check fired, `absent` means it did not.

**What it costs.** Nearly nothing today, and that is the honest summary: the mechanism is upstream's and correctly placed, and the population it currently rescues is probably empty. It is here so that the conditional exists in the right shape when something does publish early enough — a classic-mode publisher, or a future change that lets a provider settle before its siblings start.

**What would overturn it.** Either half. A reading showing the check does fire for a module-mode card retires the paragraph above. A ruling that Iris should serialise a card's scripts, or publish `Mvu` into the script frame's globals unconditionally, would replace this entry with a deliberate-improvement one — both give cards more than upstream, which is why neither was taken here.


## 43. The page root carries SillyTavern's theme variable names, aliased to Iris tokens

**Kind:** compatibility gap, closed.

**Upstream.** A card's HTML that is not inside a fenced full document lands in `.mes_text`, in the page's own DOM (`UPSTREAM-THEME-VARS.md` §三之二: `decodeStyleTags` scopes selectors under `.mes_text ` and rewrites class names to `custom-*`, but leaves declarations alone). Such a card can write `color: var(--SmartThemeBodyColor)` and it resolves against the sixteen `--SmartTheme*` names ST defines on `:root` (`style.css:71-89`), plus `--mainFontFamily`, `--monoFontFamily`, `--mainFontSize`, `--fontScale`, `--sheldWidth`, `--blurStrength`, `--shadowWidth`. It cannot redefine them at the root — `.mes_text :root{}` matches nothing — so the relationship is read-only.

**Iris** renders the same family into its own page DOM (`inline-html.ts`, `card-css.ts`), so the same `var()` used to resolve to nothing. `theme/tokens.css` now defines every one of those names, per theme, as an alias of the Iris token with the same meaning (body → ink, quote → warn, blur tint → raised paper, and so on; the three unitless multipliers stay unitless because upstream multiplies them in `calc()`). The list is pinned by `tests/st-theme-aliases.test.ts` against §七 of the upstream note.

**Measured.** 0 of 29 deduplicated corpus cards read any of these names today (§八, whole-JSON grep with a positive control). The gap is closed anyway because the mechanism is upstream's and a card family that uses it exists in the wild; the corpus is the oracle for what breaks, not for what is allowed to work.

**What it costs.** Twenty-odd custom properties on `:root`, and a second name for each colour a future theme author has to keep in step — the test makes that a red build rather than a silent drift.

**What would overturn it.** Nothing about the aliases themselves; the open question is the frames, which is entry 45.

## 44. Card frames are `color-scheme: light`, whatever the page theme

**Kind:** faithful reproduction.

**Upstream.** `style.css:167` puts `color-scheme: only light` on `body`, and the TavernHelper frame documents declare nothing, so a card's frame renders its form controls and scrollbars in the light scheme on every ST theme, including the dark default (§六). A card author who styled a dark panel saw light `<select>` arrows and a light scrollbar inside it, and shipped it that way.

**Iris** frames used to follow the page theme — `reading.css` said `normal`, which the spec defines as "the page's scheme", and every Iris theme declares one at the root; the overlay frame inherited the same way. Both kinds now say `light`: the slot rule, the overlay `attach`, and the two `srcdoc` resets, pinned by `tests/frame-color-scheme.test.ts`.

**Open detail.** Upstream writes `only light`; Iris writes `light`. Chromium does not auto-darken under either, so no visible difference is expected, but `only` on a frame element was not verified in a browser. Recorded here so the difference is a decision and not an oversight.

**What would overturn it.** A ruling that Iris frames should look native under the 墨 theme — that would move this to a deliberate improvement, with the cost that cards designed against light controls change appearance.

## 45. No theme information is pushed into card frames

**Kind:** deliberate improvement, declined for now.

**Upstream** hands a frame exactly one variable, `--TH-viewport-height`, and nothing about colours, fonts, or dark/light (§二). Iris injects the same one variable and no more; the `--SmartTheme*` aliases of entry 43 stop at the page root, and `tests/st-theme-aliases.test.ts` asserts that `src/sandbox/**` never mentions them.

**Why declined.** A bridge into the frame would give cards something upstream does not — that is the improvement ledger, and it needs a consumer. The corpus has none: the eight cards that theme themselves with variables define their own (`--bg-color`, `--main-bg`, `--bg`), and eleven hard-code colours (§八). Two cards hard-code light text on a transparent ground and are unreadable on a light host theme; they are unreadable on ST's light themes too, and a bridge they do not read would not help them.

**What would reopen it.** A card that reads `--SmartTheme*` inside a fenced document, or a decision to offer card authors an Iris-specific theme contract — in which case the aliases already defined at the root are the obvious thing to mirror.

---

## 46. A tag name no browser recognises is removed from a message's prose, and its content kept

**Kind:** compatibility gap, closed.

**Upstream.** `messageFormatting` hands the whole formatted message to DOMPurify with no `ALLOWED_TAGS` and no `USE_PROFILES` — only `ADD_TAGS: ['custom-style']` (`public/script.js:1898-1908`) — so a card's `<Gui>` reaches the sanitizer as a real `HTMLUnknownElement`, because showdown passes raw HTML through untouched (its `hashHTMLSpans` hashes the span and restores it verbatim, `showdown.js:3567-3593`; the fence inside was already turned into `<pre><code>` by `githubCodeBlocks` at `:2504`, which runs first). DOMPurify then takes the branch at `dompurify/dist/purify.cjs.js:1894`, which hands the node to `_sanitizeDisallowedNode` (`:1743`): a name outside the allow-list has its children re-inserted where it stood and the element is force-removed — unless the name is in `FORBID_CONTENTS` (the list at `:724`, the guard at `:1756`), when the subtree goes with it. (Line numbers are the `^3.4.14` copy this app depends on and the drift test reads; the measured SillyTavern checkout resolved 3.4.2, where the same code is inline at `:1029-1052`.) So the element does not survive, its content does, and a self-closing `<StatusPlaceHolderImpl/>` — which has no children — simply disappears. Upstream's own `uponSanitizeElement` hook has an `HTMLUnknownElement` branch that converts newlines inside one to `<br>` and deliberately skips text under a `<pre>` (`public/scripts/chats.js:1943-1972`); that branch exists *because* these elements arrive as elements, and the `<pre>` exemption is there because the fence inside the wrapper is exactly this card's shape. Nothing upstream of ST consumes the tags either: JS-Slash-Runner's predicate reads already-rendered `<pre>` text (`src/util/is_frontend.ts:1-3`) and hooks `CHARACTER_MESSAGE_RENDERED` (`src/store/iframe_runtimes/message.ts:121`), i.e. strictly after `messageFormatting`; it has no occurrence of `Gui` or `StatusPlaceHolder` in either its sources or its bundle.

**Iris, before.** The message renderer disables raw HTML (see entry 25), so prose reaches `MarkdownText` and every tag left in it is escaped and shown as source. `app/html-regions.ts` routes *line-initial CommonMark block tags* to the frame path, and its `BLOCK_TAGS` is CommonMark's own type-6 list — deliberately, so the split and the renderer's parse cannot disagree. `gui` and `statusplaceholderimpl` are not on that list, so those lines stayed markdown and were escaped. Measured in the browser on 灭仇家满门之后，我收养了想对我复仇的孤女: the row showed a line of literal `<Gui>`, the interface, then a line of literal `</Gui> <StatusPlaceHolderImpl/>` — three strings its author has never seen in SillyTavern.

**Iris, now.** `app/inline-html.ts` reproduces exactly that one piece of the sanitizer on the **string**, because there is no tree to sanitize: `unwrapUnknownTags` removes markup whose name is not in `KNOWN_ELEMENTS` and keeps its content, and removes element *and* content for the names in `UNKNOWN_CONTENT_FORBIDDEN`. Both sets are transcriptions of DOMPurify's defaults and both are compared against the installed copy in `tests/inline-html.test.ts` rather than trusted — a constant that encodes a measurement drifts silently otherwise. `sandbox/frontend-blocks.ts`'s `unwrapUnknownTagsOutsideCode` decides *where* the rule may run, and lives there because that module already owns the one line-walk that knows where a message's code blocks are; code is skipped whatever it is, fenced or indented, claimed or not, which is upstream's behaviour one layer down. `MessageInterfaces` applies it to every string it hands the renderer — both call sites, the claimed-block split and the no-block early return — and drops a prose segment that the rule empties, so the wrapper's line does not become a blank paragraph.

**Recognised names are deliberately untouched.** `<b>`, `<span style=…>` and the rest still reach the reader as escaped source. That is the older and larger gap — the sanitizer-based inline path of `INLINE-HTML.md` §三, which entry 25 records as deliberately not taken — and removing their tags here would change what it looks like without closing it, while silently discarding the emphasis the card asked for.

**Nothing here is a sanitizer, and nothing here relaxes one.** The output goes to `MarkdownText`, which renders it as text, so this transform cannot create an element; `FORBIDDEN_TAGS`, `FORBIDDEN_ATTRS` and `ALLOWED_URI` are unchanged and `auditSanitized` still flags a surviving `<script>`, `<iframe>` or `on*`. Where the two meet, this rule is the *tighter* of the two: `script` and `iframe` are absent from DOMPurify's allow-list and present in its `FORBID_CONTENTS`, so a `<script>` in prose now loses its body as well as its tags — previously the body was on screen as text.

**Measured impact** (26 distinct card bodies: the 19 in `E:/sillyTavern/.../characters` plus 7 under `测试用卡`, all 26 parsed by the repo's own `packages/iris-character` reader, 0 failures; the 28 further PNGs under `characters/Seraphina/` carry no card chunk and are expression sprites). Two populations, kept apart because they describe different surfaces:

| population | cards with ≥1 unknown name outside code | occurrences | distinct names |
| --- | --- | --- | --- |
| `first_mes` + `alternate_greetings` | **11 / 26** | 131 | 24 |
| regex `replaceString` | **18 / 26** | 81 | 35 |

`statusplaceholderimpl` alone accounts for 6 of the 11 and 14 of the 18: this is **one mechanism**, not 24 or 35 independent names — the tail is single-card (`updatevariable`, `analysis`, `now_plot`, `pic`, `status_block`, `gui`, …). Two numbers that would mislead if quoted without their filter: on whole text the regex column reads **623** rather than 81, and the whole of that gap is fenced code — 71 `replaceString`s across 13 cards are a ``` fence holding a complete `<!DOCTYPE html>` document, which is the *frame* path's payload and not this rule's business (all 71 `<!DOCTYPE` occurrences and 345 of 351 `<!--` live there). The columns above are the markdown surface only. `<!DOCTYPE` outside code: **0 cards**.

**What it costs.**

- An unrecognised tag is now invisible rather than visible, so a card author's typo (`<dvi>`) is silent. That is upstream's cost too, and it is the reason `unwrapUnknownTags` is documented as reproducing a sanitizer rather than inventing a policy.
- `[^>]*` is a lexer, not a tokenizer: an unrecognised tag whose attribute value contains a literal `>` ends early and leaves the remainder as text. No corpus card does this, and the failure is visible rather than silent.
- One more linear scan of the message body per render, including per token while a reply streams — the early-return path deliberately keeps the rule during streaming, because the alternative is the wrapper flashing on screen and then vanishing. It sits beside a full markdown re-parse of the same string, which is the larger cost on that path and the reason this one was not made conditional.
- `selectedcontent` is stripped with its content here and unwrapped upstream, because it entered `FORBID_CONTENTS` after the 3.4.2 that the measured SillyTavern checkout resolved, while this app depends on `^3.4.14`. The set is defined as "what our DOMPurify does" so that the drift test can compare it to exactly that.
- **The one interaction to watch.** SillyTavern's legacy angle macros `<USER>` / `<BOT>` / `<CHAR>` (`public/scripts/macros.js:624-626`) are tag-shaped and are not element names. Iris expands the first two (`packages/iris-macro/src/expand.ts:109-110`) before rendering, so this rule never sees them; it does **not** expand `<CHAR>`, which therefore now *disappears* where it used to show as literal text. No corpus card writes `<CHAR>` (the census's `user` hits, 2 cards, are the macro Iris already expands), so the cost is zero today — but the fix is in `iris-macro`, not here.

**What would overturn it.** A card that relies on an unknown tag being *shown* — none does; the shape's whole purpose is to be a marker for a regex or for a renderer. Or a decision to take the inline sanitizer path of `INLINE-HTML.md` §三, which would subsume this rule entirely: with a real tree to sanitize, DOMPurify's own branch does this and the string transform would be deleted rather than kept beside it.

---

## 47. The interface shows the provider's reported token usage, where upstream shows its own estimate of the reply

**Kind:** deliberate improvement.

**Upstream** never reads a provider's `usage` object. In SillyTavern 1.18.0 the whole front end contains four occurrences of `*prompt_tokens*` and none of them is a reported figure — two are the `max_completion_tokens` request field (`public/scripts/openai.js:2983`, `:3006`), two are the prompt manager's own estimate (`PromptManager.js:1761` and its header template) — and the only server-side hit is the string `truncate_prompt_tokens` in the passthrough parameter allow-lists (`src/constants.js:293`, `:428`). `cached_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` appear **nowhere** in the checkout. So no cache-hit share is available to a SillyTavern reader at all, and no billed input or output count either.

What upstream *does* show per message is `extra.token_count`: **its own tokenizer's count of the reply text**, written after a generation settles (`public/script.js:3638`, `:5830`, `:6629` and five more sites, all `getTokenCountAsync(reasoning + mes, 0)`) and rendered as inline text `{n}t` in the message block (`:2605`, `:10243`, into `.tokenCounterDisplay`, `public/index.html:7386`). It is gated on `power_user.message_token_count_enabled`, which defaults to `false` (`power-user.js:199`) and is `true` in the measured profile — the same shape as `mesIDDisplay_enabled`, the floor-number setting `app/Message.tsx` records at its own render site. Hovering a message shows the generation timer's title, which carries a **rate** derived from that same estimate (`Token rate: {n} t/s`, `:2697`), not a usage breakdown.

**Iris** shows the reported values, in two places: the conversation's total under the composer (`Cache hit 56% | Input 21.6K tok · Output 3.4K tok`, from `ChatView.usage`), and each reply's own total in its actions row (`Usage 7.2K`), whose `title` carries the breakdown — cache hit, uncached input, cached input, cache write, output and the reasoning inside it. Formatting is `app/token-format.ts`; the copy is the `usage*` keys of `i18n/strings.ts`.

**Why.** The three prompt-side buckets are what a request is actually billed on, and the cache-hit share is the one number that tells a reader whether a long-running scene is costing them a full prompt per turn or a tenth of one. It is knowable — every provider Iris speaks to reports it — and upstream simply does not carry it far enough forward to be shown.

**What it costs.**

- **It depends on the provider reporting.** No report, no row: `MessageView.usage` and `ChatView.usage` are optional, an absent bucket is never zero-filled, and a provider silent about caching gets **no** cache-hit line rather than `0%` — the two are different facts and `token-format.ts` keeps them apart (`cacheHitPercent` returns `null`, not `'0'`).
- **Every floor imported from a SillyTavern chat file has none**, and always will: what upstream stored is its own estimate under a different name, and back-filling `usage` from it would be manufacturing a bill. So a migrated conversation shows readings only from the turns generated in Iris, and its composer total counts only those.
- **The two numbers must not be called the same thing**, and this is the live conflation risk: upstream's `{n}t` is an *estimate*, of the *reply text only*, by *Iris's own tokenizer* if we ever computed it; Iris's `用量 7.2K` is the *provider's* count of the *whole turn*, prompt side included. They differ by the entire prompt and can differ on the reply too. The interface therefore words them apart — 「用量」 only ever means reported billing, and the prompt panel's estimate keeps 「估算」 (`STRINGS.md` §三 records the convention) — and neither surface prints the other's number.
- The per-turn breakdown is a native `title`, so it is unreachable by touch and unreadable by a screen reader as a table. The harness shows the same rows in an anchored dialog; the rows are assembled in that dialog's order (`usageDetailText`) so the copy moves over unchanged when the dialog is built.

**What would overturn it.** A ruling that Iris should also carry upstream's estimate — which is a *different* entry, not this one: it would mean computing a count for imported floors so that a migrated conversation is not blank, and it would need its own word in the interface. Or a provider population where the reported figures are unreliable enough that showing them is worse than showing nothing; nothing measured so far suggests that.
## 48. The world book panel groups books by whose card they are; upstream lays every book out flat

**Kind:** deliberate improvement.

**Upstream.** SillyTavern's World Info panel has no notion of "this card's book". Its top block is `#WIMultiSelector` — one `<select multiple>` labelled *Active World(s) for all chats* (`public/index.html:4689`) — and its editor block is `#world_editor_select`, a *--- Pick to Edit ---* dropdown (`:4822`). Both are filled by **the same loop over the same flat name list**, in `world-info.js:1001-1011` and again in `:2072-2081`: `world_names.forEach` appends one `<option>` per book to each selector, sorted by name, with nothing said about where a book came from. The per-card binding lives in an entirely different panel — the character editor's globe button, `#world_button` (`:6060`), which opens the `character_world_template` popup (`:6728`) and writes the hidden `#character_world` field. So on upstream, "which book is this card's" is a question you answer by leaving the world-info panel and opening the card.

**Iris, before.** The panel reproduced that shape one layer thinner: the global multi-select first, as one `.iris-choice` row of every book name; then, for the open chat's character, the extra-bindings row with the card's own binding as a `worldbookCharPrimary` note above it. Same flat list, same absence of provenance.

**Iris, now.** Three sections, in this order: **this card's book** (which book, how many entries, whether it is a file or still only embedded in the card, and — when the two differ — why the name on screen is not the name on the card), **this card's extra books** (unchanged, still the only binding this panel writes), and **the global selection**, whose selected books stay in view while the rest of the disk folds behind *Show all N books*. Every book row carries its entry count and, when a card claims it, `from ⟨card⟩`.

**The host's selection rule is untouched, and the panel now states it.** `@iris/app-service/worldbooks`' `resolveCardWorldbook` still chooses — the bound book, else the embedded copy, never both — and still *adds* the globally selected books on top, which is upstream's `[...chatLore, ...personaLore, ...characterLore, ...globalLore]` (`world-info.js:4478`). Nothing about which books reach a prompt changed in this round. What changed is that `worldbookCardRule` says so on screen, because the report this entry answers was half "I can't find my card's book" and half "conversations should bind their own book, not be polluted by other books" — and the second half was already true and entirely invisible.

**What it was measured against.** The reporter's own profile, `apps/iris/data/default-user`:

| reading | number |
| --- | --- |
| books in `worlds/` | 10 |
| of those, with a materialisation record (`worldbook-bindings.json`) | **10** |
| whose file name is not the card's own id | **8 of 10** |
| minted after a name collision (`origin: 'minted'`) | **0** |

So on this profile the strong ownership rule — what this host materialised, and out of which card — covers every book on disk, and eight of the ten needed it: `Sgw又看一集` → `【Sgw】『普通』和『理所当然』是什么呢 2.3（好感度x10版）`, `爱衣` → `爱衣妹妹v1.1`, `魔法少女的扣扣审判1` → `扣扣审判1.0`, `战锤群星闪耀` → `战锤群星闪耀_世界书`, and four more. The first of those is the exact row the report was about: 140 entries, a name sharing no visible prefix with the card, and nine strangers beside it in one flat control. The SillyTavern install measured alongside carries **18** books in `data/default-user/worlds`, which is the size this layout has to survive.

**What it costs.**

- **A second call shape.** Entry counts mean opening every book, which is precisely the cost `worldbook.names` documents itself as avoiding ("names, not contents … so listing books does not read 1478 entries off the disk"). So the counts are opt-in — `worldbook.names`' `withCounts` — and a card asking what books exist still pays for a directory listing. The panel pays 18 file reads once per drawer open.
- **The weak ownership rule reaches one card.** A book the user made in SillyTavern and bound by hand has no materialisation record, so the only link left is that some card's `extensions.world` spells its name — and the client holds exactly one card's binding, the open chat's. On the profile above this costs nothing (10 of 10 have the strong record), but on a profile imported wholesale from SillyTavern it would leave books unlabelled. Closing it means either a binding per card on `CharacterSummary` or a host-side sweep that decodes every card, which `library.ts` measures at about two seconds for nineteen; neither is worth a label.
- **The global list is one click further away.** A reader who came to change the global selection now opens a fold first. That is the trade the crowding complaint asks for, and the count in the fold's own label is what keeps a folded list from reading as a missing one.
- **`source: 'embedded'` is a state upstream cannot be in.** Upstream reads the embedded `character_book` only at import, after a prompt; Iris materialises on the import and open paths, so a card that has never been opened here sits with entries and no file. The panel names that state rather than showing nothing, which is a small extra vocabulary a SillyTavern user has not met.

**What would overturn it.** A ruling that the panel should be upstream-shaped for muscle memory — in which case the card's book belongs on the character page instead, beside the counts already there, and this panel goes back to being a book chooser. Or `CharacterSummary` growing the card's binding, which would make the weak rule cover the whole library and remove the one hedge above.
## 49. An API key is typed once, and the model is picked from the endpoint's own list

**Kind:** two compatibility gaps, closed — plus one deliberate improvement, recorded separately in entry 50.

**The report** (user, 2026-09-07, verbatim): 「设置里面的连接，每次测试连接都要重新填一次 apikey，众所周知 apikey 在绝大多数平台都是只能看到一次」 and 「路由这块模型选择怎么让用户自己输字填，那填不对咋办，所以要改从 models list 里面选择」.

**Upstream does both of these already**, which is what makes them gaps rather than ideas:

- **The key.** `openai.js`'s key fields are `<input type="password">`, and the value never comes back to the page: the key is POSTed to `/api/secrets/write` and read back only as a presence flag through `/api/secrets/read` (`secrets.js`'s `SECRET_KEYS` / `writeSecret` / `secretState`), which is why upstream's connection panel shows a masked "key saved" state and its Connect button works without a re-paste. Iris already stored the key write-only and already showed the mask — the store's `keyTailOf`, the panel's `apiKeyStored` line — so the storage half was never the gap. The gap was that **`connection.test` had no way to be asked to use it**: the panel only ever sent `{ baseURL, apiKey: <what is in the field> }`, so an empty field meant an empty key and the probe of a saved profile failed until the user pasted a credential their provider had shown them once.
- **The model.** Upstream's is a `<select id="model_openai_select">`, and `getStatusOpen` fills it from the endpoint's `/models` (`openai.js`'s `loadOpenAIModels` / the per-provider `load*Models` family). Iris had a **text input with a `<datalist>`** — which offers the list as autocomplete and accepts any string typed past it, so a mistyped id was accepted here and failed later, inside a generation, with the provider's own error message and no connection to the field that caused it.

**Iris, now.**

- `connection.test`'s `apiKey` is optional **as a request, not an omission**. Absent (or empty) asks the host to probe with what it already holds, in a precedence of decisions, newest first: the key just typed → the named profile's stored key → the active profile's stored key → the credential the host process was started with. The verdict carries `keySource: 'typed' | 'stored' | 'host' | 'none'` on every answer, including the refusals that never reach a socket, because a pass means three different things depending on which key produced it — and a form reporting only "ok" would let a reader believe they had validated a key they never sent.
- **Every fallback is gated on the endpoint's origin.** A key is reused only at the origin it belongs to; a probe pointed anywhere else goes out bare with `keySource: 'none'`. This is the load-bearing line of the whole change: without it, an absent `apiKey` would be a way for the page to ask the host to post the user's credential to an address of the page's choosing — the page cannot *read* the key, but it could still spend it. `packages/iris-app-service/tests/connections.test.ts` asserts both directions, and the assertion was verified to fail when the origin comparison is replaced with `true`.
- The key field's placeholder now says that blank keeps the saved key (`apiKeyPlaceholderKeep`), and a profile with no key of its own whose endpoint the **host's** credential covers says so (`apiKeyFromHost`). Clearing stays an explicit button, never a consequence of an empty field. `tests/connection-key-field.test.ts` pins that the field is the only `type="password"` in the panel and that its `value` is the form's own scratch string — never `keyTail`, never anything from a profile read, never a `defaultValue`.
- The model control is a real `<select>` whenever a list exists. Three states are kept apart because the reader's next step differs in each: a list with entries (dropdown, with the current value kept as its own `(自定义)` row when the list does not carry it, so choosing can never be what loses a working model id); a list that came back **empty** (the endpoint answered and advertises nothing → text field, and it says that); and **no list at all** (nobody has probed → text field, and it says to press Test). A dropdown with no options would be a control that cannot be used and does not explain itself. "Refresh the model list" is the same probe under the name that answers the question the dropdown raises.
- Saving a model the last list did not contain is **reported, never refused** (`modelNotInList`): a list can be incomplete and a provider can serve aliases, so blocking would make the dropdown a cage. What must not happen is silence.

**No primitives `Select` component exists** — the dispatch for this work assumed one. The panel's provider dropdown was already a bare `<select className="iris-text iris-field__control">`, and the model dropdown follows that idiom rather than inventing a wrapper for a second caller.

**What it costs.**

- **Two readers of the origin rule.** The host decides with `sameEndpointOrigin` (`packages/iris-app-service/src/connections.ts`); the panel has its own `sameOrigin` for deciding *which sentence to print* about the key field. That duplication is deliberate and asymmetric: a wrong answer in the panel mislabels a note, a wrong answer in the host posts a credential somewhere it does not belong. The panel's copy is documented as never being the permission.
- **Origin, not the full URL.** `https://x/v1` and `https://x/v1beta/openai` share a credential and are treated as one place. A host that serves two tenants on one origin with different keys would have the first key offered for the second path. No such endpoint is in play, and the alternative — demanding a character-identical base URL — would refuse to reuse a key the user plainly meant.
- **A model list is now stored per profile** (`ConnectionProfile.models` + `modelsProbedAt`), which is the first thing in that file that the user did not type. It is admitted as an *observation with a timestamp* rather than a derived description, and it is dropped whenever the endpoint moves — a list from the address a profile used to point at is another server's answer, not a stale version of this one's. Without the store, the composer's capsule could not offer a list without first making the reader open the settings panel and probe.
- The connections are now read at **boot** (silently caught, on the `loadPresets` precedent), because the composer needs the list from the first frame. One more RPC on a cold page.

**What would overturn it.** A provider whose `/models` requires a scope the generation key does not have, making the dropdown reliably empty where the text field worked — the empty-list fallback is already the answer, but it would become the common path rather than the edge. Or a per-path credential model, which would make the origin check too coarse and force the full-URL comparison this entry declines.

---

## 50. Pressing the model name under the composer switches the model for that conversation only

**Kind:** deliberate improvement. Upstream has no equivalent.

**The report** (user, 2026-09-07): 「输入框下面的模型名无法点击，这里可以做成点击对话框下的模型名可以快速切换模型且只对当前对话生效」.

**Upstream has one model selection, and it is global.** `oai_settings.openai_model` is a field of the settings object the whole install shares; switching it in the connection panel switches it for every chat, and there is no per-chat layer for it — `chat_metadata` carries no model. So the *scope* asked for here does not exist upstream, and neither does the control: there is nothing under upstream's send box to press.

**Iris, before.** The model name was a `<span className="iris-composer__pill">` — a readout, beside the prompt capsule which was already a button. The per-chat layer it needed was already there and already worked: `settings.set` has always taken a `chatId`, `SettingsStore` has always kept `chats[chatId]` as an override layer over `global`, and `null` has always cleared one field of it. Nothing about the mechanism was missing.

**What was missing was the ability to see the layer.** `settings.get` answered with the *merged* read, and a merged read cannot say whether a value is the conversation's own choice or the default showing through — a chat that overrode `model` with the string the global layer already carried is byte-identical to one that overrode nothing. An interface can render the value from the merge; it cannot offer to *undo* it. So `settings.get` / `settings.set` now also answer with `overrides` — the chat layer by itself — and **presence is scope**: present exactly when the request named a `chatId`, where `{}` is the real answer "this chat overrides nothing" and absent means the global layer was read. A reader that defaulted absent to `{}` would draw the "this conversation" marker on a surface with no conversation.

**Iris, now.** The capsule is a `<button>` opening the primitives' `Menu`: a heading naming the connection the list came from, the active connection's recorded models with the current one ticked, and — only when there is an override *and* a connection whose model to name — a pinned footer row that clears it. Selecting writes `settings.set({ chatId, settings: { model } })`; the footer row writes `{ model: null }`. A dot beside the name marks a conversation that is not on its connection's model.

**What it costs, stated because it is the real cost of the improvement.**

- **A conversation's model and its connection's model can now disagree**, and the reader has to be able to see that from either side. The composer's dot is one side. The other is the connection panel, which reports what the *connection* is, and it now also carries the host's own startup row (entry 47's `host` projection) so that "what is answering me" is answerable without inference. What the panel does **not** yet do is list which open conversations override its model — a reader with many chats can still be surprised by one of them, and the honest statement of this entry's limit is that the dot is per-chat and there is no roll-up.
- The menu's list is the **active connection's**, not a union of every profile's. Switching connections therefore changes what the capsule offers, and a conversation left on a model the new connection does not serve keeps generating with it until it fails at the provider. That is the same failure the model dropdown of entry 47 exists to reduce, arrived at from the other direction, and it is not closed here.
- The list can be stale by construction — it is a recorded probe, stamped — so a model the endpoint has since withdrawn is still offered. Its stamp is shown in the connection panel and not in the menu, which is a place the reader could be misled and the reason the capsule always reports the model *in force* rather than only list members.
- A per-chat override survives in `settings.json` under that chat's id and is not visible from the settings drawer's "this conversation" section as an override (the drawer shows merged values, like everything else did before this entry). The drawer is the obvious next consumer of `overrides`.

**What would reopen it.** A decision to give the capsule the global scope as well — a modifier, or a second row — which would need the drawer's "defaults for new conversations" wording to reach the composer too, or the two surfaces would be two ways to write different layers with no visible difference.

---

## 51. A message's own `<style>` is copied into every frame its regions became

**Kind:** compatibility gap, closed — with a named remainder.

**Upstream is one DOM per floor.** A message's `<style>` blocks are pulled out
by `decodeStyleTags`, every selector is prefixed with `.mes_text `, and the
sheet is re-inserted into the message element — so it covers the whole floor,
panel and prose alike, and a rule written for a panel three lines below it
lands on that panel. There is nothing to copy because there is nowhere else to
copy it to.

**Iris is one frame per region** (entry 25). A `<style>` block at the start of a
line opened a region of its own — `style` is on the split's block-tag list — so
the message came out as two frames: one holding the panel, one holding only
CSS. That second frame styles nothing (there is nothing in it) and its rules
cannot reach the first (an opaque-origin frame is not the neighbour's
stylesheet). Measured on 爱衣's `[美化]完整变量更新`, on the 8787 host: the
`<details>` frame 88px and collapsed, the sheet's frame **812px of empty
black**, and clicking the summary opened a panel whose body stayed invisible —
its `.thinking-description[open]>div { opacity: 1 !important }` was in the other
frame, and so was the `::after { content: attr(data-close) }` that writes the
summary's own label, which is why the title read 「变量更新 -」 and stopped.

**The population.** Read through the pipeline's own claimer over the card
corpus (25 cards decoded from `E:/sillyTavern/.../characters` plus
`iris_分支/测试用卡`; one candidate text = one regex `replaceString`, one
`first_mes`, one alternate greeting; 220 texts): **13 texts in 9 cards** emit an
HTML fragment, one blank line and a `<style>` — 爱衣, 可攻略女主拒绝被攻略,
暗渊：地下城领主, 2.1.0 (two each), 【Sgw】又看一集, 创世回廊1.3, 银麒赎世,
魔法少女是不会败北恶堕的吧！, 魔法少女的扣扣审判1.0 (one each). All 13 are
`replaceString`s, all 13 are variable-update panels, and in all 13 the gap is
exactly one blank line. No text in the corpus is a sheet with no fragment
beside it.

**The wiring.** `splitHtmlRegions` returns a run that is nothing but `<style>`
elements as a `MessageStyle` (span plus CSS) instead of a region;
`claimMessageSurfaces` joins the message's sheets, confines them once through
`card-css.ts`, and hands back both the spans and the CSS;
`runMessageInterfaces` attaches the sheet to each **bare-HTML** region's markup
and `buildSrcdoc` lifts it into that frame's `<head>`; the row passes the same
spans to `splitAroundInterfaces` as dropped, so the characters reach neither a
frame nor the renderer. After the change the corpus produces **0** style-only
frames and each of those 13 texts builds 1 frame instead of 2.

**Copying is the equivalence, not a shortcut.** With one frame per region and no
frame able to see another's stylesheet, installing the sheet in each region
frame is the only construction that reproduces a message-wide scope. The scope
root inside the frame is `body` — upstream's `.mes_text ` prefix expressed in
the frame's terms, and measured to be safe: none of the 13 sheets carries a rule
for `html`, `body` or `:root`, and none reaches for a SillyTavern container.

**A fenced block deliberately gets no copy.** Upstream renders a fenced
document in an iframe of its own, which its `.mes_text`-prefixed message sheet
does not reach either; copying ours in would be a divergence rather than a fix.

**What it costs.**

- **The sheet is parsed once per region frame.** 11.9 KiB of confined CSS across
  the 13 corpus texts (~940 B each), and every one of the 13 has exactly one
  region, so today the multiplier is 1. A message with three regions pays it
  three times. It is not counted in an interface's reported `bytes`: that number
  is the card's block, and the budget spends the same quantity.
- **A selector that crosses regions still cannot match, and this is the
  remainder.** `.panel ~ .footer`, `.a .b` with `.a` in one region and `.b` in
  the next, `:has()` across them, sibling and child combinators over a region
  boundary — the sheet is in both frames, but each frame holds only its own
  region, so a combinator that needs both elements matches in neither. Upstream
  matches these, because the floor is one tree. Nothing in the corpus's 13
  sheets does it (every one of them selects inside a single fragment), and there
  is no fix available inside the frame model: it would take the inline
  sanitizer path of `INLINE-HTML.md` §三, where a floor is one tree again.
- **A message's sheet can no longer reach the message's prose.** Upstream's
  `.mes_text `-prefixed rule can style the narrative around a panel; a frame's
  head cannot. Same cause, same remainder, same fix if it is ever wanted.
- **`@keyframes` names are kept, not renamed** (`KeyframePolicy`). In a shared
  document renaming prevents two cards' `pulse` from colliding; in a frame there
  is nothing to collide with, and renaming would break 5 of the 13 sheets, whose
  keyframes are named from `style=` attributes in the markup (爱衣's `shimmer`,
  可攻略女主 and 暗渊 with `moon-halo`, `moon-pulse`, `stars-drift`,
  `moonlight-sweep`) — the rewrite reaches `animation` declarations only inside
  the sheet it renames. The refusal list is untouched: `@import`, `@font-face`,
  `@namespace`, `@charset` and every `url()` fetch are refused in a frame's
  sheet exactly as in a message's (entry 41), and nothing in the corpus's 13 is
  refused today.
- **A sheet with no region frame is dropped and said out loud** — "a `<style>`
  block in this message has nothing to style" on the durable card-report
  channel. Zero occurrences in the corpus; the note exists because the corpus
  has cards that print their own explanation when a resource goes missing, and
  an unexplained absence loses that race.
- **An unclosed `<style>` now takes the rest of the message as CSS** and reports
  it, where the unclosed-region fallback used to frame it as HTML — which was a
  frame whose entire content was a stylesheet's text.

**What would overturn it.** A card that needs a message sheet to match across
two regions or into the prose (none in the corpus) — which is not a knob on this
entry but the inline path of `INLINE-HTML.md` §三, where the remainder above
disappears because the floor is one tree again. Or a message whose sheets are
large enough that copying them per region is measurable; 940 B against a
360 KiB interface says that is not today's problem.

---

## 52. A user floor's HTML renders as a sandbox frame, exactly like an assistant floor's

**Kind:** compatibility gap, closed — no new mechanism, one routing gate removed.

**Upstream.** `messageFormatting` (`public/script.js:1753`) is role-agnostic
about markup: its `isUser` argument only chooses the regex placement
(`USER_INPUT` vs `AI_OUTPUT`), the prompt-bias strip and the `name2`
suppression. With `encode_tags` at its default (`false`,
`scripts/power-user.js:301`) a user message's bare `<div>`/`<details>` reaches
showdown and DOMPurify exactly like an assistant message's, and renders as live
HTML — so a console that writes a floor of markup as a user message
(`createChatMessages`) still gets its panel. Verified against
E:/sillyTavern/SillyTavern source; no deviation to record **in the direction of
this change** — Iris before it was the deviation.

**The report that opened it.** The 政经博弈卡's console submitted 建国档案 and
`createChatMessages` made the floor a **user** message: 5,836 characters
opening line-initially with `<div style="width: 85%">`, a `<details
class="polsim-terminal">` terminal with a nested 👾 variable panel, `is_user`
undefined at the ST-format data layer and therefore a user row in the view.
`Message.tsx` routed only assistant rows through `MessageInterfaces`, so §25's
bare-HTML pipeline had no effect on the floor and the reader saw the whole
source.

**The change.** Every row routes through `MessageInterfaces`, with the row's
role handed along. Claim, budget, count gate, sandbox frame and height sync are
the assistant pipeline's, shared — `FrameBudgetProvider` had always planned
over user floors (the `isUser` flag was carried precisely so a routing change
could not pass unreported), so a user region pays `FRAME_OVERHEAD_BYTES` and
loses to the count gate exactly as an assistant one does, and the plan's
`userInterfaces` report now records what user floors actually carry. The one
role difference kept is the **prose between frames**: an assistant row's
unclaimed segments read as markdown (`MarkdownText`), every other row's stay
the raw text that row has always shown. This closes the HTML gap, not the
markdown one.

**Residual deviations from upstream, both already on record or standing.** The
frame, not in-page sanitized HTML — §25's twist, now applying to user floors
too. And user prose stays plain text where upstream runs markdown over the
whole message — pre-existing Iris behaviour, deliberately preserved here.

**What it costs.** A user floor with a claimed region now spends real budget,
so a chat whose user floors carry interfaces reaches the count gate sooner —
which is the accounting working, not a regression; the measured corpus had zero
such floors, and the report names them the moment that stops being true. A
plain-text user floor claims nothing and renders byte-for-byte as before.

---

## 50. A clamped frame scrolls itself, and its boundary stops the wheel

**Kind:** deliberate divergence from upstream — forced by the clamp, which
upstream does not have.

**Upstream.** No band, no clamp: Tavern Helper writes
`frameElement.style.height` same-origin and synchronously, so a frame is always
exactly its content's height and there is never anything past the viewport to
reach — the injected `html,body{overflow:hidden!important}`
(`render/iframe.ts:88-89`) costs the reader nothing. Iris clamps the frame to
the visible band (the `max-height` band clamp in `reading.css`, task U), so a heavy interface lives its
whole life with content past its own viewport and *somebody* has to decide how
that content is reached. Upstream has no answer to copy because upstream has no
question.

**The change.** Two pure decisions in `frame-height.ts`, applied by
`frame-entry.ts` to `html` and `body` inline with `!important` (the rule being
beaten is itself `!important`, and it is upstream's line): `overflowDecision`
turns `overflow-y` on from the **honest extent** — the largest of
`bodyScroll`/`docScroll`/a range over the body's contents/the furthest child
edge (`contentExtent`), because a card that pins its own body lies to
`scrollHeight` (measured: `bodyScroll 100` against a 1069px range) — and
`containDecision` sets `overscroll-behavior: contain` from the **scroll range
that exists after the overflow applies**, sealing the frame's boundary so the
wheel at its end does not drag the reading column (measured pre-fix: 68px →
146px of page scroll over six notches). Both run on **every** measurement —
before `heightSignal`, whose early returns (`silent`, `sizing`) used to skip
the scroll entirely — and both are **removed when the content fits**: a
fitting frame must chain its wheel to the page, and a leftover `overflow-y:
auto` was measured swallowing it (neither frame nor page moved).

**What it costs.** `contain` on a zero-range scroller would swallow the wheel —
so containment binds to the post-apply range, not the extent, and a
self-pinning card (`sizing` contract) chains exactly as before; that gate is
the whole difference between "the frame is a scroller" and "the frame is a
trap". And the honest extent reads a `Range` over the body on every
measurement, not only under the diagnostics cap — one `Range`, rAF-coalesced
like the three observers that trigger it.

---

## 51. The height reporter's schedule survives a frame that never paints

**Kind:** robustness fix against a measured environment fault, not a behaviour
change.

**Upstream.** Irrelevant — upstream measures from inside the page
(`adjust_iframe_height.js`'s `ResizeObserver` + rAF coalescing), and its frames
are same-origin elements of the page's own render tree, so an animation frame
arrives when the page renders. Iris's frames are opaque-origin children; in the
project's own headless harness every frame of a chat sat
`document.hidden === false` with a queued `requestAnimationFrame` that **never
fired** (render-throttled children), so `reportHeight`'s rAF-only
`schedule()` meant the bootstrap's one synchronous `send` — taken before the
card's markup parsed — was also its last. A card whose interface builds its DOM
asynchronously (政经博弈's reply interface, an async `$(fn)`) never posted a
height, lived at the 60vh starting height, and neither the height nor the §50
scroll decision ever ran for it.

**The change.** `reportHeight`'s schedule gains the timer rescue
`reportRegions` already carries for the same fixed point — `rAF` **and** a
500ms `setTimeout` that fires only if the rAF never did (`send` clears
`scheduled`), so a painting frame pays one no-op timeout per schedule. The
interval is `reportRegions`'s, reused, not a new knob.

**What it costs.** `FRAME_OVERHEAD_BYTES` moved 48 → 49 KiB
(`frame-budget.ts`): the rescue is real code in the per-frame inlined
bootstrap, `check-bootstrap.mjs` caught the two-byte overrun against the old
budget, and the constant is the measurement of that artifact — raised in the
same change that caused it, per that file's own discipline. On the merged tree
the constant reads **50 KiB**, which is the mainline's own independent raise
(measured 48.6 KiB there) absorbing this one; the build's `check-bootstrap`
pass is what confirms the combined artifact still fits under it. The reading
view's count gate degradation point moves to ≈41 frames of fixed overhead; the
byte budget itself is untouched.

**Recorded findings, deliberately not fixed here** (both card-native, both
measured on the 政经博弈 reply chat):

- An interface that clips its own overflow **inside a descendant**
  (`docScroll == viewport == 100` against a 1025px range over its contents) is
  unreachable from any ruler outside that descendant, and escalating to the
  card's own clipper was rejected: the same signature — laid-out boxes past a
  clipping ancestor — is how SPA cards park hidden screens, and flipping those
  clippers to scrollable would scroll a card onto screens it meant to hide.
  Upstream renders the same card equally clipped. The frame now hugs the
  visible content (100px, height applied) instead of holding 60vh of dead air.
- A claimed block whose markup is entirely zero-box (`bodyScroll 0`, range 0,
  five children that lay out nothing) keeps its frame at the 60vh starting
  height — the height path refuses zero by design (the self-reinforcing zero),
  and upstream would render a 0px frame where Iris shows a blank band. A
  collapse policy after the 6s blank diagnostic is the recorded shape of a fix.
