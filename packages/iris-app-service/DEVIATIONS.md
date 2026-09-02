# Deviations from SillyTavern

Where the host deliberately does something other than what SillyTavern does, and
what each difference was measured to cost. A deviation with no measurement is a
guess, so every entry names the upstream source it read and the corpus test that
would overturn it.

Upstream source cited here is the **installed** extension, not a fetched copy:
`E:/sillyTavern/SillyTavern/data/default-user/extensions/JS-Slash-Runner/src/`.

---

## 1. A card script's own variables are stored beside the installation, not inside the card

**Upstream.** `{type: 'script'}` variables live on the script object inside the
character card, and every write reaches the card file immediately:

| what | where |
| --- | --- |
| read | `function/variables.ts:88` — `useScriptIframeRuntimesStore().get(script_id)?.data ?? {}` |
| write | `function/variables.ts:178-182` — `script.data = variables` |
| that object is the card's | `store/iframe_runtimes/script.ts:1-14` → `store/scripts.ts:71-77` (`character_store.settings.scripts`) |
| and it is saved on change | `store/settings/character.ts:152-160` — a **deep** watcher calling `writeExtensionField`, commented 「酒馆经常读取角色卡数据, 所以这里需要立即保存」 |

Note that the write path itself calls no save — it mutates and returns. The deep
watcher is what turns it into a file write, which is why this is easy to miss by
reading `variables.ts` alone.

**Iris.** The tables live in `<profile>/script-variables.json`, partitioned by
character id and then by script id. The card's `scripts[].data` **seeds** a
partition that does not exist yet — the author's shipped value is a default with
exactly the standing `initial` has — and never overwrites one that does.

**Why.** The same reason `initial` is not writable: a card file gets shared, and
content that depends on how long its owner played is not content its owner chose
to send. Iris also never writes card files at all today, so the deviation is
partly structural rather than only chosen.

**This is not a disagreement with upstream.** `panel/script/ScriptEditor.vue:65`
binds a per-script `export_with.data` checkbox — upstream already treats "does
this state travel with the card" as the author's choice. Iris takes the other
default for a switch upstream itself ships. When a card exporter is built, the
rule is: write back the value that was *imported*, frozen, and omit `data`
entirely when `export_with.data === false`. That makes a card exported from Iris
byte-comparable to the one imported, which a user can check.

**What it costs, measured.** 19 cards on this machine; 14 carry scripts; 47
scripts; **8 hold a non-empty `data`**. All eight are settings — a display
toggle (`是否显示变量更新错误`), a build stamp the author's pipeline wrote
(`构建信息`), two feature switches (`强制重载消息数`, `强制重载功能`,
`isEnabled`), and a note that a rule moved into the script body (`statusRule`).
Nothing in the corpus grows with play. MVU, the heaviest framework in it, never
writes this scope at all — its settings go to `extension_settings.mvu_settings`
(per-installation) and its gameplay state to the `chat` and `message` scopes.
So the deviation costs no behaviour today.

Upstream already splits identity from value here, which is the other half of the
argument: **all 47 script ids appear 0 times in `settings.json` and 0 times
across the 31 chat files**, while script *enablement* is stored per-installation
in `extension_settings.tavern_helper.script.enabled.characters` — keyed by
character **name**. A script's id travels with the card; what the installation
decided about it does not. (This search was first run over an undercounted 22 of
the 47 ids; re-run over all 47, the result is unchanged.)

**What would overturn it.** One real card that writes player progress into
`scripts[].data`. `tests/script-variables.test.ts` re-measures the corpus on
every run and fails when a key appears that was not there when this was decided.
It pins **key names, not a count**: a card that swapped its build stamp for a
save file would keep the count and break the claim.

