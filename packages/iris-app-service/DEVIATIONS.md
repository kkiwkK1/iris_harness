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
newest `keepRecent`, keep and mark every layer on the interval, strip the five
named keys in between. `prune.ts` extends rather than replaces.

**Corrected: all three parameters count messages, not turns.** An earlier
version counted turns — interval, protection window and trigger alike — on the
reasoning that a turn is the meaningful unit and that upstream's reach-back
compensated for an event it does not receive. Measurement said otherwise: on the
corpus's 677-message chat SillyTavern retained 14 snapshots, one per 50 message
indices, where a turn-counted interval of 50 retained 7. That is not a different
trade-off, it is the same rule in the wrong unit, and since nothing here is
replayed back it simply halved how far a long chat could be reasoned back
through. Now fixed, and pinned by a test that reproduces the exact survivor set
upstream left on that file (`{0, 50, … 650}`).

**Nobody lost anything to the old unit, and the reason is worse than the bug.**
The correction was first written here with a warning that profiles pruned under
the turn-counted rule had lost layers permanently. They had not: `pruneVariables`
and its two settings were declared on the plugin config and **read by nothing**,
from the commit that introduced the feature. The service supported cleanup, the
schema advertised it, and the pass-through between them was never written — so
the cleanup has never run on a real host, at any setting, and the wrong unit
could not reach a user's data.

The wiring is now in place. **This is the more serious of the two findings**: a
unit error is visible to anyone who reads the rule, and a feature that is fully
implemented, fully tested and never called is visible to nobody — every test
passes, because tests construct the service directly and pass the option the
plugin never passed.

### The default is on, and the cost of that is not symmetric with upstream

It defaults **on**, matching upstream, whose `启用: true` reaches every install
through a `.prefault({})`. That is not only a reading of a schema: on the corpus,
every chat long enough to qualify has already been cleaned — the 677-message file
keeps 31 of 344 layers with a median layer of 39 bytes — and nobody turned that
on by hand.

**Defaulting off had a cost that no rule of ours would have produced.** An
imported chat arrives already cleaned by SillyTavern, with snapshots at message
0, 50, 100 and so on. If this host then never cleaned, the same profile would
carry chats whose early history is upstream-trimmed and whose later history is
kept whole — a shape that is the arithmetic of two defaults meeting, not the
output of either one, and the divergence grows with the length of the chat.

**But the same default does not cost the same on both sides, and that asymmetry
is the part worth reading twice.** Upstream can afford to delete because
`restoreVariables` folds `updateVariables` forward from the nearest snapshot: its
cleanup discards a cache. **This host does not replay**, so a trimmed floor here
is gone, and what remains is a report naming the nearest intact floor below it.
Copying the default is right; copying it while implying the consequences match
would not be.

### The legacy path: detected, reported, not performed

Upstream has a second cleanup that the periodic one does not cover.
`checkAndCleanupLegacyChat` runs unconditionally at init and, behind four gates —
enabled, longer than `keepRecent + 5`, `chat[1].variables[0].stat_data` still
present, and no recorded `ignore_cleanup` — **asks the user**: clean, never ask
again, or export a backup through `/api/chats/export` and then clean. Its action
is a full sweep of `[1, len - 1 - keep]`, far wider than the periodic window.

This host evaluates the same four gates and **reports**, once per loaded chat.
It does not sweep. The dialog and the backup are what make that deletion
legitimate upstream, and performing the sweep without them would convert a
deletion its author requires consent for into a silent one — the largest single
thing this feature could do, done quietly. The three-button prompt and the export
belong to the shell and are on the roadmap.

**`ignore_cleanup` is upstream's key, kept verbatim.** A refusal is persisted on
the chat itself, so a chat moved between the two hosts carries the answer its
owner already gave. Inventing a name here would mean asking again someone who
had said no.

**Floor 0 is protected by name, not by arithmetic.** `legacy_chat.ts:94` carries
an explicit comment and expresses it as `start = 1`; the periodic path then also
keeps it through `0 % interval === 0`. An earlier note here called it a side
effect of the modulo, which was wrong about upstream’s intent — though the
testing consequence it drew still holds: because both paths keep floor 0, an
assertion that it survives cannot tell a correct implementation from one that
special-cases it.

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

