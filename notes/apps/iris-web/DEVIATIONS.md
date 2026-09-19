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

> 复查（2026-09-17，e668785）：重开条件「样式表代理落地」已成立——证据 fe45239（`rewriteStylesheetLinks`/`rewriteStylesheetUrls` 走 bundle 路由）与 §95.4、`notes/ROADMAP.md`。决定**部分**改变：代理只重写白名单内主机（`*.jsdelivr.net`、`raw.githubusercontent.com`），本节自己点名的 `fontsapi.zeoseven.com` 仍在白名单外被具名拒绝。

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

**Postscript, 2026-09-11.** The sentence above about upstream's timer tooltip —
that it carries a rate derived from upstream's estimate, "not a usage
breakdown" — is still an accurate reading of upstream and is no longer a
statement that Iris shows no rate. Each turn's chip now carries one, over
upstream's own window and with the provider's `outputTokens` as the numerator,
and the hover card carries the timing rows beside the bucket rows. §92 records
the definitions and the two departures; this entry's ruling — reported figures
where upstream estimates — is what the numerator follows from.
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

> 复查（2026-09-17，e668785）：重开条件「宿主在聊天文件里记录 per-message 时刻」已成立——证据 a99c3db 与 host §67。决定**尚未**重看：新记录带 `at`，但未带戳的旧历史仍走重建与 `undatedTurns` 计数，见 REVIEW-1 清单第 115 条。

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

> 复查（2026-09-17，e668785）：重开条件「宿主记录启动时的路由」已成立——证据 #624c4ce 与 host §60，本节已就地记「it did, hours later: host §60, entry 78」。决定已随之改变（§78、§79 记录）。

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

*Postscript 2026-09-11.* Both audits were retired by the user's decision: their
pull requests (#50, #51) had closed unmerged on 2026-09-09, and the branches
`dev/audit-th-surface` and `dev/audit-st-context-surface` were deleted. The
texts stay frozen at the PRs' head commits (`4840297`, `c91d7b5`, reachable as
`refs/pull/50/head` and `refs/pull/51/head`). The standing per-member account
is the census's 用到 · 没建 tables together with this ledger's family entries,
and `CARD-SURFACE.md` now says so. Every other citation of the two documents in
this ledger is a dated record of what was read at the time and is left as
written.

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
## 83. `parent.alert`, `parent.confirm`, `parent.prompt` and `parent.toastr` are the frame's own, one object per name

**Kind:** fix. Four names upstream's parent window carries and Iris's virtual one
did not — three of them killing a real card on contact.

**Measured** 2026-09-10, both corpora (the ST install's `data/default-user` and
`apps/iris/data/default-user`), five populations read through the product's own
readers (`decodeCardPng` → `extractScripts`, the card's own regex replacement
text, the *rendered* interfaces deduplicated per card, preset regex replacement
text, world book entry bodies): 415 sources, 35 owners.

| name | owners | lines | shape | before |
| --- | ---: | ---: | --- | --- |
| `parent.alert` | 1 (銀麒赎世) | 10 | `_pw.alert("…")`, **no guard** | `TypeError: _pw.alert is not a function` |
| `parent.confirm` | 1 (銀麒赎世) | 1 | `if (!_pw.confirm("确定导入存档？…")) return;`, **no guard** | same throw |
| `parent.prompt` | 1 (銀麒赎世) | 3 | `_pw.prompt && _pw.prompt("…")`, guarded | silent skip |
| `parent.toastr` | 4 | 144 | `if (_pw.toastr) _pw.toastr.success("…")`; also `window.parent.toastr ? … : window.toastr` | silent skip |

`_pw` is that card's own `var _pw = window.parent`. The worst site is the first,
`银麒系统面板` L52 — `_pw.alert("未找到API通道，请确保手机UI脚本已加载")`. The line
whose job is to *report* a missing API channel was the line that killed the
script, so the card's own diagnostic destroyed the diagnosis.

### Why they were missing