**How the numbers were got wrong, twice.** Both times by walking a card's
extensions by hand. The corpus stores scripts under three container shapes —
`tavern_helper.scripts`, `tavern_helper` as an entries array, and
`TavernHelper_scripts` — so a walk written from one shape over-counts (a regex on
key names sweeps in `regex_scripts`: 222 instead of 47) or under-counts (only the
first shape: 22 instead of 47, and 2 non-empty instead of 8). The measurement is
correct only through `@iris/script`'s `extractScripts`, which already encodes the
three shapes and documents them at the top of `extract.ts`. **Using the product's
own reader is not a convenience here; it is what makes the number true.**

---

## 2. A `script` scope selector with no `script_id` is refused

**Upstream** throws — `未指定 script_id`, at `function/variables.ts:85` (read)
and `:175` (write) — because a script always knows its own id, and a caller that
does not is not a script.

**Iris** does the same, as `invalid-request`. It briefly did not: an earlier
version defaulted to an `'anonymous'` partition. That would have pooled every
unidentified caller's state into one shared table, and once the scope persists,
that table is on disk. Refusing costs a card nothing that upstream would have
allowed it.

---

## 3. The host's variable fold emits no `VARIABLE_UPDATE_ENDED`, deliberately

**Upstream.** `Mvu.events.VARIABLE_UPDATE_ENDED` is `'mag_variable_update_ended'`
(`JS-Slash-Runner/@types/iframe/exported.mvu.d.ts`), and its listeners take
`(variables, variables_before_update)`.

It is **not a notification.** `MagVarUpdate/src/function/update_variables.ts:1472`
emits it, and the four lines after it decide the outcome:

```js
await eventEmit(variable_events.VARIABLE_UPDATE_ENDED, variables, variables_before_update);
//在结束事件中也可能设置变量
_.unset(variables.stat_data, '$internal');
const is_modified = !_.isEqual(variables.stat_data, variables_before_update.stat_data);
if (is_modified) { reconcileAndApplySchema(variables); }
```

The emit is awaited, the author's own comment says listeners set variables, and
`is_modified` is computed *after* the event — so a listener's mutation can flip
the update from "nothing changed" to "changed", trigger schema reconciliation,
and be persisted. Both documented examples mutate (clamping a stat to ≥ 0,
capping an increase at 3). It is an **interception**.

**The gap as first reported.** The host folds MVU commands in `#settle`, the
bundle is not part of that path, so nobody emits the event — and a card that
redraws on it would not wake.

**Why the gap is empty.** Measured on the corpus 2026-09-02: 7 listener
registrations across **4 cards**, and all 4 ship the MagVarUpdate bundle
themselves (jsDelivr import, served through `/iris/script-bundle`). The bundle
registers its own trunk on `MESSAGE_RECEIVED`
(`MagVarUpdate/src/function/update/index.ts:14`), and
`apps/iris-web/src/sandbox/host-events.ts` forwards `MESSAGE_RECEIVED` on
`stream.end`. So on exactly the cards that listen, the bundle folds and emits the
event itself, on the card's own bus, with both trees. **Zero measured consumers
depend on the host emitting it.**

**Why emitting it anyway would be worse than not.** A host emit would be a
*second* emitter for an event that already fires. Because the listener is an
interception that mutates, firing it twice does not merely duplicate a
notification — it applies the correction twice. "Cap the increase at 3" applied
to its own output is a different number. Absence leaves the four cards working;
a well-meaning round trip breaks them.

**Does the host double-fold?** No, and the reason is worth writing down because
the surface reading says yes. Both paths do fold the same reply: the host in
`#settle`, and the bundle in `handleVariablesInMessage`
(`update_variables.ts:1500`). But the bundle reads its base from
`getLastValidVariable(message_id)`, whose semantics are the interval
`[0, message_id)` — the state **before** this floor. The host's write to floor N
is therefore not the bundle's input; both computations start from floor N−1 and
apply the same commands to it. The result is the same value written twice, not a
value folded twice, so non-idempotent commands (`add`, `insert`) do not
double-count.

What it *is* is **last-writer-wins**: for cards carrying the bundle, the bundle's
fold overwrites the host's, so upstream's implementation is authoritative for
them. That is the outcome compatibility wants. The bundle's write arrives through
`script.setVariables` with `scope: 'message'` and `op: 'replace'`, which the
contract already carries.