## 10. Script injections are held per chat, where upstream holds one global set

Upstream keeps `extension_prompts` in a single module-level object
(`script.js:625`) and `clearChat()` empties it — 14 call sites covering opening,
switching and deleting a chat. Nothing serialises it, so a reload loses it too.
This host keeps injections **on the conversation**, which agrees with upstream on
the part that matters most — they are memory-only and never persisted, because an
injection belongs to a running script — and differs on one axis: switching away
from a chat and back finds that chat's injections still there, where SillyTavern
would have cleared them.

**Kept rather than matched, because "clear on switch" has no meaning here.**
Upstream has exactly one active chat; this host serves several pages that may
each hold a different conversation open, so there is no moment that is
unambiguously "the switch". Clearing chat A's injections because a page opened
chat B would break the other page still using A.

**The divergence is announced instead.** Re-opening a chat that still holds
injections emits a `script` report naming how many. A card written against
SillyTavern assumes a clean slate at that moment, and stale injected text is
indistinguishable from text the card meant to be there — the failure is silent
and misattributable, which is what the report removes. This is the silence
family from `OBSERVABILITY.md`, whose remedy is a sentence at the moment it
happens, rather than the fidelity family the charter's "add context, not
reports" rule governs.

**A related asymmetry, upstream's rather than ours.** TavernHelper's script
frame is rebuilt only when the *character* changes
(`store/settings/character.ts:55-60`), so switching chats within one character
leaves the scripts running with live handles whose `deleted` is still false —
while SillyTavern has already emptied the injections underneath them. A card is
then holding a handle to nothing, with no notification. V1.5.4 happens to
survive this by re-injecting every turn, but that is a habit of that card, not a
guarantee of the mechanism.

**What would overturn this.** A card that depends on injections *not* surviving
a return to the same chat — it would look like text reappearing that the user
thought was gone.

### The consequence, once runs exist

**Both halves of the original argument turned out to be true, and measurement
settled which one governs where.** The premise for clearing — that the shell
rebuilds a card’s script frame per chat, so the new frame re-injects and
keeping the old set means two copies — is correct: the frame’s dependencies
include the chat id. The premise for keeping — that a second page may hold the
same conversation open, so clearing by chat pulls text out from under it — is
also correct. Neither is wrong; they are about different units.

So the unit changed. An injection now carries the **frame run** that made it,
and the shell says when a run ends. What follows:

- **One page behaves as upstream does.** Opening the chat starts a new run and
  ends the old one, so the previous run’s injections go — which is what
  `clearChat()` does, arrived at by attribution rather than by emptying a table.
- **Several pages do not collide.** Ending page one’s run cannot touch page
  two’s, because they are different keys. This is the case upstream cannot
  have, and it is the reason the unit is a run and not a chat.
- **Orphans are reported, not swept.** A page that closes abnormally never
  sends its run’s end, and **the host cannot tell that run from a live one on
  another page** — both are just a `(chatId, runId)`. Sweeping "everything but
  this open" would be precisely the failure this section exists to prevent, so
  the count is reported on re-open and nothing is deleted. The cost is real and
  bounded: injections from a crashed page live until the chat is closed.

Identifying an orphan needs a notion of *page identity* the host does not have.
That is a layer, not a fix, and it is not built until something needs it.

## 11. What a card may set on an injection, and what it may not

Built to upstream's whole signature rather than to any card's observed usage:
`injectPrompts` is a thin wrapper whose handle **is** the key, and `uninject()`
is `_.unset(extension_prompts, id)`, so this host implements the primitive and
the wrapper composes in the façade.

- **`position: 'none'` is a third state.** Upstream's `NONE: -1` is queried by no
  call site of `getExtensionPrompt`, so such an injection holds its key — it can
  be overwritten or removed — and contributes no text. Registered-but-silent is
  distinct from both assembled and absent.
- **Assembly order within a group is the keys' lexicographic order**, because
  upstream walks `Object.keys(extension_prompts).sort()` (`script.js:3249`).
  This host iterated its Map in insertion order until 2026-09-03, which agreed
  only when a card injected alphabetically. Nothing reported the difference:
  both orders produce a well-formed prompt, and the model simply received
  different text. Upstream's own keys are named `1_memory`, `2_floating_prompt`,
  `3_vectors` — **the digits are a sorting device, not a naming habit**, and
  noticing that is how the rule becomes visible at all.