Not a ruling. All four exist inside the frame already: the three dialogs as
`bridgedDialogs` (bridged when `allow-modals` was ruled out, so a card's
unanswerable question reaches the run panel instead of being a browser no-op),
and `toastr` as `toastr-report.ts`'s adapter, seeded onto the frame's window by
`provideToastr`. Nobody asked whether a card reaches for the **parent's** copy
first. That unasked question is the whole defect — the same shape as the six
schedulers (§71's postscript) and `postMessage` (§76): a card walking
`window.parent` outward holds, upstream, the same-origin page window, where every
one of these is simply there.

Upstream's own values, checked rather than assumed:

- `alert`/`confirm`/`prompt` are native methods of any window, so a card's parent
  upstream has them whatever else is on the page.
- `toastr` is a classic script tag on upstream's page (`public/index.html:8194`),
  and `predefine.js:12` `_.pick`s it from `window.parent` into every script frame
  — so both spellings are live there, from one object.

### What was built

Four branches in the virtual parent's `get`, four names on `isBridged`, four on
`has`. The dialogs walk a new exported list, `VIRTUAL_PARENT_DIALOG_MEMBERS`, for
the reason the scheduler list exists: three traps read one list, so they cannot
drift apart silently.

- **Object identity, not equivalent behaviour.** `parent.alert` returns the very
  function `resolveValues` binds to the bare name, and the test asserts
  `parent.alert === alert`. The rule is `eventSource`'s: one implementation per
  name, two spellings. A mutation that wraps the bridge in an identical-behaving
  closure turns two tests red, one of them the pre-existing surface pin.
- **`toastr` is read live off the frame's window**, exactly as `$` is, and for a
  second reason besides load order: `provideToastr` deliberately does *not*
  overwrite a toastr a card brought itself, so a captured value could hand out
  Iris's adapter after the card had installed the real library. `has` asks the
  window the same question `get` does, so absent reads as absent and a guarded
  card's guard stays correct.
- **All four are read-only.** One card's scripts share this frame, so an
  assignment would replace every sibling's dialog or notifier; and upstream
  cannot be written to either — the dialogs are native, and `parent.toastr` is
  SillyTavern's own instance, which a card overwriting would break the host UI
  rather than a neighbour's. Same argument as `parent.$`.

### The divergence this does **not** close

A card's toast still does not pop. What arrives under both spellings is the
reporting adapter, and its calls land in the run panel — the standing ruling in
`toastr-report.ts`, unchanged. This section is about *one object under two
spellings*; it is not a promise of a toast. Read the other way: 銀麒赎世's ~100
notifications now reach the panel instead of being skipped, which is more
information than before and still not what upstream shows.

### What would overturn it

A card that legitimately needs to replace `parent.toastr` for its own scripts —
the read-only rule would then need the same exception `provideToastr` already
makes for the bare spelling; a measurement that a card depends on
`parent.alert !== window.alert` (nothing in either corpus reads them apart); a
decision to grant `allow-modals` to trusted cards, which would make the dialogs
real and change what all four spellings mean at once.

## 84. `getContext().chat` is the live array a card mutates, and `saveChat` means it

**Kind:** fix — of a defect whose fix had already been designed, written, tested
and left unplugged.

**The defect.** `chat-journal.ts` — the recording Proxy, the ordered journal and
the replay — was built against the two measured cards, shipped green, and had
**exactly one consumer: its own test file.** `frame.ts` never imported it. So
`SillyTavern.chat` was a plain snapshot copy, `saveChat` was
`callAction('saveChat', {})`, and every in-place mutation a card made went into
the copy while the host stored its own array. Nothing threw and nothing was said.

That is worse than an unbuilt member, and worth naming as a class: a module that
fixes a problem and is not wired in fixes nothing, while reading in every review
— and in every test run — exactly as though it had. `notes/apps/iris-web/CHAT-WRITES.md`
describes the mechanism in the present tense; the mechanism was not running.
`grep` for a module's consumers, not for the module.

**Who it cost.** Measured 2026-09-10 through the product's own readers, both
corpora. 銀麒赎世's `手机UI` inserts a forum event as a user floor at **six
sites**, all the same block (L19167-19185 and five copies):

```js
var chat = context.chat;
var newMessage = { name: context.name1 || "玩家", is_user: true, is_system: false,
                   mes: content, extra: {}, send_date: Date.now() };
chat.push(newMessage);
if (typeof context.saveChat === "function") context.saveChat();
if (typeof context.addOneMessage === "function") { context.addOneMessage(newMessage, { scroll: false }); }
else if (typeof context.printMessages === "function") { context.printMessages(); }
…
console.log("[论坛见面] 已插入楼层，对方：" + md.inviterNick);
```

The card logged *"已插入楼层"* — a success line for a floor that did not exist.
`notes/apps/iris-web/CHAT-WRITES.md` counts the family at 2 cards and 5
de-duplicated write sites (rewrite, splice and push), every one of them saving,
none behind a branch that could skip the save.

### What was built

`recordChatEdits` and `replayChatEdits` join the **fetched member table**, not
the inlined bootstrap — the module is 358 lines and the bootstrap is re-parsed
per frame, which is the same line `popup-api.ts` and `card-storage.ts` sit on.
Then two wires in the core:

- **On every snapshot**, the chat a card is handed is `recording.array` and
  `context` is rebound to carry it, so `SillyTavern.chat`,
  `getContext().chat` and every Tavern Helper member that reads the snapshot see
  one array.
- **`saveChat` replays the journal, in order, then commits once.** An empty
  journal still calls `saveChat` directly: that is the shape every non-mutating
  caller has (銀麒赎世 closes a read-only refresh with it), and
  `replayChatEdits` returns without committing when there is nothing to replay —
  so routing every save through it would turn the commonest call into a no-op
  that reported success.

### Two orderings that are load-bearing

- **The recorder is installed *before* `restoreFloorTables`.** The recorder
  copies each row; a copy taken after the floor-table getters were installed
  would spread through every one of them, parsing every floor's variable tables
  eagerly — the exact cost the JSON-text encoding exists to avoid (45% of the
  snapshot's bytes, 91% of its clone time) — and would lose the self-replacing
  cache besides. Nothing would throw and no value would change; only the bill.
  Taken first, the rows still carry `variables` as plain text and the two layers
  compose, which is also what `restoreFloorTables`' own in-place note requires.
- **The journal replays in the order the card wrote it**, never sorted, batched
  across a structural operation, or deduplicated. One measured card works back to
  front (`sort((a, b) => b.index - a.index)`, commented *"avoid index shift"*)
  precisely so that each index is valid against the array as the earlier entries
  in the same batch left it. A mutation that sorts the journal turns four tests
  red.

### The deliberate choices

- **The journal is cleared whether or not the replay succeeded.**
  `ChatReplayError` already says how many entries landed; leaving them in place
  would make the next `saveChat()` re-send what the host already took, turning a
  *described* partial failure into silent duplicate floors. The error is the
  record.
- **The inlined seed is not wrapped.** `seededContext` is the pre-arrival answer
  for a parse-time read and is replaced whole by the `context` message a moment
  later. Wrapping it too would put two journals in one frame, each holding half a
  card's intentions with no rule for which one a save replays. A card that
  mutates the seed and saves loses the write, as it did before — recorded here
  rather than quietly changed, and the seed's rows are equally un-restored today.
- **Only `push` and `splice(i, 1)` are recorded.** Everything else that mutates —
  `sort`, `pop`, `chat[i] = …`, `chat.length = n` — is refused **by name, in the
  card's own stack**, because a journal entry that could describe it does not
  exist and inventing one is the guess the whole module avoids.

### What is still missing, precisely

The **data** half of this family is now closed; the **draw** half is not.
`addOneMessage` (2 cards, 8 sites), `printMessages` (2 cards, 14 sites) and
`reloadCurrentChat` (2 cards, 3 sites — one of them 命定之诗与黄昏之歌 v3.0.4's
`card-regex[8] 首页` L891 `await SillyTavern.reloadCurrentChat()`, **unguarded**)
are all requests to *redraw*. They are not built, and the reason is now sharper
than it was: the host's write arms broadcast `chat.updated` and the shell
re-renders on it, so after this section a card's insert both lands and appears —
what the three members would add is the card's own control over *when*. The one
that still fails hard is `reloadCurrentChat`: reading it answers `undefined` and
`await undefined()` throws at the tail of a swipe-switch whose data has already
been saved. Building it needs a shell arm ("re-push and wait for the render"),
which is a decision about the reading column rather than about this surface, so
it is left named rather than guessed at.

### What would overturn it

A card that relies on `addOneMessage` alone to make an insert stick —
`notes/apps/iris-web/CHAT-WRITES.md` measured zero such sites in this corpus, and
card 20 is under no obligation; a measured `splice` with a count other than 1 or
an insert-via-splice, which today is refused by name; a host append arm that
takes a batch atomically, which would make the one-entry-per-call replay a
choice rather than the only correct reading of the recorded indices.

## 85. Names a card reaches for that Iris deliberately leaves absent, and three phantoms

**Kind:** four recorded non-builds, one measured refusal, and one correction of a
census this project's own planning was resting on.

The occasion was a task list of ~20 names to build, drawn from a corpus census
dated 2026-09-09. Checking the premise before doing the work — every name's
value **on upstream's own page**, and every "used" count against evidence lines
— dissolved most of the list. That is recorded here rather than in a handoff
note, because the same names will be re-derived by the next census and the reason
not to build them is not visible from a count.

### The `top.X` / `parent.X` family: undefined upstream too, so building them is the divergence

`public/index.html:8204` loads `script.js` as `<script type="module">`. **Module
exports do not land on `window`.** So a card reading `top.saveChat`,
`top.reloadCurrentChat`, `top.printMessages`, `top.substituteParams`,
`top.sendMessageAsUser`, `top.stopAllGeneration` or `top.context` on real
SillyTavern gets `undefined` — every one of them. Verified independently of the
census: the tag, and each function's definition site.

| name | upstream | in the corpus | ruling |
| --- | --- | --- | --- |
| `saveChat` | `script.js:154` via `st-context.js:154` (`saveChatConditional`) | `top.saveChat` (1 card, guarded); `context.saveChat` (4 cards, 34 lines) | the **context** spelling is built (§84); the `top` spelling is not |
| `reloadCurrentChat` | `script.js:1676`, `st-context.js:129` | `top.` (1 card, guarded); `SillyTavern.` (1 card, **unguarded**) | the ST-surface spelling is the real gap (§84's last section); `top.` no |
| `printMessages` | `script.js:1475`, `st-context.js:288` | `top.` (1 card); `context.` (2 cards) | same split |
| `substituteParams` | `script.js:2922`, `st-context.js:161` | `top.` only (1 card, guarded) | no |
| `sendMessageAsUser` | `script.js:5815` — and **not among `st-context.js`'s 145 keys** (`grep -c` = 0), nor among Tavern Helper's 171 | `top.` only (1 card, guarded) | no, and there is nowhere faithful to put it: `SillyTavern.sendMessageAsUser` would invent a member on a surface being mirrored |
| `stopAllGeneration` | absent from all of `public/` (`grep -rn` = 0); declared only by Tavern Helper (`function/generate.d.ts:223`) | `top.` only (1 card, guarded) | no on `parent`; its faithful home is `TavernHelper.stopAllGeneration`, unbuilt, and blocked on a host stop arm |
| `markdown` / `markdown_parser` | neither exists on upstream's page | `if (top.showdown && top.markdown)` (1 card) | no — the combination is **false upstream as well**, so Iris is already bit-for-bit identical here |
| `showdown` on `parent` | exists on upstream's page (`lib.js:34-88` shims) | only inside the combination above | no: the guard is false either way, so bridging changes no behaviour |
| `triggerSlash` on `parent` | undefined — `predefine.js:12` picks only `EjsTemplate`, `TavernHelper`, `YAML`, `showdown`, `toastr`, `z` from the parent, and Tavern Helper's own members are merged onto the **child** window | not reproduced: the one site in these populations is `window.triggerSlash` on the frame's own window, which Iris already serves | no |

The reason not to build them is the one §12 (`chat_metadata`) paid for: **these
guards fail upstream too, so their degraded branch is the baseline the card
author was writing against.** Adding the names brings dead branches to life. If a
card ever hard-depends on one, the single name goes in and the ledger records
"we activated a path upstream does not have" — which is the honest entry, and it
is not a free one.

### `Split`, `moment`, `d3`: zero real uses, and the phantoms named

The census reported `Split` 2 cards, `moment` 1, `d3` 1 as unmet bare globals.
Every hit is a literal collision. Read back with evidence lines:

| name | every corpus hit | verdict |
| --- | --- | --- |
| `Split` | `const parts = key.split(/[·・]/); // Split by '·' or '・'` (a comment); `/* Side Nav Styles for Split View */` (a CSS comment) | 0 real uses |
| `moment` | `.phone-moment-like-btn`, `data-moment-index`, `.moment-comment-box` (CSS classes and data attributes, 46 lines in one card); *"She complies after a moment of terrified hesitation"* (English prose in a rendered interface) | 0 real uses |
| `d3` | `.xr-d3{bottom:8px…}` (a CSS class); `const d3 = parseDataTriple(map['数据项三'])` (a local variable) | 0 real uses |

So: **nothing is seeded and nothing is refused by name.** Adding them to
`EXPECTED_GLOBALS` would be worse than silence in the other direction — that list
drives the missing-libraries banner, so three names no card wants would report a
gap on every card forever, which is how a banner stops being read. (Upstream's
page does carry `window.moment` via `lib.js:72`; nobody reaches for it.)

The lesson is the one the surface census exists to serve and did not: a
bare-identifier detector cannot tell a library from a comment, a CSS class or a
local, so **a bare-global count is a hypothesis and its evidence lines are the
measurement.** The three phantoms cost one planning round.

### `getPreset('in_use')`: refused with a number, not deferred

The one Tavern Helper member with a real corpus caller and no cheap answer.

- **Who calls it.** 魔法少女的扣扣审判1.0, script `外置状态栏`, two sites, both
  `if (usePreset && TavernHelper && typeof TavernHelper.getPreset === 'function')`
  → `TavernHelper.getPreset('in_use')`. It consumes exactly
  `preset.prompts[].{id, enabled, content, role}` and
  `preset.settings.{temperature, max_completion_tokens}`, to assemble its
  forum feature's own request to a user-supplied endpoint.
- **Upstream's contract.** `[TH] @types/function/preset.d.ts:180`
  `declare function getPreset(preset_name): Preset` — **synchronous**, returning
  the preset itself, throwing when it does not exist. So the faithful shape is
  the one `getVariables` and `getLorebookSettings` have: answered from the pushed
  snapshot, not a round trip. An async `getPreset` would put a member on the
  surface that lies about its contract, and the card's `preset.prompts` read
  would be `undefined` — the same silent skip it takes today, dressed as a
  feature.
- **The cost of the faithful shape, measured.** The two real presets in
  `apps/iris/data/default-user/presets` carry **500.5 KiB** and **342.5 KiB** of
  `prompts` JSON (220 and 246 prompts). The prompt *content* is the bulk and is
  precisely what the card needs — a projection without it would make the member
  present and useless in a worse way than absent, since the card's placeholder
  branches would fire while its text branches did not. Putting that in every
  frame's snapshot, structure-cloned per frame against `FRAME_COUNT_LIMIT` 19, is
  6–9 MiB of clone per reading window to serve one guarded call site in one card.
- **Two corrections to the surface audit** (`origin/dev/audit-th-surface`
  §4.1.1), which rated this P1 at S–M "delegate to the existing arm": there is
  **no `preset.get` host arm** at this revision — the preset methods are
  `list/read/view/save/select/delete/move/import/importFile/upsertPrompt/`
  `removePrompt/setEnabled`, and `preset.read` takes a *library name* and answers
  a stored file, which is neither "the preset in use" nor card-facing; and the
  estimate assumed an async shape upstream does not have.
- **Not given a named refusal either.** A throwing `getPreset` would make
  `typeof … === 'function'` true, so a `typeof`-guarded caller *without* a
  try/catch would go from silently skipping to crashing — a compatibility
  regression on a path that works upstream. This card has a try/catch; card 20 is
  under no obligation.
- **What would overturn it.** The preset library landing with a host-side arm and
  a decision about the synchronous contract (a preset pushed once per chat rather
  than per frame would change the arithmetic); a second card reaching for it; or
  a caller that needs only `settings` and not `prompts`, which is small enough to
  push.

### `registerMacroLike`: one caller, inside a bundle, and three places to change

OVERLORD不死者之王's `ERA` script — a MagVarUpdate webpack module — registers
`{{ERA:path}}` from a jQuery-ready callback. Upstream
(`[TH] @types/function/macro_like.d.ts:27`) registers into Tavern Helper's own
macro replacement, which participates in `substitudeMacros` **and** in what the
host assembles for the model. Serving it faithfully means an in-frame registry,
`substitudeMacros` running card macros before built-ins, and the host prompt path
sending text back for in-frame replacement — three places, and the function
cannot leave the frame. One caller, and the loss is "the ERA query macro is
unavailable" rather than a crash. Left unbuilt; the upgrade condition is a second
caller, or `{{ERA:…}}` appearing in corpus messages.

### Where these readings came from

Two audits on the user's own branches were read first and are credited: the
`top.X`-is-undefined-upstream finding, the `predefine.js` reading, the
`Split`/`moment`/`d3` disproof and the `alert`/`confirm`/`prompt` gap are all
theirs (`origin/dev/audit-st-context-surface`
`notes/apps/iris-web/ST-CONTEXT-SURFACE-AUDIT.md` §3.2, §4.2, §4.3;
`origin/dev/audit-th-surface` `notes/apps/iris-web/TH-SURFACE-AUDIT.md` §4.1).
Every upstream line number quoted above was re-checked against the install, and
every corpus count re-measured with its own evidence lines; the two divergences
found are the missing `preset.get` arm and `getCharData`'s evidence card
(人贩子物语), which is in neither corpus reachable from this tree — so that one
name can be neither confirmed nor built here.

> 复查（2026-09-17，e668785）：重开条件「预设库落地，带宿主侧臂与同步契约的裁决」已成立——证据 web §89（预设家族十八名）与 host §65。决定已随之改变：§89 按自己的数字推翻了本条对 `getPreset` 的拒绝。

## 86. The frame budget moves to 54 KiB and the gate to 18, because two branches spent the same headroom

**Kind:** cost, recorded where it was paid.

**Measured.** 2026-09-10, on the rebase of `dev/card-surface-used-members` onto a
main that already carried `dev/card-surface-census`: `build:sandbox` refused with
`a frame now costs about 54309 bytes (bootstrap 53285 + 1024 wrapper) but
FRAME_OVERHEAD_BYTES is 54272`. Each branch alone fit under 53 KiB — 52,947 bytes
with 301 to spare for the dialog names and the live `chat` array (§83, §84),
52,825 with 423 to spare for the `getContext()` absence report and the three `has`
repairs (§82) — and each report said so. Both measured their headroom against a
main the other had not reached yet, and the 1.8 KiB the 53 KiB row left was spent
twice.

**Now.** `FRAME_OVERHEAD_BYTES` is 54 KiB; the table in `frame-budget.ts` gains
the row `54 KiB | 37.9 | 19.0 | 19 | false → gate 18`, and `FRAME_COUNT_LIMIT` is
18: the invariant `FRAME_COUNT_LIMIT < degradesAt / 2` fails at 19 by four
hundredths of a frame, and 18 is the largest value that holds (to about 58 KiB).
Trimming 37 bytes out of the minified bootstrap to keep 19 was considered and
refused for the reason the table refused it twice before: it repairs the reading
to fit the instrument. The behaviour change is the one the gate always makes —
the nineteenth live frame on one screen becomes a named, openable placeholder —
and `WINDOWING.md`'s corpus measurement never reaches sixteen.

**What would overturn it.** A bootstrap slimming pass that moves the measured
frame back under 53 KiB with room to spare (the table would then get a row the
other way, and the gate its frame back); or the two-branch shape recurring, which
would argue for the seam itself (a `build:sandbox` run on the merge result, not on
each branch) rather than for another kibibyte.

> 复查（2026-09-17，e668785）：重开条件「一次 bootstrap 减重把预算拉回 53 KiB 以下」已成立——证据 2afa1f8 与 web §91（bootstrap 改为抓取，`FRAME_OVERHEAD_BYTES` 4 KiB、`FRAME_COUNT_LIMIT` 回到 20）。决定已随之改变（§91 记录）。

## 87. Tavern Helper's identity and message family is built — twenty from the snapshot, four over the wire, five answering the value upstream allows and saying why

**Kind:** compatibility gap closed, with four narrowings and one cost recorded.

**Measured.** Upstream 4.9.1, from the installed extension. Twenty-four members
the `@types` declare and Iris had not built, in five groups: the character
family (`getCharacterNames` `character.ts:52`, `getCharacterIds` `:59`,
`getCurrentCharacterName` `:63`, `getCurrentCharacterId` `:70`, `getCharacter`
`:240`), the raw-card family (`getCharData` `raw_character.ts:181`,
`getCharAvatarPath` `:197`, `getChatHistoryBrief` `:216`, `getChatHistoryDetail`
`:235`), the persona reads (`getPersonaNames` `persona.ts:53`, `getPersonaIds`
`:60`, `getCurrentPersonaName` `:67`, `getCurrentPersonaId` `:74`,
`getPersonaAvatarPath` `:302`, `getPersona` `:310`), the frame's own identity
(`getIframeName` `util.ts:74`, `getMessageId` `util.ts:109`, `getScriptName`
`script.ts:125`, `getScriptInfo` `:134`, `replaceScriptInfo` `:143`) and the
displayed-message family (`formatAsDisplayedMessage`
`displayed_message.ts:24`, `retrieveDisplayedMessage` `:88`, `refreshOneMessage`
`:92`, `rotateChatMessages` `chat_message.ts:468`).

**Nineteen of the twenty-four are synchronous upstream**, and that decides the
architecture rather than describing it: `getPersonaNames().includes(...)` reads
its answer in the same statement, `getCurrentCharacterId()` lands straight in a
comparison. A promise there breaks a card with no type error anywhere. So
nineteen answer from the pushed snapshot or from the frame's own state, and the
five that are asynchronous upstream too are the only ones that cross to the
host — four of them as new wire methods, and `getPersonaAvatarPath` as a refusal
(see below).

**Corpus: zero.** `card-surface-census.mjs` over both corpora finds no script,
interface, preset regex or world-book entry reaching for any of the twenty-four.
So none of this is firefighting and none of it is measured demand; it is the surface
being filled, and the census's face ① moves `Iris 建 54 → 78` with
`用到但没建` unchanged at 5.

### The snapshot grew by three fields, and each is the cheapest shape that works

`personas` (`{id, name}[]`), `persona` (the selected one in full) and `scripts`
(`{name, info?}` by script id). The persona split is a narrowing: the four list
members need names and ids, `getPersona` needs content, and carrying *every*
persona's description would hand a card the user's other alter egos' prompt text
for no measured demand. So one persona's content travels — the one this
conversation is being played with.

**Key-absent and empty are kept apart in all three**, because they are different
facts and the frame reports them differently: a host with no persona store omits
the key and the frame says so; a store holding nothing sends `[]` and the frame
answers upstream's own empty answer in silence. A `?? []` at either end would
have manufactured a clean zero.

### The four narrowings, all enforced on the host

Upstream takes any name in the library and hands over the whole card, including
its script bodies, and reads any of a character's chat files. A card script here
is consented to per card (`GRANTS.md`), so:

| member | upstream | here |
| --- | --- | --- |
| `getCharacter(name)` | any card in the library | `'current'`, or this conversation's card by name or id; anything else rejected by `unsupported` naming the narrowing |
| `getCharData(name)` | any card, whole `v1CharData` | the played card only, from the snapshot; any other card answers `null` **with a report** saying the null is Iris's scope and not a missing card |
| `getChatHistoryBrief(name)` | any character's chat list | this conversation's character; another answers `null` and reports, without asking the host |
| `getChatHistoryDetail(data)` | every named file, unbounded, in parallel | only files belonging to this character (checked on the host, because the frame is the untrusted side), at most 50 per call, floors without their per-swipe variable tables |

Two more departures worth naming because a card can see them:

- **Ids are Iris's, not avatar file names.** Upstream's `getCharacterIds`,
  `getCurrentCharacterId` and `getCharData().avatar` all answer a `foo.png`,
  because on SillyTavern the picture is the identity. They answer the host's
  `characterId` here, which is what every other Iris member takes. A card that
  round-trips the value finds its card; one that appends it to `/characters/`
  gets nothing, and never could have.
- **`getCharAvatarPath` answers Iris's own endpoint** (`/iris/avatar/<id>`),
  never a filesystem path. Upstream's own interface frames use this member in
  the `<style>` they inject into every message frame
  (`.char_avatar{background-image:url('${getCharAvatarPath()}')}`,
  `panel/render/iframe.ts:78-103`) — **Iris injects no such rule**, which is a
  separate gap, recorded here because building the member is what makes closing
  it possible.

### Five members answer the value upstream's contract allows, and say so once

The founding rule of §1 is that an unbuilt member answers `undefined` and is
reported. These five are *built* and still cannot do what upstream does, so they
answer a value upstream itself returns and report which limit produced it — the
`substidudeMacros` shape, whose sentence they deliberately echo:

- `getPersonaAvatarPath` → `null`. This host keeps no persona pictures at all;
  inventing a URL would put a broken `<img>` on the page with nothing saying
  why.
- `formatAsDisplayedMessage` → the text unchanged. Its three passes are macros,
  display regexes and markdown; the first two are the host's (the display tier
  runs there, so a floor's text arrives already regexed) and the third is a
  React component in the shell, while the member is synchronous. It keeps the
  whole of upstream's *argument* checking, including the throw, because that is
  a fact about the chat rather than about rendering.
- `retrieveDisplayedMessage` → an empty jQuery, which is upstream's documented
  answer for a floor that is not displayed. Here every floor is undisplayed to a
  card: the reading view is across an opaque origin and `parent.document` is
  container-scoped with no `#chat` in it, deliberately (`st-anchors.ts`).
- `refreshOneMessage` → nothing, once reported. Upstream's own fork detection
  takes the shape this host is in: on a *managed* chat surface it touches no DOM
  and calls `refreshManagedChatSurface()` (`displayed_message.ts:97-100`). Every
  host write here broadcasts `chat.updated` and the view re-renders, so the
  floor already shows what the file holds; what the member would add is a card's
  control over *when*, which needs a shell arm. **Left named rather than
  guessed at**, the ruling `reloadCurrentChat` has in §84. It does **not** emit
  `CHARACTER_MESSAGE_RENDERED`: announcing a render that did not happen would
  put a lie on the one bus a card can hear.
- `replaceScriptInfo` → remembered for the frame's life, reported as unstored.
  A card script's name and note are the **card file's**, so storing this would
  be writing the user's character file on a card's own initiative — a
  character-library write the grant model has no slot for. The mechanism is
  written down where the member is: a `script.setInfo` arm through the script
  policy store for a card script and through `scriptLibrary.save` for the user's
  own, which already carries `info`.

**One report per fact per frame**, not per call: these sit on members a status
panel calls in a redraw loop, and four hundred identical lines hide the other
findings. `parent-messages.ts` counts by shape for the same reason; the tenfold
reprises are omitted because none of these has a rate that means anything.

### `getCharData` omits the clipped description, and says which fields are gone

The snapshot's `description` is clipped to 200 code points, and 4 of the 19
corpus cards that carry one run 730 to 2851. Serving that clip under the field's
own name would be the quietest possible wrong answer: a card would put a fifth
of a description into a prompt and nothing would say so. So `description`,
`first_mes`, `personality`, `scenario` and `mes_example` are **absent**, the
report names all five, and it names `await getCharacter('current')` as the way
to the whole card. What it does answer is what the one measured call site reads
— `data.character_book.entries`, which the snapshot already carries for the
played card — plus name, id, tags, creator and `extensions.world`, the key
`RawCharacter.getWorldName()` reads.

### `getIframeName`'s trailing number is a placeholder, and is reported as one

Upstream's name is `TH-message--<floor>--<n>` or `TH-script--<name>--<id>`. The
script spelling is exact. The message spelling ends in `0`: upstream's own
number means different things on its two render paths and upstream never parses
it (`getMessageId`'s pattern takes only the floor), while Iris's frames carry an
opaque instance identity the member table cannot see. Reported once rather than
fabricated from something that looks like an index. `getMessageId` is upstream's
pattern verbatim, `_n` suffix included, and the two share the constant so the
name a card builds is the name the parser accepts.

### What it costs

**The inlined bootstrap grew 909 bytes: 53,285 → 54,194**, leaving **78 bytes**
under `FRAME_OVERHEAD_BYTES`. Attributed by two measurement builds rather than
by estimate: **652 bytes** are the twenty-four `MEMBER_KINDS` lines (the names
survive minification; the prose does not) and **257 bytes** are the four
`CARD_METHODS` pairs plus their four `OFF_ST_SURFACE` strings. The fetched
member table, where every implementation lives, grew 56.61 → 65.52 kB and costs
the frame budget nothing — it is fetched once per page.

**This is 92% of the headroom §86 left, and three sibling branches are spending
the same 987 bytes right now.** §86's own lesson was that each branch measured
against a main the others had not reached; this section is the second instance,
recorded before the merge rather than after it. The structural fix, if the merge
overflows: `MEMBER_KINDS` is 81 entries and roughly 2 KiB of the bootstrap, and
three of its four readers need only the *identity* names — `frame.ts:2319`,
`frame.ts:2418` and `preamble.ts:66`. Only `script-run-state.ts:262`'s
`Object.hasOwn` needs the whole set, and it could ask the live surface the frame
has already built. Moving the table to the fetched side would free the 2 KiB for
all four branches at once. Not done here, because it is a shared registry with
three branches in flight and the decision is the coordinator's.

The twenty-four entries are also written one per line rather than folded into a
compact spread that would have saved about seven bytes each:
`card-surface-census.mjs` reads `MEMBER_KINDS` out of the **source text** with a
per-line pattern, so a folded block would make every member in it invisible to
the caliper — which would then report them as declared-but-unbuilt, the exact
reading the census exists to get right. 168 bytes is not worth breaking the
instrument for.

**Pinned.** `apps/iris-web/tests/identity-messages.test.ts` (30 tests) and
`packages/iris-app-service/tests/identity-messages.test.ts` (15), plus the four
surface pins that grew (`identity.test.ts`'s identity set, `sandbox-frame.test.ts`'s
two exhaustive name lists, `rpc-transport.test.ts`'s wire probes) and
`rebuild-hydration.test.ts`'s classification of the new rebuild site.
Twenty-seven mutations were applied one at a time and each went red on its own
assertion — including the two that did **not**, at first: a rotation stripped of
its index mapping and a collapsed span stripped of its guard both stayed green,
because the first fixture wrote its floors with `script.createChatMessages`
(whose tables ride on the line itself, so they travel whenever the line does)
and because a collapsed rotation leaves the same file either way. The fixtures
were replaced with real turns carrying candidate tables and with a snapshot
count, and both mutations then went red. A green teeth check is a finding about
the test, not about the code.

**What would overturn it.** A card reaching for any of these five degenerate
answers and needing the real behaviour — the first one to appear in a corpus
scan is the one to build, and `refreshOneMessage` is the cheapest, since the
shell arm it needs is the one §84 already names. A measured card reading
`getCharData().description` would move the description into the played card's
summary (a bounded cost: 15 of 19 corpus cards carry none). And a card that
legitimately needs a *neighbouring* card's data would put the per-card grant
model itself in question, which is a decision above this surface.

---

## 88. The regex family reads and writes over the wire, because the tiers are too heavy to ride the snapshot

**Kind:** deliberate departure, measured.

**Upstream.** Tavern Helper declares five regex members and the *shape* of three
of them is the whole difficulty:

| member | upstream declaration | upstream implementation | signature |
| --- | --- | --- | --- |
| `getTavernRegexes(option)` | `@types/function/tavern_regex.d.ts:87` | `src/function/tavern_regex.ts:209-242` | **synchronous**, returns `TavernRegex[]` |
| `replaceTavernRegexes(regexes, option)` | `:103` | `:260-329` | `Promise<void>` |
| `updateTavernRegexesWith(updater, option)` | `:131` | `:335-343` | `Promise<TavernRegex[]>` |
| `isCharacterTavernRegexesEnabled()` | `:62` | `:196-200` | **synchronous**, returns `boolean` |
| `formatAsTavernRegexedString(text, source, destination, option)` | `:23` | `:27-73` | **synchronous**, returns `string` |

They are real functions on the ST page (`src/function/index.ts:424-428` puts
them on `globalThis.TavernHelper`, and `predefine.js` picks the surface off the
parent into every same-origin frame), so a card's call runs in the page's own
realm and returns before the next statement. Storage: `'global'` is
`extension_settings.regex`, `'character'` is
`characters.at(id).data.extensions.regex_scripts`, `'preset'` is the preset
body's `extensions.regex_scripts` — the same three tiers Iris already composes
(§30, §47, §53, and the host ledger §35 for the order).

**The measurement that settled it.** The two synchronous *readers* could only be
faithful by riding the pushed snapshot, the way `getCharWorldbookNames` and
`getLorebookSettings` do. Measured over `E:\sillyTavern` (read-only,
2026-09-10), the card tier alone:

| tier | rules | bytes (JSON) |
| --- | ---: | ---: |
| global (`settings.json`) | 0 | 2 |
| preset, largest of 4 files | 15 | 55,804 |
| card, median of the 15 that carry one | — | 134,819 |
| card, largest (创世回廊 1.3, 9 rules) | 9 | **1,090,531** |
| largest single `replaceString` | — | 524,550 chars |

251 rules in all, 173 in cards and 78 in presets. The snapshot is **inlined into
every frame's `srcdoc` as a double-JSON-encoded string literal**
(`srcdoc.ts:519-528`), uncached, one copy per frame; at `FRAME_COUNT_LIMIT` 18
that is about 2.4 MiB of frame source for a typical card and 19.6 MiB for the
worst one — paid by every card, including the whole corpus, which calls none of
these five (0 hits in both audits). That is the same cost that got `getPreset`
refused in §85, an order of magnitude larger.

**Now.** Three members are round trips — `regex.tavernList`,
`regex.tavernReplace`, `regex.tavernFormat` — and two are answered in the frame:

- **`getTavernRegexes` and `formatAsTavernRegexedString` return promises.** This
  is the departure. A card that awaits is unaffected, and this family's own
  documented examples await (its write half is async upstream); a card that
  treats the answer as an array or a string gets a `TypeError` on the frame's own
  answer. Refusing them outright — §85's treatment of `getPreset` — was the
  alternative, and is worse here: `getPreset` had a throwing-vs-absent argument
  about `typeof` guards, while these two are useful the moment a card awaits.
- **`isCharacterTavernRegexesEnabled` really is synchronous**, because its answer
  is one boolean: `ScriptContext.characterRegexAllowed`. **Absent means allowed**,
  Iris's default for the card tier and a standing divergence from upstream's
  (§30) — so a card asking this on a fresh install gets `true` here and `false`
  there.
- **`updateTavernRegexesWith` is composed in the frame** from the other two,
  exactly as `updateWorldbookWith` is, because it takes a function. It returns
  **the stored tier** rather than the updater's array (upstream returns the
  array), because the host fills in a blank name and carries unnamed fields
  across, and those are changes a card cannot otherwise see.
- **Both signatures of both mutable members are answered**, the new
  `{type, name}` one and the deprecated `{scope, enable_state}` one, with
  upstream's two refusal strings character for character. The deprecated read is
  the only answer in which the tier order is visible — global rows first, then
  the card's, with each row carrying the `@deprecated` `scope` tag — and it omits
  the **preset** tier, which runs between those two. That omission is upstream's.
- **`name` is refused, not ignored.** Upstream resolves `option.name` through
  `RawCharacter.findIndex` / `getCompletionPresetByName`, so a card there reads
  and writes any installed card's tier and any saved preset's. Here the tier is
  resolved from the `chatId` the shell stamps on every card action, so
  `'character'` is the conversation's own card and `'preset'` the active one;
  `'current'` and `'in_use'` pass through and any other name is refused by name.
  Ignoring it would answer with this card's rules under another card's name — and
  a card that wrote the list back would overwrite the wrong document.
- **A `'preset'` write is refused** (`unsupported`, saying the library is
  read-only). Upstream writes both `oai_settings` and a named preset file.
- All five sit in `OFF_ST_SURFACE`: none is among `st-context.js`'s 145 keys, so
  `SillyTavern.getTavernRegexes` would be Iris inventing a member on the surface
  it mirrors. All five are `shared` in `MEMBER_KINDS` — a regex tier is a
  document, and none of the five carries a scope or a script id.

**Cost.** The bootstrap grows **260 bytes** (53,536 → 53,796 raw; `bootstrap
check` reports 53,712 and a frame overhead of about 54,736 against the budgeted
55,296), all of it `card-api.ts`'s three table entries and five deny-list
strings. That leaves 560 bytes under the 54 KiB row of §86, and three sibling
branches are adding to the same two tables — so the merge is where this is
decided, not here.

**Pinned.** `apps/iris-web/tests/tavern-regex-facade.test.ts` (19 tests): the
five names bare and under `TavernHelper`; the routable three against the
frame-answered two; the deny list and the identity classification; both
signatures of both mutable members including the two upstream strings; the
deprecated read's order and tag and its `enable_state` filter; the deprecated
write's partition, with an **untagged** row belonging to the card (upstream's
`_.partition` falsy half); the `scope` tag stripped before a strict schema sees
it; a foreign `name` refused; `updateTavernRegexesWith` composed from the two
locals rather than through the published object, and awaiting an async updater;
the gate synchronous, snapshot-read, absent-means-allowed; `depth: 0` surviving
(a truthiness check would drop the commonest value); `character_name` renamed at
the boundary; a bad source or destination refused in the frame. Thirteen frame
mutations, each red on its own assertion.

**What would overturn it.** A card measured calling `getTavernRegexes` without
awaiting — the promise would then be a real break, and the answer would be to
push a *projection* (names, ids and switches, no bodies) and refuse the bodies,
which is a different member than upstream's; or a snapshot channel that is not
per-frame source bytes (a shared `SharedArrayBuffer`, a fetched per-chat blob),
which would make the tiers affordable and the whole departure unnecessary.

## 89. The preset family is eighteen names, `getPreset` is synchronous and whole, and the refusal §85 recorded is overturned by its own numbers

**Kind:** card surface built, one refusal reversed, two deliberate departures and one addition.

### The refusal this replaces, and why the numbers read differently

§85 refused `getPreset` with a measurement: upstream answers a `Preset`
synchronously, so a faithful shape must ride the pushed snapshot; the two real
presets' `prompts` are 500.5 and 342.5 KiB; times `FRAME_COUNT_LIMIT` 19 is 6 to
9 MiB of structured clone per reading window, for one guarded call site; and a
throwing function would turn a `typeof`-guarded card from a silent skip into a
crash. Every one of those readings reproduces (2026-09-10, both corpora, 8 real
presets — `[主预设] V19.5 狐神抚 · 毓忻.json` at 500.5 KiB of `prompts` and
`咩咩预设 - ver 5.8.1` at 342.5 KiB). What was missing is that **the byte total was
never converted into a cost**:

| what | measured 2026-09-10 |
| --- | --- |
| `structuredClone` of the heaviest preset's prompt graph | 0.481 ms per frame → 8.7 ms per 18-frame window |
| the same data as one JSON **string** | 0.252 ms per frame → 4.5 ms per window |
| `JSON.parse` of that string, once, only if a card asks | 0.304 ms |
| the snapshot this rides, as it already stands | ~145 KB, ~1.75 s for the host to build (`client/in-flight.ts`) |

8.8 MiB sounds fatal; 8.7 ms against a 1.75 s snapshot build does not. The
refusal was right about the bytes and wrong about the conclusion, and the two
halves are recorded separately here because the number stays true.

### What the corpus actually reads, which decides the shape

One card in 19 — 魔法少女的扣扣审判1.0, script `外置状态栏` — and it reads:

```js
if (usePreset && TavernHelper && typeof TavernHelper.getPreset === 'function') {
    const preset = TavernHelper.getPreset('in_use');
    if (preset && preset.prompts) {
        preset.prompts.filter(p => p.enabled).forEach(prompt => {
            if (prompt.id === 'worldInfoBefore') { /* … */ }
            else if (prompt.content) {
                finalMessages.push({ role: prompt.role || 'user', content: prompt.content });
```

`prompts`, `enabled`, `id`, `role` and **`content`** — the last one both as a
truthiness test and as the payload. That kills two of the three candidate
answers, and it kills them silently, which is the point:

- **metadata only** (names and flags, content fetched on demand) makes
  `else if (prompt.content)` false for every normal prompt, so the card
  assembles a message list with its world-info blocks and none of the preset's
  text, and reports nothing;
- **`async getPreset`** makes `preset && preset.prompts` false — a promise is
  truthy and has no `.prompts` — so the whole branch does nothing, inside a
  `try`/`catch` that never fires. Observably identical to today's skip, except
  that the `typeof` guard now passes and every census reads the member as built.

### Now

Eighteen names, all on both spellings a card writes (bare, and under
`TavernHelper` — `predefine.js` produces the bare set by merging that object's
own keys).

**Four are synchronous, from the snapshot.** `ScriptContext.preset` carries
`{ names, loaded?, inUse?, refusal? }`, where `inUse` is the whole `Preset` **as
JSON text**. `getPreset` parses it once per distinct text — the cache's entire
invalidation rule is `!==` on the string, so there is no second place to be wrong
about what changes a preset — and per-call freshness comes from the surface's one
`detachReturns` clone, which is upstream's `klona`. `getPresetNames` answers
`['in_use', ...library]`, `getLoadedPresetName` the name the running body was
loaded from, and `loadPreset` a boolean it decides from the name list before
firing the switch unawaited, which is upstream's own shape.

**It rides the snapshot rather than a channel of its own**, and that was a real
choice: the in-use preset is host state, not chat state. But a preset switch
already reaches every live frame through this field — `#applyPreset` ends in
`#refreshRegex`, which re-announces every open chat, which is the `chat.updated`
that `MessageInterfaces`' `watchContext` answers by refetching the snapshot. A
second channel would have been a second freshness rule for one fact.

**Fourteen are asynchronous or pure.** `createPreset`, `createOrReplacePreset`,
`replacePreset`, `updatePresetWith` and `setPreset` compose over **one** wire
method plus the round-trip read, which is upstream's own composition
(`preset.ts:596`, `:705`, `:718`, `:731`); `deletePreset`, `renamePreset` and
`loadPreset` have arms of their own because each carries a consequence beyond the
file (host §65). The three `isPreset*Prompt` guards, `default_preset` and the
built-in order come from `@iris/compat-tavernhelper-core/src/preset.ts` — the
same module the host writes presets back through, so the guard a card calls and
the `system_prompt` / `marker` flags the file records cannot disagree by an
identifier.

### The two departures, and one addition

**`getPreset('某个预设名')` throws.** Upstream reads the library synchronously; a
frame cannot. The throw is the right shape for saying so — upstream throws for a
name it cannot resolve, so a card's `catch` already handles it — and the sentence
names `loadPreset` and `updatePresetWith` as the ways in. Measured: the corpus
passes the literal `'in_use'` and nothing else, which `notes/TEST-CARDS.md:297`
recorded on 2026-09-02 and this branch re-measured across both corpora.

**The frame's copy leaves out two `extensions` sub-trees and says so.** Measured
over the eight real presets: the heaviest whole `Preset` is 5,961 KiB, of which
5,040 KiB is `extensions.tavern_helper` (that preset's own script library) and
202 KiB `extensions.regex_scripts` — 105 MiB of clone per 18-frame window for two
keys no body in the 1,694-source corpus reads. Without them the same preset is
719 KiB. They are named **inside the body** at `extensions.iris_omitted`, and the
write arm restores them from the stored preset when the marker is there, so
upstream's own documented round trip (`const p = getPreset('in_use');
p.settings.should_stream = true; await replacePreset('in_use', p)`) cannot delete
a preset's script library as a side effect of turning streaming on. A card that
supplies the key itself is replacing it, and the restore stands aside. The
asynchronous `script.getPreset` carries everything untrimmed; that one is a round
trip on demand rather than a clone per frame.

**`placeholder_prompt_default_order` is published, and upstream does not publish
it.** Upstream declares it as a global (`@types/function/generate.d.ts:326`) and
its own JSDoc tells authors to prefer it over the deprecated
`builtin_prompt_default_order` — but it is not a key of the `TavernHelper`
object, `predefine.js` seeds a card's bare globals by merging that object's keys,
and the string occurs **0 times** in the shipped `dist/index.js` against 1 for
the deprecated spelling. So a card written against the type declarations dies on
real SillyTavern. This is the one place in the family where Iris adds rather than
mirrors, and it is cheap and pinned: the two names are the **same array object**,
asserted by identity, so they cannot drift.

### Refused, with the reason

**`builtin`** (`@types/function/builtin.d.ts:1`) is not built. It is a bag of 16
SillyTavern internals — `addOneMessage`, `promptManager`, `renderMarkdown`,
`reloadEditorDebounced`, `saveSettings`, `uuidv4` and the rest — with **0 corpus
hits** across 19 cards, 4 presets and 24 world books. Of the 16, four have an
honest Iris answer today (`uuidv4`, `copyText`, `duringGenerating`,
`parseRegexFromString` — the last already living in
`@iris/compat-tavernhelper-core/src/regex.ts`); the other twelve are pokes at
SillyTavern's own DOM. Building it as a **partial** object is the trap §85 named,
running the other way: `typeof TavernHelper.builtin === 'object'` would start
passing, and the card behind that guard would then read `undefined` off
`builtin.promptManager` and crash where it silently skips today. So it stays
absent, and the four answerable names are written down here so a later branch
does not have to re-derive them.

### The cost this branch spends, beside the ones it saves

Two, and both belong to whoever lands next. The bootstrap grows **53,369 → 54,116
bytes (+747)** — all of it the two registry tables, `MEMBER_KINDS` gaining 21
string keys and `CARD_METHODS`/`OFF_ST_SURFACE` five each — which leaves **240
bytes** under the 54 KiB `FRAME_OVERHEAD_BYTES` §86 had just moved to. And every
`script.context` now costs an extra `PresetStore.list()`, measured at **~25 ms**
against the real two-preset library (6.0 MB + 640 KB, every file parsed to
validate it) on a snapshot the host already takes ~1.75 s to build.

**What would overturn any of this.** A corpus card that calls `getPreset` with
anything but `'in_use'` (the throw becomes a gap worth closing with a preloaded
library, or with an async-only named read); a card that reads
`extensions.tavern_helper` or `extensions.regex_scripts` off a preset (the trim
becomes a fidelity bug, and the ceiling has to move instead); a card that reaches
`builtin` at all (build the four, report the twelve by name); upstream exporting
`placeholder_prompt_default_order`, which would turn this addition into plain
parity; or a fourth branch needing bootstrap room, which would argue for moving
`MEMBER_KINDS` out of the inlined core and into the fetched member table rather
than for another kibibyte — the table is data, and the frame reads it only to
decide which members to rebind.

## 90. The `Lorebook` vocabulary Tavern Helper renamed, over the `Worldbook` one it renamed it to — and the four writes the new family was missing

**The premise this landed with was wrong, and the correction changes the shape
of the work.** The dispatch said upstream implements the old `Lorebook` API as a
compatibility layer over the new `Worldbook` one, so the aliases would be a
rename plus a field map. Read: `src/function/lorebook.ts` and
`src/function/lorebook_entry.ts` implement the old names **directly** against
SillyTavern's own state (`world_names`, `loadWorldInfo`, `saveWorldInfo`,
`chat_metadata`, and a `$('#character_world')` write), and it is the *new*
module that delegates to the old one — `worldbook.ts:50-82` builds four of its
binding members out of `getCharLorebooks`, `getChatLorebook`, `setChatLorebook`
and `getOrCreateChatLorebook`. The two entry vocabularies meet **nowhere**
upstream: each converts to and from the raw stored row on its own
(`toLorebookEntry` at `lorebook_entry.ts:133`, `fromPartialLorebookEntry` at
`:223`; `toWorldbookEntry` at `worldbook.ts:205`, `fromWorldbookEntry` at
`:262`). Iris has no raw row in the frame — the host owns storage and the wire
carries the new shape — so the old vocabulary is composed *through* the new one
here, with the raw row as a pivot read out of both converters.

**Why the old names are built at all, against the surface audit.**
`TH-SURFACE-AUDIT.md` groups these sixteen names as **不补** — the whole family
is `@deprecated`, each declaration points at its replacement, and corpus usage
measured **zero** in both corpora. That reading is correct and the conclusion is
overturned here, on the coordinator's dispatch of 2026-09-10 and for three
reasons: the corpus is 19 cards and one sample, so a zero there bounds nothing
about card 20; these were upstream's *only* spelling until 4.x, and they still
work there — `@deprecated` is advice to whoever writes the next card, not a
member that stopped working; and the failure mode is not a no-op but a
`TypeError` in a card's first statement, because the measured idiom is
`getCharLorebooks().primary`. Recorded rather than quietly done, per the rule
that a peer's ruling is overturned in writing or not at all.

**Twenty members, three new wire routes.** Seventeen of the twenty are composed
in the frame out of routes that already existed, which is the ratio the family's
shape predicts: the old names are a second spelling of members already here.

| member | how | note |
| --- | --- | --- |
| `createOrReplaceWorldbook` | `worldbook.create`, then `worldbook.replace` if it existed | one call for an absent book: the host's create takes entries |
| `deleteWorldbook` | `worldbook.delete` (**new**) | host §66 |
| `deleteWorldbookEntries` | `worldbook.get` + `worldbook.replace` | takes a predicate, so it cannot cross the boundary |
| `rebindCharWorldbooks` | `worldbook.setCharBooks` (**newly routed**) | `primary` refused; see below |
| `getLorebooks` | snapshot `worldbookNames` | synchronous, like `getWorldbookNames` |
| `createLorebook` | `worldbook.create` | |
| `deleteLorebook` | `worldbook.delete` | |
| `getCharLorebooks` | snapshot `charWorldbooks` | `type` accepted and ignored — upstream ignores it too |
| `getCurrentCharPrimaryLorebook` | the same read's `.primary` | |
| `setCurrentCharLorebooks` | `worldbook.setCharBooks` | same local as `rebindCharWorldbooks` |
| `getChatLorebook` | snapshot `chatMetadata` + names | same local as `getChatWorldbookName` |
| `setChatLorebook` | `worldbook.bindChat` | `null` unbinds |
| `getOrCreateChatLorebook` | the local `getOrCreateChatWorldbook` composes | upstream's exact name-minting recipe |
| `setLorebookSettings` | `worldbook.setSettings` (**newly routed**) + `worldbook.setGlobalSelect` | synchronous, `void` |
| `getLorebookEntries` | `worldbook.get` + the mapping + upstream's `filter` | |
| `replaceLorebookEntries` | `worldbook.replace` with the **old** defaults | |
| `updateLorebookEntriesWith` | read, updater, replace | not on the dispatch's list; see below |
| `setLorebookEntries` | read, `_.merge` per uid, replace | |
| `createLorebookEntries` | read, lowest free uid, replace | |
| `deleteLorebookEntries` | read, filter by uid, replace | |

`updateLorebookEntriesWith` was not on the branch's list of names and is built:
upstream constructs `setLorebookEntries`, `createLorebookEntries` and
`deleteLorebookEntries` on top of it (`lorebook_entry.ts:361`), so leaving it
out would have made the vocabulary five sixths complete with the missing sixth
the one every sibling is a composition of. No other branch owns it.

**The mapping** (`lorebook-aliases.ts`, whose header carries the full table and
the upstream line numbers). The five asymmetries are copied rather than
repaired, and each is a place a "cleaner" implementation would be silently
wrong:

1. **The default entry is not the same entry.** An old partial with no `type`
   becomes `selective` (`default_original_lorebook_entry`, `:99`); a new partial
   with no `strategy` becomes `constant` — always on (`worldbook.ts:272`). So
   `replaceLorebookEntries(book, [{uid: 0}])` and
   `replaceWorldbook(book, [{uid: 0}])` write **different entries**, and this is
   why the old write leg fills in a complete entry from the old defaults instead
   of forwarding the partial. Forwarding passes every other test and turns a
   card's blank entry always-on.
2. **The old getter revives no keys**, so the mapping reads the wire shape
   before revival. `LorebookEntry.keys` is `string[]` upstream and
   `getWorldbook` hands out `RegExp` objects; `readWorldbookRows` is split out
   of `readWorldbook` for exactly this, so "how a book is fetched" stays one
   decision and revival is the only thing the two readers differ by.
3. **`key` and `filter` are readable and not writable.** Upstream's getter sets
   all four spellings (`:157`, `:167`); its writer has transformers for `keys`
   and `filters` only (`:262`, `:271`). A card writing `key` is ignored *there*
   too, so both halves are reproduced — a card that "works" here and drops its
   keys on real SillyTavern is the worse outcome.
4. **`outlet` has no old spelling.** Upstream's old getter maps six position
   codes by table and sends everything else through the role fallback
   (`:141-152`), so position 4 *and* 7 read as `at_depth_as_<role>`; writing
   that back stores `at_depth`. An outlet is lost by a round trip through the
   old API, upstream's included. **0 of the 2476 entries** in the two real
   corpora sit at position 7.
5. **`display_index` cannot line up, and that is upstream's doing.** The new API
   dropped the field and derives `displayIndex` from array position
   (`fromWorldbookEntry`'s second parameter *is* the index); this host does the
   same on every write, and `worldbook.get` does not carry it. So the value a
   card reads is the entry's **position in the book**. Measured over the 29 real
   books (2476 entries): the stored `displayIndex` equals the entry's ordinal
   for 1966 of them, so **21% of real entries would read a different number**
   under upstream's old getter.

**Two orderings measured rather than assumed.**

- `getLorebookEntries` answers in the host's **`displayIndex` order**, not uid
  order. Upstream's old getter effectively answers in *uid* order — its storage
  is an object keyed by uid, so `_(data.entries).values()` walks integer-like
  keys ascending — while its own new API sorts by `displayIndex`. Copying the
  uid order here would be actively destructive: this host renumbers
  `displayIndex` from array position on every write, so a card's
  read-modify-write would permanently reorder the book, and **14 of the 29 real
  books have a uid order that differs from their displayIndex order**.
- `createLorebookEntries` mints the **lowest free** uid (`:391`), not the random
  one the replace path uses (`:315`), because `new_uids` is what a card holds on
  to in order to find its own entries again.

**`_.merge`, not a spread.** `setLorebookEntries` patches with
`_.merge(data_entry, entry_to_set)` (`:377`), and lodash merges two arrays
**index by index**: patching `keys: ['a']` over `['x','y']` leaves `['a','y']`.
A spread would drop the tail, so a card narrowing a key list would leave this
host's book activating on keywords the card removed — with no error anywhere.
Reproduced in `mergeLorebookEntry` rather than by importing lodash, because the
old entry shape is flat and the whole of merge's behaviour over it is that rule
plus "an `undefined` source does not overwrite".

**Three writes the old vocabulary cannot carry, and one it cannot read.**
`outletName`, `triggers`, `characterFilter` and `ignoreBudget` exist on disk,
have no old spelling, and are therefore **reset across the whole book by any
write through this vocabulary** — upstream's old writer loses the same four, its
default row having no key for any of them. And `probability` is unrecoverable
for an entry with `useProbability: false`: this wire (and upstream's new API,
`worldbook.ts:241`) reports 100, while upstream's old getter reports the stored
number. 23 of the 2476 real entries are in that state; reporting what the entry
actually does beats inventing a number nobody sent. The write leg sets
`useProbability: true`, which is upstream's old default row doing the same
thing.

**The one thing this family cannot do: change a character's primary book.**
Upstream's `setCurrentCharLorebooks` writes it into the **card file** — it drives
`#character_world` and posts `/api/characters/edit` (`lorebook.ts:263-284`) —
and this host has no arm for that: `worldbook.setCharBooks` is
`world_info.charLore`, the additional list, and its contract says the primary
"lives on the card, and the card file is shared between installations". So a
`primary` that would **change** is refused by name with nothing written; a
`primary` that is unchanged is not a request, because the shape a card writes is
`setCurrentCharLorebooks({...getCharLorebooks(), additional: […]})`. The
existence check covers the additional list **only**, which departs from
upstream's `_.concat` of both (`:255`): a primary whose file is gone is a normal
state here — `getCharWorldbookNames` reports the binding rather than the book in
use, and 2 of the corpus's 18 bindings dangle — so validating it would refuse
the ordinary call over a name this host cannot write anyway. Found by this
branch's own first test run, not by reading.

**The character is named by the shell, never by the card.**
`worldbook.setCharBooks` takes a `characterId` and the frame is the untrusted
side, so a card supplying one could rewrite the bindings of a character the user
did not open. Both members accept only `'current'`, and `client/store.ts` fills
in `view.characterId` — spread **after** the card's own params so a frame that
sends its own is overridden. Same division as `runId` for an injection, and
pinned by a `store.test.ts` case that deliberately sends a hostile
`characterId`.

**`setLorebookSettings` is synchronous and `void`, because upstream's is** — MVU
has a call site that does not await it. So the validation happens before
anything is sent (upstream's own order: refuse the whole call when the global
selection names a book that does not exist, one throw carrying **every** missing
name, `lorebook.ts:191`; then apply only the fields that differ from what is set,
`:198`), and the two writes are fired with their failures reported rather than
thrown — an asynchronous throw from a `void` member arrives as an unhandled
rejection with no card frame in the stack, the precedent `writeButtons` set.
The sixteen fields split three ways: twelve knobs to `worldbook.setSettings`
under this host's own names (`context_percentage` → `budgetPercent`, `max_depth`
→ `minActivationsDepthMax` — both misleading names mapped by meaning),
`selected_global_lorebooks` to `worldbook.setGlobalSelect`, and
**`overflow_alert` to nothing**: this host stores no such knob, so it is
reported as a gap rather than accepted, because accepting it would make the next
read disagree with what the card just set, silently.

**Cost: the bootstrap grows 53,285 → 54,059 bytes (+774).** The members
themselves and the whole mapping module ride the **fetched member table**, which
the budget does not bill; what grew is the three inlined tables the frame's core
reads — 20 `MEMBER_KINDS` entries, 3 `CARD_METHODS` entries, 3 `OFF_ST_SURFACE`
entries. Frame overhead is now about 55,083 bytes against `FRAME_OVERHEAD_BYTES`
= 55,296, so this branch alone fits with **213 bytes to spare where it found
987**. §86 is the standing warning about exactly this: three sibling branches
are spending the same headroom against the same main, and the constant will have
to move — and `FRAME_COUNT_LIMIT < degradesAt / 2` re-checked — when they land
together rather than one branch at a time.

**Pinned.** `lorebook-aliases.test.ts` (44 tests, split deliberately: the pure
mapping field by field in both directions, the members through the real façade
with a recording host, so what is asserted is the call that would cross the
boundary), plus one case in `store.test.ts` for the injected `characterId`, and
the two pinned bare-surface lists in `sandbox-frame.test.ts` grow by twenty
names. 21 mutations across the mapping, the members and the shell each turned
exactly the expected assertion red — including "the arrays are replaced instead
of merged index-wise", "the old default is `constant`", "the primary refusal is
removed", "the frame may name the character" and "the settings write becomes
asynchronous".

**What would overturn it.** A host arm that can write a card's `extensions.world`
— the primary refusal would become a real rebind, and `rebindCharWorldbooks`
would then match upstream field for field; a `worldbook.get` that carries the
stored `displayIndex`, which would let `display_index` be the number upstream
reports rather than the ordinal (and would then need a rule for what a write
does with it, since this host renumbers); a measured card that reads
`probability` off an entry whose roll is disabled; SillyTavern giving `outlet` an
old-vocabulary spelling, which would end asymmetry 4.

---

## 91. The frame bootstrap is fetched, not inlined — and the premise that made it inline is now checked three ways

**Kind:** deliberate divergence from our own earlier design, with a measured cost
paid in the opposite direction from the one it saves.

**What was there.** Every card frame is an opaque-origin `srcdoc` document, and
the 53 KB bootstrap was **inlined into each one**. The reason is written in
`srcdoc.ts`'s own header and it was a real one: a card's interface markup runs
its scripts at **parse** time and reads bridged names immediately — drawing a
status panel from `getAllVariables()` is the point of it existing — so the
bootstrap has to have finished before the body parses. The judgement at the time
was that fetching would lose that race, plus two secondary arguments: an
opaque-origin frame has no useful same-origin path, and a stable public URL is
one more answer that could be substituted.

The cost of that decision is the entire history in `frame-budget.ts`. The
bootstrap is charged **per frame with no cache**, the reading window's byte
budget is denominated in that charge, and the count gate is derived from it — so
every kilobyte the bootstrap grew was a kilobyte charged twenty times, and the
gate moved four times to pay for it: 39 KiB with the gate at 20, then 52 → gate
19, 53 → 19 held, 54 → gate 18 (§86, and that last one was two branches spending
the same 1.8 KiB). Four rounds of the same event. Each was answered by moving
something into the fetched member table, which worked and never asked why the
bootstrap was inlined at all.

**What upstream does.** Tavern Helper's message iframes carry no client code in
their `srcdoc` — only a row of `<script src="…">` tags (`predefine`,
`parent_jquery`, `adjust_iframe_height`, `adjust_viewport`, `cleanup_protector`,
Tailwind), all same-origin and browser-cached, so each frame's inline cost is a
handful of tags. Read from
`data/default-user/extensions/JS-Slash-Runner/dist/index.js`.

**The premise, restated correctly.** "The bootstrap must finish before the body
parses" is true. "Therefore it must be inlined" does not follow: a **classic
`<script src>` with no `async`, `defer` or `type`** blocks the parser until it
has run. That is not a hope about timing — it is the mechanism the **member
table** has run on since it was split out of the bootstrap, and the mechanism the
card libraries have always run on, both in this very document, both already
depended on by every frame that works. The inlining was buying a property it
already had by another route.

**Now.** The frame's head and body carry, in order: the CSP, token and origin
metas, the FontAwesome sentinel, the reset, then the member table tag, the
context seed, **the bootstrap tag**, the guard, the card libraries, the card
markup.

```
<script src="{origin}/sandbox/bootstrap-{hash}.js" crossorigin="anonymous" data-iris-bootstrap></script>
```

`crossorigin="anonymous"` for the reason the member table and libraries carry it:
an opaque origin redacts a cross-origin throw to the bare words `Script error.`,
and for this file that would erase the frame's only diagnostic. Its other half —
the host's `access-control-allow-origin` on the sandbox-asset route — already
existed. Nothing per-frame goes in the URL: the token and origin travel in
`<meta>` tags and the snapshot in the inline seed, exactly as before, because a
URL that varied per frame would be a fresh cache key per frame.

**The srcdoc, byte for byte.** Measured through `buildSrcdoc` over all four
frame shapes:

| | before | after |
| --- | --- | --- |
| script frame, network closed | ~54.7 KB | **2,448 B** |
| interface frame, network closed | ~54.8 KB | **2,572 B** |
| interface frame, 51-char origin | — | **3,006 B** |
| of which: bootstrap guard | — | 1,187 B |
| of which: three script tags | — | 376 B |
| of which: CSP, metas, sentinel, reset, body tag, doctype | — | ~1,009 B |

`FRAME_OVERHEAD_BYTES` is **4 KiB**, measured rather than allowed for —
`check-bootstrap.mjs` now builds eight real documents — two frame kinds × two
grant states × the dev origin and a deliberately long deployment origin — and
weighs the widest, where it used to add a stated 1 KiB "wrapper allowance" to
the artifact's size. The long origin is in there because the shell's origin
appears **seven times** in a frame document, so the wrapper's size depends on
where Iris is deployed and measuring only at `127.0.0.1` would budget for the
developer's machine. 4 KiB rather than 3: 3 KiB clears the widest shape by 66
bytes, which is the headroom §86 watched two branches spend at once, and an
overrun here no longer costs a live panel — it is a one-line bump.
`FRAME_COUNT_LIMIT` is back to the design's **20**: the degradation point is
512 frames, the invariant `FRAME_COUNT_LIMIT < degradesAt / 2` holds by a
factor of thirteen, and the gate is chosen by "how many live panels is still
reading" rather than by bytes. The table in `frame-budget.ts` gains its closing
row `4 KiB | 512.0 | 256.0 | 20 | held`.

**This is a change of dimension, not a loosening, and it is worth being exact
about.** `FRAME_OVERHEAD_BYTES` has always meant "bytes of `srcdoc` charged per
frame". What left the `srcdoc` is 53 KB of build artifact, so the same measure of
the same quantity reads 3.0 KB. No threshold was widened; the byte budget did not
grow; the bill has excluded fetched artifacts since the member table split, so
the bootstrap joining them changes no rule. `frame-budget.test.ts`'s sanity band
on the ratio (`degradesAt > 30 && degradesAt < 60`) could not survive that and
was **not widened to 30..600** — widening it would have been the move that file
has refused twice. It is replaced by a rail in the dimension that changed: the
overhead must be between 1 KiB (a frame cannot cost less than its own CSP and
guard) and 8 KiB (above that, a build artifact is inlined into the frame again).
That second bound is the regression `FRAME_COUNT_LIMIT` can no longer feel, and
it is the reason a rail is still there at all.

The build's **waste** warning was rebuilt for the same reason and is the one
place a threshold did move. It fired when the constant sat more than a quarter
above the measurement, on the reasoning that overstating makes the budget
tight; at 54 KiB a quarter was 270 KiB across a full gate, an eighth of the
whole budget, and at 4 KiB it is 20 KiB, 1%. So the fraction is kept **and**
paired with a materiality test — the waste has to exceed 5% of the budget
across a full gate. Moving 0.75 to 0.70 would have silenced the same reading
without saying anything, which is the difference between the two edits.

### The cost, measured, in the direction this move makes worse

**Every frame downloads it again.** Measured 2026-09-10 over CDP against the
product's own `serveSandboxAsset` route, three interface frames on one page,
resource timing read from inside each frame (`transferSize > 0` means bytes
crossed the wire; `transferSize 0` with `decodedBodySize > 0` would mean a cache
hit — the distinction `transfer-cost.ts` exists to draw):

| frame | bootstrap transferSize | decodedBodySize | duration |
| --- | --- | --- | --- |
| 1st | 53,802 | 53,502 | 1.3 ms |
| 2nd | 53,802 | 53,502 | 1.2 ms |
| 3rd | 53,802 | 53,502 | 1.0 ms |

`cache-control: public, max-age=31536000, immutable` on all three — the same
header the preset gets, because the host derives its immutable set from
`manifest.json` and `bootstrap-<hash>.js` has been in that manifest since the
artifacts were hashed. **The header buys nothing here**: every chat, and as this
measurement shows every *frame*, is a fresh opaque origin, and the HTTP cache is
partitioned by it. `RENDER.md` established this across chats; this is the same
finding one level finer.

The declining durations are **not** a cache effect and must not be read as one.
`transferSize` stays at 53,802 in all three; what falls is a warm server and a
warm connection.

So the honest ledger of the trade:

- **Before**, the shell fetched the bootstrap's source **once per page**
  (memoised at module scope in `MessageInterfaces.tsx`) and inlined it N times.
  Wire cost: 53 KB per page. `srcdoc` cost: 53 KB × N.
- **After**, wire cost is 53.8 KB × N and `srcdoc` cost is 2.6 KB × N. At
  N = 20 that is **+1.02 MB of transfer** and **−1.06 MB of markup**.

**Why that is accepted, with the number that decides it.** An interface frame
already fetches, per frame, in the same partition:

| artifact | per frame | share |
| --- | --- | --- |
| message preset | 1,658,336 B | 93.7% |
| member table | 56,908 B | 3.2% |
| **bootstrap (new)** | **53,802 B** | **3.0%** |
| total | 1,769,046 B | |

The bootstrap's new wire cost is **3.0% of what the frame was already paying**,
and it is the same magnitude and the same mechanism as the member table, which
has been paid per frame for months without anyone arguing about it. On loopback
the whole of it is 1.0–1.3 ms per frame, ~25 ms across twenty frames. The
per-frame `library cost:` note reports all of it already, so the day the host
moves to a remote machine the panel makes the number ugly by itself — and the
answer then is the one the 1.66 MB preset needs first, not this.

### Three checks, because the premise is a browser fact and this project has been wrong about browser facts

The move rests on one sentence — *a blocking classic script finishes before the
body parses* — and being wrong about it produces the failure this whole sandbox
was built to eliminate: a card's markup running against no bridge, throwing a
`ReferenceError` per member, every one of them attributed to the card. So the
sentence is checked at three levels, ordered by how early each can speak and by
how much each can see. None subsumes another.

**① Build time — `tools/check-bootstrap.mjs`.** Beyond the two checks it already
made (the artifact is a classic self-contained IIFE; the channel is captured
exactly once), it now:

- hashes the artifact and asserts the name matches, using the **same
  `fingerprint`** the hash step names files with — extracted to
  `tools/asset-fingerprint.mjs` so a verifier cannot check one convention
  against another. A stale manifest or a file touched after hashing would
  otherwise be served `immutable` for a year under a name that no longer
  describes it, which is the one failure content hashing exists to prevent.
- builds the **real** `srcdoc` from `srcdoc.ts` and reads the tag out of it: the
  `src` is this build's artifact by name; there is no `async`, `defer` or `type`;
  `crossorigin="anonymous"` is present; the guard is present, **after** the tag
  and **before** the card markup; and the bootstrap's source does not appear in
  the document (a frame carrying both would pass everything else and pay twice).
- counts `postMessage` reads **twice, separately** — once in the artifact, once
  in the guard, each expected to be exactly 1. A single combined count of 2 is
  satisfied by two wrong distributions.
- weighs the widest of the four real documents against `FRAME_OVERHEAD_BYTES`,
  failing on the unsafe direction and warning on the wasteful one.

**② In the frame — `bootstrap-contract.ts`.** The `<script src>` introduces
exactly one failure the inline element could not have: *the tag is in the
document and the code never ran.* Three ways in — the request failed, this
frame's CSP refused it, the file would not parse — and all three look identical
from outside. So the bootstrap sets `__iris_bootstrap_ready__` as its **last**
statement, `fail()` sets `__iris_bootstrap_spoke__` **before** it reports, and a
guard between the tag and the card's markup reads both:

- Neither set → the script never ran. The guard names which absence it is, using
  the resource timing entry as the discriminator (an entry with a body means the
  file arrived and did not install — wrong bytes, a parse error, a stale build;
  no entry means nothing was delivered — CSP, blocked, or a failed request), and
  reads the URL off the tag rather than holding a second copy of it. It reports
  through the **existing** unstamped `bootstrap-error` channel — the same one
  `frame-entry.ts`'s own `fail()` uses, which `runner.ts` accepts on
  `event.source` alone and the shell shows through `onBootstrapError` — draws a
  named panel in the frame so a blank frame is blank *for a stated reason*, and
  then makes the rest of the document inert two ways: `document.write` of an
  unclosed `<template>` (everything after it becomes template content, parsed but
  neither rendered nor executed) and `window.stop()`.
- `spoke` set → the bootstrap ran and threw, and has already reported the real
  error. The guard is **silent and does nothing**. Speaking would replace a
  named error with a guess about the network; stopping would blank a card's
  interface for a failure that is today survivable, which this move has no
  business changing.

`document.open()` is not used and cannot be: called from a parser-inserted
script it sets the ignore-destructive-writes counter and returns, so it is a
no-op in exactly the position this guard occupies.

**③ A real browser — `tests/frame-bootstrap-live.test.ts`.** Three `srcdoc`
frames in a headless Chrome over CDP, built from the real `buildSrcdoc` and the
real built artifact served with the host's headers. The card body under test is
one parse-time `<script>` followed by one element, and the element is the witness.

1. **The real thing.** The card's first parse-time script reports
   `__iris_bootstrap_ready__ === true`, `window.parent.document` **reachable**,
   the member table present, and `document.readyState === 'loading'` — that last
   one is what makes the reading about the moment under test rather than a later
   one.
2. **The negative control: the bootstrap 404s.** The shell receives a
   `bootstrap-error` whose message names the failing URL and whose `iris` field
   is empty (unstamped, as the pre-token channel is); the frame carries the named
   panel with a sentence a reader can act on; the swallowing `<template>` is in
   the DOM; and **the card's markup never ran** — no probe reading, and the
   witness element is not in the document at all.
3. **The vacuity control: no bootstrap tag at all.** The same probe in a bare
   sandboxed `srcdoc` reports `window.parent.document` **threw** a SecurityError.
   This is what stops ① from being a test of nothing: if a cross-origin parent's
   `document` were readable anyway, the live frame's reading would be green with
   the bootstrap deleted.
4. **The other absence: a real script that is not the bootstrap.** The tag points
   at the member table — HTTP 200, loads, parses, sets no bootstrap marker, which
   is the shape a stale build or a wrong manifest entry takes. It exists because
   the guard's first diagnosis was **wrong for the commonest case** and this file
   was green while it was: the guard asked "is there a body" and answered "it
   arrived and set no marker: wrong bytes, a parse error, or a stale build"
   whenever there was — and a 404 has a body, so a missing file sent the reader to
   the bundler. Found by mutating the guard's inertness away, which let the panel
   text through into a failure message; the negative control had only asserted
   that the panel said *something* actionable, so the branch it took was never
   pinned. The guard now reads `responseStatus`, the report names the status, and
   both branches are pinned in both directions (404 says 404 and does not say
   "wrong bytes"; a 200 that sets no marker says so and does not say 404).

Gated on `IRIS_BROWSER=1` — on the **flag**, not on whether a browser is
installed, so the suite's skip count is a property of the request and not of the
machine (`check-corpus-skips.mjs`, 34 → 35, with a new `IRIS_BROWSER` gate
category). With the flag set and no Chrome, or no `public/sandbox` build, it
**fails** and says which: asking for a check and silently not getting it is the
outcome the file exists against.

### What else moved

- **The shell stops fetching the bootstrap's bytes.** Three call sites did
  (`MessageInterfaces.tsx`, `useCardScripts.tsx`, `SandboxProbe.tsx`); they now
  resolve the manifest and hand `runCard` a URL. `RunnerHost.bootstrap: string`
  is `bootstrapUrl: string` — renamed because the type did not change and the
  meaning did.
- **`checkBootstrap` narrows to one caller, the build.** It is not deleted and
  not redundant: it reads the **emitted** bytes and can say *what* is wrong with
  them in an actionable sentence, where the guard reads the **served** bytes,
  cannot see them, and can only say that nothing installed. A bundler
  misconfiguration is visible to the first and not the second; a dev server that
  rewrites on the way out is the reverse.
- **`bootstrap.js`, the un-hashed copy, does not exist** and has not for some
  time: the hash step *renames* rather than copies. `prune-sandbox-assets.mjs`'s
  comment still described it as a build output the pruner deliberately leaves
  alone; corrected, together with the report's "also present" line, whose only
  member today is the FontAwesome sentinel.

### One dev-story change, found by measuring rather than by reasoning

**A bare `npm run dev` — Vite alone, no Iris host — does not serve
`access-control-allow-origin` on `/sandbox/*`.** Measured 2026-09-10 on Vite
6.4.3, with and without an `Origin: null` request header (which is what a
sandboxed `srcdoc` frame sends): `content-type: text/javascript`,
`cache-control: no-cache`, and **no CORS header at all**, for the bootstrap and
for the member table alike. Vite's `server.cors` default does not admit an
opaque origin.

That was already true and already fatal for the member table, so a bare Vite dev
server has never been able to run a card frame: the frame came up and refused,
naming the table. What changes is **which** name the refusal carries — the
bootstrap is blocked first now, so the guard says "the bootstrap did not install
— the browser recorded no response for it" instead. Both sentences point at the
same missing header.

Not fixed here, because the supported path is not bare Vite: the Iris host claims
`/sandbox` ahead of the frontend plugin and answers it through
`serveSandboxAsset`, which sends `access-control-allow-origin: *` and
`timing-allow-origin: *` (measured above, and the route this section's cost table
was measured through). **Acceptance has to go through the host** — `node
apps/iris/bin.ts` — and a frame reporting "the bootstrap did not install" on a
bare Vite port is this, not a regression.

### What would overturn it

- **A measurement showing a card's markup reaching a bridged name before the
  bootstrap installed.** Check ③ is written to see exactly this, and its failure
  message says so. The fix would not be to re-inline: it would be to find which
  attribute or which browser broke the blocking-classic contract, because
  everything else in the document — the member table, every card library —
  depends on the same contract.
- **A remote deployment.** Then 20 frames × 53.8 KB is a real number instead of
  25 ms. But the same page already pays 20 × 1.66 MB for the message preset, so
  the case that arrives with that evidence is a shared-cache or a
  smaller-preset case, and it would have to answer for 93.7% of the transfer
  before it reached this 3.0%.
- **The member table and the bootstrap becoming one artifact.** Recorded as an
  open question rather than answered here. The seam between them was justified by
  the inline/fetch split — policy inlined and unsubstitutable, surface fetched —
  and that justification is now spent on both sides: both are fetched, both by
  hashed URL, both under the same `script-src`. Merging them would remove one
  request per frame and a class of "which half is missing" report. Not done in
  this change: four branches are adding members to that table concurrently, and
  the conflict cost would swamp the benefit.

## 92. Each turn's reading carries its output speed, and there are two rates because they answer two questions

**Kind:** compatibility in the definition (the primary rate is upstream's, to
the digit), with two departures — the numerator, and one extra row upstream has
no counterpart for. Dated 2026-09-11.

**The request**, verbatim: 「加一个功能在每轮对话的用量中就是 token 输出速度」.
The per-turn reading was already there — `用量 7.2K` at the end of a reply's
action row with the breakdown in a hover card (§47) — and it had no time in it,
because nothing in the host recorded any. The host half is
`notes/packages/iris-app-service/DEVIATIONS.md` §67.

**What upstream shows.** A message timer, and a rate inside its tooltip:
`formatGenerationTimer` (`public/script.js:2681`) puts `{seconds}s` on the
message block and a five-line title behind it — `Generation queued`, `Reply
received`, `Time to generate`, `Time to first token`, `Time to think`,
`Token rate: {n} t/s`. The rate is `tokenCount / seconds` where `seconds` is
`gen_finished - gen_started` (`:2688`, `:2697`), printed to three decimals, and
`tokenCount` is `mes.extra.token_count` — **upstream's own tokenizer estimate of
the reply text** (`:3638`). §47 already records that Iris shows the provider's
reported figures where upstream shows that estimate; this section is what
follows for the rate.

**What Iris shows.** The chip becomes `用量 1.1K · 75.0 tok/s` (`usageTurnRate`,
built by `usageChipText` in `app/token-format.ts`), and the hover card gains
five rows after the token rows, in upstream's own tooltip order and with
upstream's own English words:

| row | value | present when |
| --- | --- | --- |
| 用时 / Time to generate | `durationMs`, one decimal of a second | there is a timing at all |
| 首字 / Time to first token | `firstTokenMs` | the host saw an output-carrying chunk |
| 思考 / Time to think | `reasoningMs` | it is present **and above zero** — upstream's own `reasoningDuration > 0` gate |
| 输出速度 / Token rate | `outputTokens ÷ (durationMs / 1000)` | both are usable |
| 纯输出 / Decode rate | `outputTokens ÷ ((durationMs − firstTokenMs) / 1000)` | `firstTokenMs` is known and above zero |

The timing rows sit *after* the token rows and are never mixed into them,
because they are a different measurement by a different measurer — the host's
clock against the provider's counters — and a reader has to be able to see
which half of the table came from where.

**The definitions, stated because the whole risk here is confusing them.**

- **输出速度 / Token rate is upstream's number.** The *whole* window: the
  provider's queue, the first connection and the decode are all inside it, and
  the denominator is exactly `gen_finished - gen_started` as SillyTavern
  divides it. So the figure Iris prints is the figure SillyTavern would print
  for the same reply, and `token-format.test.ts` asserts the arithmetic against
  upstream's own expression rather than against a recorded output.
- **纯输出 / Decode rate is Iris's own.** The same tokens over the time after
  the first one arrived. It answers what the whole-window rate cannot: whether a
  slow reply was a slow *model* or a slow *start*. Two seconds of queue in front
  of a two-second decode and a fast start in front of a four-second decode give
  the same `Token rate` and are different providers to live with.
- They can differ by a factor, which is why they are two labelled rows rather
  than one number that changes meaning, and why the chip carries the
  **whole-window** one: the chip is the figure a reader compares across hosts.

**Formatting** lives in `app/token-format.ts` beside `usageDetailRows`, whose
signature grew a third parameter rather than gaining a sibling builder: the rows
belong to one generation and one card, and a second builder would be a second
place for the order and the wording to drift — the drift that function's own
history is a record of (§47's last bullet).

- rates: one decimal at ten and above, two below. The band from a hosted
  reasoning model to a local 7B is three orders of magnitude, and one precision
  across it either prints noise (`312.47`) or erases the difference between
  `4.2` and `4.8`. Upstream's three decimals are fine in a tooltip nobody reads
  at a glance; this string sits beside the reply.
- seconds: one decimal, upstream's own precision — but computed in **integer
  tenths**, not `(ms / 1000).toFixed(1)`. `4050ms` is `4.05` seconds, `4.05` is
  not representable, and `toFixed` prints `4.0` — wrong by a tenth in the one
  place a reader would check. The module's own house rule (see its opening
  comment about integer arithmetic) applied to one more figure.
- **absent is never zero**, the rule §47 states for the buckets: no timing means
  no timing rows at all; no time-to-first-token means no decode row, rather
  than a decode rate that silently equals the row above it; an unusable
  duration means no rate, rather than `∞ tok/s` or a large finite number a
  reader would believe.

**What it costs.**

- **The chip's speed is gated on `usage`, not on the timing.** The numerator is
  the provider's `outputTokens`, so a turn the host clocked through an endpoint
  that reports no usage shows neither a cost nor a speed — and shows no
  duration either, because the whole popover hangs off `message.usage`. That is
  a real gap: the host *has* the duration (§67 stores it for every generation),
  and a reader of such a turn is told nothing rather than "3.4s, tokens
  unknown". Left as a follow-up rather than fixed here, because it means the
  reading no longer being a *usage* chip at all.
- **A reloaded turn shows a speed only for the reading its file was showing.**
  The host stores the timer in SillyTavern's one-per-line `gen_started` /
  `gen_finished` pair, so the other swipes come back with a cost and no
  stopwatch (§67's second departure). The interface renders that as no speed,
  and the fake's seeded conversation is deliberately in that state so the
  rendering is exercised without a reload.
- **No live rate while a reply streams.** A duration that grows makes a rate
  that starts absurd and settles, so the host projects no timing onto a
  streaming row and neither does the fake. A streaming figure would need its own
  definition — tokens per second *so far*, over a window that has not closed —
  and its own word, and the number that matters is the final one. Follow-up.
- **Two more words in a table that was already six rows.** The card is now up to
  eleven rows on a reasoning turn with a cache. It is a hover card a reader
  opened on purpose; the chip stayed one line.

**Held by** `tests/token-format.test.ts` (five new tests: no timing → no timing
rows; the row order and upstream's reading of "Time to think"; the two rates on
a slow start, checked against upstream's own expression; a zero thinking
duration dropped; the precision thresholds and the chip agreeing with the card
to the digit) and `packages/iris-client-fake/tests/usage.test.ts` (the fake's
timing shape, and the seeded turn with one clocked reading and one not). Every
new assertion was shown red under a named mutation.

**What would overturn it.** A ruling that the chip should carry the decode rate
instead — which is a claim that a reader cares more about the model than about
the wait, and would break comparability with SillyTavern's own number. A
provider population where a proxy buffers whole replies, making the whole-window
rate a measurement of the proxy rather than the model; the decode row is already
the answer, and it would then have to be promoted. Or the follow-up above
landing: a reading that shows a duration with no bill beside it, which needs the
popover to stop being gated on `usage`.

## 93. The shell page carries a policy of its own, refuses to be framed, and cannot carry the strict policy the audit asked for — because a `srcdoc` card frame inherits it

**Kind:** a layer upstream does not have at all, built smaller than it was asked
for by a browser measurement that overturned the ask. Dated 2026-09-11. The host
half — the tap that injects it, and `nosniff` on every route Iris owns — is
`notes/packages/iris-app-service/DEVIATIONS.md` §74.

**The findings.** A network audit (M-1, L-1) and a system audit (F10), all three
defence-in-depth:

- **M-1.** `apps/iris-web/index.html` carried no `Content-Security-Policy` — 0
  CSP meta elements, two inline `<script>` blocks and a module entry. The
  shell's one HTML sink (`CardPopup.tsx:223`) is guarded by DOMPurify, an
  independent audit pass and a fail-closed branch, but a DOMPurify bypass (mXSS)
  would then own the whole page: every host RPC, the connection profiles,
  `script.generate` spending the user's tokens. The card frames' own policy is
  complete (`sandbox/srcdoc.ts`, `framePolicy`); the shell had no layer of its
  own.
- **L-1.** No `X-Content-Type-Options: nosniff`, no
  `frame-ancestors`/`X-Frame-Options` — an unauthenticated local UI can be put
  in a frame by a hostile page and clicked through — and no `no-store` on the
  index.
- **F10.** The frame policy had no `base-uri`, and the host's allow-list
  accepted the bare `jsdelivr.net` where the CSP side spells
  `https://*.jsdelivr.net`, which does not match an apex.

**What upstream does.** SillyTavern mounts `helmet()` at
`src/server-main.js:104-106` — with `contentSecurityPolicy: false`. So upstream
has **no CSP at all**, on any page, by default; helmet 8's remaining defaults
still put `X-Content-Type-Options: nosniff` and `X-Frame-Options: SAMEORIGIN` on
every response, index and assets included (the two middlewares are pushed at
`node_modules/helmet/index.cjs:400-407` and `:445-459` when their options are
absent). That is the honest comparison and it cuts both ways: Iris gains a
policy upstream does not have, and loses the two *header-level* protections
upstream gets for free, because the response that carries this page is written
by an external package (below).

### The measurement that decided the policy, and what it overturns

The ruling asked for the textbook shell policy: `default-src 'self'`,
`script-src 'self' 'nonce-…'` with **no** `'unsafe-inline'` and no
`'unsafe-eval'`, `connect-src 'self'`, `img-src 'self' data: blob:`, `style-src`
measured, `frame-src` measured, `object-src 'none'`, `base-uri 'none'`,
`form-action 'none'`.

**It cannot ship, and the reason is structural.** A card interface is an
`<iframe srcdoc>` (`src/sandbox/runner.ts:363`). `about:srcdoc` is a *local
scheme*, and a document with a local-scheme URL **inherits the CSP of its
embedder**, which the browser then enforces *alongside* the document's own
`<meta>` policy. The frame's own policy is the permissive one card code needs —
`'unsafe-inline' 'unsafe-eval' blob:` plus the CDN allow-list — and intersecting
it with a strict shell policy leaves nothing that runs.

Measured in headless Chrome, 2026-09-11, one card-shaped `srcdoc` frame
carrying the real frame policy in its `<meta>` and
`sandbox="allow-scripts"` (what `frameSandbox` writes for an ungranted card),
mounted under four parent documents:

| the shell's policy | the frame's parse-time inline script | `new Function` |
| --- | --- | --- |
| none (the shipping state before this change) | **runs** | `2` |
| `default-src 'self'; script-src 'self' 'nonce-…'` | **never runs** | — |
| the same plus `frame-src 'none'` | **never runs**; the frame is still created and its markup parses | — |
| `default-src 'self'; script-src 'self' 'unsafe-inline'` | runs | **blocked**, and the refusal quotes the *shell's* directive |

The first row is the control: the same frame document, byte for byte, runs when
the parent carries no policy. The last row names the mechanism out loud — Chrome
refused the frame's `new Function` citing `script-src 'self' 'unsafe-inline'`, a
string that appears nowhere in the frame's own policy.

Three consequences:

1. **No fetch directives in the shell policy.** `default-src`, `script-src`,
   `style-src`, `img-src`, `font-src` and `connect-src` each narrow every card
   frame. The only `script-src` that would not is a union wide enough for the
   frames — `'unsafe-inline' 'unsafe-eval' blob:` plus two CDNs — which is to say
   no protection against the threat M-1 is about. A nonce cannot rescue it
   either: a `script-src` carrying a nonce makes browsers *ignore*
   `'unsafe-inline'`, so "nonce for the shell, unsafe-inline for the frames" is
   not a policy that exists.
2. **`frame-src` is omitted, not set.** The same measurement shows Chrome does
   not apply `frame-src` to a `srcdoc` navigation — under `frame-src 'none'` the
   frame was still created and parsed. Every value is therefore either a no-op
   today or, if a browser started enforcing it, the one line that kills every
   card interface at once, since no source expression matches `about:srcdoc`. An
   omitted directive says that honestly; a written one would be a landmine with
   a green test beside it.
3. **Nonce versus hash is moot, and the caching fact is recorded anyway.**
   `@deepseek-ai/dsh-host-frontend-static` re-reads `distIndex` and calls
   `ctx.webServer.renderIndex` **per response** — nothing is cached per process —
   so a per-response nonce would have been sound. With no `script-src` there is
   nothing for a nonce to authorise, so none is generated and no `<script>` is
   stamped.

**The shipped set**, `SHELL_CSP_DIRECTIVES` in
`packages/iris-app-service/src/shell-csp.ts`:

```
object-src 'none'; base-uri 'none'; form-action 'none'
```

Each one is free, and each one is real. The shell uses no `<form>`, `<object>`,
`<embed>` or `<base>` anywhere in `apps/iris-web/src` (measured). A card frame
already enforces `object-src` and `form-action` on itself by way of
`default-src 'none'`. `base-uri` has **no fallback to `default-src`**, so the
frame was unrestricted there — which is F10, closed on both sides at once. What
they buy against an mXSS payload: `<object data>`/`<embed>` execute script in
several engines, `<base href>` re-points every relative URL on the page (the
shell's own module bundle is loaded as `./assets/…`), and a form posting
somewhere else is how an injected credential prompt gets its answer out without
needing `fetch`.

### Click-jacking: the page refuses, and a header would be stronger

`frame-ancestors` is ignored in a `<meta>` by definition, and no header on this
response is Iris's to set. So `index.html`'s **first** script is now a guard: if
`window.top !== window.self` it calls `window.stop()`, empties the document and
writes one sentence into a fresh `<body data-iris-framed="refused">`.

This is honestly weaker than a header and the ledger says so: a header stops the
browser *before* the document exists, while this runs after the document has
been fetched and parsed this far, and it depends on the page's own script
running at all. It is what can be done from inside a document.

### The recorded gaps

- **Headers on the index and the built assets.** `nosniff`, `frame-ancestors` /
  `X-Frame-Options` and `Cache-Control: no-store` are headers, and the fallback
  seat that writes those responses belongs to
  `@deepseek-ai/dsh-host-frontend-static`, which writes `content-type` and
  nothing else and offers no hook. Routes Iris *does* own now answer `nosniff`
  (§74). Upstream has these, through helmet, on every response.
- **`script-src` itself**, for the reason above.

### What would overturn this

One thing, and it is nameable: **a card frame's document ceasing to be
`srcdoc`** — served from a real same-origin URL, still sandboxed to an opaque
origin, its policy in its own response's header. A non-local-scheme document
does not inherit, and on that day the whole strict set becomes available in one
edit to `SHELL_CSP_DIRECTIVES`. The cost is not small: §91's premise — a card's
first parse-time script sees the bridge — is a property of the body arriving
*as* the response, so that move needs the body to reach the frame without a
post-load channel, and it needs its own measurement.

Also overturning: any browser change to srcdoc CSP inheritance, which is exactly
what the second live test would announce by going red.

**Held by** `packages/iris-app-service/tests/shell-csp.test.ts` (8 — the tap's
output, the single meta, the position ahead of the first script, the refusal on
a page that already has a policy, idempotence, and a **forbidden-directive**
assertion naming the six that would break the cards),
`apps/iris/tests/shell-index.test.ts` (4 — the policy on a booted host's served
index, the file on disk untouched, every response tapped, and the index's
missing `nosniff` recorded as the gap with `/version`'s present one beside it),
`apps/iris-web/tests/shell-page.test.ts` (+1 — the framing guard is the page's
first script and stops the parser),
`apps/iris-web/tests/sandbox-srcdoc.test.ts` (+1 — `base-uri 'none'` on both
grant branches), `apps/iris-web/tests/allowlist-drift.test.ts` (+1 — a `*.`
entry excludes the apex, on this half and in the document), and
`apps/iris/tests/shell-csp-live.test.ts` (4, `IRIS_BROWSER=1`) — the real shell
on a real host with zero `securitypolicyviolation` and a card frame still
running inside it; the strict policy stopping that same frame, against a control
page carrying none; the framed shell refusing; and `connect-src 'self'` admitting
a same-origin WebSocket while refusing a cross-origin one.

---

## 94. What page access actually hands over, said in the copy; the scripts a card's markup runs without being asked about, counted; and the one same-origin path list the bridge carries

**Kind:** three answers to an audit, and all three are places where Iris has a
decision upstream does not have to make. Dated 2026-09-11. §93 belongs to a
sibling branch landing the same week.

**Why upstream has no counterpart to any of this.** A card's code upstream runs
in an iframe with **no `sandbox` attribute at all** — `Iframe.vue:2-11` and
`script/Iframe.vue:2` in JS-Slash-Runner 4.9.1
(`data/default-user/extensions/JS-Slash-Runner/src/panel/`, read-only), which
bind `srcdoc`/`src` and set `id`, `name`, `loading`, `frameborder` and nothing
else; `grep -rn sandbox src/` over that tree returns nothing. So upstream's card
frame is same-origin with the SillyTavern page by construction. There is no
grant to word, because there is nothing to grant: the card already has the page.
There is no consent state, because nothing is withheld. And there is no fetch
bridge, because a relative `fetch` from inside a same-origin frame is simply a
same-origin fetch — so there is no list to put on it either. Every part below is
therefore Iris adding a boundary and then having to describe it honestly, not
Iris diverging from a behaviour upstream ships.

### 94.1 The page-access copy names all four things, not one (network audit M-3)

**What the grant is.** `sandbox/policy.ts:36-43` — `frameSandbox(true)` returns
`allow-scripts allow-same-origin`, which is the one combination in the product
that is deliberately not a sandbox. The frame becomes same-origin with the
shell, which means, concretely: it can read every conversation's DOM on the
page, read the page's `localStorage`, reach the shell's own RPC client and call
**every** host method as the user rather than only the ones the card facade
offers — and read `input[type=password].value` in the connection panel while an
API key is being typed or pasted into it.

**What the copy said.** "your other conversations", four times over
(`grantedNote`, `grantDialogBody`, `grantDialogAck`, and both `consentSandbox*`
sentences). One of four. The key was the one nobody had written down, and it is
the one whose loss is not undone by turning the grant back off.

**What it says now**, in both dictionaries. `grantDialogBody` and `grantedNote`
each list: the contents of every conversation on this page; this page's stored
preferences; any host action in your name — generation included, which spends
your tokens — and an API key while you type or paste it into the connection
panel with this card open. `grantDialogAck`, the sentence a reader ticks as a
claim about themselves, names the key too. `offNote` and both `consentSandbox*`
sentences say the same three things in the negative, because "cannot read your
other chats" was an incomplete reassurance in exactly the way the grant's copy
was an incomplete warning.

The register is unchanged: prose, no list markup, no new colour, no emphasis,
and `STRINGS.md`'s glossary terms (卡片脚本 / 页面访问权 / 沙箱（隔离子沙箱）)
kept verbatim.

**Where it is pinned.** The dialog is a modal, so `check:render` can never open
it: `grantDialogBody` and `grantDialogAck` have no rendered form to match
against. That cost is named rather than hidden — `i18n.test.ts` asserts the five
facts in both columns of both `grantDialogBody` and `grantedNote`, and
`check:render` asserts the strings that *do* render (the off state, and the
granted state, reached by actually calling `setDocumentGrant(true)`).

### 94.2 Scripts embedded in a card's markup are counted and shown (system audit F9)

**The finding.** `consent.ts:135-138` — `interfacesMayBuild(state, count)`
returns true for `unasked` when `scriptCount === 0`, and the message frame puts
the card's markup into the srcdoc body (`srcdoc.ts`), where an inline `<script>`
runs while the document parses. So a card whose `scripts` array is empty but
whose greeting embeds a `<script>` runs code while the panel says "This card
ships no scripts."

**Not changed, deliberately.** The `unasked && 0` branch is upstream parity and
it is load-bearing: `ConsentAsk` renders nothing for a card with no scripts, so
a gate demanding an answer would strand that card's greeting behind a silence no
user action can break — measured on a real card whose greeting is a 30 KB HTML
document. `consent.test.ts` still pins all eight `interfacesMayBuild` outcomes
unchanged.

**What changed is that the number exists.** `sandbox/markup-scripts.ts` counts
`<script` openings inside the blocks `claimMessageSurfaces` claims — the frames'
own claim, not a regex over the card file, so prose that merely mentions
`<script` and unclaimed fences no frame will parse are not counted. Two rules are
pinned, because both directions are wrong in a different way:

- **A tag name is what ends it.** `<script`, `<script `, `<script/>`, `<script`
  followed by a newline and `<SCRIPT>` count; `<scripting>` and a trailing
  `<script` at end of text do not. `<script type="module">` counts — a module
  script in a srcdoc body is deferred, not skipped.
- **A `<script` inside an HTML comment counts.** It does not run, and counting
  it is still the right direction: stripping comments correctly needs a parser,
  and every failure of a hand-rolled one is quiet (a `<!--` inside an attribute
  value swallows the real script after it and the count drops to zero on the one
  card where it mattered). Over-counting shows a reader a warning about markup
  that does not run; under-counting shows them nothing about markup that does.
  `frontend-blocks.ts` already makes that trade one layer up, where the claim is
  substring containment rather than parsing.

The count is taken over the open conversation's messages, with the same settled
stray-fence repair the rows and the frame budget apply, so the three agree about
which characters a frame would parse. **It is not read from the card file**: the
greeting is message zero and is already in that list, and a second reading would
be a second extraction that could disagree with the one the frames use. The cost
of that choice is named rather than buried — the number is per conversation
rather than per card, so a model reply that emits an interface is counted too,
which is correct for the sentence being said ("the interface markup in this
conversation") and is not the same statement as "this card ships N".

It appears in two places, and `check:render` asserts the **number of
occurrences** rather than merely matching one, because the question is put twice
— the banner above the conversation and the settings panel — and a match is
satisfied by either. When the question is on screen the sentence is its last
clause; when it has been answered, or was never put because the card carries no
scripts, the panel says it on its own. The wording is the same either way and
says what the answer does **not** govern: these run with their message frame
whatever was answered.

### 94.3 The same-origin fetch bridge carries four path shapes and no others (network audit F11)

**The finding.** `same-origin.ts` decides whether a card's `fetch` is aimed at
Iris, and the bridge then has the **shell page** fetch it with the shell's own
credentials (`runner.ts` `ride`, `frame.ts` `rideFor`). Any same-origin path was
therefore a card's to read — `/iris/avatar/<another card>`
(`packages/iris-app-service/src/index.ts:413-469`) hands back another
character's whole card file, PNG payload and embedded card data together. POST
writes were already stopped twice over: the bridge carries only GET/HEAD with no
body and no headers, and the RPC endpoint refuses anything that is not
`application/json`.

**Measured first, over the operator's install** (`E:/sillyTavern/SillyTavern`,
ST 1.18.0, read-only; 19 cards → 47 script bodies, 173 card regexes, 65
greetings; 31 chat files → 2,454 messages; 6 presets → 78 regex replacements; 18
world books → 1,478 entries; 6,024 bodies, 3,207 distinct after content hashing):

| layer | what the corpus reaches through the bridge |
| --- | --- |
| written directly in card, preset or world-book bodies | **two** relative `fetch` targets, both in one card (`萧谴写卡助手版_V4.5.1`), both dev-mode fixtures behind `window.is_dev`, and neither file exists in the install — they 404 upstream too. Zero `XMLHttpRequest`, `$.get`, `$.post`, `$.ajax`, `axios`, `sendBeacon`, `EventSource`, `WebSocket`; zero relative `src=`/`href=`/`url()`; zero reads of `location.origin`/`href`/`pathname`/`baseURI` in 3,207 bodies |
| inside the CDN bundles cards import | `GET /version` (MagVarUpdate's `_wait_init`, reached by **13 of 19 cards**), `POST /api/backends/chat-completions/status` and `POST /api/chats/export` (the same 13, both behind buttons), and in one card's 1.15 MB Fatria bundle `GET /csrf-token`, `POST /api/worldinfo/get`, `POST /api/worldinfo/edit`, plus dynamic `import()` of `/script.js` and `/scripts/world-info.js` |

The premise this corrects is the framing that the on-disk corpus would show the
bridge's usage: **no card body writes a same-origin fetch at all**. Every real
one arrives transitively, inside a bundle 13 of 19 cards import. A census of the
four on-disk populations alone reports a clean zero on the paths that matter.

**The list**, in `sandbox/bridge-paths.ts`: `/version` exactly; `/sandbox/` and
`/iris/script-bundle` by prefix; and `/iris/avatar/<id>` only when the id is the
**current card's own**, compared exactly rather than case-folded (the library
folds case to decide whether an id is *taken*; folding here would admit a
genuinely different card's file on a case-sensitive host, and a card never types
this id — it comes back from `getCharAvatarPath()` as the host spells it). A
frame that does not yet know whose card it is gets no avatar at all: failing
open would make the leak a race, failing closed costs a picture. Images are
unaffected either way — a card putting an avatar in `url(...)` or an `<img>` is
`img-src`, not the bridge.

**What the list costs, measured: nothing this corpus exercises.** `/version` —
the only allow-list entry with any breadth, and the only path the corpus reaches
— is allowed. The three refused GETs (`/csrf-token`, `/script.js`,
`/scripts/world-info.js`) are SillyTavern's own routes, which this host does not
serve; they 404 through the bridge today, so that one card degrades identically
with or without the list. The POSTs never rode the bridge. The two directly
written targets are dev-mode fixtures that 404 upstream as well. Named rather
than waved past, because "nothing breaks" is the claim a list like this is most
often wrong about.

**Both sides, one list.** `frame.ts` consults it before a request rides, and
`runner.ts` again before the shell honours one — the same reason the origin check
is already doubled: the frame is the untrusted half and the shell is what holds
the credentials, so "the frame already filtered" is not a check. The two
refusals differ only in which layer is speaking, which is the repo rule that a
refusal names the relaying layer. Frame-side a refused request **falls through to
the native fetch**, exactly where it went before the bridge existed, so CSP
refuses and reports it as it always did; what is new is a note saying Iris
declined to relay it. Shell-side the promise rejects and the existing
`fetch:error` message carries it — no new message type and no new error kind.
Each refused *shape* is reported once per frame, with the avatar id folded to
`<id>`, so a card sweeping the library leaves one line rather than one per card.

**Configuration drift, named.** The three prefixes are literals here while the
host takes them from config (`avatarPath`, `scriptBundlePath` and `sandboxPath`
default to exactly these). That is the existing practice in this package —
`asset-manifest.ts` already hardcodes `/sandbox/manifest.json` — and a host
reconfigured off the defaults would refuse its own artifacts loudly rather than
quietly, which is the safe direction. A host that starts shipping those paths to
the shell as configuration is what would move them.

**What is unchanged.** The three consent states, the storage convention,
`forget` on delete, `interfacesMayBuild`, and everything `same-origin.ts`
decides. `frameSandbox` is untouched: the grant still does what it did, it is
now described.

**Tested.** `apps/iris-web/tests/bridge-paths.test.ts` (the list, the own-avatar
rule, the shape folding, the two voices), `markup-scripts.test.ts` (the tag-name
rule, the comment decision, claimed-only counting, the F9 card's own shape),
additions to `consent.test.ts` (the clause appended and absent) and
`i18n.test.ts` (both dictionaries carry the facts; the zh question sentence),
and two-sided integration in `sandbox-frame.test.ts` and `runner-fetch.test.ts`.
The fake's seeded greeting gains a card interface with one inline `<script>`,
because nothing in the repository rendered one before and `check:render` had no
markup to count. Twenty named mutations, each red on at least one new assertion.

**What would overturn it.** A corpus or a report showing a real card that needs a
same-origin path this list refuses — the three Fatria GETs become an argument the
day Iris serves anything at those paths. A ruling that 94.2's count should be per
card, which needs a card-file extraction that agrees with the frames' claim and
therefore needs the claim to move out of the web app. Or a design in which the
page-access grant is narrowed rather than described, at which point 94.1's copy
is describing a boundary that no longer exists.

## 95. Four audit findings accepted rather than closed, with the price of closing each one written down

Dated 2026-09-11. **No code changed** — this section and the `docs/SANDBOX.md`
"Accepted gaps — 已接受的缺口" section it backs are the whole deliverable. The
four come from `AUDIT-SYSTEM-SECURITY-DATA.md` (F8, F15, F17) and
`审计报告-网络安全工程.md` §5 (L-5); the other findings of those two reports were
either fixed (§93, §94, and the host-side sections of
`notes/packages/iris-app-service/DEVIATIONS.md` and
`notes/packages/iris-rpc-host/DEVIATIONS.md`) or are still open with an owner,
which `notes/SECURITY-REMEDIATION.md` tabulates.

Acceptance is a decision, not a shrug, and the reason it gets a ledger section
is that the three ways it goes wrong are all quiet. It gets forgotten, so the
next audit reports it again and the next engineer rediscovers the reasoning
from scratch. It gets remembered as "safe", so the condition it rested on
lapses without anyone noticing that it was a condition. Or it gets treated as
permanent, so a cheap fix that arrives later is never taken. Each entry below is
therefore three things — what is open, what closing it would cost, and the
observation that would make the answer different — and the last of those is what
makes this a decision with a date on it rather than an opinion.

### 95.1 F8 — a network grant does not govern `script-src`, and a code fetch's URL is a channel

**What the audit found.** The frame's code allow-list is open regardless of the
network grant (`apps/iris-web/src/sandbox/srcdoc.ts:165`,
`apps/iris-web/src/sandbox/policy.ts:77`,
`packages/iris-script/src/remote.ts:31-34`), and a dynamic `import()` is a
script fetch whose *path* the card writes. So an import of
`https://testingcf.jsdelivr.net/gh/a/b@main/` plus a data string plus `/x.js`
puts that data in a request which leaves the machine; the 404 that comes back
fails the import and changes nothing about that. The audit rated it 中 and said
so in the words that matter: it 绕开了用户以为在决策的那个开关 — it goes around the
very switch the user believes they are deciding with.

**Why it is accepted.** The closure the audit priced and then advised against is
putting `script-src` inside the grant. That is not a hardening of this product,
it is a different product: measured over the operator's install, 13 of 19 cards
import MagVarUpdate from jsDelivr before they can paint anything, so a gated
code allow-list means a consent question standing between every card and its
first frame. A question whose only workable answer is yes does not inform
anybody; it trains them to answer yes to the next one, which is the question
that was worth asking.

**What the acceptance actually changes.** The promise. The comment at
`apps/iris-web/src/sandbox/srcdoc.ts:104-119` described the grant as closing the
way out, and that reading was too strong — the grant governs `connect-src` and
`img-src`, the two channels a card would use for anything bulk or two-way, and
it never governed the code allow-list. Saying that plainly is the deliverable: a
boundary described accurately is worth more than one described generously,
because the generous description is what a later decision gets built on.

**What would reopen it.** A corpus measurement finding a real card with a
non-literal `import()` specifier — the shape is a specifier built by
concatenation rather than written whole, and the census reader can look for it.
Or the middle option the audit named and this project has not built: report the
first such specifier per frame instead of refusing it, which costs the ecosystem
nothing and turns a silent channel into a visible one. That is the change to
make if anything here moves.

### 95.2 L-5 — `showdown` 2.1.0 is advisory-flagged with no fixed release, and it lives inside the frame

**What the audit found.** `npm audit` flags showdown 2.1.0
(`apps/iris-web/package.json:37`) for a ReDoS and two XSS paths, and upstream has
published nothing to upgrade to. The audit checked the reach itself and recorded
the conclusion in the finding: showdown is provided to cards as a sandbox global
(`apps/iris-web/src/sandbox/preset-entry.ts:200`) and the shell does not render
its output, so the impact is frame-local — 关注上游；不必紧急.

**Why it is accepted.** There is no fixed version to move to, so the only actions
available are removing the global or forking. Removing it breaks upstream cards
that expect a `showdown.Converter` to exist, which is why it is there. And
inside a frame whose `default-src` is `'none'` and whose origin is opaque, an XSS
in showdown buys the attacker what a card can already do by writing the script
itself — the frame is the boundary, and this is inside it. The ReDoS hangs the
frame that ran it.

**What would reopen it.** A fixed release, at which point this is a version bump
rather than a decision. Or — and this is the one to watch — any shell-side code
rendering markdown through this library. The whole argument rests on
"frame-only"; the day the shell converts something with showdown, the two XSS
advisories are shell XSS and §93's policy is what stands between them and the
RPC surface.

### 95.3 F15 — the bundle proxy is a GET, and a GET needs no permission from anybody

**What the audit found.** The bundle route takes no preflight, so any page open
in the user's browser can drive this host into fetching an allow-listed URL and
writing the body to disk. The audit recorded it as 低，已缓解在案 — low, and
already mitigated on the record — because the module had already priced it:
`packages/iris-app-service/src/script-cache.ts:64-88` states the exposure and
calls it bounded disk fill.

**Why it is accepted.** The bound is real and the audit re-derived it rather than
taking the comment's word: the allow-list check runs on every request and on
every one of at most five redirect hops, https only, the two CDNs by dotted
suffix and exact match, so the reachable target set is two public CDNs and not
the local network — this is not an SSRF surface. A body is capped at 8 MiB, the
directory at 256 MiB, and over budget the cache **refuses to write instead of
evicting**, which is the detail that matters: eviction would let a hostile page
push a real dependency out and turn disk fill into cache poisoning. And the
preflight that would close it cannot be required, because requiring a preflight
means requiring a header, and a module `script` tag — the thing this route
exists to be loadable by — cannot send one.

**What would reopen it.** The allow-list admitting anything that is not a public
CDN, or the budget policy changing from refuse-to-write to evict. Either one
moves this from a bounded annoyance to a real finding, and both are one-line
changes, which is why they are written here rather than left to be noticed.

### 95.4 F17 — the stylesheet rewrite's regex truncates, and the truncation fails closed

**What the audit found.** The link-rewriting pass at
`apps/iris-web/src/sandbox/srcdoc.ts:232-242` matches a tag with a negated
character class that stops at the first `>` — including one inside a quoted
attribute value — so such a link is not rewritten. The audit's own note says the
direction is safe and rates the fix S.

**Why it is accepted.** Direction is the whole argument. An unrewritten link
keeps its remote href, `style-src` does not admit remotes, the browser refuses it
and the existing reporter names the sheet — the outcome is the outcome the card
would have had if the rewrite did not exist, which is the behaviour this frame
had before the convenience was added. The fix is a real attribute scanner
replacing two regexes, and a hand-rolled HTML scanner fails *quietly* where a
regex fails loudly; `frontend-blocks.ts` already took that trade deliberately one
layer up, for the same reason.

**What would reopen it.** A card in the corpus whose link tag carries a `>`
inside an attribute value — there is none. Or, more importantly, the rewrite
ceasing to be a convenience: if a future policy admitted remote stylesheets and
used the rewrite to *route* them, a missed rewrite would be a bypass rather than
a refusal, and the scanner would be worth every bit of its cost.

### Where this is recorded

`docs/SANDBOX.md`, "Accepted gaps — 已接受的缺口 (2026-09-11)", carries the same
four in the frame's own document, because that is the file a person reading the
sandbox policy has open. This section is the ledger entry with the audit's
wording and the reasoning; that one is the operational note. They are expected to
agree, and the day they stop, the ledger is the one that was written first and
the document is the one someone edited without looking here.

## 96. Settings is a directory of tasks with drawer-local pages

Dated 2026-09-11. The previous drawer stacked every settings card in one scroll.
The controls were complete, but the only way to find one was to remember its
position in that stack. The drawer now opens on fourteen rows grouped as General,
Conversation, Content, Appearance, Data and Advanced. Each row says what is
behind it and may show only a fact already held by the store: the selected
profile or preset, a real count, the context window, model, or prose size. A
selected connection is deliberately not called connected; only a probe can make
that claim.

The destination is local React state rather than a URL. The browser has not
navigated and the drawer has not closed: Back and Escape return to the directory,
while Escape on the directory closes the drawer. All destination trees remain
mounted and are hidden by the route, preserving the old drawer's load behavior
and panel-local drafts. The common header stays outside the scrolling region;
the directory and every destination own their own scroll box.

Four inline groups moved without changing their writes: generation keeps the
same `patchSettings` keys and bounds; reply behavior keeps the asymmetric
`cacheFriendly !== false` default; memory/context keeps `contextWindow` and
`contextUnlocked`; reading keeps the device-local `ReadingControl` and language
store. Existing connection, preset, persona, worldbook, script, appearance,
backup, diagnostics and about components are reused. Backup preview, typed
restore confirmation and armed deletion therefore remain the same component
state. UsagePanel gained an `embedded` presentation only; its range query and
chat navigation are unchanged.

Regex remains three stores and three panels in execution order: global, preset,
character. The segmented control changes visibility only, so preset permission
and per-character permission remain where they were. Scripts similarly groups
the card consent/run panel with the global/character user library without
combining their data.

No protocol schema, RPC, host package, Zustand field or action changed. The new
contract is presentation-only: `SettingsNavigation.tsx` owns the route catalogue,
bilingual category search and small shell primitives; `fields.tsx` can present a
CollapsibleSection expanded inside a task page without mutating remembered card
state. The old UsageSection modal remains available to any caller outside this
drawer.

---

## 97. The PluginCenter explains the browser half of each plugin: a second status surface beside the host chip

**Kind:** deliberate improvement, with one named guess.

**Upstream.** SillyTavern has no system-plugin platform, so there is no upstream
behavior to mirror; the deviation is from *silence*. Before this change, the
shell's half of the visibility rule was one `console.warn` when
`/plugins/manifest.json` did not answer (`use-plugin-manifest.ts`), and the
frame's merge reports lived inside each sandbox where cards — but no user —
could read them. A user looking at the plugin center could not tell a plugin
whose host runtime was fine from one whose `client.js` had been deleted.

**Iris** shows two independent statuses per plugin: the host runtime verdict
(the existing chip, driven by the snapshot) and a browser-asset verdict
(undeclared / loading / loaded / degraded / stale), derived from what the shell
can read without touching the frame protocol. A degraded or stale asset names
the plugin id, the expected revision, the revision actually served, the last
error classified into one of six kinds (client.js missing, HTTP fetch failure,
JavaScript parse failure, manifest malformed, member-name conflict, revision
mismatch), the last successful load time, and a retry that re-fetches the
manifest row and the bundle. The retry never touches the host plugin's enabled
state; degradation is browser-only and never flows back into the store, so
ordinary cards keep running and the enable/disable buttons keep meaning exactly
what they meant.

**The named guess: the member-conflict scan.** The frame refuses a colliding
member at registration and reports it to the card, but the shell cannot see a
frame's registrations without new plumbing into the frame protocol, which this
task's file boundary forbids. So the shell scans the fetched bundle sources for
literal `registerPluginMembers('<id>', { name: … })` objects and reports a
collision between two enabled plugins' literal names, naming both claimants.
The scan is deliberately narrow — computed keys and indirect registration yield
nothing — because a static scan must not invent a conflict registration itself
would not refuse. **What would overturn it:** if a real plugin registers
indirectly and collides, the frame still refuses its members and the card sees
the named report; only the plugin center's conflict row would be missing. The
correct close is surfacing the frame's per-plugin merge reports to the shell,
not loosening the scan.

**What it costs.** The plugin center now fetches every enabled plugin's
`client.js` once per revision (compile-checked with `new Function`, never
executed; module bundles are taken on trust because they cannot be
compile-checked without a module context). For a catalog of small bundles this
is a few requests the frames would make anyway, served from the same origin
with rev-keyed cache-busting URLs. The probe cache reuses a successful result
for an unchanged rev across renders and other plugins' retries, and the
aggregate manifest itself is re-read on a ten-second interval while the catalog
is live — a path that revalidates on every read — so a bundle deleted or
restored outside the control plane reaches the surface without a click.

**The declaration gap, and the evidence that fills it.** The wire snapshot
says nothing about whether a plugin *declares* browser assets, so "enabled
with no manifest row" is ambiguous between the bundled catalog's normal state
(TH and MVU ship no bundle at all) and a deleted `client.js`. The shell keeps
session-scoped evidence — every manifest row it has served, keyed by plugin id
and revision — and a row that vanishes at the **same** revision it was served
at reads degraded (enable, disable, install and uninstall all bump the
revision, so a no-revision disappearance is a deletion). Without that evidence
a fresh page load honestly reads `undeclared`; only a server-side declaration
bit could close the gap, which is the same overturn condition as above.

**What would overturn it.** A manifest route that gains per-plugin status from
the host (a fifth manifest field, or a `plugin.assetStatus` RPC) would make the
probe and the scan redundant; the hook is written so the fetch path is the only
thing that would need replacing. (U6 later added a third fact to this row —
the manifest revision, beside the catalog one — and corrected what the row's
two old numbers were being read as: §102.)

---

## 98. The plugin center's copy joined the shared i18n dictionaries

Dated 2026-09-15. `PluginCenter.tsx` was written after the task-I dictionary
round and carried its own inline `COPY = { en, zh }` table — about 150 lines of
English and Chinese side by side, plus one `lang === 'zh' ? … : …` aria-label
beside it. Why inline: the component predates none of the i18n machinery, but it
landed from a task whose file boundary stopped at the component, and a private
table is the shortest thing that renders both languages. It worked, at the cost
of a second, smaller translation system beside the real one.

What that cost in practice: `i18n.test.ts` audits the shared dictionaries —
every `zh` value must contain Chinese, both columns must use the same
`{placeholder}` names, the `t("key")` sweep must name real keys — and an inline
table is invisible to all of it. A mis-filed English sentence in the `zh` half,
or a placeholder renamed in one column only, would have shipped with the suite
green. The table also duplicated machinery the dictionaries already provide:
hand-rolled template functions where `interpolate` slots do the same job, and
nested maps where flat keys are the file's own convention.

The migration is mechanical: every string became a `pluginCenter*` key in
`strings.ts` (`en` plus `zh`, sixty keys), the four template functions became
slotted keys (`pluginCenterLoadFailed {detail}`, `pluginCenterWaitFor {name}`,
`pluginCenterOperationFailed {name} {detail}`, `pluginCenterBlocked {names}`),
and the nested maps became keyed families
(`pluginCenterStatus*`, `pluginCenterAssetPhase*`, `pluginCenterAssetError*`,
and the two plugin descriptions). The component's own enum-to-key tables
(`STATUS_KEYS`, `PHASE_KEYS`, `ASSET_ERROR_KEYS`, `PENDING_KEYS`,
`DESCRIPTION_KEYS`) stay in the file, because mapping a protocol enum onto a
sentence is component knowledge, not copy. The mounted component reads through
`t()`; the `PluginRow`/`AssetStatus` helpers keep their `lang` parameter and read
through `translate(lang, …)`, the same split `StatePanel.tsx` uses. No string
changed, no layout changed, and `plugin-center.test.ts` passed unmodified —
which is the point: the render contract was already right, only its audit
coverage was missing.

`STRINGS.md` is not updated for the new keys; it is the dated inventory of the
task-I round, not a living registry, and no test holds it to the dictionary.
What would overturn this note: a third language, which would make any per-
component table untenable anyway — the dictionaries are already the shape that
survives one.

## 99. 插件中心长出安装路径：一张同意页、六个失败状态、以及三处「代码赢」

Dated 2026-09-15. PR-3 of `docs/SYSTEM-PLUGIN-INSTALL.md` §10。PR-2 已经把整条安装
路径做完了——三个 RPC、`system-plugins.json` v2、开机复核、六个命名失败状态、
`SystemPluginView` 的三个可选字段——但**没有 UI**：这些状态只能被测试看见。本节记的是
把它们搬到读者面前时，设计被代码推翻的地方、文案上的判断，以及哪些断言真的会变红。

### 设计说的和代码做的

§8 是本轮之前唯一一段还是「设计」的正文，落地时被推翻五处，都已就地记进该节：

1. **`failure.detail` 实际叫 `reason`。** §8 的 `interface` 草稿写 `detail: string`，PR-2 落地的
   `SystemPluginFailure` 是 `{ state, field?, step?, reason }`（`packages/iris-protocol/src/system-plugins.ts`）。
2. **同意页不显示成员名、不做重名预警。** 草稿要求「扫出的成员名（与已启用插件重名时预警）」，
   而 `clientMembers` 在 PR-2 就被删掉了（扫描器是浏览器侧模块，宿主 import 不了它）。页面显示
   `hasClient` 一句话；重名仍由帧侧按插件拒绝，并继续显示在行上已有的浏览器资产列里。
3. **「同意页必须说明这是同权代码」不再引 `COPY` 表。** 那张表在 §98 已并进 `strings.ts`；本轮的
   85 个新键也在那里，两列都受 `i18n.test.ts` 的三项审计管。
4. **卸载文案是加一句，不是改那句 `retained`。** `pluginCenterRetained` 对内置行仍然成立，
   所以它留在页脚的 `<aside>` 里一字未动；`git` 与 `dev` 的行各自多一句 `data-uninstall-copy` 注记。
   一个 `builtin` 行**没有**这句注记——三岔的第三条就是「没有第三句话，页脚那句就是它」。
5. **「离开页面即取消」需要一个新入参。** 这是本轮最贵的一条：§5.3 写着「用户取消 ⇒
   `plugin.cancelInstall`」，而**设置页从不卸载**——`SettingsPage`
   （`apps/iris-web/src/app/SettingsNavigation.tsx:122`）把每条路由都渲染出来、只用 `hidden` 藏掉——
   所以路由切换不触发任何 cleanup，组件内部也没有任何东西能把「读者正在看这一页」与「这一页被盖住了」
   分开。`PluginCenter` 因此收一个 `active` 属性（`SettingsDrawer` 传 `open && route === 'plugins'`），
   默认 `true` 好让直接挂载的调用方（`check:render`、harness）仍是「可见的那一页」。

还有一处不在 §8、但在 `store.ts` 里：**`describeError` 会吃掉宿主在这条路上说的每一句话**。
`client/errors.ts` 的 `COPY` 表把 `invalid-request` 翻成「Iris 不会发送这个请求。」，这对六个生命周期
方法是对的（那里的详情是一个标识符），对安装路径是错的——那里的详情**就是信息本身**
（`install-failed: [fetch] …`、`manifest-invalid: iris.plugin.host — …`、`install-failed: id 已被占用 …`，
形状见 `packages/iris-app-service/src/plugins/install.ts` 的 `SystemPluginInstallError`）。所以
`store.ts` 多了一个 `pluginInstallFailure`，它走 `asRpcError().message`，只在**我们自己**出错时才套
`irisOwnFault`。没有改 `describeError`，也没有动那张表：这是一条路的读法，不是全局策略。

### 文案上的判断

- **同意页替换列表，而不是并排。** 它问的是关于一个包的问题，背后摊着一整个目录是在邀请人点过去。
- **`apiVersion` 拆成三行**（需要 / 本机支持 / 是否兼容），而不是一句带两个槽的话。一开始写的是
  「需要 {declared}，本机支持 {supported}」，但它和上面两行的数字重复；拆开之后判决那一行不带槽，
  于是它在两列里都只是一句判决：「兼容——本次构建实现了它。」/「不兼容——本次构建没有实现它。」
- **`incompatible` 的预览照样显示整页**，只把确认按钮置灰并多一句为什么。一个作者需要看见自己的包
  被拒在哪一行；一页空白只会让他再试一次。
- **`permissions` 旁边那句话是裁决 4 的原文**：「这是作者写下的声明，Iris 只做拼写校验并展示。它不是
  Iris 强制的边界：系统插件是宿主代码，这张表上的事它能做，不在这张表上的事它也能做。」它必须出现在
  列表旁边而不是页脚，否则那张列表读起来就是一个权限系统——那正是裁决 4 自己点名的风险。
- **`dev` 徽标用 danger 色**。它不是一个中性的来源标签：它是那条「这一行的字节永远不会被复核」
  的披露（裁决 1），色值就是这句话的音量。

### 变红的断言（10 次变异，逐条施加后还原）

| # | 变异 | 变红的断言 |
| --- | --- | --- |
| 1 | confirm 回带一个写死的 id 而不是 `preview.id` | `plugin-center-install.test.ts`「the confirmation is not the preview the user was shown」 |
| 2 | `discard()` 只记账、不发 `plugin.cancelInstall` | 同文件「no plugin.cancelInstall call was made」 |
| 3 | `dev` 行不渲染 `SourceBadge` | `plugin-center.test.ts`「a dev row carries no source badge」与 `check:render` 同名断言——**但两条在收紧之前都是绿的**，见下 |
| 4 | `tampered` 的重装跳过 `plugin.uninstall` | `plugin-center-install.test.ts`「the reinstall did not run uninstall before staging」 |
| 5 | `incompatible` 的确认按钮不置灰 | `plugin-center.test.ts`「an incompatible package can be confirmed」+ `check:render`「an incompatible package can still be confirmed」 |
| 6 | `zh.pluginCenterFailureTampered` 换成英文 | `i18n.test.ts`「zh["pluginCenterFailureTampered"] has no Chinese」（外加 `plugin-center.test.ts` 的中文断言） |
| 7 | 客户端 commit 形状检查放宽成 `/^[0-9a-zA-Z]+$/` | 两条：「a branch name passed the client-side check」与形状检查自己的那条单元测试 |
| 8 | 同意页的 `permissions` 行改名（等价于漏渲染一个字段） | 两处「preview fields the consent page never renders」——**`check:render` 原本是绿的**，见下 |
| 9 | 卸载文案对 `git` 与 `dev` 用同一句 | `plugin-center.test.ts`「a git row does not say the tree is deleted」 |
| 10 | `pluginInstallFailure` 改回 `describeError` | `plugin-center-install.test.ts`「the host's own refusal is not on the page」 |

**变异 3 与变异 8 各抓出一条本来不会变红的断言，两条都当场收紧了**，这比它们验证的东西更值钱：

- **3：一个选择器同时命中了两处。** 行的 `<article>` 上有 `data-plugin-source="dev"`（给行级样式用），
  徽标 `<span>` 上也有。原来的断言写的是 `/data-plugin-source="dev"/`，于是**把徽标整个删掉，断言照样绿**。
  改成匹配徽标自己的类名加文字（`class="iris-plugin__source iris-plugin__source--dev"[^>]*>dev<`）之后
  才变红。这正是「选择器跨了两张表」那一类，只不过这次两张表是同一行上的两层。
- **8：数量不是集合。** `check:render` 原来数的是「不同 `data-consent-field` 的个数 == preview 的键数 - 1」。
  把 `permissions` 改名成 `permissionsDropped`，个数纹丝不动。改成和两个测试一样的**集合对账**
  （preview 自己的键集减去 `previewToken`，逐个要求出现）之后才变红。计数在字段被**重命名**时永远
  沉默，而重命名正是一个协议键悄悄不再被显示的那条路。

### 为什么 `PluginConsent` 是导出的纯组件

`FakeSystemPlugins.previewInstall`（`packages/iris-client-fake/src/plugins.ts`）永远答
`compatible: true`、`hasClient: false`，它的 `id` 由源摘要推导。于是「`incompatible` 的同意页」这个状态
**在 fake 里造不出来**。两条路：给 fake 加一个能让它撒谎的注入点，或者把同意页做成一个纯组件、由测试
直接喂一个 preview。选后者——前者买来的是一个更差的宿主模型加一个更差的测试。本轮因此**没有给 fake
加任何 seam**，`bundled` 仍是它唯一的注入点，而 `incompatible`、`hasClient: true`、带 `warnings` 的三种
同意页由 `renderConsent`（harness）与 `check:render` 直接渲染。

其余的路全部走真 fake：preview → 同意页 → confirm 的回带、cancel 的 token、以及**宿主拒绝原样显示**
——最后这条是用 fake 自己的拒绝走通的（在同意页开着时把那张票据从外部 `cancelInstall` 掉，再点确认，
得到 `install-failed: no staged install for token "…"`），所以断言比对的是 fake 抛出来的 `.message`
字符串本身，不是一段写死的文案。

### 两个测试文件，因为它们用的是两种仪器

`plugin-center.test.ts` 用 `react-dom/server`：它测的是**投影**——宿主这样描述一行，页面就这样说，
中英各一遍。它测不了任何需要点击的东西，因为服务端渲染不会点击。`plugin-center-install.test.ts`
在 jsdom 里挂载同一个组件、在 `act` 里真点，并且**断言落在记录下来的 RPC 参数上而不是 DOM 上**：
一个把 id 接到错误变量上的页面渲染出来一模一样。harness 是同一个（`plugin-center-harness.tsx`，
多了 `mountPluginCenter` 与 `renderConsent`），没有 fork。

### 什么会推翻这一节

- **裁决 2 被改口**（`plugin.update` 真的实现了）：那时行上会多一个更新按钮，而
  `plugin-center.test.ts` 里那条 `doesNotMatch(/plugin\.update|check for updates/i)`
  （它钉的是「裁决 2 把这个方法预留了，页面不得提供它」，不在上面那张变异表里——它是一条
  否定断言，没有对应的变异，因为要让它变红只需要加一个按钮）会成为一条必须删掉的断言，
  删它的人应当在这里读到它当初为什么在。
- **设置页改成按路由卸载**：`active` 这个入参当场多余，应当删掉而不是留着。
- **第三种语言**：三行 `apiVersion` 的拆法是为「判决那一行不带槽」服务的，多一列时要重新看。
- **fake 长出一个真实的 preview 造型能力**（例如它开始读一个夹具包）：那时 `renderConsent` 那条路
  可以退回成 fake 驱动，而本节「没有加 seam」的理由也随之作废。

> 复查（2026-09-17，e668785）：重开条件「裁决 2 被改口（`plugin.update` 真的实现）」已成立——证据 #106、host §81 与 web §100。决定已随之改变：那条否定断言按本节自己的安排退役（§100 记录）。

---

## 100. 插件中心长出更新入口：行上的「更新到…」、同意页的 `updateOf` 行、以及一条否定断言按它自己的安排退役

第二批 U1（2026-09-15）。宿主那一半的事在
`notes/packages/iris-app-service/DEVIATIONS.md` §81 与
`docs/SYSTEM-PLUGIN-INSTALL.md` §5.4；这一节记的是页面这一半，以及
`plugin-center.test.ts` 里那条被删掉的断言。

### `doesNotMatch(/plugin\.update|check for updates/i)` 的退役

这条断言（原 `plugin-center.test.ts:224`）钉的是「裁决 2 把 `plugin.update`
预留了，页面不得提供它」。U1 把更新事务实现了，它当场变红——而这件事**不是
这一节的作者先发现的**：`notes/apps/iris-web/DEVIATIONS.md` §99 的「什么会
推翻这一节」第一条，在写下这条断言的同一天就点名了它会被谁删、删它的人应当
先去那里读它当初为什么在。所以这是**裁决改口带来的断言退役**，不是弱化；
`docs/SYSTEM-PLUGIN-INSTALL.md` §12 的 PR-3 落地情况里把这段来历写全了。

替代它的是两条更严的断言，都在同一个测试里：

- **更新入口只出现在已安装的 `git` 行上**：按按钮自己的
  `data-plugin-update` 属性数数量（六个失败夹具行都是 git + installed，恰好
  六个），`dev` 行与 `builtin` 行各自否定断言。按按钮自己的属性匹配，而不是
  匹配 `<article>` 也带的 `data-plugin-source`——§99 的变异 3 就栽在这个
  区别上，这里不再栽第二次。
- 「接受当前字节」的否定断言（`/accept (the )?current bytes/i`）**原样保
  留，一个字没动**：更新不是「接受当前字节」——整棵树按 (remote, commit) 重
  新取、取完重新哈希——所以这两件事并存不矛盾。

### 同意页的 `updateOf` 行

`plugin.update` 铸造的 preview 多一个可选键 `updateOf`（被替换的行、行上现
记的 commit 与 treeHash）。同意页的字段集合断言——页面上所有
`data-consent-field` 收成集合，与 `Object.keys(preview)` 去掉
`previewToken` 后比较——是结构性断言：preview 多一个键而页面不渲染它，这条
当场红。`PluginConsent` 据此多渲染一行「替换」：从哪个 commit 到哪个、两个
tree hash 的短写，旁注写明「确认后旧树被替换，`enabled` 保留；旧树在新代
启用成功前不会被删」。普通安装的 preview 没有 `updateOf`，也就没有这一行——
`doesNotMatch(/data-consent-field="updateOf"/)` 把这件事也钉住了。

行上的入口只有一句：`git` 且已安装的行多一个「更新到…」按钮，展开一个只有
一个 commit 输入框的内联表单；形状检查复用安装表单的 `COMMIT_SHAPE` 那条
分支，拒绝分支、tag 与短 sha 与安装表单同一个规则、同一句文案。`dev` 行改
为显示一句「就地加载，改了文件即生效，不需要更新事务」，`builtin` 行什么都不
显示。`tampered` 行上重装按钮与更新入口**并存**——两个出口都走完整同意，
留哪个删哪个不是页面这一层该做的决定。

### store

新 action `updateSystemPlugin(id, commit)`，与 `previewSystemPluginInstall`
同构：失败走 `pluginInstallFailure`（宿主那句话原样显示——这条路的 refusal
详情就是信息本身，§99 讲过为什么）。确认仍然走既有的
`confirmSystemPluginInstall`，回带的四个值全部读自 preview 对象——
`plugin-center-install.test.ts` 的一条变异（把确认的 `treeHash` 接到
`updateOf.fromTreeHash` 上）就是钉这个的：用户看的是新字节的哈希，页面就必
须回带新字节的哈希。

### 牙齿表

变异逐条施加、逐条还原（`git checkout` 还原）。

| 断言 | 变异 | 结果 |
| --- | --- | --- |
| 同意页字段集合（含 `updateOf`） | `PluginConsent` 不渲染 `updateOf` 行 | 红 |
| 更新入口只在 git 行（数量为 6，dev/builtin 无） | `updatable` 恒为 false | 红（期望 6 个按钮，见到 0 个） |
| 确认回带 preview 自己的 `treeHash`（RPC 参数断言） | 回带接到 `updateOf.fromTreeHash` | 红 |
| 点击流：更新到… → 输 commit → 提交 → 同意页 → 确认 | （上面三条的共同载体） | 全绿时通过；`plugin.update` 先于 `plugin.confirmInstall` 的顺序由调用序列断言 |
| i18n 两本字典键集与槽一致 | —（未变异） | `i18n.test.ts` 未改动、保持绿：14 个新键两本各一份，槽位 `{from}/{to}/{fromHash}/{toHash}/{detail}` 一致 |

### 什么会推翻这一节

- **更新入口长出第二个字段**（例如允许换 remote）：内联表单与
  `updateSystemPlugin` 的形状都要重新看，行上的「remote 从行上读」那句话也
  是。
- **`tampered` 的两个出口要合并**：重装按钮与更新入口在 D5 之下是并存关系；
  若 owner 裁决只留一个，本节与宿主 §81 的 D5 段一起改。
- **`check:render` 改成真浏览器截图**：更新态的两段断言（同意页 `updateOf`
  行、git 行的更新按钮）要跟着搬。

---

## 101. 插件自带文案并进壳：`plugin:` 命名空间覆盖层、`translate` 加宽而 `StringKey` 不动

Dated 2026-09-16 (task sheet U5, branch `dev/plugin-i18n-bundles` against
`269a97e`). The host half of this round — manifest field, install-time audit,
asset face — is ledger §84 on `packages/iris-app-service`. What the shell
gained: a runtime overlay of plugins' bundled copy, keyed
`plugin:<id>:<key>`, loaded from the aggregate manifest and consulted only
through the `plugin:` prefix of `translate`.

### 形状与理由

- **覆盖层是模块级外部 store**（`apps/iris-web/src/app/i18n/plugin-copy.ts`），
  形状照抄 `language.ts`：`getPluginCopy` / `setPluginCopy` / `dropPluginCopy`
  / `subscribePluginCopy`，React 侧 `usePluginCopy()` 走
  `useSyncExternalStore`。文案到货晚于行首次渲染、语言切换要不重载就生效，
  这两件事把「订阅式 + 模块级」定为唯一自然形状；挂在 **App.tsx** 而不是
  PluginCenter，是因为后者从不卸载（`SettingsPage` 隐藏非激活页），拿它当
  生命周期锚点会把「页面可见」和「文案在场」绑在一起。装载 hook
  （`usePluginCopyLoader`）输入是聚合清单，按 `(id, lang, rev)` 去重——rev
  没变的表一个字节都不重拉，这是资产面 `immutable` 契约买回来的；**清单里
  没有的 id 一律 drop**，于是停用即消失，没有第二套失效逻辑。
- **`translate` 加宽参数，`StringKey` 一字不动**（D4 的 (b) with (a)）：
  参数类型放宽成 `StringKey | PluginCopyKey`（`` `plugin:${string}:${string}` ``)，
  `plugin:` 前缀的键委托给 `translatePlugin`（实现住在 plugin-copy.ts，
  strings.ts 再导出——单向运行期依赖，plugin-copy 只以 type-only 引
  `Language`，槽位插值因此**复制**了 `interpolate` 的八行而不是反向导入，
  否则环就成真的了）。静态键拼错仍是类型错误（`'sendd'` 不属于并集任何一支）；
  `t()` 保持窄签名，另出 **`tPlugin(pluginId, key, params)`**，它必须订阅
  覆盖层（文案到货要触发重渲），这是它与 `t()` 唯一的形状差。
- **回退链 zh → en → 键名本身**：查不到显示 `plugin:demo:panelTitle`，不返
  空串——空白是查不出来的失败。PluginCenter 行的三选一
  （`DESCRIPTION_KEYS` → 覆盖层 → 快照句子）逐字实现裁决 R7，内置两行的
  描述句不会被插件夺走；行通过 `usePluginCopy()` 订阅，文案到货即重渲。
- **同步失败方向**：`syncPluginCopy` 按插件 all-or-nothing（一份表读不到就
  drop 整个插件），console 点名 id 与语言；其余插件不动。这与宿主「两列全
  有或全无」的发布规则是对合的。

### 测试侧的接线与两处放宽

- **`i18n.test.ts` 改接线后仍是那三条**：规则的实现搬进 `@iris/text` 的
  `auditBilingualCopy`（`copySlots` 亦然），壳侧保留的只有消费者自己的事实
  ——中性键白名单（13 个，作为参数传入）与 `dictionary` 失败前缀。每条测试
  在真实字典的正例之外各带一个**故意写坏的对**，所以「规则从 `@iris/text`
  上脱落」在这三条上会变红，而不只是审计悄悄失去覆盖。T9 的验证：删掉
  `@iris/text` 的 `auditBilingualCopy` 导出，本文件即链接失败（SYNTAX
  error, export not found）——import 就是证据，内联的 CJK/槽位实现已不在。
- **`data-consent-field` 抓取正则 `[a-zA-Z]+` → `[a-zA-Z0-9]+`，共四处**：
  任务单点名的 `plugin-center.test.ts:298`/`:328` 之外，同样牙齿还有
  `plugin-center-install.test.ts:164`/`:198`（拿 fake 实际返回的 preview 键
  集合做比较）和 `render-check.tsx` 的 `shownFields`。字段名叫 `i18n` 时旧
  正则一个都抓不到，断言以「同意页从不渲染 i18n」变红——信息对、原因错。
  放宽扫描器让它**多**比较一个此前看不见的字段，是收紧不是弱化；同时
  两个 preview 字面量与 render-check 的 `stagedPreview` 都补上了 `i18n`，
  集合比较因此真正覆盖新字段。
- check:render 新增两处：同意页两语言的「Bundled copy: 4 strings · en/zh」
  /「文案：4 条 · en/zh」行；以及喂 `setPluginCopy('mvu', …)` 后目录行显示
  bundle 的 `displayName`、切语言跟随、英文列不漏进中文行，渲染后
  `dropPluginCopy` 复原。

### 牙齿（web 半）

| 断言 | 让它变红的改动 | 结果 |
| --- | --- | --- |
| T5 覆盖层不污染静态键：插件声明 `send`，`translate('en','send')` 仍是壳的句子（plugin-copy.test.ts） | `translate` 的静态路径先查覆盖层（overlay-wins 变异） | 红（fail 1）→ 复原绿 |
| T6 切语言后插件文案跟着换（plugin-copy.test.ts） | `readPluginCopy` 忽略 `lang` 恒读 en 列 | 红（fail 2）→ 绿 |
| T13 同意页渲染 `i18n` 行（plugin-center.test.ts 集合比较） | 删掉那一行 `ConsentField` | 红（fail 1）→ 绿 |
| T3 壳侧：i18n.test.ts 的负例对（zh 列混英文被共享审计拒） | 同 §84 的 CJK 短路 | 与宿主半同一变异，i18n.test.ts 计入那 fail 3 |
| T9 三条确实调 `@iris/text` | 删 `@iris/text` 的导出 | i18n.test.ts 链接失败（fail 1, export not found）→ 复原绿 |
| 风险表点名的一条：`dropPluginCopy` 之后 `getPluginCopy(id)` 是 `undefined`（plugin-copy.test.ts） | ——（行为断言，正向覆盖） | 常绿 |

### What would reopen this

A third interface language (the overlay is two-column by construction, same
trigger as §84's); a need for plugin copy in card frames (the projection that
keeps i18n out of the frame meta is one line in `sandboxPluginRuntime`, but
letting frames read the shell's dictionary is a trust-model question, not a
plumbing one); or a plugin wanting parametric interpolation in the catalog
row — today rows render copy raw, slots and all, and filling them needs data
the row does not have.

### 后记（owner task W2，2026-09-16）：实机脚本的夹具计数不再是字面量

`live-plugin-i18n-check.mjs` 第 168 行的同意页断言写死
`/4 条 · en\/zh|4 strings · en\/zh/`，假定夹具恰好 2 键 × 2 语言。协调人用 3
键夹具跑时这一步 FAIL，而**产品是对的**——页面显示「6 strings」，正是
`preview.i18n.keys` 的和。脚本量具与产品对不上，错在量具。现改为启动时读夹具
自己的 `i18n/en.json`、`i18n/zh.json`，`count = Object.keys(en).length +
Object.keys(zh).length`，断言页面数字等于它；并在 Chrome 启动前先比较两份键
集合，不等就报出是哪两个集合（宿主本来就会拒，量具应先说清）。常量
`fixtureCopy` 的 docblock 写明这是量具不是测试，牙齿是「给夹具加一个键再跑，
期望数字跟着变」——旧的字面量在 3 键夹具上会把正确页判红。

---

## 102. The plugin center's browser-asset row shows the three quantities it always had, under labels that say what each is

**What changed.** U6 件 3. The `<dl>` in `AssetStatus` grows a third revision
cell, and the two old ones say what they are: Catalog revision
(`pluginCenterExpectedRevision`, value unchanged — the snapshot's generation
counter), Manifest revision (`pluginCenterManifestRevision`, **new field**
`PluginBrowserAssetStatus.manifestRevision: number | undefined`, carried by
every reduction branch), Asset content rev (`pluginCenterActualRevision`,
value unchanged — the twelve-hex content rev — now stamped `data-asset-rev`
so tests read the cell by value, not by label proximity). Key names are kept
and values changed; the one new key is added to both dictionaries, which is
what the sheet's "同步两列字典" becomes under that choice. The acceptance
record's「顺手看到」second item (`notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md:47`)
is closed by this and gets a status line in that file; its first item
(headless font fallback) stays open — it is a font question, not this round's.

**The premise the sheet corrected.** The code never compared
`expectedRevision` with `actualRevision`. The only comparison is
`manifest.revision !== revision` (`use-plugin-manifest.ts`, the stale branch)
— two numbers, and the stale row's whole meaning — and *neither* of those was
displayed. The two rendered values just sat side by side under labels that
read as comparable. So the fix is a third cell, not a unification: the
catalog generation and the manifest generation are the same quantity and now
sit beside each other, disagreeing legibly exactly when the row says stale;
the content rev is a different quantity (a hash) and pins nothing against
either. The one thing this round refuses to build is a rendered 一致/不一致
verdict comparing the rev against a revision, because that comparison is the
quantity mistake itself.

**The reduction became a pure function.** `reducePluginBrowserAssetStatuses`
is exported from `use-plugin-manifest.ts`, with `seenRows` passed in rather
than read from module scope, so the status contract is testable without a DOM
and a fetch double; the extraction is mechanical — the nine assignment sites
each gained the one field, and TypeScript named every branch the first edit
missed. §97's surface is unchanged in shape; it shows one more fact per row.

### Teeth

| Assertion | Mutation that reddens it | Result |
| --- | --- | --- |
| pure reduction (`plugin-browser-assets.test.ts`): on `stale`, `expectedRevision !== manifestRevision`, both `typeof number` | fill `manifestRevision` with the snapshot revision — the "make both the same quantity" wrong implementation | red → revert → green |
| pure reduction: on `loaded`, `actualRevision` matches `/^[0-9a-f]{12}$/` and never equals the catalog revision's string form | render a revision into `actualRevision` | red → revert → green |
| mount (`plugin-browser-assets-mount.test.ts`): snapshot 7 answered by manifest 6 mounts `stale` carrying both generations as numbers | same wrong fill, through the real hook | red → revert → green |
| `render-check.tsx` drives the exported `AssetStatus` directly (the consent-page pattern, because SSR never gets past loading): three cells; `data-asset-rev` is twelve-hex and ≠ the catalog revision | delete the third cell while keeping the copy | red → revert → green |
| `plugin-center.test.ts` reads the new copy in both languages | add the key to one dictionary only | red (zh render misses 清单 revision, i18n parity) → revert → green |

### What would reopen this

(a) A caller wanting the manifest generation for logic rather than display —
it is on the status object now, so the temptation exists; the comparison that
makes sense is manifest-vs-catalog (already made in the hook), never
rev-vs-hash. (b) A fourth quantity joining the row — the `<dl>` is getting
long; if it grows again the facts should re-group rather than append.

## 103. 装配面板不再只写「空」：每一行说明是谁写的字节、为什么这一行是 0

**改了什么。** `notes/tasks/M1-PROMPT-BUILD-REPORT.md` 的第一步（web 半）。
面板此前只有「多少钱」；对实测的那个对话，38 行里 23 行是 0，全部渲染成同一个
「空」，而它们背后是三个不同的原因：变量驱动型预设（条目全是 `{{setvar}}`，正文
由后面的 `{{getvar}}` 读出来）、本轮没人填的 marker 槽位、预设作者留白的条目。三
个原因把读者带向三个不同的去处，一句「空」一个也带不到。

行上现在多一块解释：**来源**（是谁写的字节——预设条目、卡字段、世界书、脚本注入、
宿主或对话本身）与 **0 的原因**（本轮宿主实际产出的两种：`macros-only` 与
`marker-unfilled`）。同一行和它展开后的每个 member 用同一个组件渲染，因为契约里
两者带的是同一种 `PromptItemExplanation`。

**决定放在纯函数里，文案在字典里。** `zeroReasonKey(entry)` 与
`sourceNoteKey(entry)` 在 `src/app/itemization.ts` 里：前者只对 `tokens === 0` 的
行给出句子（有正文却带 reason 是宿主自相矛盾，按数字可信的那一边渲染：什么都不说），
后者把来源 kind 映射到一句「卡：scenario」；kind 是闭集，用 `Record` 而不是
`switch`，于是第六种 kind 出现时是编译错误而非空 span。面板只做排版。

**没有正文，也没有密钥。** 报告只带来源名与原因；正文留在宿主的会话里
（`LayoutPart.text` 不上契约），所以从这条形状画出的 `debug.reports` 不会把对话
带进诊断包。两个方向都有测试钉住：宿主侧「the explanation carries no prompt text
and no secret」把一层楼和预设正文送进真实一回合再抓序列化的解释串；web 侧
`i18n` 审计保证两列占位符一致。

**旧记录不装作有解释。** `explanation` 是可选字段：老宿主的记录里它不出现，而
「没解释」必须渲染成它自己，不能编一句没人量过的话——`zeroReasonKey` 与
`sourceNoteKey` 对这种行都返回 `null`。

### 牙齿

| 断言 | 让它变红的改动 | 结果 |
| --- | --- | --- |
| `zeroReasonKey` 对三种原因给出三句不同的 key（`prompt-explanation.test.ts`） | 把三种都映射到同一个 key | 红 → 恢复 → 绿 |
| 非 0 行不给原因（`tokens !== 0` 守卫） | 删掉守卫 | 红 → 恢复 → 绿 |
| 每个 kind 都有来源 key | 去掉 `Record` 里的一行 | 编译红（不是运行期空 span） |
| 两列字典都有这批键、`{name}` 占位一致 | 只加到一个字典 | 红（`i18n.test.ts` 的列一致性） |
| `iris-prompt__explain` / `iris-prompt__zero-reason` 有规则且被渲染 | 删掉 CSS 规则或删掉渲染 | 红（声明的两个方向都查） |
| `data-control="prompt-explained"` 定位符 | 换掉属性或值 | 红 |
| 渲染夹具每行都有解释、且 0 行的原因不唯一（`render-check.tsx`） | 把夹具的两行 0 改成同一个原因 | 红 |

### What would reopen this

(a) 面板长出「消息视图」（手册第二步）：同一块解释要跟着 part 走，届时
`Explanation` 的入参从「行」变成「part」，纯函数不变。 (b) 宏与 regex 阶段（第三步）
给 `PromptItemExplanation` 加字段，面板展开后显示——那时 `data-control` 会多一个
折叠三角，本条的定位符不动。 (c) 若某天宿主开始产出 `blank`/`trimmed`，字典里
已有对应的两句，是补测试而不是改文案。

> 复查（2026-09-17，e668785）：重开条件 (a)「面板长出消息视图」已成立——证据 web §104（M1 第二步落地）。决定**部分**改变：视图已落地，但 `Explanation` 仍收 `entry`，对 part 喂一个合成对象，而不是本节预测的「入参从行变成 part」。

## 104. 提示词面板长出「按消息」视图：同一份装配的另一个方向

**改了什么。** M1 第二步的 web 半。面板原来只有「按部分」一张表——每行是一个
contribution，说它花了多少 token。现在顶部多一个切换：**按消息**列出这条请求真正
发出的每一条消息（第几条、什么角色、多少 token、是否在缓存前缀里），每条展开显示它
由哪些 part 组成。两个视图是**同一次装配**的两个方向：`entries[].explanation.placement`
说每个 part 进了哪条消息，`messages[].partIds` 说每条消息装了哪些 part，宿主在一趟里
把两者一起算出来，所以不可能互相矛盾。

**为什么只读一个字段不够。** 面板原来要回答「什么在吃我的上下文」，按大小排的表是
对的；但「实际发出去的是什么、按什么顺序」是另一个问题，而一张 contribution 顺序
的表答不了——depth 注入在表里是一行，在请求里是回复前的最后一条消息。两个形状答一个
问题的两面，所以做成切换而不是并排：读者挑形状，不是同时看两份。

**纯函数持有决定。** `messageRows(itemization)` 把消息的 `partIds` 解析成可渲染的
part：能在 entries 或 members 里找到的得到它的标签、kind 与 explanation；找不到的是
对话楼层（`history.N`），渲染成「第 N 层」——对话按契约是**一条聚合行**，所以楼层没有
可查的 entry，它的编号就是这里能诚实说的全部。返回空数组表示旧宿主没发 `messages`，
切换根本不出现（一个打开就空的标签页会被读成缺陷，而不是旧宿主）。

**`stable` 的措辞不是一个词两个意思。** 消息头上的「已在缓存前缀 / 在变更之后」来自
消息自己的 `stable`，与行视图里那个 per-part 判断同源——都是 `stableBoundary` 一次
walk 的结果。一个在变更之后的消息把它所有的 part 一起带出去，因为缓存服务的是整段
字节。

---

---

## 105. 内置插件的「浏览器资产」一栏说人话：`undeclared` 且 `source === 'builtin'` 时三格换一句话

Dated 2026-09-16 (owner task sheet W1, branch
`dev/plugin-center-builtin-asset-copy` against `035094e`). Web-only; the host
half of the asset surface is untouched.

**现状与实测**。内置两行（TavernHelper、MVU）不带 `client.js`，它们的帧侧
成员打在**核心成员包**里，所以聚合清单 `{"revision":4,"plugins":{}}` 对它们
是**正确的**——实测 8787 上清单空到没有任何 plugin 行。但 `AssetStatus` 把
这正确的事实渲染成三格「浏览器资产：未声明 / 资产内容 rev：无 / 最近成功加载：
从未」，读起来像故障。表达差，不是数据差。

**改法**。`AssetStatus` 里加一个布尔：`plugin.source === 'builtin' &&
asset.phase === 'undeclared'`。为真时不再渲染那五格
（`pluginCenterBrowserAsset` 起的那部分），改渲染一句
`pluginCenterBuiltinAssetNote`：「内置插件的帧侧成员随核心成员包加载，没有
独立的浏览器包。」（en 同义）。宿主运行时那一格仍在——它仍然回答「这个行
现在跑不跑」。句子自己带 `data-plugin-builtin-asset-note` 戳，测试按行切片
读它，不靠整页模糊匹配。

**边界**。只有**显式** `source: 'builtin'` 走这一支。`source` 在线上是可
选的——缺席的意思是「这个宿主对这行的字节来源没有记录」——所以缺席不做
假设。第三方行（`git`/`dev`）即使同样是 `undeclared` 也保留五格：对它们，
「没有清单行」是**真信息**，正是这一栏存在的理由。判据是 `phase ===
'undeclared'`，所以一个真的在加载/加载好/降级的 builtin 行（理论上不该有，
但形状上可能）仍显示它真实的相位，不被这句话糊掉。

**文案两语**。`pluginCenterBuiltinAssetNote` 进 `en`/`zh` 两列，`i18n.test.ts`
的三条（zh 含中文、两列槽位一致、用到的键存在）自然覆盖——这句话没有槽位，
zh 列含中文，键两列都有。

---

---

## 106. 卸载行旁的「同时删除它存的数据」复选框：默认不勾、只显示在真有数据的行、勾了才传 `removeData`

Dated 2026-09-16 (owner task sheet W5, branch
`dev/plugin-uninstall-remove-data` against `035094e`). The host half of this
round is §87 on `notes/packages/iris-app-service`.

### 形状

- **行的可选字段 `dataFootprint?: { files, bytes }`** 是页面上数字的唯一来源。
  宿主在 `plugin.list` 时测量（`refreshFootprints`），所以它反映的是「用户刚
  打开/刷新的这一页」时磁盘上的事实。无数据的行没有这个字段——**没有复选框**。
  不给零值行显示一个「删除 0 个文件」的勾选框：那是一个承诺删不掉任何东西的
  控件。`plugin.installed` 也不够：未安装的行本来就没有数据。
- **复选框，不是第二个按钮**。决定是卸载的一个形容词，不是独立动作；它改的
  就是旁边那颗卸载按钮。标签把代价说全：「同时删除它存的数据（3 个文件，2 kB）」
  / `Also delete the data it stored (3 files, 2 kB)`，`{files}`/`{size}` 来自
  宿主自己的测量，不是页面估算的。数字格式化复用 `describeBytes`（同意页
  同一套）。
- **默认不勾**，逐行独立，且卸载一跑就把那一行的勾**擦掉**（无论行是否真的
  离开）：一次陈旧的勾不能活到下一次尝试。
- **不勾就不传**。store 的 `uninstallSystemPlugin(id, removeData?)` 在
  `removeData !== true` 时发 `{ id }`——与 W5 之前的客户端**逐字节相同**的
  请求形状。发 `removeData: false` 也能用，但那样「这个客户端知道有选项」就
  和「这个用户要了默认」分不开了，而保持旧形状不花任何代价。

### 测试侧

`plugin-center-install.test.ts` 挂载真实组件、对真实 fake 驱动点击，断言的是
**客户端被调用时的参数**（不是页面说它发了什么）：

- 勾选框只出现在 `dataFootprint` 存在的行上（用具名行切片，不用整页模糊匹配）；
- 默认 `checked === false`；
- 标签正文是两个数字 `(3 files, 2 kB)`；
- 不勾 → `plugin.uninstall` 的 params 是 `{ id }`；
- 勾上再卸载 → params 是 `{ id, removeData: true }`。

fake 侧（`iris-client-fake/tests/system-plugins.test.ts`）只镜像一个可观察后果：
带 `removeData` 时行的 `dataFootprint` 消失、不带时保留。fake 没有目录可删，
假装删了它从未拥有的字节是更差的模型。

---

---

## 107. 卡脚本的 `console.*` 进诊断面（帧与壳半）：有界序列化、每卡限流、以及一条自己走完的往返

Dated 2026-09-16 (owner task sheet W7, branch `dev/sandbox-console-capture`
against `035094e`). The host half is §91 on `notes/packages/iris-app-service`.

### 为什么这条是「上游领先的最后一项」

`docs/OBSERVABILITY.md` 的十二项状态表里，第 1 项（分 frame 的日志视图）是唯一
一条「上游有而我们没有」：酒馆助手 4.3.0 起 `log.js` 覆盖五个 console 方法并
在 Logger 面板显示，而 Iris 的沙箱里没有任何 `console` 接管。这一项做完，表里
再无上游领先项。

### 三层，各修一处

**帧侧（`apps/iris-web/src/sandbox/`）**

- 新模块 `console-capture.ts`：`serializeConsole`（纯函数，有界序列化）+
  `RateGate`（每卡每秒 50 行）+ `installConsoleCapture`（包裹四个方法）。
- `frame-entry.ts` 在 `installSandbox` 之后、任何 body 之前装一次，sink 把结果
  post 成新的帧→壳消息 `console`，带 `scriptId`（最后一个 `run` 消息的 id，和
  帧自己的错误归因同一个近似）。
- **包裹但仍调原始**：卡作者对着 devtools 开发，原行必须继续出现在浏览器控制
  台。顺序是先 forward 再 apply（原文已废弃：serializer 抛错不能连浏览器那行
  一起丢）；`apply(target, args)` 而不是裸调用，因为某些引擎要求 console 作
  receiver。
- **只捕四个**：`log/info/warn/error`。`console.debug` 不捕——上游 `log.js` 虽
  然覆盖它，但上游自己就往它写几百行，捕它会把卡自己的输出埋掉。
- **不捕未处理异常**：那已经由 `reportAsyncFailures` 走自己的通道，上游也没把
  它们并进 Logger。
- **摘要而不是原参数**：`postMessage` 的 structured clone 会在函数、DOM 节点、
  抛错的 getter 上失败，而捕 console 的全部意义是它本身绝不能弄坏卡。所以每个
  值在帧里就变成文本。深度 4、每条 12 项、单值 512 字符、整行 4000 字符，截断
  在文本里可见（`…N more` / `…+M chars`）——读者分不出短字符串和被截断的字符串
  就等于分不出健康卡和坏摘要。循环引用安全（`WeakSet`，且出栈时移除，所以一个
  重复但非循环的引用会被各描述一次而不是误报 `[Circular]`）。
- **两个非显然的读取**：`Map`/`Set` 报大小而不是走 `Object.keys`（后者对任何非
  空 Map 都答 `{}`，是**读错**而不是读少）；抛错的 getter 具名（`boom: [getter
  threw]`）而不是让整次 console 调用失败。

**壳→宿主（`client/store.ts` 的 `reportCardConsole`）**

- 帧的 `console` 消息 → `runner.ts` 的新 hook `onConsole` →
  `useCardScripts.tsx` → `actions.reportCardConsole` → `script.report`。
- 不 await：一次 console 调用不该等一个往返。
- 无 `chatId` 就丢，不编一个：宿主会拒一个不存在的会话，编一个只是把错放到更
  远的地方。
- 失败**不吞**：宿主拒了就 `addCardReport(..., { grade: 'fault', channel:
  'card-console' })`，落在读者已经在看的那张列表上——否则「宿主没记下卡的
  console 行」和「卡什么都没打印」长得一样。

**诊断页**：`HostReports` 已经按 `kind` 过滤，`card-console` 自成一个过滤按钮，
两语文案只加了这一条 kind 标签（实际不新增壳文案：kind 名直接显示）。

### 边界与代价

- **默认开**：这是可观测性不是执行权限，和上游一样常开。
- **本地**：`DiagnosticBuffer` 不落盘（记录在案），所以卡打印的敏感内容只在本机
  内存里；文档写明这一点。
- **限流是保护不是礼貌**：缓冲是 2000 条 / 1 MiB 有界的，一张在渲染循环里打日志
  的卡每秒能打几千行，全部过界会把读者打开这一页要看的报告挤出去。所以每卡每秒
  50 条，**且把丢弃数写在下一行**——看见 40 行而没有计数器的人会以为卡只打了 40。

### 测试与文件

- `apps/iris-web/tests/console-capture.test.ts`（18）：序列化的每一条上限与
  marker、循环与重复引用、抛错 getter、Map/Set、10 MB 字符串、包裹的顺序与
  receiver、只取四个、限流计数。
- `apps/iris-web/tests/card-console-store.test.ts`（4）：store 转发的参数形状、
  无 chat 丢弃、宿主拒绝时上报告列表。
- `packages/iris-client-fake/tests/card-console.test.ts`（2）：fake 的
  `script.report` → `debug.reports` 往返。
- `packages/iris-app-service/tests/diagnostics.test.ts`（+3）：宿主半，见 §88。
- `apps/iris/tests/rpc-transport.test.ts`（+1 探针）。

### 牙齿

| 断言 | 让它变红的改动 | 结果 |
| --- | --- | --- |
| `messageRows` 保序解析一条多 part 消息（`prompt-explanation.test.ts`） | 把 `partIds` 反转 | 红 → 恢复 → 绿 |
| 楼层渲染成「第 N 层」且标 `floor` | 把楼层的分支去掉，只返回 id | 红 → 恢复 → 绿 |
| 两个方向各自可读（漂移可见） | 让 `messageRows` 从 `placement` 反推消息 | 红（漂移不再可见） |
| 面板的两个视图切换在 `messages` 缺席时不渲染 | 去掉 `messages.length === 0` 守卫 | 红 |
| `iris-prompt__messages` 等类有规则且被渲染 | 删掉 CSS 规则 | 红 |
| `data-control="prompt-messages"` 定位符 | 换掉属性值 | 红 |
| 渲染夹具两视图一致、且同时有已缓存与未缓存消息（`render-check.tsx`） | 把夹具的 `stable` 全置 true | 红 |

### What would reopen this

(a) 消息视图要显示每层的 token：对话是一条聚合行，楼层只有所属消息的成本——拆开它就
是「把 UI 的假设塞进装配器」，正是聚合行存在的原因。 (b) 宿主驱动器的 `squashSystemRuns`
在 `assemble` **之后**合并消息，所以 `messages[]` 描述的是 squash 前的列表；要看提供方
自己的消息边界需要驱动器的 `PromptLayout`，那是另一份契约（带正文、骑在
`GenerateOptions` 上），两者刻意不合并。

---

| 内置两行（`pkg-builtin`、`pkg-builtin-two`）的**行内切片**出现 `data-plugin-builtin-asset-note` 与那句话、且不含 `Never` / `Browser asset`（`plugin-center.test.ts`） | 删掉 `source === 'builtin'` 条件（`builtinNote = asset.phase === 'undeclared'`） | 红：第三方 `pkg-install-failed`（`git`、`undeclared`）被套上同一句话，`doesNotMatch(/data-plugin-builtin-asset-note/)` 与「仍显示三格」两条断言同时红（实测 fail 2，两测试都红）→ 复原绿 |
| 一个 `git` 且 `undeclared` 的行仍出现 `Browser asset` 与 `Never`（同上） | 同上（同一变异，反向断言） | 红 → 绿 |
| 中文渲染里这句话出现**恰好两次**（两个内置行） | 只给 en 列加键（zh 缺键 → i18n 审计先红）或只改一行 | 红 → 绿 |
| `render-check.tsx` 直接驱动导出的 `AssetStatus`：`source: 'builtin'` + `undeclared` → 句子且无 `Never`；同一 asset 换第三方行 → 三格仍在 | 删条件 / 删句子 | 红 → 绿 |

### What would reopen this

(a) 内置插件开始自带 `client.js`——那时 `undeclared` 不再是它们的常态，这一支
应当随 `phase` 自然退出，而不是被删；判据是相位，不是身份，所以它会自己退。
(b) 线上快照给每个内置行盖上 `source`（今天只有 v1→v2 迁移和注册过的内置
id 会盖，虚拟目录里缺席）——那会让这句话在更多行上出现，是预期方向。
(c) 第三方插件的「真缺失」也需要更明确的文案——那是另一栏的事，不是把
这句话扩大到所有 `undeclared`，那正是这次变异要防的错。

---

| 无 `dataFootprint` 的行**没有**复选框（`page.find('[data-plugin-remove-data="tavern-helper"]') === null`） | 删掉 `plugin.dataFootprint !== undefined` 条件（行一律显示勾选框） | 红（勾选框出现在无数据行上；断言还发现 `data-plugin-remove-data="mvu"` 本应是那一个）→ 复原绿 |
| 未勾选卸载的 params 恰为 `{ id }` | store 恒发 `{ id, removeData: <checked> }` | 红（`{ id, removeData: false }`）→ 绿 |
| 勾选卸载的 params 为 `{ id, removeData: true }` | `run()` 里丢掉 `removeDataFor.has(plugin.id)` 的读取 | 红（发的是 `{ id }`）→ 绿 |
| 标签正文 `(3 files, 2 kB)` | 直接把字节数渲染成 `2048` | 红 → 绿 |
| fake：带 flag 去 footprint、不带保留 | fake 的 flag 分支删掉 | 红 → 绿 |

### What would reopen this

(a) 行上出现第二个可删的数据根（缓存、导出）——一个布尔装不下，需要一个显式
列表而不是第二个勾选框。(b) 卸载前想显示「哪些键」而不是「多少」——`dataFootprint`
只有数量，键名需要另一个只读方法，而键名可能泄露插件内部命名，是一个隐私判断
而不是显示判断。(c) 一次卸载会连带删除别的行的数据（级联）——今天复选框只
影响它自己那一行，级联删除需要自己的同意面。

---

| 「10 MB 字符串被截到值上限且带 marker」 | `MAX_VALUE_CHARS` 改成 10 000 000 | 红（2 条：值上限与 10 MB 字符串）→ 复原绿 |
| 「循环引用不炸且说 `[Circular]`」 | 去掉 `seen.has(object)` 分支 | 红（栈溢出/断言）→ 绿 |
| 「重复但非循环的引用各描述一次」 | 去掉 `finally { seen.delete(object) }` | 红（误报 `[Circular]`）→ 绿 |
| 「限流把丢弃数写在下一行」 | `CONSOLE_BUDGET_PER_SECOND` 改成 100000 | 红 → 绿 |
| 「宿主拒绝时上报告列表」 | store 的 catch 里改成 `void error`（吞掉） | 红（「console output could not be filed」不再出现）→ 绿 |
| 宿主 `grade === 'note'` | 改成 `'fault'` | 红（见 §88）→ 绿 |
| fake 往返 | fake 的 `script.report` 分支删掉 | 红 → 绿 |

### What would reopen this

(a) 卡开始用 `console.group`/`console.table`——今天的形状是平铺四 level，结构化
需要能带嵌套的正文。(b) 一个「跟到 devtools 之外还要落文件」的需求——落盘先得
回答敏感内容和保留期。(c) 帧里出现第二个 console 消费者（比如插件自己的 client
也打 console）——今天包裹的是 `globalThis.console`，第二个消费者会连着被包一层，
需要先决定谁拥有它。

---

## 108. 提示词面板说出宏与 regex 两阶段做了什么

**改了什么。** M1 第三步的 web 半。`Explanation` 组件（行视图与消息视图共用）除来源与
0 的原因外，再渲染两行：**宏阶段**「展开了 N 种宏（setvar ×61），1250 → 0 字符」与
**regex 阶段**「regex 改写了这段：去除变量更新」。这一步把第一步那句「空」真正补完：
变量驱动型预设的 0 行现在说出了它做了什么，而不是只说它没出字节。

**`macroNote` 取次数最多的头，不取第一个。** `setvar` 跑 61 次、其余各一次，「哪个头、
多少次」才是信息量；并列时按首次出现序，所以同一状态渲染两次一致。`macroNote` 对「未
记录」与「记录了但没任何头解析出来」都返回 `null`——对读者是同一件事：这一行没有宏
可说。

**`regexNote` 把「跑过没改」与「没记录」分成两种返回。** 「记录且为空」返回 `[]`，面板
说「regex 跑过，没有改动」；「未记录」返回 `null`，面板什么都不说。空串会把前者渲染成
后者，而这两件事把读者带向不同的去处（一个去看规则为什么没命中，一个去查宿主版本）。

### 牙齿

| 断言 | 让它变红的改动 | 结果 |
| --- | --- | --- |
| `macroNote` 取最多的头（`prompt-explanation.test.ts`） | 删掉「取最多」的循环，只取第一个 | 红 → 恢复 → 绿 |
| `macroNote` 对无头 trace 返回 null | 返回 `heads.length` 不判空 | 红 → 恢复 → 绿 |
| `regexNote` 区分 `[]` 与 `null` | 把未记录也返回 `[]` | 红 → 恢复 → 绿 |
| 两列字典都有宏/regex 文案且槽位一致 | 只加到一个字典 | 红（i18n 列一致性） |
| `promptMacros` 的五个槽位、`promptRegex` 的 `{rules}` | 去掉一个槽位 | 红 |
| 渲染夹具带宏行（61 × setvar、after=0）与已命中的 regex 行（`render-check.tsx`） | 把夹具的 `regex.applied` 改成空 | 红 |

### What would reopen this

(a) 面板要展开显示每个宏头的**取值**（`{{pick}}` 抽到了哪支）：那是正文，与「报告不存
正文」的铁律冲突，要另设计（哈希或本地会话按需读）。 (b) 第四步的差异联动：宏/regex
两行会跟着 divergence 一起显示「和上一轮比变了没」，届时 `Explanation` 的入参不变。

## 109. 提示词面板说出预算裁掉了什么，并把差异标记带进消息视图

**改了什么。** M1 第四步的 web 半。面板原来只说「丢了 N 条消息」；现在多一句更完整的
账：「为装下这些，已丢弃更早的 3 条消息（1,842 token）」——条数、重量都在，来源是宿主
裁剪那一趟自己算的 `overflow` 对象，**不是**面板把丢掉的历史再数一遍。老宿主只发条数
时，`overflowNote` 回退到那句旧的「丢了 N 条」。

**消息视图带上了同一份差异标记。** `ItemMark` 本来只在行视图的每一行上；第四步把
`compared` 传进 `MessageView`，于是同一次 `prompt.divergence` 比较在「按部分」和「按
消息」两个视角下都标出来。两个视角按同一个 part id 查同一张表，所以不可能一个说变了、
另一个说没变。「现有 `ItemMark` 不动」是手册的原话，这里只是把同一份查找喂给第二个
视图。

**`overflowNote` 优先读对象、回退读计数，绝不把计数当成重量。** 老宿主的记录里没有
`overflow`，只有 `droppedHistory`；把那个数当成 `droppedTokens` 印出来，就是替一个
没人量过的数字背书。`droppedHistory: 0` 时返回 `null`，于是「没裁」不产生一句话——
那是常态，不需要说明。

### 牙齿

| 断言 | 让它变红的改动 | 结果 |
| --- | --- | --- |
| `overflowNote` 优先带出重量（`prompt-explanation.test.ts`） | 只读 `droppedHistory`、忽略对象 | 红 → 恢复 → 绿 |
| `overflowNote` 在计数为 0 时返回 null | 把 0 也渲染成一句话 | 红 → 恢复 → 绿 |
| 消息视图渲染 `ItemMark` 且按 `part.id` 查表 | 把 `compared` 从 `MessageView` 的入参里去掉 | 红 → 恢复 → 绿 |
| 两列字典都有 `promptOverflow` 且槽位一致 | 只加到一个字典 | 红（i18n 列一致性） |
| 渲染夹具带 `overflow`（3 条 / 1,842 token，`render-check.tsx`） | 把夹具的 `overflow` 去掉 | 红 |

### What would reopen this

(a) 消息视图要标出「这条消息里的 part 被裁了什么」：被裁的楼层根本不在请求里，消息视图
自然没有它——要显示得另开一个「已丢弃」区块，不是给消息打标。 (b) 重量单位若从 token
换成一个更诚实的度量（字节？），`overflowNote` 的返回形状要跟着改。 (c) `droppedIds`
在面板上的落点：今天只随对象传下来，面板还没按它高亮对话里的对应楼层——那是显而易见的
下一步，且不需要契约再变。

---

---

## 110. 正文标签只管散文怎么排、脚手架怎么折，不管哪些块有资格成为界面

**Kind:** compatibility gap（已关闭）。上游在围栏文档所在处建 frame，与它在不在
`<content>` 里**无关**；Iris 曾经不是这样。

**错在哪。** `MessageInterfaces.tsx` 的派生链是
`text → repairStrayFences → bodyText = leak.body ?? display → claim / 控制器 / 切片 / 回退`。
`bodyText` 是**正文标签里的那一段**，于是「标签内/标签外」这条判据悄悄决定了**哪些块
有资格成为界面**。预设教模型把散文包进 `<content>`，卡片自己的显示正则产出的整段
HTML 因此**按构造**落在 `head`/`tail` 里——越服从预设的卡，界面越会被判成脚手架。

2026-09-17 的卡族回归实测（`notes/CARD-REGRESSION-2026-09-17.md` 异常 A）：本轮 15 个
可渲染回复里 **13 个** `displayBlocks>0 && bodyBlocks==0`；**12/14 张卡**的回复楼层
`frame=0`、`iframe=0`。定点对照（同一段文本，只有块结构不同）：

| 变体 | 文本 | claim 块数 | 浏览器建 frame |
| --- | --- | --- | --- |
| A | 只留第一个围栏文档 | 1 | 1 |
| C | 只留最后一个围栏文档 | 1 | 1 |
| D | 两个围栏文档，无 `<content>` 散文 | 2 | 2 |
| M6 | 三个块（围栏+裸 HTML+围栏），无 `<content>` 散文 | 3 | **3** |
| M7 | 同 M6，**加上 `<content>` 散文区** | 3 | **0** |

因果开关：把 `localStorage['iris.bodyTag']` 设成一个不匹配的名字，同一文本立刻建出 3 个
frame；设回默认 `content` 又变 0。**不是帧层、不是宿主层、也不是模型输出本身。**

**第二半：连折叠件都没落地。** claim 读 `bodyText` 时，界面全在标签外的消息 claim 到
**零个块**，于是走进「无块快路径」`blocks.length === 0 && styles.length === 0`——那条
路径只 `return` 散文，`head`/`tail` 连 `.iris-bodyleak` 都不渲染。卡片的整块状态栏就这样
离开屏幕，**现场没有任何线索**。看不见的丢失比看得见的错更贵。

**裁决（coordinator，不再重议）。** 正文标签决定**散文怎么排、脚手架怎么折**；它**永远
不决定哪些块有资格成为界面**。依据是上游：`RENDER.md` §「Measured: what upstream
actually triggers on」写明 frame 判据是 `<pre>` 文本里含 `html>`/`<head>`/`<body`，上游对
正文标签一无所知，所以围栏文档在哪它就在哪建 frame。

**修法的形状。** 新的派生链：

```
text →(流式门)→ display = repairStrayFences(text)
     →(claim/控制器)→ claimMessageSurfaces(display) / useMessageInterfaces({ text: display })
     →(正文标签作为**区间**)→ layOutMessageBody(display, bodyTag, blocks, styles)
     →(切片)→ interface / text / scaffold 三种段，按源序
```

- `body-tag.ts` 增 `locateBodyTag(text, tag) → BodyTagSpan`：同一套匹配规则，产出**偏移**
  而不是三段字符串。`splitBodyTag` 现在就是它加三次 `slice`，所以「散文从哪开始」只有
  一个地方判定。未标签时是恒等（`bodyStart=0, bodyEnd=len`）。
- `splitAroundInterfaces` 多一个可选的 `prose` 区间参数：**区间而不是子串**，这正是它无法
  隐藏任何块的那个性质。区间外的文本run 以 `kind: 'scaffold'`（带 `edge`）返回给行去折；
  标签自己的两段标记（`<content>`/`</content>`）像 `<style>` 跨度一样，在**同一次遍历**里
  被丢弃——事后再删会挪动 claim 赖以命名的每一个偏移。不传该参数时，产出逐字节等同旧行为。
- 新文件 `app/message-body.ts` 的 `layOutMessageBody`：把行里原本四行的组装挪成一个**可被
  测试调用的函数**。这条是本次最重要的结构性决定——三个函数各自都对，错在它们之间那个
  没有测试能渲染的组件里。
- 行的快路径保留（`MarkdownText` 的 `streaming` 只在那条路上给），但现在在散文两侧渲染
  `BodyLeak`：到得了那一行的消息是**真的全篇没有界面**，它的 head/tail 就是普通脚手架。
- 折叠件**按源序就地渲染**，不再汇到 fragment 两端：服从预设的卡，head 是「导演本→状态栏
  →更多导演本」，中间那块是 frame。

**旁证：预算层从来没有这个缺陷。** `ChatPane.tsx` 的 `budgeted` 用
`repairStrayFences(message.text)` 规划，**不经过正文标签**。于是每一条带标签的消息上，
预算层看见 N 个块、行看见 0 个——两层对「这一楼有几个界面」的答案长期不一致，而这恰恰
不会红：预算多留了配额没人投诉。修好之后两边读同一个串，这条不一致一并消失。

**顺带改变的一件事，记在这里以免以后被当成回归。** claim 现在读整条消息，所以写在
`head`/`tail` 里的 `<style>` 也进入这条消息的样式表并被复制进区域帧——以前它们在
`bodyText` 之外，样式表根本看不见。这与「卡片的界面是卡片的界面，不看它在标签哪一侧」
同一条裁决。

**两处既有源码断言按新链改写（不是放松）。** `stray-fences.test.ts` 的
`claimMessageSurfaces(bodyText)` / `text: bodyText` 钉的正是这条缺陷链；改写后钉的仍是
「claim、控制器、切片读同一个串」这条不变量，并且额外钉死了**是哪一个串**——偏移所在的
那一个。`frontend-blocks.test.ts` 两处读行源码的接缝断言改读 `message-body.ts`（接缝搬去
哪就读到哪），并各加一条钉住行确实把 `blocks`/`styles` 交了出去。

### 牙齿

夹具是回归记录的变体缩微版（M6/M7 那一对，加 A/C/D 对照），写在
`tests/body-tag-interfaces.test.ts`，调用的是行自己的 `layOutMessageBody` 而不是它四行的
拷贝——拷贝正是那种「行回归了它还绿着」的东西。M7 夹具自带**判别力对照**：用旧办法
（claim 读 `splitBodyTag(M7).body`）必须得 0，否则这个夹具什么也没证明。

| 断言 | 让它变红的改动 | 结果 |
| --- | --- | --- |
| 行的 claim 读 `display`（`stray-fences.test.ts` 源码断言）+ `check:render` 有 slot | M1：`claimMessageSurfaces(display)` → `(bodyText)` | 红（「the row claims over the whole repaired message」；render：「an interface outside the body tag did not get a slot」） |
| 控制器读同一个串 | M2：`text: display` → `text: bodyText` | 红（「the controller claims the same string the row splices」） |
| 切片读同一个串 | M3：`layOutMessageBody(bodyText, …)` | 红（「the splice reads that same string…」） |
| 折叠件不丢（head/tail 都在）+ `check:render` 有 `.iris-bodyleak` | M4：在组装末尾滤掉 `scaffold` 段 | 红（「head and tail must both survive, got 0 folded pieces」；render：「the scaffolding around it is not reachable in the fold」） |
| M6/M7 claim 块数相等、三个都到行 | M5：只保留落在标签区间内的块 | 红 4 条（「and all three reach the row as interfaces」等） |
| 标签标记不进散文 + `check:render` 不出 `&lt;content&gt;` | M6：从 dropped 列表里去掉 `tagMarkup` | 红（「the document outside the wrapper is an interface…」；render：「the body tag markup was printed at the reader」） |
| 匹配的标签仍然折叠脚手架 | M7：`prose` 恒为 `undefined` | 红（「head and tail must both survive」「and the matching tag still folds the scaffolding」） |

七个变异全部至少红一条。**记下判别力的边界**：M1 与 M2 在单元层只被**源码断言**抓住
（claim 的输入是在组件里选的，单元测试自己传参，看不见这个选择），M1 另有
`check:render` 抓住；M2 目前只有源码断言一条腿——把消息流真正跑起来的浏览器验收才是它
的第二条腿。

### What would reopen this

(a) 预设生态放弃正文标签约定，或上游给正文标签一个正式字段：届时区间的来源变了，`prose`
参数的形状不变。 (b) 出现「标签外的块应当被当成脚手架」的真实卡形（例如模型把示例 HTML
写进导演本）：那要的是**新的判据**（谁写的、为什么），不是把正文标签重新接回 membership
——本节裁决的就是后者。 (c) 开标签落在某个被 claim 的围栏块**内部**（模型把 `<content>`
写进代码块）目前是温和退化：markup 跨度与块重叠，块赢，标签标记留在块自己的正文里。真
出现这种卡，应当在 `locateBodyTag` 之前先排除代码块区间，并在此处补记。

---

## 111. 「the library preset never executed」读的是 bootstrap 那一瞬，不是 preset 跑完之后

**Kind:** 自有仪器的报告缺陷（不是兼容性差异），已修。

**这句话是什么。** `describeLibraryState` 是 Iris 的增量仪器：一帧只能看见「某些全局不在」，
看不见「为什么」，而两个原因把读者送去相反的方向——**一次请求失败**（拦截、404、解析错，
每个缺名都是它的后果）与**若干个真缺口**（Iris 确实不带这些库，一个一个决定）。preset 的
最后一条语句写一个标记，这条仪器就靠那个标记在两者之间裁决。**这条函数本身没错**，
`library-state.test.ts` 原有的十条断言全部成立。错的是**谁在什么时刻调用它**。

**测到的时间线**（读于 `origin/main` `64d18ab`，产品代码 `0aa3ede`；行号是改前的）：

| # | 位置 | 发生什么 |
| --- | --- | --- |
| 1 | `apps/iris-web/src/sandbox/srcdoc.ts:756` | bootstrap 的 `<script src>`：classic、**无** `async`/`defer` → 阻塞执行 |
| 2 | `apps/iris-web/src/sandbox/frame-entry.ts:1890` | 这个脚本在**顶层同步**调用 `installSandbox({...})` |
| 3 | `apps/iris-web/src/sandbox/frame.ts:3011` → `:3103` | `if (env.interfaceFrame === true && hasTavernHelper)` 块里同步调 `env.reportMissingGlobals?.(EXPECTED_GLOBALS)` |
| 4 | `apps/iris-web/src/sandbox/frame-entry.ts:2163` | 钩子实现**当场**读 `host[PRESET_MARKER]`、`expected.filter(...)`、`document.querySelector('script[data-iris-lib]')`，当场组句、当场 `post` |
| 5 | `apps/iris-web/src/sandbox/srcdoc.ts:823` | preset 的 `<script src … data-iris-lib>` 这时才轮到——它在文档里排在 bootstrap **之后**，理由写在 `srcdoc.ts:672`（bootstrap 必须先拿到通道和错误处理，否则库加载失败就没人能说） |
| 6 | `apps/iris-web/src/sandbox/preset-entry.ts:257` | preset 的最后一条语句写下标记 |

第 4 步因此**必然**读到三件事：标记未设、恰好那八个 preset 自己要发布的全局缺席、
preset 标签连解析都还没解析出来——最后一点就是线上那句话里 `(the preset script)` 这个
兜底 URL 的来历，它是自带的物证。**这不是竞态，是固定的文档顺序**，每一帧每一次都这样。

owner 的 CDP 反证（爱衣 5 个 frame 逐个读）：`__iris_preset_loaded__` 5/5 为真、
`__iris_message_preset_loaded__` 5/5 为真、`__iris_preset_error__` 5/5 为 `null`、
十个 `EXPECTED_GLOBALS` 全部有定义。语料 11 张卡里 **10 张**逐楼层各一条，唯一没有的是
无脚本卡（`hasTavernHelper` 为假，根本不进第 3 步）——那正是这一列的阴性对照。

**一处前提更正。** 复跑记录把另一个调用点 `frame.ts:2950` 记成「`message.type === 'context'`
快照处理器（`:2639` 起）内」。实读是 `message.type === 'run'` 分支（`frame.ts:2784`，
try 从 `:2867` 起），也就是**脚本帧跑卡脚本**的路径；壳只在帧 `ready` 之后才发 `run`，而
`ready` 挂在 `load` 上（`frame-entry.ts:168`），所以那个调用点**本来就在 preset 之后**，
不误报。误报只有 `:3103` 一个来源——这也正好解释了计数为什么是「每个有 frame 的楼层一条」
而不是「每个脚本一条」。

**裁决。** 诊断不删：一个真的没跑起来的 preset 必须被点名，`blocked, missing, or
unparseable` 是这句话里最有用的半句。改的是**什么时候读**——报告要在它所描述的那个状态
真正到达之后才组句，并且在标记还可能翻转的时候**永远不许**说「从来没执行」。

**修法。** `library-state.ts` 多出 `PRESET_SETTLE_TIMEOUT_MS`、`LibraryProbe`、
`reportLibraryState(probe)`。realm 的六个读数全部是 thunk——整件事的要点就是它们可能比
「请求出报告」的那次调用晚，并且必须为**那个**时刻作答。三支：

- 标记已为真 → 当场出。此时若仍有缺名，那是真缺口，走既有的 gap 句式。
- 文档已解析完（`readyState !== 'loading'`）→ 当场出。preset 标签的回合已经过去，
  标记仍未设就是真结论，按名上报。
- 否则推迟到 `DOMContentLoaded` 与 15 s 上界里**先到的那个**，并在那一刻**重读**而不是
  重放：中途翻转的标记会换掉组出来的句子，而不是只决定发不发。最多报一次。

`frame-entry.ts` 的钩子只剩下把六个读数交出去；`DOMContentLoaded` 而不是 `load`，因为
阻塞的 classic `<script src>` 到那时已经跑过或已经确定失败，等子资源只会把一条真结论压在
一张无关的图后面。

**上界的边界，照实记。** 被拦、404、语法错的 preset **不会**卡住解析器（浏览器发 error
事件、解析继续），所以正常路径是 `DOMContentLoaded`，毫秒级；15 s 那条腿只覆盖「请求既不
完成也不失败、文档永远解析不完」这一种形状，那时把诊断永远扣住才是更坏的失败。它同时是
本次唯一留下的窗口：上界到点时解析仍在进行，标记理论上还能翻转。取 15 s 与
`frame-entry.ts` 的 `IMPORT_TIMEOUT_MS` 同量级，理由相同——那是这一帧对「多久之后我就说」
的既有答案。

**上游对照。** SillyTavern 自己**没有**这条仪器，而且结构上不可能有这种失败：
`public/index.html:8186`–`:8202` 把每个库都写成阻塞的 classic `<script src>`，应用代码
`script.js` 是 `type="module"`（天然 defer），所以上游任何代码观察到全局时，全部库标签都
已经跑完；库缺席的唯一信号是卡自己运行时的 `ReferenceError: Vue is not defined`，而它必然
发生在库标签之后。TavernHelper 同理（它把库注入消息 iframe，卡的代码在注入之后才跑）。
换句话说：**上游没有「早读」这种模式可言**，Iris 这句话是文档化的增量，本节修的是这个增量
自己引入的时刻错位，不是向上游看齐或偏离。

**测试。** `apps/iris-web/tests/library-state.test.ts`（+7，全部是「什么时候读」而不是
「说什么」）。`frame-libraries.test.ts` 钉的 `provideToastr` → `reportMissingGlobals` 顺序
走的是 `run` 路径，不受影响，仍绿。

**实地对照（8790 宿主，`apps/iris/data` 的副本，爱衣，只开新对话不发回合，不花 token）。**
同一张卡、同一个开场白楼层、同一套读法（`#iris-card-scripts` 里的 `.iris-script__report`
行），只换 `dist/sandbox` 的 bootstrap 构建：

| 构建 | bootstrap 资产 | 面板行数 | 含「never executed」的行 | slot / iframe |
| --- | --- | --- | --- | --- |
| 改前（`origin/main` 源码重建） | `bootstrap-49aeaca23a0e188a.js` | 31 | **1** | 1 / 1 |
| 改后 | `bootstrap-8541ed23c753134e.js` | 29 | **0** | 1 / 1 |

改前那一行逐字是：

```
the library preset never executed (the preset script) — it did not run far enough to record a
reason, so the request itself is what to check: blocked, missing, or unparseable. Every library
below is a consequence of that one failure, not a separate gap: $, jQuery, _, z, YAML, showdown,
Vue, VueRouter
```

`(the preset script)` 这个兜底 URL 就是上面第 4 步「标签还没解析出来」的现场物证。
（复跑记录把末名抄成了 `VueRoute`，实读是 `VueRouter`——八个名字正好是 `EXPECTED_GLOBALS`
去掉 `toastr` 与 `EjsTemplate` 之后那批，那两个是 Iris 在 preset 之前就种进去的。）
frame 数两次都是 1，所以少掉的只有这条误报，不是这一层整个塌了。

### 牙齿

| 断言 | 让它变红的改动 | 结果 |
| --- | --- | --- |
| (a) bootstrap 那一刻不出报告，preset 跑完后也不出 | M1：`if (probe.presetRan() \|\| !probe.parsing() \|\| true)`，恢复即时读 | 红 3 条（(a)(b)(c) 全红）→ 绿 |
| (b) 等待是**有界**的 | M2：删掉 `probe.after(PRESET_SETTLE_TIMEOUT_MS, settled)` | 红（`the wait is not bounded`）→ 绿 |
| (b) 上界与结算点只发一次 | M3：去掉 `spoken` 守卫 | 红（`the settle point repeated a report the bound had already made`）→ 绿 |
| (a)(c) 结算点**重读**而不是重放 | M4：把 `presetRan()`/`missing()` 在调用时快照成常量 | 红 2 条（含 `the preset ran and every library is present…`）→ 绿 |
| 已有定论的读数不该等 | M5：`if (false)`，恒走推迟支 | 红 2 条（`a settled marker was made to wait for the parser`、`nothing was waited for…`）→ 绿 |
| (c) gap 句走 `note` 频道 | M6a：`probe.report(message, 'error')` | 红（`a library Iris does not carry is not a failed load`）→ 绿 |
| 记录到抛错的走 `error` 频道 | M6b：`probe.report(message, 'note')` | 红 → 绿 |
| entry 只经包装到达这句话 | M7：在 `frame-entry.ts` 里恢复直接 `describeLibraryState(...)` 组装并 `post` | 红（`frame-entry.ts composes the library sentence itself again…`）→ 绿 |

八次变异各自至少红一条，且都是**改代码**而不是改夹具。M7 是其中判别力最特别的一条：
缺陷不在句子里，所以任何只钉句子的断言都会对「把它搬回 entry 里即时组装」保持绿——
那条源码断言是唯一能红的腿。

### What would reopen this

(a) preset 标签改成 `defer`/`async`/`type="module"`：那时 `DOMContentLoaded` 不再是它的
结算点，要改的是 `onParsed` 那一行（`load`，或标签自身的 `load`/`error`），本节其余不变。
(b) 真出现「请求既不完成也不失败」的网络形状：15 s 那条腿会在解析仍在进行时说出「没跑」，
这是上面写明的唯一残余窗口，届时应当把上界换成对标签 `error` 事件的等待而不是加长它。
(c) 某天 bootstrap 不再必须排在 preset 之前（`srcdoc.ts:672` 的理由失效）：那时
`frame.ts:3103` 可以直接挪到 preset 之后，这一层包装就成了多余的间接，应当连同本节一起退。
(d) 出现第三个调用点：本节只验过 `:3103`（界面帧，bootstrap 内）与 `:2950`（脚本帧，`run`
路径）两个；新调用点必须自己说清它在文档顺序的哪一侧。


## 112. 帧里的第三类代码：沙箱插件的 mini 树（挂载、门面、六格拆卸清单）

### 背景

[SANDBOX-PLUGINS](../../../docs/SANDBOX-PLUGINS.md) 是 owner 2026-09-18 立项的第二阶段设计：
玩家说一句话，模型写一个**沙箱插件**，热挂进**这张卡自己的沙箱帧**，按对话持久。本节记的是
**PR-A**——§15 切出来的第一刀，**帧里的树，没有模型**：插件源来自一个 dev 面板里手打的代码，
没有 sidecar、没有确认卡、没有任何一次生成请求。这样切是因为整个功能的技术风险全在
「挂得上、拆得干净」这一格，而一个没有模型的版本可以一行一行地验，失败的时候没有人在花钱。

帧里在此之前已经跑两类代码：**卡自己的脚本**（经 `run` 消息，随帧生，随帧死）与
**系统插件的成员包**（srcdoc 里的一个标签，解析期跑，`registerPluginMembers` 没有撤销口）。
沙箱插件是第三类，也是**唯一一类可以在帧活着的时候来、也可以走**的。

### 决定

**一、树是第二套注册面，不改成员表。** `registerPluginMembers`（`members-entry.ts:90`）没有
撤销口、重复登记直接抛、`collectPluginMembers` 一帧只跑一次（模块头原话是「a verdict, not a
poll」）。热挂载要的是替换与撤销，两样它都没有。所以 `plugin-tree.ts` 与成员表并列，互不触碰。

**二、`new Function` 而不是 `blob:` 模块。** 卡脚本走 blob 模块，因为上游把每个卡脚本当
`<script type="module">`，Iris 有兼容义务；插件没有这个义务，而 `new Function` 是**同步**的——
它让「求值抛错」与「`apply` 抛错/超时」成为两个可分的状态（`mount-failed` / `mount-timeout`），
修法不同的两件事因此不共用一个名字。CSP 一个字节不动：帧的 `script-src` 早就带着
`'unsafe-eval'`。

**三、包装器是一个共享常量，两侧都只调它。** `sandboxPluginBody(code)` 与
`SANDBOX_PLUGIN_FACADE_PARAM` 住在 `@iris/protocol`，宿主的语法预检（Node）与帧里的挂载
（浏览器）各自把它的输出**原样**交给自己的编译器。抄 dsh 的教训：预检与执行用两套包装，
预检过了执行仍可能语法错，那这道检查只是让人安心。测试比的是**两侧实际交出去的字节**，
不是同一个函数调两遍。

**四、门面只有三件能力，并且不假装它是墙。** `{ id, styles, panel, card }`，`card` 就是
`MEMBER_KINDS` 那 124 个成员**按 pluginId 绑定**的一份——不是新面，是卡脚本今天拿到的那一份。
按插件绑定不是整洁，是拆卸清单第 5 格的前提：一个共享的成员面拆不掉它注册过的东西，因为没人
知道哪一条是谁注册的。插件用 `Function('return this')()` 就能绕过门面拿到帧的全局；拿到的是
卡脚本已有的那一套，被不透明源 iframe 关着。墙是 iframe。

**五、拆卸是一张有六格的清单，而不是一次调用。** `dispose` → 面板格 → 本帧样式 →
已发布样式 → 成员面痕迹 → 树上的行。**每一格都跑，前一格失败不拦后一格**：一个抛错的
`dispose` 不该把样式标签留在 head 里。任一格没拆掉记 `dispose-failed`，**不假装拆成功了**。
第 4 格在 PR-A 只做帧这半（壳那半的扇出是 PR-C）。

**六、挂载顺序按 pluginId 字典序，每次现算。** 不按创建序（要存一个会留洞的计数器），不给
插件 `priority`（插件是模型写的，把自己设成最高没有代价）。顺序对两件事可见：样式谁赢、
面板格怎么排。壳排序后逐条发，帧里**一条全局串行链**按到达序处理——这一点与设计的「每个
pluginId 一条队列」不同，见下面「与设计稿的出入」。

**七、`code` 走 postMessage，不进 srcdoc。** srcdoc 是壳拼出来的一整页 HTML，把模型写的代码
拼进那个字符串，等于让模型的输出参与拼 markup——一条今天不存在的注入面。附带的好处是
**一张没有插件的卡，srcdoc 逐字节与改前相同**，这一条由测试钉住。

### 与上游的对照

**SillyTavern 没有任何对应物。** 上游的卡就是卡：PNG 里的脚本与界面，装进去是什么样、跑起来
就是什么样，没有任何机制能在一段对话里给一张卡长出一个它作者没写过的功能。所以这一节**不是
兼容缺口，是有意的改进**，按 SYSTEM-PLUGINS 那条「兼容是地板」的规矩，代价要写平：

- **模型写的代码在卡的沙箱里跑。** 它能做的事等于卡今天能做的事（124 个成员），而 `purpose`
  是代码作者自述的用途——一段代码可以说自己在做 A 而实际在做 B，宿主分不出来。抵御它的不是
  门面，是沙箱把后果关在这张卡这段对话里，加上随时可删。
- **拆卸清单有六格，漏一格就会留东西。** 这不是假设：本节的牙齿表里跳过第 5 格就是红的，
  而在有断言之前，跳过它的代码与不跳过的代码在任何外部读数上长得一模一样。
- **同步死循环卡死帧，3 s 的预算救不了。** deadline 是一场 promise race，race 拦不住同步代码，
  浏览器也不会抢占它。预算买到的是**壳不再等**并记下 `mount-timeout`；帧要等循环自己结束。
  这是 PR-A 验收第 4 条量到的事实，记下来而不是绕过去。真正的 `while(true)` 连一行报告都不会有：
  `mountOne` 永远走不出 `plugin.apply()`，帧从此不再回答任何消息——这一条只能记，不能修。
  **一个有界的同步 apply 是可以判的，而且是验收跑出来的**：第一版对着「spin 6 s 然后返回」报了
  `mounted`，因为 deadline 还没来得及挂上 apply 就已经结束了——一个把帧冻了两倍预算的插件被归档
  成健康的。现在同步段结束后回头量一次实耗，超了就记 `mount-timeout` 并写明「预算是被超过的，
  不是被执行的」。
- **生产包里留着一个空的 dev store。** `plugin-bench.ts` 被 `useCardScripts` 无条件读，所以它
  进产物：两个空 Map 加一个空订阅表，几百字节。换来的是生产路径与被测路径是**同一条**，而不是
  一条 `import.meta.env.DEV &&` 分出来的第二条。

### 与设计稿的出入（三处，都往窄里走）

1. **队列是一条全局链，不是每个 pluginId 一条。** 设计 §5.3 第 0 步写「同一个 pluginId 的
   操作在一条串行队列上」。按字面做，十六个插件同时开跑：§9 的顺序不再决定任何事（「后挂的
   CSS 赢」这条要写进作者文档的规则会直接变成假话），§6.3 的「整批 10 s」也没有一个序列可以
   度量。一条全局链**蕴含**每插件的那条保证，所以这是收紧不是放宽。
2. **设计稿 §5.3 的伪码把两个状态写成 `apply-failed` / `apply-timeout`，§6 的词表写的是
   `mount-failed` / `mount-timeout`。** 按 §6 实现（词表是闭合联合，伪码不是），伪码那两个名字
   在仓库里不存在。
3. **`script.report` 加了两个可选字段而不是新开 RPC。** §8 要求失败行经**既有的**
   `script.report` 进缓冲，但那个 arm 的 schema 把 kind 钉死成 `card-console`、grade 钉死成
   `note`（注释里写明「a grade the caller could choose would let a card dress itself as a host
   fault」）。所以加了 `kind?: 'card-console' | 'sandbox-plugin'` 与 `grade?`，并且**console 那
   半的裁决一个字不动**：kind 不是 sandbox-plugin 时，grade 一律 `note`，请求里写什么都不算。

### 测试与牙齿

十三次变异，每次**改代码**（不是改夹具），各自至少红一条，恢复后全绿。

| 断言（在哪） | 让它变红的改动 | 结果 |
| --- | --- | --- |
| 预检与挂载编译的字节逐字相同（`plugin-tree.test.ts`） | 在 `precheckSandboxPluginSyntax` 里自己拼模板，`"use strict"; 
` 多一个空格 | 红 1 → 绿 |
| 拆卸清单**比较过的格数 = 6**（同上） | 在 `plugin-tree.ts` 里删掉第 5 格 `member-traces` | 红 2 → 绿 |
| 求值/apply 抛错是 `mount-failed`（同上） | 让 factory 抛错那条路报 `mount-timeout` | 红 1 → 绿 |
| apply 不落定是 `mount-timeout`（同上） | 让超时那条路报 `mount-failed` | 红 1 → 绿 |
| **同步** apply 烧超预算也是 `mount-timeout`（同上） | 把 `spentSync >= applyMs` 这一支关掉 | 红 1 → 绿 |
| 壳→帧三条新分支各自被接受（`sandbox-policy.test.ts`） | 把 `case 'plugin:mount'` 改名 | 红 2 → 绿 |
| `plugin:failed` 的 state 走闭合词表（同上） | 换成 `typeof state !== 'string'` | 红 1 → 绿 |
| 未知的 `plugin:*` 分支仍被拒（同上） | 让 `default` 放行所有 `plugin:` 开头的消息 | 红 1 → 绿 |
| 没脚本但有插件 → 建帧；都没有 → 不建（`card-scripts.test.ts`） | 条件退回 `loaded.length === 0` | 红 1 → 绿 |
| 插件按 id 序发出（同上） | 去掉发送前的 sort | 红 1 → 绿 |
| 没有插件的卡 srcdoc 逐字节不变（`plugin-compat.test.ts`） | 让 `runCard` 在 host 带插件回调时给 srcdoc 加一个标记 | 红 1 → 绿 |
| 装树不碰 DOM，直到有插件要东西（同上） | 在 `installSandboxPluginTree` 里立刻建面板容器 | 红 1 → 绿 |
| 插件样式标签不与 message-preset 共用 `data-iris-style`（`plugin-surface.test.ts`） | 把 `PLUGIN_STYLE_ATTRIBUTE` 改成 `data-iris-style` | 红 1 → 绿 |

判别力最特别的是第一条与倒数第三条。第一条：两侧**各自**走到自己的编译器，测试读回两次
实际交出去的 `(param, body)` 再比——如果两边都调同一个 helper 然后互比，任何一侧改自己的拼法
都不会红，这道检查就只剩安慰作用。倒数第三条：它比的是**整页字符串**（把每次运行必然不同的
run token 挖掉，并断言真的挖到了），而不是「搜一个我想得到的标记在不在」——后者只能回答我
想到的那一种破坏。

### What would reopen this

(a) 插件之间开始有依赖、或者引进 dsh 那种 chain 插槽：那时「字典序 + list 语义」这两条
就不够了，顺序要变成一个真正的拓扑问题，§9 与第 5.5 节一起重写。
(b) `registerPluginMembers` 长出撤销口：那时「两套注册面」的理由消失，应当认真评估把树折回
成员表，而不是让两套并存下去。
(c) 帧不再是 `about:srcdoc`（例如换成同源 blob 文档）：「代码只能走消息」这条理由的第三点
失效，前两点仍在，但值得重读。
(d) PR-C 落地之后：本节第 5 格的「只做帧这半」要改成两半都做，并把 B 族帧重建的可见代价
（闪一下）写进代价清单。
(e) 出现第二个 `plugin:style` 的消费者（今天只有一个读者，PR-C 是第二个）：32 KiB 这个上限
是判断不是测量，届时应当量一次真实插件的 CSS 体量再定。


## 113. 一句话变成这张卡的一个功能：确认卡、创造模式、「这个对话长了什么」

### 背景

[SANDBOX-PLUGINS](../../../docs/SANDBOX-PLUGINS.md) §15 的第二刀。PR-A（§112）把树建进了帧里，
插件源来自 dev 面板里手打的代码；本节记的是**壳层这一半**：玩家把输入框切到「创造」说一句话，
模型写出来的东西经一张**壳层渲染的确认卡**被点头，然后挂进同一棵树，并按对话持久。宿主那一半
（sidecar、三个 RPC、专用连接档、两条解析路）在
[iris-app-service DEVIATIONS](../../packages/iris-app-service/DEVIATIONS.md) §97。

这一半的全部难处是**一个问题要问对地方、问一次、不过期**，而这件事这个仓库已经付过一次学费：
`ConsentAsk` 的第一版只活在设置抽屉里，而抽屉默认关闭并在关闭时 `aria-hidden`——于是「问过了」
与「没人看得见」长得一模一样。所以这一节的每一条都在抄它。

### 决定

**一、确认卡是 `ConsentAsk` 的第二个实例，五条规则一字不改。** 壳层渲染（画确认卡的代码不能
是要被确认的那段代码——它可以画一个假的 `purpose`、假的字节数，或者干脆画一个已经被点过的勾）、
非模态、无计时器、卡够不着、措辞按后果不按 API。第六行的 `declares` 标题写的是「它说它会注册」
而不是「它会注册」，因为宿主不按它放行任何东西（§7），显示它只是为了让玩家能对上「它说的」和
「它做的」——例如「只改一点颜色」旁边跟着四十千字节。

**二、「创造」是输入框的一个模式，不是第二个输入框，而模式只有两个可见处。** 占位符和发送键的
名字。理由写在 `Composer.tsx` 的 `submit` 里：**一个隐藏的模式是这个交互唯一会静默出错的地方**
——玩家会打一句台词，然后花掉一次写插件的请求。开关放在「+」菜单里而不是 bar 上，因为 bar 的
规矩是「每个控件陈述一个事实并改变它」，而「创造」是一个动作；`iris.composer.actions` 槽刻意
不用，那是给扩展的挂点，这是 shell 自己的功能（§12）。

**三、没设置写插件用的模型时，入口是灰的并且说出原因，不是不出现。** 一个干脆不在那里的入口
教不会任何人「有一个设置要做」。note 里指向连接卡。

**四、列表面板走 `iris.sidebar.panels` 槽，由 shell 自己注册。** §12 裁的就是这个位置。注册写在
`ui-plugin.tsx` 而不是某个组件的 effect 里，因为 `SlotCore` 在注册者消失时会收走这个 key 的全部
条目，而一个活在 effect 里的注册会随重渲染来回。**这是这个槽的第一个使用者**——它在 main 上一直
是声明了、渲染了、没有人往里放东西。

**五、失败的行不只是灰掉。** 它说出是七个状态里的哪一个，并说下一步能做什么：`mount-failed` →
「再说一句话让它重写」，`dispose-failed` → 「切走再切回这个聊天」。空的时候说一句话而不是空白——
空状态是这个功能唯一的入口说明。

**六、`declined` 时插件也不挂，而且面板要说出来。** 落点是 `useCardScripts.tsx` 里那一行
`scriptsAllowed !== 'allowed'` 的提前返回，插件与脚本共用它、没有第二个判断（Q17 裁决，
[AUTORUN](../../../docs/AUTORUN.md) §1 已同步）。面板那句「这段对话长出来的 N 个功能也不会运行」
是必须的：没有它，玩家看到的是几行写着「挂着」的记录和一个空空的帧。

**七、帧的重建只发生在 0↔1 那一格。** 挂载要一个帧，而 sidecar 是在 effect 第一次跑完之后才到的，
所以「有没有插件」是一条重建依赖——但只是**布尔**，不是那张表。一次重建会让卡脚本丢掉全部内存状态，
所以它只允许发生在「还没有东西在跑」（开聊天）或者「没有东西还要跑」（一张没脚本的卡删掉了最后一个
插件）这两处。别的变化——旁边多一个插件、换一个版本、关掉一个——都经 effect 内部对 store 的订阅
到达活着的帧，一次重建都不做。

**八、`mountPlugin` 现在回答有没有帧收下它。** PR-A 的注释把「没有帧就是空转」写成了诚实的答案，
那是**行为上的**诚实；诊断上不是：事后看，一个送到了的挂载和一个掉在地上的挂载给读者的屏幕一模一样，
而其中一个是 `orphaned`（§6.4 成因①）。所以它返回 `cards.length > 0`，壳据此记一条报告。

### 与上游的对照

**SillyTavern 没有任何对应物。** 上游没有「让这段对话长出一个功能」这件事，所以也没有要为它问的
问题、没有要为它列的面板、没有写插件用的那一行设置。这一节整节是**有意的改进**，代价要写平：

- **确认卡是一个新的、会反复出现的问题。** 每一个新插件、每一个新版本各一次（双勾之后不再问）。
  这是一个真实的打扰成本，换来的是「模型写的代码在被点头之前一行都不会跑」。玩家能用双勾把它关掉,
  而双勾的代价（**它信任的是一个位置，不是这一段字节**）写在按钮下面那一行，不是藏在文档里。
- **连接卡的面板里现在有字段了，而它自己的规矩说不该有。** 那条规矩（owner 2026-09-09：
  「连接折叠卡中就不需要有提供方/端点地址/模型这三个选项常驻了」）管的是**一个供应商自己的值**，
  而这一行是在已经存在的行里挑一个、外加一个模型名。两个替代方案都更差：为两个值开一个模态，
  或者给每一行加第三个动词。`render-check` 的那条断言**被重述而不是删掉**——现在是「authoring 块
  之外没有字段」，并且额外断言 authoring 块里**确实有**两个控件，否则这个豁免就会变成一个空洞。
- **生产包里多了两个组件和一份中英文案。** 面板与确认卡在没有插件的对话里各渲染一句话或 null。
- **「创造」模式活在组件状态里，不在 store 里。** 切换对话会把玩家放回普通输入框。这是刻意的：
  一个活过了它被设置的那块屏幕的模式，就是那个会把一句台词变成一次写插件请求的形状。

### 与设计稿的出入（两处）

1. **`sandboxPlugin.list` 的回包多一个 `mounts` 数组。** §10.2 明写 `SandboxPluginView` 不带 `code`，
   而 §4.1 第 12 步要求**壳**把 `plugin:mount` 发进帧——壳因此必须拿到 code。两句话只有一种同时成立的
   读法：视图不带，另开一个更窄的数组带，且它只装**已启用且已授权**的那些。一个等着被确认的插件、
   一个被关掉的插件，交给浏览器的是零字节。
2. **没有 `sandboxPlugin.pending` / `changed` 两个广播。** §4.1 的第 9、11 步各写了一次广播；这里
   `define` 与 `decide` 是等待的 RPC，答案直接回给发起的那张页面。多开两个事件只会让「另一张页面」
   这个今天不存在的读者提前存在，而 `IrisEvent` 的联合是闭合的、每加一个成员每个消费者都要跟着改。
   代价如实写：**第二张打开同一个对话的页面要到下一次 `list` 才知道**。

**九、失败的句子用宿主自己的原话，不是那个 code 的通用文案。** 这一条是**验收量出来的**：
第 6 条本来给读者看的是「Iris 不会发送这个请求」——`describeError` 对 `invalid-request` 的通用句。
那个偏好在 detail 是一个标识符（「no chat "chat-7"」）时是对的，在这里正好相反：detail
（「the model's code does not compile — SyntaxError: Unexpected token ')'」）**就是读者唯一能据以
行动的全部内容**，而设计要的正是一句能行动的话加一个重试入口（§6.1）。所以这条路上取错误自带的
detail，通用句只在 detail 为空时兜底。

### 测试与牙齿

五次变异，每次**改代码**（不是改夹具），各自至少红一条，恢复后全绿。

| 断言（在哪） | 让它变红的改动 | 结果 |
| --- | --- | --- |
| 作者文档里的门面签名与 `plugin-tree.ts` 逐行相同（`sandbox-plugin-doc.test.ts`） | 把文档里 `insert: (css: string)` 的参数名改成 `sheet` | 红 1 → 绿 |
| 挂进一个没有帧的 set 会说出来（`card-scripts.test.ts`） | 让 `mountPlugin` 一律 `return true` | 红 1 → 绿 |
| 拒绝时留下的句子是宿主的原话（`sandbox-plugin-store.test.ts`） | 把那一行换回 `describeError(error, getLanguage())` | 红 1 → 绿 |
| 发送控件在两个模式下都有名字（`composer-bar.test.ts`） | —— 这条是**重述**：原断言钉的是字面量 `aria-label={t('send')}`，模式化之后它对新的那一半完全无感 | 见下 |
| 连接面板里除 authoring 块之外没有字段（`render-check`） | —— 同样是重述，并补了「authoring 块里确实有两个控件」这条，否则豁免会变成空洞 | 见下 |

后两条是**重述而不是放宽**，写在这里因为区别很容易被读反：一条钉字面量的断言在被钉的那行长出
第二种形态时，不是变松了，是**变成了对另一个东西的断言**——它仍然为旧形态发红，同时对新形态一无所知。
重述之后，发送键那条对「两个模式各有一个名字」发红，连接面板那条对「字段跑到 authoring 块外面去」
与「authoring 块被掏空」两个方向都发红。

判别力最特别的是第二条：它比的不是「有没有调用」，而是**帧在不在**，并且两个方向各有一条
（有帧 → true、无帧 → false）。只钉无帧那一侧的话，一个恒返回 `false` 的实现也会绿，而那会让每一次
正常挂载都记一条 `orphaned`。

### 验收仪器自己错了两次，两次都记在这里

`qa/sandbox-plugins-pr-b.mjs` 跑到第四趟才全绿，而前几趟的红都不在产品里：

1. **切模式那一下是无条件点击。** 第 4 条之后页面没有导航，模式还开着，于是第 6 条那一下把它
   **关掉**了，那句话当成台词进了对话——没有拒绝、没有报告，而那一格读起来像「模型很听话」。
   这恰好是上面决定二说的那件事的实证：**隐藏的模式是这个交互唯一会静默出错的地方**，
   而它先在仪器身上出了错。现在 `enterCreateMode` 先读后点，`spend` 在发之前拿模式和
   「普通模式长什么样」比，不对就硬失败而不是发出去。
2. **第 7 条那个形状根本不可能成立，改了一次还是分辨不出。** chatId 是 `toId(标题)-<到秒的时间戳>`，
   所以四分钟前铸出来的 id 不可能被回收——第一版对着它试了十三次。改成「同一秒内删掉再建」之后
   又错一次：重建用的是**同一个父对话的分支**，而分支本来就该合法地拿到一份拷贝，读数分辨不出
   继承与复制。最终形状是两个父——一个**有插件**的分支当载体（它的 id 被回收），一个**空对话**的
   分支来接这个 id；两个分支标题同源，所以同一秒里铸出同一个 id，而后者本来就不该有任何插件。

两条是同一类错误：**读数正确、问的问题不对**。写在这里，是因为下一个重跑这个脚本的人会先看见这两段，
而不是重新踩一遍。

### What would reopen this

(a) 出现第二张同时打开同一个对话的页面（多窗口、或者协同）：那时「没有广播」这条出入要重做，
并且 `IrisEvent` 该长出一个 `sandboxPlugins.changed`。
(b) 确认卡开始排队——一次「创造」产出两个插件，或者两次「创造」的答案先后到达：今天 `pending` 是
一个，多于一个就会变成一个模态栈，届时要先回答「第二张卡出现时第一张怎么办」。
(c) PR-C 落地：样式扇出到消息界面帧之后，面板里那一行「挂着」才真正描述了玩家看得见的全部，
今天它只描述卡脚本帧这一半。
(d) 连接面板的 authoring 行长出第三个控件：那时它就不再是「在已有的行里挑一个」，
应当认真考虑把它做成自己的编辑器，把面板体内无字段那条规矩还回去。

## 114. 插件的样式越过帧边界：`plugin:style` 到壳、按 `(chatId, pluginId)` 存、折进消息界面帧的 srcdoc

### 背景

[SANDBOX-PLUGINS](../../../docs/SANDBOX-PLUGINS.md) 的 **PR-C**（§15）。§112 造了帧里的树，
§113 造了 sidecar、确认卡与模型请求，两者合起来能让一个插件在**卡脚本帧**（A 族）里跑起来；
但玩家那句话通常是「把状态栏改成深色」，而状态栏画在**消息界面帧**（B 族）里。
PR-B 的验收第 4 条把这件事记成了已知边界并指向本节：那时「卡脚本帧里的东西变了、消息里的状态栏
没变」是**预期**，不是通过。

插件代码只在一个 realm 里跑（§5.1 裁决 Q4，选 A 族）。所以越界的不是代码，是**一段文本**：
帧说 `plugin:style`，壳存住，下一次建 B 族帧时把它折进 srcdoc。

### 决定

**一、移除面另开一条消息 `plugin:style-clear`，因为壳推不出来。**
设计 §5.2 的消息表只有六条，没有移除的那一条；但 `iris.styles.clear()` 之后插件**还挂着**，
不会有 `plugin:unmount` 跟上，壳从外面看不见任何事情发生。拆卸清单第 4 格也走同一条消息，
所以帧里两条丢弃样式的路在壳里也都丢弃。方向只有帧→壳一条，所以只加一个联合、一个 `switch`。
**按插件，不是「全部忘掉」**：一个「忘掉这个对话的全部样式」的消息会让 B 的拆卸顺手带走 A 的样式，
而那从读者那边看就是**删错了插件**。

**二、存在壳里，不进 sidecar。** 样式是**跑起来的代码派生出来的**，不是作者写下的数据：
每次挂载重新派生，刷新即消失，这是它该有的寿命而不是缺口。落地是 `plugin-style-fanout.ts`：
`Map<chatId, Map<pluginId, string[]>>` 加一个**每对话的修订计数**。计数而不是文本摘要——
`useSyncExternalStore` 按 identity 比快照，而两张等长的样式表正是廉价摘要会撞的地方，
撞了的症状是一个消息帧安静地留着一张本该丢掉的样式表。

**三、上限是**每个插件**的合计 32 KiB，超了具名拒绝、绝不截断。**
线上那道 32 KiB（`parseFromFrame`）管的是**一次** `styles.insert`，而 `insert` 可以调任意多次——
只看一次调用的上限等于没有上限。所以壳这道按插件合计算，单位与线上同为 UTF-16 码元，
两个天花板因此不会对「32 KiB 是多少」产生分歧。超了那一张**整张不收**：截一半得到的是一张
会画出没人写过的东西的样式表，而幸存那半里的语法错会把读者指向 CSS 而不是指向一个上限。
句子带两个数（实测与上限），落 `debug.reports` 的 `sandbox-plugin`（§6.2 的口径）。

**四、折进 srcdoc 走 `withMessageCss` 已经在走的那条路，每张表一个自己的元素。**
一个 `<style data-iris-message-css data-iris-plugin-style="<id>">`，`liftMessageCss` 把开头**连着一串**
这样的元素抬进 head（它以前只抬一个）。标签名与帧内 sink 用的是**同一个字面量**
（`SANDBOX_PLUGIN_STYLE_ATTRIBUTE` 移进 `@iris/protocol`），所以「这张文档上有几张这个插件的表」
在两族帧里问的是同一个问题——§16.3 那个「壳自己的页面上是 0」的牙齿才对着扇出真正写的那个标签。

**五、文本永远是文本。** 折进去之前走 `escapeSheetClosers`：`</style` 与 `</script` 各自变成
`<\/…`。`</style` 是真洞；`</script` 在 `<style>` 里什么都结束不了，切它是**纵深防御**——
让它无害的唯一理由是「这段字符串只会被放进 `<style>`」，而那是关于未来每一个调用点的断言，
不是关于这段字符串的。`withMessageCss` 那一行**没动**：把它一起放宽会改掉每张存量卡的消息样式表
的字节，而那不是这套推理针对的那群文本。

**六、加一张表、删一张表都靠**重建**，不另开一条活注入通道。**
CSS 住在 srcdoc 里，所以除了重建没有别的办法；设计接受这个可见代价（闪一下）。
依赖是那个修订计数（`pluginCssGate`），与 `gate` 同形同理由：直接依赖数组会让视野里每一帧
在任何对话的任何一次发布时全部重建。

**七、字节计进帧预算，这是对「消息自带样式表不计」那条先例的有意背离。**
`runMessageInterfaces` 明确不给消息自己的 CSS 记账，理由是「几 KB 壳拼的文本记到卡头上」。
这条推理在这里不成立，两点都可核：①**量不被楼层约束**——消息的表是一条正在被计费的消息的一部分，
插件的表不是；16 个插件各 32 KiB 是每帧半兆，20 帧就是十兆真实内联文本，一个不看它的预算会把
这十兆读成零。②预算要守的就是「真正被内联进去的字节」。代价照写：一个长出大样式表的对话，
可能把一个本来能渲染的楼层挤成占位符——那是既有的预算行为、读者按占位符上的按钮可以逆转，
而且添字节的那个插件自己有一行报告。

### 与上游的对照

**SillyTavern 没有对应物，而且这里连「等价物」都谈不上**：上游一层楼是**一个 DOM**，
消息自带的 `<style>` 天然覆盖整层楼，根本不存在「把样式送到另一个帧里去」这个问题。
Iris 一个前端块一个不透明源帧，所以这条路是为一个上游没有的结构付的税。
按 SYSTEM-PLUGINS「兼容是地板」的规矩，代价写平：

- **一张没有沙箱插件的卡，消息帧的 srcdoc 逐字节与改前相同。** `withPluginCss` 在空表上返回
  原串，`liftMessageCss` 在没有标记元素时原样返回。由测试钉住，而且比的是**整页字符串**。
- **加/删一张表 = 消息帧重建，读者看得见地闪一下。** 旧帧会被 park 在屏幕上直到替身起来
  （`useMessageInterfaces` 的既有机制），所以它是一次交接而不是一段空白，但它不是零成本。
- **插件的表落在 head，卡自己的 `<style>` 在 markup 里、在文档里更靠后，而且多半是 class 规则。**
  所以一条朴素的插件规则**会正常参与层叠**，可能因为顺序、也可能因为具体度而输。
  实测（爱衣，2026-09-19）：`body{background:…}` 赢（卡没有与之竞争的 body 规则），
  `body > *{background:…}`（0-0-1）输给卡的 `.card`（0-1-0）；同一条加 `!important` 全部生效。
  **诚实的句子是「表到了，然后正常竞争」，不是「插件赢不了」。** 这一条要写进作者文档。
- **扇出覆盖每一个 B 族帧，围栏块也在内**——与消息自带样式表**刻意不同**的一群。
  这是第一次验收跑出来的缺陷，见下。

### 与设计稿的出入（三处）

1. **`plugin:style` 在 PR-A 就已经落了两处（联合 + `switch`）。** 任务书按设计 §5.2 把它算进
   PR-C 的工作量；仓库里它已经在，`onPluginStyle` 这个钩子也已经在 `runner.ts` 上，
   只是 `useCardScripts` 没有实现它。PR-C 实做的是**实现那个钩子**加上**新增移除面**。
2. **设计 §15 PR-C 的验收写「读帧预算面板的读数」。仓库里没有这个面板**：`FramePlan.spent`
   在整个 UI 里没有读者（`FrameBudget.tsx` 只把 `refused` 分给每一行）。验收改读预算要守的那个
   物理量——消息帧 srcdoc 实际内联的字符数，从壳上读——并把「面板不存在」印在读数旁边；
   「plan 确实收了这笔账」由单元测试钉住。本节不新造一个面板：那是一件独立的可观测性工作。
3. **上限的**名义**与落点**。任务书说「每张表 32 KiB 的上限 + 具名拒绝」；线上那道上限在
   `parseFromFrame` 里是**静默丢弃**（返回 `undefined`），一个纯函数没有地方记报告。
   所以具名拒绝落在壳的存储处，并按插件合计（见决定三）。线上那道一字未动。

### 一次验收跑出来的缺陷（写下来，因为它两侧都「看着对」）

第一次跑，五个框全红，读数是**每一格都 0**：消息帧 0 张表、srcdoc 字节一字不变。
原因不是扇出没接通，而是**折的对象选错了一群**——第一版照着消息自带样式表的先例，只折进
`bare-html` 区块。爱衣的状态栏是一个**围栏块**，于是扇出一帧都没碰到。

两件事让它没被单元测试拦住：夹具里那一句断言原文写的是「只有 bare 的那些」，
**它把错误的选择断言成了规格**；而设计 §5.1 的原话是「每一个 B 族帧」，
先例（消息表只进 bare 区）与规格（插件表进全部）在这里**刻意不同**，第一版把先例当成了规格。
现在两群各有一条断言，并且夹具先断言它同时有两种区块——否则那两条都是空集上的全称量词。

同一次跑还加了一条**归因读数**：卡脚本帧自己的标签数。没有它，「插件根本没挂上」与
「插件挂上了、扇出没到」在消息帧那边是同一个 0。

### 测试与牙齿

十四次变异，每次**改代码**（不是改夹具），各自至少红一条，恢复后全绿。

| 断言（在哪） | 让它变红的改动 | 结果 |
| --- | --- | --- |
| `plugin:style-clear` 被接受（`sandbox-policy.test.ts`） | 把 `case 'plugin:style-clear'` 改名 | 红 1 → 绿 |
| 32 KiB 整数正好收下（`plugin-style-fanout.test.ts`） | 把 `>` 改成 `>=` | 红 1 → 绿 |
| 超上限那张**整张不收**（同上） | 让超限分支存一份截断的副本 | 红 1 → 绿 |
| B 卸载不带走 A 的表（同上） | 让 `retractPluginStyles` 删掉整个 chat 的表 | 红 1 → 绿 |
| CSS 里的 `</style` 被切开（同上） | 从 `escapeSheetClosers` 的正则里去掉 `style` | 红 1 → 绿 |
| head 里抬的是**一串**而不是一个（同上） | 在抬升循环里加 `break` | 红 1 → 绿 |
| 没有插件时 srcdoc 逐字节不变（同上） | 让空表也写一个空的标记元素 | 红 1 → 绿 |
| 扇出模块碰不到 document（同上） | 在 `publishPluginStyle` 里 append 一个 `<style>` | 红 1 → 绿 |
| 预算把折进去的字节算进重量（同上） | 从 `frameWeight` 去掉 `pluginCssBytes` | 红 1 → 绿 |
| 插件表真的进了消息帧的 markup（同上） | 在 `message-frames.ts` 去掉 `withPluginCss` | 红 1 → 绿 |
| **层叠顺序**：消息表在前、插件表在后（同上） | 把两个 helper 的嵌套顺序对调 | 红 1 → 绿 |
| 帧里 `styles.clear()` 通知壳（`plugin-tree.test.ts`） | 去掉门面 `clear` 里的 `env.retractStyles` | 红 1 → 绿 |
| 拆卸第 4 格通知壳（同上） | 去掉第 4 格里的 `env.retractStyles` | 红 1 → 绿 |
| hook 把插件表交给 controller（`message-frames.test.ts`） | 把 `input.pluginSheets` 换成 `[]` | 红 1 → 绿 |

判别力最特别的是第十一条与倒数第一条，而且它们是同一件事的两半。
**第十一条**（层叠顺序）在补上之前是**绿的**：文件里每一条断言都自己拼 markup，
于是把 `withMessageCss(withPluginCss(…))` 对调成 `withPluginCss(withMessageCss(…))` 一条都不红——
生产者测了、消费者测了、**两者之间的那次拼装没人测**。现在那条断言读的是 controller 实际拼出来的
那个字符串。**倒数第一条**是同一条缝的上一层（hook → controller），它在 §112 就存在，
这次只是把它从「`css` 是最后一个参数」改写成「两张表都被交出去」——原来那条钉的是一个
**偶然的位置**，一次完全正确的改动就会让它红。

`plugin-surface.test.ts` 里那条「插件样式标签不与 message-preset 共用 `data-iris-style`」原样有效：
字面量搬进了 `@iris/protocol`，值一个字节没变。

### 验收读数（2026-09-19，`qa/sandbox-plugins-pr-c.mjs`，宿主 8794，CDP 9347，爱衣的问候楼）

不花钱：插件源走 PR-A 那个仪器——在卡脚本帧里开一个 isolated world，读帧自己的
`<meta name="iris-token">`，post 一条与壳逐字节相同的 `plugin:mount`。

| 读数 | 基线 | 挂上之后 | 卸掉之后 |
| --- | --- | --- | --- |
| 消息帧上的 `[data-iris-plugin-style]` | 0（1 帧） | **1**（1 帧） | 0 |
| 卡脚本帧上的同一个标签 | — | 1 | — |
| 状态栏 `body` 计算背景 | `rgba(0,0,0,0)` | **`rgb(16,20,24)`** | `rgba(0,0,0,0)` |
| 卡自己的 `.card` 面板 | `rgba(255,255,255,0.85)` | **`rgb(16,20,24)`**（带 `!important`） | `rgba(255,255,255,0.85)` |
| 消息帧 srcdoc 内联字符数 | 711 988 | **712 123**（+135） | 711 988 |
| **壳自己的文档**上的同一个标签 | 0 | **0** | 0 |
| 两个插件同时挂，卸掉第二个 | — | 2 张 → **1 张** | — |

观察窗口：每一格读两次（4 s 与 9 s），因为重建会把旧帧 park 在屏幕上直到替身起来——
一次读数分不出「折进去没发生」与「替身还没起来」。

### What would reopen this

(a) 消息帧改成同源文档（或者别的能被壳直接写进去的形状）：那时「只能重建」这条理由消失，
闪一下的代价可以还掉，本节第六条要重写。
(b) 出现第二个写 `data-iris-plugin-style` 的地方：今天是两个（帧内 sink 与壳的折叠），
它们共用一个字面量；第三个出现时要先回答「按标签清理的那几段代码分得清谁是谁吗」。
(c) 有了真实插件的 CSS 体量语料：32 KiB 与「按插件合计」都是**判断不是测量**（§10.4 的口径），
第一批真实使用之后应当量一次再定。
(d) `FramePlan.spent` 长出 UI 读者：那时验收该改回读面板，本节出入 2 可以删掉。
(e) 一个对话里同时挂着很多插件、重建开始被读者感知为卡顿：那时「每张表一个 `<style>` 元素」
与「每次发布重建一次」这两条要一起重看——今天它们分别买到了按 owner 的可清点性与实现的简单。

## 115. 网络授权进了契约：机制早已在策略里，缺的是从用户到 `framePolicy` 的那条路

**Kind:** deliberate divergence from upstream, completed（上游无对应物——SillyTavern
的卡代码跑在页面本身上，远程图片、fetch、样式表对它本来就是开的，没有「授权」这个
概念可偏离；本条记录的是 Iris 自己一侧「策略先于开关」的完成）。

**起因是一条用户路径的实测。** 2026-09-19，「魔法少女的扣扣审判1」的外置状态栏里
艾玛头像裂图：卡写死 `https://gitgud.io/.../Profile_Ema.webp`，帧策略默认
`img-src data: blob:`，CSP 拒绝并按设计具名上报（295 条
`blocked gitgud.io (img-src)`，见 `notes/CARD-REGRESSION-2026-09-17-rerun.md`）。
SANDBOX.md 当时写得很诚实：**策略的两个分支都建好了、都测了，但用户够不着开关** —
`networkGranted` 不在契约里，两条真实运行路径硬编码 `false`，只有 dev 探针面板能翻。

**裁决（已存在，本次只是落地）。** 授权按卡、只能用户发起、放宽
`img-src`/`connect-src`/`style-src` 到 `https:`，`http:` 永不，**`script-src` 永不** —
让卡加载作者的图和让卡执行作者的代码是两个决定，授权只为第一个存在。这些原话在
SANDBOX.md 里躺了三周；本次动的是它们之外的一切。

**落地的形状，四层各一处。**

- **契约**：`script.list` 在 `documentGranted` 旁带出 `networkGranted`；
  `script.setNetworkGrant` 写入。与文档授权同表同寿命：撤销即删键（absent 与 denied
  同一状态），写入前 `library.load` 验卡存在，删卡 `forget` 一并清。
- **运行路径**：`useCardScripts` 与 `MessageInterfaces` 两处都从
  `resolveScripts(characterId)` 在**运行时刻**读宿主答案，不读面板缓存 —— 面板状态以
  characterId 为键，而删卡会把 id 让给下一张同名卡，这条规则从文档授权起就是
  AUTORUN.md §二的正文，网络授权只是它的第二个实例。
- **面板**：ScriptPanel 在页面访问权旁加第二个授权块，措辞按后果而不是按机制
  （能到达什么、什么即使授权也拒绝），背后是同形 `RiskConfirmation`，确认勾选项
  点名外泄通道本身：「我知道这张卡将能把它能看到的内容发送到它自己选择的服务器」。
- **通知**：授予/撤销走与页面授权同形的提示句，且同样写明**下次运行生效** —
  帧的策略在建帧那一刻就定死，期望立即生效的用户会从继续失败的卡上得出错误结论。

**与页面访问权的措辞差，是有意的。** 页面授权的确认句点名「读其他对话」和「输入中的
API 密钥」—— 那是该授权真正解锁的能力；网络授权的确认句点名的是**通道**而不是具体
读数，因为 `img-src` 一开，帧里可见的一切（对话在内）都能随卡自选地址离开，具体会
带走什么取决于卡，唯一不变的承诺是通道存在。两句都不能抄对方的：把页面授权的句子
借给网络授权会承诺一个本授权并不给的能力。

**没动的部分，和它各自的守卫。**

- `framePolicy` 本体一字未改：两个分支三周前就在那里，且 `sandbox-srcdoc.test.ts` 的
  「a network grant widens fetch, images and styles — and nothing else」钉住授权前后
  `script-src` 逐字节一致 —— 那条测试先于开关存在，现在守的是开关真正翻动的东西。
- 默认仍关。一张未授权的卡今天的行为与昨天逐字节相同，拒绝仍按域名具名上报。
- dev 探针面板的 `networkGranted` 复选框保留原样：它是 DEV 门控的观测工具，产品
  开关落地后它依然探针 —— 它翻的是探针自己的 frame，不是聊天里的。

### 牙齿

| 断言 | 在哪里 |
| --- | --- |
| 默认拒绝、授予后跨重启存活 | `packages/iris-app-service/tests/scripts.test.ts`「the network grant is denied by default and survives a restart once given」 |
| 撤销存为 absent 而非 `false` | 同文件「a revoked network grant is stored as absent, not as false」（读 policy 文件本体） |
| 不存在的卡存不下授权 | 同文件「a network grant cannot be stored against a character that is not there」 |
| 两个授权互不应答 | 同文件「the two grants answer independently of each other」 |
| 删卡重导同名卡不继承 | `apps/iris/tests/rpc-transport.test.ts` id 复用测试新增 `networkGranted === false` 一条腿 |
| 契约方法真实可达线上 | 同文件 `PROBES` 表新增一行 + registration.test.ts 的注册扫描 |
| 授权前后 `script-src` 逐字节一致 | `apps/iris-web/tests/sandbox-srcdoc.test.ts`（先于本开关存在） |

### 追加：一个可选成员吞掉的缺陷（同日实测）

开关落地后第一次真人验收报「授权了图片还是裂」。查下去有两个互不相干的原因，
第二个是本节的代码缺陷，记在这里因为它的形状值得留下：

**原因一（不是缺陷）。** 卡片的图全部来自 `gitgud.io/Rown/moshen`，该仓库已死：
302 → 登录页 → 403。在**完全没有 CSP 的裸页面**里 `<img>` 也是
`net::ERR_BLOCKED_BY_ORB`。对照实验：把卡片自己 frame 的 srcdoc 复制一份、只把
URL 换成一张活的远程图，同一份 policy、同一个 sandbox 属性、同一套标记，
替代图 LOADED、每个 gitgud URL 都 ERROR；把授权关掉，替代图立刻变 ERROR。
结论：策略与授权链路都是好的，是 URL 死了。卡在 SillyTavern 里同样是裂图。

**原因二（真缺陷，本 PR 内修）。** 授权后 message frame **不会**就地重载，而同一张
卡同一屏上的 script frame 会 —— 一张卡两个 frame 跑在两套 policy 下。根因：
`StartedInterface.applyNetworkGrant` 当初被写成**可选成员**（理由是「早于本开关的
测试替身也该满足这个类型」），于是 `MessageInterfaces.tsx` 里 `runCard` 的包装对象
根本没实现它，`tsc` 一声不吭，调用点的 `?.()` 把它变成静默 no-op。
**一个调用点会用 `?.` 去够的缺失成员，是一段没有编译错误就消失的行为** —— 这正是
本仓库两个 typecheck 存在的理由，而这次是它们没能拦住的那一类。

修法：该成员改为必填（两个实现各一行，测试替身也各一行），并加
`tests/message-frames.test.ts` 的一条断言：一次翻转必须到达**每一个**实例
（只扫一部分会把漏掉那些 frame 里卡片自己的图留在拒绝状态，而屏幕上没有任何
东西说明是哪些），撤销同样如此，disposed 之后不再重导航。实测复验：真实 UI
按钮（设置 → 卡片脚本 → 授予网络访问权 → 勾选 → 确认）后两个 frame 都变成
`https: data: blob:`，无需重开聊天。


### What would reopen this

(a) 有人提出按主机授权（「只放行 gitgud.io」）：那是 SANDBOX.md 已裁的 per-host
allow-list 形状，重开需要新的语料证据而不是偏好。(b) 授权想覆盖 `script-src`：
那把这个授权变成页面授权的穷亲戚，两个授权存在的理由同时消失，需要先推翻
「加载图片与执行代码是两个决定」这条裁决本身。(c) 第三个授权出现：届时
「每授权一块面板 + 一份风险确认 + 一条通知句」的形状应当先被提出来共用，
而不是第三份手写。

## 116. 看得见源码、看得见花费：`sandboxPlugin.source` 的只读视图、用量页的第三条侧支、以及两句空态

### 背景

[SANDBOX-PLUGINS](../../../docs/SANDBOX-PLUGINS.md) 的 **PR-D**（§15），壳这一半。
§112 造了帧里的树，§113 造了 sidecar 与确认卡，§114 把样式送过了帧边界；
剩下的三件都不是机制，是**把已经存在的事实说出来**：模型写的那段代码、它花掉的钱、
以及一个空面板本该讲的那句话。宿主那一半（`sandboxPlugin.source` 的处理者、
`UsageTotals.plugin` 的折叠）在 [iris-app-service DEVIATIONS](../../packages/iris-app-service/DEVIATIONS.md) §98。

### 决定

**一、源码是一次单独的读，不是列表上的一个字段。**
`SandboxPluginView` 不带 `code` 是 §10.2 的裁决，PR-B 已经照做；PR-D 补的是另一半——
`sandboxPlugin.source({ chatId, pluginId, version? })`。壳这边它落成 store 上**一个**
`sandboxPluginSource`：一次只开一个、关掉就丢、换对话就丢。
理由是这是壳里唯一一处「因为读者想看」而不是「因为帧需要」才持有模型源码的地方，
留一份看过的缓存等于攒下一堆屏幕上没有任何东西交代的不可信文本。
`pluginId` 是**按对话铸的**，所以换对话必须清——否则一段对话的代码会挂在另一段对话的行下面。

**二、只读是「面板里没有可编辑元素」，不是「那个元素被禁用了」。**
落地是一个 `<pre>`。不是 `<textarea readOnly>`：后者打不进字，但它**是**一个编辑控件，
读者遇到它会去试；而且真正的理由（授权是按哈希记的，改一个字就是一版没人点过头的代码）
不是某个元素的属性能表达的。所以块下面那一句不是免责声明，是**这个视图自己提出的问题的答案**：
要改就再说一句话。测试断的是整块面板里 `textarea, input, [contenteditable]` 计数为 0，
牙齿正是把 `<pre>` 换成 `<textarea readOnly>`——它照样打不进字，照样红。

**三、块头上印版本**与**哈希**。哈希是授权的单位（§3.2 裁决 Q1），所以它是读者能拿去和
确认卡上那一行对上的唯一一个东西。同理，宿主对**要不到的版本**具名拒绝而不回落到当前版：
拿着面板上的哈希去读另一版的字节，屏幕上没有任何东西会说出这件事。

**四、空态说两句，而且顺序是裁决。**
§12 规则 3 只要求「空的时候说一句话」。PR-B 那一句是「切到『创造』说一句话试试」——
它**没说创造是什么**，也**没说开关在哪**（在输入框的 `+` 里，而那不在这个面板上）。
改写后的一句两件都说。另一句只在 `authoring` 未设时出现，而且**排在前面**：
后一句让读者去开一个此刻是灰的入口，读者按着做、做不到，读起来就是功能坏了。
「先说原因，再说做法」是这一条的全部内容，测试断的是**两句的先后**而不只是两句都在。

**五、用量页加一行，按既有两行的做法，不加第四个图表指标。**
`UsageTotals` 多一个可选的 `plugin`，总量下面那条注记多一个 `<span>`（自己的 `title`），
每对话小计那一格多一个 `<span>`。**没有折线**：与压缩摘要同一个理由，而且更硬——
一段对话一辈子就几次「创造」，它的序列是一条带尖峰的零线，读者真正想要的那个数是注记里那一句。
缺席即整句不画，不画 0：这条绝对不能松，因为从没用过这个功能的档占绝大多数。

**六、`rpc.ts` 里那句「Three methods」改成没有数字的说法。**
不是改成「四个」。一个写在表旁边的计数会无声地过期，而
`packages/iris-protocol/tests/method-names.test.ts` 正是这件事的常设记录（一次对同一张表的
清点用了会漏掉深层名字的模式，报出来的总数读起来是完整的）。
新的 `tests/sandbox-plugin-methods.test.ts` 钉性质不钉数：这一族非空、每一个都带**必填**的
`chatId`（这是 `source` 的跨对话拒绝在协议侧的那一半），个数在 `t.diagnostic` 里当场算出来印一遍。

**七、面板长出两个身份属性，理由与 `data-tab` 的完全一样。**
`data-panel="sandbox-plugins"` 与行上的 `data-plugin-id`。`qa/locators.mjs` 的规矩是
壳自己的部件**永远不按可见文字找**——headless Chrome 在这台机器上是中文起的，
每一个英文文案定位器都会落空。`PluginCenter` 的行早就带 `data-plugin-id`，这是同一件事往里一层。

### 与上游的对照

SillyTavern 没有对应物：那里没有「这段对话自己长出来的代码」，也就没有读它、
为它单独记一笔账、或者在它不存在时解释它是什么的问题。按「兼容是地板」的规矩，代价写平：

- **源码视图是一次额外的往返。** 面板打开不带源码，按下「看代码」才有；所以它有一个
  「正在读取」的中间态，而这个中间态和「这个插件的源码是空的」在一次读数里同形。
  验收因此**轮询到期限**再判，而不是读一次。
- **一次只开一个。** 想同时对比两个插件的代码做不到，也不打算做：那需要一份留存的源码表，
  而那正是决定一要避免的东西。
- **`plugin` 那一行是这一页上唯一一笔不是走这个对话自己的连接花出去的钱。** 注记的 `title`
  因此指的是「写插件用」那一行，而不是描述请求本身——嫌这个数大，要动的是那一行。

### 与设计稿/任务书的出入（四处）

1. **`docs/GLOSSARY.md` 在 `origin/main` 上不存在**（REVIEW-3 没有落这一份），
   所以文案审计对的是 `apps/iris-web/src/app/i18n/STRINGS.md` §三 的术语表。
2. **任务书说「用量面板 `SIDE_SOURCES` 的 `'plugin'` 成员」已由 PR-B 记账进去。**
   成员确实在，`TurnUsage.source` 也认它；但 `UsageTotals` **根本没有 `plugin` 这个字段**，
   合计器的 `if (source !== 'script' && source !== 'compaction') return` 也把它挡在外面——
   也就是说这笔钱当时**计进了总量、没有任何一处能把它单列出来**。PR-D 加的是这一格。
3. **§15 PR-D 列的「分支复制」在 PR-B 就落了**（宿主账 §97 决定四，带 `branchedFrom` 与授权，
   并有自己的测试）。设计稿的那一行已改写成「其中两项在 PR-B 就已落地」。
4. **术语一处改、一处不改，两处都记。** `pluginFixDisposeFailed` 的「这个聊天」改成
   「这个对话」（裁决：聊天只用于 ST 沿袭的功能名）。**没改**的是 `authoringPick: '供应商'`：
   裁决说 provider 用「提供方」，STRINGS.md §三 的表也这么写，但 owner 2026-09-09 的
   CC Switch 连接面落地用的是「供应商」，全库 25 处，`authoringPick` 选的正是那张列表里的一项。
   只改这一个会让同一张卡上一个控件与它的列表叫两个名字。这是一条**先于 PR-D 就存在的分歧**，
   记在这里等裁，不在这个 PR 里单方面改。同理未改的还有另外七处非 ST 名字里的「聊天」
   （`worldbookGlobalSelect`、`worldbookCharNote`、`worldbookGlobalHead`、
   `worldbookMinActivationsDepthMaxNote`、`wiDelayNote`、`showFloorNumbersNote`、
   `pluginCenterRetained`），它们都不在这个 PR 的面上。

### 一条没有读者的文案（PR-B 留下的，本节不动）

`pluginsPanelNoHost`（「这台宿主不保存沙箱插件」）在两栏都有，**没有任何地方 `t()` 它**。
`store.ts` 的 `loadSandboxPlugins` 在吞掉拒绝时写着「面板会安静地说同一句话，因为它同时
看得见空列表和那次拒绝」——面板看不见：store 上没有任何字段带着那次拒绝。
i18n 测试钉的是两栏键集相等与占位符一致，**不钉「每个键都有读者」**，所以它一直是绿的。
补它要在 store 上加一个状态，那是一条独立的改动；这里只把它记下来，免得下一个人以为它在用。

### 测试与牙齿

十三次变异，每次**改代码**（不是改夹具），各自至少红一条，恢复后全绿。

| 断言（在哪） | 让它变红的改动 | 结果 |
| --- | --- | --- |
| 当前版就是最后一版（`sandbox-plugins.test.ts`） | `versions.at(-1)` 改成 `at(0)` | 红 → 绿 |
| 要不到的版本具名拒绝，不回落（同上） | 给 `find` 加 `?? versions.at(-1)` | 红 → 绿 |
| 没有的插件具名拒绝（同上） | 把 `throw notFound` 换成返回空源码 | 红 → 绿 |
| **别的对话读不到这个插件**（同上） | 让 store 的 `#fileFor` 忽略 chatId，所有对话共用一个文件 | 红 → 绿 |
| `'plugin'` 折进自己那一格（`usage-summary.test.ts`） | 合计器的守卫改回只认 script/compaction | 红 → 绿 |
| `pluginTokens` 读的是插件那一份（`usage-stats.test.ts`） | 让它读 `totals.script` | 红 → 绿 |
| 代码视图里没有编辑控件（`sandbox-plugin-panel.test.ts`） | `<pre>` 换成 `<textarea readOnly>` | 红 → 绿 |
| 有份额就画那一句（同上） | 把 `Cards` 里那个分支改成恒 null | 红 → 绿 |
| 没份额就一个字都不画（同上） | 把同一个分支改成恒渲染 | 红 → 绿 |
| 空态两句的**先后**（同上） | 把两个 `<p>` 对调 | 红 → 绿 |
| 中文那句说出开关在哪（同上） | 从 `pluginsPanelEmpty` 的中文里删掉「在输入框旁边的『+』里」 | 红 → 绿 |
| 换对话时丢掉打开着的源码（同上） | 从 `loadSandboxPlugins` 的清空里删掉 `sandboxPluginSource` | 红 → 绿 |
| 每个 `sandboxPlugin.*` 都带必填 chatId（`sandbox-plugin-methods.test.ts`） | 把 `source` 的 `chatId` 改成 `.optional()` | 红 → 绿 |

判别力最值得记的是第四条与第十条。
**第四条**（跨对话）单靠处理者是做不出牙齿的：它和「没有这个插件」共用同一句
`notFound`，任何对处理者的改动都会同时打到两条断言。让它单独红的那个改动在**别处**——
store 按什么给文件命名。这正是这条断言真正依赖的东西：id 作用域不在处理者里，在
`read(chatId)` 里，而处理者里**没有**第二次「这段对话拥有它吗」的检查，也不该有。
**第十条**（两句的先后）在写成「两句都在」的时候是绿的：先后正是这一条的全部内容，
而「都在」对着一个把顺序写反的实现一样成立。断言因此读的是两句在 HTML 里的**下标**。

还有一条工装上的发现，记在这里因为它差点让一条断言不存在：
这个环境里的 `python3` 是 Windows 应用商店那个**空壳**，不报错、不输出、什么都不做。
用它做的三处编辑全部静默落空，其中两处当场被后续命令发现，第三处
（`usage-stats.test.ts` 里那条 `pluginTokens` 的断言）**是被牙齿发现的**——
变异跑出来一个「broken=GREEN (NO TOOTH)」，回去看才发现那个测试根本没被写进去。
一次没有牙齿的变异，和一条没有被写进去的断言，在测试报告里同形。

### 验收读数（2026-09-19，`qa/sandbox-plugins-pr-d.mjs`，宿主 8795，CDP 9348，爱衣）

不花钱，但**也不用 PR-A 那个仪器**：面板要看的是**记录**而不是帧里的树，
所以脚本把 sidecar 自己写进那份数据目录拷贝（§10.1 的形状，两个版本、字节不同、已授权），
宿主每次 `sandboxPlugin.list` 都从这个文件读，它下游全是产品。跳过的是模型请求与确认卡，
那是 PR-B 的。**15 个框全绿。**

| 读数 | 值 |
| --- | --- |
| `sandboxPlugin.source`，不给版本 | v2，`12ecd2774b61`，84 字节，**与挂载的字节逐字符相同** |
| `sandboxPlugin.source`，`version: 1` | v1，`c5cfadeedaae`，85 字节（与 v2 不同） |
| `version: 7` | `not-found plugin "1-dark-status" has no version 7; this conversation keeps v1, v2` |
| 另一段对话问同一个 pluginId | `not-found this conversation has no plugin "1-dark-status"` |
| `sandboxPlugin.list` | 1 行 / 1 个待挂载 / **行里 `iris.styles` 出现 0 次** |
| 面板行（开对话后 512 ms） | `1-dark-status` · 深色状态栏 · **挂着 · v2** |
| 「看代码」块（点击后 503 ms） | 头 `第 2 版 · 哈希 12ecd2774b61`，84 字符，**`textarea/input/[contenteditable]` 计数 0** |
| 空对话的空态（中文） | 两句，顺序为「先说一句：还没有选写插件用的模型…」→「这段对话还没有长出任何功能…」 |
| 空对话的空态（英文，改 `localStorage` 后重载） | 同样两句同样顺序 |
| `usage.summary` 的 `totals.plugin` | `{cacheMiss: 8300, output: 640, turns: 1}`，总量 `cacheMiss 744388` |
| 用量页上那一句 | 「其中写插件请求」**出现** |

观察窗口：面板的行与源码块都**轮询到 15 s 上限**再判，两者都在一次往返之后才到，
读一次分不出「还没到」与「不在那里」；两者实测分别是 512 ms 与 503 ms。
用量页那一句读一次，在报告打开后约 2.5 s，截图留在 `qa/results/sandbox-plugins-pr-d/`。

**第一趟全红，原因记在这里，因为它两次都不是产品的问题。**
（a）宿主服务的是 `apps/iris-web/dist`，而那份 dist 是在最后一次改 `SandboxPluginPanel.tsx`
**之前**构建的——`data-panel` 还不在包里，于是面板「不存在」；
（b）`chat.create` 按卡名命名对话，这份数据目录里叫「爱衣」的对话有**六条**，
按标题点行点中的是别人那条。第二条现在是脚本自己的一条断言（同名多于一行即具名失败），
对话也改成唯一标题再点——rename 不动 `chatId`（§10.3），所以 sidecar 不受影响。

### What would reopen this

(a) 读者开始要**并排比两个版本**：那需要一份留存的源码表，决定一（一次只开一个、关掉就丢）
要连同它的理由一起重写。
(b) `SIDE_SOURCES` 出现第四个成员：宿主账 §97 的 (e) 已经写了「先问用量面板要不要把它们收成一组」，
那时这一页的三句注记要一起重看，而不是加第四句。
(c) 「提供方 / 供应商」被裁决统一：出入 4 记的那 25 处要一次改完，`authoringPick` 跟着走。
(d) `pluginsPanelNoHost` 长出读者：那要在 store 上加一个带着那次拒绝的状态，
`loadSandboxPlugins` 里那段注释同时要改——它今天描述的是一件面板做不到的事。
(e) 面板从侧栏搬走：两个身份属性（`data-panel` / `data-plugin-id`）是给 `qa/` 用的，
搬家时要跟着，否则验收脚本会以一种看起来像产品缺陷的方式失败。
## 117. 授权问在拒绝发生的地方，而不只在设置里

**Kind:** deliberate divergence from upstream（上游无对应物）。SillyTavern 的卡代码跑在页面
本身上，远程图片本来就是开的，没有「按需询问」这件事可比；本条记的是 Iris 在自己已经
收紧的前提下，怎么把「放权」这件事交到读者手里。

**起因是一条使用逻辑，不是一条缺陷。** §115 把网络授权落成契约上的开关之后，owner 的第一
反馈是：`「发现卡里面图片都加载不出来」→ 开关在设置面板里`。他要的是手机应用权限的形状 ——
**需要外网的时候才问，不需要的卡永远不问**，而不是让人先知道有个开关、再去找它。这一点
owner 说得很准：一个埋在设置里的开关，对「眼前这张图的裂图」这件事没有任何连接。

**形状：入口长在证据旁边。** 拒绝报告本来就是卡里被 CSP 拦下的每个请求的具名记录
（`blocked gitgud.io (img-src)`），§115 之前它只是证据。现在它同时是**问题**：能修的那类
拒绝，行内多一个「允许这张卡联网…」的按钮，点开的是**面板那个授权块用的同一个
`RiskConfirmation` 弹窗、同一段确认勾选**。走近路不等于绕开决定 —— 这条是本节唯一真正
的裁决（shortcut 不是 bypass），因为一个能被卡片文案绕过的授权入口，就等于把 §115 里
「卡无从请求」那句话删掉。

**一个必须守住的诚实性规则：只对授权真能放宽的指令给入口。** 授权放宽
`img-src`/`connect-src`/`style-src` 三个指令；`font-src` **没有** grant 分支（`srcdoc.ts`
的 `faceSources` 在读取 `networkGranted` **之前**就建好了），所以字体拒绝是开关碰不到的。
在它旁边放一个按钮，读者按下去什么都没变，得出的结论会是「这个开关是坏的」—— 比没有按钮
更糟。于是「哪些指令会被放宽」被提成**单一事实源**（`GRANT_WIDENED_DIRECTIVES`），并且由
一条对照测试绑在**真实生成的策略**上：把 `framePolicy(false)` 与 `framePolicy(true)` 各拆成
指令映射，值发生变化的指令必须恰好等于那个列表。这样将来某个指令长了 grant 分支却没进列表，
红的是 `sandbox-policy.test.ts`，而不是它的拒绝悄悄失去入口。

**三个答案，不是两个。** `grantOffer(directive, networkGranted)` 返回
`'offer'` / `'already-on'` / `'no'`。第三个分支是「授权已经开着」，它与「授权帮不上忙」是
两件事：前者该说的是「这已经是开关能做的全部了，所以问题不在这里」，后者是沉默。合并成
`false` 会让一个有不同问题的读者读到同一句话。

**浏览器报的是元素专属指令名。** 一个被拦的 `<link>` 报的是 `style-src-elem` 而不是
`style-src`（CSP3 把元素专属指令拆成独立名字）。第一版逐字比较，于是每个被拦的样式表都失去
了入口，而图片保留着 —— 这种不对称读起来像「这张卡时灵时不灵」，而不是像「少剥了一个后缀」。
`-elem` 后缀被剥掉，且**只**剥它，所以 `font-src-elem` 不会靠拼写混进来。

**授权状态在报告的那一刻现读，不是建帧时快照。** 两个调用点都取
`store.getState().networkGranted`，而不是用建帧时捕获的值：捕获的版本会让「读者刚把开关
打开之后到达的拒绝」仍被记成 `'offer'`，于是在屏幕上放一个按钮，请他们做刚刚做完的事。
`addCardReport` 的重标日期分支同样把 `grant` 带过去，理由相同 —— 同一条拒绝在新一轮运行里
重现，正是答案可能已经改变的那一刻。

**牙齿。**

| 断言 | 在哪里 |
| --- | --- |
| 只有授权真放宽的指令拿到入口；`font-src`/`script-src` 不拿 | `apps/iris-web/tests/sandbox-policy.test.ts` |
| 元素专属名（`style-src-elem`）仍拿到入口，`-elem` 只剥一次 | 同文件 |
| 授权已开时给的是 `'already-on'` 而不是入口 | 同文件 |
| **列表与真实生成的策略逐指令一致**（对照测试，非重述） | 同文件 |
| 拒绝携带 `grant`；covered 拒绝的 grade 与 grant 各自独立判定 | `apps/iris-web/tests/blocked-line.test.ts` |
| 端到端：真实拒绝 → 行内入口 → 同一弹窗 → 确认后每个帧都放宽 | `apps/iris-web/tools/live-ask-on-demand-check.mjs`（8789 实测，卡 `魔法少女的扣扣审判1`） |

### What would reopen this

(a) 某个指令长了 grant 分支：它必须同时进 `GRANT_WIDENED_DIRECTIVES`，否则该指令的拒绝会
失去入口 —— 对照测试会先红，本节其余不变。(b) 出现第三个授权：那时「授权块 + 风险确认 +
报告行入口」这套形状应当先被提出来共用，而不是第三份手写。(c) 如果哪天卡片能影响报告行的
措辞（今天不能：文本来自 `describeRefusal` 自己的模板，按钮标签是壳的固定字符串），那么
「入口不是卡片文案的延伸」这条要重新论证，因为一个能被卡片措辞装饰的授权入口，就是 §115
里被删掉的那句「卡无从请求」。

---

## 118. 帧沙箱带上 `allow-forms`，提交由帧自己吃掉 —— 上游根本没有 `sandbox` 属性

**Kind:** deliberate divergence from upstream, in the permissive direction（上游
的卡帧没有 `sandbox` 属性，所以「允许表单提交」对它不是一个决定；Iris 加了沙箱，
就必须把这条一并补上，否则补出的是一个上游不存在的行为差异）。

**起因是一张真卡的按钮点了没反应。** 2026-09-19，「黑兽」的开局页是一张真
`<form>`，提交按钮靠卡自己的 `submit` 处理器 `preventDefault()`。Iris 帧的属性是
`sandbox="allow-scripts"`，**没有 `allow-forms`**，于是浏览器在**任何卡代码运行之前**
就把提交拦掉——卡还没来得及装监听器——用户看到的是「点击毫无反应」，而控制台只有
一句 `Blocked form submission to '' ... 'allow-forms' permission is not set`，
**Iris 的三条上报通道（`window.onerror`、控制台捕获、`onError`）一条都接不到**，
因为它发生在帧安装之前。

**上游为什么没有这个问题。** TavernHelper 构造消息帧文档
（`[TH] src/panel/render/iframe.ts:78-103`）时不写 `sandbox` 属性，`sandbox` 与
`csp` 在 `src/panel/render/` 与 `src/panel/script/` 里一次都不出现
（`docs/SANDBOX.md`「The message frame does not add one either」逐条记过）。
没有沙箱，提交自然被允许，随后被卡自己的 JS 拦下。**Iris 的沙箱是一处有意的
加固，而加固漏掉了一个旗标，就凭空造出了一种「上游能跑、这里不能」的卡。**

**修法两层，缺一不可。**

- **`policy.ts`**：两个分支都带上 `allow-forms`。这不是放宽访问，是把上游的
  「没有这层限制」补回来。
- **`frame-entry.ts`**：在 bootstrap 自己的执行流里（阻塞式 classic `<script src>`，
  保证在 body 解析之前跑完）注册一个**捕获期** `preventDefault`。**只有旗标是不够
  的**：它会让真实提交导航走一个 `srcdoc` 帧，把卡自己的文档换掉。

上游的等价物是它的 `form-action` CSP——禁止导航、不碰事件。Iris 特意不发
`form-action`（`docs/SANDBOX.md`「The shell's CSP floor」：`srcdoc` 帧继承壳层策略，
而壳层只发三条），所以等价物只能是帧内的捕获期 `preventDefault`。捕获有两个理由：
它必须在卡的冒泡期处理器之前跑，而且必须在卡**根本没装**处理器时也生效。事件照常
到达每一个卡的监听器，只有导航没有了；卡自己调 `preventDefault()` 时发现
`defaultPrevented` 已经是 true，正是上游 CSP 留给它的状态。

### 牙齿

| 断言 | 在哪里 |
| --- | --- |
| 两个分支都带 `allow-forms` | `apps/iris-web/tests/sandbox-policy.test.ts` |
| 捕获期、且 `true` 是第三参数（不是冒泡期） | `apps/iris-web/tests/sandbox-forms.test.ts`「the frame neutralises submissions in the capture phase」 |
| 兜底装在 `announceReady` 之前（解析期就要在位） | 同文件「the neutraliser is installed before the document body parses」 |

源级的后两条是**配对锁**：旗标在 `policy.ts`、兜底在 `frame-entry.ts`，两个文件互相
看不见，任一侧被重构掉，另一侧的测试仍然全绿 —— 而单边失效分别是「静默无反应」和
「帧被导航走」。两次牙齿检查都做过：拆掉帧内兜底，两条转红。

### What would overturn this

(a) 上游给卡帧加上 `sandbox` 并带上 `allow-forms`：那时本条从「补齐上游」变成
「与上游一致」，两层修法都保留，理由改写。(b) Iris 开始发 `form-action`：帧内兜底
就可以撤掉，回到上游那种「策略管导航」的形状——但壳层 CSP 的取舍
（`docs/SANDBOX.md`）要先被推翻。(c) 一张卡依赖提交真的发生（例如靠
`target=_blank` 提交到自己的服务器）：那是一种 Iris 不打算支持的形态，届时要写的是
拒绝理由而不是放开旗标。

## 119. `uid` 从请求 schema 的必填变成可选，并把新词表那六个写入点补上补号

**Kind:** transport-level technicality, fixed at the schema；上游的声明本来就允许

**起因是同一张卡的下一步。** 开局页点「以此启程」后，卡走
`updateWorldbookWith`：读回整本书，追加一条它刚构造的条目（`{name, content}`，
**没有 `uid`**），整组发回。请求被 schema 拒成
`entries[110].uid: expected number, received undefined`。

**这是运输层的技术性缺陷，而仓库已经在一处认出过它。**
`apps/iris-web/src/sandbox/lorebook-aliases.ts` 的 `assignLorebookUids` 文档里写着：

> **It has to happen here rather than being left to the host** … `uid` is the one
> *required* field of the wire's entry shape, so an entry that reached the wire
> without one would be rejected at validation — a card that wrote exactly what
> upstream's declaration allows (`Partial<LorebookEntry>[]`, every field
> optional) failing on a technicality of this transport.

也就是说：Iris 知道「uid 必填」是运输层的毛病，并**只为旧的 lorebook 词表**在帧里
绕过了它。**新的 worldbook 词表六个写入点全都没有补号**，而宿主
`worldbooks.ts` 的 `resolveUidCollisions` 第一行就是
`entry.uid ?? Math.floor(Math.random() * MAX_UID)` —— 与上游
`handleLorebookEntriesCollision`（`lorebook_entry.ts:311`）同一算法，
**但请求 schema 让这个分支成了死代码**。

**修法两层（同一条论证的两半）。**

- **schema（运输层缺陷本身）**：`worldbookEntriesPatch.uid` 改为 `.optional()`，
  非负整数约束在有值时保留。这修的是**所有调用方**，不只是某一个词表。
  同一个 commit 里 `PartialWorldbookEntry.uid` 也改为可选——它自称是上游的
  `PartialDeep`，被要求必填是我的 schema 的错，不该让类型当第二份拷贝。
- **帧侧（与旧词表对称）**：把算法抽成通用 `assignEntryUids<T>`，
  `assignLorebookUids` 成为它的旧词汇别名，**一份实现两处用**，两个词表不会就
  「uid 怎么铸、碰撞怎么探」产生分歧；新增 `prepareWorldbookEntries`（压平 + 补号）
  并让**六个写入点全部改用它**。

**两层都留着的理由。** schema 放宽让宿主能接住任何调用方的无 uid 条目（
`resolveUidCollisions` 重新可达，这是它被写出来时就该有的状态）；帧侧补号让**普通
的卡路径不依赖第二道防线**。少任何一层都能跑通这张卡，但少 schema 那层就留下一个
「换个客户端又撞」的缺口，少帧侧那层就让一个已知缺陷继续由宿主兜着。

`uid` 的可选性不改变任何有 uid 的写入：有值时仍校验非负整数、仍按上游的二次探测
去重，写盘仍按数组位置编 `displayIndex`。

### 牙齿

| 断言 | 在哪里 |
| --- | --- |
| 无 uid 的整书写入合法、有 uid 时仍校验边界 | `packages/iris-protocol/tests/rpc.test.ts`「an entry with no uid is a valid book write, because the host mints one」/「a uid that is present is still bounded」 |
| 整本书追加一条无 uid 条目后写盘：条目数正确、uid 唯一 | `packages/iris-app-service/tests/worldbook-write.test.ts`「a new entry appended to a whole book is written without the caller minting a uid」 |
| **实际发出的 wire 请求**里每条都有 uid | `apps/iris-web/tests/worldbook-facade.test.ts`「an entry appended through updateWorldbookWith reaches the wire with a uid」 |

最后一条断言的是**过线的东西**，不是某个 helper 的返回值：帧才是 uid 必须存在的地方
（请求要过校验），只测 helper 会在某个调用点不再用它时依然全绿。牙齿检查做过——
去掉帧侧补号，该条转红并报出 `entries[2] reached the wire without a uid`。

### What would overturn this

(a) 上游收紧 `PartialDeep` 让 `uid` 成为必填：那时帧侧补号成为唯一正确的做法，schema
那层要改回必填，而六个写入点已经有了补号。(b) `uid` 的含义改变（例如由宿主统一铸造
并且必须回传以标识已有条目）：那要重新区分「新建条目」与「已有条目」，可能值得一个
显式的判别字段而不是可选性。(c) 出现第三个词表：`assignEntryUids` 就是它该复用的
那一个，再写第二份补号实现之前先读这一节。

---

## 120. 选了供应商，「用它写插件」还是灰的：模型跟着供应商走

### 背景（owner 实测，2026-09-19，`40460d7`）

连接页 §11.1 的 「写插件用」 一行：选一个供应商，旁边的模型控件**当场显示出一个模型名**，
而 「用它写插件」 仍然是灰的。把选择挪开再挪回来，按钮才亮。

原因是一行。那个模型控件是**受控 `<select>`**，选项是该供应商的模型加 「自定义…」 哨兵，
**没有一个选项的值是 `''`**；而草稿从 `{ id: '', model: '' }` 开始，改供应商时只写了 `id`。
浏览器没有「不显示任何选项」这种状态，于是它显示第一个模型；React 的 state 仍是 `''`；
`disabled` 读的是 state，读者读的是屏幕，**两边说的不是一回事**。

这不是「按钮判据太严」。把 `disabled` 放宽成「选了供应商就算」是唯一看起来更短的修法，而它
在另一个方向上是错的：那样按钮会在 `model` 仍是 `''` 时点亮，把半条设置送到宿主——契约那边
`connection.authoring` 要求**两个都有或两个都没有**（`service.ts`），少一个的失败出现在
玩家已经打完那句话之后，离引起它的控件三步远。所以修在 **state** 上。

### 决定

**选供应商这一步同时选模型**，判断收在 `apps/iris-web/src/app/authoring-pick.ts`：

- **正在手打**（模型控件是文本框）：屏幕上就是 state 里的东西，无需调和；读者打的名字**活过
  供应商的更换**——他打它正是因为没有列表提供它，而那种名字通常是几个端点共同前置的内测模型
  （owner 2026-09-10 的裁决）。
- **该供应商没有列表**（没探过，或探出来是空的）：回到文本框，手上那个模型**丢掉**——它来自
  *上一个* 供应商的列表，带过去就等于让按钮亮在草稿本来要防的那种错配上。按钮回到灰，这是诚实的：
  state 是空的，框也是空的。
- **该供应商有列表**：新供应商也提供当前这个模型就留着（两个端点都服务 `gpt-4o-mini` 时，
  切一下不该把设置悄悄改指），否则取第一个——也就是 `<select>` 马上要显示的那个。

**不加 `<option value="">` 占位项。** 裁决允许加，但要拿得出「默认第一个模型是错的」的实例，
而这里没有：列表里的每个模型都是这个端点自己广告的，这一行的按钮是 「用它写插件」 而不是一个
破坏性动作，而且行下面那句话会把**存着的**东西念回来。两个控件用两种写法说「什么都没选」
（这里一个空选项，供应商控件里一个 「— 未设置 —」）是更坏的形状。

**`CUSTOM_MODEL` 哨兵原样保留**（owner 2026-09-10：手打永远提供）。

**独立 `.ts` 而不是 `ConnectionPanel.tsx` 里的一个闭包**，理由和 `model-menu.ts` 写下的一样：
node 的测试运行器剥类型但不转 JSX，住在 `.tsx` 里的判断**单测根本够不着**。这一条已经付过一次学费。

### 验收里纠正的两个前提

**一、宿主那一侧没有第二个缺陷。** 任务书里的怀疑是 `connection.list` 可能不回 `authoring`
（store 用它设 `authoringConnection`，而那个字段是composer 「创造」 的闸）。实测（下文读数）：
**设置之前** `connection.list` 的键是 `profiles, activeId, host`，**设置之后**是
`profiles, activeId, host, authoring`，值就是行里存的那一对。`service.ts` 的 `connection.list`
**未设置时刻意不带这个键**（`exactOptionalPropertyTypes` 下「缺席」与「`undefined`」是两件事），
所以早先那次「只看见三个键」的读数不是缺陷，是**未设置**这个状态本身。`packages/iris-app-service`
一行没动，那边的账本也就没有这一节。

**二、composer 的 「创造」 不是一个 `disabled` 的控件。** `Composer.tsx` 一直渲染它，只是在
`canAuthor` 为假时挂上 `note`（「先在连接卡里选一个写插件用的模型」）并让 `onSelect` 提前返回。
所以「它是不是可用的」这个读数只能读**两样东西**：那条 note 在不在，以及选它之后**模式有没有
切过去**——而模式只显示在输入框的 placeholder 与发送键的 `aria-label` 上，两者都会被翻译，
所以判据是「它们变了」，文案只作为证据记下来。

### 测试与牙齿

| 断言 | 在哪里 | 破什么会红 |
| --- | --- | --- |
| 选了带列表的供应商后**立刻**读，按钮已亮；且草稿里的模型**等于控件显示的那个** | `apps/iris-web/tests/connection-authoring-row.test.ts`「choosing a provider with models arms the button in one move」 | B1：把 `onChange` 改回 `{ ...current, id }`（原缺陷） |
| 没探过的供应商走手打路径，且**上一个供应商的模型不跟过来**，打字之前一直灰 | 同文件「a provider with no list keeps the hand-typed path, disabled until typed」 | B2：`authoringPick` 在无列表时返回 `{ id, model }` |
| 存下去的就是显示的那一对（读**发出的 RPC 参数**），store 的 `authoringConnection` 与行里那句话都对得上；清掉 store 的字段后重读 `connection.list` 仍能读回来 | 同文件「what is saved is the pair that was displayed」 | B1；B5：删掉 `store.ts` `loadConnections` 里的 `authoringConnection: listed.authoring` |
| **冷启动**（另起一个 store 走 `boot()`）也带着这个设置——刷新之后的页面走的是这条路 | 同文件「a reload reads the setting back, which is what the composer waits for」 | B6：删掉 `store.ts` boot 那句 `authoringConnection: connections.authoring` |
| 两个供应商都提供的模型**留着**，只有旧供应商有的模型换成新列表的第一个 | `apps/iris-web/tests/authoring-pick.test.ts`「a model both providers advertise is kept rather than re-pointed」 | B3：删掉 `if (models.includes(model)) return { id, model }` |
| 手打的名字活过供应商更换 | 同文件「a hand-typed model survives the provider moving under it」 | B4：删掉 `if (typing) return { id, model }` |

六条牙齿全做过：破一条、跑红、撤回、跑绿。

**其中一条第一次是假的，值得写下来。** 「重读 `connection.list` 之后设置还在」这条断言，在
B5 之下**照样全绿**——因为写入自己的应答已经把那一对放进了 store，重读根本不需要带回什么。
现在那一步先 `setState({ authoringConnection: undefined })` 再读，B5 才转红（红在
「what is saved is the pair that was displayed」）。清那一行是**牙齿本身**，不是收拾屋子。

**同一个文件第一次连失败都报不出来。** `ConnectionPanel.tsx` 用了 dsh primitives 的 `Button`
与 `Modal`，那个包的入口 import 了一个 CSS module；vite 默认把依赖 externalise 给 SSR，于是
node 被递了一个 `.css` 当模块加载，挂在挂载之前。而 teardown 是在挂载**之后**注册的，vite 服务器
与 fake client 都吊着事件循环——所以 runner 什么都不印，一直挂到被杀。两件事都改了：
`ssr.noExternal`（`sandbox-plugin-panel.test.ts` 为 `UsagePanel.tsx` 付过同样的过路费），以及
**先注册 teardown 再挂载**，让坏掉的 setup 能说出自己坏在哪。

### 验收读数（2026-09-20，`qa/authoring-row-acceptance.mjs`，宿主 8796，CDP 9349，不花钱）

数据目录是 `apps/iris/data` 的拷贝（删掉 `host.lock`），供应商是它里面那唯一一个带探过列表的
profile（两个模型，第一个 `deepseek-flash`）。连跑两趟，11/11 PASS，两趟读数相同：

| 读数 | 值 |
| --- | --- |
| `connection.list` 的键（任何写入之前） | `profiles, activeId, host`；`authoring` 缺席 |
| 「创造」 条目（未设置时，阴性对照） | note = 「先在连接卡里选一个写插件用的模型」；选它之后 placeholder 与发送键文案**没变** |
| 行刚打开时 | 供应商 `''`、模型控件是 `INPUT`、按钮 `disabled=true` |
| **选完供应商、同一段表达式里立刻读** | `saveDisabled=false`，模型控件 `SELECT` 显示 `deepseek-flash` |
| 点 「用它写插件」 之后行里那句话 | 「default · … 上的 deepseek-flash」 |
| `connection.list` 的键（保存之后） | `profiles, activeId, host, **authoring**`；值 `{id, model: 'deepseek-flash'}` |
| 刷新之后再读那一行 | 供应商已选中、句子照旧、按钮**不碰任何东西就是亮的** |
| 「创造」 条目（设置之后） | note 为空；选它之后 placeholder 「写下你的部分…」→「说一句话，让这张卡长出一个功能…」，发送键 「发送」→「长出来」，再开菜单 `aria-checked="true"` |

「选完立刻读」是这一格的**全部意义**：以前正是「再动一次」把它治好的，所以那次改动与那次读数
之间不能有第二次交互，脚本把改值、派发 `change`、等 React 落定、读按钮放在**同一段**
`Runtime.evaluate` 里。

### What would reopen this

(a) 出现一个「默认取第一个模型」是错的实例——例如某个端点把一个昂贵或者已下线的型号排在列表
第一位，那时 `<option value="">` 占位项重新有论据，而这一节的第二段就是要被推翻的那一段；
(b) 模型控件不再是受控 `<select>`（例如换成可搜索的组合框）：屏幕与 state 的分岔点会换地方，
`authoring-pick.ts` 的三个分支要按新的控件重新写一遍；
(c) `connection.authoring` 变成可以只带供应商（宿主替你挑模型）：那样草稿里的 `model` 不再是
按钮的必要条件，`disabled` 与本节的修法要一起重讲；
(d) 「创造」 条目改成真的 `disabled`：验收里那两条按 note 与模式变化的读法要跟着改，
否则它们会在一个真的被禁用的控件上继续报绿。

## 121. 引号里的对白有了颜色：上游的 `<q>` 规则搬到渲染之后的那一层

**Kind:** compatibility floor closed, with one seam moved；规则照抄，落点不同

**上游是两行东西。** `messageFormatting` 里一条正则把六种引号包进 `<q>…</q>`
（`[ST] public/script.js:1845-1871`），引号本身留在元素里面（`:1850` 起每个分支都是
`` `<q>"${p1.slice(1, -1)}"</q>` `` 这个形状）；样式表里
`.mes_text q { color: var(--SmartThemeQuoteColor) }`（`[ST] style.css:554-556`），
默认值 `rgb(225, 138, 36)`（`:74`）。就这些。

**那条正则的每一个部件都在说一件事，按上游的原文抄下来：**

```js
/<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/gim
```

- **前五个分支不是装饰，是「别进代码」。** `<style>`、``` ```、`~~~`、``` `` ```、
  ``` ` ``` 各自整段匹配并**原样返回**（`:1866-1868` 的 `else` 分支），所以代码里的引号
  永远走不到后面六个捕获组。
- **没有 `s` 标志。** `.` 不跨行，于是 `".*?"` 不可能跨一行——一个没有闭合的引号被留在
  原地，而不是一路吃到消息末尾。这是这条规则敢作用在没人校对过的文本上的原因。
- **`.*?` 允许匹配空**：`""` 也是一段对白，上游会包。
- **六种引号的顺序**：`"…"`、`“…”`、`«…»`、`「…」`、`『…』`、`＂…＂`。

**门是一条，只有一条。** 整块代码在 `if (!isSystem)` 里（`:1837`），
**没有任何 `power_user` 开关**能关掉它，**也从不问 `isUser`**——读者自己写的那行里的
对白，上游一样上色。而 `:1770-1777` 还在这条门之前把 comment 消息和隐藏消息的
`isSystem` **清成 false**，所以真正被跳过的只剩 `systemUserName` 说的话。

**还有一条与之配套、容易漏读的保护。** `:1839-1843`：在扫描之前，
把 `<…>` **标签内部**的 `"` 换成 U+FFFE，扫完再换回来（`:1874-1876`），
免得 `<div class="panel">` 的属性值被当成对白上色。它挂在
`!power_user.encode_tags` 上，而 `encode_tags` 的默认值就是 `false`
（`[ST] public/scripts/power-user.js:301`），所以默认路径上这条保护**是开着的**。

**在流水线里的位置**：正则跑在 `converter.makeHtml(mes)`（`:1880`）**之前**，
也就是作用在**原始文本**上；`<q>` 是随后交给 showdown 和 DOMPurify 的字符串的一部分。

---

**Iris 抄不了这个机制，因为散文渲染器收的是文本。** `MarkdownText` 明写着
raw HTML 一律当字面文本渲染（"raw HTML renders as literal text (no HTML enters the
DOM)"，`@deepseek-ai/dsh-client-ui-primitives` 的 `markdown/render.tsx` 模块注释），
并且没有任何行内装饰的扩展点。按上游那样把 `<q>` 塞进字符串，结果是读者在页面上
**看见 `<q>` 这四个字符**，正好是这件事想要的反面。

**所以规则照抄，落点后移一个接缝**：`apps/iris-web/src/app/quoted-dialogue.ts`
把上面那条正则（连同标签保护、连同少一个 `s`）原样搬过来，作用在**渲染完的散文**上——
一遍走 `.iris-msg__text` 自己的文本节点，把命中的区间包进 `<q>`。样式则与上游同形：
`.iris-msg__text q { color: var(--SmartThemeQuoteColor) }`，加上
`q::before/::after { content: '' }`（上游是 `[ST] style.css:1208-1211` 的
`.mes q:before/.mes q:after`）——浏览器默认样式表会**自己再加一对引号**，而该给读者看的
引号是模型写的那一对，它们在元素**里面**。

**接缝移了，就得说清代价。三处，都是量过的：**

| 上游 | Iris | 为什么 |
| --- | --- | --- |
| 跨行内标记的一段引号是**一个** `<q>` | 是**每个文本节点一个** `<q>` | `"hello *world*"` 在上游是先包 `<q>` 再交给 showdown，`<em>` 长在 `<q>` 里面；这边 `<em>` 已经存在，一个元素包不住横跨它的区间。同样的字符、同样的颜色，元素个数不同 |
| 逐 token 重跑整条 `messageFormatting` | **只在回复落定后上色** | 上游那条路测下来没有任何节流；这条流水线在每一个正对着它的接缝上都拒绝过这笔交易（消息界面的 claim 就在同一道门后面）。代价是对白的颜色在回复写完的那一刻才出现 |
| `<code>` 里的引号被正则**整段吃掉** | `<code>` 子树在扫描里是**一个占位符** U+FFFC | 渲染之后代码就是元素了，扫不进去；用一个占位字符而不是换行，是因为上游的扫描会**读穿**行内代码（`"` 开在反引号之前时，`(".*?")` 这个分支先命中），换行会把上游连起来的那段引号切断 |

**段落边界补了一个换行，这是「少一个 `s`」在渲染之后的活法。** 上游扫的是**写出来的
消息**，两段就是两行，引号跨不过去；渲染树把那些换行扔了。所以扁平化的时候在每个
块级元素的进出各补一个 `\n`，`<br>` 也补一个——`.` 依旧过不去，两段之间依旧不成一句
对白。

**上游有、这里没有的一条：`.mes_reasoning q`**（`[ST] style.css:558-560`，把同一个颜色
按 `--reasoning-saturation` 降饱和）。思维链在 Iris 是 `Reasoning` 自己的容器，不在
`.iris-msg__text` 里，这一遍不走它。这是**已知的缺口**，不是被否掉的做法。

**一个实现细节值得写下来，因为它是这遍 DOM 操作唯一危险的地方。** React 持着那些文本
节点，下一次提交会往**同一个节点**里写新的读数。所以这遍不切 React 的节点：它把宿主
节点**清空**，把装饰过的副本挂在它右边，并记下清空前的原文。撤销的时候，
**「宿主还是空的」就是判据**——还是空的，说明最后写它的是这一遍，原文该还回去；不是空的，
说明 React 已经提交过新值，那些副本就是旧读数的残留，只能删掉、并且不许碰 React 的值。
`useLayoutEffect` 的依赖表因此必须是**完备**的而不是保守的：一次没被听见的提交，就是一段
挂在新读数旁边的旧对白。

**服务端渲染会为此多叫 305 声。** `check:render` 是 `renderToString`，
`useLayoutEffect` 在那里什么都不做并会说出来（仓库里本来就有 274 声，Composer 那两处）。
这条警告说的是实话——这遍上色本来就只在客户端发生——`check:render` 仍然 ok。

### 牙齿

| 断言 | 在哪里 | 掰断它的改动 |
| --- | --- | --- |
| 六种引号都包，引号在元素里面 | `quoted-dialogue.test.ts`「the six quote kinds upstream wraps, marks and all」 | 把 `＂…＂` 那一组换成别的字符 |
| 一行里两段对白是两段，中间的叙述不是 | 同上「two quoted runs on one line are two runs」 | `(".*?")` 改贪婪 |
| 空引号 `""` 也是对白 | 同上「an empty quotation is still a quotation」 | `.*?` 改 `.+?` |
| 引号跨不了行 | 同上「a quotation cannot cross a line」 | 给正则加 `s` 标志 |
| 落单的引号不包；奇数个只包成对的那一对 | 同上「an unbalanced quote mark is left alone」 | `(".*?")` 改贪婪 |
| 嵌套取外层，扫描从取走的区间之后继续 | 同上「nesting is the outer pair」 | 每次匹配后把 `lastIndex` 退回 `index + 1` |
| 五种代码写法里的引号都不是对白 | 同上「quotes inside code are not dialogue」 | 删掉正则前五个分支 |
| 标签属性里的引号不是对白 | 同上「quotes inside a tag are attribute values」 | 去掉 U+FFFE 那层遮罩 |
| 门是 `!isSystem` 加 Iris 的 streaming | 同上「the gate is upstream's one condition」 | `marksQuotedDialogue` 只返回 `!streaming` |
| 渲染后的散文里，一段对白变成一个 `<q>`，引号在里面 | 同上「a quoted run in rendered prose becomes a `<q>`」 | 包的时候把引号切掉 |
| 跨行内标记的对白整段都上色 | 同上「a quote that spans inline markup」 | 只取完全落在一个节点内的区间 |
| `<code>` / `<pre>` 子树不进扫描 | 同上「a code span is opaque」「a fenced block is opaque too」 | 去掉 `OPAQUE_TAGS` 那半条件 |
| 两个段落之间不成一句对白；`<br>` 同理 | 同上「a quote opened in one paragraph」「a `<br>` is a line break」 | 去掉块级换行 / 去掉 `<br>` 的换行 |
| 界面槽位与折叠的脚手架不是散文 | 同上「an interface slot and a folded scaffold are not prose」 | 去掉 `OPAQUE_CLASSES` 那半条件 |
| 上两次等于上一次 | 同上「marking twice is marking once」 | 去掉入口处的 `clearQuotedDialogue` |
| 撤销把树还原成 React 建的那棵（节点同一性） | 同上「clearing puts the tree back exactly as React built it」 | 撤销时不删副本 |
| React 改写过宿主之后，撤销删副本、留 React 的值 | 同上「when React has rewritten the host」 | 撤销时无条件写回原文 |
| 没有对白的消息，节点一个不动 | 同上「a message with no dialogue keeps the exact nodes React built」 | 同时去掉 `runs.length === 0` 与 `overlapping.length === 0` 两道早退 |
| 三个主题下引号色都还读得动（4.5:1），且与正文墨色**不同** | `contrast.test.ts`「quoted dialogue stays readable in …」「…is a different colour from the prose around it in …」 | 把 `--SmartThemeQuoteColor` 指到 `--iris-ink`（后一条红），或直接用上游的 `#e18a24`（雪 2.46:1、宣 2.11:1，前一条红） |

最后一行那条是这一节唯一改了既有文件的断言，值得说明它**为什么是两条**：一个既过
4.5:1 又恰好等于正文墨色的 token，会让这里别的每一条都报绿，而屏幕上什么都没发生。

量出来的读数（`tokens.css`，WCAG）：雪 `#8a6420` 纸上 **4.93:1**、与墨 3.02:1；
墨 `#d9b46a` 纸上 **8.80:1**、与墨 1.60:1；宣 `#7d5c1e` 纸上 **4.86:1**、与墨 2.49:1。
上游那支 `#e18a24` 在雪的纸上是 **2.46:1**——三个主题不照搬上游 hex 的理由，是这个数，
不是品味。

### What would overturn this

(a) `MarkdownText` 长出行内装饰的扩展点（或 Iris 自己接管 mdast→React 那一步）：那时
整条规则应当回到**渲染之前**，跨行内标记的对白重新变成一个 `<q>`，上表第一行的分歧消失，
而这一遍的 DOM 操作连同它的撤销判据都该删掉。
(b) 上游把这条正则挪到 markdown 之后，或给它加上 `s`：那是上游改了规则，照抄的一方要跟着改，
并且本节的三行分歧要重新量一遍。
(c) 思维链要上色：`.mes_reasoning q` 是上游的做法（降饱和），落点是 `Reasoning` 自己的容器，
不是把 `.iris-msg__text` 的选择器放宽——放宽会把壳里别的 `<q>` 一起染了。
(d) 流式期间也要上色：那要先回答上游那笔「每 token 重跑整条格式化」的账，本仓库在别处
已经拒过三次；真要做，应当是增量的，而不是把这遍整树重扫挂到每个 token 上。