**What would overturn this.** A card that listens to `VARIABLE_UPDATE_ENDED`
*without* shipping the bundle — it would consume a `Mvu` some other card
provided, and on the host fold path its listener would never run. That premise is
**asserted, not cited**: `tests/mvu-events.test.ts` fails with this deviation's
number in the message when such a card appears, because nobody re-runs a census
to check an assumption they have stopped thinking about. At that point the only correct
implementation is the **full round trip** (host broadcasts both trees → frame runs
the listeners → host adopts what they returned), never a notification-only
forward, which would execute the card's correction, appear to succeed, and
discard it.

**Note on the second upstream typo.** `VARIABLE_INITIALIZED` is
`'mag_variable_initiailized'` — `i-n-i-t-i-a-i-l`. Copied verbatim wherever this
host names it, on the `substidudeMacros` precedent: a correctly spelled constant
reaches no listener at all.

---

## 4. A floor that wrote no variables inherits, where upstream answers empty

**Upstream.** `getVariables({type: 'message'})` with `'latest'` or no id
(`JS-Slash-Runner/src/function/variables.ts`):

```js
chat_message = chat.filter(m => !m.is_system).at(normalized_message_id);
return chat_message?.variables?.[chat_message?.swipe_id ?? 0] ?? {};
```

Two properties: it **filters `is_system`** before taking the newest, and it does
**not inherit** — a floor with no table of its own answers `{}`.

**Iris.** `entry.currentVariables()` resolves the newest **turn** without an
`is_system` filter, takes that candidate's own table, and when there is none
walks backwards to the nearest earlier one.

**Why the values still agree.** Upstream's MVU materialises a table on *every*
floor: `updateVariablesWith(updater, {type: 'message', message_id})`
(`MagVarUpdate/src/function/update_variables.ts:1551`) sits **outside** the
`if (has_variable_modified)` guard that gates the chat-scope write. So upstream
never reaches its own `?? {}` while MVU is running, and its answer for an
unchanged floor is a materialised copy of the previous state — the same value
this host produces by inheriting. Two internally coherent designs meeting at the
same number by different routes. Three constructions were measured (a system row
last; a reply that wrote nothing; a system row carrying its own table) and all
three agreed.

**Where they diverge.** Only when a floor has no table *and* nothing materialised
one — that is, where MVU is not running. Upstream answers `{}`; this host answers
the previous state. The usage that suffers is **read → test for empty →
initialise**: upstream re-initialises on every such floor, this host hands back
the old value and the initialisation never runs.

**Scope of the zero, stated because the zero is thin.** No corpus card is
affected, but that is coincidence rather than structure: the non-MVU pool is
**3 cards** (希尔, 萧谴写卡助手, the sample card) and **none of them touches a
variable API at all**. The zero rests on three cards happening not to use the
feature, not on anything that would keep a fourth from doing so. Caliper: the MVU
detector's wide reading counts 13 cards and its narrow one 9; the 4 in between
use `getMvuData` without a bare `Mvu.` reference and are genuinely MVU.

**Why this is not being aligned.** Matching upstream means copying the
materialisation too, not just adding a filter — and that was measured at **40
stored tables / 201 KB against 4 tables / 20 KB** for the same information. Ten
times the storage to buy a behaviour difference nobody has yet observed. The
inheritance is also the same decision as storing message-scope variables per
candidate: it is an upgrade, not an omission.

**What would overturn this.** A card that reads the `message` scope without MVU
present. `tests/floor-anchor.test.ts` pins the per-floor anchor, which is
deliberately *not* inheriting — the two behaviours live side by side and mean
different things, so neither should be changed to match the other without
reading this entry first.

---

## 5. `characterId` is an opaque id, not a stringified array index