- **Keys are not partitioned by script.** Upstream's key is `prompt.id ??
  uuidv4()` with no script prefix, so two scripts choosing one id overwrite each
  other there as well. Matching, not diverging. The consequence worth knowing: a
  UUID id lands at a random position in that lexicographic order.
- **`should_scan` is accepted and stored, and the scan pass does not yet read
  it.** Recorded rather than flattened to `false`: answering a card's request
  with its opposite leaves nothing for anyone to find, while a stored value
  makes the gap locatable and means cards already asking for it are asking
  correctly the day it is honoured.
- **`filter` is not implemented.** It is a function, re-evaluated on every
  assembly, and cannot cross this boundary — the `updateVariablesWith`
  precedent, composed in the façade.
- **Upgrade side.** TavernHelper exposes only `'in_chat'` and `'none'`, so a
  card cannot reach SillyTavern's `IN_PROMPT(0)` or `BEFORE_PROMPT(2)`. This
  host's `before` and `after` are therefore more than a card can ask for
  upstream, which is a documented improvement rather than a compatibility need.

**What would overturn this.** Upstream partitioning keys by script, or exposing
the two positions it currently hides.

## 12. An embedded world book is materialised into a named one, and the binding is ours

SillyTavern's assembly layer reads exactly one character-book channel: the bound
name in `extensions.world` (`world-info.js:4363-4380`; `character_book` appears
nowhere in it). An embedded book reaches assembly only after
`importEmbeddedWorldInfo` has written it out as a named book — and both of that
function's call sites are UI clicks, so materialisation upstream always follows
a user action.

Iris read the embedded book directly during assembly. That was a **second
channel upstream does not have**, and the duplication it produced — 1122 of 2246
corpus entries — is what the old "choose one, never both" rule existed to hide.
The rule was patching a problem only we could create.

Now: the embedded book is materialised on the import and open paths, and
assembly reads the bound name and nothing else. Three things differ from
upstream, and the third is the one to read carefully.

| | SillyTavern | Iris |
| --- | --- | --- |
| when it materialises | when the user clicks the world-info button | **on import, and on first open of an existing chat** |
| where the binding goes | written back into the card's `extensions.world` | **recorded in `worldbook-bindings.json`** |
| a card exported back | carries `extensions.world`, embedded book stripped | **unchanged, still carrying its embedded book** |

The middle row is the whole design: the assembly layer is still single-channel,
and only the bookkeeping of *which book* lives somewhere else. It keeps the
standing position that runtime state does not go into a shared card file (§1,
§7), and it means a card taken back to SillyTavern behaves there exactly as it
did before Iris touched it.

**On name collisions this host is stricter than upstream, and that is an
upgrade rather than an alignment.** Upstream has three behaviours: an explicitly
named book that already exists is **refused** (`world-info.js:1184-1204`); a
minted name that collides gets an automatic ` (i)` suffix (`getUniqueName`,
`utils.js:701-713`); and an **embedded-book materialisation that collides
overwrites the existing book** — `saveWorldInfo(bookName, …, true)` at
`:5625-5640`, on a path where `skipPopup` is true, so the user never sees it.
Iris matches the first two and refuses the third: a name wanted by one card but
already belonging to another is given up, the book is materialised under
` (i)` instead, and a report says why. **The link between a card and its book is
the binding table, not the filename**, which is what makes the name the thing
that can safely give way.

**When the card is updated, four states, and only one of them speaks.** The
binding records two hashes: `sourceHash` over the **normalised** embedded book
(so an author reordering entries is not read as new content) and
`materialisedHash` over the **bytes written** (so "is this still the file I
wrote" is answered exactly). Card unchanged: nothing happens, whether or not the
user edited the book — the user's copy is authoritative and the embedded one was
only a seed. Card changed and the book untouched: re-materialised silently,
because no one's work is at risk. **Card changed and the book edited: the user's
book is kept and a report is emitted**, because both parties changed the same
book legitimately, merging would betray both, and silently keeping the user's
version produces "I updated the card and nothing appeared" — which is
indistinguishable from an update that failed.

**A consequence worth stating.** A host with no world-book store has nowhere to
materialise into and therefore no character-book channel at all. Production
always builds one (`index.ts:360`, unconditional); the hosts that lacked one
were test fixtures, which were relying on the channel this change removed.

**What would overturn this.** Upstream moving embedded-book reading into
assembly, or a measurement showing users expect a card update to overwrite their
edited book — the report would then be the wrong answer rather than the careful
one.

## 13. Reading a user's SillyTavern installation, and one member not copied

A card can name a world book that never travelled with it. Rather than leaving
such a card on the embedded copy for ever, Iris will read the real book out of
the user's own SillyTavern profile when one is configured (`sillyTavernDir`,
unset by default and never guessed).

**Read-only, and structurally so.** Only `worlds/*.json` and `settings.json` are
opened; an overlap between that directory and Iris's own `dataDir` is refused at
startup rather than at first write, because that overlap is exactly how "we
never write to your install" stops being true. The install may be running, so a
file that will not parse is reported as *unreadable this time* rather than
absent — telling a user a book is missing when they have it sends them looking
for the wrong thing.

**Their filename rule, not ours.** SillyTavern writes
``sanitize(`${name}.json`)`` through `sanitize-filename`; this host mirrors that
in `stFileName`. Using Iris's own `toId` here would be wrong in a way worse than
a miss: it strips what looks like a trailing extension, so `创世回廊1.3` becomes
`创世回廊1` and a dotted version number resolves to **a different book**.
Measured against the reference install: their rule finds 18 of 18, `toId` finds
5 of 18.

**`toId` has a second victim surface: the character id itself.** The same
extension strip clips a card's own id — `创世回廊1.3` mints `创世回廊1`, and
`魔法少女的扣扣审判1.0` mints `魔法少女的扣扣审判1`. Measured over the 19 cards in
the reference install: **8 ids differ from the card's name, 5 of them because a
dotted version was read as a file extension.**

**No collision exists today** — 0 ids claimed by two different cards, in either
the install or this profile — and `characterId` is an opaque id by contract
(§5), so nothing reads it as a version. The cost is therefore confusion rather
than corruption: the id a user sees in a report or a filename is their card's
name with the version filed off.

**Not changed, and the reason is the blast radius rather than the merit.** The
id keys the worldbook binding table and every per-character store — script
variables, script buttons, extension settings, script policy. Reminting would
orphan all of them for every existing profile: the cards would keep working and
quietly lose their stored state, which is the failure mode this ledger exists to
avoid. If it is changed, the right change is narrow — strip only the extensions
a card file actually has (`.png`, `.json`, `.charx`) instead of anything after a
final dot, which is the same correction `stFileName` made for book names — and
it must land with a migration that renames the keys, in its own batch.

**What would overturn this.** Two versions of one card in a profile: they mint
one id, the second is minted `… (2)`, and from then on the ids mislead about
which is which. The collision itself is handled; the confusion is what would
force the change.

**A fetched book outranks a seed, and never outranks the user.** The four-way
table from §12 applies unchanged: a seed nobody has edited is replaced by the
real book and the binding's origin becomes `imported-from-st`; a seed the user
*has* edited is kept, with a report, because the install's copy is not more
authoritative than their own work — merely different.

### Not copied: enumerating IndexedDB to find another extension's data

One corpus card (银麒赎世's phone UI) enumerates every IndexedDB database in its
origin, finds a third-party extension's store (智绘姬) by name, and reads images
out of it. **Structurally inapplicable rather than withheld**: it depends on
another *extension* being installed, not on a host capability, so there is
nothing for this host to implement. The card already degrades on its own —
its guard resolves `false` — so nothing is broken by the absence. Source:
`apps/iris-web/UPSTREAM-FRAME-ORIGIN.md` §六.

**What would overturn this.** Iris growing an extension ecosystem of its own, at
which point "read another extension's data" becomes a capability question rather
than a category error.

## 14. A user row's `message_id` reads its reply's table

SillyTavern stores variables **per message**, so addressing a user line returns
that line's own table. This host stores them **per turn**, and a turn owns both
the user line and the reply it produced — so both message ids map to one turn,
and therefore to one candidate's table. A card asking for a user row's variables
gets its reply's.

**Recorded now because the path is about to open.** Until this batch the frame
refused every `message_id` except `'latest'`, so no explicit id had ever reached
the host and the difference was theoretical (`service.ts`, on
`turnForMessage`). With floor-addressed reads answered from the snapshot and the
`'latest'` sentinel accepted alongside numbers, every card that addresses floors
by number will meet it.

**Why not fixed here.** Storing a table per message rather than per turn is a
change to the log's shape, not to this read: the user row exists in the exported
file but has no candidate to hang a table on. Doing it properly means deciding
what a user row's variables *mean* in a log whose unit is the exchange — and
that question is worth answering deliberately rather than as a side effect of
opening the read path.

**What it looks like when it bites.** A card reads `message_id: N` for a user
line and gets state that is one step *ahead* of what it expected — the reply's,
not the prompt's. Nothing errors, and the table is well-formed.

**What would overturn this.** A card that visibly depends on the two being
different — or a measurement showing upstream's per-message tables actually
differ between a user line and its reply often enough to matter.

## 15. `message_id`: two upstream behaviours not copied

The accepted domain is upstream's, and wider than it looks: an integer,
a **numeric string** (`_.inRange` and `Array.prototype.at` both coerce), a
**negative** counting from the end (`at`'s own meaning), `'latest'`, or omitted.
Anything else — `'last'`, `NaN`, a fraction, out of range — is refused by name,
which is what upstream does too.

Two things are deliberately different.

**`null` is refused; upstream silently addresses floor 0.** Upstream does not
normalise `null` either, but its guards let it through by accident:
`_.inRange(null, …)` is true and `chat.at(null)` is `chat.at(0)`. So a card that
computed `null` for its target reads the opening message — and on the write path
**overwrites** it. A read-modify-write aimed at floor 0 destroys data and then
reports success, which is the one class of outcome worth refusing rather than
reproducing. This is the refusal policy, not an improvement.

**`'latest'` means one floor here, and two floors upstream.** Upstream's read
resolves `'latest'` to the last **non-system** message and its write resolves it
to the last message. In a chat whose final row is a system message those are
different floors, so a card writes to one and reads from the other — silently,
and only in that case. This host uses the last non-system message on both paths:
**one fewer inconsistency than upstream rather than a matching one**, and a
write through `'latest'` is always visible to a read through `'latest'`.

**What would overturn this.** A card that depends on `'latest'` writing to a
system row, or on `null` meaning "the beginning" — both would show up as a card
that works upstream and refuses here, with our own error naming the reason.

## 16. Card storage is shared, quota'd like a browser, and says who filled it

A card's scripts get one key–value store **shared across the profile**, because
upstream gives them one `localStorage` per origin — two cards choosing the same
key see each other's values there, measured on the corpus as four shared keys
between two cards. Partitioning per card would be tidier and would break every
card that relies on the sharing.

**The quota is built to the mechanism, not to our costs.** A browser gives an
origin roughly 5–10 MiB and throws `QuotaExceededError` from `setItem`; the
store caps at the top of that range and refuses past it, and the frame raises
the exception cards are already written against. **No per-value limit**, because
browsers have none: a 2 MB wallpaper stores in SillyTavern, so it stores here.
An earlier draft capped one value at 1 MiB on fairness grounds and was removed —
a rule upstream does not have, invented to solve a cost that measurement then
showed was not there (a 4 MiB string clones in 1.39 ms; what actually scales is
re-serialising the whole store on every write, which is why writes are
coalesced).

**Two additions upstream has no answer for.** A removal that takes a key another
card wrote is reported with the key and its last writer; a refused write is
reported with the store's size and its **bytes per card**. A browser can only
say "full" — it cannot say whose bytes those are, so a user meeting the quota
upstream has nothing to act on. `lastWriter` is attribution for these reports
and **not ownership**: it is deliberately not a basis for deletion, which is why
`character.delete` does not forget this store the way it forgets the
per-character ones.

**What would overturn this.** Cards colliding on keys often enough that the
sharing costs more than it buys — which would be an argument for a namespace,
and a divergence to take deliberately rather than by tidying.

## 17. Two upstream events are never sent, and MVU loses five callbacks

`CHAT_COMPLETION_SETTINGS_READY` and `worldinfo_entries_loaded` are **not
forwarded into the script frame, deliberately**. They are not notifications:
the listeners mutate the outgoing request *in place* and expect the host to
send what they leave behind. Our bridge is a one-way post, so a card told the
request was ready would edit a copy, see every edit succeed, and have all of
them discarded. **Not sending is the smaller lie**, and the frame says so at
`apps/iris-web/src/sandbox/host-events.ts`.

The five MVU callbacks that therefore never run: `filterEntries` on the world
info event; `filterPrompts`, `applyExtraModelRequestOverrides` and
`overrideToolRequest` on the settings event; and `registerFunction`. (The
first three of the settings group are named in the frame source; the rest
comes from the sessions that read MVU itself.)

### What this costs in the default mode: one placeholder, measured

In MVU’s default `随AI输出` mode, `filterEntries` returns early anyway, so the
only reachable loss is the one strip `filterPrompts` would have done.
Measured on the 爱衣 chat, through the host’s own prompt projection:

```
<UpdateVariable>    raw  3  ->  to-model 0
<JSONPatch>         raw  3  ->  to-model 0
"op": "replace"     raw 12  ->  to-model 0
StatusPlaceHolder   raw  1  ->  to-model 1     <- the whole cost
chars 9445 -> 7113 (2332 removed)
```

**A relayed description of this deviation said the command blocks go unstripped
and accumulate into the context turn by turn. On this card they do not.** The
card ships six regex scripts, the prompt direction runs in `#history`, and every
block is gone before the model sees it — that stripping was never MVU’s to do
here. What survives is a single `<StatusPlaceHolderImpl/>`. The claim is worth
recording as refuted rather than dropped, because it is the plausible one: it is
true of a card that leans on `filterPrompts` instead of shipping the scripts,
and the measurement above is what tells the two apart.

### What it costs in `额外模型解析` mode

Visible failure. The extra-model request overrides and the tool override never
apply, and `filterEntries` never removes the `[mvu_update]` entries, so the main
model is still asked for a block the mode means to obtain elsewhere.

### Nothing reaches that mode by accident

This is what keeps the row a **missing feature rather than a lurking risk**, and
it was measured rather than assumed (by the corpus and upstream sessions): no
card in the corpus sets `更新方式`; per-card override travels in a
`[config_override]` world book entry, of which there are none; and MVU parses its
settings as `z.union([Old, New]).catch(() => New.parse({}))`, three layers of
fallback that leave `更新方式` never `undefined`. **Only a person choosing
`额外模型解析` explicitly gets there** — no default, and no load failure, arrives
there on its own. An earlier reading that unloaded settings could fall through to
the removal path was withdrawn.

**The fix is a round trip, not a louder notification.** Sending these as events
is the one repair that cannot work. The host would have to hand the assembled
request across the boundary and wait for it to come back — worth building when
someone wants that mode, and not before.

---

# Upstream bugs, deliberately not reproduced

A third column, and the reasoning in it differs from both neighbours. The
numbered sections above are places Iris **chose** differently; the column below
is behaviour reproduced **because** it is upstream's. This one is neither: the
upstream behaviour is broken on its own terms — it defeats something upstream
itself is trying to do — so copying it would import a defect rather than a
compatibility.

The bar is deliberately high. "Upstream is wrong" is the easiest thing in the
world to believe about code one is reimplementing, and the compatibility floor
exists precisely because that belief is usually the reimplementer's error. An
entry belongs here only when the behaviour **contradicts upstream's own
intent**, not merely our taste.

## Dismissing the cleanup offer does not record a permanent refusal

Upstream asks once whether to clean a chat that has never been cleaned, with
three buttons. `CANCELLED` and `NEGATIVE` take the same branch
(`legacy_chat.ts:27-33`): **pressing Esc, or clicking outside the dialog, writes
`ignore_cleanup` exactly as "do not remind me again" does.** The offer never
comes back.

**This contradicts what the dialog is for.** A three-button prompt exists
because the author wanted a decision, and the third state — closing a dialog
without choosing — is the ordinary way a person defers one. Upstream records it
as the decision it most resembles positionally rather than the one it means, so
a user who hits Esc has silently opted out of a feature forever, and nothing
they can see will tell them. That is the bar this column asks for: it defeats
the dialog’s own purpose, not merely our taste.

**Here a dismissal is no answer at all**, which is a state the protocol already
has and already handles: nothing is cleaned, no key is written, a note is
retained, and the offer returns next time. `chat.answerCleanup` receives
`'never'` only when someone presses that button.

**The cost, stated.** A user who dismisses the dialog every time is asked every
time, where upstream would have asked once. That is the price of not recording
a decision nobody made, and it is visible and self-correcting — one press of
the button ends it — where upstream’s failure is silent and permanent.

## An injection with no `id` cannot be removed

**Upstream.** `injectPrompts` keys each injection with `prompt.id ?? uuidv4()`,
so an injection that arrives without an id gets a generated one — used as the
key and **not written back to the prompt object**. The handle's `uninject()`
then reads `p.id`, finds `undefined`, and removes nothing. The injection stays
for the life of the page, and the card holding the handle has no way to tell:
`deleted` reports true, and the text keeps appearing in every prompt.

**Why this is a bug rather than a behaviour.** `uninject` exists to remove the
injection. An id is generated *so that* the injection can be addressed. The two
halves are written to work together and do not, which is the difference between
"upstream does it differently" and "upstream does not do what it is trying to
do".

**Iris.** The id is filled in from a counter and **written back**, so the handle
addresses the same key the registration used and `uninject` removes what it
names. A counter rather than a UUID because assembly order inside a group is the
keys' lexicographic order (§11) — sequential ids keep a card's own injections in
the order it made them, where UUIDs would scatter them.

**What a card sees.** One that always supplies its own `id` sees no difference
at all. One that omits it gets an injection it can actually remove — which is
what it was asking for.

**What would overturn this.** Upstream fixing it, at which point this stops
being a divergence and becomes agreement; or a card that depends on an
un-removable injection, which would be depending on the defect itself.

---

# Faithful reproductions a user may report as a bug

The two columns above record where Iris **differs** from SillyTavern. This one
records the opposite hazard: behaviour that is correct *because* it matches
upstream, and that a user will nonetheless report as broken.

Written down for one reason. A report reading "my world book stopped working"
arrives with no indication of which column it belongs to, and the cheapest wrong
move is to fix it — turning a faithful reproduction into a divergence, silently,
with a green test suite. **Each entry below is a thing not to fix without a
ruling.**

Entries marked *(frame)* are the sandbox domain's findings, cited rather than
restated: the mechanism was measured there, and paraphrasing someone else's
measurement into this ledger is how a citation becomes a claim.

## The "never cleaned" notice comes back after a restart

The one-time notice that a chat has never been through a variable cleanup says
itself **once per load**, not once per chat. Reopen the conversation, or restart
the host, and it appears again. That reads like a bug in a "show this once"
feature, and it is deliberate.

The flag lives in memory on the open `ChatEntry` and is never serialized.
Persisting it would mean **writing our UI bookkeeping into the user’s own chat
file** — recording that we had already spoken, inside their data, forever. The
thing upstream does persist there is `ignore_cleanup`, and that is a different
kind of fact: it is the **user’s decision**, made in answer to a question, and it
travels with the chat between hosts because the answer belongs to whoever gave
it.

So the weaker guarantee is the intended one. **Do not fix this by persisting the
flag.** If the repetition becomes a real annoyance the answer is the feature
upstream actually has — ask the question, and record the reply under upstream’s
own key.

## Host

**Injection order inside a group is the keys' lexicographic order.**
Upstream walks `Object.keys(extension_prompts).sort()` (`script.js:3249`), so
two injections at the same position and depth are concatenated in *name* order,
not in the order the card registered them. **What the user sees:** a card's
panels or notes appear in an order that looks arbitrary, and a card whose
injection id is a UUID lands at a random point in the prompt. **Not fixed
because** SillyTavern's own keys are `1_memory`, `2_floating_prompt`,
`3_vectors` — the digits *are* the ordering mechanism, and cards written against
upstream rely on it. Sorting by registration order would put a card's text
somewhere upstream never puts it. See §11.

**An injection at `position: 'none'` is stored and never appears.**
Upstream's `NONE: -1` is queried by no call site of `getExtensionPrompt`, so
such an injection holds its key — it can be overwritten or removed — and
contributes nothing. **What the user sees:** a card says it injected something
and no text appears anywhere in the prompt. **Not fixed because** it is a real
third state; treating it as "assemble anyway" would put text into prompts that
upstream leaves out, and treating it as "reject" would break a card that parks
an injection deliberately.

**A card that binds a globally selected book receives nothing from its own
binding.** `world-info.js:4387` skips a character's book when it is already
active globally — with upstream's own comment, "is already activated in global
world info! Skipping...". **What the user sees:** exactly the card whose book
they also selected globally appears to have lost its world info, while every
other card gained entries. **Not fixed because** without it that one card
receives every entry of that book *twice*; the dedup is what stops the fix from
being a duplication. Measured: 18 cards gain 15 always-on entries each, the one
binding card gains 0 — and that zero is the strongest available evidence the
rule is working. See `WORLDBOOKS.md §2c`.

**`[InitVar]` seeding reads the books in the opposite order from assembly.**
Assembly is `character_first` on the measured installation; MVU's seeding builds
`[...selected_global_lorebooks, primary, ...additional]`
(`variable_init.ts:230`), so a global book's declaration is folded **first** and
the character's wins where they overlap. **What the user sees:** a variable
declared in both books takes the character's value at chat start, while the
same two books' *entries* are assembled character-first — two orders that look
like one should be a typo. **Not fixed because** matching only one of the two
would be plausible tidiness that changes behaviour: the seeding order decides
which declaration wins, and the assembly order decides activation ties.

**A branch shares its parent's chat world book, and a write on either side is
visible to the other.** `chat_metadata` is `structuredClone`d into a branch, so
the child inherits the same *book name* — one book, not a copy. **What the user
sees:** editing world info while playing a branch changes the parent chat too,
and because books are rewritten whole, the later writer replaces the earlier
one's entire book. **Not fixed because** a branch here is a save point the user
jumps back to; copying would let the two silently diverge and clearing would
make the branch forget. Ruled 2026-09-03. See `WORLDBOOKS.md §2d`.

**Writing a world book replaces all of it.** `createOrReplaceWorldbook` builds
the saved object fresh from the array it is given, so an entry the caller left
out is gone. **What the user sees:** a card that updates one entry appears to
delete the rest. **Not fixed because** it is upstream's write semantics, and a
partial update is expressed by reading the book, changing what you want, and
writing all of it back — which is what `updateWorldbookWith` does.

**World info scans only the last two messages by default.** `scan_depth`
defaults to 2 (`world-info.js:69`). **What the user sees:** a keyword mentioned
three messages ago does not trigger its entry, which reads as an entry that
"stopped working". **Not fixed because** the number is SillyTavern's own
default, and a card tuned against it would activate differently here — the
setting is the place to change this, not the default.

**A pruned floor's variables read as `{}`.** Cleanup is enabled by default
upstream (`启用: true`, interval 50, keep 20), so an imported long chat has been
rolling under it from its first floor, and floors outside the keep window have
had their tables stripped. **What the user sees:** `getVariables({message_id})`
against an early floor returns an empty table, as though the state was never
recorded. **Not fixed because** it is upstream's own cleanup and the file
arrived that way; what *is* fixed is the silence — see §8, where such a read
reports that the floor was pruned rather than answering a bare empty table.

## Frame *(cited, not restated)*

- **Storage façade is shared per profile**, so a card's wallpaper or floating
  button position can appear under a different card — four shared keys measured
  between two corpus cards. `UPSTREAM-FRAME-ORIGIN.md §四`.
- **One card can end up with two Pinia instances.** `UPSTREAM-ESM-DEPS.md`.
- **The interface frame sees `parent.Mvu` as undefined while MVU is still
  starting**, which upstream also handles by waiting for its
  `global_Mvu_initialized` event rather than by making the read synchronous.

## Not in this column

§14 (a user row's `message_id` reads its reply's table) is a **divergence**, not
a faithful reproduction — upstream stores a table per message and would answer
with the user row's own. It is listed here only as the contrast: the two look
alike from a bug report, and they belong in opposite columns.
