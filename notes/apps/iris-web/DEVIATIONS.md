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

### Addendum (2026-09-08): the card's own copy of this dialog was also running

This entry described the host's dialog and never asked what MagVarUpdate's
in-frame copy does. **It was running in parallel, and it only looked otherwise
because it crashed.** The frame projects the chat faithfully — floor 1 really
does carry `stat_data`, deliberately, because MVU's restore path reads it — so
all four of upstream's gates (`legacy_chat.ts:7-14`) pass inside the frame too,
on exactly the chats where the host's own gates pass. What stopped it was the
missing popup API: `SillyTavern.POPUP_TYPE.CONFIRM` threw (§57). The crash was
hiding a double-ask, so building the popup API alone would have produced two
dialogs asking one question.

**The host's copy keeps this path, and the card's stands down.** Three
measurements decide it, and each is about MVU's copy being unable to carry out
its own answers here rather than about which dialog is nicer:

- **"Clean only" cleans nothing durable.** `cleanupMessageVariables` writes
  `chat[i].variables` on the frame's **snapshot** and then calls `saveChat()` —
  which in Iris is `callAction('saveChat', {})` and carries no rows. The
  deletion is discarded at the next context push.
- **"Back up and clean" cannot back up.** It POSTs to `/api/chats/export`,
  which Iris refuses (§19); the branch toasts an export failure and returns
  without cleaning.
- **"Do not remind me again" does not persist.** It writes
  `_.set(SillyTavern.chat, [1,'variables',0,'ignore_cleanup'], true)` on that
  same snapshot, so it does not even achieve the permanent refusal this entry is
  about.

So letting MVU's dialog through the new API would offer the reader three
answers, none of which can happen, beside a host dialog where all three can. The
ruling above holds unchanged: **the dismissal-defers rule is the host dialog's,
and there is no second dialog to lose it in.**

**How it is enforced, and where the smell is.** Not by intercepting a popup
whose content matches MVU's — that would be a per-card patch. Iris closes
upstream's **own fourth gate**: the frame marks `chat[1].variables[0]` with
upstream's `ignore_cleanup` key (`sealLegacyCleanup`, `sandbox/tavern-helper.ts`).
In upstream's vocabulary that says "this chat's in-card cleanup is already
answered", and in Iris it is true — the question has an answer path and it is
not the card's. It is still MVU-shaped, and it is named as such rather than
dressed up: the key is upstream's, one extension writes it and one reads it.

**The mark is non-enumerable**, which is the part that took thinking rather than
typing. A card that reads floor 1's table and writes it back through
`replaceVariables({type:'message', message_id:1})` would otherwise persist a
fabricated key into the real chat file and disable the **host's** offer for that
chat forever, silently — and MVU's restore path does write floors from
`snapshot + 1` upward, a bound that can be floor 1. `JSON.stringify`, spread,
`Object.keys` and structured clone all skip a non-enumerable property; `_.has`,
`hasOwnProperty` and `in` — which is what the gate uses — all see it. A refusal
the user really recorded is left exactly as it is, enumerable and durable.

**What the addendum costs.** Floor 1's tables are parsed eagerly once per
snapshot, the one row the lazy getters would have left alone (0.01 ms against
the 7.75 ms the laziness exists to avoid). And gate three is deliberately left
open: `stat_data` on floor 1 stays visible, because hiding it to buy silence
would break restoring.

**What would overturn the addendum.** A durable path for a card's own chat-file
writes — if `saveChat` ever carried rows, MVU's sweep would work and the
question of which copy owns the path reopens. Or a second extension reading
`ignore_cleanup` for a different purpose, which would make the mark a lie to
someone.

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

**Iris** shows the reported values, in two places: the conversation's total under the composer (`Cache hit 56% | Input 21.6K tok · Output 3.4K tok`, from `ChatView.usage`), and each reply's own total in its actions row (`Usage 7.2K`), whose hover card carries the breakdown — cache hit, uncached input, cached input, cache write, output and the reasoning inside it (the landing is the bullet below). Formatting is `app/token-format.ts`; the copy is the `usage*` keys of `i18n/strings.ts`.

**Why.** The three prompt-side buckets are what a request is actually billed on, and the cache-hit share is the one number that tells a reader whether a long-running scene is costing them a full prompt per turn or a tenth of one. It is knowable — every provider Iris speaks to reports it — and upstream simply does not carry it far enough forward to be shown.

**What it costs.**

- **It depends on the provider reporting.** No report, no row: `MessageView.usage` and `ChatView.usage` are optional, an absent bucket is never zero-filled, and a provider silent about caching gets **no** cache-hit line rather than `0%` — the two are different facts and `token-format.ts` keeps them apart (`cacheHitPercent` returns `null`, not `'0'`).
- **Every floor imported from a SillyTavern chat file has none**, and always will: what upstream stored is its own estimate under a different name, and back-filling `usage` from it would be manufacturing a bill. So a migrated conversation shows readings only from the turns generated in Iris, and its composer total counts only those.
- **The two numbers must not be called the same thing**, and this is the live conflation risk: upstream's `{n}t` is an *estimate*, of the *reply text only*, by *Iris's own tokenizer* if we ever computed it; Iris's `用量 7.2K` is the *provider's* count of the *whole turn*, prompt side included. They differ by the entire prompt and can differ on the reply too. The interface therefore words them apart — 「用量」 only ever means reported billing, and the prompt panel's estimate keeps 「估算」 (`STRINGS.md` §三 records the convention) — and neither surface prints the other's number.
- **The breakdown was a native `title`; it is now a styled hover card, and this bullet is the record of that landing.** Both readings that carried one — the per-turn chip in a reply's actions row and the composer's session strip — open the same card (`app/UsagePopover.tsx`): anchored below the trigger by `useAnchoredPosition` from `@deepseek-ai/dsh-client-ui-primitives` (the model menu's own package; the strip lives at the viewport's bottom edge and the reading pane scrolls, so the card is portaled rather than CSS-positioned like the context card), clamped inside the viewport, drawn only in `--iris-*` tokens at the dropdown layer. It opens on hover (after a dwell) and on keyboard focus at once, closes on Escape, pointer-out (with the menus' 200ms grace, so the trip onto the portaled card does not close it) and an outside press, and its rows are a two-column `<dl>` a screen reader reads as pairs. The touch semantics are the honest trade: touch has no hover, so a tap **toggles** the card and an outside tap closes it — a press-and-hold or a second tap on the trigger is how a touch reader dismisses it, which is less discoverable than a hover-out but reachable, which the `title` was not. The plain-text assembly (`usageDetailText`) is deleted rather than kept beside the card: the rows are built once (`usageDetailRows` for the turn, `usageSummaryRows` for the session, the strip's own line being `usageSummaryRows` flattened by `usageLineGroups`), so the copy cannot drift between the line, the card, and the two languages. On the composer card those rows are joined by the card-script share as a `note` under them — the split the strip's `title` used to own, riding the card rather than a fourth group in the line (the composer's card-share divergence, §70).

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

> **Where this now lives:** every decision in this entry still holds, but the surface it describes was rearranged on 2026-09-09 — entry **77**. "The panel" below means the connection card's *editor*, which is now a dialog opened from a provider list; the card body itself carries no field at all. Read 77 for the shape and this entry for why the key and the model behave as they do inside it.

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

**2026-09-07，用户实测：菜单在最常见的那台宿主上答错了对象。** 原话：「我点击输入框下方的模型标签希望快速切换模型但是确实提示：『本对话使用的模型 / 没有活动连接，因此没有可选的模型列表。』当很明显我是连接着模型的。」那台宿主整条路由都来自环境变量（`IRIS_BASE_URL` / `IRIS_MODEL` / `IRIS_API_KEY_ENV`），用户从没存过 profile——`activeId` 是 undefined，而菜单只读活动 profile 的 `models`，于是说出一句**关于 profile 列表为真、关于「谁在回答我」为假**的话。宿主默认那一行（条目 47 的 `host` 投影）当时已经在线上，只是输入框底下没人读它。

现在：**宿主默认连接也是一路列表来源。** `HostDefaultConnection` 多了 `models?` 与 `modelsProbedAt?`；宿主在**服务进程内存里**记一次探测结果，不落盘——宿主默认不是用户的决定，是进程启动时的环境，一次观测不该躺在记录用户决定的那个文件里；`connection.test` 打到宿主默认端点的**原点**且成功时写入（按原点而不是按调用方式，所以一条指向宿主端点的 profile 探测同时填两行），四个 `connection.*` 应答都带上它。`model-menu.ts` 有 profile 用 profile、否则用宿主默认、两者都无才说「没有连接」；菜单标题分开写「来自「某个 profile」」与「来自宿主默认连接（变量名）」——只说变量名，不说值。列表缺席时**点开菜单就去探一次**（`connection.test`，带 `profileId` 或宿主默认的 `baseURL`，**不带密钥**：凭据由宿主自己按原点解析，这也是裸探测存在的理由），期间菜单显示「正在读取模型列表…」，失败原样显示宿主命名过的那句（`unauthorized` / `network` / `no-endpoint` …）而不是吞掉；成功后 5 分钟内不重探（`MODEL_LIST_FRESH_MS`，读的是宿主写下的时间戳而不是组件里的计数器，所以重挂载也不会重探）。**当前生效的模型永远是第一项且被勾选**，无论列表回不回来、含不含它——菜单在任何状态下都要答得出「现在用的是什么」；这也是为什么「是哪一种空」现在从**来源自己的列表**判定，而不是从菜单的行数判定。

这一段没有关掉上面列的任何一项代价，只改正了本条自己的一处措辞：原先写「列表是活动连接的」，准确的说法是「列表是**正在回答的那个端点**的」——没有 profile 时，那就是宿主启动时的那条。仍然没做的是反向汇总：连接面板依旧不列出哪些对话覆盖了它的模型。

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
`public/scripts/power-user.js:301`) a user message's bare `<div>`/`<details>` reaches
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

## 53. A clamped frame scrolls itself, and its boundary stops the wheel

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

## 54. The height reporter's schedule survives a frame that never paints

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
height, lived at the 60vh starting height, and neither the height nor the §53
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

---

## 55. A card with no scripts is never held at `unasked`

**Kind:** deliberate improvement (closing a dead state the acceptance round
walked into).

**Upstream.** Message interfaces render under a global switch
(`render.enabled`); nothing per-card is asked before a status bar draws. A
card's scripts and its interfaces are two features with two switches, and only
one of them is a question.