**Upstream.** `this_chid` is a **stringified index into `characters[]`**, so
`characters[this_chid]` works and so does arithmetic on it — `Number(this_chid)`,
`this_chid + 1`, comparisons against numbers.

**Iris.** `characterId` is the card's own id (`'aria'`), and the snapshot's
`characters[]` entries carry that id. `characters[characterId]` still resolves,
because the two fields agree with each other.

**Why the difference is safe as far as it was measured.** The corpus reaches into
that array exactly once, and the shape it uses is
`ctx.characters[ctx.characterId]` — a lookup, not an index. What that needs is
for the two fields to correspond, which they do; nothing in it requires the key
to be a number. Three other `characters[…]` sites exist and none of them touches
this array at all: two are 银麒赎世's own local object of the same name (it
*writes* to it) and one is 扣扣审判's CG-gallery name list. A census that counts
`characters[` hits finds four; a census that asks *which object* finds one.

**Scope of the zero, and it has no mechanism behind it.** A card doing
`parseInt(characterId)`, comparing it to a number, or using it to index anything
other than this array will break. **Zero corpus hits, but nothing prevents it** —
the id is opaque by construction and a card written against upstream may
reasonably assume otherwise. This is the same shape as the frame-opens-only-on-
assistant-floors boundary: measured absence, not structural impossibility.

~~**Why it is not being aligned.** Renumbering would make `characterId` a value
like `'3'`, which changes it for every existing consumer of `script.context` —
`charWorldbooks`, the façade's own lookups — to satisfy no measured need. The
essence of upstream's semantics here is "`characters[characterId]` finds the
character being played", and that already holds.~~

> **Corrected 2026-09-02. The struck paragraph rested on a false premise, and
> the recommendation built on it was mine.**
>
> "That already holds" was wrong. The card does not *search* by the field, it
> **indexes** with it — `ctx.characters[ctx.characterId]` — and an array
> subscripted by a non-numeric string is `undefined` whatever any element's
> `characterId` field says. Measured:
>
> ```
> ours:      characters['aria'] -> undefined     (array + opaque id)
> upstream:  characters['0']    -> FOUND         (array + stringified index)
>            characters[0]      -> FOUND
> ```
>
> JavaScript arrays accept numeric-string subscripts, which is exactly why
> upstream's `this_chid` works and why the shape is not incidental.
>
> **Named, because the error has a shape worth recognising: I took "the two
> values are equal" for "the lookup resolves."** They are different claims, and
> only the second is what a caller depends on. The consequence was not
> theoretical — the embedded book attached in §4 was hung on an element no card
> could reach, so that work was correct in shape and unreachable in practice.

**Ruling (2026-09-02): the translation lives in the façade, and this contract
does not move.**

- `ScriptContext.characterId` stays an opaque id; `charWorldbooks` and every
  by-id lookup stay as they are. The migration cost that argued against
  renumbering is genuinely avoided — it was the *conclusion* that was wrong, not
  that concern.
- The **SillyTavern-facing surface** presents `characterId` as the stringified
  index of the played character within the snapshot's `characters` array, so a
  card's `ctx.characters[ctx.characterId]` resolves and reaches the
  `data.character_book` attached in §4.
- Safe because measured: `characterId` appears in the corpus **only** as a
  subscript — never persisted, never compared — so a façade-side `'0'` cannot
  disturb anything else.
- The principle: **upstream's shape is the compatibility surface's contract, not
  the system's.** Two identities, each where it belongs, rather than one of them
  flooding back into the protocol.

**What would overturn this.** A card doing arithmetic on `characterId`, or one
persisting it across sessions and expecting it to still name the same character.
Either presents as a lookup that silently finds nothing — `characters[NaN]` is
`undefined`, and every corpus reader guards its result — so the symptom is a
card quietly behaving as though the character had no data, not an error.

---

## 6. A card's template writes, and every write is announced

**Upstream.** `evalTemplate` runs a template through the same evaluator as world
book and preset templates, so it reaches the same write channel: `setvar` in any
scope, `delvar`, `insvar`, and a wholesale `saveMetadata`.

**The asymmetry that makes this a decision.** That channel was designed for text
the *user installed* — a world book file, a preset. `evalTemplate` hands the same
authority to a string a **card** supplied. Same writer, two very different
provenances.

**Three options were on the table.**

| | what it does | what it costs |
| --- | --- | --- |
| **A. Apply silently** | upstream's behaviour, unchanged | a card writes through a channel built for installed files, and nothing anywhere says so |
| **B. Refuse a template that writes** | the card gets a loud error | **breaks a card that works upstream** — see below |
| **C. Apply, and name every write** | upstream's values, plus a record | one report per op |

**B was implemented first and then withdrawn, which is the part worth
recording.** Refusing looks like closing a hole. Measured, it closes nothing:
the corpus's 18 books hold **8 entries carrying writes**, and the single card
that calls `evalTemplate` (银麒赎世) uses it to render **world book content** —
its `renderEntry` can reach 16 entries, one of them (`[EJS]末日世界观`) both
templating and writing. Under B that card loses its render *and* its write, on
behaviour that works in SillyTavern. The victim of the safety measure is the only
real consumer of the feature.

Discarding the ops instead (a fourth option) is worse than refusing and was
ranked below B: the `setvar` appears to succeed, the card reads back the old
value, and nothing connects the two. **Between two wrong answers, the loud one
is better** — but both are wrong here, because the correct value is upstream's.

**C is what ships.** The route's actual deficiency was never authority, it was
**visibility**: a card-supplied string reaching the same writer as an installed
file should not do it silently. Each op is reported by name and scope through
`#report` — `a card's template performed setvar global marker` — because "a
template wrote" is not actionable while the scope is: the scope says how far the
write reaches beyond the card that made it.

**What would overturn this.** A card using `evalTemplate` to write somewhere it
has no business writing — the reports are what would show it, and they are the
reason C is not simply A. `tests/eval-template.test.ts` pins that a write both
lands and is named.

### 6a. The exposure is currently zero, and why that is not reassuring

**Measured 2026-09-02: `script.evalTemplate` is never called on this host.** The
one card that uses it reaches its templates through `renderEntry`, which gets its
entries from two places and both are broken here:

- **Main path** `ctx.characters[ctx.characterId].data.character_book`. The
  `data` half now exists — `CharacterSummary.data` carries the played
  character's embedded book. The **index** half does not: `characters` is an
  array and `characterId` is an opaque string, and `array['aria']` is
  `undefined`. Upstream works because its `this_chid` is a *stringified numeric*
  index, and JavaScript arrays do accept those — `array['0']` resolves.
- **Fallback** `ctx.chat_metadata.world_info`. Snake-case `chat_metadata` is not
  a `getContext()` key at all — the 145-key surface has only camelCase
  `chatMetadata` — so this branch is **dead code in SillyTavern too**. An
  inherited dud, not a gap on our side, and it cannot rescue the main path.

So `entries` stays `[]`, the loop never runs, `renderEntry` returns null, and the
template is never evaluated.

**Three consequences, and the third is the trap.**

1. The guards in §6 are **pre-positioned, not wasted**. The write channel is
   real; only its traffic is blocked, by a defect tracked elsewhere.
2. The fork cost measured for this route (127 ms per call, of which 2 ms is the
   actual template — 98.4% is process startup) **does not accrue yet** either,
   for the same reason. Batching would not be a micro-optimisation but an
   order-of-magnitude change, and its trigger date is the same as this one's.
3. **Until the mirror lands, any "run a real card through it" acceptance is
   false-green** — not because plan C is correct, but because nothing calls it.
   A green end-to-end run today would be evidence of the blockage, read as
   evidence of the feature.

**This entry and the `characters`/`characterId` mirror are two links of one
chain, tracked separately.** Whoever closes the mirror must come back and
re-verify plan C end to end, because that is the moment this exposure goes from
zero to non-zero — and nothing about closing the mirror would remind them.