**Iris.** Both features gate on one per-card answer — deliberate: a message
frame is another frame of the same card, not a new trust domain. The gate
itself is fine; the dead state was in the derivation. `ConsentAsk` suppresses
the question for an empty script list ("a card with no scripts is not a
decision" — its own comment), and the host reports `scriptsAllowed` as absent
until answered, which `consentState` reads as `unasked`. A card with **no
scripts** therefore sat at `unasked` forever: nothing could ever put the
question, and the interface pipeline — reading the same field — never built a
frame. Measured live (人偶演出Lights ON, the one script-less card among the
four under acceptance): the greeting's slot stood empty — no iframe, no
caption, no question, no reason anywhere — while the identical card with the
answer pre-set rendered fully. Three cards with scripts passed acceptance; the
script-less one was the casualty.

**The fix** is where the empty list is known: `loadScripts` derives
`allowed` when the host's answer is absent **and** the list is empty. For the
script surface that answer is vacuous (there is nothing to run); for the
interface surface it is the difference between rendering and a silently blank
slot. It is derived per load and never written back — the host's absent key
stays the truth about what was asked, and a reused character id later carrying
scripts falls back to `consentState` and is asked like anyone else.

**What it costs.** A script-less card's interfaces render without any
consent interaction. That is upstream's behaviour exactly, and the reader is
already looking at the markup these frames render — the wall (opaque origin,
CSP, per-frame grants) is the isolation, not the question.

**What would overturn it.** A ruling that message interfaces must require the
same explicit yes as scripts for *every* card — then the question has to be
put for empty lists too, and `ConsentAsk`'s suppression (not this derivation)
is what must change.


**Merge addendum (2026-09-07).** The mainline took the gate, not the derivation:
`interfacesMayBuild` admits `unasked` when the script count is zero, so the
store's field keeps answering only what the host answered, and `unasked` stays
the truth about what was asked. Deriving `allowed` in `loadScripts` — this
section's original shape, merged from `dev/fix-render` — was superseded by that
gate in the same merge and reverted there; the ruling stands, the mechanism
moved one level out. The test that pinned the derivation now pins both halves:
the store's honest state and the gate's admission.


---

## 56. Every frame asking for the context at the same moment shares one request

**Kind:** deliberate improvement, with a named freshness cost.

**Upstream.** `getContext()` is a synchronous in-process read of a singleton, so
each interface frame really does take its own — and the cost of "its own" is
nothing. Twenty-two frames reading in one tick read one identical state anyway,
because the page is single-threaded and nothing can change between the reads.

**Iris** has to ship the same facts across an origin boundary, so a frame's
"own read" is an RPC. Every displayed row mounts its own `MessageInterfaces`,
whose effect depends on the chat, the card and the consent answer — identical
for every row — so React commits them together and the page issued **one
question N times**. Measured on 8789, 2026-09-07, one conversation of 25
messages: 22 `script.context` calls inside the same millisecond with identical
response sizes, plus 22 `script.list`. Re-measured headless against a read-only
copy of the same profile (`scripts/script-context-probe.mjs`, 2026-09-08): one
snapshot is **about 145 KB** of JSON and the host takes **1.75 s** to build it.
The size is quoted loosely because it tracks the conversation — two runs an hour
apart read 145,282 and 147,385 bytes as the log grew — while the 1.75 s does
not, being almost entirely card-library decoding. The host serves RPCs one at a
time, so the batch resolved 9 s → 47 s in a straight line, and a
`connection.test` the reader fired after it queued behind all of them for
30.7 s.

`apps/iris-web/src/client/in-flight.ts` now shares the request **while it is in
the air**: one flight per `(method, arguments)` per client, joined by every
caller asking during it, dropped the moment it settles. Not a cache — nothing
outlives the request. It replaced `app/shared-snapshot.ts`, whose event-keyed
sharing covered the refresh burst but not the mount burst; the flight covers
both, and a host event's taps are fanned out in one synchronous loop, so it
still gives that module's guarantee of one round trip per event.

Sharing the request is only sound because the answer does not depend on which
row asks. Measured through `scripts/script-context-probe.mjs` on the same
conversation: `script.context` is byte-identical across `messageId` absent, `0`
and the newest floor **except** for the `floor` field it adds — and the page
never passes `messageId` at all. The floor a message frame renders in travels
separately, as `runCard`'s `currentMessageId`.

**What it costs.** A joiner's snapshot can predate its own call by up to one
flight's duration; the caller that opened the flight is unaffected. Upstream's
equivalent window is zero, because its read is synchronous. Two things bound it.
The host is single-threaded, so before this the joiner's own request queued
*behind* the flight and was answered later — fresher data at the price of the
reader waiting for two requests instead of one. And anything happening inside
the window that changes what the snapshot says arrives as a host event, on
which `watchContext` opens a fresh flight and pushes the newer snapshot into
every live frame. The window is bounded and self-correcting, and it sits inside
the much larger snapshot-versus-live-object divergence §5 already records.

The same sharing covers `script.list`, where the analogous cost is a caller
arriving just after a `script.setEnabled` write joining a reading issued just
before it. That race exists without the sharing too — the write and the read are
separate round trips — and the sharing does not widen it past one flight.

**What would overturn it.** A frame-addressed context — a snapshot that
legitimately differs per row, `floor` being carried in it rather than beside it
— would make one flight the wrong unit, and the key would have to carry the
floor. So would a host that served RPCs concurrently: N parallel requests would
no longer serialise, and per-row freshness would cost nothing again.

## 57. A character's page lists what a card carries; upstream has no such page

**Kind:** deliberate improvement (a second round on the same page: the columns
were counts, and are now counts over lists).

**Upstream.** There is no character page. A card is a row in the character list,
and clicking the row *starts a conversation with it*. What the card contains is
answerable only by opening panels that describe **the card currently being
played**: the world info editor for its book, the script manager for its
scripts, the chat list for its conversations. A card you have not opened is a
picture and a name.

**Iris** has the page (§ the 「梅花」 library work, `CharacterPage.tsx`), and this
round gave its three columns their contents:

- **对话** — one row per conversation: title, last activity, floor count.
  Clicking it calls `openChat`, the same action the sidebar's rows call, and
  hands the shell back to the reading surface (`onEnterReading`). Derived
  entirely from `state.chats`, so it needs no host call and is answerable for
  every card on every host.
- **世界书** — one row per book the card involves (its own, plus every book the
  reader bound through the host), folding open to its entries. The row carries
  three figures — entries / enabled / constant — and each entry carries its
  name, what fires it, where it lands, and whether it is switched off.
- **脚本** — one row per script: name, that it came out of the card, both
  switches said as the *reason* rather than the result, its size in bytes, and
  how many of its buttons its author left visible.

**What it costs, in bytes, measured.** The library list must stay counts-only —
a card is a median of 494 KiB — so the lists are fetched per page open:
`worldbook.charDigest` (new, host ledger §27) plus the existing `script.list`,
held in the store against the character id and re-fetched for no other reason.
Measured against the operator's own profile, `charDigest`'s whole response:

| card | entries | this response | the same books through `worldbook.get` |
| --- | --- | --- | --- |
| `Sgw又看一集` | 140 | 23 489 B (22.9 KiB) | 349 188 B (341.0 KiB) |
| `魔法少女的扣扣审判1` | 153 | 20 526 B (20.0 KiB) | 1 161 905 B (1 134.7 KiB) |
| `爱衣` | 12 | 1 483 B (1.4 KiB) | 51 732 B (50.5 KiB) |
| `Assistant` (no book) | 0 | 12 B | — |

The 140-entry card is `Sgw又看一集`, not `爱衣`: the task named 爱衣 for its
「内嵌 140 条」 and 爱衣's book holds **12**. Worth recording because the two cards
are adjacent in every earlier note about this page.

So the ceiling on this page's new traffic is ~23 KB per card, once. The
alternative — composing the same view out of `worldbook.charNames` plus one
`worldbook.get` per book — is one call per book and 15× to 57× the bytes, all of
it entry *content* the page never shows.

**The second cost is vertical.** 153 entries is 153 rows, and a column that grew
by 153 would push the two beside it off the screen. So a book folds shut behind
its figures and its entries scroll inside the column (`max-height: 320px`,
`shell.css`). A reader who wants to *edit* those entries still goes to the world
book panel; this page is a listing.

**The cache has two invalidations, and they are the whole staleness story.**
Saving a book in the world book editor clears the held listing (the next page
open asks again), and a script switched in `ScriptPanel` is written straight
into the page's copy from that write's own answer. Nothing else invalidates:
another client editing a book on the same host would leave this page's figures
behind until the reader switched cards, which is the cost of holding the answer
at all and is recorded rather than fixed.

**What is deliberately not here.** No switch. `script.setEnabled` is scoped to
the card whose conversation is open (the store's `scriptsFor`), and the panel
beside that conversation owns it — a toggle on a page being browsed would either
need a second write path for a card nobody opened, or would write the wrong
card's policy. The page says where the control is instead. Likewise the reader's
own consent answer is shown only when `scriptsFor` names *this* card, unchanged
from the previous round.

**What would overturn it.** A card whose books run to thousands of entries, where
23 KB stops being the ceiling and the digest needs paging (the shape would be a
`limit`/`cursor` on `worldbook.charDigest`, not a per-book call). Or a decision
that the page should edit rather than list, which would move the entry rows onto
the world book panel's editor and make this page a launcher again.

## 58. A card's popup is drawn by the shell, says a card is asking, and queues

**Kind:** deliberate improvement — and it closes a **compatibility gap** that
was a hard crash, so the two halves are separated below.

### The gap it closes, and what it cost

The card surface carried none of SillyTavern's popup API: no `POPUP_TYPE`, no
`POPUP_RESULT`, no `callGenericPopup`, no `callPopup`, no `Popup`
(`[ST] public/scripts/st-context.js:192-225` exposes all five). Reading an
unbuilt member yields `undefined` and a report (§1) — which is right for a
member a card *guards*, and useless for one it reads **through**:

```js
// [MVU] cleanup/legacy_chat.ts:16-25, live in artifact/bundle.js
await SillyTavern.callGenericPopup(text, SillyTavern.POPUP_TYPE.CONFIRM, '', {…})
```

`SillyTavern.POPUP_TYPE` is `undefined`, `.CONFIRM` throws, and the throw lands
inside MagVarUpdate's `jQuery(async …)` as an unhandled rejection:

```
card scripts: 失败:an unhandled rejection after a card body ran:
TypeError: Cannot read properties of undefined (reading 'CONFIRM')
  at …/MagVarUpdate/artifact/bundle.js:2:205599
```

**Reported by a user on 2026-09-08**, on a 26-message chat, reproducing on main
and on the PR branch. Every MVU card past 25 messages reaches it, because the
gate is `chat.length > keepRecent + 5`.

**Where the API is exercised, measured rather than assumed.** Over the local
corpus — 47 card scripts, 70 card interface fields and 1,451 world-book entries,
1,559 distinct bodies after content dedup — the five names appear **zero** times
(control: `SillyTavern` and `toastr` fire in the hundreds through the same
reader, so the zero is a reading and not a broken scan). The population that
uses this API is the **imported bundle**: MagVarUpdate's `artifact/bundle.js`
calls `callGenericPopup` six times in four distinct shapes, and five corpus
cards import it. So a per-card judgement would have found nothing to build.

### Iris

**The dialog is the shell's, not the frame's**, and that is forced rather than
chosen: a message frame is clipped to its message's height and a script frame's
surface is the reading column, so a modal drawn inside either is a modal nobody
can see. The frame reduces the card's four arguments to a *plan* — the buttons
in upstream's render order, the `POPUP_RESULT` each carries, the value `show()`
resolves to (`sandbox/popup.ts`, checked line by line against `popup.js` in
`tests/popup.test.ts`) — and the shell draws the plan and reports the press. The
shell never computes a result.

**Return values are upstream's, including the parts that read like bugs:**

| call | upstream | Iris |
| --- | --- | --- |
| ok | `AFFIRMATIVE` = 1 | same |
| cancel | `NEGATIVE` = 0 | same |
| Esc, click outside | `CANCELLED` = **`null`** | same |
| string `customButtons[i]` | `i + 2` (`popup.js:55`, `:284`) | same |
| object custom with `result` | that value | same |
| object custom **without** `result` | does not close (`popup.js:69`) | same |
| INPUT, `result >= 1` | the input text | same |
| INPUT, `NEGATIVE` / `CANCELLED` | `false` / `null` | same |
| `callPopup` ok / cancel | `true` / `false`, text for `'input'` | same |
| CONFIRM default captions | Yes / No | same, translated |
| INPUT ok caption | Save | same, translated |
| CROP | a cropped data URL | **`null`**, refused by name |

Three deviations, and all three are on this list because they are visible:

1. **The dialog says a card is asking.** Upstream's popups are
   indistinguishable from SillyTavern's own, because upstream has no boundary
   there — the extension *is* the application. Here a card is content, and a
   modal that might be Iris asking about the user's data or might be a card
   asking about its own is one the reader cannot answer safely. Cost: one line
   of chrome upstream does not have.
2. **Popups queue; upstream stacks them.** Upstream opens a second `<dialog>`
   over the first. Iris draws the oldest and holds the rest in order. No result
   changes — every popup still gets its own answer — and it keeps the shell from
   reasoning about a modal over a modal it also owns. Cost: a card that opens
   two at once shows them one at a time.
3. **Options accepted and ignored, by name.** `transparent`,
   `allowHorizontalScrolling`, `animation`, `customInputs`, `onClosing`,
   `cropAspect`/`cropImage`, and per-button `classes`/`icon`. Each is reported
   once on the card's durable channel when a card actually passes it, so a
   dialog that behaves differently from upstream's is on the record rather than
   discovered. `onClosing` is the one with teeth: it is a close **veto**, and
   honouring it would mean reopening a dialog the shell has already dismissed —
   so a card's veto is dropped and it sees a closed popup rather than a hung
   one. Corpus and bundle use of all of them: zero.

**The content is the first card-authored HTML the shell renders into its own
DOM.** Everything else a card draws goes into a sandboxed frame. A modal cannot,
so `app/sanitize-html.ts` installs the policy `app/inline-html.ts` has carried
since `INLINE-HTML.md` ruling ③ and had no consumer for: DOMPurify with the
stated forbidden tags and attributes and an allow-list for every URI-bearing
attribute, then the independent audit over the tree that actually came back. It
**fails closed** — where DOMPurify cannot run (a server render) or the audit
finds anything, the markup is escaped to text and the dialog says so. Measured:
all four of the bundle's contents are plain text, one of them a DOM `<span>`
built with `textContent`, so nothing in the measured population needs markup at
all.

**Not `window.alert`.** The bridged `alert`/`confirm`/`prompt` (§ the dialog
bridge) answer *for* the card, because upstream answers those synchronously and
a message boundary cannot. `callGenericPopup` is asynchronous upstream too, so
this one carries the reader's real answer — and no real blocking dialog is ever
opened, which would freeze browser automation and is not ST's behaviour either.

### What it costs elsewhere

The popup runtime lives in the **fetched member table**
(`sandbox/popup-api.ts`), not in the per-frame bootstrap. Its first shape put it
in the bootstrap and grew it 7.1 KiB — a seventh of an artifact that is inlined
into every frame's `srcdoc` — which needs `FRAME_OVERHEAD_BYTES` at 57 KiB, at
which the frame budget's own invariant forces `FRAME_COUNT_LIMIT` from 20 live
interfaces down to 17. Split out, the bootstrap grows 0.9 KiB and the constant
moves one KiB with the gate untouched. `FRAME_OVERHEAD_BYTES` is now within
about a kilobyte of the artifact (it was within 0.8 before this change), so the
next thing that grows the bootstrap faces the same choice: the member table, or
the gate.

**What would overturn it.** For the attribution line: a measurement that readers
find it noise, which is a claim about the line and not about the boundary. For
the queue: a card that legitimately needs two dialogs at once — a confirm raised
*from* a popup's own content. For the sanitizer's install: a decision that the
shell must never hold card markup at all, which would mean answering popups with
text-only content and saying so.


## 60. A usage page: what the whole profile has cost, cut by time and by model

**Kind:** deliberate improvement, with no upstream counterpart and a named
limit on what it can say about the past.

**Upstream** has no such surface, and could not build this one from what it
stores. SillyTavern keeps its own *estimate* of each message's text
(`extra.token_count`, written by `getTokenCountAsync`) and shows that; it never
records what the provider said it charged, so a cache hit — the thing that
decides what a long chat costs on DeepSeek — is invisible there, and a question
across conversations has nothing to be asked of. §47 records the per-turn half
of this difference; this entry is the profile-wide half.

**Iris** already stored the provider's own figure per generation (§47, host
§22), and that was still not enough to answer "what am I spending, and on
what": a `TurnUsage` named **no model and carried no moment**. Measured over the
16 real conversations on this machine, 2026-09-08
(`apps/iris/data/default-user/chats`, 566,905 bytes): **12 usage records, and
every one of them has neither field** — seven carry the five token buckets
alone, five carry a request fingerprint as well. No message line can date them
either, because Iris's own export writes no `send_date`.

So three optional fields join the record on the same stored object as the
buckets (`model`, `provider`, `at`; protocol `TurnUsage`, host §28), a host RPC
`usage.summary` aggregates across the profile's chat files, and this page reads
it:

| what | where |
| --- | --- |
| Entry, in the settings drawer beside the backups card | `apps/iris-web/src/app/UsageSection.tsx` |
| The page, a dialog rather than a drawer card | `apps/iris-web/src/app/UsagePanel.tsx` |
| Every figure, colour and coordinate on it, pure | `apps/iris-web/src/app/usage-stats.ts` |
| Styles | `apps/iris-web/src/app/panels.css`, `.iris-usage*` |

**A dialog and not a drawer card**, measured: the drawer is 392px and the chart
keeps a legible column per time bucket, so a 30-day range needs about 1.7 of
those widths before it has to scroll. The dialog carries `min(880px, 100%)` —
the prompt breakdown's 640px was still not enough — and the SVG scrolls inside
`.iris-usage__plot`, which is the one layout rule the page has: **the chart
must never be the thing that makes the page scroll sideways.** The chart also
**grows to fill the room it is given** (`chartLayout`'s second argument, a
`ResizeObserver` reading in the panel): three buckets is the floor width, and a
460px plot in the left half of a 950px card reads as a thumbnail nobody
finished. It cannot be a CSS rule — the SVG has a `viewBox`, so `width: 100%`
would scale the 10px axis type up with the drawing — and the data still wins,
so a range that needs more columns than there is room for takes what it needs
and scrolls.

**The page's own shape**, after the appearance pass of 2026-09-08: one control
row (the range switch left, the metric switch right, both the segmented
`.iris-choice` the prompt breakdown uses), then three sheets of
`--iris-bg-raised` paper on the dialog's sunken ground — the figures (one large
total card beside a grid of six capsules, where seven equal cards had been seven
unranked facts), the chart with its legend inside the same card under a
hairline, and the conversations as hairline-separated rows. The plum accent is
spent on exactly three things: the pressed option of a switch, the two share
bars, and the caveat line's `?`. Two of the arrangements are measurements rather
than choices, both taken from a static preview built out of this page's own
server-rendered markup and stylesheets: the capsule grid's `minmax(160px, 1fr)`
(at 104px it fitted five columns and orphaned the sixth) and the control strips'
`flex: 0 0 auto` with `nowrap` (`space-between` had squeezed `7 days` onto two
lines). The one width rule is a **container** query on the dialog body rather
than a media query, because `tests/breakpoints.test.ts` pins the shell's three
viewport breakpoints and this reflow is about how wide the dialog turned out,
not how wide the window is.

**One line per model, colour assigned by name and not by position.** The chart
is redrawn on every range and metric change, and a model whose line was gold in
"7 days" and grey in "30 days" would make the two readings uncomparable — so the
style comes from a hash of the model name, with collisions probed in sorted-name
order so the assignment depends only on the *set* of names. The palette is six
existing theme tokens times four dash patterns; the six are the tokens that
clear the 3:1 WCAG 1.4.11 floor for a meaning-carrying non-text mark against
`--iris-bg-raised` in all three themes, and `tests/contrast.test.ts` now
computes that rather than trusting it. Two candidates were rejected on the
measurement — `--iris-accent-quiet` at 2.93:1 and `--iris-tick` at 2.79:1, both
in 墨. Past six the colours run out and a dash takes over, because a seventh hue
this palette cannot distinguish is worse than a dashed repeat, and a dash is
also the one distinction that survives a colour-blind reader.

**And the unattributed line was drawn in one of the two rejected tokens**, which
the check could not see because it was reading the palette list and this colour
was written into the panel — three times, in two spellings that disagreed about
the dash. It is now `UNATTRIBUTED_STYLE` in `usage-stats.ts`, dashed
`--iris-ink-tertiary` (3.96:1 in its worst theme), and `tests/contrast.test.ts`
measures it beside the palette. This was the *worst* place for that mistake to
sit rather than a marginal one: every usage record on this machine names no
model, so the failing 2.79:1 grey was the only line most readers would ever see.

**What it costs.** Three things, and the first is the one that matters.