**Caliper on the reachability numbers in §6**, corrected by their author: the
count came from the **disk** book `银麒赎世.json`, while `renderEntry` reads the
card's **embedded** `character_book`. For this card the two are identical entry
for entry (129/129), so the numbers stand — but that is a property of this card,
not a rule: `干物吸血鬼少女与夜间工作` is 51 of 52. Redoing this measurement on
another card means checking that step first.

Reachability is also **measured absence, not structural impossibility**: it was
computed from the call arguments present in the card's current source (five
literals and one half-dynamic `renderEntry("人物_" + ch.name)`, whose prefix is
open-ended). One edited line in the card changes the set.

---

## 7. A script's runtime buttons are stored beside the installation, not in the card

**Upstream.** `replaceScriptButtons` (`JS-Slash-Runner/src/function/script.ts:73`)
calls no save of its own — it assigns `script.button.buttons` and returns. What
persists it is a **deep watcher** on the character settings store
(`store/settings/character.ts:150`), which writes the character card
*immediately*: 「酒馆经常读取角色卡数据, 所以这里需要立即保存」. So on
SillyTavern, a script rearranging its own panel edits the card file on disk.

This is the identical mechanism to §1, and it caught the same way: the write path
reads as pure assignment, and only the watcher makes it a file write. §1 records
that reading `script.ts` alone will miss it. It nearly did again.

**Iris.** The card's button table is a **seed**. A `replaceScriptButtons` write
becomes an override in `<profile>/script-buttons.json`, partitioned by character
and then by script, and the snapshot hands out the two merged — the override
replacing the declaration **whole**, because upstream's writer assigns the array
it is given, so a button the script dropped is meant to be gone. Merging by name
would resurrect exactly what the script removed.

**Why, and why the same answer as §1.** The standing rule is that runtime state
is not written into a shared card file. The deciding factor was consistency
rather than the rule alone: `script.data` and the button table are two runtime
states of the same script, and splitting them across two persistence schemes
would leave nobody able to say which kind of state lives where.

**The cost, stated rather than left to be found.** A card exported back to a real
SillyTavern carries the buttons it **declared**, not the ones a script
rearranged. A user who moves a card across finds the panel as its author shipped
it. That follows from seed semantics and is the price of not touching the shared
file — the same trade §1 made for `script.data`, with the same shape of loss.

**Not implemented, deliberately.** `appendInexistentScriptButtons` and
`updateScriptButtonsWith` get no arms: upstream builds the first out of
`replaceScriptButtons` (`script.ts:110`, deduplicating by name then appending)
and the second takes a **function**, which cannot cross this boundary. Both are
composed in the façade, on the `updateVariablesWith` precedent.

**What would overturn this.** A card that expects its rearranged panel to
survive an export — or a user reporting exactly that. The reports would look like
"my buttons reset when I moved the card", which is the sentence to recognise.

## 8. A pruned floor is answered by name, and replay is opt-in

Upstream's variable cleanup is enabled by default (`.prefault({})` on a zod
schema whose values are `{启用: true, 快照保留间隔: 50, 要保留变量的最近楼层数: 20,
触发恢复变量的最近楼层数: 10}`), so **an imported long chat has been rolling
under cleanup since its first floor** — that is the ordinary state of every MVU
installation, not a property of one corpus. Iris matches the rule: keep the
newest `keepRecent`, keep and mark every floor on the absolute-numbered
interval, strip the five named keys in between. `prune.ts` extends rather than
replaces, and the interval is taken modulo the **absolute floor number** because
a user arrives carrying upstream's mental model of where their snapshots are.

Two things diverge, both on the read side.

**A pruned floor says so.** `readFloorVariables` reports `origin: 'pruned'` with
a sentence naming which keys were taken and which earlier floor is still intact.
The table itself is still empty, exactly as upstream answers it — the divergence
is that a reader can now tell a deletion from a floor that never held anything.
Those were the same `{}` before, and they ask a caller for opposite responses.
This resolved what looked like a dilemma: honesty was assumed to mean refusing
the read and breaking cards that walk history. It does not — nothing errors.

**Replay is available and off by default.** `readFloorVariables(id, {replay:
true})` reconstructs a pruned floor by folding forward from the nearest intact
one, and labels the answer `origin: 'replayed'` with `replayedFrom` and
`replayedFloors`. It is not the default for two independently sufficient
reasons:

- **Fidelity.** Folding one floor forward from the previous floor's stored table
  reproduces its `stat_data` in **93 of 118** adjacent full-floor corpus pairs —
  **78.8%**. The rest return a value that differs from what was stored, with
  nothing in the table saying so. Folding is deterministic (verified three ways:
  same-process repeats, 971 corpus folding floors, and two separate processes
  byte-comparing per-chat hashes), which is no comfort — it deterministically
  returns the same wrong value.
- **Cost.** A fold is p50 1.98 ms against a 187 KB state, so one snapshot
  interval is ~108 ms of **synchronous** CPU — not overlapping latency, but
  108 ms in which this process serves nobody.

**Why the gap will not close, which is the durable part of this entry.**
**Of the 25 measured divergences, 24 are writes no command in that reply
caused.** A zero-command control makes this exact: on a floor issuing no
commands the fold is the identity function, so any difference is out-of-band by
definition — 18 of 19 such pairs were unchanged, the one exception being a
character-creation form write. With full schema support added, the ceiling is
**94 of 118 = 79.7%**. Replay therefore cannot become the default on fidelity
grounds *ever*: the limit is structural, not a matter of the implementation
improving.

**A withdrawn number, recorded so it is not re-derived.** An earlier pass put
the ceiling at 84.3%. That used "the differing leaf sits under a path some
command names" as a proxy for "the fold is wrong", and the proxy is only an
upper bound — a card script can overwrite a commanded path too. Measured
directly, the two classes that proxy flagged both cleared: our fold produced
exactly what the reply asked in **9 of 9** `set` cases and **4 of 4** array
`insert` cases. 84.3% is void; 79.7% replaces it.

**What would overturn this.** A measurement showing out-of-band writes are rare
on some other corpus — in which case replay's fidelity there is much higher and
the default deserves revisiting. Or the opposite discovery, that some card
depends on reading a pruned floor's real state, which would make the named
refusal insufficient and force either retention or a documented data loss.

## 9. The variable fold reads the `schema` section, and refuses what it forbids

Upstream consults the `[InitVar]`-generated `schema` on every `insert`: an array
is **closed unless** `extensible` is exactly `true`, an object is closed only by
an explicit `extensible: false`, and a declared `template` is merged into each
newly added member. Iris ignored the schema entirely. It now implements both
rules (`@iris/mvu/schema`).

**Filed as compatibility, not as fidelity.** Against replay this is worth under
one point — it moves the ceiling in §8 from 78.8% to 79.7%. The reason to do it
is that the same `applyCommands` runs on every finished turn, so accepting an
append upstream refuses writes the divergence into the user's save immediately,
and a card carried back to SillyTavern grows differently shaped members. Corpus
exposure: 2 inserts upstream refuses that were being accepted, and 11 whose
template was not being merged.

**One upstream behaviour is copied even though it looks like a bug.**
`getSchemaForPath` resolves object keys through `properties` only and stops at
the first missing key — it does **not** fall back to an extensible parent's
`template`. So a member added at runtime to an `extensible: true` object has no
schema of its own and every rule above is skipped for it. This is load-bearing
rather than incidental: a corpus append into `命定之人.<runtime member>.职业`
looked exactly like a schema refusal until the walk was traced, and it is not
one — upstream resolves no node there and permits the append. "Improving" the
walk would refuse writes upstream accepts, which is the direction that loses
user data.

**What would overturn this.** Upstream changing the walk to consult `template`,
or a card whose arrays are all undeclared and which therefore stops being able
to append at all — the report would read "my inventory stopped growing".