**Every record that exists today is unattributed and undated.** A model with no
name is drawn as its own line labelled "unknown model" — counted, because those
tokens were spent and dropping them would understate a bill — and an undated
record is placed at its conversation's own last activity. That is a
*reconstruction*: every undated record in a chat lands in one bucket, so an old
conversation reads as a single spike at its last activity rather than as the
sessions it really was. The page says so, with the count — one line of small
type under the chart carrying `usageUndatedShort` ("N/M undated"), whose hover
is the whole sentence (`usageUndated`: "N of M generations carried no
timestamp…") — rather than smoothing it, which would invent a distribution the
files do not contain. **The count is the part that stays visible**, because
"some of this is a reconstruction" is not a reading: on the corpus above the
line reads 12 of 12, and 1 of 400 would be a different page. It stops being the
whole story one generation after this ships, and never stops being true of the
history before it.

**The hit rate is over a narrower population than the tokens beside it.** It is
`cacheRead / cachePrompt`, both restricted to the generations that reported a
cache bucket, so a route that says nothing about caching cannot dilute one that
does. The consequence a reader must not be surprised by: the percentage is *not*
`cacheRead` over the "billed input" card above it, and on a mixed range the two
denominators differ by a lot — on a two-generation fixture, 75% against 19%.
`cacheTurns` of zero shows a dash, never `0%`.

**The reply is a whole-corpus scan with no cap.** Measured through the host's own
reader against a read-only copy of the profile, 2026-09-08: **1,300 bytes** at
day granularity and **1,446** at hour, over 16 conversations and 566,905 bytes of
chat files; 爱衣 alone (9 records) is **629 bytes**. The bound that makes an
uncapped answer safe is that the reply's size is set by (buckets × models) and by
the number of conversations, never by their length — but a profile of thousands
of conversations pays a linear file read per request, and there is no cache
because the files are the truth (host §28 states the same reasoning
`chat.search` does).

**What would overturn it.** A host that recorded a per-message timestamp in the
chat file would retire the reconstruction and its note. A profile large enough
for the scan to be felt would make the uncapped reply the wrong shape, and the
answer then is a host-side index with invalidation on write, not a cap — a
summary of an unstated fraction of the corpus is not a summary. And a palette
with six genuinely distinguishable hues in all three themes would retire the
dash axis.

## 59. A capsule under the composer says how full the context window is, and what is filling it

**Kind:** deliberate improvement.

*(Numbered from 58 because 57 is reserved for the popup-proxy round in flight elsewhere. If the two land out of order this becomes 57 and that one 58; nothing outside these two files cites either number yet.)*

**Upstream.** SillyTavern has the figures and never puts them together. Its prompt manager computes a per-item token count and a total, and shows them in the *prompt manager* — a panel two clicks away inside the AI-response-configuration drawer, listing the preset's own rows with a token column (`public/scripts/PromptManager.js:1761`, into the `#completion_prompt_manager_list` header template). Nothing on the composer says how much of the window is spoken for: the send form's own bar carries the extension buttons and the stop/continue affordances, and the only always-visible token figure anywhere in the interface is the per-message `{n}t` estimate — of the reply text only — which is off by default (`power-user.js:199`). So the question "am I about to overflow" is answered in SillyTavern by opening a drawer, and the question "what is filling it" by reading a list of preset rows that does not include the conversation, the world books, or a card script's injections as such.

**Iris** puts one capsule in the composer's row beside the prompt and model capsules, and it opens a card. Before it has been pressed for this conversation it states the capacity alone (`Context 7.2K`); pressed once, it states the reading (`Context 2.1K/7.2K · 29%`) and keeps it until the conversation changes. *(§68 narrowed that first clause: the capsule now states a **measured** reading, and draws it, as soon as the conversation has generated once — the capacity-alone state is what a conversation nobody has generated in shows.)* The card carries the headline reading, one proportion bar, six category rows with a colour and a token count each, what is left, what is held back for the reply, the conversation's average cache-hit share, and which of the two answers this is — a record of a sent turn or a preview of the next request. `app/context-occupancy.ts`, `app/ContextMeter.tsx`, the `context*` keys of `i18n/strings.ts`, `tests/context-meter.test.ts`.

**Transcribed from deepseek-harness** (MIT, `THIRD-PARTY-NOTICES.md`): the panel's shape and dismissal, and the rule that makes the picture honest — the bar's overall length is the **exact** occupancy and the breakdown only proportions its coloured parts, so the bar can never disagree with the percentage printed above it; a zero-width part is dropped rather than drawn at the minimum width that protects genuinely small ones.

**The six categories are read off the ids the host mints**, not off labels. A label is the preset's own `name` and a user can type anything into it; an id is minted by the host for every contribution it makes itself and is the preset's `identifier` otherwise. The classification is a total function with a real `other`: `kind === 'history'` is the conversation whatever its id is called (the contract says history is one aggregate row, so a second history-shaped row must not be filed by name); `script.*` is a card's injection; `worldInfoBefore` / `worldInfoAfter` / `worldInfo.*` are world books; seven named ids are the card and the persona; **an id with no dot is a preset identifier** — ST mints the marker names and UUIDs, and a UUID's separator is a hyphen — so every custom prompt in the list lands under "prompt and preset", which is what a reader means by "the preset"; and a dotted id in a namespace the table has never met lands in `other`, which is what makes a host-side addition show up as an unexplained slice instead of being filed silently under the preset.

**The denominator is `context - reserve`.** Not the window: the reserve is held back for the reply, so it was never the prompt's to spend, and `itemization.ts`'s `budgetUse` and the prompt panel's 「占可用 N」 already divide by that figure. Two surfaces one press apart dividing by different denominators is the one thing this reading must not do — and it is also the denominator the host's compaction threshold uses (`notes/packages/iris-app-service/DEVIATIONS.md` §29), so the meter's percentage and the trigger cannot disagree about what full means.

**What it costs.**

- **The reading costs a round trip, and the capsule says so by not showing one.** An itemization is a full world-info scan and a macro pass; the composer re-renders on every keystroke of the draft, so a reading taken per render would be unaffordable. It is fetched **when the card opens**, kept while the conversation is unchanged, and dropped when the chat, its floor count or its compaction record moves. The visible consequence is that a reader who has never pressed the capsule sees `Context 7.2K` rather than a percentage. Showing nothing until a round trip completed would be a control that looks broken; showing a stale percentage would be worse than both.
- **Two kinds of number sit on one card, and only the wording keeps them apart.** Everything except the cache-hit line is the host's own **estimate** of an assembly; the cache-hit share is the provider's own accounting. `STRINGS.md` §三 pins 「用量」 = reported billing against 「估算」 = estimate, and this card is the only surface in the shell where the two meet — so it takes the prompt panel's estimate vocabulary throughout and reuses `usageCacheHit`'s own key for the one reported figure rather than restating it.
- **`ChatView` grew a `budget` field** so the capsule can render without asking for anything. It is optional and absent is a real state: a projection with no settings to resolve (a fixture, a transport test) yields a view that says nothing about capacity and no capsule at all, rather than a `0` window every consumer would divide by.
- **A legend swatch is not held to the 3:1 contrast floor**, and that is a decision rather than an oversight: WCAG 1.4.11 covers a graphic required to understand the content, and each row states its own name and token count in text beside the dot. Two of the four borrowed palette tokens would fail that floor. What *is* held, by a test that reads both stylesheets, is the property that actually breaks the legend — **no two categories may draw the same colour in any of the three themes**.
- **Two new palette tokens.** Six categories needed six distinguishable marks; four came out of the existing family (plum, its lighter derivative, gold, the faintest ink) and two hues were missing, so `--iris-meter-celadon` and `--iris-meter-slate` were added to all three themes, to `THEME_TOKENS` and to the three preset tables. Not `--iris-danger`, which means "this deletes something" everywhere else in the shell — a category wearing it would read as a warning about itself.
- **The card is CSS-positioned, not portaled**, which means it is anchored to the composer's left gutter rather than to the capsule. `.iris-composer__inner` is the scroll container that reserves the scrollbar lane and would clip an absolutely-positioned child, so the card is a sibling of the plum branch at `.iris-composer` level — the box that exists to paint and position and has no `overflow` for exactly this reason. The cost is that a very narrow window gets a card wider than the capsule it belongs to.
- **A server render cannot open it**, so `tools/render-check.tsx` pins only the wiring on either side — the capsule is on the page, it is a button that announces a dialog, and it states the reading computed from the fake's own budget. The card's contents are pinned in `tests/context-meter.test.ts`, the same division the model menu already uses. *(§68 added to both ends: the render check also pins the gauge, its band and its width, and renders `ContextCard` directly for the one line that had fallen between the two suites.)*

**What would overturn it.** A cheap reading. If the host ever carried the last request's category totals on the open chat, the capsule could state a percentage without being pressed and the fetch-on-open machinery would go — that is a protocol change with a real cost (the host would have to classify, which is a view concern) and it is why it was not done now. Or a ruling that the prompt panel is the only place a breakdown belongs, in which case this becomes a capsule that opens that panel and the card goes.

## 61. The composer runs `/` commands, and gives every name SillyTavern owns back to SillyTavern

**Kind:** deliberate improvement, with one deliberate deference.

**Upstream.** SillyTavern's composer *is* a command line. Anything typed into `#send_textarea` beginning with `/` is parsed by `SlashCommandParser` and executed instead of being sent, with a pipeline (`|`), a no-inject variant (`||`), named arguments, quoting, and an escape rule for a literal pipe. It registers **289** command names in 1.18.0 — measured, not estimated: every `SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: '…'` across the 34 files under `public/` that call it (`node -e` over the checkout; the list is checked into `app/commands.ts` as `ST_SLASH_NAMES`). Help is `/?`. There is no `compact` and no `help` among them.

**Iris, before.** Nothing read the first character of the draft. `Composer.tsx`'s only uses of it were `draft.trim() === ''`; a line beginning with `/` went to the model as prose. Slash commands existed only as a card-driven path — `TavernHelper.triggerSlash` → `actions.runSlash` → `script.slash` — with no composer involvement and no way to enumerate what the host accepts.

**Iris, now.** The composer resolves a typed line into one of three things, in `app/commands.ts`:

1. **Not a command** — no leading `/` — is a message, unchanged.
2. **A name Iris owns** runs a client-side descriptor. Two of them when this section was written — `/compact` (`notes/packages/iris-app-service/DEVIATIONS.md` §29) and `/help`; eight since §61a, which lists the rest.
3. **Anything else** goes to the host **verbatim**, through the same `script.slash` a card's call goes through.

Typing `/` opens a completion menu (the `Menu` primitive, portaled and anchored to the field's own rect); Tab completes an unambiguous candidate; Escape dismisses the menu without dismissing the line. The IME guard that was already on the Enter handler now guards Escape and Tab as well — a Chinese reader presses both to commit and cancel a *composition*, and neither press is for this component.

**The deference is the point, and it is a rule rather than a habit.** Compatibility is the floor, so a name upstream registers keeps upstream's meaning and Iris may not take it. `tests/commands.test.ts` holds the disjointness against the measured 289, in the direction that can actually break it: a **new Iris command** that collides goes red at the moment it is added. The list is checked in rather than parsed from the install on purpose — a test that read `E:/sillyTavern/SillyTavern` would run on a developer's machine and skip on CI, which is exactly the shape `scripts/check-corpus-skips.mjs` exists to catch, and it would leave the collision unchecked precisely where new commands get merged.

**Only the name is parsed here.** Everything after the first run of whitespace or the first `|` is handed on as one string. Upstream's argument grammar — named arguments, quoting, the pipeline, the odd-backslash escape for a literal `|` — lives host-side in `@iris/compat-tavernhelper`'s parser, and `store.ts`'s `runSlash` already records why there must be exactly one implementation: *"a second copy in the browser would agree in every test and disagree the first time a user types a `|`."*

**What it costs.**

- **A `/`-prefixed line can no longer be sent as prose.** A reader who wanted to say `/shrug` to the character now gets a refusal naming the command instead of a message. That is what upstream does too, and it has upstream's escape hatch neither more nor less: none in the composer.
- **The host's refusal is what a reader sees for a name nobody owns**, and it is the host's own words. `script.slash` accepts exactly `/trigger` and `/send <text>|/trigger` today (`notes/apps/iris-web/UPSTREAM-SLASH.md` — the three commands the corpus actually calls) and refuses everything else **by name**. So a reader typing `/setvar x 1` — a real upstream command — is told that Iris has not implemented it, which is true and is the honest answer; a sentence written in the browser could not know which of the two layers declined.
- **Iris's command surface is now user-visible**, where before it was only card-visible. That makes the gap between 289 and 3 something a reader meets rather than something only a card author meets. `/help`'s closing line exists for this: without it, a reader shown a short list concludes that `/trigger` does not work here, and it does. (Two commands then, eight after §61a — the closing line matters *more* at eight, not less, because a longer list reads more like a complete one.)
- **The completion menu is a display and a click target, not a keyboard surface.** Focus stays in the field so the reader keeps typing, which is why Tab completes rather than the arrow keys, and why the menu is mounted only while open.
- **The card bus goes through the same resolution.** A card that writes into the field and clicks send gets the command, because that is what SillyTavern's composer does with a card's write. Gating commands to the keyboard would make the same text mean two different things depending on who typed it — but it does mean a card that wrote a `/`-prefixed line intending prose has changed behaviour. Nothing in the corpus does that (all four measured `triggerSlash` sites call the RPC directly).
- **`/compact` is refused while a reply is arriving**, with a named sentence rather than silence: it rewrites what the next request assembles from, so running it under a request in flight would change the conversation beneath it. `/help` is not gated, because asking what the commands are costs nothing.

**What would overturn it.** A host method that enumerates what `script.slash` accepts, which would let the completion menu offer upstream's names beside Iris's instead of leaving them undiscoverable. Or widening `script.slash` past the three commands — every name it gains is a name this table must not have, and the disjointness test is where that collision would surface.

### 61a. The second batch, read off the harness's own command list

**Kind:** deliberate improvement, on the rule §61 established.

**What the harness actually registers.** The brief for this task named `help`, `model`, `new`, `export`, `config`, `tokens` and `review` as the harness's commands. **Measured, that list is wrong in both directions.** `dsh` has two command registries and seven commands between them:

| dsh command | usage | description (verbatim) | where |
| --- | --- | --- | --- |
| `/compact` | — | *Compact older conversation history* | `packages/compaction/command-compact` (host, `ctx.commands.register`) |
| `/export` | — | *Download this Session log as a ZIP archive* | `packages/session-query/session-log-export` (host) |
| `/feedback` | `<text>` | *record feedback about this session* | `packages/feedback/command-feedback` (host) |
| `/goal` | `[<objective>\|clear\|edit <objective>\|pause\|resume]` | *set or view the goal for a long-running task* | `packages/goal/command-goal` (host) |
| `/plan` | `[off\|message]` | *Enter or leave plan mode* | `packages/plan/plan-mode` (host) |
| `/permission` | `<preset>` | *Switch the permission preset (sandbox mode + approval policy)* | `packages/interaction/permission-presets` (host) |
| `/model` | — (a `popupSelect`) | *Select the model for this conversation* | `packages/client/ui-model-selection` (client, `ctx.commandUi.register`) |

`/permission` is also **decorated** client-side by `packages/client/ui-permission-presets` — a `popupSelect` UI hung on the host command's name, not an eighth command. There is no `/help` (the `/` popup *is* the discovery surface, so a help command would list what the menu already shows), no `/new`, no `/config`, no `/tokens`, no `/clear` and no `/review` — the `review` the brief saw is a *skill* name in a test fixture, and `tokens` is a parameter name in an API catalogue. The seven above are the whole list; `grep -rn "commands.register(\|command.register("` over `packages` and `apps` is the census.

**What each one means here.**

| dsh | verdict | Iris |
| --- | --- | --- |
| `/compact` | **照搬** | `/compact`, shipped in §61. |
| `/export` | **照搬** | `/export` → `actions.exportChat(chatId)` over the existing `chat.export`. A conversation, not a session log. |
| `/model` | **改造 + 改名** | `/chat-model [<name>\|default]` → `actions.setChatModel`. Same semantics as dsh's — *this conversation only* — but `model` is one of upstream's 289, so the name yields. |
| `/feedback` | **不做** | The object does not exist. Nothing in Iris records a judgement about a session, and inventing one would be a new RPC plus a new store — not a keyboard entry to something that already works. |
| `/goal` | **不做** | A coding agent's long-running objective. A roleplay conversation's "objective" is the scene, which is the author's note and the prompt — surfaces that already exist and are not commands. |
| `/plan` | **不做** | Plan mode is a tool-execution policy: the model proposes and a human approves before anything is written. Iris's model writes prose into a conversation; there is nothing to approve. |
| `/permission` | **不做** | Tempting, because Iris *does* have a permission of this shape — whether a card's scripts may run, and whether they get document access. But it is a **consent decision**, asked through `ConsentAsk` with the script count and byte size in front of the reader (`answerScriptsAllowed`, `setDocumentGrant`). A command that flipped it would be a way to grant a permission without being shown what is being granted, which is the one thing that flow exists to prevent. |

**Four more that are not dsh's, and are marked as such.** `/new`, `/rename`, `/config` and `/capacity` came from the brief rather than from the harness. They were built anyway because each is a keyboard entry to a control the mouse already has — the sidebar's new-conversation, the chat list's rename, the masthead's gear, the composer's capacity capsule — which is the same thing dsh's `/model` is for its capsule. Nothing new reaches the wire: every one of the eight commands calls a store action that already existed.

**The names the rule cost, recorded because a rename is a divergence.**

| wanted | upstream has it | Iris ships | why this name |
| --- | --- | --- | --- |
| `model` | yes | `chat-model` | Upstream: *"Sets the model for the current API. Gets the current model name if no argument is provided."* (`slash-commands.js:3005`) — **global**. The prefix names the scope, which is the real divergence: Iris's override is per conversation. |
| `tokens` | yes | `capacity` | Upstream: *"Counts the number of tokens in the provided text."* (`:2983`). Nothing to do with how full the window is. |
| `context` | yes | `capacity` | Upstream's `/context` selects a **context template preset** (`selectContextPreset`, `:609-630`). Same word, unrelated object — the worst kind of collision to allow. |
| `regenerate` | yes | **nothing** | The action stays on the newest reply's own button row (`Message.tsx`), where it already was. |
| `continue` | yes | **nothing** | Same row. |
| `impersonate` | yes | **nothing** | Same row. |

**Reserved is not the same as working, and this is the half most likely to be misread.** `script.slash` accepts three commands (`UPSTREAM-SLASH.md`), so typing `/continue` today reaches the host and is **refused by name** — the same honest answer §61 already records for `/setvar` and every other real upstream command. Yielding does not make the three work; it makes them upstream's the day the host implements them, with nothing here to undo.

`new`, `rename`, `export`, `capacity`, `config`, `compact` and `help` are all free of the 289; `tests/commands.test.ts` asserts the disjointness over the whole table with a size floor under it, and asserts the six yielded names in **both** directions — upstream has them, and Iris does not — because either half alone is satisfiable by accident.

**The three decisions inside the batch that are not obvious.**

- **`/chat-model` is *not* gated on idleness, and `/export` is.** The gate answers one question: would running this under a request in flight change or truncate what that request is about to produce? An override applies from the *next* request, and the capsule's menu is already open and selectable during a generation — gating the keyboard entry to a control the mouse can still reach would give one action two answers. `chat.export`, by contrast, serves what the host has **stored**, and a reply still streaming is not stored yet: an ungated `/export` hands back a file silently missing its last floor. `/new` is gated because it navigates off a conversation a reply is still arriving into. The test asserts the gating as a **partition**, both sides, so a ninth command that never asked the question goes red on whichever side it landed on.
- **An unlisted model name is refused only when the endpoint has answered.** `ModelMenu.models` always carries the model in force, so a connection nobody has probed still yields a one-row list — refusing against *that* would reject every valid id on a connection whose capsule the reader has not opened. The fact that separates them is `menu.empty === undefined`, which is what `ModelChoices.listed` carries. The array's length cannot answer it, and the refusal names the list it refused against.
- **`default` is a keyword, so a model literally named `default` cannot be set from this command.** The capsule's menu solves the same problem with a sentinel id that begins with a space, which nobody can type on a command line. The capsule can still select such a model; this is the cost, recorded rather than papered over.

**What it costs.**

- **`/config` needed a prop through `ChatPane`.** The drawer's open state is the shell's, because above 1200px the drawer is a grid *track* and only the shell can decide a track (§ the `StatePanel` `drawerOpen` prop, for the same reason). So `App` → `ChatPane` → `Composer` carries an opener. The alternative was a second module-scope bus beside `composer-bus.ts` for one boolean the shell already owns.
- **`/c` no longer completes on Tab.** Four commands start with it (`chat-model`, `capacity`, `compact`, `config`), and Tab only fires on an unambiguous candidate. The menu still lists all four.
- **The argument menu is one command's, and only `/chat-model` has one.** `/rename` takes free text a menu cannot predict, so typing `/rename ` closes the menu rather than offering something. The two kinds of row are computed by separate functions because picking one means a different thing: a name row replaces the line with `/name `, a value row completes the line already being written.
- **Eight rows needed headings.** One column answering three different questions read as one answer. An empty group prints no heading, so the shape follows the table.

**What would overturn it.** A host RPC that reports what the endpoint offers without a connection test would let `/chat-model` refuse honestly on a cold connection instead of accepting anything. A consent surface that is a *statement* rather than a question — if the script permission ever became a plain setting with the figures visible beside it — would make `/permission`'s analogue buildable. And if `script.slash` ever grows `/regenerate`, `/continue` or `/impersonate` host-side, those three names start working from the composer with no change here, which is what yielding was for.

**A note on the brief.** Five of the seven candidate commands the brief named do not exist in the harness, and one of the two that do (`/model`) is a client contribution rather than a host command. The census above is the correction; it was taken before any code was written, because the whole task was defined as "follow dsh's list" and the list was the premise.

## 62. A rule editor with no test panel, that says beforehand what a rule would fail to do

**Kind: compatibility (the editor) plus one deliberate improvement and one
deliberate omission.**

**The compatibility half.** Until this round the regex panel could import,
toggle, reorder, export and delete, and could not **write** a rule. Every rule
in the profile's global tier had to be authored in a SillyTavern install and
imported, and a typo in a pattern meant going back there to fix it.
`RegexEditor` is upstream's `editor.html`, field for field:

| upstream label | field | note |
| --- | --- | --- |
| Script Name | `scriptName` | required, as upstream's save requires it |
| Find Regex | `findRegex` | bare or `/pattern/flags` |
| Replace With | `replaceString` | `{{match}}`, `$1`, `$<name>` |
| Trim Out | `trimStrings` | one per line; blank lines dropped, as upstream filters |
| Affects | `placement` | five checkboxes: 1, 2, 3, 5, 6 |
| Min / Max Depth | `minDepth` / `maxDepth` | blank means unlimited |
| Disabled | `disabled` | |
| Run On Edit | `runOnEdit` | |
| Macro in Find Regex | `substituteRegex` | 0 / 1 / 2 |
| Only Format Display | `markdownOnly` | reworded, below |
| Only Format Prompt | `promptOnly` | reworded, below |

New rules start on upstream's own defaults (`index.js:797-809`): display-only,
run-on-edit, User Input. Reproduced rather than improved on, so a rule written
here and exported into an install is the rule that install's editor would have
produced.

**Placements 0 and 4 have no control**, matching upstream: `0` is `MD_DISPLAY`,
marked deprecated in upstream's own source, and `4` is the retired `sendAs` and
a hole in the enum. A rule that arrives carrying one keeps it — the editor's
round trip preserves what it cannot show.

**The two ephemerality checkboxes are reworded by consequence.** Upstream's
visible text is "Alter Chat Display" and "Alter Outgoing Prompt"; its i18n keys
are the field names, `Only Format Display` / `Only Format Prompt`. Neither says
the thing the reader is choosing, which is *whether the chat file on disk
changes*. Here they are 「你读到的文本」 / 「模型读到的文本」 under 「改动的是」,
with a note that switches on the state: with either ticked, the stored
conversation is left alone; with neither, the rule rewrites it and that cannot
be undone.

**The improvement: four sentences about what a saved rule would fail to do**
(`regexDraftProblems`). All four are consequences of one gate in the engine
(`getRegexedString`, `engine.js:348-355`) meeting the flags each call site
passes, so they are derivable rather than guessed:

| condition | upstream's treatment |
| --- | --- |
| no placement ticked | a toast, **after** the save |
| no find pattern | a toast, after the save |
| World Info without prompt-only | a tooltip on the checkbox, enforced nowhere |
| Slash Commands with either ephemerality flag | **nothing at all** |

The last is the one worth having. All four slash-command call sites pass no
flags, so only the "neither" branch of the gate can fire — and upstream's
new-script default ticks *display-only*. So a freshly created slash-command rule
silently never runs, and the mistake is pre-made by the defaults. Reported, not
refused: a half-finished rule is a normal thing to save, and upstream saves it.

**The omission: no test panel.** Upstream's runs the rule with every gate
disabled — `disabled`, `promptOnly`, `markdownOnly` and `runOnEdit` forced
false, `placement` and both depths `null` (`index.js:816-843`). It answers "would
this pattern match this text, ignoring everything that decides whether it runs",
and all four rows of the table above pass it. A control that says "works" about
a rule that will never fire is worse than no control. The four sentences are
what a test panel was being used to discover.

**What would overturn it.** A test panel that ran the *real* gate — placement,
depth and ephemerality included, against a chosen message of the open
conversation — would answer the question the reader actually has, and would be
worth building. It needs a message to test against, which is why it is not in
a profile-wide settings card.

## 63. The card's own regex tier gets a panel, and the switch it never had

**Kind: compatibility fix — a control upstream has and this shell did not.**

**Measured, and the measurement is why this is here rather than in a later
round.** Over the 19 local cards: **15 carry `data.extensions.regex_scripts`,
173 rules between them**, all 13 fields present on every one. The same install's
global tier — the only one this shell could see — held **zero**. All 15 carry at
least one live display-only rule and **11** use the tier to strip the card's own
`<UpdateVariable>` blocks. So essentially all of a real user's regex was
invisible in Iris, and the tier that decides whether a reader sees a card's
bookkeeping had no control at all. The host side of the gate is
`notes/packages/iris-app-service/DEVIATIONS.md` §30–§31.

`ScopedRegexPanel` sits under `RegexPanel` in the drawer, in **run order** —
global first, as upstream's `SCRIPT_TYPES` iteration puts it — because a reader
comparing the two lists is comparing them along the axis that decides which
rewrite wins.

**It lists a refused tier rather than emptying out**, which is upstream's own
behaviour: `getRegexScripts` defaults to `allowedOnly: false` and only the engine
passes `true`, so upstream's panel shows a disallowed card's rules too. A refused
tier answering with an empty list would read as a card carrying no rules, with
the control that reverses the decision sitting over nothing.

**Both switches are reported**, the way `ScriptPanel` reports a card script's
two: 「卡作者关掉的」 for the author's `disabled`, and the reader's own checkbox
beside it. "Why is this off" has two answers and they call for different
actions.

**What this panel deliberately will not do is edit a rule.** The rules belong to
the card — the author wrote them, they travel with it through export and
re-import — and an edit here would either rewrite someone else's document or
invent a shadow copy that the next card update silently disagreed with. Export
is offered instead, and the panel says so, so the absence reads as a decision
rather than as a missing button. The path for a reader who wants to change one
is: export it, import it into the global tier, edit it there, switch the card's
copy off.

**What would overturn it.** A card update flow — "this card has a new version,
here is what changed" — would give a shadow copy somewhere to be reconciled, and
then editing in place becomes answerable.

## 64. A script library: the user's own scripts, in the same sandbox as a card's

**Kind: compatibility — TavernHelper's 脚本库, which this shell had no
equivalent of.**

Iris could list, govern and run the scripts a **card** ships. A user who had
written a script of their own — a dice roller, a status panel — had nowhere to
put it. `ScriptLibraryPanel` is the two repositories this host keeps (global,
and one per character; the shapes and the storage decision are host ledger §32),
with `ScriptEditor` as the form and `script-library.ts` as the file format.

**The one design decision that matters: it is not a second run path.** A library
script reaches the page through `script.list` and `script.body` — the two calls
the card runner already used — with a new `source` field on the row saying which
repository it came from. So a library script runs in the same frame, under the
same per-card consent question, with the same remote-code allowlist
(`*.jsdelivr.net`, `raw.githubusercontent.com`), reports the same run states, and
appears in the same panel a card's scripts are governed from. **Nothing was
opened for it.**

A parallel listing would have been easier to build and would have put the user's
own scripts outside every one of those. It would also have been *invisible*: the
scripts would have run, so nothing would have looked broken, and the missing
consent gate would only have surfaced the day one of those scripts did something
the user had not read.

**The user's own code is not more trusted than a card's**, and the reason is
mechanical rather than moral: the two run in the same realm, so a card would
inherit anything granted to a neighbour. `COHABITATION.md` is the same argument
between two cards' scripts.

**Two repositories, listed in run order** — global, then this character's,
matching upstream's own merge (`store/iframe_runtimes/script.ts:26-32`) with the
card's tier standing in for the preset one. The order is data: two scripts
writing the same variable settle it by which ran last.

**Where each repository is edited.** The drawer holds both, with the
per-character half present only while a conversation is open — a repository
belongs to a card, and the drawer has no card to name otherwise. The **character
page** holds the same rows for a card merely being browsed, and its own "write a
script for this character" control. That page deliberately refuses to switch a
*card* script (§57), and the difference is which store the write lands in:
`script.setEnabled` is scoped to the card whose conversation is open, so a switch
there would write the wrong card's policy, while a library write names its
character explicitly.

**Buttons carry both figures**, as the card-script rows do: 58 of the corpus's
89 buttons are `visible: false`, so "2 buttons, 1 shown" is the ordinary case
and a bar built from the whole array is the bug the proportion exists to catch.

**Folders are not carried.** Upstream has one level of `ScriptFolder`
(`type/scripts.ts:36-45`, `flattenScriptTree` at `:55`), and a folder export is
refused here rather than half-imported — its scripts live in a nested array, and
importing the wrapper would store a bodiless entry and drop everything inside it.
Listed as a gap, not silently mishandled.

**What would overturn it.** A library big enough to want folders. The shape
would be a `folder` discriminator on the stored record plus one level of nesting
in the listing, which is upstream's own and is additive.

## 65. An exported script carries its variable table; upstream offers to strip it

**Kind: known divergence, in the less private direction. Recorded, not fixed.**

**Upstream** asks before writing the file. `panel/script/ScriptExport.vue` shows
「脚本导出将包含以下内容, 请确认是否保留」 with a checkbox for 变量 and one for
按钮, driven by the script's own `export_with` defaults (`data: true`,
`button: true`, `type/scripts.ts:10-13`), and clearing one empties that field in
the exported copy (`ScriptItem.vue:167-183`).

**`exportScriptFile` writes the stored record whole**, `data` and `export_with`
included. So someone sharing a script they have been running shares whatever it
has accumulated with it.

**Why it is not simply always stripped.** A `data` table is sometimes the
script's *shipped* data rather than its accumulated state — 8 of the corpus's 47
card scripts carry a non-empty one — and dropping it would export something that
does not run. The correct fix is upstream's: ask, with the script's own
`export_with` as the default. It is not in this round because the question wants
a small dialog and this round's surface was already the two features themselves.

**The mitigation that exists.** This host does not use `data` as the live
`script` scope (host ledger §33), so the table in a stored library script is
whatever an import brought in or the author typed — not a running script's
accumulated variables. That narrows the exposure to imported tables rather than
removing it.

**What would overturn it.** Nothing; this is a gap with a known shape. The next
round should add the confirmation and default it from `export_with`.

## 66. The fake client answers the regex and script-library methods from memory

**Kind: a reversal of an earlier decision in this file's own subject.**

`regex.list` and `regex.set` were **refused** by the fake, with the reason
recorded in its own source: "the global regex list is profile state on the
host's disk; a fake has none, and an imaginary list would let a panel believe an
import landed."

**The argument was about the wrong thing.** An import into an in-memory list
*does* land, and `regex.list` reports it — which is exactly the truthfulness the
fake already claims for `scriptsAllowed`, the document grants and the per-script
overrides, all of which are host-side files it holds in memory. What the refusal
actually cost was visibility: `RegexPanel` returns `null` when
`regexScripts === undefined`, so the whole regex panel had never been rendered
by anything in this repository, and the editor added in §62 would have had
nowhere to be checked.

So the fake now holds a global regex tier, a per-card scoped tier, and the two
library repositories, and `render-check.tsx` pins all three sections plus the
merged `script.list`.

**The line the fake still holds is the same one it always held**: it will not
invent a script **body** (`script.body`) or a remote **fetch**
(`script.fetch`), because handing back plausible code would let a runner appear
to work here and fail against a real host. A list, a switch and a small store
the user writes are things a fake can model honestly; executable content is not.

**The seed is shaped after the corpus rather than being three identical rows**:
one display-only global rule and one that rewrites stored text; a scoped tier on
the dense card only, with its second rule `disabled: true`, because 4 of the 19
real cards carry none and the "this card ships none" branch is the common one;
and both library scripts switched **off**, which is the state a fresh library is
in.

## 67. A prompt part the cache-friendly order moved says so, and says where it came from

The host may now send a prompt section somewhere other than where the preset
put it — `notes/packages/iris-app-service/DEVIATIONS.md` §38 explains the
mechanism and what it costs. **A reorder the interface does not show is a
reorder the user cannot debug**, so two surfaces carry it, and each answers a
different question.

### The prompt panel: "my instruction is not where I put it"

The host sends `PromptItemization.entries` in **contribution order** — the order
the preset and the card asked for — and marks a moved row `deferred` (sent after
the conversation) or `promoted` (sent before it). The panel does two things with
that, and both are needed:

- **「按装配顺序」 groups the rows into the three phases the request carries** —
  promoted, in place, deferred. A view named "assembly order" that showed a row
  in a position the request does not use would be describing something that
  never happened. The grouping is deliberately coarse: the host's breakdown has
  one aggregate row for the whole conversation, so there is no finer position to
  be had, and a rank that pretended otherwise would be a number the contract
  cannot support. 「从大到小」 is untouched: it answers "what is eating my
  context", and position is no part of that question.
- **The row itself carries 「已前移（缓存友好）」 or 「已后移（缓存友好）」, plus
  「原位置第 N / M 条」.** Two badges rather than one, because the two moves have
  opposite meanings — "sent after the transcript" and "sent before it" — and a
  single 「已移动」 would leave the reader unable to tell which way, which is the
  only thing they need. The badge alone would also tell someone their prompt
  moved and give them nowhere to look; the position is the row's index in the
  host's own list, which is where they put it and where they will go to change
  it. The ids are UUIDs (29 of 41 prompts in a real preset) and the `order`
  numbers are internal, so "third of five" is the only form of that answer a
  reader can act on.

The row is **not** dimmed and not moved out of the table. The section is still
in the request, in full — only somewhere else. The visual mark is a rule in the
gutter plus a small line under the label, drawn in the accent colour for the
forward move and the warning colour for the backward one: they do not cost the
same. A promoted part is unchanged and only arrives earlier; a deferred part is
one the host has decided *does* change.

### The context card: "how much of this request is reusable"

`PromptItemization.stablePrefixTokens` over the request's total, printed as
「稳定前缀 约 X%（N）」. It sits on its own line beside
「缓存命中 X%」 and must never share a sentence with it: that line is the
**provider's own accounting of what happened**, this one is the host's
**estimate of a ceiling** the assembly leaves available. `STRINGS.md` §三 pins
that vocabulary split, and this is the one card where the two kinds of number
sit together.

It shows even when the provider has said nothing about caching, because a prompt
shaped badly for the cache is worth seeing before the first bill arrives. And
`stablePrefix()` returns `null` rather than 0 when the field is absent: "the host
sent no reading" and "nothing in this request is reusable" are different facts,
and a `?? 0` would print the second whenever the first was true.

### The switch

The replies card gets 「缓存友好装配」, and it is the **only** toggle on that card
whose absence means **on** — `settings.cacheFriendly !== false`, written out
rather than folded into a helper, because a copy-paste of its neighbours'
`=== true` would show every fresh installation a switch that is off while the
host reorders anyway. The card's one-line summary names it only when it is
**off** (「缓存顺序已关」), the mirror of how the other two switches are named
only when on: for a default-on control, the state worth surfacing without
opening the card is having been switched off.

## 68. The capacity capsule draws a gauge, and says which window it is dividing by

**Kind:** deliberate improvement, and the correction of a §59 cost.

*(§67 is the fake-client round in flight elsewhere.)*

**What §59 said it would take to do this.** Its own closing paragraph:

> **What would overturn it.** A cheap reading. If the host ever carried the last
> request's category totals on the open chat, the capsule could state a
> percentage without being pressed and the fetch-on-open machinery would go.

Half of that turned out to be already paid for and half is still true, and the
difference is the shape of this entry. The host records a full itemization for
**every turn it assembles** (`entry.itemizations`, and `#autoCompact` was
already reading one of them back by `lastTurn` — `service.ts` calls that reading
*free*, "no second assembly") and simply never projected it. So the *total* was
available for nothing; the *category totals* still are not, because classifying
is a view concern and putting six buckets on the wire would move it host-side.

So `ChatView` grew `measured?: { turn, tokens }` — one number and the turn it
was taken on — and nothing else changed about the fetch-on-open machinery. The
card still fetches, because the card answers a different question (what the
*next* request would contain, itemized).

### The gauge

A 2px fill along the capsule's own bottom edge, inside the capsule's existing
`overflow: hidden` so it is clipped to the capsule's curve and needs no radius
of its own — which is what keeps a fill at 4% from drawing a square corner
outside a rounded box.

**Three colour bands, not a ramp** (`pressureLevel`): under 60% the faintest
ink, from 60% the accent, past 85% the warning hue. At 2px a continuous hue ramp
is a colour nobody can name; three bands are a fact a reader can carry away
("it has gone plum"). The bands are stated once — `quiet` below 60, `near` from
60 through 85, `full` above 85 — so the capsule, the class names and the test
read the same rule, and the test pins them **as boundaries** (59/60, 85/86),
because a test at 30/70/95 passes for a rule shifted five points either way,
which is the only way this can be wrong.

**No track.** The capsule's border already draws the full length; a track would
be a second hairline 1px inside the first, and at this size the pair reads as a
rendering fault rather than as a scale.

**`aria-hidden`.** The gauge draws the percentage already printed in the label
beside it, and the label is the one that carries units. A zero-width fill is not
drawn at all — the rule `meterSegments` already follows on the card: nothing in
the window is a real state, and a hairline of plum is not how to say it. (The
`min-width: 2px` that keeps a genuinely small reading visible is exactly why the
zero case has to be dropped in the component rather than left to the width.)

**Which reading it draws, and a correction to the obvious ordering.** The task
brief said to prefer the host's recorded measurement. Implemented as: the
**fetched itemization wins when there is one**, the record otherwise. The reason
is agreement. A record is the cheaper fact and is why there is a bar at all
before anything is pressed — but the moment the card is open the card is showing
the *preview*, and a capsule printing a different number one line below the card
that explains it is two surfaces under one composer disagreeing about one
conversation, which is the exact failure §59's denominator paragraph exists to
prevent. `CapsuleReading.basis` carries which of the two is on screen, and the
hover names it.

**What a reader loses.** A conversation nobody has generated in yet has no
gauge, and so does every conversation immediately after the host restarts —
those records live in memory. The capsule then states its capacity alone, as it
did before this existed. Absent is reported as absent (`capsuleReading` returns
`null`), never as 0%: a confident empty bar under a full window is worse than no
bar.

### The window's provenance

The other half, and the one the user actually asked about — the capacity card
was printing 1 998 976 as the window for a `deepseek-v4-flash` conversation, and
nothing anywhere said who had chosen 2 000 000. (Where that number came from:
`notes/packages/iris-app-service/DEVIATIONS.md` §44.)

The host now resolves a window *with* its provenance (`ChatBudget.source`), and
two surfaces print it: a line on the card above the record-or-preview line, and
the capsule's hover. Four sentences, because they are four different next steps
for the reader — change model or unlock, change the number, reconsider a
decision already made, or set one at all:

| source | the line |
| --- | --- |
| `model` | 窗口 1M，按模型 deepseek-v4-flash 的上限 |
| `settings` | 窗口 65.5K，来自设置或预设 |
| `unlocked` | 窗口 2M，未夹 —— deepseek-v4-flash 已知只到 1M |
| `host` | 窗口 32.8K，宿主默认 |

**`source` is required on the wire, not optional.** The other two fields of
`ChatBudget` are absent when there is nothing to say; this one always has an
answer, because the host cannot resolve a window without taking one of the four
paths. Optional would let a projection that forgot it read as "no opinion", and
a capacity readout that cannot name its own denominator is precisely the state
this entry is fixing.

**The branch is a function, not a `switch` in JSX.** `windowSourceKey` lives in
`context-occupancy.ts` so a node test can call it: the four cases are the whole
visible half of this feature, and the case that was missing entirely — the
clamp — is the one nobody could have noticed the absence of. `windowSourceText`
then passes every slot for every case, one call site, which is what keeps four
sentences about the same three numbers from drifting into four vocabularies. The
test asserts the other direction too: the two sentences that do **not** name a
model must not carry a `{model}` slot, or the host-default line would print a
model it was never judged against.

**The settings drawer gets the unlock toggle** beside the window slider and not
elsewhere, because it is the other half of one decision — upstream keeps it
beside the same slider for the same reason.

### Costs

- **The gauge shares the capsules' positioning context.** `position: relative`
  went on the shared `.iris-composer__pill` rule rather than the capacity
  capsule's own, because the `overflow: hidden` that clips the fill is declared
  on that box and the two have to be on the same element. Harmless for the
  prompt and model capsules, and it is a coupling worth knowing about.
- **The three bands are held to the property the six category tints are held
  to** — no two may draw the same value in any of the three themes — by a test
  that reads `panels.css` and `tokens.css` off disk. Not to a contrast floor,
  for §59's reason: the percentage is printed in text beside the bar.
- **`prefers-reduced-motion` drops the width transition.** The growth is
  decoration; the width it lands on is the information.
- **`contextPillTitle`** (「看上下文窗口被什么占满了」) now appears only when
  nothing has ever been measured, which is the only state it is still true of —
  and so does `contextPillCapacity`'s comment one key above it, which said
  "before the card has been opened". The hover otherwise composes two existing
  keys (`contextCardFigures`, and one of the record/preview pair) with the
  window sentence added by this task, joined with ` · ` rather than given a
  template of its own — a second layout of the same figures is how two surfaces
  come to disagree.
- **The card's own 「第 N 回实测」 line is still unreachable, and that is
  unchanged rather than fixed.** `Composer` calls `actions.itemize()` with no
  turn, and the host answers with a record only when a turn is passed
  (`service.ts`'s `prompt.itemize`), so the card always renders
  `contextFromPreview`. Reachable copy would mean deciding the card is about the
  last request rather than the next one, which is a product decision and not
  this task's. The **capsule** does render 「第 N 回实测」 now, off
  `ChatView.measured`, which is where that wording earns its keep.
- **The render check can see both halves**, because both are wiring a server
  render reaches: the gauge needs `measured` to have survived the store and the
  provenance needs `budget.source` to have. It pins the fill's presence, its
  band, its width and the hover's window line — every one computed from the
  fake's own seed rather than spelled out. The fake declares
  `source: 'settings'` with a model the built-in table has never heard of
  (`local/qwen3-8b`), which is the one of the four wordings that fixture can be
  *true* of; declaring `'model'` to light up the clamped wording would have
  meant a fixture whose three numbers cannot all hold at once, and a fixture
  that cannot be true silences whatever asserts on it. The other three wordings
  are pinned in `tests/context-meter.test.ts` — all four in fact, and against
  `windowSourceKey` directly rather than by building a budget, because the
  branch is the thing that can be wrong.

  The fake also had to *earn* `'settings'`. It means "the stored value stands",
  and the fake's `DEFAULT_SETTINGS` carried no `contextWindow` at all — the real
  resolver would have said `'host'`. Visible on the seeded page: the drawer
  rendered its 32 768 fallback while the hover claimed the settings. Fixed by
  storing 8192 in the seed, not by relabelling the budget, so
  `FAKE_BUDGET`'s number is the one in both places.

**What would overturn it.** Per-category totals on the open chat, which would
let the *card* render without a fetch too and would retire the fetch-on-open
machinery §59 describes — still a host-side classification, so still not now.
Or a reading that the gauge and the over-budget border say the same thing twice:
the border already turns `--iris-danger` past 100%, and if that reads as
sufficient the third band could go.

**Where this sits among §59, §67 and the divergence line.** The card now closes
with four lines, and the order is an argument rather than an accretion: cache
hit (what the provider gave — 用量), stable prefix (§67: what this assembly left
reusable — 估算), divergence (bytes: where this request stopped matching the
last), then the window source. The first three are all *about this request* and
move every turn; the window source is about the **conversation** and does not,
which is why it is last of the four and why it sits beside the reserve line in
kind rather than beside the cache figures. 「第 N 回实测 / 下一条请求的预览」
stays below all of them: that sentence is about the *reading*, not about either
the request or the conversation. `STRINGS.md`'s divergence section states the
same ordering from the copy side.

One shared prop came out of the merge: `ContextBody` now takes the whole
`ChatBudget` rather than a bare `reserve`, because the card reads two things off
it — what is held back for the reply, and where the window came from — and
passing one number plus a second object would have been two reads of one fact.

## 69. A world-info row that was split shows which of its entries moved, because no badge on the row itself would be true

§67 put one badge on one row: 「已前移（缓存友好）」 or 「已后移（缓存友好）」,
with the position the row came from. That works while a row is one thing that
either moved or did not.

`notes/packages/iris-app-service/DEVIATIONS.md` §50 broke that assumption on the
largest row in the panel. A world-info depth bucket is **one** contribution and
several entries in the request, and the host now classifies the entries
separately — so on the operator's own 爱衣 four of five entries in one bucket
are sent ahead of the transcript and the fifth stays after it. There is no
single badge for that. 「已前移」 on the row would tell the reader their whole
19 KB world-info block moved, and no badge at all would leave the panel silent
about the one row it exists to explain.

**So the row keeps a badge only when every one of its entries went the same
way**, and otherwise the answer moves to a sub-list under the row: one line per
entry, the entry's own `comment` as its name, its own token count, and its own
badge where it has one. The sub-list is rendered **only when at least one entry
carries a badge** — a bucket that was split and stayed put is the ordinary case,
and five unmarked sub-rows under it would bury the rows that did move.

Three details are decisions rather than styling:

- **The row count does not change.** Five entries do not become five rows. The
  list is contribution order — the order the preset and the card asked for — and
  a panel that grew a row per world-info entry would describe a configuration
  the user never made. The bucket's token count stays the bucket's.
- **The entries get their own locators**, `prompt-member-promoted` and
  `prompt-member-deferred`, distinct from the row's `prompt-promoted` /
  `prompt-deferred`. The badges carry the same words, so a QA locator asking for
  a moved *entry* would otherwise match its bucket's badge.
- **The divergence mark is looked up by the entry's own id.** The host names
  members `<bucket>#<book>.<uid>` in both the itemization and
  `prompt.divergence`, so 「未变但重发」 lands on the entry that was re-sent
  rather than on its bucket — which is the whole reason the ids are minted per
  entry.

The sub-list has no `origin` line ("row *n* of *m*"), and that is the one place
this is thinner than §67's row badge. The position a reader would go to in order
to change an entry is inside a world book, not at an index in this list, and a
number pointing into the panel's own ordering would be a place that does not
exist. The entry's name is the handle instead.

## 70. Every cost figure now counts a card's own requests, and says how many of them there were

**Kind:** deliberate improvement, on a surface upstream does not have. §47 and
§60 record the per-turn and the profile-wide halves of showing what a provider
charged; this is the population those two were missing. The host side —
including the measurement and the storage argument — is
`notes/packages/iris-app-service/DEVIATIONS.md` §51.

**The fact being surfaced.** A card's script can ask for a generation of its own
(`TavernHelper.generate` / `generateRaw`). The provider bills it exactly like a
turn, on the same route, and it produces no reply — so nothing on the page could
show it, and until now nothing recorded it either. MVU fires one per turn for
its variable update, so on that card roughly half of what a reader had spent was
absent from every figure Iris printed.

**The ruling: inside the totals, with the share named.** A card's request is
spend on this account, so leaving it out would make a total disagree with the
bill. But a reader whose figure is twice the replies they can count needs to be
able to explain it, so the share is stated beside the figure rather than folded
in silently. Three surfaces, three amounts of room, three answers:

- **The usage page's total card** carries a line under the figure and its label:
  「其中卡脚本请求 N 次 · X token」. A line rather than an eighth capsule, because
  it is not another way of dividing the total — it is a statement *about* the
  figure immediately above it. Drawn only when the host reported a share;
  「其中卡脚本 0 次」 on every profile that runs no card scripts is a line a reader
  learns to skip, and the host's absent-versus-zero rule is what makes that
  distinction available here.
- **The chart** gets a fifth metric, 「卡脚本」, rather than splitting every line
  in two. That was the smaller change and the better reading: split by source,
  each model draws two lines a legend keyed on the model name cannot tell apart,
  the colour assignment grows a second axis, and a reader who wanted the plain
  total is looking at twice as many lines to find it. As a metric it reuses the
  whole machine — same axis, same series, same legend — and the switch already
  says which reading is on screen. It sits **last** in the switch because it is
  a subset of 「总量」 rather than a fifth way of cutting it.
- **The per-conversation subtotals** get a fifth column, 「卡脚本 N 次 · X tok」,
  blank — never `0` — on a conversation with no card generations. One blank cell in a column says "not
  this one"; a column of zeros says the feature failed to load. Its own column
  and not a second number inside the total's cell, because two figures in one
  cell read as a subtraction whose direction the reader has to guess.

**The composer's line keeps dsh's reading and moves the split to the card's note.**
That row is 「本对话累计计费」 — what this conversation has cost — and a card's
request is part of that, so the visible figure counts it. What the row cannot do
is carry a fourth group: it is one ellipsised line, and a fourth group is the
one that gets cut on a narrow composer. The `title` that used to state the split
separately is gone with DEVIATION 47's landing — the strip opens the same hover
card the per-turn chip does — and the share rides as a **note under that card's
rows** (the card's `note`, `usageScriptShareSentence`): 「其中卡脚本请求
N 次 · X tok」. The wording is 「其中」 in both dictionaries precisely because a
reader who added the two figures would double-count.

**The wrong implementation this is defended against**, in the render check and
in `token-format.test.ts`: a line that *subtracted* the card's share to keep
"what I generated" clean. It renders a smaller number, looks entirely
reasonable, and disagrees with the bill — so the checks assert that the visible
line carries the whole figure and the card's note the smaller one, on a fixture
where the two are different numbers. The note is closed inside the portaled
card on a server render, so `render-check` proves it reaches markup by
rendering the card itself, and pins that the share sentence appears nowhere on
the static page. The fake seeds the card share on **one** of its three
conversations for the same kind of reason: a fixture where every row had a
figure would leave the blank column unrendered, which is the half a reviewer
never sees.

## 71. The `z` global keeps answering after a card overwrites it with a one-spelled copy

**Kind:** deliberate improvement.

**Upstream.** A card script may assign anything to `globalThis.z`, and whatever
it assigns is thereafter what every bare `z` read answers — in upstream's frames
exactly as here. MagVarUpdate's helper `mvu_zod.js` is written against the
**namespace** spelling (`const r = z; … r.z.ZodObject …`), and the host page's
`z` upstream happens to be a namespace-shaped object, so the helper works against
whatever namespace it finds.

**The measured break.** 人贩子物语's Zod Schema script imports zod itself
through the bundle proxy —
`({ z: zodZ } = await import('https://cdn.jsdelivr.net/npm/zod/v4/+esm'))` — and
hangs the **named export** on `globalThis.z` before importing `mvu_zod.js`.
Measured on both the jsDelivr rollup build and the npm package it is
`Object.freeze({__proto__:null, …})` with `ZodObject`, `looseObject`, `object`,
`prettifyError` on it and **no `.z`** — the self-reference is a named export of
the namespace, not a member of the export. So the helper's first dereference
read `.z` of a copy that does not have it, and the card reported
`Cannot read properties of undefined (reading 'ZodObject')` at
`mvu_zod.js:1:647` before its variable schema registered. The overwrite is the
card's own doing and fails the same way in an upstream frame; upstream never
meets it because no upstream card has shipped this wiring yet.

**The fix.** `preset-entry.ts` publishes `z` through `zod-global.ts` as an
**accessor**: the setter stores whatever a card assigns, and the getter answers
it as stored — except when the stored value is zod-shaped and missing `.z`, in
which case reads answer through a prototype-layered view owning exactly one
member, `z`. That view *is* the namespace shape the seed was chosen for,
reconstructed over the card's own copy, so `instanceof r.z.ZodObject` sees the
very class the card's schemas were built from and the prefault-compat question
never arises across copies.

**The cost.** One accessor where a data property was; every bare `z` read in the
realm passes a two-member shape test. The shape test is deliberately narrow — a
full namespace, a future zod whose export self-references, and every non-zod
value read back identically — so the defense cannot silently rewrite a value it
does not recognise. **What would overturn it:** a zod that puts `.z` on the
named export makes the view dead code; the premise is pinned by
`zod-global.test.ts`'s first assertion, which fails — and retires the layer —
the day upstream's shape changes.

**The same round closed the document stand-in's event half** (`virtual-document.ts`),
recorded here because it is the mirror image: not a divergence but a
**compatibility gap closed**. 人贩子物语's 黑市手机 walks `window.parent`
outwards until a document reads and holds it as `hostDocument`; here that walk
lands on the virtual document, which answered `addEventListener` with
`undefined` — `hostDocument.addEventListener is not a function`, one line into
its startup. The stand-in now carries `addEventListener`/`removeEventListener`/
`dispatchEvent`, delegating to the **frame's own document** — the only page a
card's capture-phase delegation can observe, and the only bus that produces real
DOM events with a `target` to walk. Upstream's `hostDocument` is the page's real
document; this is the same semantics over the page a card actually has.

**The walk's window half followed** (`frame.ts`): the same card holds the proxy
as `hostWindow` and its next measured failure was `hostWindow.setTimeout is not
a function`. Upstream's `hostWindow` is a real same-origin window whose
scheduler is the scheduler; the proxy now answers the standard set —
`setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`,
`requestAnimationFrame`, `cancelAnimationFrame` — delegating to the **frame's
own realm**, because that is the only realm a timer here can fire in, which
makes a scheduler read through the parent and one read bare the same functions
with mutually cancellable handles. Injected through `FrameEnv` like the event
target; absent, the six names follow the unpublished-name policy.

## 72. The third regex tier gets a section of its own, and it is the one that has to explain itself

**Kind:** new surface for a compatibility feature landing — host `DEVIATIONS.md`
§53 is the mechanism, §47 the measurement.

**What the drawer showed before.** Two of SillyTavern's three regex tiers: the
profile's global list (`RegexPanel`) and the card's own (`ScopedRegexPanel`).
The preset's tier — the active preset file's own `extensions.regex_scripts`,
which upstream runs *between* those two — had no surface at all, and on the one
preset measured for §47 that is **40 rules, 18 of them live: 6 rewriting the
request and 12 rewriting the page**.

**`PresetRegexPanel`, and where it sits.** Between `RegexPanel` and
`ScopedRegexPanel` — **not** under the preset section, which is its subject.
The three regex sections are read as a sequence, the drawer already says so in
its own comment ("under the profile's, because that is the order they run in"),
and a reader comparing the lists is comparing along the axis that decides which
rewrite wins: global → preset → card is upstream's `SCRIPT_TYPES` iteration
order. Putting the section next to its subject would have put it out of the
order it runs in, which is the only ordering a reader can act on.

**The section that renders while running nothing.** This is the one panel in the
regex family whose *ordinary* state is refused: the tier arrives off (§53), so
the section's first job is to tell a reader that the preset they imported
carries rules at all. It therefore lists them whether or not they run —
upstream's own panel does the same, `getRegexScripts` defaulting to
`allowedOnly: false` — and the summary says `N rules, not enabled` rather than
falling silent. The refusal note names the cost *and* names upstream's identical
requirement, because a default that looks like breakage gets clicked through:
「SillyTavern 也是同样的要求：预设名进了 `preset_allowed_regex` 白名单，它自带的
正则才会跑」.

**Three row states, and the third is new to this family.** `ScopedRegexPanel`
has two — off by the card, and no `id` so it cannot be switched. This panel has
a third, because the whole tier can be refused while an individual rule is on:
that row is badged 「等上面那个开关」 rather than shown as running. A reader can
set the rules up before turning the tier on, which is why the per-rule
checkboxes stay live while the tier is refused.

**The unnamed-preset branch hides the control rather than disabling it.** When
the active preset has no library name — a host still assembling with its
configured file, which upstream cannot represent — the allow-list has nothing to
be keyed by, so the permission block is not rendered at all and the note says
what to do instead ("save it to the preset library first"). A disabled switch
would invite the reading that the feature is broken here; the sentence is the
control.

**One reload trigger, and it is the active preset.** The panel's effect is keyed
on `state.activePreset`, not on a panel-local memory of it, so switching presets
in the section two rows up re-reads this one — the tier, the permission and the
name all belong to the preset. There is no `presetRegexFor` field beside the
list the way `scopedRegexFor` sits beside the scoped one: the subject is a
single global fact rather than one card among many, and the answer carries the
name it was about (`presetRegexName`), which the panel *prints* rather than
guards.

**`presetRegexState` is one function on purpose.** All three calls — the list
and the two writes — answer with the same envelope, and three hand-written
`set({ … })` blocks are three places for the newest field (`malformed`) to be
forgotten in two of them.

**A green teeth check deleted a line.** The running count was first written
`allowed ? scripts.filter(…).length : 0`, and breaking it on purpose changed no
render: the refused summary takes no running count, so the guard was
unobservable. It is gone, with the reason in the comment where it stood — the
"on, but the tier is off" state is carried by the row badge, where it *is*
observable.

**Pinned by `check:render`** in both states: the refused render (the preset's
name, its rules, `3 rules, not enabled`, the `preset_allowed_regex` sentence,
the skipped-rows line, the off-by-preset and waiting-on-the-switch badges) and
the allowed one (`2 of 3 running`, and no waiting badge). The fake answers the
three `regex.*Preset*` methods from memory while every `preset.*` method stays
refused, which is the same line the fake already drew: what it cannot honestly
model is a host-side *file* — a preset library, a script body, a snapshot —
while which preset is active and what rules it ships are data. Its seed carries
one rule of each shape the measured preset is made of, the empty-pattern
separator included, so the skipped-rows line has something real to render
against.

## 74. Every cost figure also counts Iris's own compaction summaries, and says how many

**Kind:** deliberate improvement, on a surface upstream does not have. §70 is
the same fix for the *other* population that is not a turn; this is the one §70
left out, and the host side — record, storage, and the measured before-and-after
— is `notes/packages/iris-app-service/DEVIATIONS.md` §55.

**The fact being surfaced.** When a conversation gets too big, Iris asks the
model to fold its older history into a summary (`/compact`, or the automatic
trigger at 80% of the budget). That request is billed exactly like a turn, on
the same route, and it produces no reply — so nothing on the page could show it,
and until §55 nothing recorded it either. One request per compaction, so it is a
handful over a conversation's life rather than §70's one-per-turn; what makes it
worth a figure is that it is **Iris's own request**. It appears on a profile that
has never run a card script, and before it was recorded a compacted profile's
usage page was short by exactly one summary per compaction with nothing naming
the gap.

**The ruling is §70's, applied to a sibling and not to a merged bucket.** Both
shares are inside the enclosing totals — a compaction is spend on this account,
so leaving it out would make a total disagree with the bill — and each is stated
beside the figure it is part of rather than folded in silently. What is new here
is the refusal to merge: `UsageTotals.compaction` sits beside
`UsageTotals.script` rather than the two becoming one "not a turn" figure,
because a card's spend is the card author's doing and a compaction's is Iris's
own policy. A reader who wants less of the first uninstalls or edits a card; a
reader who wants less of the second changes a threshold. One figure covering
both would answer neither question.

Three surfaces, the same three amounts of room §70 found, and one shape decision
each:

- **The usage page's total card** — the second sentence in the note under the
  figure. One note, two sentences, not two notes: the note is a hairline block
  under the total and a second one would draw a second rule across the card for
  a fact of the same rank. Inside it, each sentence is its own `<span>` with its
  own hover hint, because the two are explained differently and a `title`
  belongs to one element. `.iris-usage__hero-note` became a flex column to hold
  them — **which is also why there is no separator string**: inline they would
  run together, and a punctuation joiner would have to be translated and would
  sit between two clauses that already use `·` inside themselves.
- **The per-conversation subtotal list** — the same cell as the card figure,
  stacked under it, right-aligned against the total column. Not a sixth grid
  column: a column blank on every row but the compacted ones would take width
  from the title on every row to say nothing, and the two facts answer the same
  question — how much of this row was not a reply. Blank, never `0`, when a
  conversation has neither.
- **The composer's session strip** — a second paragraph in the hover card's
  notes. `UsagePopover`'s `note?: string` became `notes?: readonly string[]`,
  one `<p>` each, for the same reason the panel refuses a joiner: the two shares
  are **independently absent**, so a single string would need a separator
  spelled per language.

**Independently absent is the load-bearing part**, and it is what
`token-format.test.ts` checks in all four combinations. A profile can run card
scripts and never compact, or compact and run no cards. An implementation that
drew the compaction sentence only when the card sentence was there would pass a
check that only ever looked at "both" and "neither" — which is the shape the
first draft of the render check had, and why the seed now puts both shares on
one conversation with **different counts** (two card requests against one
summary) so a merged reading reports a `3` no correct reading produces.

**No sixth chart metric, and that is a decision rather than an omission.** §70
added `usageMetricScript` as a fifth metric because the card share has a shape
to read over time — on MVU it tracks the turn count. A compaction share does
not: one request per compaction draws a line flat at zero with an occasional
spike, and the figure a reader actually wants ("how much of this total was the
host folding my history") is the sentence on the header card, which reads
without a mode switch. So the switch keeps five options, and the render check
pins the option **count** rather than the absence of a caption — a sixth
metric arriving for any reason should come back through this paragraph.
`usage-stats.ts`'s `compactionTokens` carries the same note at the code.

**What would overturn it.** A profile where compaction fires often enough for
its spend to have a distribution — then the sixth metric earns its place, and
the per-conversation cell probably wants its own column after all. Or a reader
who reads the two stacked sentences as an addition to the total rather than a
breakdown of it, which is the failure the 「其中」/"of which" wording exists to
prevent and the one thing about this shape that copy alone is holding up.

## 75. A failed connection test shows the host's reason under the sentence

**Kind:** fix (companion to host §57).

**Measured.** 2026-09-09, the operator's report: the connection form said
「无法连接到端点。请检查地址与网络。」 and nothing else, one millisecond after the
test, for a key and endpoint that worked everywhere else. The host's verdict carried
a `message` — `could not reach …/models: Failed to parse URL …` — and
`testErrorText` mapped the code to its sentence and dropped the message on the
floor. Its own docblock promised "falling back to the host's own words"; the code
never did.

**Now.** `testErrorDetail` returns the host's message for every code except the two
whose message is host boilerplate that adds nothing to the sentence (`missing-key`,
`no-endpoint`), and the verdict paragraph renders it as a quieter second line
(`.iris-conn__test-detail`, smaller, `overflow-wrap: anywhere` because it carries a
URL). The protocol's contract that the message never carries a credential is what
makes showing it unconditionally safe; host §57 pins that contract for the new
`bad-key` code with a test that the message holds neither the key's body nor the
offending character. Two new sentences, `testErrBadUrl` and `testErrBadKey`, name
the two faults the host now distinguishes from a network failure; both point at the
field, not the network. The detail line is deliberately **not translated**: it is
the address tried, the status, the socket code — the tokens a person pastes into a
search or a bug report.

**What would overturn it.** A host message that carries a credential (the contract
is the host's, the exposure would be here); a code whose message is boilerplate
being shown twice.

## 76. A card's `parent.postMessage` is answered, and its resize request is honoured by measurement

**Kind:** fix, plus one documented improvement over the single upstream consumer.

**Measured.** 2026-09-09 on the live host (8788), with the preset-embedded regex
tier switched on (PR #43, `dev/preset-regex-tier`, unmerged), every message
reported:

> an uncaught error before the card body message arrived: TypeError:
> `window.parent.postMessage` is not a function at about:srcdoc:922:31 — this
> frame carries the card's markup, which runs while the document parses, so this
> is most likely that markup rather than the frame's own setup

The attribution was right. The sender is
`apps/iris/data/default-user/presets/[主预设] V19.5 狐神抚 · 毓忻.json`,
`extensions.regex_scripts[37]` 【行动选项美化 · 狐策】 (`markdownOnly: true`,
`replaceString` 41,831 characters), which ships:

```js
function requestParentResize() {
  if (window.parent && window.parent !== window) {
    requestAnimationFrame(() => {
      window.parent.postMessage({ type: 'resizeIframe', height: document.body.scrollHeight }, '*')
    })
  }
}
```

`postMessage` was not on the virtual parent's bridged list, so the read took the
unpublished-name path, answered `undefined`, and the call threw. Because the
sender is markup rather than a script, the throw took the rest of the interface
with it.

### Who calls it

Both corpora, both columns (a card's *scripts* and the *interface text* it ships
as markup), deduplicated by content hash, read through `decodeCardPng` and
`extractScripts`:

| message | sites | owners | distinct bodies | column |
| --- | --- | --- | --- | --- |
| `{type:'resizeIframe', height}` | 15 | 3 preset files (2 presets: V19.5 狐神抚, Kemini 5.17) | 5 | interface text |
| `'toggle-forum-overlay'` — a bare **string** | 2 | 1 card (不要被神隐挑战-V1.5, script 论坛覆盖层) | 1 | script |
| `{event:'__devtools-kit…'}` | 1 | 1 cached script bundle (Vue devtools) | 1 | script |

`iframeResize` — the spelling the one upstream consumer matches — appears **zero**
times in either corpus. `parent.addEventListener('message', …)` also appears zero
times: no card listens on the parent bus, while eight sites listen on their *own*
window for messages from their *own* children, a direction `nested-frame.ts`
already serves.

### Who listens upstream

- **SillyTavern core listens for nothing.** No `window`/`document` `message`
  listener in `public/script.js` or `public/scripts/**`; the four hits are Worker
  and AudioWorklet ports.
- **TavernHelper (JS-Slash-Runner 4.9.1) never receives a height.**
  `src/iframe/adjust_iframe_height.js:21` writes `frameElement.style.height`
  directly, same-origin, from inside the frame. Iris cannot — the shell is a
  different origin — which is why the height travels as a protocol message and
  `reportHeight`/`heightSignal` exist at all.
- **One listener in the whole page consumes an upward message**:
  ST-Prompt-Template `src/utils/iframe.ts:108-120` (confirmed in the shipped
  `dist/index.js`), matching `event.data.type === 'iframeResize'` and then
  `document.getElementById(event.data.id).style.height = Math.ceil(height)`.

So the message the corpus actually sends matches no upstream listener on either
count: wrong spelling, and no `id`. **Upstream's behaviour for every row of the
table above is silent discard** — no `else`, no warning, no counter, in any of
the three listeners.

**Now.** `parent.postMessage(message, targetOrigin?, transfer?)` is a bridged,
read-only member, injected through `FrameEnv.postToParent` like the event target
and the schedulers, so `frame.ts` still knows nothing about the realm it installs
into; absent, the name follows the unpublished-name policy (`undefined`, reported
once). The sink is `sandbox/parent-messages.ts`, built from the **fetched member
table** rather than inlined, and it:

- answers a height request — **either** spelling — by asking this frame's own
  height reporter for a fresh measurement (`reportHeight` now returns its
  rAF-coalesced schedule);
- drops everything else, **counted and named once per shape**, then again at each
  ten-fold, so a card posting in a loop bounds its own noise;
- never throws, for any value a card can pass;
- never touches the shell↔frame protocol channel. That channel carries the run
  token and can run code; `tools/check-bootstrap.mjs` still pins that the frame
  reads `.postMessage` exactly once, at boot, before this bridge is published.

**Why measurement rather than the card's number.** The card's `height` is
`document.body.scrollHeight` of *this* document — the same quantity
`reportHeight` reads, in the same realm — so re-measuring costs nothing in
fidelity and keeps the reported height inside `heightSignal`'s echo and `sizing`
guards, whose absence was measured as an endless flicker on four real cards
(`height-loop.test.ts`). A forwarded number would bypass them. The claimed height
is put in the note so a reader can compare it against the `height sources` line
beside it — which is the reading that would falsify this choice.

### Three deliberate divergences from the one upstream consumer

1. **`id` is ignored; a request is always about the sending frame.** Upstream
   resolves `getElementById(event.data.id)` against the whole host page with no
   `event.source` and no origin check (the origin check is present as a comment),
   so any frame can resize any element that has an id — and upstream's own stable
   id from `evaluate.ts:151` is overwritten by a random one at `iframe.ts:16`.
   Reproducing that would reproduce a hole. Costless here: no measured sender
   sends an `id`.
2. **Both spellings are honoured.** `iframeResize` is what upstream matches;
   `resizeIframe` is what all 15 measured sites send. Honouring one would either
   serve nobody here or diverge from the only consumer that exists.
3. **`targetOrigin` is accepted and ignored, and a non-cloneable message is
   accepted rather than refused.** All 15 sites pass `'*'`; a real `postMessage`
   would throw `DataCloneError` on a function or a symbol. Being more permissive
   than the platform cannot break a card the platform would have refused, and
   there is no origin here that would mean what the DOM's comparison means.

**Cost.** The bootstrap grew 311 bytes (52,177 → 52,488), which is 264 past the
47 bytes of headroom 52 KiB had left, so `FRAME_OVERHEAD_BYTES` moves to 53 KiB.
`FRAME_COUNT_LIMIT` stays at **19** — 19 against a half-degradation point of 19.3
— the first increment since 41 KiB that costs no frame. The policy half is
unavoidably inline (which name is bridged, that it is read-only, where the
argument goes); everything that decides what a message *means* went into the
member table, the answer the popup API gave the last time this line was crossed.

**What would overturn it.** A card that sends an `id` and expects a sibling frame
to move (then the choice in divergence 1 is between fidelity and the hole, and it
should be argued rather than inherited); a measured card whose claimed height is
one this frame's own rulers cannot read, which the note beside the `height
sources` line is there to reveal; an upstream release in which SillyTavern core
or TavernHelper starts consuming an upward message, which would make the
drop-and-count a divergence rather than parity.

---

## 77. The connection card is a provider list with three verbs, not a form — and the typed route is gone

**Kind:** deliberate divergence from SillyTavern, on the user's ruling. Entry 49's
two compatibility fixes (the key typed once, the model picked from a list) are kept
whole; what changes is the shape they sit in.

**The ruling** (user, 2026-09-09, verbatim): 「现在连接这个部分做的就很不好，这个逻辑
很混乱呀，这个部分不必效仿 ST 做，ST 那个就做的很抽象了，我们可以按照 CC Switch 的
逻辑：我们保存供应商是一回事，从列表中用哪个连接是一回事；连接折叠卡中就不需要有
提供方/端点地址/模型这三个选项常驻了；这个连接就是 添加供应商、选择供应商（对现有
供应商的编辑或删除）、测试连接 三个部分；然后可以添加些展示信息，但是修改都得走对
当前供应商的修改。」

**What was there.** One resident form — provider preset, base URL, key, model — with
a list under it and five buttons in a row (Test, Save, Cancel, plus "save the current
settings as a connection" and its naming input at the bottom). Two things about the
same provider were on screen at once and neither said which was in force: the form
held whatever was last typed or last loaded for editing, the list held what was
saved, and "the connection" meant either depending on which button you pressed. On
top of that the drawer carried a **third** place to set the route: a 「路由」 card
with `provider` and `model` as free-text fields on the global settings layer.

**Upstream is the shape being left behind, and that is the point.** SillyTavern's
connection page *is* a form: `#openai_form`'s fields are the connection, the profile
list (`connection-manager`) is a saver/loader bolted beside it, and pressing Connect
acts on the fields. That is why a profile there can be named `deepseek deepseek-chat`
and point at Gemini — the name is a snapshot of the fields taken once. CC Switch's
shape is the other one: a row per provider, one marked current, `编辑/删除/测试` per
row, and "use" as its own act. This entry adopts the second.

**Iris, now.** Three blocks in the card body and nothing else (`data-block`
`providers` / `add` / `test`, counted by the render check):

- **The provider list.** The host's own connection is the fixed first row — read-only,
  testable, and adoptable, never editable or deletable, because it lives in the
  environment the process was launched with. Every saved provider follows, each with
  its label (or the derived summary when unnamed), the derived summary regardless
  (entry 49's rule: a label can go stale, the derived half cannot), and a meta line
  of endpoint origin, model, key state, bound preset, model window and probe age.
  Exactly one row is marked 「当前」 — the provider in use, or the host row when none
  is. Row verbs: **使用** (global), **编辑**, **测试**, **删除**.
- **添加供应商.** One button, opening the same editor an 编辑 opens, seeded
  differently. Beside it the sentence the whole rearrangement exists for
  (`connSaveVsUse`): saving writes the provider into this host's list, using decides
  which one generates.
- **测试连接.** One verdict area for the whole card. A row's Test reports into it with
  the row's name in the sentence (`connTestedRow`), because two verdicts on screen are
  two answers to one question. Entry 75's judgement sentence and untranslated host
  detail line are unchanged.

**No field is resident.** The editor is a `Modal` (`iris-conn-dialog`, 440px — §19's
finding that the primitive's card is 380px and clips, so the width goes on the card),
mounted only while a provider is being edited. So "the panel body carries no input"
is structural rather than a habit: a closed `Modal` renders `null`. `render-check`
pins zero `<input>`, `<select>` and `<textarea>` in the card body, exactly three
blocks by name, exactly one current row, and that the marked row is the provider in
use; each of those was verified to fail on a mutation of its own (eleven mutations,
eleven distinct red assertions).

**The 「路由」 card is deleted**, and with it the only route in the product a person
could type. Both values are still fully settable — a provider's editor writes
`provider` and `model` together with the endpoint and credential they belong to, and
`settings.set` still carries them for anything that asks — so what is gone is the
loose field, not the capability. `CardId` loses `'route'`, and a `route: true` left in
someone's `localStorage` falls out of `loadCardState`'s allowlist, which is what that
allowlist is for.

**Using a provider is global, always.** `activateConnection` no longer sends the open
chat's `chatId`. Scoped to whichever conversation happened to be open, one list meant
two different things depending on where the reader was standing, and there was no way
at all to move the global layer while a conversation was open. The per-conversation
switch has had its own control and its own method since entry 50: the model capsule
under the composer, through `setChatModel`. The protocol keeps `connection.activate`'s
optional `chatId`; nothing in the browser asks for it.

**Editing the provider in use re-applies it.** Measured in
`packages/iris-app-service/src/service.ts` (2026-09-09): `connection.save` writes the
profile file and does nothing else — it does not call `#installConnectionFor` and does
not write the settings layer that names the route; only `connection.activate` does
either. So changing the endpoint or model of the row in force would have sat in the
file while generation kept going to the old address, with no symptom but a reply from
a provider the panel says is not selected. The panel therefore re-uses that provider
after such a save, which is the host's own path for it — asked for from here rather
than added to a handler another branch is editing.

**What it costs.**

- **「宿主环境」 had no 「使用」 button**, which the dispatch asked for. **Closed the
  same day by entry 78 — read that instead of this paragraph.** What stood here was
  the diagnosis: the gap was host-side in two parts, `#hostConnection()` reading
  `provider` and `model` from the **global settings layer** (`service.ts`) on a
  composition that passes no explicit `hostConnection`, so after any global activation
  that row described the activated profile's route rather than the launch
  configuration; and `ConnectionStore` having `markActive(id)` with no clearing path,
  so nothing could put `activeId` back to absent. Rather than ship a button that would
  re-apply the current profile's own values and call it "back to the host", the row
  said why (`connHostUseGap`) and offered the act that did work: **存为供应商**. Host
  §60 supplies both halves — a launch snapshot and `clearActive()` — and entry 78 puts
  the verb on the row; the sentence is deleted, and 存为供应商 keeps the narrower job
  it always had (an *editable* copy).
- **No confirmation on delete.** A row's 删除 fires immediately, as it did before.
  The list is cheap to rebuild and a `RiskConfirmation` on every provider row would be
  a dialog per row; if this bites, that is the change to make.
- **A new provider cannot capture the drawer's current sampling.** The deleted
  「把当前设置存为一个连接」 button was the only path for that. Sampling a provider
  already carries survives every edit (the editor sends it back untouched, because an
  absent field clears on a replacement), and sampling itself stays the sampling card's
  business — which is where a reader looks for it. CC Switch has no sampling in a
  provider row either.
- **One verdict area, so a row's Test is reported below the list rather than on the
  row.** A reader who tests the fourth row reads the answer at the bottom of the card.
  The row's name in the sentence is what makes that legible; per-row verdicts would be
  four places for the same kind of sentence to differ.

**What would overturn it.** A host that records the route it was launched with (which
would make 「使用」 on the host row honest and this entry's first cost obsolete —
**it did, hours later: host §60, entry 78**); a user who wants the endpoint field back
on the card body, which would mean the ruling above has been revised.

**Postscript, 2026-09-10 (§79).** The three-block shape, the two verbs and the
editor-in-a-`Modal` all stand. What is gone is the **fixed first row**: the
environment is no longer a connection anything generates through, so the list
holds saved providers and nothing else, and the paragraph above about 「宿主环境」
having no 「使用」 button is now history twice over. The 「no confirmation on
delete」 cost is unchanged and has grown slightly sharper — deleting the row in
use now means nothing generates until another is chosen, which the note after a
delete says.

## 78. 「宿主环境」 is a selectable row, not an explained exception

**Kind: completion of entry 77**, on the host work that entry named as the reason it
could not be done then (host §60, same day).

**What entry 77 shipped and why.** Every row in the provider list carried 使用 except
the first one, which carried a sentence instead: `connHostUseGap`, 「一旦开始使用某个
供应商，这一行就无法再被选回：宿主没有留下启动时那条路由的记录」. That was an honest
report of a host limitation, and the limitation was real — the row's `provider` and
`model` came from the global settings layer, so a 使用 built on them would have
re-applied the profile in force and called it "back to the host", and `activeId` had
no path back to absent either way.

**What changed.** Host §60 snapshots the launch route and model at construction and
adds `ConnectionStore.clearActive()`, exposed as `connection.deactivate` (global, no
parameters). So:

- The host row's actions gain **使用**, first in the row and offered on exactly the
  condition every provider row uses: shown while this row is *not* current, replaced
  by the 「当前」 badge when it is. A press that could only be a no-op is not offered.
- It calls `deactivateConnection()` on the store, which is `activateConnection`'s
  shape with no id: `connection.deactivate` with `{}`, then
  `{ settings, activeConnectionId: result.activeId, hostConnection: result.host }`
  from the answer — `activeId` read back rather than assumed, because the host is what
  decides no profile is applied. The list's badge and the collapsed head
  (`hostDefaultTitle · host.model`) follow from that one write.
- **The composer capsule follows the same way an activation makes it follow**: with a
  conversation open, the action re-reads `settings.get({ chatId })` afterwards, because
  the global layer just moved under that conversation and a chat overriding nothing is
  now generating with the launch model. A chat that *does* override the model keeps its
  override — using a provider is global (entry 77), and this is that verb.
- `connHostUseGap` is **deleted** from both dictionaries and from `STRINGS.md`. A
  sentence explaining a gap that has been filled is worse than no sentence: it is
  read as a live limitation. `hostDefaultNote` is reworded in the same direction —
  from 「在没有选中任何供应商时，回复由它生成」 (a description of an absence) to
  「这是宿主启动时配置的路由与模型。点「使用」即可把全局路由放回它」 (the row's own
  content, and the act available on it).
- **存为供应商 stays**, with the narrower job it always had. It used to double as the
  only way back to the host's connection; now it is what it says — an *editable* copy,
  whose endpoint, model or key can then differ from the one the process was launched
  with. Its docblock no longer claims the other role.

**Pinned.** `render-check.tsx` renders the card in both states: with the seeded
profile in use the host row carries `aria-label="Use Host environment"` beside its
Test, and with nothing applied it carries the 「当前」 badge, no 使用, and is the single
`aria-current="true"` row. `connection-key-field.test.ts` pins the source decisions a
render cannot see — no `chatId` reaches `connection.deactivate` (the same absence
already pinned for `connection.activate`), the button is guarded by `activeId ===
undefined ? null : …` rather than by something a fixture happens to make false, the
panel no longer calls `t('connHostUseGap')`, and the key is gone from the dictionary
rather than merely unused (`i18n.test.ts` checks used → dictionary only, so an unused
key is never reported).

**What it costs.**

- **The capsule's 「回到连接的模型」 row can now name the launch model while the
  global layer holds a different one.** `modelMenu` reads `connectionModel` as
  `active?.model ?? host?.model`, and with no profile active that used to *be* the
  global layer's model. It is now the launch model, and the two disagree in one narrow
  state: the active profile was **deleted** (host §59 deliberately leaves its `model`
  in the layer as a value), so clearing a chat's own override returns to that leftover
  rather than to the launch model the footer names. Not changed here, for two reasons —
  the fix belongs in `modelMenu`, which would need the global layer's model passed in
  beside the chat's merged one, and the state now has an obvious way out that it did
  not have before: press 使用 on 「宿主环境」. Reported rather than filed silently.
- **No transient sentence after pressing 使用 on the host row**, and none after
  pressing it on a provider row either. The panel's `note` states cover saving,
  deleting and adopting; using a row is reported by the badge moving, which is the
  same feedback every other row gets.

**What would overturn it.** A host whose 「宿主环境」 row is expected to describe what
is generating rather than what it was launched with (host §60 records that reading and
why it was rejected); a user who reads 使用 on a read-only row as an offer to edit it,
which would mean the 「只读」 badge is doing less work than it looks.

**Postscript, 2026-09-10 — overturned, one day old (§79).** The user retired the
row this entry completed: 「宿主环境这个功能废弃了，以后都从在 Iris 中自己添加供应商
来调用模型」. So 使用 on it, the 「只读」 badge, 存为供应商 and the row itself are
gone, along with the launch snapshot's browser-side readers. This entry's own
first cost — the capsule's 「回到连接的模型」 row naming the launch model while the
global layer holds another — is closed by the same change from the other end:
the capsule has one model source now, the provider in use, and names nothing
when none is.

## 79. The provider list is the only way to a model, and a model can be typed

**Kind: deliberate divergence from SillyTavern and from Iris's own two previous
entries, on the user's ruling.** Entries 77 and 78 stand except for the row this
one deletes; entry 49's two compatibility fixes (the key typed once, the model
picked from a list) are both kept, and the second is *widened*.

**The ruling** (user, 2026-09-10, verbatim): 「宿主环境这个功能废弃了，以后都从在
Iris 中自己添加供应商来调用模型；然后供应商编辑这里模型要支持添加自定义名称的模型，
以防止用户无法使用到还在内测的模型。」 Two changes in one sentence, and they pull
the same way: the card is the one place a route comes from, and nothing in it may
be a dead end.

### A. The environment is not a row

**What was there.** The list's fixed first row: 「宿主环境」, read-only, with the
launch route and model as its summary, the environment variable its key came
from on its meta line, 测试, 存为供应商, and — for one day, entry 78 — 使用.
Below it, `hostDefaultNote` explaining what it was.

**What is there now.** Saved providers, and nothing else. Every row is a
profile, so every row carries all four verbs; the render check counts the rows
against the store and counts 编辑 and 删除 against the rows, because the host row
was the one exception and a count is what notices a new one.

- **The empty state is the change with the most weight.** It used to be a note
  under a working connection (「还没有保存任何供应商。」); it is now the one thing
  between a fresh install and a reply, because the host refuses to generate with
  no provider in use (host §61). So it says what to do — 「还没有供应商——添加一个
  来调用模型。」 — and carries the button that does it, inside the branch rather
  than only in the add block below.
- **The collapsed head reads 「未选择供应商」** whenever nothing is in use, whether
  or not the list has rows. It used to read 「宿主环境 · <model>」 there, which was
  true while the environment was a route and is now the one sentence that would
  send a reader away from the thing they have to do.
- **The composer capsule loses its second source.** `modelMenu` took a `host`
  argument, read when no profile was active — which, on a host configured from
  its environment, was *the normal state*. That fall back existed for a reported
  bug (user, 2026-09-07: 「没有活动连接，因此没有可选的模型列表」 shown on a host
  that was plainly connected). The ruling answers that report from the other
  end: with nothing in use the host really is connected to nothing, so
  `no-connection` is now a correct report — and its sentence was rewritten to
  say where to go (「到 设置 → 连接 添加一个，然后点『使用』」) rather than only
  what is absent. `ModelMenuSource` loses `'host'`, `hostKeyEnv` goes, and the
  menu heading loses two of its three forms.
- **A refusal has copy of its own.** The new `no-provider` code is one of the
  three whose sentence is written in the browser rather than taken from the
  host: the host's detail is about routes, and what a reader needs is which card
  to open and which verb to press, in their own language. It arrives two ways
  and prints the same sentence both times — as `stream.error`'s `code` for a
  turn (`store.ts`), and as an `RpcError` code for a card's own generation
  (`errors.ts`'s `COPY`).
- **What still says 「宿主」, and why.** Three sentences: a provider with no
  endpoint of its own 「走宿主配置的端点」 (`hostDefaultEndpointRidden`), and the
  two that say a blank key at the host's own origin is supplied by the
  environment (`connKeyFromHost`, `apiKeyFromHost*`). Host §58's ladder still
  lends that credential to a route, so removing those would make a profile that
  generates fine read as 「无密钥」. The environment is the source of a *key*, not
  of a route — and the whole point of this entry is that those are different
  claims.

### B. 「自定义…」: the list is a shortcut, never a gate

Entry 49 made the model **picked** rather than typed, because a mistyped model is
a request that fails at generation time with a provider's own error, one screen
away from the field that caused it. That reasoning is intact. What it missed is
that `/models` is what an endpoint *chooses to advertise*, and a model in closed
testing is exactly the one it does not — measured:
`deepseek-v4.1-flash-expires-on-0910` generates and is not listed.

The dropdown therefore ends in a fixed 「自定义…」 option, and choosing it gives
the same text field a never-probed provider gets, focused, with the sentence
that says why it exists and a way back to the list. Four decisions inside that:

- **The option's value is a sentinel** (`CUSTOM_MODEL`, spelled with a control
  character no endpoint could advertise) and it never reaches `form.model`:
  choosing it switches the control and leaves the value where it was. An empty
  value would have been indistinguishable from a form that had lost its model.
- **The current value is carried into the field rather than blanked.** Most
  custom ids are a variant of a listed one, and blanking would disable 保存 the
  instant the reader asked to type.
- **Focus only in that branch.** Autofocusing the never-probed case would take
  the caret off the endpoint field every time the dialog opens for a new
  provider.
- **The off-list path is untouched.** A stored model the list does not carry
  still keeps a row of its own and is still marked (`modelCustomCurrent`,
  `modelOffListNote`, `modelNotInList`) — that path *preserves* such a name, and
  this one *enters* it. Both are needed, which is why neither replaced the other.

### What it costs

- **The 「自定义…」 option cannot be pinned on a render.** The editor is a `Modal`
  mounted only while editing, and `render-check` cannot open it (React's server
  renderer has no click and no portal), so the option, the sentinel's handling,
  the focus and the way back are pinned as **source** assertions in
  `connection-key-field.test.ts` — the same concession that file already makes
  for the key field, and for the same stated reason. The empty state and the
  collapsed head *are* pinned on a real render, because both are in the panel
  body.
- **A host started with no `IRIS_BASE_URL` now shows an empty list and generates
  nothing** until the user adds a provider. Host §61 argues why the composition's
  default endpoint is not copied in; the browser's part is that the empty state
  has to be a usable instruction rather than a report, which is what it was
  rewritten to be.
- **Twelve dictionary keys deleted**, listed in `STRINGS.md` with the reason
  each one existed. `i18n.test.ts` checks used → dictionary only, so an unused
  key is never reported; the twelve are held by a loop in
  `connection-key-field.test.ts` asserting `Object.hasOwn(en, key) === false`,
  and the count is asserted against the number `STRINGS.md` states so the two
  cannot drift apart quietly.
- **`.iris-conn--host` and `.iris-conn__badge--quiet` are deleted from
  `panels.css`**, and the empty state took the first slot with a rule of its
  own. A style with no element is a style nobody can see go wrong.

**Pinned.** `render-check.tsx`: the environment row's class, its name, its adopt
button and the 「只读」 word are all absent from a real render; one row per saved
provider with 编辑 and 删除 on every one; exactly one 当前 row with providers and
**zero** with none; the empty state's sentence, its own block and its button
inside that block; the collapsed head reading 「未选择供应商」 with nothing in use
and naming no environment. `connection-key-field.test.ts`: the 「自定义…」 option
after the endpoint's own list, the sentinel switching the control rather than
being stored, the focus condition, the way back, the empty state's own button,
and the three-way absence (panel calls, store action, dictionary keys).
`model-menu.test.ts`: nothing in use offers no list, names no source, probes
nothing and names no default — and offers no *other* profile's models either,
which is the failure removing a fall back can produce by accident.
`store.test.ts`: a `no-provider` frame prints the dictionary's sentence and not
the host's.

Sixteen mutations across both halves, sixteen distinct reds (host §61 lists the
two worth reading).

**What would overturn it.** A user asking for the environment back as a row
(entry 78 is the design to restore, and host §60 the mechanism); a reader who
takes 「自定义…」 for a model named "custom" — the sentence under the field is what
prevents that, and its wording is the thing to test if anyone reports it; a
provider list that stops being reachable while nothing generates, which would
make the refusal a dead end rather than a redirection.

## 80. The composer is one card with one bar, and the readings moved outside the paper

**Kind:** deliberate departure from SillyTavern's send form, on the user's instruction,
against a reference image. It also overturns one earlier ruling of our own (the
saturated send key, 2026-09-07) and corrects one of our own readings (the capacity
capsule, entry 68).

**The instruction** (user, 2026-09-10, verbatim): 「按照图片重新设计对话框并在配色上和
本系统保持一致」, with an image: a large rounded card, a placeholder 「给智能体发消息」
in the empty upper half, and **one** bottom row — a circular 「+」 and a dropdown on
the left; a model name, a grey effort word, a chevron, a thin ring and a filled
circular send key on the right.

**What was there.** Three boxes stacked inside the composer: the writing sheet with the
send key beside it (84px wide, arrow over the word 「发送」), a row of three outlined
capsules under it (「提示词 · 预设名」, the model, 「上下文 30.1K/128K · 24%」) with the
extension slot and the keyboard hint sharing the same line, and the usage strip under
that. Five surfaces, four of them printing figures, and the capsules were the loudest
things on the screen after the branch.

**Upstream is a form and stays one.** SillyTavern's `#send_form` is a bar of icon
buttons around a textarea — the wand, the options gear, the extensions menu, the
character-management row — and everything a reader can change about the next request is
somewhere else entirely (the connection panel, the preset panel, the sliders). Iris put
the two facts a reader checks before pressing send *under the field* (entry 36) and that
decision is unchanged; what changes is that they are no longer capsule-shaped and no
longer share the row with things that are not facts about the next request.

### The bar, left to right

- **「+」** (32px, no ground until pointed at) opens two rows: 「提示词」 — the
  itemization panel, which is what the first capsule's press did — and 「斜杠命令」,
  which sets the draft to `/` and opens the completion list. Not a second code path:
  the completion menu reads the draft, so a reader who chose the row can keep typing to
  filter, exactly as one who typed the key can. Two acts, and they are here rather than
  in the bar because neither is a *fact about the next request*.
- **The preset**, in words, with a chevron: the name in force, or 「未启用预设」. Its
  menu lists the library (`preset.list` through the store's `loadPresets`, re-read on
  every open, the model menu's rule) and switches with `preset.select`. It carries a
  sentence the model control does not need: **a preset switch is global**, and a reader
  who learned the scope from the control beside it would guess wrong.
- **The extension slot** (`iris.composer.actions`) stays in the bar, wrapped in a span
  whose `:empty` state removes it and its divider. It is *not* folded into 「+」: a
  contribution is a component, not a labelled action, so it cannot become a menu row
  without asking every extension to describe itself twice — and mounting the same
  component in two places would give one control two states. The brief allowed either;
  this is the half of it that keeps every existing contribution working unchanged.
- **The model**, with the **effort** beside it one tier quieter, a dot when this
  conversation overrides the model, and a chevron. The menu is the same
  `model-menu.ts` decision as before (list, heading, the two nothings, the probe on
  open, the restore row) plus a second group: the six effort words.
- **The capacity ring** (20px, three bands, `--iris-danger` when over budget, the track
  turning while a reply is in flight). It replaces the capsule that printed
  「上下文 30.1K/128K · 24%」.
- **The send disc** (32px, up arrow, `--iris-accent`; a square while generating).

Under the card, outside the paper, one line of the faintest type: the keyboard hint on
the left and the usage strip on the right. Both are readings a reader *consults* rather
than controls, and putting them outside the sheet is the layout saying so without
spending a word on it. Below 880px the hint goes and the figures stay — three keystrokes
nobody at that width has, against figures that are worth the same everywhere.

### The four judgements worth arguing

**One: the effort is in the model's control, and writes the conversation's layer.**
It is the same decision at a lower resolution — which model answers, and how hard it
thinks — so it is the same control and the same menu. The write goes through
`patchSettings`, which is the settings drawer's own action and scopes itself to the open
conversation; the composer only ever renders with a chat open, so an effort chosen here
lands beside the model override the dot reports. `auto` writes `null` rather than the
word: `@iris/llm-openai-compat` omits `reasoning_effort` for both an absent value and
the literal `'auto'`, so storing it would be an override with no effect — visible in the
layer, invisible in the request. The plausible wrong implementation writes the global
layer, looks identical on the control, and silently moves every other conversation;
`tools/render-check.tsx` writes an effort against the live store and asserts which layer
caught it.

**Two: the figures left the bar, and the ring's `aria-label` is where they went.**
Entry 68 argued the trigger should be a capsule *because the row was a row of capsules*
— 「a progress ring beside them would be a fourth vocabulary in a strip of two」. That
premise is gone: the redesigned bar has two worded controls and three marks, and a
fourth line of figures would be the only thing on it a reader has to read rather than
glance at. So the reading became a mark, and the sentence the capsule printed became
the button's accessible name (the long form — exact figures, the window's provenance,
which request the reading is about — stays on the `title`, and the card a press opens is
unchanged). **What this costs:** the occupancy is no longer legible at rest to a reader
who is not hovering, and 「how full am I」 now takes a hover or a press. That is a real
loss and it is the price of the row the reference draws. What would overturn it: a
report that a reader stopped noticing a filling window.

**Three: the send disc is quiet on an empty draft, which reverses our own ruling.**
On 2026-09-07 the user overturned the older 「quiet until there is something to send」
rule in favour of the artboards, and the seal has been saturated in both states since.
The reference image draws it desaturated on an empty draft and the instruction says so
(空草稿时降饱和), so it is desaturated again — with `--iris-accent-quiet` rather than an
opacity, because an opacity on plum goes brown under 墨. The concern the 2026-09-07
ruling answered — a permanently-disabled primary control reading as broken — is answered
by the disc inking up on the first keystroke, which is a change the reader causes and
therefore sees. `render-check` still pins what it pinned before: the idle class and the
`disabled` attribute travel together.

**Four: the bar's menus are this file's own component, not the primitives' `Menu`.**
The slash-command completion list still uses the primitive, because for a typeahead it
is right. The bar's three menus do not, and the reason is one attribute: the primitive's
rows are `role="menuitem"`, minted inside the component from a data array. The effort
ladder is a **radio set** — six mutually exclusive answers, exactly one in force — and so
is the model list; announced as independent menu items, a screen reader is told there are
six things to do here and not that choosing one un-chooses the rest. `ComposerMenu.tsx`
transcribes what the primitive does well (the portal out of the composer's scroll
container, placement from the trigger's rect, re-placement on scroll and resize, one
`pointerdown` and one `keydown` listener while open) and adds the keyboard walk the
primitive leaves out. **What this costs:** a second menu implementation in the app, and
two menu surfaces that must be kept looking alike by hand. What would overturn it: the
primitives growing a role on `MenuItem`.

### Smaller decisions

- **The 「梅花」 decoration stays and is halved.** The branch across the panel's top
  edge and the blossom in the card's corner are what canvas.json spends this screen's
  whole decorative budget on, so removing them was never on the table; the blossom moves
  out of the writing lane to the top-right corner at 14px and both drop to half
  contrast. The subject of the surface is now the empty space above the bar, and a mark
  at full strength stood in it. The 1px white inset the writing sheet carried is gone
  with the sheet — at the card's radius it read as a second edge, and it was the last
  literal colour in the composer.
- **The composer asks for the preset library on mount.** `loadPresets` was the preset
  panel's alone, deliberately (a host with no library refuses `preset.list`, and a
  refusal at startup would raise a notice about a feature that host never had). That
  reason survives — the action swallows its own refusal and records the absence — and the
  cost is one round trip per session. The payoff: the control names the preset in force
  instead of saying 「未启用预设」 about every host until somebody opens the drawer. The
  visible cost is one frame: between mount and the answer the control prints the absence.
- **The model name is ink, not the accent.** The instruction says 模型名主色字; read as
  「the primary text colour」 against 努力度灰字 beside it, which is the hierarchy the
  reference image draws (a dark name, a grey qualifier). Plum type on the model name
  would have made the bar's quietest fact its loudest mark, and the one saturated thing
  on this screen is the send disc.
- **`capsuleReading` is now `ringReading`.** The function outlived the shape it was
  named for, and a name that describes the wrong object is the trap a future reader falls
  into; `context-occupancy.ts`'s prose about 「the capsule's 2px bar」 went with it.
- **The fake now keeps a chosen effort.** `mergeSettings` / `mergeOverrides` dropped
  `reasoningEffort` — not numeric, not `stop`, not the route — so against the seeded
  transport a chosen effort was forgotten and the control looked broken while being
  correct against a host. Its neighbours are **still** dropped and deliberately not
  fixed here: `contextWindow`, `contextUnlocked`, `continuePostfix`, `trimSentences`,
  `squashSystemMessages` and `cacheFriendly`. Each needs its own check and none is on
  this path.

### What is pinned, and the one state nothing can reach

`tools/render-check.tsx` holds the structure on a real render: the card, the bar, each
of the three controls announcing its menu, the preset control's sentence, `__under`, the
slot's wrapper, no menu in the markup while all three are closed, the model name and its
dot, the effort word appearing and disappearing with the layer it is written to, the
ring's arc in the right band at the right length, and — on the mid-stream render — the
stop disc and the turning ring together. `tests/composer-bar.test.ts` holds what a render
cannot see: the six words against the host's validator *and* the fake's, both directions;
the layer rule as a property of two source files; the ring's arithmetic against its own
length; `menuitemradio`; every mark-only control's name; and — the check that stands in
for looking at three screenshots — that **every colour the composer draws is a
`var(--iris-…)`**, since the three palettes redefine the same properties and a rule that
names a colour is the only way one theme can be wrong on its own. The three arc bands
are still held to being three distinct values in each palette, in
`tests/context-meter.test.ts`, where the capsule gauge's were.

**The one state nothing renders:** a composer with a draft in it. The draft is `useState`
inside the component, `renderToString` runs no effects, and the card bus that could write
one is installed by an effect — so 「ready」 is pinned against the source (the
`empty ? 'idle' : 'ready'` branch) and not on a render. Two of the three states are real
renders; the third is a source pin, and this is the sentence that says which.

**What would overturn it.** A reference image or a ruling that puts the figures back
in the bar (the ring is the one part of this that trades information for quiet, and it
is the part most likely to be reported against); a reader who cannot find 「提示词」 now
that it is behind 「+」, which would mean a two-row menu is one row too far for the act a
reader most often wants; a report that a preset switched from the bar surprised somebody
in another conversation, which would mean the sentence in the menu is not enough and the
verb belongs somewhere global-looking; the primitives growing a role on `MenuItem`,
which would delete `ComposerMenu.tsx` and half of what `tests/composer-bar.test.ts`
holds.

## 81. The sidebar gets an identity, a one-line row, a manual order and a rail

The user's design, drawn 2026-09-10 in five artboards (`Main`, `RowStates`,
`DragReorder`, `LogoMotion`, `Rail`) and implemented from them. Four changes,
recorded together because they are one panel and three of them share a mechanism.

### The identity: an aperture, not the blossom

`marks.tsx` grows `ApertureMark` — an outer ring, six blades, a hole the blades
close over — and the sidebar's head is now that mark plus the wordmark 「Iris」.
The plum blossom that stood there is **still in the product** and has not moved:
it is the composer's seal and the mark on a turn boundary, which is where a
theme signs its own paper.

The reason for the swap is that the blossom was doing two jobs. It was 「梅花」's
decoration *and* the thing that said "Iris", so the product's identity changed
whenever the theme did — and a theme is something a reader picks.

- **Two states, one drawing.** `open` toggles a class; `shell.css` moves the
  blades' `rotate` and the hole's `r`. Folding the panel therefore animates the
  mark it already has rather than swapping in a second asset, and the closed
  form is guaranteed to be the open form's own geometry. `Rail.dc.html` draws
  the shut mark as a solid `r=6.5` dot; that is what six blades converged 38°
  and 5.5px inward look like, and drawing it separately would have been a second
  copy of a shape the mechanism already produces.
- The blades' base angles are CSS custom properties, not the artboards'
  `transform="rotate(60 22 22)"` attributes: a CSS `transform` **replaces** the
  presentation attribute rather than composing with it, so with the base
  rotation left in the markup every blade would have snapped to 0° the moment
  the transition touched it.
- The hole shuts by `r` **and** by `opacity`, which is one effect with a
  fallback inside it: `r` as a CSS property is animatable in Chromium and
  Firefox and not everywhere, and a hole still lit at full size behind closed
  blades reads as a mark that failed to finish.
- **The wordmark is set in a serif, and it is not the artboards' serif.**
  `Main.dc.html` uses Cormorant Garamond 500 from Google Fonts. `tokens.css`'s
  standing rule is system stacks only — Iris is local-first, and a wordmark that
  falls back whenever the network is down tells the reader the product is
  broken — so what ships is the artboard's own fallback stack verbatim,
  `--iris-font-wordmark: Georgia, 'Songti SC', serif`. Checked rather than
  assumed: `georgia.ttf` is installed on this machine, so the first name draws,
  and the mark is a real transitional serif against the interface's Corbel.
  A four-glyph woff2 subset was the alternative and there was **nothing to
  subset**: the family is not installed here, this worktree may not install
  anything, and neither `fontTools` nor `pyftsubset` is on this machine. When
  either exists it is one token plus one `@font-face`, and an OFL row in
  `THIRD-PARTY-NOTICES.md`.
- **The tab icon is the shut aperture**, as a `data:` URI in `index.html`. It
  was `data:,` — an empty icon whose only job was to stop the browser asking the
  host for `/favicon.ico` (measured: one 404 per page load, on every card). That
  job is unchanged, since a data URI is never fetched. The plum is a literal
  there because a favicon has no stylesheet and so no tokens, exactly like the
  ground colours the pre-paint script already duplicates; `shell-page.test.ts`
  holds it to 雪's own `--iris-accent`.

### The row: one line, four columns, and the trigger inside it

`RowStates.dc.html`: 10px of handle, the title, the stamp right-aligned, 24px
for the overflow trigger, 44px minimum. It was two lines with the stamp beneath
the title, and the trigger was a **sibling of the row in a flex line** — which
made every row narrower than the panel and put its own actions outside the
rectangle they act on.

- **The trigger is in the row and is not inside the row's button.** The row is
  still one `<button>`; the trigger and the star are its siblings, absolutely
  positioned over the cell the grid reserved (`.iris-row__acts`, `.iris-row__well`).
  A `<button>` inside a `<button>` renders, looks right, and is repaired by the
  parser hoisting the inner one *out* of the outer — so the control the reader
  sees inside the row would sit somewhere else in the DOM, at a different tab
  position and with a different event target. This is the redesign's one
  structural rule and it is pinned twice, in the render check and against the
  source of both row components.
- The trigger is **permanent**, at `--iris-rule` — the hairlines' own grey —
  and brightens to `--iris-ink-faint` when the row is hovered, focused or
  current. It used to appear on hover, which cost a control that grows under
  the pointer and a control a touch reader cannot find at all. Going from a rule
  to an ink is one step; going from nothing to something is a flicker.
- Hover moved from `.iris-row` to `.iris-row-shell`: reaching for the trigger,
  which is outside the button, used to make the row's ground vanish under the
  pointer.
- The stamp is the **short** count — `2 天前 · 3 条` / `2d ago · 3 msg`, built
  by `format.ts`'s `chatMeta`. `messageCount` survives for the character page,
  whose column is wide enough for the noun.
- The library row got the same treatment: its star and trigger are in the row
  now, over a 52px reserved column.

### Dragging, and an order the host keeps

`DragReorder.dc.html`, implemented with Pointer Events and no library — a
reorderable list is three numbers and a `splice`, and the libraries that do it
ship a sensor stack and a collision strategy this one panel does not need.

- `reorder.ts` holds the arithmetic (`moveItem`, `dropIndex`, `makeWay`) because
  it is behaviour a `node --test` file can check; the pointer plumbing stays in
  the component because that part is the browser's.
- Row centres are **measured**, never computed from a constant: the rows are
  44px today and a title that wraps would make that a lie the same afternoon,
  and a wrong constant shows up as a drop that lands one row off — which reads
  as a mystery rather than as a stale number.
- And measured **once, when the row goes up**, which is a correction and not a
  shortcut. Re-reading them on each move looks more honest and is not: a
  neighbour making way carries a `translateY`, and `getBoundingClientRect`
  reports the *transformed* box — so every row the drag had already passed
  measured one pitch from where it rests, and the drop index was computed
  against positions the drag itself had moved. Travel is now a delta from where
  the pointer went down, plus the list's scroll drift, which is the only thing
  that can still move a resting row under the pointer.
- 150ms press on the row *or* the handle; 6px of slop abandons the press so a
  flick-scroll stays a scroll; Escape or dragging 48px outside the list cancels
  and writes nothing; `prefers-reduced-motion` keeps the well and the reorder
  and drops every transform.
- **Only a root row has a handle.** A branch renders under the conversation it
  left, so its position is derived — a handle on one would offer a move the next
  render undoes.
- **The request carries the whole visible order, branches included.** The host
  treats an id its arrangement does not name as newer than the arrangement and
  puts it on top, so sending only the roots would detach every branch from its
  parent the moment anything was dragged.
- A finished drag eats exactly one click, scoped to the row that was carried and
  stamped with a time — the row is a button, and the pointer-up that sets a
  conversation down would otherwise open it.
- **Keyboard:** Alt+↑/↓ on a focused row. Alt rather than a bare arrow because
  the arrows scroll the list, and a reader stepping through rows with them must
  not reorder by accident.
- **Manual against by-time** (the relation the task asked to be decided): the
  chat list had **no** sort control — `iris-sorts` belongs to the library tab —
  and was unconditionally `updatedAt` desc, decided on the host. It now gets two
  capsules, 自定义 / 按时间, which **appear only once the host reports an
  arrangement exists**. Before the first drag the two answers are the same list
  and a permanent pair of capsules would be a control that never changes
  anything; the artboards draw the chat tab with nothing but a search box above
  the rows, and this keeps that drawing until the reader has done the thing that
  makes the choice real. 按时间 re-sorts **in the browser** and deliberately
  does not tell the host: switching to newest-first is a way of looking at the
  list, not a decision to throw the arrangement away, and switching back has to
  find it exactly as it was. Dragging while in 按时间 flips the device to
  自定义 and stores the result. The choice itself is per-device
  (`sidebar-state.ts`), like the drawer's open cards; the *sequence* is on the
  host, because a shelf someone arranged has to survive a new machine.
- The host half is DEVIATIONS §62 (`chat.reorder`, `chat-order.json`, and why an
  unmentioned conversation is listed on top).

### Folding: one switch, two appearances

`LogoMotion.dc.html` and `Rail.dc.html`. The panel folds to a 44px rail with the
aperture shut at its head, the same three destinations as icons, and the import
`+` at its foot.

- **`navOpen` is gone and there are not two switches.** The shell holds one
  `collapsed`, and the *width* decides what collapsing looks like: above 880px
  the panel becomes the rail; at or below it the panel is off-canvas and the
  masthead's ☰ is what brings it back, exactly as before. Two switches would
  have let a window that got narrower arrive with one open and the other shut,
  with no rule for which one the ☰ answers. The ☰ is now a toggle and says so
  (`aria-expanded`), and the dismiss scrim still renders from the one switch and
  is still shown only in the interval that has a sliding sidebar
  (`breakpoints.test.ts` holds it there).
- Stored in `localStorage` like the drawer's cards. With nothing stored, a
  window narrower than **900px** starts folded — a *default* read once, not a
  breakpoint: the shell has exactly three width breakpoints and each one is a
  rule that holds at every moment, while this is a first guess that a reader
  overrides for good. It is in TypeScript, not in a stylesheet, so
  `breakpoints.test.ts` still sees three.
- **Both forms are always mounted**, cross-faded by class. The outgoing form
  cannot fade if it has already been unmounted, and the list's scroll position
  would reset on every fold. The form that is away is `visibility: hidden`,
  which takes it out of the accessibility tree and out of the tab order — so
  "mounted" is not "reachable", and both `aria-hidden` states are pinned.
- **Neither fold control travels** (the user's amendment, 2026-09-10: 「展开按钮
  从左往右出现，缩放按钮从右往左消逝；风格和间距要和其他图标一致」). They are two
  buttons, not one that moves: the head's leaves with the content it belongs to,
  right to left; the rail's arrives with the rail, left to right. Both are the
  same `.iris-sidebar__ico` as the rail's four destinations — 32px, radius 8,
  `--iris-ink-tertiary`, sunken on hover, 12px apart — written once, because the
  earlier drawing gave the fold button its own 28px box and its own colour and
  at 44px wide the icons under it read as a set with an intruder at the top.
- Timing: 160ms for the wordmark's clip, 120ms for the cross-fade, 220ms for the
  bar, as three tokens (`--iris-fold-word`, `--iris-fold-fade`,
  `--iris-fold-width`) because each is used twice, once per direction, with the
  delays swapped. 160 + 220 = **380ms**, inside the artboards' 400ms ceiling.
  Under `prefers-reduced-motion` the two end states remain and the choreography
  goes.
- One asymmetry, and it is about focus rather than looks: on the way *in*,
  `visibility` flips with no delay while the opacity still waits for the bar.
  The rail's 搜索 icon expands the panel and puts the cursor in the search box,
  and a `visibility: hidden` element cannot take focus — so a delayed visibility
  would have made that icon expand the panel and then silently do nothing for
  220ms. Nothing appears any earlier: the opacity is 0 and the bar clips it.
- The shell's first grid track became `auto` with the width on `.iris-sidebar`,
  so one transition animates both the panel and the reading area. `SIDEBAR_TRACK`
  (`state-panel.ts`) still reads 272 — the **expanded** width — because a media
  query cannot ask whether the reader has folded the panel, and a breakpoint
  that moved when they did would make the variable margin appear and vanish for
  a reason nothing on screen explains. That errs safely: with the rail showing
  there is 228px *more* reading area than the sums assume.

### Costs

- **A local `z-index`.** A lifted row has to paint over the rows it passes,
  which is an order between siblings inside one list rather than a page layer.
  `layers.test.ts` refused every literal; it now grants one named selector an
  exception, on the argument it already makes for `reading.css`'s two
  `z-index: 1`, **and asserts the exception is still used** — an allow-list
  nothing uses is a licence waiting for the next literal.
- **The panel's DOM is larger while folded**: the whole conversation list is
  still there, hidden. That is the price of the cross-fade and of keeping the
  scroll position, and it is the same trade `App.tsx` already makes for the
  reading sheet.
- **Two capsules that were not drawn.** The artboards give the chat tab a search
  box and rows. The order control is an addition, and it is bounded to the case
  where it means something.
- **`chatMeta` is a second copy of a separator.** `STRINGS.md` argues elsewhere
  against template keys that hold only punctuation; this one lives in `format.ts`
  as code rather than in the dictionary, so there is still one layout.

### What would overturn it

A report that the rail's four icons are not enough to work from — the fold would
then need labels and a wider rail, which is a different drawing; a reader who
wants the arrangement to follow the conversation they are writing in (a chat
that rises to the top when it is written to), which is a rule the current one
cannot express; Cormorant Garamond becoming available to subset, which changes
the wordmark's face and this section's third bullet; a measurement that the
150ms press makes the list feel unresponsive on touch, which would move the drag
back onto the handle alone.

## 82. The `getContext()` surface is a written-down list, so its absences say whose they are — and the virtual parent's two traps now agree about every name

**Kind:** fix (a diagnostic that could not tell two absences apart, and three
`has`/`get` disagreements), plus one caliper.

Three pieces of one job: make the gap between what a card may reach for and what
Iris answers **measurable and self-reporting**. No member is implemented here.
The per-member accounting for all four surfaces already exists in
`TH-SURFACE-AUDIT.md` and `ST-CONTEXT-SURFACE-AUDIT.md` (both from 2026-09-08,
on their own branches) and this does not restate it.

### 82.1 `UPSTREAM_CONTEXT_MEMBERS`, and which kind of absence a card met

The facade's report for a member Iris has not built said:

> a card read SillyTavern.printMessages, which Iris has not built — it returned
> undefined, which is not a statement that the host has no such member

The hedge at the end was the whole of what the frame could say, because it had
no list of upstream's `getContext()` surface — so **a member upstream really
has** and **a name nothing anywhere carries** produced the same sentence. The
corpus reaches for both: three of the 145 keys are used and unbuilt
(`addOneMessage`, `printMessages`, `reloadCurrentChat` — the same three the ST
audit graded P1, reproduced here from a wider population), and reaching for a
name upstream also lacks is a *measured idiom* — nineteen of them, all behind
`typeof` guards, because a card written against SillyTavern probes before it
calls.

`upstream-surface.ts` now carries the 145 keys beside the 171 Tavern Helper
names, extracted from the installed `public/scripts/st-context.js` rather than
written by hand, and the frame's report splits in two: a name on upstream's list
gets **"upstream's getContext() carries this and Iris has not built it yet, so
this is missing scope here, not a fault in the card"** — the same sentence
`script-run-state.ts`'s `attribute()` gives the Tavern Helper face, deliberately
word-for-word, because a reader who has learned to recognise one should not have
to learn a second. A name on nobody's list keeps its `undefined` and is told so.

Three deliberate choices inside that:

- **The list does not reach the parent proxy.** `parent.printMessages` is
  `undefined` on the real SillyTavern page too: `public/script.js` loads as
  `type="module"`, so its exports never land on `window`, and the page's own
  `SillyTavern` global carries only `{libs, getContext}` (`script.js:292-295`).
  Consulting this list there would answer "upstream declares this" about names
  upstream's page does not have — manufacturing scope out of a list that is true
  about a different object. The 145 are reachable as `SillyTavern.X` *inside a
  card frame* only because Tavern Helper's `predefine.js:26-31` defines that
  frame's global as `{...getContext(), getContext, writeExtensionField}`, which
  is exactly the surface the facade stands in for. The module doc says so, so
  the next person to wire it has the reason rather than the rule.
- **The names travel in the fetched member table, not the bootstrap.** 145
  strings is about 2.4 KiB and the bootstrap had roughly 1.8 KiB of headroom
  under `FRAME_OVERHEAD_BYTES` (53 KiB, §76). Inlining them would have moved the
  frame gate to buy a diagnostic — the trade the inline/fetch seam exists to
  stop anyone making by accident, and the same answer the popup API and the
  parent-message table gave. The core still composes the sentence; only the data
  moved.
- **Declaration order in `upstream-surface.ts` is load-bearing, and so is that
  file's prose.** Two calipers — `scripts/th-member-census.mjs` here and
  `scripts/th-surface-audit.mjs` on `dev/audit-th-surface` — find the Tavern
  Helper list by searching the file for its name and then matching every quoted
  identifier **to the end of the file**. A second array after it becomes part of
  it: 171 answers 316, and 145 extra names that no card uses land in the
  "declared but never used" column, which is those reports' *expected* shape, so
  nobody would look. The context list therefore goes **first**, the header talks
  about "the Tavern Helper list" instead of naming it (the search takes the
  first occurrence, comment text included), the census in this tree now slices
  to the closing bracket with a floor under it, and
  `upstream-context.test.ts` asserts that reading the file the caliper's way
  still yields exactly `UPSTREAM_MEMBERS`.

### 82.2 The virtual parent's `has` now answers for every name its `get` does

`#48` (web §76) found `parent.setTimeout` working while `'setTimeout' in parent`
said false, and added the schedulers to `has`. That fix was right and the
*shape* of the finding was the result: two hand-written lists in one proxy drift
every time a member is added, silently and in the worst direction — the corpus
feature-tests before calling at hundreds of sites, so a card skips a member that
works.

So the audit runs over the whole surface. `sandbox-frame.test.ts` extracts every
`property === 'name'` from both traps out of `frame.ts` itself — brittle against
our own source on purpose, with floors that turn a broken extraction red rather
than into "0 inconsistencies" — and requires `in` and a read to agree, in three
context states. It found three more, each the same shape:

| name | `get` | `has` before | why it mattered |
| --- | --- | --- | --- |
| `EjsTemplate` | a real object, always | false | the measured caller tests `typeof tw.EjsTemplate.evalTemplate === 'function'`; a probe on the name itself would have skipped a working member |
| `is_send_press` | a **boolean**, `false` most of the time | false | the read says "not generating" and the probe says "no such member"; the corpus polls it to avoid re-entering while the model writes |
| `extension_settings` | the settings object | `context !== undefined` | a *different condition* — the object is built in the `context` message handler, so a **seeded interface frame**, whose snapshot arrives inlined in the srcdoc, had a context and no settings object, and `in` said true while the read was `undefined` |

`has` now gates on the same thing `get` does: `EjsTemplate` and `is_send_press`
unconditionally, `extension_settings` on the object rather than on the context.
The third state — a seeded interface frame — is in the test because a gate and a
constant look identical when only one state is checked, and it is the state that
found the third row.

### 82.3 `scripts/card-surface-census.mjs`

A caliper (`npm run census:card-surface`, always exits 0, skips with no corpus).
Not a third audit: what it adds is the **population** and the **unit**.

- **Two code populations no other census reads**: preset regexes (`OpenAI
  Settings/*.json` → `extensions.regex_scripts[].replaceString`) and disk world
  book entries (`worlds/*.json` → `entries[].content`). Both carry code, and
  three names in this corpus are reached **only** from them — `parent.postMessage`
  (the member §76 built, whose only corpus caller is a preset),
  `parent.triggerSlash` (a gap), and `YAML` (a world book). Every other
  instrument in the tree reports those as absent, which is the same output as
  "nobody uses it".
- **Two columns, always both** (a card's scripts / the interface text it ships),
  because a member reached only from rendered markup and one reached only from a
  script body need different work, and this project has produced three tidy
  wrong zeros by scanning `extractScripts` alone.
- **The unit is the source** — a card, a preset, a world book — deduplicated by
  content hash first, so one script pasted into nine cards is one vote.
- **Our side is extracted from our own source** (`MEMBER_KINDS`, both proxies'
  dispatch branches, `CARD_METHODS` minus `OFF_ST_SURFACE`, `ScriptContext`'s
  fields, `EXPECTED_GLOBALS`, the seeded `host['x'] =` assignments), each with a
  floor that stops the run rather than shading it. That discipline earned its
  keep immediately: the snapshot fields were read from the wrong module, came
  back empty **without saying so**, and reported `chat` — 94 calls across five
  sources — as an unbuilt member of the getContext surface.

The reading is in `notes/apps/iris-web/CARD-SURFACE.md` with the口径 and the
差异 against both audits (group differences, no disagreements). One new
conclusion came out of it, and it came from the *union* of the two audits'
populations rather than from either being wrong: 魔法少女的扣扣审判's interface
regex writes `if (typeof stopAllGeneration === 'function') … else if (typeof
top.stopAllGeneration === 'function') …`. The ST audit saw the second branch and
correctly ruled it out (upstream's page has no such global; adding it would
activate a branch that is dead upstream). The TH audit did not see the first,
because for the ST install it kept the older census's population — script bodies
plus *rendered* interfaces — and this regex has never rendered in a local chat;
it recorded the member as "未提供 · 0 命中". The bare spelling **is** provided
upstream, as a plain global in every script frame, so the first guard passes
there and fails here: a card asking to stop generation, doing nothing, saying
nothing. Recorded as a fact; the grading stays where the TH audit put the
family (P2, waiting on a host stop arm).

### Costs

- **Two more things extracted from our own source by text.** The audit test and
  the census both read `frame.ts` and refuse rather than shrink, which is the
  right failure mode but is a maintenance debt: renaming `isBridged` or moving
  the facade's `set` trap turns a test red for a reason that is not a bug. The
  floors and the messages say which, and that is the whole mitigation.
- **A member-table field for a name list.** The table is the surface a card
  reaches *with*, and this is data the core reads about the surface — the first
  entry of that kind beside `KNOWN_ST_IDS` and the event-name lists. It is in
  the table for a byte budget, not for a design reason, and the doc comment says
  so.
- **337 bytes of the bootstrap, for two sentences.** `tools/check-bootstrap.mjs`
  measures 52,825 bytes after this, against the 52,488 §76 recorded at its own
  commit — a frame overhead of about 53,849 against the budgeted 54,272, so
  **423 bytes of headroom** under `FRAME_OVERHEAD_BYTES`. The 2.4 KiB of names
  is not in that figure (it rode the member table, above); what is in it is the
  branch and the two report strings, which are policy and cannot leave the core.
  The next change to this file has to read the build's own comparison rather
  than assume room — the margin is now a third of what §76 left.
- **`tests/members-table.ts` had to grow with it**, which is the drift the
  shared helper exists to catch — and it caught it: the new field was missing
  there first, and the facade's report test went red with `nothing was said
  about printMessages` rather than with a type error, because a runtime table
  without the field throws inside the proxy.
- **The census's parent face is a judgement call in one place.** A host-window
  alias with several bindings in one body (`win`, `targetWindow`, `tw`, `_tw` —
  four in this corpus, each declared three or four times as `window.parent ||
  window`, then `window`, then `getCore().window`) is **counted**, and a
  single-character alias is **dropped**. Requiring one binding cut
  `parent.SillyTavern` from 4 sources / 84 calls to 2 / 4 and `parent.TavernHelper`
  to zero, in a corpus where the audit beside it measures 6 cards and 4;
  accepting one letter put 53 ordinary `e.replace(…)` / `e.trim()` calls from a
  minified bundle on the host-global face. Both numbers are printed each run so
  the residual uncertainty is visible rather than assumed away.

### Found and not changed

- **A seeded interface frame answers `extension_settings` with `undefined`.**
  `extensionSettings` is built only in the `context` message handler, and an
  interface frame's snapshot arrives inlined instead — so a card's interface
  reading `parent.extension_settings` at parse time gets nothing, while the
  snapshot it would have come from is right there in the srcdoc. `has` now
  agrees with that, which is this section's fix; making the read *answer* is
  building a member, which this branch does not do.
- **`EjsTemplate` and `is_send_press` are not on `isBridged`**, so a card
  assigning them lands in the published bag while the read keeps answering the
  frame's own object — a write that appears to succeed and changes nothing.
  Adding them would make the write throw, which upstream does not do for either
  name (both are ordinary page globals there), so it is a behaviour change
  rather than a consistency fix and it is recorded here instead of made.
- **`preset-globals.ts:65-69` still calls `showdown`, `VueRouter` and
  `EjsTemplate` "absent and reported"**, which `preset-entry.ts:200/:230` and
  the frame's core list have made false. The ST audit found it first; this run
  reproduces it from the other direction (the census reads the seeded
  assignments and finds all ten of `EXPECTED_GLOBALS` provided).

### What would overturn it

Upstream reorganising `st-context.js`'s returned literal, which stops the
extraction and — by the discipline both calipers already carry — stops any new
number being quoted until it is repaired; a card that reaches a `getContext()`
member through destructuring (`const { chat } = getContext()`), the one shape
neither this census nor either audit matches, which would mean the "used"
columns are lower bounds by more than the aliasing already makes them; a
decision to bridge the host page's globals wholesale, which would make the
parent face's careful exclusion list pointless and is the opposite of what the
sandbox is for.
